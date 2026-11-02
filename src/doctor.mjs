import { status } from './status.mjs';
import { planRepair, applyRepair, legacyWarnings } from './setup.mjs';
import { createSetupPrompts } from './prompts.mjs';

export async function diagnose(root, flags = {}, dependencies = {}) {
  let report;
  try { report = await status(root, flags, dependencies); }
  catch (error) {
    return { project: root, healthy: false, checks: [{ state: 'error', message: error.message,
      next: 'Repair the invalid configuration manually, then run mmx doctor again.' }],
    repair: { available: false, reason: 'Invalid or unsafe configuration cannot be repaired automatically.' } };
  }
  const checks = [];
  const check = (ok, message, next) => checks.push({ state: ok ? 'ok' : 'error', message, ...(ok ? {} : { next }) });
  check(report.binding.kind !== 'unbound', report.binding.kind === 'unbound' ? 'No Brain selected.' : 'Project Brain is selected.', 'Run mmx setup to choose a Brain.');
  if (report.binding.kind === 'cloud') check(report.credentialsPresent, report.credentialsPresent ? 'CLI credentials are saved; use --online to validate access.' : 'CLI credentials are missing.', 'Run mmx login, then mmx doctor --online.');
  if (report.mcp.length) checks.push({ state: 'ok', message: 'Setup-managed agents found.' });
  else checks.push({ state: 'warning', message: 'No setup-managed agents found.', next: 'Run mmx setup to configure agents, or keep using your existing connect-only integration.' });
  for (const item of report.mcp) {
    check(item.configured && item.executablePresent, `${item.agent}: MCP configuration and launcher ${item.configured && item.executablePresent ? 'are present' : 'need attention'}.`, 'Run mmx doctor --fix to review a repair plan.');
    if (!report.integrations.some(i => i.agent === item.agent)) checks.push({ state: 'error', message: `${item.agent}: managed instructions and hooks are missing.`, next: 'Run mmx doctor --fix to restore the integration.' });
  }
  for (const integration of report.integrations) {
    check(integration?.rulesPresent && integration?.hookCommandsPresent && integration?.executablePresent,
      `${integration.agent}: project instructions and hooks ${integration?.rulesPresent && integration?.hookCommandsPresent && integration?.executablePresent ? 'are present' : 'need attention'}.`,
      'Run mmx doctor --fix to restore managed instructions and hooks.');
  }
  if (report.live) check(report.live.accessible, report.live.accessible ? 'Brain access check passed.' : `Brain access failed: ${report.live.error}`, 'Check your network, login and Brain permissions; rerun mmx doctor --online.');
  if (report.mcpProbe) check(report.mcpProbe.connected, report.mcpProbe.connected ? 'MCP launch and recall check passed.' : `MCP check failed: ${report.mcpProbe.error}`, 'Run mmx doctor --fix to review the managed configuration.');
  const warnings = [...legacyWarnings(root), ...report.integrations.filter(i => i.existingBrainMdHook).map(i => `${i.agent}: an existing brain.md hook may deliver duplicate context.`)];
  for (const message of warnings) checks.push({ state: 'warning', message, next: 'Review the existing integration before migrating it with mmx setup --migrate.' });
  let repair;
  try { repair = { available: true, ...planRepair(root) }; }
  catch (error) {
    repair = { available: false, reason: error.message };
    // A setup-managed project failing preflight is unhealthy, even if its files exist.
    // Connect-only installations have no repair plan and remain supported.
    if (report.mcp.length) checks.push({ state: 'error', message: `Configuration preflight failed: ${error.message}`,
      next: 'Resolve the configuration conflict, then run mmx doctor again.' });
  }
  return { ...report, node: process.version, checks, warnings, repair, healthy: !checks.some(item => item.state === 'error') };
}

export function formatDoctor(report) {
  const icons = { ok: '✓', warning: '!', error: '✗' };
  const lines = ['MindMux doctor', ''];
  for (const item of report.checks) {
    lines.push(`${icons[item.state]} ${item.message}`);
    if (item.next) lines.push(`  ${item.next}`);
  }
  if (!report.live) lines.push('', 'Use mmx doctor --online to check live Brain access and MCP recall.');
  if (report.integrations?.some(item => item.mode === 'instructions')) lines.push('Codex uses project instructions; no native lifecycle hooks.');
  if (!report.healthy && !report.repair.available) lines.push('', `Automatic repair unavailable: ${report.repair.reason}`);
  lines.push('', 'Configuration and self-checks do not prove that an agent used recalled knowledge.');
  return lines.join('\n');
}

export function formatRepair(plan) {
  return ['Repair plan', ...plan.actions.map(action => `• ${action}`), '', 'Files that may change:', ...plan.files.map(file => `  ${file}`), '', plan.note].join('\n');
}

export async function doctor(root, flags = {}, dependencies = {}) {
  const inspect = dependencies.diagnose || diagnose;
  const report = await inspect(root, flags, dependencies);
  if (!flags.fix) return report;
  if (!report.repair.available) return { ...report, repairResult: { applied: false, reason: report.repair.reason } };
  if (report.healthy) return { ...report, repairResult: { applied: false, reason: 'No configuration issues found. No changes were made.' } };
  const interactive = Boolean(dependencies.prompts || (process.stdin.isTTY && process.stderr.isTTY));
  if (!flags.yes) {
    if (!interactive) return { ...report, repairResult: { applied: false, reason: 'Review the plan with mmx doctor --json, then use --fix --yes in a non-interactive terminal.' } };
    process.stderr.write(`Issues found:\n${report.checks.filter(item => item.state === 'error').map(item => `• ${item.message}`).join('\n')}\n\n${formatRepair(report.repair)}\n`);
    try {
      if (!await (dependencies.prompts || createSetupPrompts()).confirm('Apply this repair plan?')) return { ...report, repairResult: { applied: false, cancelled: true } };
    } catch (error) {
      if (error.name !== 'ExitPromptError') throw error;
      return { ...report, repairResult: { applied: false, cancelled: true } };
    }
  } else if (!flags.json) process.stderr.write(`${formatRepair(report.repair)}\n`);
  try {
    const result = await (dependencies.applyRepair || applyRepair)(root, report.repair, flags, dependencies);
    const verified = await inspect(root, flags, dependencies);
    return { ...verified, repairResult: { applied: true, backup: result.backup, next: 'Restart the configured agents in this project.' } };
  } catch (error) { return { ...report, healthy: false, repairResult: { applied: false, error: error.message } }; }
}
