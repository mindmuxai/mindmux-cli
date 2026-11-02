import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, planRepair, applyRepair } from '../src/setup.mjs';
import { diagnose, doctor, formatDoctor } from '../src/doctor.mjs';
import { runMenu } from '../src/menu.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { credentialPath } from '../src/cloud.mjs';
import { connect } from '../src/integrations.mjs';
import { binding, writeJson } from '../src/storage.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mmx-doctor-'));
  const root = join(dir, 'project'); mkdirSync(root);
  const oldHome = process.env.MINDMUX_HOME, oldCodex = process.env.CODEX_HOME;
  process.env.MINDMUX_HOME = join(dir, 'home'); process.env.CODEX_HOME = join(dir, 'codex');
  t.after(() => {
    if (oldHome === undefined) delete process.env.MINDMUX_HOME; else process.env.MINDMUX_HOME = oldHome;
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, root };
}
const dependencies = { probe: async () => ({ connected: true, recall: true }) };
const install = root => setup(root, { local: true, agent: 'codex', yes: true, json: true }, dependencies);

test('doctor repairs missing owned entries and instructions, preserving binding, data and unrelated configuration', async t => {
  const { root } = fixture(t); await install(root);
  const prefs = readFileSync(join(root, '.mindmux/preferences.json'), 'utf8');
  const brain = readFileSync(join(root, 'brain/index.md'), 'utf8');
  writeFileSync(join(root, '.codex/config.toml'), 'model = "user-model"\n');
  writeFileSync(join(root, 'AGENTS.md'), 'Keep user instructions.\n');
  const before = await diagnose(root);
  assert.equal(before.healthy, false); assert.equal(before.repair.available, true);
  const result = await doctor(root, { fix: true, yes: true, json: true }, dependencies);
  assert.equal(result.repairResult.applied, true); assert.equal(result.healthy, true);
  assert.ok(existsSync(result.repairResult.backup));
  assert.equal(readFileSync(join(root, '.mindmux/preferences.json'), 'utf8'), prefs);
  assert.equal(readFileSync(join(root, 'brain/index.md'), 'utf8'), brain);
  assert.match(readFileSync(join(root, '.codex/config.toml'), 'utf8'), /model = "user-model"/);
  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /Keep user instructions/);
});

test('doctor refreshes stale launcher paths and keeps migrated originals', async t => {
  const { root } = fixture(t); await install(root);
  const config = join(root, '.codex/config.toml'), manifest = join(root, '.mindmux/cli/setup.json');
  const data = JSON.parse(readFileSync(manifest));
  const previousNode = data.agents.codex.installed.command;
  data.agents.codex.installed.command = '/missing/old/node';
  data.agents.codex.original = { url: 'https://original.example/mcp' };
  writeJson(manifest, data);
  writeFileSync(config, readFileSync(config, 'utf8').replace(previousNode, '/missing/old/node'));
  const report = await doctor(root, { fix: true, yes: true, json: true }, dependencies);
  assert.equal(report.repairResult.applied, true);
  assert.equal(JSON.parse(readFileSync(manifest)).agents.codex.original.url, 'https://original.example/mcp');
  assert.doesNotMatch(readFileSync(config, 'utf8'), /missing\/old/);
});

test('doctor refuses modified entries and malformed configuration without writing', async t => {
  const { root } = fixture(t); await install(root);
  const config = join(root, '.codex/config.toml');
  for (const content of ['[mcp_servers.mindmux_cli]\ncommand = "custom-command"\n', 'invalid = [']) {
    writeFileSync(config, content);
    const report = await doctor(root, { fix: true, yes: true, json: true }, dependencies);
    assert.equal(report.repair.available, false);
    assert.equal(report.repairResult.applied, false);
    assert.equal(readFileSync(config, 'utf8'), content);
    assert.match(formatDoctor(report), /Automatic repair unavailable/);
  }
});

test('doctor preview and cancellation do not mutate files; changed plans are rejected', async t => {
  const { root } = fixture(t); await install(root);
  rmSync(join(root, 'AGENTS.md'));
  const plan = planRepair(root);
  let confirmations = 0;
  const cancelled = await doctor(root, { fix: true, json: true }, { ...dependencies, prompts: { confirm: async () => { confirmations++; return false; } } });
  assert.equal(cancelled.repairResult.cancelled, true); assert.equal(confirmations, 1);
  assert.equal(existsSync(join(root, 'AGENTS.md')), false);
  writeFileSync(join(root, 'AGENTS.md'), 'New user edits\n');
  await assert.rejects(applyRepair(root, plan, { json: true }, dependencies), /Configuration changed after the repair plan/);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'New user edits\n');
});

test('doctor rolls back failed repair and rejects symlinks', async t => {
  const { dir, root } = fixture(t); await install(root);
  rmSync(join(root, 'AGENTS.md'));
  const failed = await doctor(root, { fix: true, yes: true, json: true }, { probe: async () => { throw new Error('failed check'); } });
  assert.equal(failed.repairResult.applied, false); assert.match(failed.repairResult.error, /configuration restored/);
  assert.equal(existsSync(join(root, 'AGENTS.md')), false);
  const external = join(dir, 'external.md'); writeFileSync(external, 'external'); symlinkSync(external, join(root, 'AGENTS.md'));
  assert.equal((await diagnose(root)).repair.available, false);
  assert.equal(readFileSync(external, 'utf8'), 'external');
});

test('doctor has readable output, explicit JSON, and no repair without noninteractive confirmation', async t => {
  const { root } = fixture(t); await install(root);
  const run = promisify(execFile), bin = new URL('../bin/mmx.mjs', import.meta.url).pathname;
  const args = [bin, '--project', root];
  const human = await run(process.execPath, [...args, 'doctor']);
  assert.match(human.stdout, /MindMux doctor/); assert.throws(() => JSON.parse(human.stdout));
  const json = JSON.parse((await run(process.execPath, [...args, 'doctor', '--json'])).stdout);
  assert.equal(json.healthy, true);
  rmSync(join(root, 'AGENTS.md'));
  await assert.rejects(run(process.execPath, [...args, 'doctor', '--fix', '--json']), error => {
    assert.match(JSON.parse(error.stdout).repairResult.reason, /--fix --yes/); return true;
  });
  assert.equal(existsSync(join(root, 'AGENTS.md')), false);
  const help = await run(process.execPath, args); assert.match(help.stdout, /^mmx —/);
});

test('menu offers setup first when unconfigured and returns after a recoverable error', async t => {
  const { root } = fixture(t); let count = 0; const calls = [], messages = [];
  await runMenu(root, { write: value => messages.push(value), run: async args => { calls.push(args); throw new Error('offline'); },
    prompts: { choose: async (_message, choices) => { count++; assert.deepEqual(choices[0].value, ['setup']); return count === 1 ? ['setup'] : 'exit'; } } });
  assert.deepEqual(calls, [['setup']]); assert.ok(messages.some(message => message.includes('offline')));
});

test('configured menu supports switching and cancelled removal without executing it', async t => {
  const { root } = fixture(t); await install(root);
  const choices = [['switch'], 'more', 'remove', 'codex', 'exit']; const calls = [];
  await runMenu(root, { write: () => {}, run: async args => calls.push(args), prompts: {
    choose: async (_message, options) => { assert.ok(options.length); return choices.shift(); }, confirm: async () => false,
  } });
  assert.deepEqual(calls, [['switch']]);
  await runMenu(root, { write: () => {}, run: async () => { throw new Error('Must not run'); }, prompts: {
    choose: async () => { const error = new Error('cancelled'); error.name = 'ExitPromptError'; throw error; },
  } });
});


test('doctor restores missing inherited-server overrides while preserving original migration data', async t => {
  const { root } = fixture(t); await install(root);
  const manifestPath = join(root, '.mindmux/cli/setup.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  manifest.agents.codex.suppressed = { remote_alias: null };
  writeJson(manifestPath, manifest);
  const report = await doctor(root, { fix: true, yes: true, json: true }, dependencies);
  assert.equal(report.repairResult.applied, true);
  assert.match(readFileSync(join(root, '.codex/config.toml'), 'utf8'), /remote_alias/);
  assert.match(readFileSync(join(root, '.codex/config.toml'), 'utf8'), /enabled = false/);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath)).agents.codex.suppressed, { remote_alias: null });
});

test('Cloud repair retains the explicit binding and login without any remote write', async t => {
  const { root } = fixture(t); await install(root);
  const server = 'https://mcp.mindmux.ai/mcp';
  const prefsPath = join(root, '.mindmux/preferences.json');
  const prefs = JSON.parse(readFileSync(prefsPath));
  prefs.cloudBrain = { enabled: true, brainId: 'existing-cloud-brain', name: 'Existing Brain', workspaceId: 'workspace', workspaceName: 'Existing Workspace' };
  prefs.mindmuxCli = { server }; writeJson(prefsPath, prefs);
  writeJson(credentialPath(server), { tokens: { access_token: 'fixture-token' } });
  const login = readFileSync(credentialPath(server), 'utf8');
  rmSync(join(root, 'AGENTS.md'));
  const calls = [];
  const cloud = async (_server, run) => {
    const call = async (name, args) => { calls.push(name); assert.equal(name, 'resolve_brain'); assert.equal(args.brainId, 'existing-cloud-brain'); return { status: 'resolved', brain: { name: 'Existing Brain' } }; };
    call.listTools = async () => ({ tools: [] }); return run(call);
  };
  const result = await doctor(root, { fix: true, yes: true, json: true }, { ...dependencies, cloud, login: async () => { throw new Error('Unexpected login'); } });
  assert.equal(result.repairResult.applied, true);
  assert.equal(result.binding.brainId, 'existing-cloud-brain');
  assert.deepEqual(JSON.parse(readFileSync(prefsPath)).cloudBrain, prefs.cloudBrain);
  assert.equal(readFileSync(credentialPath(server), 'utf8'), login);
  assert.deepEqual(calls, ['resolve_brain']);
});


test('doctor reports malformed instruction markers as unhealthy and exits nonzero without changing them', async t => {
  const { root } = fixture(t); await install(root);
  const rules = join(root, 'AGENTS.md'); const content = readFileSync(rules, 'utf8');
  writeFileSync(rules, content + content);
  const report = await diagnose(root);
  assert.equal(report.healthy, false);
  assert.equal(report.repair.available, false);
  assert.ok(report.checks.some(check => check.state === 'error' && /Malformed.*markers/.test(check.message)));
  assert.match(formatDoctor(report), /Malformed.*markers/);
  const run = promisify(execFile), bin = new URL('../bin/mmx.mjs', import.meta.url).pathname;
  for (const flags of [[], ['--json'], ['--fix', '--yes', '--json']]) {
    await assert.rejects(run(process.execPath, [bin, '--project', root, 'doctor', ...flags]), error => {
      assert.equal(error.code, 1);
      if (flags.includes('--json')) assert.equal(JSON.parse(error.stdout).healthy, false);
      else assert.match(error.stdout, /Malformed.*markers/);
      return true;
    });
  }
  assert.equal(readFileSync(rules, 'utf8'), content + content);
});

test('doctor surfaces global Codex transport conflicts in both text and JSON output', async t => {
  const { root } = fixture(t); await install(root);
  const globalConfig = join(process.env.CODEX_HOME, 'config.toml');
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const content = '[mcp_servers.mindmux_cli]\nurl = "https://example.com/mcp"\n';
  writeFileSync(globalConfig, content);
  const report = await diagnose(root);
  assert.equal(report.healthy, false);
  assert.match(report.repair.reason, /Global Codex entry mindmux_cli/);
  assert.match(formatDoctor(report), /Global Codex entry mindmux_cli/);
  const run = promisify(execFile), bin = new URL('../bin/mmx.mjs', import.meta.url).pathname;
  await assert.rejects(run(process.execPath, [bin, '--project', root, 'doctor', '--json']), error => {
    assert.equal(error.code, 1); assert.equal(JSON.parse(error.stdout).healthy, false); return true;
  });
  const result = await doctor(root, { fix: true, yes: true, json: true });
  assert.equal(result.repairResult.applied, false);
  assert.equal(readFileSync(globalConfig, 'utf8'), content);
});

test('a valid connect-only installation remains healthy without an automatic repair plan', async t => {
  const { root } = fixture(t); await install(root);
  writeJson(join(root, '.mindmux/cli/setup.json'), { agents: {} });
  connect(root, 'codex');
  const report = await diagnose(root);
  assert.equal(report.healthy, true);
  assert.equal(report.repair.available, false);
  assert.equal(report.checks.some(check => check.state === 'error'), false);
});

test('menu preserves local binding when refreshing or configuring agents after removal', async t => {
  const { root } = fixture(t); await install(root);
  let loginCalls = 0; const calls = [];
  for (const installed of [true, false]) {
    if (!installed) writeJson(join(root, '.mindmux/cli/setup.json'), { agents: {} });
    let selected = false;
    await runMenu(root, { write: () => {}, prompts: {
      choose: async (_message, options) => {
        if (selected) return 'exit'; selected = true;
        return options.find(option => option.name === (installed ? 'Set up or refresh agent connections' : 'Set up this project')).value;
      },
    }, run: async args => {
      calls.push(args);
      await setup(root, { local: args.includes('--local'), agent: 'codex', yes: true, json: true }, {
        ...dependencies, login: async () => { loginCalls++; throw new Error('Unexpected Cloud login'); },
        cloud: async () => { throw new Error('Unexpected Cloud request'); },
      });
    } });
    assert.equal(binding(root).kind, 'local');
  }
  assert.deepEqual(calls, [['setup', '--local'], ['setup', '--local']]);
  assert.equal(loginCalls, 0);
});
