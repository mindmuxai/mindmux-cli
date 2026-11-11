import { VERSION } from './version.mjs';
import { parseArgs } from 'node:util';
import { resolve, join, basename } from 'node:path';
import { existsSync, rmSync, realpathSync } from 'node:fs';
import { binding, projectRoot, preferences, mergePreferences, ignoreRuntime, readJson, writeJson, homeDir, serverUrl, DEFAULT_SERVER } from './storage.mjs';
import { localCommand, withBrain } from './brain.mjs';
import { withCloud, login, credentialPath } from './cloud.mjs';
import { connect } from './integrations.mjs';
import { runHook } from './hooks.mjs';
import { recall } from './recall.mjs';
import { reviewedWrite, finishReview } from './review.mjs';

const HELP = `mmx — project Brain operations and agent integrations (v${VERSION})

Setup:
  mmx setup [--agent claude-code,codex]      login, choose Brain, install MCP + rules/hooks
  mmx setup --local --agent codex --yes     local Brain without Cloud login
  mmx setup --json                         return detailed setup results as JSON
  mmx update [--check] [--yes] [--json]     check for releases or upgrade this global installation
  mmx status [--online] [--json]            show configuration and observed activity
  mmx switch [--brain-id ID | --local]      choose another Brain; keep login and data
  mmx clean [--keep-login] [--yes]           reset local setup and data; keep Cloud data
  mmx remove [--agent NAME]                 remove setup entries; keep data and login
  mmx init --local                          initialize/reuse a local Brain
  mmx login [--server URL] [--no-open]       OAuth PKCE browser login
  mmx logout [--server URL]                 remove this CLI's saved credentials
  mmx brain bind --brain-id ID [--server URL]
  mmx brain bind --local                    explicitly choose the local Brain
  mmx project create --workspace-id ID --name NAME --confirm
  mmx connect --agent cursor|claude-code|codex
  mmx disconnect --agent NAME               remove only owned integration entries
  mmx doctor [--online] [--json]            diagnose configuration and connectivity
  mmx doctor --fix [--yes]                  review and apply managed configuration repair

Brain (JSON output, automatically uses the selected local/cloud Brain):
  mmx brain status | list | roots
  mmx brain read ID | read-root SLUG
  mmx brain index | reindex
  mmx brain search QUERY | recall QUERY
  cat decision.md | mmx brain create --id ID --title TITLE --category decision [--status draft] [--source TEXT]
  cat decision.md | mmx brain update ID --expected-version VERSION [--change-kind substantive] --summary WHY [--source TEXT]
  cat corrected.md | mmx brain update ID --expected-version VERSION --change-kind correction
    Cloud corrections replace content without a Timeline entry. Local updates require a summary.
  mmx brain append ID --kind evidence --summary TEXT [--source TEXT]
  mmx brain archive ID
  mmx brain review --review-token TOKEN --outcome saved|no-changes|already-covered|deferred --reason TEXT [--id ID]
    Codex hooks supply the token. Pass it to Brain mutations with --review-token TOKEN.
  cat root.md | mmx brain update-root SLUG --expected-version VERSION
    New local/cloud root: --expected-version new. Existing roots require their current version.

Cloud discovery and low-level access:
  mmx mcp serve                             stdio MCP sharing CLI authentication
  mmx workspace list | project list | brain discover
  mmx mcp tools
  mmx mcp call TOOL --args '{"key":"value"}'
    Low-level calls use your credentials and explicit arguments; they do not choose a Brain.

Run mmx without arguments in a terminal for the interactive menu.
All commands accept --project PATH. No automatic cloud-to-local fallback.
Cursor: startup context + prompt retrieval delivered at first tool call; one stop review.
Claude Code: startup + prompt context; one stop review. Codex: pre-answer review; Stop recovers a missing review once.
`;

async function stdin(limit = 1024 * 1024) {
  if (process.stdin.isTTY) throw new Error('Pipe content through stdin.');
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value) > limit) throw new Error('stdin exceeds 1 MiB.');
  }
  return value;
}
const output = value => console.log(JSON.stringify(value, null, 2));
const need = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`); return value; };
const body = async () => need((await stdin()).trim(), 'Nonempty stdin');
function cloudVersion(value) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--expected-version must be a positive integer for Cloud updates.');
  return Number(value);
}

export async function main(argv = process.argv.slice(2)) {
  const options = Object.fromEntries(['project', 'agent', 'brain-id', 'server', 'workspace-id', 'name', 'description', 'id', 'title', 'category', 'status', 'source', 'expected-version', 'change-kind', 'summary', 'kind', 'args', 'review-token', 'outcome', 'reason', 'manager'].map(key => [key, { type: 'string' }]));
  for (const key of ['local', 'online', 'no-open', 'confirm', 'help', 'version', 'yes', 'migrate', 'json', 'keep-login', 'include-external-data', 'fix', 'check', 'refresh-integrations']) options[key] = { type: 'boolean' };
  const { values: flags, positionals: pos } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  if (flags.version) { console.log(VERSION); return; }
  if (flags.help || pos[0] === 'help' || (!pos.length && (!process.stdin.isTTY || !process.stderr.isTTY || flags.json || flags.yes))) { console.log(HELP); return; }
  const root = realpathSync(flags.project ? resolve(flags.project) : projectRoot());
  process.chdir(root);
  if (!pos.length) {
    const { runMenu } = await import('./menu.mjs');
    await runMenu(root, { run: async args => {
      process.exitCode = 0;
      return main(['--project', root, ...args]);
    } });
    return;
  }
  const [command, action, ...rest] = pos;
  for (const key of ['title', 'summary', 'source']) {
    if (flags[key] && /[\r\n\0]/.test(flags[key])) throw new Error(`--${key} must be a single line without NUL characters.`);
  }
  if (command === 'update') {
    if (action || rest.length) throw new Error('Run mmx update [--check] [--yes] [--json] [--manager npm|pnpm].');
    if (flags['refresh-integrations']) {
      if (flags.check || flags.manager) throw new Error('Integration refresh cannot be combined with update selection flags.');
      const { refreshIntegrations } = await import('./setup.mjs');
      const result = await refreshIntegrations(root);
      if (flags.json) output(result);
      else console.log(result.refreshed ? 'Managed integrations refreshed. Restart your agent.' : 'No managed integrations in this project.');
      return;
    }
    const { update, formatUpdate } = await import('./update.mjs');
    const result = await update(root, flags);
    if (flags.json) output(result); else console.log(formatUpdate(result));
    if (result.status === 'manual') process.exitCode = 1;
    return result;
  }
  const selectedServer = () => serverUrl(flags.server || preferences(root).mindmuxCli?.server || readJson(join(homeDir(), 'config.json'), {}).server || DEFAULT_SERVER);
  if (command === 'clean') {
    const { clean } = await import('./clean.mjs');
    const result = await clean(root, flags);
    if (flags.json) output(result);
    else if (result.cancelled) console.log('Cleanup cancelled.');
    else console.log(`\n✓ Local MindMux setup has been reset.${result.signedOut ? ' You are signed out of the CLI.' : ''}\nCloud Projects and Brains are kept.\n\nRun mmx setup to start again.`);
    return;
  }
  if (command === 'setup' || command === 'remove' || command === 'switch') {
    const { setup, removeSetup, switchBrain } = await import('./setup.mjs');
    const result = await (command === 'switch' ? switchBrain(root, flags) : command === 'setup' ? setup(root, flags) : removeSetup(root, flags));
    if (flags.json) output(result);
    else if (command === 'remove') console.log(result.removed.length ? `Removed connections for ${result.removed.join(', ')}. Brain data, binding and login are kept.` : result.note);
    else {
      const agents = result.agents.map(agent => ({ 'claude-code': 'Claude Code', codex: 'Codex' })[agent] || agent).join(' and ');
      const project = result.binding.kind === 'cloud' ? result.binding.name : basename(result.project);
      const codexNote = result.agents.includes('codex') ? '\nIn Codex, trust this project and review the new or changed hooks with /hooks.' : '';
      console.log(`\n✓ MindMux is ready.\n\nProject: ${project}\nConfigured for: ${agents}\n\nRestart ${agents} in this project and approve any trust prompts to get started.${codexNote}`);
    }
    return;
  }
  if (command === 'mcp' && action === 'serve') {
    const { serveMcp } = await import('./mcp-server.mjs');
    await serveMcp(root); return;
  }
  if (command === 'hook') {
    let input;
    try { input = JSON.parse((await stdin()) || '{}'); }
    catch { output({}); return; }
    output(await runHook(root, flags.agent, action, input)); return;
  }
  if (command === 'login') {
    const server = selectedServer();
    await login(server, { open: !flags['no-open'] });
    writeJson(join(homeDir(), 'config.json'), { server }); return;
  }
  if (command === 'logout') {
    rmSync(credentialPath(selectedServer()), { force: true });
    output({ signedOut: true, note: 'Removed this CLI’s local credentials. This does not revoke other clients or server grants.' }); return;
  }
  if (command === 'init') {
    if (!flags.local) throw new Error('Choose --local explicitly, or run brain bind --brain-id <id> for Cloud.');
    localCommand(root, ['init', '--no-wire']);
    mergePreferences(root, { cloudBrain: { ...preferences(root).cloudBrain, enabled: false } });
    ignoreRuntime(root);
    output({ initialized: true, binding: binding(root), next: 'mmx connect --agent cursor' }); return;
  }
  if (command === 'connect' || command === 'disconnect') {
    output(connect(root, need(flags.agent, '--agent'), { remove: command === 'disconnect' })); return;
  }
  if (command === 'status') {
    const { status, formatStatus } = await import('./status.mjs');
    const report = await status(root, flags);
    if (flags.json) output(report); else console.log(formatStatus(report));
    if (report.live?.accessible === false || report.mcpProbe?.connected === false) process.exitCode = 1;
    return;
  }
  if (command === 'doctor') {
    const { doctor, formatDoctor } = await import('./doctor.mjs');
    const report = await doctor(root, flags);
    if (flags.json) output(report);
    else {
      console.log(formatDoctor(report));
      if (report.repairResult) {
        const result = report.repairResult;
        console.log(result.applied ? '\n✓ Managed configuration repaired. Restart the configured agents.'
          : result.cancelled ? '\nRepair cancelled. No changes were made.'
          : `\n${result.error || result.reason}`);
      }
    }
    if (!report.healthy) process.exitCode = 1;
    return;
  }
  if ((command === 'workspace' && action === 'list') || (command === 'project' && action === 'list') || (command === 'brain' && action === 'discover')) {
    const tool = command === 'workspace' ? 'list_workspaces' : command === 'project' ? 'list_projects' : 'list_brains';
    output(await withCloud(selectedServer(), call => call(tool, flags['workspace-id'] ? { workspaceId: flags['workspace-id'] } : {}))); return;
  }
  if (command === 'project' && action === 'create') {
    const workspaceId = need(flags['workspace-id'], '--workspace-id'), name = need(flags.name, '--name');
    if (!flags.confirm) throw new Error('New projects are visible to all Workspace members. Pass --confirm after selecting this Workspace and Project name.');
    output(await withCloud(selectedServer(), call => call('create_project', { workspaceId, name, description: flags.description || '' }))); return;
  }
  if (command === 'mcp') {
    if (action === 'call') {
      const args = JSON.parse(flags.args || '{}');
      if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('--args must be a JSON object.');
      output(await withCloud(selectedServer(), call => call(need(rest[0], 'tool name'), args))); return;
    }
    if (action === 'tools') {
      const { listCloudTools } = await import('./cloud.mjs');
      output(await listCloudTools(selectedServer())); return;
    }
  }
  if (command === 'brain' && action === 'bind') {
    if (flags.local && flags['brain-id']) throw new Error('Choose --local or --brain-id, not both.');
    const prefs = preferences(root);
    if (flags.local) {
      localCommand(root, ['brain-dir']);
      mergePreferences(root, { cloudBrain: { ...prefs.cloudBrain, enabled: false } });
    } else {
      const brainId = need(flags['brain-id'], '--brain-id'), server = selectedServer();
      const result = await withCloud(server, call => call('resolve_brain', { brainId }));
      if (result.status !== 'resolved') throw new Error('Cloud Brain unavailable; binding was not changed.');
      mergePreferences(root, { cloudBrain: { enabled: true, brainId, name: result.brain?.name || brainId }, mindmuxCli: { ...prefs.mindmuxCli, server } });
    }
    ignoreRuntime(root); output(binding(root)); return;
  }
  if (command === 'brain' && action === 'status') { output(binding(root)); return; }
  if (command === 'brain' && action === 'review') {
    output(await finishReview(root, { token: flags['review-token'], outcome: flags.outcome, reason: flags.reason, id: flags.id })); return;
  }
  if (command === 'brain') {
    // Validate operation before opening a cloud connection.
    if (!['index', 'reindex', 'list', 'roots', 'read', 'read-root', 'search', 'recall', 'create', 'update', 'append', 'archive', 'update-root'].includes(action)) throw new Error('Unknown brain command. Run mmx help.');
    let content;
    if (['create', 'update', 'update-root'].includes(action)) content = await body();
    const result = await withBrain(root, async brain => {
      const mutate = (resource, run) => reviewedWrite(root, flags['review-token'], brain, resource, run);
      switch (action) {
        case 'index': return brain.index();
        case 'reindex': return brain.reindex();
        case 'list': return { pages: (await brain.list()).map(({ raw, compiledTruth, ...page }) => page) };
        case 'roots': return { rootPages: await brain.roots() };
        case 'read': return brain.read(need(rest[0], 'page id'));
        case 'read-root': return brain.readRoot(need(rest[0], 'root slug'));
        case 'search': return { pages: await brain.search(need(rest.join(' '), 'query')) };
        case 'recall': return recall(brain, rest.join(' '));
        case 'create': {
          const id = need(flags.id, '--id'), title = need(flags.title, '--title'), category = need(flags.category, '--category');
          if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || /[\r\n]/.test(title)) throw new Error('Invalid page id or multiline title.');
          if (!['project', 'concept', 'decision', 'person', 'reference'].includes(category)) throw new Error('Invalid page category.');
          if (flags.status && !['active', 'draft', 'archived'].includes(flags.status)) throw new Error('Invalid page status.');
          return mutate({ kind: 'page', id }, () => brain.create({ id, title, category, status: flags.status || 'active', compiledTruth: content, creationSummary: flags.source || 'Captured through MindMux CLI' }));
        }
        case 'update': {
          const expected = need(flags['expected-version'], '--expected-version');
          const changeKind = flags['change-kind'] ?? 'substantive';
          if (!['correction', 'substantive'].includes(changeKind)) throw new Error('--change-kind must be correction or substantive.');
          if (changeKind === 'correction' && (flags.summary !== undefined || flags.source !== undefined)) throw new Error('A correction must omit --summary and --source; it does not add a Timeline entry.');
          if (changeKind === 'correction' && brain.target.kind !== 'cloud') throw new Error('Timeline-free correction is supported only for Cloud Brain. Local brain.md updates require --change-kind substantive and --summary.');
          const timeline = changeKind === 'substantive'
            ? { timelineEntry: { kind: 'decision', summary: need(flags.summary, '--summary'), source: flags.source || 'MindMux CLI' } }
            : {};
          return mutate({ kind: 'page', id: need(rest[0], 'page id') }, () => brain.update({ id: rest[0], compiledTruth: content,
            expectedVersion: brain.target.kind === 'cloud' ? cloudVersion(expected) : expected, changeKind, ...timeline }));
        }
        case 'append': {
          const kind = flags.kind || 'evidence';
          if (!['decision', 'evidence', 'reversal', 'note'].includes(kind)) throw new Error('Invalid timeline kind.');
          return mutate({ kind: 'page', id: need(rest[0], 'page id') }, () => brain.append({ id: rest[0], entry: { kind, summary: need(flags.summary, '--summary'), source: flags.source || 'MindMux CLI' } }));
        }
        case 'archive': return mutate({ kind: 'page', id: need(rest[0], 'page id') }, () => brain.archive(rest[0]));
        case 'update-root': {
          const expected = need(flags['expected-version'], '--expected-version');
          return mutate({ kind: 'root', id: need(rest[0], 'root slug') }, () => brain.updateRoot({ slug: rest[0], body: content,
            expectedVersion: brain.target.kind === 'cloud' && expected !== 'new' ? cloudVersion(expected) : expected }));
        }
      }
    });
    output(result); return;
  }
  throw new Error('Unknown command. Run mmx help.');
}
