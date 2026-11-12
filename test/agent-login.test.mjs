import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { agentCloud } from './helpers/agent-cloud.mjs';
const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/mmx.mjs', import.meta.url));

test('separate Agent tool calls resume OAuth, select Cloud project and verify real MCP', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mmx-agent-oauth-')), root = join(dir, 'project'); mkdirSync(root);
  const fixture = await agentCloud();
  t.after(async () => { await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  const env = { ...process.env, MINDMUX_HOME: join(dir, 'home'), CODEX_HOME: join(dir, 'codex') };
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--project', root, ...args], { env, timeout: 40000 })).stdout);
  const base = ['setup', '--agent', 'claude-code', '--server', fixture.serverUrl, '--non-interactive'];
  let state = await call(...base);
  assert.equal(state.step, 'authorize');
  for (let i = 0; !state.authorization.authorizationUrl && i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 100)); state = await call(...base);
  }
  assert.equal(state.authorization.status, 'authorization_required');
  const url = state.authorization.authorizationUrl; assert.ok(url);
  const again = await call(...base);
  assert.equal(again.authorization.authorizationUrl, url); assert.equal(fixture.registrations(), 1);
  const status = await call('login', '--server', fixture.serverUrl, '--status', 'check', '--non-interactive');
  assert.equal(status.authorizationUrl, url);
  for (const args of [['logout'], ['clean', '--yes']]) {
    const refused = await exec(process.execPath, [bin, '--project', root, ...args, '--non-interactive'], { env }).catch(error => error);
    assert.equal(refused.code, 1);
    assert.match(JSON.parse(refused.stdout).error, /authorization is pending/);
  }
  // Simulate the user's browser approval; callback is served by a detached CLI worker.
  const approved = await fetch(url); assert.equal(approved.status, 200);
  for (let i = 0; i < 30; i++) {
    const status = await call('login', '--server', fixture.serverUrl, '--status', 'check', '--non-interactive');
    if (status.status === 'authorized') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  state = await call(...base); assert.equal(state.step, 'select_project');
  assert.equal(state.workspaceAutomaticallySelected, true);
  const ready = await call(...base, '--brain-id', state.choices[0].brainId);
  assert.equal(ready.status, 'ready'); assert.equal(ready.mcp.recall, true); assert.equal(ready.binding.brainId, 'test-brain');
  const doctor = await call('doctor', '--online', '--json'); assert.equal(doctor.healthy, true);
  assert.equal(fixture.calls.includes('create_project'), false);
  assert.equal(JSON.stringify(ready).includes('fixture-access-token'), false);
  const before = readFileSync(join(root, '.mindmux/preferences.json'), 'utf8');
  assert.equal((await call(...base)).status, 'ready');
  assert.equal(JSON.parse(before).cloudBrain.brainId, 'test-brain');
  const { readdirSync } = await import('node:fs');
  const auth = join(env.MINDMUX_HOME, 'auth');
  for (const file of readdirSync(auth).filter(f => f.endsWith('.json'))) assert.equal(statSync(join(auth, file)).mode & 0o777, 0o600);
});

test('authorization rejection is observable, setup does not restart it, explicit login retries', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mmx-agent-denied-')), root = join(dir, 'project'); mkdirSync(root);
  const fixture = await agentCloud();
  t.after(async () => { await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  const env = { ...process.env, MINDMUX_HOME: join(dir, 'home') };
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--project', root, ...args], { env, timeout: 20000 })).stdout);
  const setup = ['setup', '--agent', 'claude-code', '--server', fixture.serverUrl, '--non-interactive'];
  const status = () => call('login', '--server', fixture.serverUrl, '--status', 'check', '--non-interactive');
  let state = await call(...setup);
  for (let i = 0; !state.authorization.authorizationUrl && i < 30; i++) { await new Promise(r => setTimeout(r, 100)); state = await call(...setup); }
  const url = new URL(state.authorization.authorizationUrl); url.searchParams.set('deny', '1');
  assert.equal((await fetch(url)).status, 400);
  for (let i = 0; i < 30 && (await status()).status !== 'failed'; i++) await new Promise(r => setTimeout(r, 100));
  state = await call(...setup);
  assert.equal(state.authorization.status, 'failed'); assert.equal(state.authorization.authorizationUrl, undefined);
  assert.equal(fixture.registrations(), 1);
  let retry = await call('login', '--server', fixture.serverUrl, '--non-interactive');
  for (let i = 0; !retry.authorizationUrl && i < 30; i++) { await new Promise(r => setTimeout(r, 100)); retry = await status(); }
  assert.equal(fixture.registrations(), 2);
  assert.equal((await fetch(retry.authorizationUrl)).status, 200);
  for (let i = 0; i < 30 && (await status()).status !== 'authorized'; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal((await call(...setup)).step, 'select_project');
});


test('login retries and clean recover an abandoned launch lock', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'mmx-agent-stale-')), root = join(dir, 'project'); mkdirSync(root);
  const fixture = await agentCloud();
  t.after(async () => { await fixture.close(); rmSync(dir, { recursive: true, force: true }); });
  const env = { ...process.env, MINDMUX_HOME: join(dir, 'home') };
  const call = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--project', root, ...args, '--non-interactive'], { env, timeout: 20000 })).stdout);
  const auth = join(env.MINDMUX_HOME, 'auth'); mkdirSync(auth, { recursive: true });
  const path = join(auth, `login-${createHash('sha256').update(fixture.serverUrl).digest('hex')}.json`);
  writeFileSync(path, JSON.stringify({ id: 'abandoned', server: fixture.serverUrl, status: 'starting', startedAt: 1, expiresAt: 2 }));
  const lock = `${path}.launch.lock`;
  const abandonedLock = () => {
    mkdirSync(lock);
    const old = new Date(Date.now() - 10000); utimesSync(lock, old, old);
  };
  abandonedLock();
  let state = await call('login', '--server', fixture.serverUrl);
  for (let i = 0; !state.authorizationUrl && i < 30; i++) {
    await new Promise(r => setTimeout(r, 100));
    state = await call('login', '--server', fixture.serverUrl, '--status', 'check');
  }
  assert.equal(state.status, 'authorization_required');
  assert.equal(fixture.registrations(), 1);
  assert.equal((await fetch(state.authorizationUrl)).status, 200);
  for (let i = 0; i < 30; i++) {
    state = await call('login', '--server', fixture.serverUrl, '--status', 'check');
    if (state.status === 'authorized') break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(state.status, 'authorized');
  abandonedLock();
  assert.equal((await call('clean', '--yes')).cleaned, true);
  assert.equal(existsSync(auth), false);
});
