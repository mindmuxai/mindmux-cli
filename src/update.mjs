import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import semver from 'semver';
import { homeDir, readJson, writeJson } from './storage.mjs';
import { VERSION } from './version.mjs';
import { createSetupPrompts } from './prompts.mjs';

const PACKAGE = '@mindmux/cli';
const REGISTRY = 'https://registry.npmjs.org';
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const execute = promisify(execFile);
export async function runCommand(command, args, options = {}) {
  const { stdout } = await execute(command, args, { cwd: homedir(), timeout: 5000, maxBuffer: 2 * 1024 * 1024, ...options, encoding: 'utf8' });
  return stdout.trim();
}
const canonical = path => { try { return realpathSync(path); } catch { return undefined; } };

export async function detectInstallation({ packageRoot = PACKAGE_ROOT, run = runCommand, manager } = {}) {
  if (manager && !['npm', 'pnpm'].includes(manager)) throw new Error('--manager must be npm or pnpm.');
  const current = canonical(packageRoot);
  if (existsSync(join(packageRoot, '.git')) || !current?.includes('/node_modules/')) return { kind: 'source', path: current || packageRoot };
  const matches = [];
  for (const name of ['npm', 'pnpm']) {
    try {
      const root = await run(name, ['root', '-g']);
      const candidate = join(root, PACKAGE);
      if (canonical(candidate) === current) matches.push({ kind: 'global', manager: name, globalRoot: root, path: current });
    } catch { /* An unavailable manager is not evidence that it owns this installation. */ }
  }
  const selected = manager ? matches.filter(match => match.manager === manager) : matches;
  if (selected.length === 1) return selected[0];
  if (matches.length) return { kind: 'unknown', path: current, reason: manager ? 'The selected manager does not own this installation.' : 'Both managers resolve to this installation. Use --manager npm or --manager pnpm.' };
  return { kind: 'local', path: current, reason: 'Not owned by an available npm/pnpm global installation. Update the project dependency or source installation with its original installer.' };
}

async function latestRelease(fetcher, timeout) {
  const response = await fetcher(`${REGISTRY}/@mindmux%2fcli/latest`, { signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Update check failed (HTTP ${response.status}). Try mmx update --check again later.`);
  const data = await response.json();
  if (data.name !== PACKAGE || !semver.valid(data.version) || semver.prerelease(data.version)) throw new Error('Registry returned invalid stable release metadata.');
  const node = data.engines?.node || '*';
  if (!semver.validRange(node)) throw new Error('Registry returned an invalid Node.js requirement.');
  return { latest: data.version, node };
}
export async function checkUpdate({ current = VERSION, fetcher = fetch, now = Date.now(), cachePath = join(homeDir(), 'update-check.json'), force = false, timeout = 3000 } = {}) {
  let cache = {};
  try { cache = readJson(cachePath, {}); } catch { /* A bad optional cache must not block the CLI. */ }
  if (!force && Number.isFinite(cache.checkedAt) && now >= cache.checkedAt && now - cache.checkedAt < DAY) {
    if (cache.error) return { current, available: false, cached: true };
    if (semver.valid(cache.latest) && !semver.prerelease(cache.latest) && semver.validRange(cache.node)) return { current, latest: cache.latest, node: cache.node, available: semver.gt(cache.latest, current), cached: true };
  }
  try {
    const release = await latestRelease(fetcher, timeout);
    try { writeJson(cachePath, { checkedAt: now, ...release }); } catch { /* Cache writes are best effort. */ }
    return { current, ...release, available: semver.gt(release.latest, current), cached: false };
  } catch (error) {
    try { writeJson(cachePath, { checkedAt: now, error: true }); } catch { /* Do not mask the network error. */ }
    throw error;
  }
}

export async function notifyUpdate({ argv = process.argv.slice(2), stdin = process.stdin, stderr = process.stderr, env = process.env, check = checkUpdate } = {}) {
  if (!stdin.isTTY || !stderr.isTTY || env.CI || env.NO_UPDATE_NOTIFIER || env.MINDMUX_NO_UPDATE_CHECK || argv.some(arg => ['--json', '--help', '--version', '--yes'].includes(arg))) return;
  // Only these exact human-facing commands may contact the registry or print notices.
  const commands = [...argv];
  while (commands[0] === '--project' || commands[0]?.startsWith('--project=')) {
    if (commands.shift() === '--project') commands.shift();
  }
  if (commands.length && !['setup', 'status', 'doctor'].includes(commands[0])) return;
  try {
    const result = await check({ timeout: 800 });
    if (result.available) stderr.write(`\nUpdate available: ${result.current} → ${result.latest}\nRun mmx update to upgrade.\n\n`);
  } catch { /* Passive checks are never command failures. */ }
}

export async function update(root, flags = {}, dependencies = {}) {
  if (flags.manager && !['npm', 'pnpm'].includes(flags.manager)) throw new Error('--manager must be npm or pnpm.');
  const run = dependencies.run || runCommand;
  const current = dependencies.current || VERSION;
  const report = await (dependencies.check || checkUpdate)({ force: true, current });
  if (flags.check) return { ...report, status: report.available ? 'available' : 'current' };
  if (!report.available) return { ...report, status: 'current' };
  if (!semver.satisfies(process.versions.node, report.node)) throw new Error(`MindMux ${report.latest} requires Node.js ${report.node}. Upgrade Node.js first.`);
  const installation = await (dependencies.detect || detectInstallation)({ run, manager: flags.manager });
  if (installation.kind !== 'global') return { ...report, status: 'manual', installation,
    message: installation.kind === 'source' ? 'Source installation detected. Update your checkout and reinstall using your original source-install workflow; local changes were not modified.' : installation.reason };
  if (!flags.yes) {
    if (!dependencies.prompts && !(process.stdin.isTTY && process.stderr.isTTY)) throw new Error('Run mmx update in an interactive terminal, or pass --yes.');
    const confirmed = await (dependencies.prompts || createSetupPrompts()).confirm(`Update MindMux ${current} → ${report.latest} using ${installation.manager}? Refresh this project’s managed connections afterwards.`);
    if (!confirmed) return { ...report, status: 'cancelled' };
  }
  const lock = join(dependencies.home || homeDir(), 'update.lock');
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  try { mkdirSync(lock); } catch { throw new Error(`Another update is active. After confirming it stopped, remove ${lock} and retry.`); }
  try {
    // Revalidate immediately before installing, including an explicit manager selection.
    const latestDetection = await (dependencies.detect || detectInstallation)({ run, manager: installation.manager });
    if (latestDetection.kind !== 'global' || latestDetection.path !== installation.path || latestDetection.globalRoot !== installation.globalRoot) throw new Error('Installation changed during confirmation. Rerun mmx update.');
    const args = installation.manager === 'npm' ? ['install', '-g'] : ['add', '-g'];
    const command = [...args, `${PACKAGE}@${report.latest}`, `--registry=${REGISTRY}`];
    if (!flags.json) (dependencies.write || console.log)(`Installing MindMux ${report.latest} with ${installation.manager}…`);
    try { await run(installation.manager, command, { timeout: 180000 }); }
    catch (error) { throw new Error(`Update installation failed: ${[error.stderr, error.stdout].filter(Boolean).join('\n').trim() || error.message}. No project configuration was refreshed. Check permissions or your package-manager setup and retry; mmx does not invoke sudo.`); }
    // pnpm may move the package into a different versioned directory. Resolve it again.
    const globalRoot = await run(installation.manager, ['root', '-g']);
    if (globalRoot !== installation.globalRoot) throw new Error('The package-manager global directory changed during installation. Check your installation before refreshing project connections.');
    const newPackage = join(globalRoot, PACKAGE);
    const newBin = join(newPackage, 'bin/mmx.mjs');
    const installedVersion = await run(process.execPath, [newBin, '--version']);
    if (installedVersion !== report.latest) throw new Error(`Package installation finished but version verification failed (expected ${report.latest}, received ${installedVersion}). Rerun mmx update --check and inspect your installation.`);
    const warnings = [];
    let refresh;
    try {
      refresh = JSON.parse(await run(process.execPath, [newBin, '--project', root, 'update', '--refresh-integrations', '--json'], { timeout: 30000 }));
      if (!refresh.refreshed) warnings.push('No managed connections in this project. Run mmx setup if needed.');
    } catch (error) { warnings.push(`CLI updated, but project connections could not be refreshed: ${error.message}. Run mmx doctor --fix or mmx setup in this project.`); }
    try {
      const pathVersion = await run('mmx', ['--version']);
      if (pathVersion !== report.latest) warnings.push(`Your shell resolves mmx ${pathVersion}, not ${report.latest}. Check PATH for multiple installations.`);
    } catch { warnings.push('Could not verify mmx on PATH. Check PATH or reopen your terminal.'); }
    return { ...report, status: 'updated', manager: installation.manager, installedVersion, refresh, warnings,
      next: 'Restart your agent/MCP service. Other connected projects may need mmx doctor --fix or mmx setup to refresh their paths and rules.' };
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

export function formatUpdate(report) {
  if (report.status === 'cancelled') return 'Update cancelled.';
  if (report.status === 'manual') return `${report.message}\nCurrent installation: ${report.installation.path}\nSee docs/installation.md for the original installation workflow.`;
  if (report.status === 'current') return `MindMux ${report.current} is up to date (latest stable: ${report.latest}).`;
  if (report.status === 'available') return `Update available: ${report.current} → ${report.latest}\nRun mmx update to upgrade.`;
  return `\n✓ Updated MindMux to ${report.installedVersion}.${report.refresh?.refreshed ? '\n✓ Refreshed this project’s integrations.' : ''}\n${report.warnings.map(warning => `\n• ${warning}`).join('')}\n\n${report.next}`;
}
