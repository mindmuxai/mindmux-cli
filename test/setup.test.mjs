import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { parse } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setup } from '../src/setup.mjs';

const bin = fileURLToPath(new URL('../bin/mmx.mjs', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mindmux setup 'quoted' "));
  const root = join(dir, 'project'); mkdirSync(root);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, root, home: join(dir, 'auth home'), codexHome: join(dir, 'codex-home') };
}
function cli(f, args, fail = false) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [bin, '--project', f.root, ...args], { env: { ...process.env, MINDMUX_HOME: f.home, CODEX_HOME: f.codexHome }, timeout: 45000 }, (error, stdout, stderr) => {
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
  assert.equal(existsSync(join(f.root, '.mindmux/preferences.json')), false);
  assert.equal(existsSync(join(f.root, '.mindmux/cli/setup.lock')), false);
  assert.ok(existsSync(join(f.root, 'brain/index.md')));
});
