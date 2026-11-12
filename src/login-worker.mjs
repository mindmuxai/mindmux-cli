import { login } from './cloud.mjs';
import { loginSessionPath } from './login-session.mjs';
import { readJson, writeJson } from './storage.mjs';

const [server, id, mode] = process.argv.slice(2);
const path = loginSessionPath(server);
const update = patch => {
  const state = readJson(path, {});
  if (state.id !== id) throw new Error('Login session was replaced.');
  writeJson(path, { ...state, pid: process.pid, ...patch });
};
try {
  update({ status: 'starting' });
  await login(server, { open: mode === 'open', output: () => {},
    onAuthorization: url => update({ status: 'authorization_required', authorizationUrl: url.href }) });
  update({ status: 'authorized', authorizationUrl: undefined });
} catch (error) {
  try { update({ status: 'failed', authorizationUrl: undefined, error: error.message }); } catch {}
  process.exitCode = 1;
}
