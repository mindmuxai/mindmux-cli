import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { binding, preferences, readJson, writeJson } from './storage.mjs';
import { withBrain } from './brain.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
export const targetKey = root => hash(JSON.stringify([binding(root), preferences(root).mindmuxCli?.bindingRevision || null]));
const directory = root => join(root, '.mindmux/cli/reviews');
const statePath = (root, session) => join(directory(root), `${session}.json`);
const lifetime = 24 * 60 * 60 * 1000;
const open = state => ['active', 'recovering'].includes(state.status) && state.expiresAt > Date.now();

// One lock protects the active turn, writes, receipts and Stop for this session.
// Never remove another process's lock, including after a crash: fail open in hooks.
async function locked(root, session, run) {
  const dir = directory(root), lock = join(dir, `${session}.lock`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 1500;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Memory review is busy; retry after the active operation finishes.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await run(readJson(statePath(root, session), {}), state => writeJson(statePath(root, session), state)); }
  finally { rmdirSync(lock); }
}
const sessionKey = input => typeof input.session_id === 'string' && input.session_id.trim() ? hash(input.session_id) : null;
const turnId = input => typeof input.turn_id === 'string' && input.turn_id.trim() ? input.turn_id : null;
function active(root, state, token) {
  if (!open(state) || state.targetKey !== targetKey(root) || state.token !== token) throw new Error('Memory review token is stale, expired, closed or belongs to another Brain.');
}
function tokenSession(root, token) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) throw new Error('A valid --review-token is required.');
  const session = readJson(join(directory(root), 'tokens', `${token}.json`), {}).session;
  if (!/^[a-f0-9]{64}$/.test(session || '')) throw new Error('Unknown memory review token.');
  return session;
}
function diagnostic(root, state, status, error) {
  writeJson(join(root, '.mindmux/cli/last-codex-review.json'), { time: new Date().toISOString(), agent: 'codex', event: 'review',
    targetKey: state.targetKey, status, ...(error ? { error: String(error).slice(0, 500) } : {}) });
}

export async function beginReview(root, input) {
  const session = sessionKey(input), turn = turnId(input);
  if (!session || !turn || binding(root).kind === 'unbound') return null;
  return locked(root, session, (state, save) => {
    if (state.turnId === turn && state.targetKey === targetKey(root)) return open(state) ? state : null;
    state = { token: randomBytes(32).toString('hex'), session, turnId: turn, targetKey: targetKey(root),
      status: 'active', expiresAt: Date.now() + lifetime, writes: [] };
    save(state);
    writeJson(join(directory(root), 'tokens', `${state.token}.json`), { session });
    return state;
  });
}

export async function currentReview(root, input) {
  const session = sessionKey(input);
  if (!session) return null;
  return locked(root, session, state => open(state) && state.targetKey === targetKey(root) && (!turnId(input) || state.turnId === turnId(input)) ? state : null);
}

export async function stopReview(root, input) {
  const session = sessionKey(input), turn = turnId(input);
  if (!session || !turn) return { status: 'review-unavailable' };
  return locked(root, session, (state, save) => {
    if (state.turnId !== turn || state.targetKey !== targetKey(root)) return { status: 'review-unavailable' };
    if (['aborted', 'error'].includes(input.status) || input.hook_event_name === 'Interrupt') {
      state.status = 'aborted'; save(state); return { status: 'review-aborted' };
    }
    if (state.status === 'completed') return { status: 'review-completed' };
    if (!open(state)) return { status: state.status === 'failed' ? 'recovery-exhausted' : 'review-expired' };
    if (state.receipt) {
      state.status = 'completed'; save(state);
      return { status: 'review-completed', outcome: state.receipt.outcome };
    }
    if (state.status === 'recovering' || input.stop_hook_active) {
      state.status = 'failed'; save(state);
      return { status: 'recovery-exhausted', error: state.error || 'No completed memory review after one recovery attempt.' };
    }
    state.status = 'recovering'; save(state);
    return { status: 'review-requested', state };
  });
}

const versionOf = value => value?.version ?? value?.page?.version ?? value?.rootPage?.version;
async function readResource(brain, resource) {
  const result = await (resource.kind === 'root' ? brain.readRoot(resource.id) : brain.read(resource.id));
  const version = versionOf(result);
  if (version === undefined || version === null) throw new Error('Brain read did not provide a version for verification.');
  return { ...resource, version };
}

// Called only around actual CLI mutations, including the MCP facade's CLI calls.
// Holding the session lock prevents a late write from authorizing a newer turn.
export async function reviewedWrite(root, token, brain, resource, run) {
  if (!token) return run();
  const session = tokenSession(root, token);
  return locked(root, session, async (state, save) => {
    active(root, state, token);
    if (JSON.stringify(brain.target) !== JSON.stringify(binding(root))) throw new Error('Brain binding changed before the operation.');
    let written = false;
    try {
      const result = await run(); written = true;
      const verified = await readResource(brain, resource);
      const returned = versionOf(result);
      if (returned !== undefined && String(returned) !== String(verified.version)) throw new Error('Brain changed before write verification; read the current version.');
      active(root, state, token);
      state.writes = [...state.writes.filter(item => item.kind !== resource.kind || item.id !== resource.id), verified];
      delete state.receipt;
      state.failures = (state.failures || []).filter(item => item.kind !== resource.kind || item.id !== resource.id);
      if (state.failures.length) state.error = state.failures[0].error;
      else delete state.error;
      save(state);
      return result;
    } catch (error) {
      delete state.receipt;
      state.error = `${written ? 'Write completed but verification failed' : 'Write failed'}: ${error.message}`;
      state.failures = [...(state.failures || []).filter(item => item.kind !== resource.kind || item.id !== resource.id), { ...resource, error: state.error }];
      save(state); diagnostic(root, state, 'review-failed', state.error);
      throw new Error(state.error);
    }
  });
}

export async function finishReview(root, { token, outcome, reason, id }) {
  if (!['saved', 'no-changes', 'already-covered', 'deferred'].includes(outcome)) throw new Error('Review outcome must be saved, no-changes, already-covered or deferred.');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 1000 || /[\r\n\0]/.test(reason)) throw new Error('Review requires a single-line --reason (1–1000 characters).');
  const session = tokenSession(root, token);
  return locked(root, session, async (state, save) => {
    const receipt = { outcome, reason: reason.trim(), ...(id ? { id } : {}) };
    // Permit an exact retry after completion, but never rewrite an old receipt.
    if (state.token === token && state.targetKey === targetKey(root) && state.expiresAt > Date.now() && state.status === 'completed'
      && JSON.stringify(state.receipt) === JSON.stringify(receipt)) return { reviewed: true, outcome };
    active(root, state, token);
    try {
      if (outcome === 'deferred') {
        delete state.receipt; state.error = receipt.reason; save(state);
        diagnostic(root, state, 'review-failed', receipt.reason);
        return { reviewed: false, outcome, retryable: true };
      }
      if (state.error) throw new Error('A Brain operation failed. Retry it successfully, or report deferred; do not claim successful review.');
      if (outcome === 'saved' && !state.writes.length) throw new Error('No verified write in this turn. Pass --review-token to the actual Brain mutation first.');
      if (outcome === 'saved' && id && !state.writes.some(item => item.kind === 'page' && item.id === id)) throw new Error('--id does not refer to a verified write in this turn.');
      if (outcome !== 'saved' && state.writes.length) throw new Error('This turn has verified writes; use outcome saved.');
      if (outcome === 'already-covered' && !id) throw new Error('already-covered requires --id for the existing Page.');
      if (outcome === 'saved' || outcome === 'already-covered') {
        await withBrain(root, async brain => {
          for (const proof of outcome === 'saved' ? state.writes : [{ kind: 'page', id }]) {
            const current = await readResource(brain, proof);
            if (proof.version !== undefined && String(proof.version) !== String(current.version)) throw new Error('Brain changed after write verification; inspect and save the current version before registering saved.');
          }
        });
      }
      active(root, state, token); state.receipt = receipt; save(state);
      diagnostic(root, state, 'review-registered');
      return { reviewed: true, outcome };
    } catch (error) {
      diagnostic(root, state, 'review-failed', error.message);
      throw error;
    }
  });
}
