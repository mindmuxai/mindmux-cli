import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCodexHooks } from '../src/codex-hooks.mjs';

test('Codex hook capability distinguishes enabled, disabled, unsupported and unavailable runtimes', () => {
  assert.deepEqual(inspectCodexHooks(() => 'hooks stable true\n').supported, true);
  assert.equal(inspectCodexHooks(() => 'hooks stable false\n').enabled, false);
  assert.equal(inspectCodexHooks(() => 'other stable true\n').supported, false);
  assert.equal(inspectCodexHooks(() => { throw new Error('not installed'); }).supported, null);
});
