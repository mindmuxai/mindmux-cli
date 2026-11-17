import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { connect, inspectIntegrations, managedBlock, CLI_BIN } from '../src/integrations.mjs';
import { setup, refreshIntegrations } from '../src/setup.mjs';
import { handleHook, runHook } from '../src/hooks.mjs';
import { writeJson, readJson, mergePreferences } from '../src/storage.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mmx-hook-only-'));
  const root = join(dir, 'project'); mkdirSync(root);
  const old = process.env.MINDMUX_HOME; process.env.MINDMUX_HOME = join(dir, 'home');
  t.after(() => { if (old === undefined) delete process.env.MINDMUX_HOME; else process.env.MINDMUX_HOME = old; rmSync(dir, { recursive: true, force: true }); });
  return { root, dir };
}

test('hook-only installs do not create shared instructions and leave foreign files byte-identical', t => {
  const { root } = fixture(t);
  for (const agent of ['codex', 'claude-code']) connect(root, agent);
  for (const name of ['AGENTS.md', 'CLAUDE.md']) assert.equal(existsSync(join(root, name)), false);
  const own = '# Team rules\n\nKeep $HOME and `commands` intact.\n';
  for (const name of ['AGENTS.md', 'CLAUDE.md']) writeFileSync(join(root, name), own);
  for (const agent of ['codex', 'claude-code']) { connect(root, agent); connect(root, agent, { remove: true }); }
  for (const name of ['AGENTS.md', 'CLAUDE.md']) assert.equal(readFileSync(join(root, name), 'utf8'), own);
});

test('refresh migrates owned shared Claude handlers once and preserves foreign hooks and team rules', async t => {
  const { root } = fixture(t);
  connect(root, 'claude-code'); connect(root, 'codex');
  const local = join(root, '.claude/settings.local.json'), shared = join(root, '.claude/settings.json');
  const owned = readJson(local).hooks;
  const foreign = { type: 'command', command: 'echo team-policy' };
  owned.SessionStart[0] = { matcher: 'startup', hooks: [owned.SessionStart[0].hooks[0], foreign] };
  writeJson(shared, { permissions: { allow: ['Read'] }, hooks: owned }); rmSync(local);
  const surrounding = 'Team rules.\n';
  for (const name of ['AGENTS.md', 'CLAUDE.md']) writeFileSync(join(root, name), managedBlock(surrounding, 'Old personal path /Users/alice/cli'));
  await refreshIntegrations(root); await refreshIntegrations(root);
  assert.deepEqual(readJson(shared), { permissions: { allow: ['Read'] }, hooks: { SessionStart: [{ matcher: 'startup', hooks: [foreign] }] } });
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) assert.equal(readJson(local).hooks[event].length, 1);
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const text = readFileSync(join(root, name), 'utf8');
    assert.ok(text.startsWith(surrounding)); assert.doesNotMatch(text, /mindmux-cli|alice/);
  }
  assert.ok(inspectIntegrations(root).every(item => item.guidanceReady && item.hookCommandsPresent));
  connect(root, 'claude-code', { remove: true });
  assert.deepEqual(readJson(local).hooks, {});
  assert.deepEqual(readJson(shared).hooks.SessionStart[0].hooks, [foreign]);
});

test('failed setup rolls back local migration, shared handlers and historical instruction blocks', async t => {
  const { root } = fixture(t); connect(root, 'claude-code');
  const local = join(root, '.claude/settings.local.json'), shared = join(root, '.claude/settings.json');
  writeJson(shared, readJson(local)); rmSync(local);
  writeFileSync(join(root, 'CLAUDE.md'), managedBlock('Team text\n', 'legacy'));
  const original = [shared, join(root, 'CLAUDE.md')].map(path => readFileSync(path, 'utf8'));
  await assert.rejects(setup(root, { local: true, yes: true, json: true, agent: 'claude-code' }, { probe: async () => { throw new Error('probe failure'); } }), /configuration restored/);
  assert.equal(existsSync(local), false);
  assert.deepEqual([shared, join(root, 'CLAUDE.md')].map(path => readFileSync(path, 'utf8')), original);
});

test('registered hook commands inject rules, usage and index without instruction files', async t => {
  const { root } = fixture(t);
  await setup(root, { local: true, yes: true, json: true, agent: 'codex,claude-code' }, { probe: async () => ({ recall: true }) });
  const body = '发布必须经过双人审核。修改发布流程时读取此页。';
  execFileSync(process.execPath, [CLI_BIN, '--project', root, 'brain', 'create', '--id', 'release-rule', '--title', '发布规则', '--category', 'decision', '--source', 'test fixture'], { input: body });
  for (const path of ['.codex/hooks.json', '.claude/settings.local.json']) {
    for (const [event, extra] of [['SessionStart', { source: 'compact' }], ['UserPromptSubmit', { prompt: '发布流程', turn_id: 'turn-one' }]]) {
      const command = readJson(join(root, path)).hooks[event][0].hooks[0].command;
      const output = JSON.parse(execFileSync('/bin/sh', ['-c', command], { input: JSON.stringify({ cwd: root, session_id: path, ...extra }), encoding: 'utf8' }));
      const text = output.hookSpecificOutput.additionalContext;
      assert.equal(output.hookSpecificOutput.hookEventName, event);
      assert.match(text, /Use this project's bound Brain proactively/);
      assert.match(text, /brain create --id/); assert.match(text, /--expected-version/);
      assert.match(text, /发布必须经过双人审核/); assert.match(text, /Active Brain index/);
      assert.ok(Buffer.byteLength(text) <= 9500);
    }
  }
  for (const name of ['AGENTS.md', 'CLAUDE.md']) assert.equal(existsSync(join(root, name)), false);
});

test('missing Cloud credentials retain policy and commands without fabricating knowledge', async t => {
  const { root } = fixture(t);
  mergePreferences(root, { cloudBrain: { enabled: true, brainId: 'unavailable-brain' } });
  for (const agent of ['codex', 'claude-code']) {
    const output = await runHook(root, agent, 'prompt', { cwd: root, session_id: agent, turn_id: 't1', prompt: '发布' });
    const text = output.hookSpecificOutput.additionalContext;
    assert.match(text, /MindMux recall failed/); assert.match(text, /Use this project's bound Brain proactively/);
    assert.match(text, /brain update <id>/); assert.doesNotMatch(text, /Active Brain index/);
    assert.equal(readJson(join(root, `.mindmux/cli/last-${agent}-prompt.json`)).status, 'error');
    if (agent === 'codex') assert.match(text, /--review-token/);
  }
});

test('unbound hooks still teach selection and operations; Cursor retains its rule file', async t => {
  const { root } = fixture(t);
  for (const agent of ['codex', 'claude-code']) {
    const text = (await handleHook(root, agent, 'session-start', { cwd: root })).hookSpecificOutput.additionalContext;
    assert.match(text, /no selected Brain/); assert.match(text, /brain create --id/);
  }
  connect(root, 'cursor');
  assert.match(readFileSync(join(root, '.cursor/rules/mindmux.mdc'), 'utf8'), /BEGIN mindmux-cli/);
});

test('clean removes historical shared and current local Claude hooks while preserving foreign settings', async t => {
  const { root } = fixture(t);
  await setup(root, { local: true, yes: true, json: true, agent: 'claude-code,codex' }, { probe: async () => ({ recall: true }) });
  const local = join(root, '.claude/settings.local.json'), shared = join(root, '.claude/settings.json');
  writeJson(shared, { ...readJson(local), env: { TEAM_SETTING: 'keep' } });
  const { clean } = await import('../src/clean.mjs');
  await clean(root, { yes: true, 'keep-login': true });
  assert.equal(existsSync(local), false);
  assert.equal(existsSync(join(root, '.codex/hooks.json')), false);
  assert.deepEqual(readJson(shared), { env: { TEAM_SETTING: 'keep' } });
});

test('invalid historical Claude settings abort migration before changing team instructions', t => {
  const { root } = fixture(t); mkdirSync(join(root, '.claude'));
  const shared = join(root, '.claude/settings.json'), rules = join(root, 'CLAUDE.md');
  const text = managedBlock('Team text\n', 'legacy'); writeFileSync(rules, text);
  writeFileSync(shared, '{broken');
  assert.throws(() => connect(root, 'claude-code'), /Invalid JSON/);
  assert.equal(readFileSync(rules, 'utf8'), text);
  assert.equal(existsSync(join(root, '.claude/settings.local.json')), false);
});
