import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { binding, readJson, writeJson } from './storage.mjs';
import { withBrain } from './brain.mjs';
import { recall } from './recall.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
export const targetKey = root => digest(JSON.stringify(binding(root)));
const statePath = (root, agent, input) => join(root, '.mindmux/cli/sessions', `${agent}-${digest(String(input.session_id || input.conversation_id || 'default'))}.json`);
export function recordHook(root, agent, event, values) {
  writeJson(join(root, `.mindmux/cli/last-${agent}-${event}.json`), { time: new Date().toISOString(), targetKey: targetKey(root), agent, event, ...values });
}
const MEMORY_CHECK = 'MindMux memory check (once this turn): if this task settled a durable requirement, constraint or decision that has not already been captured, search/read the bound Brain and record it with its source. Do not store guesses or routine progress. If nothing qualifies, finish without writing. Do not repeat this check. Keep your final response focused on the user’s original request, in the user’s working language and requested format. Do not replace the answer with a memory-check report; if you already answered, preserve the substantive answer in the final response.';
const unboundContext = 'MindMux: this project has no selected Brain. Ask the user to choose an existing Cloud Brain, create a Project in an explicitly selected Workspace, or use mmx init --local. Do not infer a Brain from the folder name.';

export async function handleHook(root, agent, event, input) {
  if (!['cursor', 'claude-code', 'codex'].includes(agent)) throw new Error('Hooks support cursor, claude-code and codex.');
  if (!['session-start', 'prompt', 'pre-tool', 'stop'].includes(event)) throw new Error('Unknown hook event.');
  const path = statePath(root, agent, input);
  let state = readJson(path, {});
  const key = targetKey(root);
  if (state.targetKey !== key) state = { targetKey: key };
  // Codex emits UserPromptSubmit again for the Stop continuation. Keep its guard.
  if (agent === 'codex' && event === 'prompt' && state.stopped && (input.stop_hook_active || input.prompt === MEMORY_CHECK)) return {};
  const outputContext = (context, hookEventName) => agent === 'cursor' ? { additional_context: context }
    : { hookSpecificOutput: { hookEventName, additionalContext: context } };
  if (event === 'stop') {
    if (state.stopped || input.stop_hook_active || Number(input.loop_count || 0) > 0 || ['aborted', 'error'].includes(input.status)) return {};
    state.stopped = true;
    writeJson(path, state);
    recordHook(root, agent, event, { status: 'review-requested' });
    return agent === 'cursor' ? { followup_message: MEMORY_CHECK } : { decision: 'block', reason: MEMORY_CHECK };
  }
  if (event === 'pre-tool') {
    if (agent !== 'cursor' || !state.context || state.delivered) return {};
    if (Date.now() - state.recalledAt > 10 * 60 * 1000) return {};
    state.delivered = true;
    writeJson(path, state);
    recordHook(root, agent, event, { status: 'emitted', pageIds: state.pageIds || [], bytes: Buffer.byteLength(state.context),
      note: 'Returned to host; model usage is not observable.' });
    return outputContext(state.context);
  }
  // Compaction is still the same turn; preserve its Stop continuation guard.
  const stopped = agent === 'codex' && event === 'session-start' && input.source === 'compact' && Boolean(state.stopped);
  // Invalidate previous-turn context before any retrieval that may fail.
  writeJson(path, { targetKey: key, stopped });
  const result = binding(root).kind === 'unbound' ? { context: unboundContext, pageIds: [] }
    : await withBrain(root, brain => recall(brain, event === 'prompt' ? String(input.prompt || '').slice(0, 12000) : ''));
  state = { targetKey: key, context: result.context, pageIds: result.pageIds, recalledAt: Date.now(), stopped,
    delivered: agent !== 'cursor' || event === 'session-start' };
  writeJson(path, state);
  recordHook(root, agent, event, { status: state.delivered ? 'emitted' : 'retrieved', pageIds: result.pageIds,
    bytes: Buffer.byteLength(result.context), note: state.delivered ? 'Returned to host; model usage is not observable.' : 'Awaiting Cursor preToolUse; tool-free turns receive startup context only.' });
  if (agent === 'cursor' && event === 'prompt') return { continue: true };
  return outputContext(result.context, event === 'session-start' ? 'SessionStart' : 'UserPromptSubmit');
}

export async function runHook(root, agent, event, input) {
  // No failing hook should block a task. Bound the entire process as well as individual requests.
  const timer = setTimeout(() => {
    try { recordHook(root, agent, event, { status: 'timeout', error: 'Hook exceeded 8 seconds.' }); } catch {}
    console.log(JSON.stringify(agent === 'cursor' && event === 'prompt' ? { continue: true } : {}));
    process.exit(0);
  }, 8000);
  try { return await handleHook(root, agent, event, input); }
  catch (error) {
    try { recordHook(root, agent, event, { status: 'error', error: error.message.slice(0, 500) }); } catch {}
    return agent === 'cursor' && event === 'prompt' ? { continue: true } : {};
  } finally { clearTimeout(timer); }
}
