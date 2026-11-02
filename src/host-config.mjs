import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { readJson, homeDir, preferences, DEFAULT_SERVER } from './storage.mjs';
import { CLI_BIN } from './integrations.mjs';

const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const same = (a, b) => isDeepStrictEqual(plain(a), plain(b));
const BEGIN = '# BEGIN mindmux-cli MCP', END = '# END mindmux-cli MCP';
export const mcpPath = (root, agent) => join(root, agent === 'codex' ? '.codex/config.toml' : '.mcp.json');
const entryName = agent => agent === 'codex' ? 'mindmux_cli' : 'mindmux';
export function guardPath(root, path) {
  for (let current = path; current !== root; current = dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing project configuration symlink: ${current}`);
    if (dirname(current) === current) throw new Error('Configuration path escaped project.');
  }
}
export function launcher(root) {
  return { command: process.execPath, args: [CLI_BIN, '--project', root, 'mcp', 'serve'], env: { MINDMUX_HOME: homeDir() } };
}
function block(text, content) {
  const starts = text.split(BEGIN).length - 1, ends = text.split(END).length - 1;
  if (starts !== ends || starts > 1 || (starts && text.indexOf(END) < text.indexOf(BEGIN))) throw new Error('Malformed MindMux MCP markers. Repair configuration before continuing.');
  const value = content ? `${BEGIN}\n${content.trim()}\n${END}\n` : '';
  if (starts) return text.slice(0, text.indexOf(BEGIN)) + value + text.slice(text.indexOf(END) + END.length).replace(/^\r?\n/, '');
  return text + (text && !text.endsWith('\n') ? '\n' : '') + value;
}
export function hostState(root, agent) {
  const path = mcpPath(root, agent); guardPath(root, path);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const data = agent === 'codex' ? parse(text) : readJson(path, {});
  const key = agent === 'codex' ? 'mcp_servers' : 'mcpServers';
  if (data[key] !== undefined && (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key]))) throw new Error(`Invalid ${key} in ${path}`);
  if (agent === 'codex') block(text, '');
  return { path, text, data, key, name: entryName(agent), entry: data[key]?.[entryName(agent)] };
}
function inheritedCodex(root) {
  const path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  const servers = existsSync(path) ? parse(readFileSync(path, 'utf8')).mcp_servers || {} : {};
  const known = preferences(root).mindmuxCli?.server || DEFAULT_SERVER;
  const found = Object.entries(servers).filter(([name, entry]) => name !== 'mindmux_cli' && typeof entry.url === 'string' && (entry.url === known || entry.url.startsWith('https://mcp.mindmux.ai/'))).map(([name]) => name);
  if (servers.mindmux_cli) throw new Error('Global Codex entry mindmux_cli already exists. Rename it before project setup to avoid merged transports.');
  return found;
}
export function planHost(root, agent, previous, { migrate = false, remove = false, repair = false } = {}) {
  const state = hostState(root, agent), desired = launcher(root);
  const { data, key, entry, name, path } = state;
  if (previous && !same(entry, previous.installed) && !(repair && entry === undefined)) throw new Error(`MindMux MCP entry changed outside the installer: ${path}. Preserve or repair it before continuing.`);
  if (!previous && entry && !same(entry, desired)) {
    if (!migrate || typeof entry.url !== 'string') throw new Error(`Existing ${name} MCP entry in ${path}. Use --migrate to explicitly replace a remote entry; it will be backed up.`);
  }
  if (remove && !previous) return null;
  const suppress = { ...previous?.suppressed };
  if (agent === 'codex') {
    for (const [legacy, original] of Object.entries(suppress)) {
      if (!same(data[key]?.[legacy], { enabled: false }) && !(repair && data[key]?.[legacy] === undefined)) throw new Error(`Project override for ${legacy} changed outside the installer: ${path}`);
    }
    if (!remove) {
      const candidates = new Set([...inheritedCodex(root), ...Object.entries(data[key] || {}).filter(([id, value]) => id !== name && typeof value.url === 'string' && (id === 'mindmux' || value.url.startsWith('https://mcp.mindmux.ai/'))).map(([id]) => id)]);
      for (const legacy of candidates) {
        if (legacy in suppress) continue;
        if (data[key]?.[legacy] && !migrate) throw new Error(`Existing project ${legacy} MCP entry in ${path}. Use --migrate to disable and back it up for this project.`);
        suppress[legacy] = data[key]?.[legacy] || null;
      }
    }
  }
  const restored = remove ? previous.original : desired;
  const managed = {};
  if (restored) managed[name] = restored;
  for (const [legacy, original] of Object.entries(suppress)) {
    if (!remove) managed[legacy] = { enabled: false };
    else if (original) managed[legacy] = original;
  }
  let content;
  if (agent !== 'codex') {
    data[key] = { ...data[key] };
    if (restored) data[key][name] = restored; else delete data[key][name];
    if (!Object.keys(data[key]).length) delete data[key];
    content = JSON.stringify(data, null, 2) + '\n';
  } else {
    let base = block(state.text, '');
    const baseData = parse(base);
    const keysToReplace = [name, ...Object.keys(suppress)];
    if (keysToReplace.some(id => baseData[key]?.[id])) {
      // Only explicit migration rewrites existing tables. All values survive; comments remain in backup.
      for (const id of keysToReplace) delete baseData[key][id];
      if (baseData[key] && !Object.keys(baseData[key]).length) delete baseData[key];
      base = stringify(baseData);
    }
    content = block(base, Object.keys(managed).length ? stringify({ mcp_servers: managed }) : '');
  }
  if (agent === 'codex') parse(content); else JSON.parse(content);
  return { path, content, record: { installed: desired, original: previous ? previous.original : entry || null, suppressed: suppress } };
}
export function inspectMcp(root) {
  const manifest = readJson(join(root, '.mindmux/cli/setup.json'), {});
  return Object.entries(manifest.agents || {}).map(([agent, saved]) => {
    try {
      const state = hostState(root, agent);
      const configured = same(state.entry, saved.installed) && Object.keys(saved.suppressed || {}).every(id => same(state.data[state.key]?.[id], { enabled: false }));
      return { agent, name: state.name, path: state.path, configured,
        executablePresent: existsSync(saved.installed.command) && existsSync(saved.installed.args[0]),
        projectDisabledRemoteServers: Object.keys(saved.suppressed || {}) };
    } catch (error) { return { agent, configured: false, error: error.message }; }
  });
}
