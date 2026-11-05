import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { runBrainTool } from '../src/mcp-server.mjs';
import { beginReview, reviewedWrite, stopReview } from '../src/review.mjs';
import { binding, mergePreferences } from '../src/storage.mjs';

const bin = fileURLToPath(new URL('../bin/mmx.mjs', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mmx review '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'project'); mkdirSync(root);
  return { dir, root };
}
function cli(f, args, input = '', fail = false) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [bin, '--project', f.root, ...args], {
      env: { ...process.env, MINDMUX_HOME: join(f.dir, 'home') }, timeout: 15000,
    }, (error, stdout, stderr) => {
      if (fail) return error ? resolve(stderr) : reject(new Error('Expected failure'));
      if (error) return reject(new Error(stderr || error.message));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}
const input = (turn = 'one', session = 'session') => ({ session_id: session, turn_id: turn, prompt: '报告约定' });
const hook = (f, event, data = input()) => cli(f, ['hook', '--agent', 'codex', event], JSON.stringify(data));
async function token(f, data = input()) {
  const context = (await hook(f, 'prompt', data)).hookSpecificOutput.additionalContext;
  return context.match(/--review-token ([a-f0-9]{64})/)[1];
}
const review = (f, key, outcome, extra = [], fail = false) => cli(f, ['brain', 'review', '--review-token', key, '--outcome', outcome, '--reason', '用户本轮确认', ...extra], '', fail);
const create = (f, key, id = 'export-rule') => cli(f, ['brain', 'create', '--id', id, '--title', '导出约定', '--category', 'decision', ...(key ? ['--review-token', key] : [])], '报告导出为 Markdown。');
const latest = (f, event = 'stop') => JSON.parse(readFileSync(join(f.root, `.mindmux/cli/last-codex-${event}.json`)));

test('saved requires this turn’s successful write, validates versions and invalidates receipts after another write', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']);
  const old = await create(f);
  const key = await token(f);
  assert.match(await review(f, key, 'saved', ['--id', old.id], true), /No verified write/);
  assert.equal((await cli(f, ['brain', 'read', old.id])).version, old.version);
  await cli(f, ['brain', 'update', old.id, '--review-token', key, '--expected-version', old.version, '--summary', '补充链接'], '报告导出为 Markdown，并保留来源链接。');
  await review(f, key, 'saved');
  await cli(f, ['brain', 'append', old.id, '--review-token', key, '--summary', '验证完成']);
  assert.equal((await hook(f, 'stop')).decision, 'block');
  await review(f, key, 'saved');
  assert.deepEqual(await hook(f, 'stop'), {});
  assert.equal(latest(f).status, 'review-completed');
  // Exact retry is idempotent; closed tokens cannot authorize another mutation.
  await review(f, key, 'saved');
  assert.match(await cli(f, ['brain', 'append', old.id, '--review-token', key, '--summary', '迟到写入'], '', true), /stale|closed/);
});

test('external changes and failed writes cannot be reported as successful persistence', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']); const key = await token(f);
  const page = await create(f, key);
  await cli(f, ['brain', 'append', page.id, '--summary', '另一个会话的更新']);
  assert.match(await review(f, key, 'saved', [], true), /changed after write verification/);
  assert.match(await cli(f, ['brain', 'update', page.id, '--review-token', key, '--expected-version', page.version, '--summary', '冲突'], '冲突正文', true), /Write failed/);
  await create(f, key, 'another-successful-page');
  assert.match(await review(f, key, 'saved', [], true), /operation failed/);
  assert.match(await review(f, key, 'no-changes', [], true), /operation failed/);
  assert.equal((await review(f, key, 'deferred')).reviewed, false);
  assert.equal((await hook(f, 'stop')).decision, 'block');
  assert.deepEqual(await hook(f, 'stop', { ...input(), stop_hook_active: true }), {});
  assert.equal(latest(f).status, 'recovery-exhausted');
});

test('turn/session/Brain isolation, expiry and interruptions reject stale registrations before writes', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']);
  const first = await token(f);
  const next = await token(f, input('two'));
  assert.match(await review(f, first, 'no-changes', [], true), /stale/);
  const other = await token(f, input('one', 'other-session'));
  await review(f, other, 'no-changes');
  assert.equal((await hook(f, 'stop', input('two'))).decision, 'block');
  const compact = await hook(f, 'session-start', { session_id: 'session', source: 'compact' });
  assert.ok(compact.hookSpecificOutput.additionalContext.includes(next));
  await hook(f, 'interrupt', input('two'));
  assert.match(await review(f, next, 'no-changes', [], true), /closed/);
  const expired = await token(f, input('three'));
  const dir = join(f.root, '.mindmux/cli/reviews');
  const stateFile = readdirSync(dir).filter(name => name.endsWith('.json')).map(name => join(dir, name))
    .find(name => JSON.parse(readFileSync(name)).token === expired);
  const state = JSON.parse(readFileSync(stateFile)); state.expiresAt = 0; writeFileSync(stateFile, JSON.stringify(state));
  assert.match(await review(f, expired, 'no-changes', [], true), /expired/);
  assert.deepEqual(await hook(f, 'stop', input('three')), {});
  assert.equal(latest(f).status, 'review-expired');
  const changed = await token(f, input('four'));
  mergePreferences(f.root, { brainRoot: 'different-brain' });
  assert.match(await review(f, changed, 'no-changes', [], true), /another Brain/);
  mergePreferences(f.root, { brainRoot: 'brain' });
  assert.match(await review(f, changed, 'no-changes', [], true), /another Brain/);
});

test('compaction restores pending and registered review state without resetting the token', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']); const key = await token(f);
  let compact = await hook(f, 'session-start', { session_id: 'session', source: 'compact' });
  assert.ok(compact.hookSpecificOutput.additionalContext.includes(key));
  assert.match(compact.hookSpecificOutput.additionalContext, /BEFORE your final answer/);
  await review(f, key, 'no-changes');
  compact = await hook(f, 'session-start', { session_id: 'session', source: 'compact' });
  assert.match(compact.hookSpecificOutput.additionalContext, /already has a registered review/);
  assert.ok(compact.hookSpecificOutput.additionalContext.includes(key));
  assert.deepEqual(await hook(f, 'stop'), {});
});

test('MCP registration uses the same verified write path and no-changes never creates a Page', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']); const key = await token(f);
  await runBrainTool(f.root, { operation: 'review', reviewToken: key, outcome: 'no-changes', reason: '问候没有长期知识' });
  assert.equal((await cli(f, ['brain', 'list'])).pages.length, 0);
  assert.deepEqual(await hook(f, 'stop'), {});
  const key2 = await token(f, input('two'));
  const page = await runBrainTool(f.root, { operation: 'create', reviewToken: key2, id: 'mcp-rule', title: 'MCP 约定', category: 'decision', body: '使用 MCP 读写当前绑定的 Brain。' });
  assert.ok(page.version);
  await runBrainTool(f.root, { operation: 'review', reviewToken: key2, outcome: 'saved', reason: '已保存并核对' });
  assert.deepEqual(await hook(f, 'stop', input('two')), {});
  const key3 = await token(f, input('three'));
  assert.match(await review(f, key3, 'already-covered', [], true), /requires --id/);
  await review(f, key3, 'already-covered', ['--id', 'mcp-rule']);
  assert.deepEqual(await hook(f, 'stop', input('three')), {});
});

test('concurrent writes and Stop serialize per session without losing proofs or looping', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']);
  const state = await beginReview(f.root, input());
  const brain = { target: binding(f.root), read: async () => ({ version: 1 }) };
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const writing = reviewedWrite(f.root, state.token, brain, { kind: 'page', id: 'one' }, async () => { entered(); await wait; return { version: 1 }; });
  await ready;
  const stopping = stopReview(f.root, input());
  release(); await writing;
  assert.equal((await stopping).status, 'review-requested');
  assert.equal((await stopReview(f.root, input())).status, 'recovery-exhausted');
  const sessionFile = join(f.root, '.mindmux/cli/reviews', `${state.session}.json`);
  assert.equal(JSON.parse(readFileSync(sessionFile)).writes.length, 1);
});

test('missing identifiers fail open explicitly and recovery preserves substantive final output', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']);
  assert.deepEqual(await hook(f, 'stop', { session_id: 'session' }), {});
  assert.equal(latest(f).status, 'review-unavailable');
  await token(f);
  const result = await hook(f, 'stop');
  assert.match(result.reason, /Never return an empty final answer/);
  assert.doesNotMatch(result.reason, /finish silently|without additional user-facing text/);
  await hook(f, 'stop', { ...input(), stop_hook_active: true });
  const status = await cli(f, ['status', '--json']);
  assert.ok(status.receipts.some(item => item.status === 'recovery-exhausted'));
  const doctor = await cli(f, ['doctor', '--json']);
  assert.ok(doctor.checks.some(item => /recovery-exhausted/.test(item.message)));
});
