import { existsSync, readFileSync, mkdirSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { binding, preferences, mergePreferences, readJson, writeJson, writeAtomic, homeDir, DEFAULT_SERVER, serverUrl, ignoreRuntime } from './storage.mjs';
import { login, credentialPath, withCloud } from './cloud.mjs';
import { connect, integrationFiles, managedBlock } from './integrations.mjs';
import { localCommand } from './brain.mjs';
import { planHost, hostState, guardPath } from './host-config.mjs';
import { probeMcp } from './mcp-server.mjs';
import { createSetupPrompts } from './prompts.mjs';

const supported = ['claude-code', 'codex'];
const setupPath = root => join(root, '.mindmux/cli/setup.json');
function agentsFrom(value) {
  const agents = [...new Set((value || '').split(',').map(x => x.trim()).filter(Boolean))];
  if (agents.some(x => !supported.includes(x))) throw new Error('setup supports --agent claude-code,codex.');
  return agents;
}
export function legacyWarnings(root) {
  const warnings = [];
  for (const agent of supported) {
    const file = join(root, agent === 'codex' ? '.codex/hooks.json' : '.claude/settings.json');
    if (existsSync(file) && readFileSync(file, 'utf8').includes('brain-session-start')) warnings.push(`${agent}: project brain.md hook detected; use setup --migrate to remove the recognized old hook.`);
  }
  for (const folder of ['.claude/skills', '.codex/skills', '.agents/skills']) {
    if (existsSync(join(homedir(), folder, 'brain-page'))) warnings.push(`Global brain.md skill detected in ~/${folder}; uninstall with the original brain.md installer if replacing it. Global integrations are not removed by project setup.`);
  }
  return warnings;
}
function pathsFor(root, agents) {
  return [...new Set([join(root, '.mindmux/preferences.json'), join(root, '.gitignore'), setupPath(root), join(root, '.mindmux/cli/integrations.json'),
    ...agents.flatMap(agent => {
      const f = integrationFiles(root, agent);
      return [f.rules, f.hooks, hostState(root, agent).path, join(root, agent === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'), join(root, agent === 'codex' ? '.codex/hooks/brain-session-start' : '.claude/hooks/brain-session-start')].filter(Boolean);
    })])];
}
function snapshot(root, paths) {
  return paths.map(path => {
    guardPath(root, path);
    return { path, content: existsSync(path) ? readFileSync(path, 'utf8') : null, mode: existsSync(path) ? statSync(path).mode & 0o777 : null };
  });
}
function restore(files) {
  for (const file of [...files].reverse()) {
    if (file.content === null) rmSync(file.path, { force: true });
    else { writeAtomic(file.path, file.content); chmodSync(file.path, file.mode); }
  }
}
async function transaction(root, files, run) {
  const backup = join(homeDir(), 'backups', createHash('sha256').update(root).digest('hex'), `${Date.now()}-${randomUUID()}.json`);
  writeJson(backup, { createdAt: new Date().toISOString(), files });
  const interrupted = () => {
    try { restore(files); } catch (error) { console.error(`Interrupted setup rollback failed: ${error.message}. Backup: ${backup}`); }
  };
  process.once('exit', interrupted);
  try {
    const result = await run();
    process.removeListener('exit', interrupted);
    return { ...result, backup };
  }
  catch (error) {
    process.removeListener('exit', interrupted);
    try { restore(files); } catch (rollback) { throw new Error(`${error.message}; rollback failed: ${rollback.message}. Backup: ${backup}`); }
    throw new Error(`${error.message} Project configuration restored. Backup: ${backup}`);
  }
}
function preflight(root, agents, manifest, migrate, remove = false) {
  return agents.map(agent => {
    const files = integrationFiles(root, agent);
    guardPath(root, files.rules);
    managedBlock(existsSync(files.rules) ? readFileSync(files.rules, 'utf8') : '', 'preflight');
    if (files.hooks) {
      const settings = readJson(files.hooks, {});
      if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error(`Invalid hooks: ${files.hooks}`);
      for (const hooks of Object.values(settings.hooks || {})) if (!Array.isArray(hooks)) throw new Error(`Invalid hook array: ${files.hooks}`);
    }
    return { agent, plan: planHost(root, agent, manifest.agents?.[agent], { migrate, remove }) };
  });
}
export async function setup(root, flags = {}, dependencies = {}) {
  const interactive = !flags.yes && Boolean(dependencies.prompts || (process.stdin.isTTY && process.stderr.isTTY));
  const prompts = dependencies.prompts || createSetupPrompts();
  const cloud = dependencies.cloud || withCloud;
  const runtime = join(root, '.mindmux/cli'); guardPath(root, runtime);
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const lock = join(runtime, 'setup.lock');
  try { mkdirSync(lock); } catch { throw new Error(`Another setup/remove is active. If it crashed, remove ${lock}.`); }
  const cleanup = () => rmSync(lock, { recursive: true, force: true });
  const interrupt = () => process.exit(130), terminate = () => process.exit(143);
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  process.once('exit', cleanup);
  try {
    let agents = agentsFrom(flags.agent);
    if (!agents.length) {
      if (!interactive) throw new Error('Specify --agent claude-code,codex in a non-interactive terminal.');
      const installed = supported.filter(name => { try { execFileSync('/usr/bin/which', [name === 'claude-code' ? 'claude' : name], { stdio: 'ignore' }); return true; } catch { return false; } });
      agents = agentsFrom(await prompts.agents(installed));
    }
    if (flags.local && (flags['brain-id'] || flags.name || flags['workspace-id'] || flags.server)) throw new Error('--local cannot be combined with Cloud selection flags.');
    if (flags['brain-id'] && (flags.name || flags['workspace-id'])) throw new Error('Choose --brain-id or Workspace/project creation flags.');
    if (flags.name && !flags['workspace-id']) throw new Error('--workspace-id is required with --name.');
    const manifest = readJson(setupPath(root), {});
    let migrate = Boolean(flags.migrate);
    let plans;
    try { plans = preflight(root, agents, manifest, migrate); }
    catch (error) {
      if (!interactive || migrate || !error.message.includes('--migrate')) throw error;
      migrate = await prompts.confirm(`${error.message}\nReplace and back up the existing MCP configuration?`);
      if (!migrate) throw error;
      plans = preflight(root, agents, manifest, migrate);
    }
    const files = snapshot(root, pathsFor(root, agents));
    const warnings = legacyWarnings(root);
    if (warnings.length) console.error(warnings.join('\n'));
    const current = binding(root);
    const server = serverUrl(flags.server || (current.kind === 'cloud' ? current.server : readJson(join(homeDir(), 'config.json'), {}).server) || DEFAULT_SERVER);
    let selected, created = manifest.created;
    const pendingPath = join(runtime, 'setup-pending.json');
    const createOrReuse = async (workspaceId, name, description = '') => {
      const match = value => value?.server === server && value?.workspaceId === workspaceId && value?.name === name;
      const pending = readJson(pendingPath, {});
      if (match(pending)) {
        if (!pending.brainId) throw new Error('A prior project creation has an unknown outcome. Run mmx project list and select its --brain-id; do not blindly retry creation. Inspect ' + pendingPath);
        created = pending; return pending;
      }
      if (match(created)) return created;
      const intent = { server, workspaceId, name, state: 'requesting' };
      writeJson(pendingPath, intent);
      let result;
      try { result = await cloud(server, call => call('create_project', { workspaceId, name, description })); }
      catch (error) { throw new Error(`${error.message} Project creation outcome may be unknown. Inspect project list before retrying. Journal: ${pendingPath}`); }
      created = { ...intent, state: 'created', brainId: result.brainId };
      if (!created.brainId) throw new Error('Project creation returned no brainId. Inspect project list before retrying.');
      writeJson(pendingPath, created);
      return created;
    };
    if (!flags.local) {
      if (!readJson(credentialPath(server), {}).tokens) await (dependencies.login || login)(server, { open: !flags['no-open'] });
      // Authenticate/refresh through a harmless real request. Do not start browser auth after arbitrary network errors.
      try { await cloud(server, call => call.listTools()); }
      catch (error) {
        if (error instanceof UnauthorizedError || ['InvalidGrantError', 'InvalidTokenError'].includes(error.name) || error.message.startsWith('Cloud login required.')) {
          await (dependencies.login || login)(server, { open: !flags['no-open'] });
          await cloud(server, call => call.listTools());
        } else throw error;
      }
      if (flags['brain-id']) selected = { brainId: flags['brain-id'] };
      else if (flags.name) {
        if (!flags['workspace-id']) throw new Error('--workspace-id is required with --name.');
        if (!flags.confirm && !(interactive && await prompts.confirm(`Create Project ${flags.name}? All Workspace members can access it.`))) throw new Error('Project creation requires --confirm.');
        selected = await createOrReuse(flags['workspace-id'], flags.name, flags.description || '');
      } else if (current.kind === 'cloud' && current.server === server && !flags['workspace-id']) selected = current;
      else {
        if (!interactive) throw new Error('Select --brain-id, or --workspace-id plus --name --confirm; no Brain is inferred from directory names.');
        const workspaces = (await cloud(server, call => call('list_workspaces'))).workspaces;
        if (!workspaces.length) throw new Error('No accessible Workspaces. Check Workspace membership and subscription.');
        const workspace = flags['workspace-id'] ? workspaces.find(w => (w.id || w.workspaceId) === flags['workspace-id']) : await prompts.choose('Select a Workspace:', workspaces.map(w => ({ name: w.name, value: w })));
        if (!workspace) throw new Error('Workspace is unavailable.');
        const workspaceId = workspace.id || workspace.workspaceId;
        const projects = (await cloud(server, call => call('list_projects', { workspaceId }))).projects;
        while (!selected) {
          const choice = await prompts.choose('Select a Project or create a new one:', [
            { name: '+ Create a new Project', value: { kind: 'create' } },
            ...projects.map(project => ({ name: project.name, value: { kind: 'existing', project } })),
          ]);
          if (choice.kind === 'existing') selected = choice.project;
          else {
            const name = await prompts.projectName(projects);
            if (await prompts.confirm(`Create Project "${name}"? All Workspace members can access it.`)) {
              selected = await createOrReuse(workspaceId, name);
            }
          }
        }
      }
      if (!selected?.brainId) throw new Error('Selected Project has no Cloud Brain.');
      const resolved = await cloud(server, call => call('resolve_brain', { brainId: selected.brainId }));
      if (resolved.status !== 'resolved') throw new Error('Selected Cloud Brain is inaccessible. Project binding was not changed.');
      selected = { brainId: selected.brainId, name: resolved.brain?.name || selected.name || selected.brainId };
    }
    // Do not roll back over edits made during browser authorization or selection.
    for (const file of files) if ((existsSync(file.path) ? readFileSync(file.path, 'utf8') : null) !== file.content) throw new Error(`Configuration changed during setup: ${file.path}. Rerun setup.`);
    return await transaction(root, files, async () => {
      if (flags.local) {
        // Local Brain data survives a configuration rollback and is never deleted by remove.
        localCommand(root, ['init', '--no-wire']);
        mergePreferences(root, { cloudBrain: { ...preferences(root).cloudBrain, enabled: false } });
      } else mergePreferences(root, { cloudBrain: { enabled: true, ...selected }, mindmuxCli: { ...preferences(root).mindmuxCli, server } });
      for (const { agent, plan } of plans) {
        if (migrate) localCommand(root, ['uninstall-hooks', '--agent', agent]);
        connect(root, agent);
        writeAtomic(plan.path, plan.content);
      }
      const next = { ...manifest, agents: { ...manifest.agents }, created, updatedAt: new Date().toISOString() };
      for (const { agent, plan } of plans) next.agents[agent] = plan.record;
      writeJson(setupPath(root), next);
      ignoreRuntime(root);
      const ignored = join(root, '.gitignore'); let text = readFileSync(ignored, 'utf8');
      for (const entry of ['/.mcp.json', '/.codex/config.toml']) if (!text.split(/\r?\n/).includes(entry)) text += `${text.endsWith('\n') ? '' : '\n'}${entry}\n`;
      writeAtomic(ignored, text);
      const probe = await (dependencies.probe || probeMcp)(root);
      const pending = readJson(pendingPath, {});
      if (pending.brainId && pending.brainId === selected?.brainId) rmSync(pendingPath, { force: true });
      return { installed: true, project: root, binding: binding(root), agents, mcp: probe, warnings: legacyWarnings(root),
        next: 'Restart the selected Agent in this project and approve its MCP/project/hook trust prompts. Codex uses AGENTS.md instructions, not native hooks.' };
    });
  } catch (error) {
    if (error.name === 'ExitPromptError') throw new Error('Setup cancelled.');
    throw error;
  } finally {
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); cleanup();
  }
}

export async function removeSetup(root, flags = {}) {
  const manifest = readJson(setupPath(root), {});
  const agents = agentsFrom(flags.agent || Object.keys(manifest.agents || {}).join(','));
  if (!agents.length) return { removed: [], note: 'No setup-managed integrations. Existing connect-only integrations can be removed with disconnect.' };
  const runtime = join(root, '.mindmux/cli'); guardPath(root, runtime); mkdirSync(runtime, { recursive: true });
  const lock = join(runtime, 'setup.lock');
  try { mkdirSync(lock); } catch { throw new Error(`Another setup/remove is active: ${lock}`); }
  const cleanup = () => rmSync(lock, { recursive: true, force: true });
  const interrupt = () => process.exit(130), terminate = () => process.exit(143);
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate); process.once('exit', cleanup);
  try {
    const plans = preflight(root, agents, manifest, false, true);
    const files = snapshot(root, pathsFor(root, agents));
    return await transaction(root, files, async () => {
      for (const { agent, plan } of plans) {
        if (!plan) continue;
        connect(root, agent, { remove: true });
        writeAtomic(plan.path, plan.content);
        delete manifest.agents[agent];
      }
      writeJson(setupPath(root), manifest);
      return { removed: plans.filter(p => p.plan).map(p => p.agent), note: 'Brain data, binding, CLI login and unrelated configuration retained. Migrated remote MCP entries restored.' };
    });
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    process.removeListener('exit', cleanup); cleanup();
  }
}
