// Opt-in packaged-install protocol smoke test. No production auth or Cloud writes.
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { agentCloud } from '../test/helpers/agent-cloud.mjs';
const exec = promisify(execFile);
const source = fileURLToPath(new URL('..', import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mmx-agent-install-')));
const root = join(dir, 'project'); mkdirSync(root);
const env = { ...process.env, MINDMUX_HOME: join(dir, 'home'), CODEX_HOME: join(dir, 'codex'),
  npm_config_cache: join(dir, 'cache'), npm_config_prefix: join(dir, 'global'), MINDMUX_NO_UPDATE_CHECK: '1' };
const run = async (bin, args, cwd = root) => {
  try { return (await exec(bin, args, { env, cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch (error) { throw new Error(`${bin} ${args.join(' ')}\n${error.stdout || ''}\n${error.stderr || error.message}`); }
};
const packed = JSON.parse(await run('npm', ['pack', '--json', '--pack-destination', dir], source));
await run('npm', ['install', '-g', join(dir, packed[0].filename), '--registry=https://registry.npmjs.org']);
const bin = join(dir, 'global/bin/mmx');
const fixture = await agentCloud();
let authorization;
const states = [];
const call = async args => {
  const value = JSON.parse(await run(bin, args));
  states.push({ command: args[0], status: value.status, step: value.step });
  return value;
};
try {
  const base = ['setup', '--agent', 'claude-code,codex', '--non-interactive', '--server', fixture.serverUrl];
  let result = await call(base);
  for (let i = 0; !result.authorization?.authorizationUrl && i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 100)); result = await call(base);
  }
  assert.equal(result.step, 'authorize'); authorization = result.authorization.authorizationUrl;
  assert.ok(authorization); assert.equal(fixture.registrations(), 1);
  // Only the user/browser approval is simulated; OAuth exchange and callback use real HTTP.
  assert.equal((await fetch(authorization)).status, 200);
  for (let i = 0; i < 30; i++) {
    const auth = await call(['login', '--non-interactive', '--server', fixture.serverUrl, '--status', 'check']);
    if (auth.status === 'authorized') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  result = await call(base); assert.equal(result.step, 'select_project');
  assert.equal(result.workspaceAutomaticallySelected, true);
  const ready = await call([...base, '--brain-id', result.choices[0].brainId]);
  assert.equal(ready.status, 'ready'); assert.equal(ready.mcp.connected, true); assert.equal(ready.mcp.recall, true);
  const prefs = readFileSync(join(root, '.mindmux/preferences.json'), 'utf8');
  assert.equal((await call(base)).status, 'ready'); // Resumes existing binding, no creation replay.
  assert.equal(JSON.parse(prefs).cloudBrain.brainId, 'test-brain');
  const doctor = await call(['doctor', '--online', '--json']); assert.equal(doctor.healthy, true);
  const clean = await call(['clean', '--yes', '--json']);
  assert.equal(clean.cleaned, true); assert.equal(clean.cloudDataDeleted, false);
  for (const path of ['.mcp.json', '.codex/config.toml', '.codex/hooks.json', '.claude/settings.json', 'AGENTS.md', 'CLAUDE.md', '.mindmux/cli']) {
    assert.equal(existsSync(join(root, path)), false, path);
  }
  assert.equal(existsSync(join(env.MINDMUX_HOME, 'auth')), false);
  // A fresh Agent flow after cleanup must request authorization again, with no stale binding.
  let fresh = await call(base);
  for (let i = 0; !fresh.authorization?.authorizationUrl && i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 100)); fresh = await call(base);
  }
  assert.equal(fresh.step, 'authorize');
  assert.notEqual(fresh.authorization.authorizationUrl, authorization);
  assert.equal((await fetch(fresh.authorization.authorizationUrl)).status, 200);
  for (let i = 0; i < 30; i++) {
    const auth = await call(['login', '--non-interactive', '--server', fixture.serverUrl, '--status', 'check']);
    if (auth.status === 'authorized') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fresh = await call(base); assert.equal(fresh.step, 'select_project');
  assert.equal(fresh.workspaceAutomaticallySelected, true);
  assert.equal((await call([...base, '--brain-id', fresh.choices[0].brainId])).status, 'ready');
  assert.equal((await call(['doctor', '--online', '--json'])).healthy, true);
  assert.equal(fixture.calls.includes('create_project'), false);
  const report = { directory: dir, version: (await run(bin, ['--version'])).trim(), passed: true,
    simulated: ['user browser approval', 'Workspace and Project choices', 'local OAuth/MCP service'],
    verified: ['packaged npm global installation', 'background OAuth across independent tool calls', 'single Workspace automatic selection and explicit Project choice', 'both host integrations', 'real stdio MCP recall', 'idempotent retry', 'online doctor', 'complete clean and fresh Agent setup with new OAuth'], states };
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await fixture.close(); }
