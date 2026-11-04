import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const DEFAULT_SERVER = 'https://mcp.mindmux.ai/mcp';
export const homeDir = () => resolve(process.env.MINDMUX_HOME || join(homedir(), '.mindmux-cli'));
export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Invalid JSON: ${path}. Repair it before continuing.`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Expected an object: ${path}`);
  return data;
}
export function writeJson(path, value) { writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`); }
export function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
export function projectRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.mindmux/preferences.json')) || existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}
export const preferencesPath = root => join(root, '.mindmux/preferences.json');
export const preferences = root => readJson(preferencesPath(root), {});
export function mergePreferences(root, patch) {
  writeJson(preferencesPath(root), { ...preferences(root), version: 1, ...patch });
}
export function serverUrl(value = DEFAULT_SERVER) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('Server must use HTTPS (HTTP is allowed only on loopback).');
  }
  if (url.username || url.password || url.hash || url.search) throw new Error('Server URL must not contain credentials, query or fragment.');
  return url.href.replace(/\/$/, '');
}
export function binding(root) {
  const prefs = preferences(root);
  if (prefs.cloudBrain?.enabled === true) {
    if (!prefs.cloudBrain.brainId) throw new Error('Cloud Brain is enabled without brainId. Run mmx brain bind --brain-id <id>.');
    return { kind: 'cloud', brainId: prefs.cloudBrain.brainId, name: prefs.cloudBrain.name,
      server: serverUrl(prefs.mindmuxCli?.server || DEFAULT_SERVER) };
  }
  if (prefs.cloudBrain?.enabled === false || prefs.brainRoot || existsSync(join(root, 'brain/index.md'))) {
    return { kind: 'local', directory: resolve(root, prefs.brainRoot || 'brain') };
  }
  return { kind: 'unbound' };
}
export function requireBinding(root) {
  const value = binding(root);
  if (value.kind === 'unbound') throw new Error('No Brain selected. Run mmx init --local or mmx brain bind --brain-id <id>.');
  return value;
}
export function ignoreRuntime(root, extraEntries = []) {
  const path = join(root, '.gitignore');
  let text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  for (const entry of ['/.mindmux/preferences.json', '/.mindmux/cli/', ...extraEntries]) {
    if (!text.split(/\r?\n/).includes(entry)) text += `${text && !text.endsWith('\n') ? '\n' : ''}${entry}\n`;
  }
  writeAtomic(path, text);
}
