import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireLoginLaunchLock, removeStaleLoginLaunchLock } from '../src/login-lock.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mmx-launch-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'login.json.launch.lock');
}

test('a killed launcher leaves a lock that a new launcher can recover', async t => {
  const lock = fixture(t);
  const moduleUrl = new URL('../src/login-lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireLoginLaunchLock } from ${JSON.stringify(moduleUrl)};
    acquireLoginLaunchLock(${JSON.stringify(lock)});
    process.send('locked');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child, 'message');
  assert.equal(acquireLoginLaunchLock(lock), undefined, 'a live launcher must retain its lock');
  child.kill('SIGKILL'); await once(child, 'exit');
  const release = acquireLoginLaunchLock(lock);
  assert.equal(typeof release, 'function');
  release(); assert.equal(existsSync(lock), false);
});

test('legacy empty locks recover after a grace period, fresh empty locks remain protected', t => {
  const lock = fixture(t); mkdirSync(lock);
  assert.equal(removeStaleLoginLaunchLock(lock), false);
  const old = new Date(Date.now() - 10000); utimesSync(lock, old, old);
  assert.equal(removeStaleLoginLaunchLock(lock), true);
  const release = acquireLoginLaunchLock(lock); assert.ok(release); release();
});

test('a stale releaser cannot remove a replacement owner', t => {
  const lock = fixture(t);
  const release = acquireLoginLaunchLock(lock); release();
  const replacement = acquireLoginLaunchLock(lock);
  release();
  assert.equal(acquireLoginLaunchLock(lock), undefined);
  replacement();
});
