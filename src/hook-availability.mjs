import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { readJson } from './storage.mjs';
import { inspectCodexHooks } from './codex-hooks.mjs';

export function inspectHookAvailability(root, agent) {
  if (agent === 'codex') return inspectCodexHooks();
  if (agent !== 'claude-code') return { supported: true, enabled: true };
  const paths = [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
    join(root, '.claude/settings.json'), join(root, '.claude/settings.local.json')];
  // New Claude versions also read the main checkout's local settings in worktrees.
  try {
    const listing = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'],
      { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
    const main = listing.split('\0').find(field => field.startsWith('worktree '))?.slice(9);
    if (main) {
      const mainLocal = join(main, '.claude/settings.local.json');
      if (!paths.includes(mainLocal)) paths.push(mainLocal);
    }
  } catch {}
  const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : process.platform === 'win32' ? join(process.env.ProgramData || 'C:\\ProgramData', 'ClaudeCode/managed-settings.json')
      : '/etc/claude-code/managed-settings.json';
  paths.push(managed);
  let disabled = false, source;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const settings = readJson(path, {});
    if (typeof settings.disableAllHooks === 'boolean') { disabled = settings.disableAllHooks; source = path; }
    if (path === managed && settings.allowManagedHooksOnly === true) return { supported: true, enabled: false,
      message: `Claude Code allowManagedHooksOnly blocks MindMux hooks (${path}). User/admin policy was preserved.` };
  }
  return { supported: true, enabled: !disabled, verified: false,
    message: disabled ? `Claude Code disableAllHooks is enabled (${source}). User settings were preserved.`
      : 'Claude Code: no known disabling setting found. Runtime settings, trust and execution still require host verification.' };
}
export function requireHooksAvailable(capability) {
  if (capability?.supported === false || capability?.enabled === false) throw new Error(capability.message || 'Agent hooks are unavailable. Enable supported hooks before setting up MindMux.');
}
