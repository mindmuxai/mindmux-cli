import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homeDir, readJson } from './storage.mjs';
import { guardPath } from './host-config.mjs';

// Recover only previously configured projects from this CLI home's own backups.
// Never scan arbitrary user directories or restore old backup contents.
export function updateProjects(root, { allProjects = false, home = homeDir() } = {}) {
  const projects = [realpathSync(root)], warnings = [];
  if (!allProjects) return { projects, warnings };
  const backups = join(home, 'backups');
  if (!existsSync(backups)) return { projects, warnings };
  if (lstatSync(backups).isSymbolicLink()) throw new Error(`Refusing backup directory symlink: ${backups}`);
  for (const hash of readdirSync(backups).sort()) {
    if (!/^[a-f0-9]{64}$/.test(hash)) continue;
    const dir = join(backups, hash);
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) continue;
    const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort().reverse();
    let known;
    for (const name of files) {
      const path = join(dir, name);
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) continue;
      try {
        const backup = readJson(path, {});
        const record = backup.files?.find(file => typeof file.path === 'string' && file.path.endsWith('/.mindmux/cli/setup.json'));
        const candidate = backup.project || (record && dirname(dirname(dirname(record.path))));
        if (typeof candidate !== 'string' || !isAbsolute(candidate) || createHash('sha256').update(candidate).digest('hex') !== hash) continue;
        known = candidate; break;
      } catch { /* An older valid backup can still identify this project. */ }
    }
    if (!known) { warnings.push(`Could not identify the project for backup ${hash}; it was not refreshed.`); continue; }
    if (projects.includes(known)) continue;
    if (!existsSync(known)) { warnings.push(`Recorded project no longer exists: ${known}. Skipped.`); continue; }
    try {
      if (realpathSync(known) !== known) throw new Error('Project path now resolves through a symlink.');
      const setup = join(known, '.mindmux/cli/setup.json'), integrations = join(known, '.mindmux/cli/integrations.json');
      guardPath(known, setup); guardPath(known, integrations);
      const agents = [...Object.keys(readJson(setup, {}).agents || {}), ...Object.keys(readJson(integrations, {}))];
      if (agents.length) projects.push(known);
    } catch (error) { warnings.push(`Cannot inspect recorded project ${known}: ${error.message}`); }
  }
  return { projects, warnings };
}

export async function refreshUpdateProjects(root, options = {}, dependencies = {}) {
  const plan = options.plan || updateProjects(root, options);
  const refresh = dependencies.refresh || (await import('./setup.mjs')).refreshIntegrations;
  const projects = [], warnings = [...plan.warnings];
  for (const project of plan.projects) {
    try {
      const result = await refresh(project);
      projects.push({ project, ...result });
    } catch (error) {
      projects.push({ project, refreshed: false, error: error.message });
      warnings.push(`Project connections could not be refreshed in ${project}: ${error.message}. Run mmx doctor --fix in that project.`);
    }
  }
  return { refreshed: projects.some(project => project.refreshed), projects, warnings };
}
