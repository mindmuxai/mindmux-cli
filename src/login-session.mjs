import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { acquireLoginLaunchLock } from './login-lock.mjs';
import { homeDir, readJson, writeJson, serverUrl } from './storage.mjs';

export const loginSessionPath = server => join(homeDir(), 'auth', `login-${createHash('sha256').update(serverUrl(server)).digest('hex')}.json`);
export function loginSession(server) {
  const session = readJson(loginSessionPath(server), {});
  if (['starting', 'authorization_required'].includes(session.status)) {
    let alive = false;
    try { if (session.pid) { process.kill(session.pid, 0); alive = true; } } catch {}
    if (Date.now() > session.expiresAt || (!alive && Date.now() - session.startedAt > 5000)) {
      return { ...session, status: 'failed', authorizationUrl: undefined, error: 'Authorization expired or its worker stopped. Run login again.' };
    }
  }
  return session;
}

export function pendingLogin() {
  const dir = join(homeDir(), 'auth');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).filter(name => /^login-[a-f0-9]{64}\.json$/.test(name)).some(name => {
    const saved = readJson(join(dir, name), {});
    return saved.server && ['starting', 'authorization_required'].includes(loginSession(saved.server).status);
  });
}

// The detached worker owns the OAuth callback and auth lock, not the short-lived agent tool call.
export async function startLoginSession(server, { open = false, retry = false } = {}) {
  server = serverUrl(server);
  const path = loginSessionPath(server), lock = `${path}.launch.lock`;
  mkdirSync(join(homeDir(), 'auth'), { recursive: true, mode: 0o700 });
  const unlock = acquireLoginLaunchLock(lock);
  if (!unlock) return loginSession(server);
  try {
    const previous = loginSession(server);
    if (['starting', 'authorization_required'].includes(previous.status) || (previous.status === 'failed' && !retry)) return previous;
    const session = { id: randomUUID(), server, status: 'starting', startedAt: Date.now(), expiresAt: Date.now() + 180000 };
    writeJson(path, session);
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./login-worker.mjs', import.meta.url)), server, session.id, open ? 'open' : 'no-open'],
      { detached: true, stdio: 'ignore', env: process.env });
    await new Promise((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
    worker.unref();
  } finally { unlock(); }
  // Usually return the URL on the first call, but never wait for user authorization.
  for (let i = 0; i < 10; i++) {
    const state = loginSession(server);
    if (state.status !== 'starting') return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return loginSession(server);
}

export function publicLoginState(session) {
  return { status: session.status || 'not_started', server: session.server,
    ...(session.authorizationUrl ? { authorizationUrl: session.authorizationUrl } : {}),
    ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
    ...(session.error ? { error: session.error } : {}) };
}
