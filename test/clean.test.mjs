import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { clean } from '../src/clean.mjs';

const bin = fileURLToPath(new URL('../bin/mmx.mjs', import.meta.url));
const exec = promisify(execFile);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mmx-clean-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'project'); mkdirSync(root);
  const home = join(dir, 'home');
  return { dir, root, home, env: { ...process.env, MINDMUX_HOME: home, CODEX_HOME: join(dir, 'codex') } };
}
const run = async (f, ...args) => JSON.parse((await exec(process.execPath, [bin, '--project', f.root, ...args, '--json'], { env: f.env })).stdout);
const put = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
function login(f) {
  put(join(f.home, 'auth', 'test.json'), { tokens: { access_token: 'fake-test-token' } });
  put(join(f.home, 'config.json'), { server: 'https://example.com/mcp' });
}

test('clean resets local setup, data, caches, project backups and login while preserving unrelated content', async t => {
  const f = fixture(t);
  put(join(f.root, 'AGENTS.md'), 'Keep my instructions.\n');
  put(join(f.root, '.codex/config.toml'), 'model = "custom"\n');
  await run(f, 'setup', '--local', '--agent', 'claude-code,codex', '--yes');
  await run(f, 'connect', '--agent', 'cursor');
  login(f);
  put(join(f.home, 'backups/another-project/keep.json'), {});
  put(join(f.root, '.mindmux/cli/sessions/test.json'), { context: 'cached knowledge' });
  put(join(f.root, 'keep.txt'), 'source content');
  const result = await run(f, 'clean', '--yes');
  assert.equal(result.cleaned, true); assert.equal(result.signedOut, true); assert.equal(result.cloudDataDeleted, false);
  for (const path of ['brain', 'BRAIN.md', '.mindmux/preferences.json', '.mindmux/cli', '.mcp.json', '.claude/settings.json', '.codex/hooks.json', '.cursor/rules/mindmux.mdc']) assert.equal(existsSync(join(f.root, path)), false, path);
  assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8').trim(), 'Keep my instructions.');
  assert.equal(readFileSync(join(f.root, '.codex/config.toml'), 'utf8').trim(), 'model = "custom"');
  assert.equal(readFileSync(join(f.root, 'keep.txt'), 'utf8'), 'source content');
  assert.equal(existsSync(join(f.home, 'auth')), false);
  assert.equal(existsSync(join(f.home, 'config.json')), false);
  assert.deepEqual(readdirSync(join(f.home, 'backups')), ['another-project']);
  assert.equal((await run(f, 'brain', 'status')).kind, 'unbound');
  assert.equal((await run(f, 'clean', '--yes')).cleaned, true);
  assert.equal((await run(f, 'setup', '--local', '--agent', 'codex', '--yes')).mcp.recall, true);
});

test('clean removes a Cloud binding without network access and can keep login and unknown preferences', async t => {
  const f = fixture(t); login(f);
  put(join(f.root, '.mindmux/preferences.json'), { version: 1, cloudBrain: { enabled: true, brainId: 'remote-brain' }, mindmuxCli: { server: 'https://unreachable.invalid/mcp' }, otherSetting: true });
  const result = await run(f, 'clean', '--keep-login', '--yes');
  assert.equal(result.cloudDataDeleted, false); assert.equal(result.signedOut, false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, '.mindmux/preferences.json'))), { version: 1, otherSetting: true });
  assert.ok(existsSync(join(f.home, 'auth/test.json')));
  assert.ok(existsSync(join(f.home, 'config.json')));
  assert.equal((await run(f, 'brain', 'status')).kind, 'unbound');
});

test('clean requires confirmation; cancellation makes no changes and defaults to readable output', async t => {
  const f = fixture(t); login(f);
  put(join(f.root, '.mindmux/preferences.json'), { cloudBrain: { enabled: true, brainId: 'test' } });
  await assert.rejects(exec(process.execPath, [bin, '--project', f.root, 'clean'], { env: f.env }), /pass --yes/);
  const old = process.env.MINDMUX_HOME; process.env.MINDMUX_HOME = f.home;
  t.after(() => { if (old === undefined) delete process.env.MINDMUX_HOME; else process.env.MINDMUX_HOME = old; });
  let scope;
  const cancelled = await clean(f.root, {}, { prompts: { confirm: async text => { scope = text; return false; } } });
  assert.equal(cancelled.cancelled, true);
  assert.match(scope, /all servers/); assert.match(scope, /Cloud Projects and Brains will be kept/);
  assert.ok(existsSync(join(f.root, '.mindmux/preferences.json')));
  assert.ok(existsSync(join(f.home, 'auth/test.json')));
  assert.equal(existsSync(join(f.root, '.mindmux/cli')), false);
  const result = await exec(process.execPath, [bin, '--project', f.root, 'clean', '--yes'], { env: f.env });
  assert.match(result.stdout, /Local MindMux setup has been reset/);
  assert.match(result.stdout, /Run mmx setup/);
  assert.throws(() => JSON.parse(result.stdout));
});

test('clean refuses modified managed MCP entries before removing any data or credentials', async t => {
  const f = fixture(t); login(f);
  await run(f, 'setup', '--local', '--agent', 'claude-code', '--yes');
  const path = join(f.root, '.mcp.json');
  const config = JSON.parse(readFileSync(path)); config.mcpServers.mindmux.command = 'custom-command'; put(path, config);
  await assert.rejects(run(f, 'clean', '--yes'), /changed outside/);
  assert.ok(existsSync(join(f.root, 'brain/index.md')));
  assert.ok(existsSync(join(f.root, '.mindmux/preferences.json')));
  assert.ok(existsSync(join(f.home, 'auth/test.json')));
});

test('clean rejects symlinks, unsafe data paths, and active locks', async t => {
  const f = fixture(t); login(f);
  const outside = join(f.dir, 'outside'); mkdirSync(outside); put(join(outside, 'keep.txt'), 'keep');
  symlinkSync(outside, join(f.root, 'brain'));
  await assert.rejects(run(f, 'clean', '--yes'), /symbolic link/);
  rmSync(join(f.root, 'brain'));
  put(join(f.root, '.mindmux/preferences.json'), { brainRoot: '.' });
  await assert.rejects(run(f, 'clean', '--yes'), /Unsafe local Brain/);
  rmSync(join(f.root, '.mindmux/preferences.json'));
  for (const lock of ['setup.lock', 'write.lock']) {
    const path = join(f.root, '.mindmux/cli', lock); mkdirSync(path, { recursive: true });
    await assert.rejects(run(f, 'clean', '--yes'), /active/); rmSync(path, { recursive: true });
  }
  mkdirSync(join(f.home, 'auth/test.lock'));
  await assert.rejects(run(f, 'clean', '--yes'), /authentication is busy/);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.ok(existsSync(join(f.home, 'auth/test.json')));
});

test('external local Brain data requires explicit inclusion and preserves a customized scaffold', async t => {
  const f = fixture(t); const sidecar = join(f.dir, 'sidecar');
  put(join(f.root, '.mindmux/preferences.json'), { brainRoot: '../sidecar' });
  await run(f, 'setup', '--local', '--agent', 'codex', '--yes');
  put(join(f.root, 'BRAIN.md'), 'Customized Brain instructions.');
  await assert.rejects(run(f, 'clean', '--yes'), /--include-external-data/);
  assert.ok(existsSync(join(sidecar, 'index.md')));
  await run(f, 'clean', '--include-external-data', '--yes');
  assert.equal(existsSync(sidecar), false);
  assert.equal(readFileSync(join(f.root, 'BRAIN.md'), 'utf8'), 'Customized Brain instructions.');
});


test('clean preserves unrelated Codex hooks while removing managed lifecycle handlers', async t => {
  const f = fixture(t);
  const path = join(f.root, '.codex/hooks.json');
  const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep-user-hook' }] }] } };
  put(path, foreign);
  await run(f, 'setup', '--local', '--agent', 'codex', '--yes');
  assert.equal(JSON.parse(readFileSync(path)).hooks.Stop.length, 2);
  await run(f, 'clean', '--yes');
  assert.deepEqual(JSON.parse(readFileSync(path)), foreign);
});
