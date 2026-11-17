import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateProjects, refreshUpdateProjects } from '../src/update-projects.mjs';
import { update, formatUpdate } from '../src/update.mjs';
import { setup } from '../src/setup.mjs';
import { CLI_BIN } from '../src/integrations.mjs';
import { readJson, writeJson } from '../src/storage.mjs';

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mmx-update-projects-')));
  const home = join(dir, 'home'), root = join(dir, 'current'); mkdirSync(root);
  const oldHome = process.env.MINDMUX_HOME; process.env.MINDMUX_HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.MINDMUX_HOME; else process.env.MINDMUX_HOME = oldHome; rmSync(dir, { recursive: true, force: true }); });
  return { dir, home, root };
}
const current = { current: '0.1.4', latest: '0.1.4', available: false };
function backup(home, root, { legacy = false, key = root } = {}) {
  const hash = createHash('sha256').update(key).digest('hex');
  writeJson(join(home, 'backups', hash, '1.json'), { ...(legacy ? {} : { project: root }), files: [{ path: join(root, '.mindmux/cli/setup.json'), content: null }] });
}
function recordProject(home, root, options) {
  mkdirSync(root, { recursive: true });
  writeJson(join(root, '.mindmux/cli/integrations.json'), { codex: {} });
  backup(home, root, options);
}

test('an already-current CLI repairs obsolete launcher paths without reinstalling, login or Brain changes', async t => {
  const f = fixture(t);
  await setup(f.root, { local: true, yes: true, json: true, agent: 'claude-code,codex' }, { probe: async () => ({ recall: true }) });
  const prefs = readFileSync(join(f.root, '.mindmux/preferences.json'), 'utf8');
  const brain = readFileSync(join(f.root, 'brain/index.md'), 'utf8');
  const oldBin = join(f.dir, 'removed-0.1.1/bin/mmx.mjs');
  for (const name of ['.codex/config.toml', '.codex/hooks.json', '.mcp.json', '.claude/settings.local.json', '.mindmux/cli/setup.json', '.mindmux/cli/integrations.json']) {
    const path = join(f.root, name);
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll(CLI_BIN, oldBin));
  }
  const result = await update(f.root, {}, { check: async () => current,
    detect: async () => { throw new Error('Must not reinstall or detect package manager'); },
    run: async () => { throw new Error('Must not launch package manager or login'); } });
  assert.equal(result.status, 'current'); assert.equal(result.refresh.refreshed, true);
  for (const name of ['.codex/config.toml', '.codex/hooks.json', '.mcp.json', '.claude/settings.local.json']) {
    const content = readFileSync(join(f.root, name), 'utf8');
    assert.ok(content.includes(CLI_BIN)); assert.ok(!content.includes(oldBin));
  }
  assert.equal(readFileSync(join(f.root, '.mindmux/preferences.json'), 'utf8'), prefs);
  assert.equal(readFileSync(join(f.root, 'brain/index.md'), 'utf8'), brain);
  assert.match(formatUpdate(result), /Refreshed integrations/);
});

test('bulk refresh discovers legacy backups, deduplicates current and ignores removed, foreign and symlinked projects', t => {
  const f = fixture(t), other = join(f.dir, 'other'), unconfigured = join(f.dir, 'unconfigured'), missing = join(f.dir, 'missing');
  recordProject(f.home, f.root);
  recordProject(f.home, other, { legacy: true });
  mkdirSync(unconfigured); backup(f.home, unconfigured); backup(f.home, missing);
  const foreign = join(f.dir, 'unrecorded'); mkdirSync(foreign);
  // A backup cannot redirect its hashed project to a different directory.
  backup(f.home, foreign, { key: join(f.dir, 'wrong-hash') });
  const link = join(f.dir, 'alias'); symlinkSync(other, link); backup(f.home, link);
  assert.deepEqual(updateProjects(f.root).projects, [f.root]);
  const plan = updateProjects(f.root, { allProjects: true });
  assert.deepEqual(plan.projects, [f.root, other]);
  assert.ok(plan.warnings.some(w => w.includes(missing)));
  assert.ok(plan.warnings.some(w => w.includes(link)));
});

test('bulk refresh continues after a project failure and check-only never changes any project', async t => {
  const f = fixture(t), other = join(f.dir, 'other'); recordProject(f.home, other);
  const visited = [];
  const result = await refreshUpdateProjects(f.root, { allProjects: true }, { refresh: async root => {
    visited.push(root);
    if (root === f.root) throw new Error('Modified MCP configuration');
    return { refreshed: true, agents: ['codex'] };
  } });
  assert.deepEqual(visited, [f.root, other]); assert.equal(result.refreshed, true);
  assert.match(result.projects[0].error, /Modified/); assert.equal(result.projects[1].refreshed, true);
  assert.ok(result.warnings.some(w => w.includes(f.root)));
  const report = await update(f.root, { check: true, 'all-projects': true }, {
    check: async () => current, refresh: async () => { throw new Error('Read-only check must not refresh'); } });
  assert.equal(report.status, 'current'); assert.equal(report.refresh, undefined);
});

test('current-version refresh failures are reported without claiming successful repair', async t => {
  const f = fixture(t);
  const refresh = await refreshUpdateProjects(f.root, {}, { refresh: async () => { throw new Error('busy'); } });
  const result = await update(f.root, {}, { check: async () => current, refresh: async () => refresh });
  assert.equal(result.refresh.refreshed, false);
  assert.match(formatUpdate(result), /could not be refreshed/);
  assert.doesNotMatch(formatUpdate(result), /✓ Refreshed/);
});


test('legacy updater refresh command upgrades all recorded projects without an all-projects flag', async t => {
  const f = fixture(t), other = join(f.dir, 'other'); mkdirSync(other);
  const saved = new Map();
  for (const root of [f.root, other]) {
    await setup(root, { local: true, yes: true, json: true, agent: 'codex' }, { probe: async () => ({ recall: true }) });
    saved.set(root, readFileSync(join(root, 'brain/index.md'), 'utf8'));
    const path = join(root, '.codex/hooks.json'), config = readJson(path);
    config.hooks.Interrupt[0].hooks[0].timeout = 10;
    writeJson(path, config);
  }
  const { stdout } = await promisify(execFile)(process.execPath,
    [CLI_BIN, '--project', f.root, 'update', '--refresh-integrations', '--json'],
    { env: { ...process.env, MINDMUX_HOME: f.home }, timeout: 10000 });
  const report = JSON.parse(stdout);
  assert.equal(report.projects.length, 2); assert.deepEqual(report.warnings, []);
  for (const root of [f.root, other]) {
    assert.equal(report.projects.find(project => project.project === root).refreshed, true);
    assert.equal(readJson(join(root, '.codex/hooks.json')).hooks.Interrupt[0].hooks[0].timeout, 3);
    assert.equal(readFileSync(join(root, 'brain/index.md'), 'utf8'), saved.get(root));
  }
});

test('current-version refresh respects the updater lock and releases its own lock on failure', async t => {
  const f = fixture(t), lock = join(f.home, 'update.lock');
  mkdirSync(lock, { recursive: true });
  await assert.rejects(update(f.root, {}, { check: async () => current }), /Another update/);
  rmSync(lock, { recursive: true });
  await assert.rejects(update(f.root, {}, { check: async () => current, refresh: async () => { throw new Error('failed'); } }), /failed/);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(lock), false);
});

test('already-current updates refresh all recorded projects by default', async t => {
  const f = fixture(t), other = join(f.dir, 'second');
  for (const root of [f.root, other]) {
    mkdirSync(root, { recursive: true });
    await setup(root, { local: true, yes: true, json: true, agent: 'codex' }, { probe: async () => ({ recall: true }) });
    const path = join(root, '.codex/hooks.json'), config = readJson(path);
    config.hooks.Interrupt[0].hooks[0].timeout = 10;
    writeJson(path, config);
  }
  const result = await update(f.root, {}, { check: async () => current });
  assert.equal(result.refresh.projects.length, 2);
  for (const root of [f.root, other]) assert.equal(readJson(join(root, '.codex/hooks.json')).hooks.Interrupt[0].hooks[0].timeout, 3);
});
