// Opt-in, mutating production integration test. Never runs under npm test.
// Chinese fixture bodies exercise multilingual Cloud search and retrieval.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'workspace-id': { type: 'string' }, confirm: { type: 'boolean' }, output: { type: 'string' } } });
if (!values.confirm || !values['workspace-id']) throw new Error('Mutates a dedicated test project. Supply --workspace-id <explicit-id> --confirm [--output directory].');
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const directory = resolve(values.output || join(packageRoot, 'artifacts', `live-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`));
const projectDir = join(directory, 'project'); mkdirSync(projectDir, { recursive: true });
const bin = join(packageRoot, 'bin/mmx.mjs');
const records = [], checks = [];
const startedAt = new Date().toISOString();
let manifest;
function save() {
  writeFileSync(join(directory, 'results.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), manifest, checks, commands: records }, null, 2));
  const text = `# MindMux CLI production integration test\n\nStarted: ${startedAt}\n\nWorkspace: ${manifest?.project?.workspaceId || values['workspace-id']}\n\nProject: ${manifest?.project?.name || '(creating)'}\n\nProject ID: ${manifest?.project?.id || ''}\n\nBrain ID: ${manifest?.brainId || ''}\n\nLocal directory: ${projectDir}\n\n${checks.map(check => `- ${check.pass ? 'PASS' : 'FAIL'} ${check.name}${check.error ? `: ${check.error}` : ''}`).join('\n')}\n\nPassed ${checks.filter(check => check.pass).length}/${checks.length} checks across ${records.length} CLI commands.\n\nHook checks execute generated commands against Cloud Brain. Context adoption by an actual agent model is not tested.\n`;
  writeFileSync(join(directory, 'report.md'), text);
}
async function run(args, input = '', { fail = false, project = projectDir } = {}) {
  const start = performance.now();
  const result = await new Promise(resolve => {
    const child = execFile(process.execPath, [bin, '--project', project, ...args], { encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin.end(input);
  });
  let data; try { data = result.stdout ? JSON.parse(result.stdout) : undefined; } catch { data = result.stdout; }
  records.push({ args, elapsedMs: Math.round(performance.now() - start), exitCode: result.error ? result.error.code : 0, output: data, error: result.stderr.trim() }); save();
  if (fail) { assert.ok(result.error, `Expected rejection: ${args.join(' ')}`); return result.stderr; }
  assert.ok(!result.error, `${args.join(' ')}: ${result.stderr || result.error?.message}`);
  return data;
}
async function check(name, run) {
  try { await run(); checks.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, pass: false, error: error.message }); throw error; }
  finally { save(); }
}
const call = (tool, args) => run(['mcp', 'call', tool, '--args', JSON.stringify(args)]);

try {
  const workspaces = await run(['workspace', 'list']);
  const workspace = workspaces.workspaces.find(item => item.id === values['workspace-id']);
  assert.ok(workspace, 'Explicitly selected Workspace is not accessible.');
  const manifestPath = join(directory, 'manifest.json');
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath));
    assert.equal(manifest.project.workspaceId, values['workspace-id']);
  } else {
    manifest = await run(['project', 'create', '--workspace-id', workspace.id, '--name', `MindMux CLI Integration Test ${startedAt.slice(0, 10)}`, '--description', 'Dedicated CLI integration project for binding, lifecycle, versioning, retrieval, and hook checks.', '--confirm']);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  const brainId = manifest.brainId;
  await check('Created Project appears in the selected Workspace', async () => assert.ok((await run(['project', 'list', '--workspace-id', workspace.id])).projects.some(item => item.brainId === brainId)));
  await check('Brain discovery and explicit binding', async () => {
    assert.ok((await run(['brain', 'discover', '--workspace-id', workspace.id])).brains.some(item => item.id === brainId));
    assert.equal((await run(['brain', 'bind', '--brain-id', brainId])).brainId, brainId);
    assert.equal((await run(['brain', 'status'])).kind, 'cloud');
  });
  await check('Tool discovery and low-level resolve_brain', async () => {
    assert.ok((await run(['mcp', 'tools'])).tools.some(tool => tool.name === 'update_root_page'));
    assert.equal((await call('resolve_brain', { brainId })).status, 'resolved');
  });
  await check('Invalid binding is rejected without changing the existing binding', async () => {
    await run(['brain', 'bind', '--brain-id', '00000000-0000-0000-0000-000000000000'], '', { fail: true });
    assert.equal((await run(['brain', 'status'])).brainId, brainId);
  });
  const suffix = Date.now().toString(36);
  const id = `cli-auth-${suffix}`, draft = `cli-draft-${suffix}`, archived = `cli-archive-${suffix}`;
  const content = 'CLI 认证采用独立 OAuth PKCE。用户必须显式绑定 Cloud Brain。网络错误不得回退本地。';
  let first, current;
  await check('Create and read a Cloud decision', async () => {
    await run(['brain', 'create', '--id', id, '--title', 'CLI 认证与绑定方案', '--category', 'decision', '--source', 'CLI 生产集成测试'], content);
    first = await run(['brain', 'read', id]); assert.equal(first.page.compiledTruth, content); assert.equal(first.version, 1);
  });
  await check('Duplicate creation is rejected without changing content', async () => {
    await run(['brain', 'create', '--id', id, '--title', '错误覆盖', '--category', 'decision'], '不应覆盖', { fail: true });
    assert.equal((await run(['brain', 'read', id])).page.compiledTruth, content);
  });
  await check('Draft and archived lifecycle with active listing', async () => {
    await run(['brain', 'create', '--id', draft, '--title', 'CLI 认证未确认草稿', '--category', 'concept', '--status', 'draft'], '认证草稿，不是已经确认的事实。');
    await run(['brain', 'create', '--id', archived, '--title', 'CLI 认证待归档记录', '--category', 'reference'], '仅用于验证归档过滤。');
    await run(['brain', 'archive', archived]);
    assert.equal((await run(['brain', 'read', archived])).page.frontmatter.status, 'archived');
    const pages = (await run(['brain', 'list'])).pages;
    assert.ok(pages.some(page => page.id === id)); assert.ok(!pages.some(page => [draft, archived].includes(page.id)));
  });
  await check('Chinese search returns active pages only', async () => {
    const pages = (await run(['brain', 'search', '认证'])).pages;
    assert.ok(pages.some(page => page.id === id)); assert.ok(!pages.some(page => [draft, archived].includes(page.id)));
  });
  await check('Updates preserve timeline reasons and sources', async () => {
    await run(['brain', 'update', id, '--expected-version', String(first.version), '--summary', '确认 callback 仅监听 loopback', '--source', '生产集成测试'], `${content}\nOAuth callback 仅监听 127.0.0.1。`);
    current = await run(['brain', 'read', id]); assert.equal(current.version, 2); assert.match(current.page.timelineRaw, /确认 callback/); assert.match(current.page.timelineRaw, /生产集成测试/);
  });
  await check('Stale and invalid versions cannot overwrite content', async () => {
    await run(['brain', 'update', id, '--expected-version', '1', '--summary', 'stale'], '不应覆盖', { fail: true });
    await run(['brain', 'update', id, '--expected-version', 'NaN', '--summary', 'invalid'], '不应覆盖', { fail: true });
    assert.equal((await run(['brain', 'read', id])).page.compiledTruth, current.page.compiledTruth);
  });
  await check('Appending evidence preserves content and history', async () => {
    await run(['brain', 'append', id, '--kind', 'evidence', '--summary', 'CLI 真实云端读写验证完成', '--source', 'verify-live.mjs']);
    const page = await run(['brain', 'read', id]); assert.equal(page.page.compiledTruth, current.page.compiledTruth); assert.match(page.page.timelineRaw, /CLI 真实云端读写验证完成/); assert.match(page.page.timelineRaw, /确认 callback/);
  });
  await check('Low-level MCP updates tags, title, and category', async () => {
    await call('set_page_tags', { brainId, id, tags: ['cli', 'integration'] });
    let page = await run(['brain', 'read', id]); assert.deepEqual(page.page.frontmatter.tags, ['cli', 'integration']);
    await call('update_page_title', { brainId, id, title: 'CLI 认证与绑定策略（已验证）', expectedVersion: page.version });
    page = await run(['brain', 'read', id]); assert.match(page.page.frontmatter.title, /已验证/);
    await call('set_page_category', { brainId, id: draft, category: 'reference', expectedVersion: (await run(['brain', 'read', draft])).version });
    assert.equal((await run(['brain', 'read', draft])).page.frontmatter.category, 'reference');
  });
  await check('Low-level MCP status transitions', async () => {
    await call('set_page_status', { brainId, id: draft, status: 'active' });
    assert.equal((await run(['brain', 'read', draft])).page.frontmatter.status, 'active');
    await call('set_page_status', { brainId, id: draft, status: 'draft' });
  });
  await check('Cloud root creation, reads, updates, and version checks', async () => {
    const roots = (await run(['brain', 'roots'])).rootPages;
    const slug = roots.some(root => root.slug === 'background') ? 'architecture' : 'background';
    const existing = roots.find(root => root.slug === slug);
    await run(['brain', 'update-root', slug, '--expected-version', existing ? String(existing.version) : 'new'], '# CLI 集成测试架构\n真实 MCP 验证 marker: cloud-root-test');
    const root = await run(['brain', 'read-root', slug]);
    assert.match(root.rootPage.body, /cloud-root-test/);
    await run(['brain', 'update-root', slug, '--expected-version', 'new'], '# 不应覆盖', { fail: true });
    await run(['brain', 'update-root', slug, '--expected-version', String(root.version)], '# CLI 集成测试架构\n真实云端 root 创建和更新均已验证。');
    await run(['brain', 'update-root', slug, '--expected-version', String(root.version)], '# stale root', { fail: true });
    assert.match((await run(['brain', 'read-root', slug])).rootPage.body, /均已验证/);
  });
  await check('Cloud recall includes content and roots while excluding drafts and archives', async () => {
    const result = await run(['brain', 'recall', 'CLI 认证和绑定方案']);
    assert.ok(result.context.includes('OAuth')); assert.ok(result.rootSlugs.length); assert.ok(!result.context.includes(draft)); assert.ok(!result.context.includes(archived)); assert.ok(Buffer.byteLength(result.context) <= 8192);
  });
  for (const agent of ['cursor', 'claude-code', 'codex']) {
    await check(`${agent} install, repeat install, remove, and reinstall`, async () => {
      await run(['connect', '--agent', agent]); await run(['connect', '--agent', agent]);
      const report = await run(['doctor', '--json']); const integration = report.integrations.find(item => item.agent === agent);
      assert.ok(integration.rulesPresent && integration.hookCommandsPresent && integration.executablePresent);
      await run(['disconnect', '--agent', agent]); assert.ok(!(await run(['doctor', '--json'])).integrations.some(item => item.agent === agent));
      await run(['connect', '--agent', agent]);
    });
  }
  // Execute the exact shell command installed into the host, not only a direct handler call.
  async function installedHook(agent, event, input) {
    const path = agent === 'cursor' ? '.cursor/hooks.json' : '.claude/settings.json';
    const config = JSON.parse(readFileSync(join(projectDir, path)));
    const entry = config.hooks[event][0]; const command = entry.command || entry.hooks[0].command;
    const start = performance.now();
    const result = await new Promise(resolve => { const child = execFile('/bin/sh', ['-c', command], { cwd: projectDir, encoding: 'utf8', timeout: 12000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })); child.stdin.end(JSON.stringify(input)); });
    records.push({ installedHook: `${agent}/${event}`, elapsedMs: Math.round(performance.now() - start), error: result.stderr, output: result.stdout }); save();
    assert.ok(!result.error, result.stderr); return JSON.parse(result.stdout);
  }
  await check('Installed Cursor commands: startup, prompt, preToolUse, and one stop review', async () => {
    const input = { conversation_id: `live-${suffix}`, prompt: '请实现 CLI 认证和绑定方案' };
    assert.ok((await installedHook('cursor', 'sessionStart', input)).additional_context.includes(brainId));
    assert.equal((await installedHook('cursor', 'beforeSubmitPrompt', input)).continue, true);
    assert.ok((await installedHook('cursor', 'preToolUse', input)).additional_context.includes('OAuth'));
    assert.deepEqual(await installedHook('cursor', 'preToolUse', input), {});
    assert.ok((await installedHook('cursor', 'stop', input)).followup_message);
    assert.deepEqual(await installedHook('cursor', 'stop', { ...input, loop_count: 1 }), {});
  });
  await check('Installed Claude commands: startup, prompt, and one Stop review', async () => {
    const input = { session_id: `live-${suffix}`, prompt: '请实现 CLI 认证和绑定方案' };
    assert.equal((await installedHook('claude-code', 'SessionStart', input)).hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok((await installedHook('claude-code', 'UserPromptSubmit', input)).hookSpecificOutput.additionalContext.includes('OAuth'));
    assert.equal((await installedHook('claude-code', 'Stop', input)).decision, 'block');
    assert.deepEqual(await installedHook('claude-code', 'Stop', { ...input, stop_hook_active: true }), {});
  });
  await check('Online doctor records retrieval and delivery without a shadow local Brain', async () => {
    const result = await run(['doctor', '--online', '--json']); assert.equal(result.live.accessible, true);
    assert.ok(result.receipts.some(item => item.status === 'retrieved')); assert.ok(result.receipts.some(item => item.status === 'emitted'));
    assert.ok(!result.receipts.some(item => ['error', 'timeout'].includes(item.status)));
    assert.ok(!existsSync(join(projectDir, 'brain')));
  });
  await check('Delete the dedicated disposable page and verify absence', async () => {
    const disposable = `cli-disposable-${suffix}`;
    await run(['brain', 'create', '--id', disposable, '--title', '可删除的临时测试页面', '--category', 'reference'], '仅用于验证删除操作。');
    await call('delete_page', { brainId, id: disposable });
    await run(['brain', 'read', disposable], '', { fail: true });
  });
  await check('Write test results to the dedicated Brain and read them back', async () => {
    const summary = `Passed ${checks.length} production CLI integration checks covering binding, lifecycle, multilingual retrieval, version conflicts, archives, roots, low-level MCP, installed hooks, and diagnostics. Context adoption by an actual agent model is not tested.`;
    await run(['brain', 'create', '--id', `cli-test-results-${suffix}`, '--title', 'CLI production integration results', '--category', 'reference', '--source', 'scripts/verify-live.mjs'], summary);
    assert.equal((await run(['brain', 'read', `cli-test-results-${suffix}`])).page.compiledTruth, summary);
  });
  console.log(`Completed ${checks.length} checks. Report: ${join(directory, 'report.md')}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { save(); }
