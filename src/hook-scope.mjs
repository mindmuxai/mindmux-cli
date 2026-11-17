import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Host settings can be inherited by worktrees and nested projects. Never dispatch
// another checkout's hook against the Brain pinned into its installed command.
export function hookProjectMatches(root, input) {
  if (typeof input.cwd !== 'string' || !input.cwd) return false;
  try {
    const expected = realpathSync(root);
    for (let current = realpathSync(input.cwd); ; current = dirname(current)) {
      if (current === expected) return true;
      if (existsSync(join(current, '.git')) || existsSync(join(current, '.mindmux/preferences.json'))
        || existsSync(join(current, '.mindmux/cli/integrations.json'))) return false;
      if (dirname(current) === current) return false;
    }
  } catch { return false; }
}
