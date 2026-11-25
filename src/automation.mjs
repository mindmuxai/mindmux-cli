import { guardPath } from './host-config.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { readJson, writeJson, ignoreRuntime } from './storage.mjs';

const pathFor = root => join(root, '.mindmux/cli/automation.json');
export function automation(root) {
  guardPath(root, pathFor(root));
  const state = readJson(pathFor(root), { paused: false, revision: 'initial' });
  if (typeof state.paused !== 'boolean' || typeof state.revision !== 'string' || !state.revision) {
    throw new Error('Invalid automatic memory state. Run mmx pause or mmx resume to reset it.');
  }
  return state;
}
export function setAutomation(root, paused) {
  for (const path of [pathFor(root), join(root, '.mindmux/cli/sessions'), join(root, '.gitignore')]) guardPath(root, path);
  // Every explicit change invalidates pending contexts and reviews, even pause -> resume.
  ignoreRuntime(root);
  const state = { paused, revision: randomUUID(), updatedAt: new Date().toISOString() };
  writeJson(pathFor(root), state);
  rmSync(join(root, '.mindmux/cli/sessions'), { recursive: true, force: true });
  return state;
}
export function automationMatches(root, revision) {
  const state = automation(root);
  return !state.paused && state.revision === revision;
}
