import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setup, suggestedProjectName } from '../src/setup.mjs';
import { binding, writeJson } from '../src/storage.mjs';
import { credentialPath } from '../src/cloud.mjs';
import { loginSession, loginSessionPath } from '../src/login-session.mjs';

const bin = fileURLToPath(new URL('../bin/mmx.mjs', import.meta.url));
const run = promisify(execFile);
function fixture(t, { workspaces = [{ id: 'workspace', name: 'Workspace' }, { id: 'second', name: 'Second Workspace' }], projects = [{ brainId: 'existing', name: 'Existing' }] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mmx-agent-setup-'));
  const root = join(dir, 'project'); mkdirSync(root);
  const home = join(dir, 'home');
  const previous = process.env.MINDMUX_HOME;
  process.env.MINDMUX_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.MINDMUX_HOME; else process.env.MINDMUX_HOME = previous; rmSync(dir, { recursive: true, force: true }); });
  const flags = { 'non-interactive': true, json: true, agent: 'claude-code' };
  const calls = [];
  const dependencies = { probe: async () => ({ connected: true, recall: true }),
    cloud: async (_server, callback) => {
      const call = async (name, args) => {
        calls.push(name);
        if (name === 'list_workspaces') return { workspaces };
        if (name === 'list_projects') return { projects };
        if (name === 'resolve_brain') return { status: 'resolved', brain: { name: 'Resolved' } };
        if (name === 'create_project') return { brainId: 'created' };
        throw new Error(name);
      };
      call.listTools = async () => ({ tools: [] });
      return callback(call);
    },
    prompts: new Proxy({}, { get() { throw new Error('Agent setup must never open a terminal prompt'); } }),
  };
  const authenticate = () => writeJson(credentialPath('https://mcp.mindmux.ai/mcp'), { tokens: { access_token: 'fixture-secret' } });
  return { root, home, dir, flags, calls, dependencies, authenticate };
}

test('agent setup returns choices, preserves an unbound project and never opens terminal prompts', async t => {
  const f = fixture(t);
  assert.equal((await setup(f.root, { ...f.flags, agent: undefined }, f.dependencies)).step, 'select_agent');
  const state = await setup(f.root, f.flags, { ...f.dependencies, startLogin: async () => ({ status: 'authorization_required', authorizationUrl: 'https://example.test/authorize' }) });
  assert.equal(state.step, 'authorize'); assert.equal(state.authorization.status, 'authorization_required');
  assert.equal(f.calls.length, 0);
  f.authenticate();
  const workspaces = await setup(f.root, f.flags, f.dependencies);
  assert.equal(workspaces.step, 'select_workspace'); assert.equal(workspaces.choices[0].id, 'workspace');
  const projects = await setup(f.root, { ...f.flags, 'workspace-id': 'workspace' }, f.dependencies);
  assert.equal(projects.step, 'select_project'); assert.equal(projects.choices[0].brainId, 'existing');
  assert.equal(binding(f.root).kind, 'unbound');
  assert.equal(existsSync(join(f.root, '.mcp.json')), false);
  assert.equal(existsSync(join(f.root, '.mindmux/cli/setup.lock')), false);
  const ready = await setup(f.root, { ...f.flags, 'brain-id': 'existing' }, f.dependencies);
  assert.equal(ready.status, 'ready'); assert.equal(ready.binding.brainId, 'existing');
  assert.equal(ready.restartRequired, true); assert.equal(ready.trustRequired, true);
  assert.equal(JSON.stringify(ready).includes('fixture-secret'), false);
});

test('agent creation requires separate consent; retries reuse created project and rollback failed setup', async t => {
  const f = fixture(t); f.authenticate();
  const flags = { ...f.flags, 'workspace-id': 'workspace', name: 'New Project' };
  const waiting = await setup(f.root, { ...flags, yes: true }, f.dependencies);
  assert.equal(waiting.step, 'confirm_project_creation');
  assert.equal(f.calls.includes('create_project'), false);
  const failed = await setup(f.root, { ...flags, confirm: true }, { ...f.dependencies, probe: async () => { throw new Error('probe failed'); } });
  assert.equal(failed.status, 'error'); assert.equal(failed.recovery.brainId, 'created');
  assert.equal(binding(f.root).kind, 'unbound');
  assert.equal((await setup(f.root, { ...flags, confirm: true }, f.dependencies)).status, 'ready');
  assert.equal(f.calls.filter(name => name === 'create_project').length, 1);
});

test('network failures are errors, not authorization requests; inaccessible Brain never binds', async t => {
  const f = fixture(t); f.authenticate(); let logins = 0;
  const error = await setup(f.root, f.flags, { ...f.dependencies, cloud: async () => { throw new Error('network down'); }, startLogin: async () => { logins++; } });
  assert.equal(error.status, 'error'); assert.match(error.error, /network down/); assert.equal(logins, 0);
  const result = await setup(f.root, { ...f.flags, 'brain-id': 'forbidden' }, { ...f.dependencies, cloud: async (_s, cb) => {
    const call = async () => ({ status: 'forbidden' }); call.listTools = async () => ({}); return cb(call);
  } });
  assert.equal(result.status, 'error'); assert.equal(binding(f.root).kind, 'unbound');
});

test('foreign MCP configuration requires migration consent and is preserved while waiting', async t => {
  const f = fixture(t); f.authenticate();
  const path = join(f.root, '.mcp.json'); const foreign = { mcpServers: { mindmux: { command: 'foreign' } } }; writeJson(path, foreign);
  const result = await setup(f.root, f.flags, f.dependencies);
  assert.equal(result.step, 'confirm_migration');
  assert.deepEqual(JSON.parse(readFileSync(path)), foreign);
});

test('non-interactive CLI installs local integrations and probes real stdio without stdin', async t => {
  const f = fixture(t);
  const options = { env: { ...process.env, MINDMUX_HOME: f.home, CODEX_HOME: join(f.dir, 'codex') }, timeout: 45000 };
  const args = [bin, '--project', f.root, 'setup', '--non-interactive', '--local', '--agent', 'claude-code,codex'];
  const result = JSON.parse((await run(process.execPath, args, options)).stdout);
  assert.equal(result.status, 'ready'); assert.equal(result.mcp.recall, true);
  assert.equal(JSON.parse((await run(process.execPath, args.map(arg => arg === '--non-interactive' ? '-agent' : arg), options)).stdout).status, 'ready');
  const invalid = await run(process.execPath, [bin, '--project', f.root, 'setup', '--non-interactive', '--agent', 'invalid'], options).catch(e => e);
  assert.equal(JSON.parse(invalid.stdout).status, 'error'); assert.equal(invalid.code, 1);
});

test('dead authorization worker and expired session are reported as failed', t => {
  const f = fixture(t); const server = 'https://mcp.mindmux.ai/mcp';
  writeJson(loginSessionPath(server), { server, status: 'authorization_required', startedAt: Date.now() - 10000, expiresAt: Date.now() + 10000, pid: 2147483647 });
  assert.equal(loginSession(server).status, 'failed');
});

test('one Workspace is selected automatically, but even one Project still needs a choice', async t => {
  const f = fixture(t, { workspaces: [{ id: 'only', name: 'Only Workspace' }] }); f.authenticate();
  const state = await setup(f.root, f.flags, f.dependencies);
  assert.equal(state.step, 'select_project'); assert.equal(state.workspaceId, 'only');
  assert.equal(state.workspaceAutomaticallySelected, true);
  assert.equal(state.choices[0].kind, 'existing'); assert.equal(state.choices.at(-1).kind, 'create');
  assert.ok(state.choices.at(-1).name.includes(state.suggestedName));
  assert.equal(state.interaction.preferred, 'host-native-choice'); assert.equal(state.interaction.fallback, 'conversation');
  assert.equal(binding(f.root).kind, 'unbound'); assert.equal(f.calls.includes('create_project'), false);
});

test('empty Workspace asks for a name directly and does not create the suggested Project automatically', async t => {
  const f = fixture(t, { workspaces: [{ id: 'only', name: 'Only Workspace' }], projects: [] }); f.authenticate();
  const state = await setup(f.root, f.flags, f.dependencies);
  assert.equal(state.step, 'name_project'); assert.equal(state.suggestedName, 'project');
  assert.equal(state.workspaceId, 'only'); assert.equal(state.choices[0].kind, 'create');
  const confirm = await setup(f.root, { ...f.flags, 'workspace-id': state.workspaceId, name: state.suggestedName }, f.dependencies);
  assert.equal(confirm.step, 'confirm_project_creation');
  assert.equal(f.calls.includes('create_project'), false); assert.equal(binding(f.root).kind, 'unbound');
});

test('suggested names avoid case-insensitive collisions and preserve the 200-character limit', () => {
  assert.equal(suggestedProjectName('/tmp/My Project', [{ name: 'my project' }, { name: 'MY PROJECT (2)' }]), 'My Project (3)');
  assert.equal(suggestedProjectName('/'), 'My Project');
  const name = 'a'.repeat(200);
  const suggestion = suggestedProjectName('/tmp/' + name, [{ name }]);
  assert.equal(suggestion.length, 200); assert.ok(suggestion.endsWith(' (2)'));
});

test('explicit unavailable Workspace errors instead of silently using the sole accessible Workspace', async t => {
  const f = fixture(t, { workspaces: [{ id: 'only', name: 'Only Workspace' }] }); f.authenticate();
  const state = await setup(f.root, { ...f.flags, 'workspace-id': 'unavailable' }, f.dependencies);
  assert.equal(state.status, 'error'); assert.match(state.error, /unavailable/);
  assert.equal(binding(f.root).kind, 'unbound');
});


test('-agent selects machine mode without changing --agent or normal setup', async t => {
  const f = fixture(t);
  const options = { env: { ...process.env, MINDMUX_HOME: f.home }, timeout: 10000 };
  const base = [bin, '--project', f.root, 'setup'];
  const short = JSON.parse((await run(process.execPath, [...base, '-agent'], options)).stdout);
  const long = JSON.parse((await run(process.execPath, [...base, '--non-interactive', '--json'], options)).stdout);
  assert.deepEqual(short, long);
  assert.equal(short.step, 'select_agent');
  assert.equal(short.installed, false);
  for (const suffix of [['-agent', '--agent', 'invalid'], ['-agent', '--unknown-option']]) {
    const failed = await run(process.execPath, [...base, ...suffix], options).catch(error => error);
    assert.equal(failed.code, 1);
    assert.equal(JSON.parse(failed.stdout).status, 'error');
  }
  const normal = await run(process.execPath, base, options).catch(error => error);
  assert.equal(normal.code, 1);
  assert.match(normal.stderr, /Specify --agent/);
  assert.equal(normal.stdout, '');
});
