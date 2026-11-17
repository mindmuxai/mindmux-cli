import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, writeAtomic, ignoreRuntime, homeDir } from './storage.mjs';
import { guardPath } from './host-config.mjs';
import { inspectHookAvailability, requireHooksAvailable } from './hook-availability.mjs';
import { MEMORY_POLICY } from './recall.mjs';

export const CLI_BIN = fileURLToPath(new URL('../bin/mmx.mjs', import.meta.url));
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const BEGIN = '<!-- BEGIN mindmux-cli -->', END = '<!-- END mindmux-cli -->';
const CURSOR_OWNER = '<!-- mindmux-cli managed rule file -->';
const CURSOR_HEADER = '---\ndescription: Bound project Brain memory\nalwaysApply: true\n---\n';
export const AGENTS = ['cursor', 'claude-code', 'codex'];
const CODEX_STATUS_MESSAGES = {
  SessionStart: 'MindMux: load Brain context',
  UserPromptSubmit: 'MindMux: recall project knowledge',
  Stop: 'MindMux: verify memory review',
  Interrupt: 'MindMux: close interrupted review',
};
export function managedBlock(text, content) {
  const starts = text.split(BEGIN).length - 1, ends = text.split(END).length - 1;
  if (starts !== ends || starts > 1 || (starts && text.indexOf(END) < text.indexOf(BEGIN))) throw new Error('Malformed mindmux-cli instruction markers. Repair before continuing.');
  const block = content ? `${BEGIN}\n${content}\n${END}` : '';
  if (starts) return text.slice(0, text.indexOf(BEGIN)) + block + text.slice(text.indexOf(END) + END.length);
  return content ? `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n${block}\n` : text;
}
export function integrationFiles(root, agent) {
  if (!AGENTS.includes(agent)) throw new Error(`Unknown agent. Choose ${AGENTS.join(', ')}.`);
  return agent === 'cursor' ? { rules: join(root, '.cursor/rules/mindmux.mdc'), hooks: join(root, '.cursor/hooks.json') }
    : agent === 'claude-code' ? { rules: join(root, 'CLAUDE.md'), hooks: join(root, '.claude/settings.local.json'), legacyHooks: join(root, '.claude/settings.json') }
    : { rules: join(root, 'AGENTS.md'), hooks: join(root, '.codex/hooks.json') };
}
export function agentGuidance(root) {
  const command = `env ${shellQuote("MINDMUX_HOME=" + homeDir())} ${shellQuote(process.execPath)} ${shellQuote(CLI_BIN)} --project ${shellQuote(root)}`;
  return `MindMux Project Brain\n\n${MEMORY_POLICY}\n\nUse the following CLI command prefix from any working directory:\n\n\`${command}\`\n\nAt the start of every new task (including discussion), run \`<prefix> brain recall "task keywords"\` if relevant context has not arrived via a hook.\nOperations: \`brain index\` (page summaries and root navigation), \`brain reindex\` (regenerate the derived index), \`brain list\`, \`brain search "keywords"\`, \`brain read <id>\`, \`brain roots\`, \`brain read-root <slug>\`. Results are JSON.\nCapture a confirmed decision: pipe its body to \`<prefix> brain create --id <id> --title "Title" --category decision --source "user confirmed ..."\`.\nUpdate: read the complete Page first, then pipe the full replacement body to \`<prefix> brain update <id> --expected-version <version> --summary "Why it changed"\`.\nFor a Cloud correction of typos, formatting or erroneous initial content, use \`<prefix> brain update <id> --expected-version <version> --change-kind correction\` without --summary or --source. Other updates default to substantive and require --summary.\nPreserve unchanged values exactly, including code, quotes and backslashes. JSON output escapes are serialization, not literal Markdown content: decode the string before reusing it. Send body text through stdin using a quoted heredoc or a file, without adding shell/JSON escaping to the body. After creating or updating, read the page back and verify the intended changes and unchanged values before reporting success. If correction is needed, use the newly read version and record the reason.\nAppend evidence: \`<prefix> brain append <id> --kind evidence --summary "Evidence" --source "Source"\`.\nUse \`brain create --status draft\` for explicitly requested proposals; never present drafts as settled facts.\nThe CLI resolves the explicit project binding. For Cloud, do not fall back to local tools after an error. An authenticated MCP can also be used only with the same bound brainId shown by \`brain status\`.\nWhen another Brain guide documents local file commands, retain its data-format contract and route this project's operations through the binding above.\nIf unbound, ask the user to select/create a Brain; never infer a cloud Brain from a folder name.\nBefore finishing, check whether any confirmed durable knowledge remains uncaptured. If none, finish without creating a page.\n`;
}
function definitions(root, agent, { home = homeDir(), node = process.execPath, bin = CLI_BIN } = {}) {
  root = realpathSync(root);
  const prefix = `env ${shellQuote("MINDMUX_HOME=" + home)} ${shellQuote(node)} ${shellQuote(bin)} --project ${shellQuote(root)} hook --agent ${agent}`;
  if (agent === 'cursor') return Object.fromEntries([
    ['sessionStart', 'session-start'], ['beforeSubmitPrompt', 'prompt'], ['preToolUse', 'pre-tool'], ['stop', 'stop'],
  ].map(([event, operation]) => [event, [{ command: `${prefix} ${operation}`, ...(event === 'stop' ? { loop_limit: 1 } : {}) }]]));
  if (agent === 'claude-code' || agent === 'codex') return Object.fromEntries([
    ['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'], ['Stop', 'stop'], ...(agent === 'codex' ? [['Interrupt', 'interrupt']] : []),
  ].map(([event, operation]) => [event, [{ hooks: [{
    // Codex caps Interrupt hooks at three seconds, including background hooks.
    type: 'command', command: `${prefix} ${operation}`, timeout: agent === 'codex' && event === 'Interrupt' ? 3 : 10,
    // Codex also uses statusMessage as the handler title in /hooks.
    ...(agent === 'codex' ? { statusMessage: CODEX_STATUS_MESSAGES[event] } : {}),
    ...(agent === 'codex' && ['SessionStart', 'UserPromptSubmit'].includes(event) ? { additionalContextLimit: 10000 } : {}),
  }] }]]));
  return {};
}
const commandOf = definition => definition.command || definition.hooks?.[0]?.command;
const commandsOf = definition => definition.hooks?.map(hook => hook.command).filter(Boolean) || [definition.command].filter(Boolean);

// Match exact recorded/generated commands, never an arbitrary command containing "mindmux".
// The setup launcher can recover ownership if only the integration receipt was lost.
function ownedCommands(root, agent, manifest) {
  const launcher = readJson(join(root, '.mindmux/cli/setup.json'), {}).agents?.[agent]?.installed;
  const args = launcher?.args;
  const known = Object.values(definitions(root, agent)).flat().flatMap(commandsOf);
  if (Array.isArray(args) && args.length === 5 && args[1] === '--project' && args[2] === realpathSync(root) && args[3] === 'mcp' && args[4] === 'serve'
    && typeof launcher.command === 'string' && typeof args[0] === 'string') {
    known.push(...Object.values(definitions(root, agent, { node: launcher.command, bin: args[0], home: launcher.env?.MINDMUX_HOME || homeDir() })).flat().flatMap(commandsOf));
  }
  return new Set([...(manifest[agent]?.commands || []), ...known]);
}

function withoutOwnedCommands(items, owned) {
  return items.flatMap(item => {
    if (item.command && owned.has(item.command)) return [];
    if (!Array.isArray(item.hooks)) return [item];
    const hooks = item.hooks.filter(hook => !owned.has(hook.command));
    if (hooks.length === item.hooks.length) return [item];
    return hooks.length ? [{ ...item, hooks }] : [];
  });
}

// Recognizing a historical shape is enough to report a conflict, never enough
// to delete a command whose ownership cannot be established.
const looksManaged = command => /(?:mmx|mindmux)\.mjs['"]?\s+--project\s/.test(command)
  && /\shook --agent (?:codex|claude-code|cursor) (?:session-start|prompt|pre-tool|stop|interrupt)(?:\s|$)/.test(command);
export function inspectHookOwnership(root, agent) {
  const files = integrationFiles(root, agent);
  const owned = ownedCommands(root, agent, readJson(join(root, '.mindmux/cli/integrations.json'), {}));
  const conflicts = []; let recognized = false;
  for (const path of [files.hooks, files.legacyHooks].filter(Boolean)) {
    guardPath(root, path);
    const hooks = readJson(path, {}).hooks || {};
    if (typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error(`Invalid hooks: ${path}`);
    for (const items of Object.values(hooks)) {
      if (!Array.isArray(items)) throw new Error(`Invalid hook array: ${path}`);
      for (const command of items.flatMap(commandsOf)) {
        if (owned.has(command)) recognized = true;
        else if (looksManaged(command)) conflicts.push(path);
      }
    }
  }
  return { recognized, conflicts: [...new Set(conflicts)] };
}
export function requireHookOwnership(root, agent) {
  const state = inspectHookOwnership(root, agent);
  if (state.conflicts.length) throw new Error(`MindMux hook migration conflict: ${state.conflicts.join(', ')} contains historical commands without local ownership records. Review and explicitly remove only the obsolete MindMux handlers, or restore their installation records, then retry. No unknown handlers were removed.`);
  return state;
}
export function discoverHookAgents(root) {
  return AGENTS.filter(agent => { const state = requireHookOwnership(root, agent); return state.recognized; });
}

export function connect(root, agent, { remove = false, availability } = {}) {
  const files = integrationFiles(root, agent);
  for (const path of Object.values(files)) guardPath(root, path);
  const manifestPath = join(root, '.mindmux/cli/integrations.json');
  const manifest = readJson(manifestPath, {});
  const previous = ownedCommands(root, agent, manifest);
  requireHookOwnership(root, agent);
  if (!remove) requireHooksAvailable(availability || inspectHookAvailability(root, agent));
  let text = existsSync(files.rules) ? readFileSync(files.rules, 'utf8') : '';
  // Recognize an empty skeleton left by v0.1's old uninstaller as well as owned rules.
  if (agent === 'cursor' && text && !text.includes(BEGIN) && !text.includes(CURSOR_OWNER) && text.trim() !== CURSOR_HEADER.trim()) throw new Error(`Refusing to overwrite foreign rule: ${files.rules}`);
  const originalText = text;
  text = managedBlock(text, remove || agent !== 'cursor' ? '' : agentGuidance(root));
  let removeRule = false;
  if (agent === 'cursor') {
    if (!text.startsWith('---')) text = `${CURSOR_HEADER}${text}`;
    removeRule = remove && !text.replace(CURSOR_HEADER, '').replace(CURSOR_OWNER, '').trim();
    if (!removeRule && !text.includes(CURSOR_OWNER)) text += `\n${CURSOR_OWNER}\n`;
  }
  // Validate both local and legacy shared configuration before mutating either.
  let legacy;
  if (files.legacyHooks && existsSync(files.legacyHooks)) {
    const original = readJson(files.legacyHooks, {});
    legacy = { ...original };
    if (legacy.hooks !== undefined) {
      if (!legacy.hooks || typeof legacy.hooks !== 'object' || Array.isArray(legacy.hooks)) throw new Error(`Invalid hooks object: ${files.legacyHooks}`);
      legacy.hooks = { ...legacy.hooks };
      for (const [event, items] of Object.entries(legacy.hooks)) {
        if (!Array.isArray(items)) throw new Error(`Invalid hook array ${event}: ${files.legacyHooks}`);
        legacy.hooks[event] = withoutOwnedCommands(items, previous);
        if (!legacy.hooks[event].length) delete legacy.hooks[event];
      }
      if (!Object.keys(legacy.hooks).length) delete legacy.hooks;
    }
    if (JSON.stringify(original) === JSON.stringify(legacy)) legacy = undefined;
  }
  let settings;
  const defs = remove ? {} : definitions(root, agent);
  if (files.hooks) {
    settings = readJson(files.hooks, agent === 'cursor' ? { version: 1 } : {});
    if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error(`Invalid hooks object: ${files.hooks}`);
    settings.hooks = { ...settings.hooks };
    // Compute and validate everything before the first write.
    for (const event of new Set([...Object.keys(settings.hooks), ...Object.keys(defs)])) {
      const current = settings.hooks[event] || [];
      if (!Array.isArray(current)) throw new Error(`Invalid hook array ${event}: ${files.hooks}`);
      const kept = withoutOwnedCommands(current, previous);
      const desired = defs[event] || [];
      settings.hooks[event] = [...kept, ...desired.filter(item => !kept.some(old => commandOf(old) === commandOf(item)))];
      if (!settings.hooks[event].length) delete settings.hooks[event];
    }
  }
  if (removeRule) rmSync(files.rules, { force: true });
  else if (text !== originalText || agent === 'cursor') {
    if (agent !== 'cursor' && !text.trim()) rmSync(files.rules, { force: true });
    else writeAtomic(files.rules, text);
  }
  if (legacy) {
    if (Object.keys(legacy).length) writeJson(files.legacyHooks, legacy);
    else rmSync(files.legacyHooks, { force: true });
  }
  if (settings) writeJson(files.hooks, settings);
  if (remove) delete manifest[agent];
  else manifest[agent] = { installedAt: new Date().toISOString(), bin: CLI_BIN, node: process.execPath,
    commands: Object.values(defs).flat().map(commandOf), mode: 'hooks' };
  writeJson(manifestPath, manifest);
  ignoreRuntime(root, !remove ? agent === 'codex' ? ['/.codex/hooks.json'] : agent === 'claude-code' ? ['/.claude/settings.local.json'] : [] : []);
  return { agent, installed: !remove, mode: 'hooks', ...files,
    note: agent === 'codex' ? 'Restart Codex, trust the project, and review the installed hooks with /hooks. Hook execution requires a compatible Codex with hooks enabled.' : 'Restart/reload the agent and review hook trust. doctor reports configured state; real delivery requires host execution.' };
}

export function inspectIntegrations(root) {
  const manifest = readJson(join(root, '.mindmux/cli/integrations.json'), {});
  return Object.entries(manifest).map(([agent, installed]) => {
    const files = integrationFiles(root, agent);
    const text = existsSync(files.rules) ? readFileSync(files.rules, 'utf8') : '';
    const hooks = files.hooks ? readJson(files.hooks, {}).hooks || {} : {};
    const actualCommands = Object.values(hooks).filter(Array.isArray).flat().flatMap(commandsOf);
    const expected = Object.values(definitions(root, agent)).flat().map(commandOf);
    return { agent, mode: installed.mode, rulesRequired: agent === 'cursor', rulesPresent: text.includes(BEGIN) && text.includes(END),
      guidanceReady: agent === 'cursor' ? text.includes(BEGIN) && text.includes(END) : !text.includes(BEGIN),
      hookCommandsPresent: installed.commands.length > 0 && installed.commands.every(command => actualCommands.includes(command))
        && expected.every(command => actualCommands.includes(command)),
      executablePresent: existsSync(installed.bin) && existsSync(installed.node),
      hookConflicts: inspectHookOwnership(root, agent).conflicts,
      existingBrainMdHook: JSON.stringify(hooks).includes('brain-session-start') };
  });
}
