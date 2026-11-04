import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, writeAtomic, ignoreRuntime, homeDir } from './storage.mjs';
import { MEMORY_POLICY } from './recall.mjs';

export const CLI_BIN = fileURLToPath(new URL('../bin/mmx.mjs', import.meta.url));
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const BEGIN = '<!-- BEGIN mindmux-cli -->', END = '<!-- END mindmux-cli -->';
const CURSOR_OWNER = '<!-- mindmux-cli managed rule file -->';
const CURSOR_HEADER = '---\ndescription: Bound project Brain memory\nalwaysApply: true\n---\n';
export const AGENTS = ['cursor', 'claude-code', 'codex'];
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
    : agent === 'claude-code' ? { rules: join(root, 'CLAUDE.md'), hooks: join(root, '.claude/settings.json') }
    : { rules: join(root, 'AGENTS.md'), hooks: join(root, '.codex/hooks.json') };
}
function ruleText(root) {
  const command = `env ${shellQuote("MINDMUX_HOME=" + homeDir())} ${shellQuote(process.execPath)} ${shellQuote(CLI_BIN)} --project ${shellQuote(root)}`;
  return `MindMux Project Brain\n\n${MEMORY_POLICY}\n\nUse the following CLI command prefix from any working directory:\n\n\`${command}\`\n\nAt the start of every new task (including discussion), run \`<prefix> brain recall "task keywords"\` if relevant context has not arrived via a hook.\nOperations: \`brain list\`, \`brain search "keywords"\`, \`brain read <id>\`, \`brain roots\`, \`brain read-root <slug>\`. Results are JSON.\nCapture a confirmed decision: pipe its body to \`<prefix> brain create --id <id> --title "Title" --category decision --source "user confirmed ..."\`.\nUpdate: read first, then pipe the new body to \`<prefix> brain update <id> --expected-version <version> --summary "Why it changed"\`.\nPreserve unchanged values exactly, including code, quotes and backslashes. JSON output escapes are serialization, not literal Markdown content: decode the string before reusing it. Send body text through stdin using a quoted heredoc or a file, without adding shell/JSON escaping to the body. After creating or updating, read the page back and verify the intended changes and unchanged values before reporting success. If correction is needed, use the newly read version and record the reason.\nAppend evidence: \`<prefix> brain append <id> --kind evidence --summary "Evidence" --source "Source"\`.\nUse \`brain create --status draft\` for explicitly requested proposals; never present drafts as settled facts.\nThe CLI resolves the explicit project binding. For Cloud, do not fall back to local tools after an error. An authenticated MCP can also be used only with the same bound brainId shown by \`brain status\`.\nWhen another Brain guide documents local file commands, retain its data-format contract and route this project's operations through the binding above.\nIf unbound, ask the user to select/create a Brain; never infer a cloud Brain from a folder name.\nBefore finishing, check whether any confirmed durable knowledge remains uncaptured. If none, finish without creating a page.\n`;
}
function definitions(root, agent) {
  root = realpathSync(root);
  const prefix = `env ${shellQuote("MINDMUX_HOME=" + homeDir())} ${shellQuote(process.execPath)} ${shellQuote(CLI_BIN)} --project ${shellQuote(root)} hook --agent ${agent}`;
  if (agent === 'cursor') return Object.fromEntries([
    ['sessionStart', 'session-start'], ['beforeSubmitPrompt', 'prompt'], ['preToolUse', 'pre-tool'], ['stop', 'stop'],
  ].map(([event, operation]) => [event, [{ command: `${prefix} ${operation}`, ...(event === 'stop' ? { loop_limit: 1 } : {}) }]]));
  if (agent === 'claude-code' || agent === 'codex') return Object.fromEntries([
    ['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'], ['Stop', 'stop'],
  ].map(([event, operation]) => [event, [{ hooks: [{ type: 'command', command: `${prefix} ${operation}`, timeout: 10, ...(agent === 'codex' && event !== 'Stop' ? { additionalContextLimit: 10000 } : {}) }] }]]));
  return {};
}
const commandOf = definition => definition.command || definition.hooks?.[0]?.command;

export function connect(root, agent, { remove = false } = {}) {
  const files = integrationFiles(root, agent);
  const manifestPath = join(root, '.mindmux/cli/integrations.json');
  const manifest = readJson(manifestPath, {});
  const previous = manifest[agent]?.commands || [];
  let text = existsSync(files.rules) ? readFileSync(files.rules, 'utf8') : '';
  // Recognize an empty skeleton left by v0.1's old uninstaller as well as owned rules.
  if (agent === 'cursor' && text && !text.includes(BEGIN) && !text.includes(CURSOR_OWNER) && text.trim() !== CURSOR_HEADER.trim()) throw new Error(`Refusing to overwrite foreign rule: ${files.rules}`);
  text = managedBlock(text, remove ? '' : ruleText(root));
  let removeRule = false;
  if (agent === 'cursor') {
    if (!text.startsWith('---')) text = `${CURSOR_HEADER}${text}`;
    removeRule = remove && !text.replace(CURSOR_HEADER, '').replace(CURSOR_OWNER, '').trim();
    if (!removeRule && !text.includes(CURSOR_OWNER)) text += `\n${CURSOR_OWNER}\n`;
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
      const kept = current.filter(item => !previous.includes(commandOf(item)));
      const desired = defs[event] || [];
      settings.hooks[event] = [...kept, ...desired.filter(item => !kept.some(old => commandOf(old) === commandOf(item)))];
      if (!settings.hooks[event].length) delete settings.hooks[event];
    }
  }
  if (removeRule) rmSync(files.rules, { force: true });
  else writeAtomic(files.rules, text);
  if (settings) writeJson(files.hooks, settings);
  if (remove) delete manifest[agent];
  else manifest[agent] = { installedAt: new Date().toISOString(), bin: CLI_BIN, node: process.execPath,
    commands: Object.values(defs).flat().map(commandOf), mode: 'hooks' };
  writeJson(manifestPath, manifest);
  ignoreRuntime(root, agent === 'codex' && !remove ? ['/.codex/hooks.json'] : []);
  return { agent, installed: !remove, mode: 'hooks', ...files,
    note: agent === 'codex' ? 'Restart Codex, trust the project, and review the installed hooks with /hooks. Hook execution requires a compatible Codex with hooks enabled.' : 'Restart/reload the agent and review hook trust. doctor reports configured state; real delivery requires host execution.' };
}

export function inspectIntegrations(root) {
  const manifest = readJson(join(root, '.mindmux/cli/integrations.json'), {});
  return Object.entries(manifest).map(([agent, installed]) => {
    const files = integrationFiles(root, agent);
    const text = existsSync(files.rules) ? readFileSync(files.rules, 'utf8') : '';
    const hooks = files.hooks ? readJson(files.hooks, {}).hooks || {} : {};
    const actualCommands = Object.values(hooks).filter(Array.isArray).flat().map(commandOf);
    const expected = Object.values(definitions(root, agent)).flat().map(commandOf);
    return { agent, mode: installed.mode, rulesPresent: text.includes(BEGIN) && text.includes(END),
      hookCommandsPresent: installed.commands.length > 0 && installed.commands.every(command => actualCommands.includes(command))
        && expected.every(command => actualCommands.includes(command)),
      executablePresent: existsSync(installed.bin) && existsSync(installed.node),
      existingBrainMdHook: JSON.stringify(hooks).includes('brain-session-start') };
  });
}
