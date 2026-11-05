import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { parse } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setup, switchBrain } from '../src/setup.mjs';
import { binding, writeJson } from '../src/storage.mjs';
import { credentialPath } from '../src/cloud.mjs';
import { status, formatStatus } from '../src/status.mjs';

const bin = fileURLToPath(new URL('../bin/mmx.mjs', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mindmux setup 'quoted' "));
  const root = join(dir, 'project'); mkdirSync(root);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, root, home: join(dir, 'auth home'), codexHome: join(dir, 'codex-home') };
}
function cli(f, args, fail = false) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [bin, '--project', f.root, ...(['setup', 'doctor', 'remove'].includes(args[0]) ? ['--json'] : []), ...args], { env: { ...process.env, MINDMUX_HOME: f.home, CODEX_HOME: f.codexHome }, timeout: 45000 }, (error, stdout, stderr) => {
      if (fail) return error ? resolve(stderr) : reject(new Error('Expected failure'));
      if (error) return reject(new Error(stderr || error.message));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(stdout)); }
    }); child.stdin.end();
  });
}
async function clientFor(t, f) {
  const client = new Client({ name: 'setup-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, '--project', f.root, 'mcp', 'serve'], env: { ...process.env, MINDMUX_HOME: f.home, CODEX_HOME: f.codexHome }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  await client.connect(transport); t.after(() => client.close());
  return client;
}
const tool = async (client, args) => {
  const result = await client.callTool({ name: 'mindmux_brain', arguments: args });
  if (result.isError) return result;
  return JSON.parse(result.content[0].text);
};

test('setup installs both project MCP launchers, probes stdio, preserves settings and removes cleanly', async t => {
  const f = fixture(t); mkdirSync(join(f.root, '.codex')); mkdirSync(join(f.root, '.claude'));
  writeFileSync(join(f.root, '.codex/config.toml'), '# keep my comment\nmodel = "custom"\n[mcp_servers.other]\ncommand = "other-tool"\n');
  writeFileSync(join(f.root, '.mcp.json'), JSON.stringify({ other: true, mcpServers: { other: { command: 'foreign' } } }));
  writeFileSync(join(f.root, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }] } }));
  const result = await cli(f, ['setup', '--local', '--agent', 'claude-code,codex', '--yes']);
  assert.equal(result.mcp.recall, true); assert.ok(existsSync(result.backup));
  const toml = readFileSync(join(f.root, '.codex/config.toml'), 'utf8');
  assert.match(toml, /keep my comment/); assert.equal(parse(toml).mcp_servers.other.command, 'other-tool');
  assert.equal(parse(toml).mcp_servers.mindmux_cli.env.MINDMUX_HOME, f.home);
  assert.equal(JSON.parse(readFileSync(join(f.root, '.mcp.json'))).other, true);
  assert.match(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), /MINDMUX_HOME/);
  await cli(f, ['setup', '--local', '--agent', 'claude-code,codex', '--yes']);
  assert.equal((readFileSync(join(f.root, '.codex/config.toml'), 'utf8').match(/BEGIN mindmux-cli MCP/g) || []).length, 1);
  const doctor = await cli(f, ['doctor', '--online']); assert.ok(doctor.mcp.every(x => x.configured)); assert.equal(doctor.mcpProbe.recall, true);
  await cli(f, ['remove']);
  const removed = parse(readFileSync(join(f.root, '.codex/config.toml'), 'utf8'));
  assert.equal(removed.mcp_servers?.mindmux_cli, undefined); assert.equal(removed.model, 'custom');
  assert.equal(JSON.parse(readFileSync(join(f.root, '.mcp.json'))).mcpServers.other.command, 'foreign');
  assert.equal(JSON.parse(readFileSync(join(f.root, '.claude/settings.json'))).hooks.Stop[0].hooks[0].command, 'echo unrelated');
  assert.ok(existsSync(join(f.root, 'brain/index.md')));
  await cli(f, ['setup', '--local', '--agent', 'codex', '--yes']);
});

test('stdio Brain tool preserves body bytes, checks versions, recalls and never accepts routing flags', async t => {
  const f = fixture(t); await cli(f, ['setup', '--local', '--agent', 'codex', '--yes']);
  const client = await clientFor(t, f);
  assert.equal((await client.listTools()).tools[0].name, 'mindmux_brain');
  const body = '认证使用 `SHA-256(workspaceId + ":" + replayBatchId)`。\n保留 $HOME、反斜杠 \\ 和反引号 `literal`。';
  const created = await tool(client, { operation: 'create', id: 'auth-byte-proof', title: '认证字节保真', category: 'decision', body, source: 'confirmed test' });
  const read = await tool(client, { operation: 'read', id: created.id }); assert.equal(read.compiledTruth.trim(), body);
  assert.ok((await tool(client, { operation: 'recall', query: '认证' })).pageIds.includes(created.id));
  const update = await tool(client, { operation: 'update', id: created.id, expectedVersion: read.version, summary: 'confirmed change', body: body + '\n新增确定规则。' });
  assert.notEqual(update.version, read.version);
  assert.equal((await tool(client, { operation: 'update', id: created.id, expectedVersion: read.version, summary: 'stale', body: 'wrong' })).isError, true);
  assert.equal((await tool(client, { operation: 'read', id: created.id, server: 'http://127.0.0.1' })).isError, true);
});

test('malformed config and foreign MCP entry fail before changing binding', async t => {
  const f = fixture(t); mkdirSync(join(f.root, '.codex'));
  writeFileSync(join(f.root, '.codex/config.toml'), 'not valid = [');
  await cli(f, ['setup', '--local', '--agent', 'codex', '--yes'], true);
  assert.equal(existsSync(join(f.root, '.mindmux/preferences.json')), false);
  writeFileSync(join(f.root, '.codex/config.toml'), '[mcp_servers.mindmux]\nurl = "https://mcp.mindmux.ai/mcp"\n');
  assert.match(await cli(f, ['setup', '--local', '--agent', 'codex', '--yes'], true), /--migrate/);
  assert.equal(existsSync(join(f.root, '.mindmux/preferences.json')), false);
  await cli(f, ['setup', '--local', '--agent', 'codex', '--yes', '--migrate']);
  await cli(f, ['remove', '--agent', 'codex']);
  assert.equal(parse(readFileSync(join(f.root, '.codex/config.toml'), 'utf8')).mcp_servers.mindmux.url, 'https://mcp.mindmux.ai/mcp');
});

test('failed probe rolls back config and preserves existing local Brain data', async t => {
  const f = fixture(t); const oldHome = process.env.MINDMUX_HOME; process.env.MINDMUX_HOME = f.home;
  t.after(() => { if (oldHome === undefined) delete process.env.MINDMUX_HOME; else process.env.MINDMUX_HOME = oldHome; });
  writeFileSync(join(f.root, 'AGENTS.md'), 'my instructions\n');
  await assert.rejects(setup(f.root, { local: true, agent: 'codex', yes: true }, { probe: async () => { throw new Error('simulated transport failure'); } }), /configuration restored/);
  assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), 'my instructions\n');
  assert.equal(existsSync(join(f.root, '.codex/config.toml')), false);
  assert.equal(existsSync(join(f.root, '.codex/hooks.json')), false);
  assert.equal(existsSync(join(f.root, '.mindmux/preferences.json')), false);
  assert.ok(existsSync(join(f.root, 'brain/index.md')));
});

test('setup refuses symlink config and remove preserves user-modified owned entries', async t => {
  const f = fixture(t); const elsewhere = join(f.dir, 'outside'); mkdirSync(elsewhere); symlinkSync(elsewhere, join(f.root, '.codex'));
  assert.match(await cli(f, ['setup', '--local', '--agent', 'codex', '--yes'], true), /symlink/);
  assert.equal(existsSync(join(elsewhere, 'config.toml')), false); rmSync(join(f.root, '.codex'));
  await cli(f, ['setup', '--local', '--agent', 'claude-code', '--yes']);
  const path = join(f.root, '.mcp.json'); const data = JSON.parse(readFileSync(path)); data.mcpServers.mindmux.command = 'user-customized'; writeFileSync(path, JSON.stringify(data));
  assert.match(await cli(f, ['remove'], true), /changed outside/);
  assert.equal(JSON.parse(readFileSync(path)).mcpServers.mindmux.command, 'user-customized');
  assert.match(readFileSync(join(f.root, 'CLAUDE.md'), 'utf8'), /BEGIN mindmux-cli/);
});


test('Codex local transport uses a separate name and disables inherited remote only in this project', async t => {
  const f = fixture(t); mkdirSync(f.codexHome);
  const globalConfig = '[mcp_servers.mindmux]\nurl = "https://mcp.mindmux.ai/mcp"\n[mcp_servers.unrelated]\ncommand = "foreign"\n';
  writeFileSync(join(f.codexHome, 'config.toml'), globalConfig);
  await cli(f, ['setup', '--local', '--agent', 'codex', '--yes']);
  const config = parse(readFileSync(join(f.root, '.codex/config.toml'), 'utf8'));
  assert.equal(config.mcp_servers.mindmux.enabled, false);
  assert.ok(config.mcp_servers.mindmux_cli.command);
  assert.equal(config.mcp_servers.mindmux_cli.url, undefined);
  assert.equal(readFileSync(join(f.codexHome, 'config.toml'), 'utf8'), globalConfig);
  await cli(f, ['setup', '--local', '--agent', 'codex', '--yes']);
  await cli(f, ['remove']);
  assert.equal(parse(readFileSync(join(f.root, '.codex/config.toml'), 'utf8')).mcp_servers, undefined);
  assert.equal(readFileSync(join(f.codexHome, 'config.toml'), 'utf8'), globalConfig);
});


test('SIGTERM releases an acquired authentication lock before process exit', async t => {
  const f = fixture(t);
  const moduleUrl = new URL('../src/cloud.mjs', import.meta.url).href;
  const worker = join(f.dir, 'lock-worker.mjs');
  writeFileSync(worker, `import { withAuthLock } from ${JSON.stringify(moduleUrl)};
await withAuthLock('http://127.0.0.1:12345/mcp', async () => { process.stdout.write('locked\\n'); await new Promise(() => setInterval(() => {}, 1000)); });
`);
  const child = spawn(process.execPath, [worker], { env: { ...process.env, MINDMUX_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  const { readdirSync } = await import('node:fs');
  assert.equal(readdirSync(join(f.home, 'auth')).some(name => name.endsWith('.lock')), false);
});

test('interrupting setup during probe rolls back configuration and releases its setup lock', async t => {
  const f = fixture(t);
  const moduleUrl = new URL('../src/setup.mjs', import.meta.url).href;
  const worker = join(f.dir, 'setup-worker.mjs');
  writeFileSync(worker, `import { setup } from ${JSON.stringify(moduleUrl)};\nawait setup(${JSON.stringify(f.root)}, { local: true, agent: 'codex', yes: true }, { probe: async () => { process.stdout.write('probe-start\\n'); await new Promise(() => setInterval(() => {}, 1000)); } });\n`);
  const child = spawn(process.execPath, [worker], { env: { ...process.env, MINDMUX_HOME: f.home, CODEX_HOME: f.codexHome }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  assert.equal(existsSync(join(f.root, '.codex/config.toml')), false);
  assert.equal(existsSync(join(f.root, '.codex/hooks.json')), false);
  assert.equal(existsSync(join(f.root, '.mindmux/preferences.json')), false);
  assert.equal(existsSync(join(f.root, '.mindmux/cli/setup.lock')), false);
  assert.ok(existsSync(join(f.root, 'brain/index.md')));
});

// Exercise the interactive flow without production credentials or remote writes.
function interactiveFixture(t, f, projects = []) {
  const originalHome = process.env.MINDMUX_HOME;
  process.env.MINDMUX_HOME = f.home;
  t.after(() => { if (originalHome === undefined) delete process.env.MINDMUX_HOME; else process.env.MINDMUX_HOME = originalHome; });
  const calls = [];
  const workspace = { id: 'test-workspace', name: 'Test Workspace' };
  const cloud = async (_server, run) => {
    const call = async (name, args) => {
      calls.push({ name, args });
      if (name === 'list_workspaces') return { workspaces: [workspace] };
      if (name === 'list_projects') return { projects };
      if (name === 'create_project') return { brainId: 'created-brain' };
      if (name === 'resolve_brain') return { status: 'resolved', brain: { name: 'Test Brain' } };
      throw new Error(`Unexpected tool: ${name}`);
    };
    call.listTools = async () => ({ tools: [] });
    return run(call);
  };
  const login = async () => {};
  const probe = async () => ({ recall: true });
  return { calls, workspace, cloud, login, probe };
}

test('interactive setup creates a named Project only through the create option and confirmation', async t => {
  const f = fixture(t); const flow = interactiveFixture(t, f);
  const prompts = {
    agents: async () => 'codex',
    choose: async (message, choices) => {
      if (message.includes('Workspace')) return choices[0].value;
      assert.equal(choices.length, 1); // Empty Workspace still offers creation.
      assert.match(choices[0].name, /Create a new Project/);
      return choices[0].value;
    },
    projectName: async () => 'mindmux-cli',
    confirm: async message => { assert.match(message, /mindmux-cli/); return true; },
  };
  const result = await setup(f.root, {}, { ...flow, prompts });
  assert.equal(result.binding.brainId, 'created-brain');
  assert.deepEqual(flow.calls.find(call => call.name === 'create_project').args, { workspaceId: 'test-workspace', name: 'mindmux-cli', description: '' });
  assert.equal(existsSync(join(f.root, '.mindmux/cli/setup.lock')), false);
});

test('cancelling creation returns to the Project menu and can bind an existing Project', async t => {
  const f = fixture(t); const project = { name: 'Existing Project', brainId: 'existing-brain' };
  const flow = interactiveFixture(t, f, [project]); let projectMenus = 0;
  const prompts = {
    agents: async () => 'codex',
    choose: async (message, choices) => {
      if (message.includes('Workspace')) return choices[0].value;
      projectMenus++;
      return choices[projectMenus === 1 ? 0 : 1].value;
    },
    projectName: async () => 'Cancelled Project',
    confirm: async () => false,
  };
  const result = await setup(f.root, {}, { ...flow, prompts });
  assert.equal(projectMenus, 2);
  assert.equal(result.binding.brainId, 'existing-brain');
  assert.equal(flow.calls.some(call => call.name === 'create_project'), false);
});

test('cancelling the interactive wizard releases its lock without creating or binding a Brain', async t => {
  const f = fixture(t); const flow = interactiveFixture(t, f);
  const prompts = { agents: async () => { const error = new Error('cancelled'); error.name = 'ExitPromptError'; throw error; } };
  await assert.rejects(setup(f.root, {}, { ...flow, prompts }), /Setup cancelled/);
  assert.equal(flow.calls.length, 0);
  assert.equal(existsSync(join(f.root, '.mindmux/preferences.json')), false);
  assert.equal(existsSync(join(f.root, '.mindmux/cli/setup.lock')), false);
});


test('setup defaults to a concise success message and supports explicit JSON output', async t => {
  const f = fixture(t);
  const run = promisify(execFile);
  const args = [bin, '--project', f.root, 'setup', '--local', '--agent', 'claude-code,codex', '--yes'];
  const options = { env: { ...process.env, MINDMUX_HOME: f.home, CODEX_HOME: f.codexHome }, timeout: 45000 };
  const human = await run(process.execPath, args, options);
  assert.match(human.stdout, /MindMux is ready/);
  assert.match(human.stderr, /Installing project integrations/);
  assert.match(human.stderr, /Checking MCP launch and Brain recall/);
  assert.match(human.stdout, /Project: project/);
  assert.match(human.stdout, /Configured for: Claude Code and Codex/);
  assert.match(human.stdout, /Restart Claude Code and Codex/);
  assert.doesNotMatch(human.stdout, /brainId|toolCount|backup|installed|instructions|native hooks/);
  assert.equal(human.stdout.includes(f.root), false);
  assert.throws(() => JSON.parse(human.stdout));
  const machine = await run(process.execPath, [...args, '--json'], options);
  assert.doesNotMatch(machine.stderr, /Installing project integrations|Checking MCP launch/);
  const report = JSON.parse(machine.stdout);
  assert.equal(report.installed, true);
  assert.equal(report.mcp.recall, true);
  assert.deepEqual(report.agents, ['claude-code', 'codex']);
  assert.ok(existsSync(report.backup));
});


test('switch uses menus with existing agents, keeps login and data, and restores binding on probe failure', async t => {
  const f = fixture(t); const flow = interactiveFixture(t, f, [{ name: 'Next Project', brainId: 'next-brain' }]);
  await setup(f.root, { local: true, agent: 'codex', yes: true, json: true }, flow);
  const credential = credentialPath('https://mcp.mindmux.ai/mcp');
  writeJson(credential, { tokens: { access_token: 'test-token' } });
  const savedLogin = readFileSync(credential, 'utf8');
  const dataPath = join(f.root, 'brain/index.md'); const savedData = readFileSync(dataPath, 'utf8');
  const prompts = { agents: async () => { throw new Error('Should reuse agents'); },
    choose: async (message, choices) => choices[message.includes('Workspace') ? 0 : 1].value };
  const login = async () => { throw new Error('Should reuse login'); };
  const result = await switchBrain(f.root, { json: true }, { ...flow, prompts, login });
  assert.equal(result.binding.brainId, 'next-brain');
  assert.deepEqual(result.agents, ['codex']);
  assert.equal((await status(f.root)).workspace, 'Test Workspace');
  const oldPrefs = readFileSync(join(f.root, '.mindmux/preferences.json'), 'utf8');
  const oldConfig = readFileSync(join(f.root, '.codex/config.toml'), 'utf8');
  await assert.rejects(switchBrain(f.root, { 'brain-id': 'failing-brain', yes: true, json: true }, {
    ...flow, login, probe: async () => { throw new Error('Probe unavailable'); },
  }), /Project configuration restored/);
  assert.equal(readFileSync(join(f.root, '.mindmux/preferences.json'), 'utf8'), oldPrefs);
  assert.equal(readFileSync(join(f.root, '.codex/config.toml'), 'utf8'), oldConfig);
  assert.equal(readFileSync(credential, 'utf8'), savedLogin);
  assert.equal(readFileSync(dataPath, 'utf8'), savedData);
  const cancel = { choose: async () => { const error = new Error('cancel'); error.name = 'ExitPromptError'; throw error; } };
  await assert.rejects(switchBrain(f.root, { json: true }, { ...flow, login, prompts: cancel }), /Setup cancelled/);
  assert.equal(readFileSync(join(f.root, '.mindmux/preferences.json'), 'utf8'), oldPrefs);
  assert.equal(flow.calls.some(c => c.name === 'create_project'), false);
  assert.equal(binding(f.root).brainId, 'next-brain');
});

test('created Project recovery keeps its ID and resumes without replaying the creation', async t => {
  const f = fixture(t); const flow = interactiveFixture(t, f);
  const flags = { agent: 'codex', 'workspace-id': 'test-workspace', name: 'New Project', confirm: true, yes: true, json: true };
  await assert.rejects(setup(f.root, flags, { ...flow, probe: async () => { throw new Error('offline'); } }), error => {
    assert.match(error.message, /Cloud Project was created and retained/);
    assert.match(error.message, /--brain-id 'created-brain'/);
    assert.match(error.message, /--server 'https:\/\/mcp.mindmux.ai\/mcp'/);
    return true;
  });
  assert.equal(binding(f.root).kind, 'unbound');
  assert.equal(existsSync(join(f.root, '.mindmux/cli/setup-pending.json')), true);
  await setup(f.root, flags, flow);
  assert.equal(flow.calls.filter(c => c.name === 'create_project').length, 1);
  assert.equal(existsSync(join(f.root, '.mindmux/cli/setup-pending.json')), false);
});

test('status reports configuration separately from client calls and excludes probes and stale receipts', async t => {
  const f = fixture(t);
  const run = promisify(execFile);
  const options = { env: { ...process.env, MINDMUX_HOME: f.home, CODEX_HOME: f.codexHome }, timeout: 45000 };
  const args = [bin, '--project', f.root];
  const empty = await run(process.execPath, [...args, 'status'], options);
  assert.match(empty.stdout, /Not selected/);
  await cli(f, ['setup', '--local', '--agent', 'codex', '--yes']);
  let report = JSON.parse((await run(process.execPath, [...args, 'status', '--online', '--json'], options)).stdout);
  assert.equal(report.live.accessible, true);
  assert.equal(report.mcpProbe.recall, true);
  assert.equal(report.receipts.length, 0);
  assert.match(formatStatus(report), /Codex: Configured/);
  const client = await clientFor(t, f);
  await tool(client, { operation: 'recall', query: 'sample' });
  report = JSON.parse((await run(process.execPath, [...args, 'status', '--json'], options)).stdout);
  assert.equal(report.receipts.length, 1);
  assert.equal(report.receipts[0].client, 'setup-test');
  assert.equal(report.receipts[0].operation, 'recall');
  assert.equal(JSON.stringify(report.receipts).includes('sample'), false);
  assert.match(formatStatus(report), /setup-test called mindmux_brain/);
  // Errors do not replace successful usage evidence.
  await tool(client, { operation: 'read', id: 'missing-page' });
  const receiptPath = join(f.root, '.mindmux/cli/last-mcp-tool.json');
  const receipt = JSON.parse(readFileSync(receiptPath));
  assert.equal(receipt.operation, 'recall');
  writeJson(receiptPath, { ...receipt, targetKey: 'old-binding' });
  report = JSON.parse((await run(process.execPath, [...args, 'status', '--json'], options)).stdout);
  assert.equal(report.receipts.length, 0);
  writeJson(receiptPath, { ...receipt, time: '2000-01-01T00:00:00.000Z' });
  report = JSON.parse((await run(process.execPath, [...args, 'status', '--json'], options)).stdout);
  assert.equal(report.receipts.length, 0);
});


test('status distinguishes Brain access from MCP launch failures', async t => {
  const f = fixture(t); const flow = interactiveFixture(t, f);
  await setup(f.root, { local: true, agent: 'codex', yes: true, json: true }, flow);
  const report = await status(f.root, { online: true }, {
    withBrain: async (_root, run) => run({ list: async () => [] }),
    probe: async () => { throw new Error('launcher failed'); },
  });
  assert.equal(report.live.accessible, true);
  assert.equal(report.mcpProbe.connected, false);
  assert.match(formatStatus(report), /MCP check: Failed: launcher failed/);
});

test('Codex setup upgrades instructions-only installs, preserves foreign hooks and removes only owned hooks', async t => {
  const f = fixture(t);
  const hooksPath = join(f.root, '.codex/hooks.json'); mkdirSync(join(f.root, '.codex'));
  const foreign = { description: 'User hooks', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] } };
  writeJson(hooksPath, foreign);
  await cli(f, ['setup', '--local', '--agent', 'codex', '--yes']);
  const installed = JSON.parse(readFileSync(hooksPath));
  assert.match(readFileSync(join(f.root, '.gitignore'), 'utf8'), /\/\.codex\/hooks\.json/);
  assert.equal(installed.hooks.SessionStart[0].hooks[0].additionalContextLimit, 10000);
  assert.equal(installed.hooks.Stop.at(-1).hooks[0].additionalContextLimit, undefined);
  assert.equal(installed.hooks.Interrupt[0].hooks[0].additionalContextLimit, undefined);
  assert.equal(installed.description, 'User hooks');
  assert.deepEqual(installed.hooks.Stop[0], foreign.hooks.Stop[0]);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) assert.ok(installed.hooks[event].some(group => group.hooks[0].command.includes('hook --agent codex')));
  const manifestPath = join(f.root, '.mindmux/cli/integrations.json');
  const manifest = JSON.parse(readFileSync(manifestPath)); manifest.codex.commands = []; manifest.codex.mode = 'instructions'; writeJson(manifestPath, manifest);
  writeJson(hooksPath, foreign);
  const run = promisify(execFile);
  const env = { ...process.env, MINDMUX_HOME: f.home, CODEX_HOME: f.codexHome };
  await assert.rejects(run(process.execPath, [bin, '--project', f.root, 'doctor', '--json'], { env }), error => {
    assert.equal(JSON.parse(error.stdout).healthy, false); return true;
  });
  const fixed = JSON.parse((await run(process.execPath, [bin, '--project', f.root, 'doctor', '--fix', '--yes', '--json'], { env })).stdout);
  assert.equal(fixed.repairResult.applied, true);
  assert.equal(fixed.integrations[0].mode, 'hooks');
  await cli(f, ['setup', '--local', '--agent', 'codex', '--yes']);
  assert.equal(JSON.parse(readFileSync(hooksPath)).hooks.Stop.length, 2);
  await cli(f, ['remove']);
  assert.deepEqual(JSON.parse(readFileSync(hooksPath)), foreign);
});


test('malformed Codex hooks fail before setup changes instructions or binding', async t => {
  const f = fixture(t); mkdirSync(join(f.root, '.codex'));
  const path = join(f.root, '.codex/hooks.json');
  writeFileSync(join(f.root, 'AGENTS.md'), 'Keep these instructions.\n');
  for (const content of ['{invalid', '{"hooks":{"Stop":{}}}']) {
    writeFileSync(path, content);
    await cli(f, ['setup', '--local', '--agent', 'codex', '--yes'], true);
    assert.equal(readFileSync(path, 'utf8'), content);
    assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), 'Keep these instructions.\n');
    assert.equal(existsSync(join(f.root, '.mindmux/preferences.json')), false);
  }
});
