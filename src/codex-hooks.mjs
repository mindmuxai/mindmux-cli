import { execFileSync } from 'node:child_process';

// Feature discovery avoids guessing a minimum version or changing global Codex settings.
export function inspectCodexHooks(run = execFileSync) {
  try {
    const output = run('codex', ['features', 'list'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] });
    const match = output.split(/\r?\n/).find(line => /^hooks\s/.test(line))?.match(/\s(true|false)\s*$/);
    if (!match) return { supported: false, enabled: false, message: 'Codex does not report hooks support. Update Codex before using this integration.' };
    return { supported: true, enabled: match[1] === 'true', message: match[1] === 'true'
      ? 'Codex hooks are enabled. Project and hook trust must still be reviewed in Codex with /hooks.'
      : 'Codex hooks are disabled. Enable them with codex features enable hooks, then review /hooks.' };
  } catch {
    return { supported: null, enabled: null, message: 'Could not verify Codex hooks support. Install or update Codex, then run mmx doctor.' };
  }
}
