import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { binding, preferences, readJson } from './storage.mjs';
import { credentialPath } from './cloud.mjs';
import { withBrain } from './brain.mjs';
import { inspectMcp } from './host-config.mjs';
import { inspectIntegrations } from './integrations.mjs';
import { targetKey } from './hooks.mjs';

export async function status(root, flags = {}, dependencies = {}) {
  const target = binding(root);
  const runtime = join(root, '.mindmux/cli');
  const manifest = readJson(join(runtime, 'setup.json'), {});
  const key = targetKey(root);
  const receipts = existsSync(runtime) ? readdirSync(runtime)
    .filter(name => /^last-.*\.json$/.test(name))
    .map(name => readJson(join(runtime, name), {}))
    .filter(item => item.targetKey === key && (!manifest.updatedAt || item.time >= manifest.updatedAt))
    .sort((a, b) => b.time.localeCompare(a.time)) : [];
  const report = { project: root, binding: target,
    workspace: target.kind === 'cloud' ? preferences(root).cloudBrain?.workspaceName : undefined,
    credentialsPresent: target.kind === 'cloud' ? Boolean(readJson(credentialPath(target.server), {}).tokens) : undefined,
    mcp: inspectMcp(root), integrations: inspectIntegrations(root), receipts,
    adoption: 'Model use of recalled knowledge cannot be inferred from configuration or tool calls.' };
  if (flags.online && target.kind !== 'unbound') {
    try {
      report.live = await (dependencies.withBrain || withBrain)(root, async brain => ({ accessible: true, activePages: (await brain.list()).length }));
    } catch (error) { report.live = { accessible: false, error: error.message }; }
    if (report.live.accessible && report.mcp.some(item => item.configured)) {
      try {
        const probe = dependencies.probe || (await import('./mcp-server.mjs')).probeMcp;
        report.mcpProbe = await probe(root);
      } catch (error) { report.mcpProbe = { connected: false, error: error.message }; }
    }
  }
  return report;
}

export function formatStatus(report) {
  const names = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
  const lines = ['MindMux status', '', `Brain: ${report.binding.kind === 'cloud' ? report.binding.name || report.binding.brainId : report.binding.kind === 'local' ? report.binding.directory : 'Not selected'}`];
  if (report.binding.kind === 'cloud') {
    lines.push(`Workspace: ${report.workspace || 'Not recorded (choose it with mmx switch)'}`);
    lines.push(`Login: ${report.credentialsPresent ? 'Saved credentials (not proof of a valid session)' : 'Not signed in; run mmx login'}`);
  }
  if (!report.mcp.length) lines.push('Agents: Not configured; run mmx setup');
  for (const item of report.mcp) {
    const rules = report.integrations.find(i => i.agent === item.agent);
    lines.push(`${names[item.agent] || item.agent}: ${item.configured && item.executablePresent && rules?.rulesPresent && rules?.hookCommandsPresent && rules?.executablePresent ? 'Configured' : 'Configuration needs attention; run mmx doctor'}`);
  }
  lines.push(`Connection check: ${report.live ? report.live.accessible ? 'Brain reachable' + (report.mcpProbe?.recall ? '; MCP launch and recall passed' : '') : `Failed: ${report.live.error}` : 'Not run; use mmx status --online'}`);
  if (report.mcpProbe?.connected === false) lines.push(`MCP check: Failed: ${report.mcpProbe.error}`);
  if (report.integrations.some(item => item.agent === 'codex')) lines.push('Codex hooks require project trust and review in /hooks. Configuration does not prove execution.');
  const call = report.receipts.find(item => item.event === 'tool-call' && item.status === 'success');
  const hook = report.receipts.find(item => item.status === 'emitted');
  lines.push(`MCP activity: ${call ? `${call.client} called ${call.tool} at ${call.time}` : 'No tool calls observed for the current setup'}`);
  lines.push(`Hook context: ${hook ? `Delivered to ${hook.agent} at ${hook.time}` : 'No delivery observed for the current setup'}`);
  const failure = report.receipts.find(item => ['error', 'timeout'].includes(item.status));
  if (failure) lines.push(`Recent issue: ${failure.agent || failure.client}: ${failure.error || failure.status}`);
  lines.push('', report.adoption);
  if (report.binding.kind === 'unbound') lines.push('Run mmx setup to get started.');
  return lines.join('\n');
}
