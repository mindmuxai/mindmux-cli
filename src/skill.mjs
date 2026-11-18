import { readFileSync } from 'node:fs';

// Resolve from the installed package, independent of the caller's project or login.
export function readSkill() {
  return readFileSync(new URL('../skills/mindmux-cli/SKILL.md', import.meta.url), 'utf8');
}
