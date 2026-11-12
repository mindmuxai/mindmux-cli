import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkUpdate, detectInstallation, notifyUpdate, update, formatUpdate } from '../src/update.mjs';
import { runMenu } from '../src/menu.mjs';
import { refreshIntegrations, setup } from '../src/setup.mjs';
import { connect } from '../src/integrations.mjs';
import { writeJson, readJson } from '../src/storage.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mmx update 'quoted' "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'project'); mkdirSync(root);
  return { dir, root, home: join(dir, 'home') };
}
const release = { current: '0.1.1', latest: '0.1.2', node: '>=22', available: true };
const fetcher = value => async () => ({ ok: true, json: async () => ({ name: '@mindmux/cli', version: '0.1.2', engines: { node: '>=22' }, ...value }) });

test('release check uses semver, daily cache, forced refresh and rejects bad metadata', async t => {
  const f = fixture(t), cachePath = join(f.dir, 'cache.json');
  let requests = 0;
  const request = async (...args) => { requests++; assert.match(args[0], /^https:\/\/registry.npmjs.org\//); return fetcher()(...args); };
  assert.equal((await checkUpdate({ current: '0.1.1', cachePath, fetcher: request, now: 100 })).available, true);
  assert.equal((await checkUpdate({ current: '0.1.3', cachePath, fetcher: request, now: 101 })).available, false);
  assert.equal(requests, 1);
  await checkUpdate({ current: '0.1.1', cachePath, fetcher: request, force: true, now: 102 });
  assert.equal(requests, 2);
  await checkUpdate({ current: '0.1.1', cachePath, fetcher: request, now: 86400103 });
  assert.equal(requests, 3);
  for (const data of [{ name: 'wrong' }, { version: '0.2.0-beta.1' }, { version: 'garbage' }, { engines: { node: 'invalid range' } }]) {
    await assert.rejects(checkUpdate({ cachePath, force: true, fetcher: fetcher(data) }), /Registry returned/);
  }
  assert.equal((await checkUpdate({ current: '0.1.2-dev.1', cachePath, force: true, fetcher: fetcher() })).available, true);
});

test('failed passive checks are cached and corrupt/unwritable caches do not block checks', async t => {
  const f = fixture(t), cachePath = join(f.dir, 'cache.json');
  let calls = 0;
  const offline = async () => { calls++; throw new Error('offline'); };
  await assert.rejects(checkUpdate({ cachePath, fetcher: offline, now: 100 }), /offline/);
  assert.equal((await checkUpdate({ cachePath, fetcher: offline, now: 101 })).available, false);
  assert.equal(calls, 1);
  await assert.rejects(checkUpdate({ cachePath, fetcher: offline, now: 102, force: true }), /offline/);
  writeFileSync(cachePath, '{broken');
  assert.equal((await checkUpdate({ cachePath, fetcher: fetcher() })).latest, '0.1.2');
  const unwritable = join(f.dir, 'file'); writeFileSync(unwritable, 'not a directory');
  assert.equal((await checkUpdate({ cachePath: join(unwritable, 'cache'), fetcher: fetcher() })).latest, '0.1.2');
});

test('notifications are TTY-only and exclude MCP, hooks, JSON, CI and opt-outs', async () => {
  let checks = 0, text = '';
  const input = { isTTY: true }, output = { isTTY: true, write: value => { text += value; } };
  const options = { stdin: input, stderr: output, env: {}, check: async () => { checks++; return release; } };
  for (const argv of [[], ['setup'], ['status'], ['doctor'], ['--project', '/tmp/project', 'status']]) await notifyUpdate({ ...options, argv });
  assert.equal(checks, 5); assert.match(text, /Run mmx update/);
  for (const argv of [['hook', 'prompt'], ['--project', '/tmp/project', 'mcp', 'serve'], ['mcp', 'serve'], ['brain', 'read', 'a'], ['status', '--json'], ['--version'], ['status', '--help'], ['setup', '--yes'], ['setup', '--non-interactive']]) await notifyUpdate({ ...options, argv });
  for (const env of [{ CI: '1' }, { NO_UPDATE_NOTIFIER: '1' }, { MINDMUX_NO_UPDATE_CHECK: '1' }]) await notifyUpdate({ ...options, env, argv: ['status'] });
  await notifyUpdate({ ...options, stdin: {}, argv: ['status'] });
  assert.equal(checks, 5);
  await notifyUpdate({ ...options, argv: ['status'], check: async () => { throw new Error('timeout'); } });
});

test('installation ownership uses canonical global roots, not package-manager environment hints', async t => {
  const f = fixture(t), npmRoot = join(f.dir, 'npm/lib/node_modules'), pnpmRoot = join(f.dir, 'pnpm/node_modules');
  const packageRoot = join(npmRoot, '@mindmux/cli'); mkdirSync(packageRoot, { recursive: true }); mkdirSync(pnpmRoot, { recursive: true });
  const run = async name => name === 'npm' ? npmRoot : pnpmRoot;
  assert.equal((await detectInstallation({ packageRoot, run })).manager, 'npm');
  mkdirSync(join(pnpmRoot, '@mindmux')); symlinkSync(packageRoot, join(pnpmRoot, '@mindmux/cli'));
  assert.equal((await detectInstallation({ packageRoot, run })).kind, 'unknown');
  assert.equal((await detectInstallation({ packageRoot, run, manager: 'pnpm' })).manager, 'pnpm');
  await assert.rejects(detectInstallation({ packageRoot, run, manager: 'yarn' }), /--manager/);
  writeFileSync(join(packageRoot, '.git'), 'gitdir: worktree');
  assert.equal((await detectInstallation({ packageRoot, run })).kind, 'source');
  const local = join(f.root, 'node_modules/@mindmux/cli'); mkdirSync(local, { recursive: true });
  assert.equal((await detectInstallation({ packageRoot: local, run })).kind, 'local');
});

function updateDependencies(f, manager = 'npm') {
  const calls = [], globalRoot = join(f.dir, 'global/node_modules');
  const installation = { kind: 'global', manager, globalRoot, path: join(globalRoot, '@mindmux/cli') };
  const deps = {
    home: f.home, check: async () => release, detect: async () => installation, current: '0.1.1', write: () => {},
    run: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'root') return globalRoot;
      if (args.includes('--refresh-integrations')) return JSON.stringify({ refreshed: true, agents: ['codex'] });
      if (args.includes('--version')) return '0.1.2';
      return '';
    },
  };
  return { deps, calls, installation };
}

test('npm/pnpm updates pin the checked version, re-resolve paths and refresh through the new CLI', async t => {
  for (const manager of ['npm', 'pnpm']) {
    const f = fixture(t), { deps, calls } = updateDependencies(f, manager);
    const result = await update(f.root, { yes: true }, deps);
    assert.equal(result.status, 'updated'); assert.equal(result.warnings.length, 0);
    assert.deepEqual(calls[0], { command: manager, args: [manager === 'npm' ? 'install' : 'add', '-g', '@mindmux/cli@0.1.2', '--registry=https://registry.npmjs.org'] });
    assert.ok(calls.find(c => c.args.includes('--refresh-integrations')).args.includes(f.root));
    assert.equal(existsSync(join(f.home, 'update.lock')), false);
  }
});

test('check-only, current, manual and cancellation never invoke installation', async t => {
  const f = fixture(t), { deps, calls } = updateDependencies(f);
  assert.equal((await update(f.root, { check: true }, deps)).status, 'available');
  assert.equal((await update(f.root, {}, { ...deps, check: async () => ({ ...release, available: false }) })).status, 'current');
  assert.equal((await update(f.root, { yes: true }, { ...deps, detect: async () => ({ kind: 'source', path: f.root }) })).status, 'manual');
  assert.equal((await update(f.root, {}, { ...deps, prompts: { confirm: async () => false } })).status, 'cancelled');
  assert.deepEqual(calls, []);
  await assert.rejects(update(f.root, { yes: true }, { ...deps, check: async () => ({ ...release, node: '>=999' }) }), /Upgrade Node/);
});

test('installation changes, locks, failed installs and version mismatches stop without refreshing', async t => {
  const f = fixture(t), { deps, calls, installation } = updateDependencies(f);
  let count = 0;
  await assert.rejects(update(f.root, { yes: true }, { ...deps, detect: async () => count++ ? { ...installation, path: 'changed' } : installation }), /changed/);
  assert.deepEqual(calls, []);
  mkdirSync(join(f.home, 'update.lock'));
  await assert.rejects(update(f.root, { yes: true }, deps), /Another update/);
  rmSync(join(f.home, 'update.lock'), { recursive: true });
  await assert.rejects(update(f.root, { yes: true }, { ...deps, run: async () => { throw new Error('EACCES'); } }), /installation failed/);
  assert.equal(existsSync(join(f.home, 'update.lock')), false);
  await assert.rejects(update(f.root, { yes: true }, { ...deps, run: async (command, args) => args.includes('--version') ? '0.1.1' : deps.run(command, args) }), /version verification failed/);
  assert.ok(!calls.some(c => c.args.includes('--refresh-integrations')));
});

test('refresh failure and PATH shadowing are reported as partial completion', async t => {
  const f = fixture(t), { deps } = updateDependencies(f);
  const report = await update(f.root, { yes: true }, { ...deps, run: async (command, args) => {
    if (args.includes('--refresh-integrations')) throw new Error('foreign config');
    if (command === 'mmx') return '0.0.1';
    return deps.run(command, args);
  } });
  assert.equal(report.status, 'updated'); assert.equal(report.warnings.length, 2);
  assert.match(formatUpdate(report), /could not be refreshed/);
  assert.doesNotMatch(formatUpdate(report), /✓ Refreshed/);
});

test('offline refresh preserves Brain, credentials and foreign configuration without any Cloud access', async t => {
  const f = fixture(t), oldHome = process.env.MINDMUX_HOME;
  process.env.MINDMUX_HOME = f.home;
  t.after(() => { if (oldHome === undefined) delete process.env.MINDMUX_HOME; else process.env.MINDMUX_HOME = oldHome; });
  const foreign = join(f.root, '.mcp.json'); writeJson(foreign, { mcpServers: { other: { command: 'foreign' } } });
  await setup(f.root, { local: true, yes: true, json: true, agent: 'claude-code' }, { probe: async () => ({ recall: true }) });
  // Cloud binding with no credentials: a refresh must not try logging in or reading Cloud.
  writeJson(join(f.root, '.mindmux/preferences.json'), { cloudBrain: { enabled: true, brainId: 'unchanged-brain' }, keep: true });
  writeJson(join(f.home, 'auth/credentials.json'), { keep: 'secret fixture' });
  const prefs = readFileSync(join(f.root, '.mindmux/preferences.json'), 'utf8');
  const auth = readFileSync(join(f.home, 'auth/credentials.json'), 'utf8');
  const original = readFileSync(join(f.root, 'brain/index.md'), 'utf8');
  connect(f.root, 'cursor');
  const result = await refreshIntegrations(f.root);
  assert.deepEqual(result.agents, ['claude-code', 'cursor']);
  assert.equal(readFileSync(join(f.root, '.mindmux/preferences.json'), 'utf8'), prefs);
  assert.equal(readFileSync(join(f.home, 'auth/credentials.json'), 'utf8'), auth);
  assert.equal(readFileSync(join(f.root, 'brain/index.md'), 'utf8'), original);
  assert.equal(readJson(foreign).mcpServers.other.command, 'foreign');
  assert.equal(readJson(foreign).mcpServers.mindmux.args[0], new URL('../bin/mmx.mjs', import.meta.url).pathname);
  const run = promisify(execFile);
  const child = await run(process.execPath, [new URL('../bin/mmx.mjs', import.meta.url).pathname, '--project', f.root, 'update', '--refresh-integrations', '--json'], { env: { ...process.env, MINDMUX_HOME: f.home } });
  assert.equal(JSON.parse(child.stdout).refreshed, true);
});

test('refresh rolls back all managed files on invalid configuration and respects setup locks', async t => {
  const f = fixture(t), oldHome = process.env.MINDMUX_HOME; process.env.MINDMUX_HOME = f.home;
  t.after(() => { if (oldHome === undefined) delete process.env.MINDMUX_HOME; else process.env.MINDMUX_HOME = oldHome; });
  connect(f.root, 'claude-code'); connect(f.root, 'codex');
  const rules = join(f.root, 'CLAUDE.md'), before = readFileSync(rules, 'utf8');
  writeFileSync(join(f.root, '.codex/hooks.json'), '{broken');
  await assert.rejects(refreshIntegrations(f.root), /Invalid JSON/);
  assert.equal(readFileSync(rules, 'utf8'), before);
  assert.equal(readFileSync(join(f.root, '.codex/hooks.json'), 'utf8'), '{broken');
  mkdirSync(join(f.root, '.mindmux/cli/setup.lock'));
  await assert.rejects(refreshIntegrations(f.root), /Another setup/);
});

test('interactive menu exits after an update instead of reusing the old process', async t => {
  const f = fixture(t); let calls = 0;
  await runMenu(f.root, { write: () => {}, prompts: { choose: async (_message, options) => {
    calls++; assert.equal(calls, 1); return options.find(option => option.name === 'Check for CLI updates').value;
  } }, run: async args => { assert.deepEqual(args, ['update']); return { status: 'updated' }; } });
  assert.equal(calls, 1);
});
