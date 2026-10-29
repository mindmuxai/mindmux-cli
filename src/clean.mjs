import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, rmSync, rmdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { homeDir, preferences, preferencesPath, readJson, writeJson } from './storage.mjs';
import { AGENTS, connect, integrationFiles, managedBlock } from './integrations.mjs';
import { guardPath, planHost } from './host-config.mjs';
import { removeSetup } from './setup.mjs';
import { brainPackage } from './brain.mjs';
import { createSetupPrompts } from './prompts.mjs';

const inside = (parent, path) => { const rel = relative(parent, path); return rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel)); };
function noSymlinks(path) {
  for (let current = path; ; current = dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink() && !(process.platform === 'darwin' && ['/var', '/tmp', '/etc'].includes(current) && realpathSync(current) === '/private' + current)) throw new Error(`Refusing cleanup through a symbolic link: ${current}`);
    if (dirname(current) === current) return;
  }
}
function prune(path) {
  if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory() && readdirSync(path).length === 0) rmdirSync(path);
}
function cleanPlan(root, flags) {
  const home = homeDir();
  if (home === homedir() || inside(home, root)) throw new Error('MINDMUX_HOME must be a dedicated CLI directory, not the project, home directory, or an ancestor of the project.');
  noSymlinks(home);
  const runtime = join(root, '.mindmux/cli'); guardPath(root, runtime);
  const prefs = preferences(root);
  const setup = readJson(join(runtime, 'setup.json'), {});
  const integrations = readJson(join(runtime, 'integrations.json'), {});
  const agents = [...new Set([...Object.keys(setup.agents || {}), ...Object.keys(integrations)])];
  for (const agent of agents) {
    if (!AGENTS.includes(agent)) throw new Error(`Unknown integration in cleanup manifest: ${agent}`);
    if (setup.agents?.[agent]) planHost(root, agent, setup.agents[agent], { remove: true });
    const files = integrationFiles(root, agent);
    for (const file of Object.values(files)) guardPath(root, file);
    managedBlock(existsSync(files.rules) ? readFileSync(files.rules, 'utf8') : '', '');
    if (files.hooks) {
      const settings = readJson(files.hooks, {});
      if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks) || Object.values(settings.hooks).some(value => !Array.isArray(value)))) throw new Error(`Invalid hooks: ${files.hooks}`);
    }
  }
  const data = [...new Set([join(root, 'brain'), ...(prefs.brainRoot ? [resolve(root, prefs.brainRoot)] : [])])].filter(existsSync);
  for (const path of data) {
    noSymlinks(path);
    if (inside(path, root) || inside(path, home) || inside(home, path) || existsSync(join(path, '.git'))) throw new Error(`Unsafe local Brain directory: ${path}`);
    if (!inside(root, path) && !flags['include-external-data']) throw new Error(`Local Brain is outside this project: ${path}. Use --include-external-data to include this explicitly configured directory.`);
    if (!existsSync(join(path, 'index.md')) || !readFileSync(join(path, 'index.md'), 'utf8').startsWith('# Brain Index')) throw new Error(`Refusing to delete an unrecognized Brain directory: ${path}`);
  }
  const backup = join(home, 'backups', createHash('sha256').update(root).digest('hex'));
  const paths = [preferencesPath(root), runtime, backup, ...data];
  if (!flags['keep-login']) paths.push(join(home, 'auth'), join(home, 'config.json'));
  for (const path of paths) noSymlinks(path);
  return { root, home, runtime, prefs, setup, agents, data, backup };
}

export async function clean(root, flags = {}, dependencies = {}) {
  const plan = cleanPlan(root, flags);
  const interactive = Boolean(dependencies.prompts || (process.stdin.isTTY && process.stderr.isTTY));
  if (!flags.yes) {
    if (!interactive) throw new Error('clean deletes local data. Run interactively or pass --yes to confirm.');
    const prompts = dependencies.prompts || createSetupPrompts();
    const scope = [
      `Reset MindMux in ${root}?`,
      'Remove managed agent integrations, project binding, caches, and this project\'s configuration backups.',
      ...plan.data.map(path => `Delete local Brain data: ${path}`),
      flags['keep-login'] ? 'Keep CLI login.' : 'Sign out of the CLI for all servers (affects other projects using this CLI login).',
      'Cloud Projects and Brains will be kept.',
    ].join('\n');
    try { if (!await prompts.confirm(scope)) return { cleaned: false, cancelled: true }; }
    catch (error) { if (error.name === 'ExitPromptError') return { cleaned: false, cancelled: true }; throw error; }
  }
  // Revalidate after the confirmation, before acquiring the same lock as setup/remove.
  const current = cleanPlan(root, flags);
  if (JSON.stringify(current) !== JSON.stringify(plan)) throw new Error('Configuration changed during confirmation. Run clean again.');
  if (existsSync(join(plan.runtime, 'write.lock'))) throw new Error('A local Brain write is active. Finish it before running clean.');
  if (!flags['keep-login'] && existsSync(join(plan.home, 'auth')) && readdirSync(join(plan.home, 'auth')).some(name => name.endsWith('.lock'))) throw new Error('CLI authentication is busy. Stop active agents or finish login before running clean.');
  mkdirSync(plan.runtime, { recursive: true, mode: 0o700 });
  const lock = join(plan.runtime, 'setup.lock');
  try { mkdirSync(lock); } catch { throw new Error(`Another setup/remove/clean is active: ${lock}`); }
  const unlock = () => rmSync(lock, { recursive: true, force: true });
  process.once('exit', unlock);
  try {
    await removeSetup(root, {}, { lockHeld: true });
    for (const agent of plan.agents) {
      if (!plan.setup.agents?.[agent]) connect(root, agent, { remove: true });
      const files = integrationFiles(root, agent);
      if (existsSync(files.rules) && !readFileSync(files.rules, 'utf8').trim()) rmSync(files.rules);
      if (files.hooks && existsSync(files.hooks)) {
        const settings = readJson(files.hooks, {});
        if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
        if (!Object.keys(settings).length || (agent === 'cursor' && Object.keys(settings).length === 1 && settings.version === 1)) rmSync(files.hooks);
      }
    }
    for (const [agent, record] of Object.entries(plan.setup.agents || {})) {
      const file = join(root, agent === 'codex' ? '.codex/config.toml' : '.mcp.json');
      if (!record.original && existsSync(file) && (agent === 'codex' ? !readFileSync(file, 'utf8').trim() : !Object.keys(readJson(file, {})).length)) rmSync(file);
    }
    const remaining = { ...plan.prefs };
    for (const key of ['cloudBrain', 'mindmuxCli', 'brainRoot']) delete remaining[key];
    if (Object.keys(remaining).some(key => key !== 'version')) writeJson(preferencesPath(root), remaining);
    else rmSync(preferencesPath(root), { force: true });
    const scaffold = join(root, 'BRAIN.md');
    const original = join(brainPackage, 'skills/brain-setup/assets/BRAIN.md');
    if (plan.data.length && existsSync(scaffold) && readFileSync(scaffold, 'utf8') === readFileSync(original, 'utf8')) rmSync(scaffold);
    for (const path of plan.data) rmSync(path, { recursive: true, force: true });
    rmSync(plan.backup, { recursive: true, force: true });
    if (!flags['keep-login']) {
      rmSync(join(plan.home, 'auth'), { recursive: true, force: true });
      rmSync(join(plan.home, 'config.json'), { force: true });
    }
    // Keep our lock until every other project cleanup operation has completed.
    for (const name of readdirSync(plan.runtime)) if (name !== 'setup.lock') rmSync(join(plan.runtime, name), { recursive: true, force: true });
    return { cleaned: true, signedOut: !flags['keep-login'], localDataRemoved: plan.data, cloudDataDeleted: false, next: 'Run mmx setup to start again.' };
  } finally {
    process.removeListener('exit', unlock); unlock();
    prune(plan.runtime); prune(join(root, '.mindmux'));
    for (const dir of ['.codex', '.claude', '.cursor/rules', '.cursor']) prune(join(root, dir));
  }
}
