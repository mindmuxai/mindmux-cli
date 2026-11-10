import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { login, credentialPath } from '../src/cloud.mjs';
import { truncateBytes } from '../src/recall.mjs';

const bin = fileURLToPath(new URL('../bin/mmx.mjs', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mindmux test 'quoted' "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, 'project'); mkdirSync(project);
  return { dir, project, home: join(dir, 'home') };
}
async function cli(f, args, input = '', { fail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [bin, '--project', f.project, ...(['setup', 'doctor', 'remove'].includes(args[0]) ? ['--json'] : []), ...args], {
      env: { ...process.env, MINDMUX_HOME: f.home }, timeout: 15000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (fail) { if (!error) return reject(new Error('Expected command failure')); resolve({ stderr, stdout }); }
      else if (error) reject(new Error(`${args.join(' ')}: ${stderr || error.message}`));
      else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid JSON stdout: ${stdout}`)); } }
    });
    child.stdin.end(input);
  });
}
const seed = async (f, id = 'auth-choice', status = 'active') => cli(f, ['brain', 'create', '--id', id, '--title', '认证方案：使用 OAuth', '--category', 'decision', '--status', status, '--source', '用户已确认'], '认证使用 OAuth，不在仓库保存 API Key。');

test('mmx is the public command and previous absolute script paths still work', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.bin, { mmx: 'bin/mmx.mjs' });
  const run = promisify(execFile);
  const current = await run(process.execPath, [bin, '--help']);
  assert.match(current.stdout, /^mmx —/);
  assert.ok(current.stdout.includes(`(v${pkg.version})`));
  assert.equal((await run(process.execPath, [bin, '--version'])).stdout.trim(), pkg.version);
  assert.match(current.stdout, /mmx setup/);
  const legacy = await run(process.execPath, [fileURLToPath(new URL('../bin/mindmux.mjs', import.meta.url)), '--help']);
  assert.equal(legacy.stdout, current.stdout);
});

test('local lifecycle reuses brain.md, checks versions and preserves provenance', async t => {
  const f = fixture(t);
  await cli(f, ['init', '--local']);
  const page = await seed(f);
  assert.match(page.compiledTruth, /OAuth/);
  assert.match(page.raw, /用户已确认/);
  await cli(f, ['brain', 'update', page.id, '--expected-version', page.version, '--summary', '改为 PKCE'], '认证使用 OAuth PKCE。');
  const before = await cli(f, ['brain', 'read', page.id]);
  assert.match(before.raw, /改为 PKCE/);
  const conflict = await cli(f, ['brain', 'update', page.id, '--expected-version', page.version, '--summary', 'stale'], '错误覆盖', { fail: true });
  assert.match(conflict.stderr, /Version conflict/);
  assert.equal((await cli(f, ['brain', 'read', page.id])).version, before.version);
  await cli(f, ['brain', 'append', page.id, '--kind', 'evidence', '--summary', '完成验证']);
  assert.match((await cli(f, ['brain', 'read', page.id])).raw, /完成验证/);
  await cli(f, ['brain', 'archive', page.id]);
  assert.equal((await cli(f, ['brain', 'list'])).pages.length, 0);
});

test('sidecar binding and existing preference keys survive initialization', async t => {
  const f = fixture(t); mkdirSync(join(f.project, '.mindmux'));
  writeFileSync(join(f.project, '.mindmux/preferences.json'), JSON.stringify({ brainRoot: '../sidecar', other: { keep: true } }));
  await cli(f, ['init', '--local']);
  await seed(f);
  assert.ok(existsSync(join(f.dir, 'sidecar/pages/auth-choice.md')));
  assert.equal(existsSync(join(f.project, 'brain')), false);
  assert.equal(JSON.parse(readFileSync(join(f.project, '.mindmux/preferences.json'))).other.keep, true);
});

test('recall handles Chinese task wording, excludes drafts and loads roots', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']); await seed(f); await seed(f, 'unconfirmed', 'draft');
  await cli(f, ['brain', 'update-root', 'architecture', '--expected-version', 'new'], '# 架构\n使用独立认证服务。');
  const result = await cli(f, ['brain', 'recall', '帮我实现认证方案']);
  assert.ok(result.pageIds.includes('auth-choice'));
  assert.ok(!result.context.includes('unconfirmed'));
  assert.match(result.context, /独立认证服务/);
  assert.ok(Buffer.byteLength(result.context) <= 8192);
});

test('managed installs are idempotent, executable with quoted paths, and preserve foreign config', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']);
  mkdirSync(join(f.project, '.cursor'));
  const config = join(f.project, '.cursor/hooks.json');
  writeFileSync(config, JSON.stringify({ version: 1, other: true, hooks: { sessionStart: [{ command: 'echo foreign' }] } }));
  await cli(f, ['connect', '--agent', 'cursor']); await cli(f, ['connect', '--agent', 'cursor']);
  const settings = JSON.parse(readFileSync(config));
  assert.equal(settings.hooks.sessionStart.length, 2);
  const installed = settings.hooks.sessionStart[1].command;
  const result = await promisify(execFile)('/bin/sh', ['-c', `${installed} < /dev/null`], { cwd: f.project, env: { ...process.env, MINDMUX_HOME: f.home } });
  assert.ok(JSON.parse(result.stdout).additional_context);
  await cli(f, ['disconnect', '--agent', 'cursor']);
  assert.deepEqual(JSON.parse(readFileSync(config)).hooks, { sessionStart: [{ command: 'echo foreign' }] });
  assert.equal(JSON.parse(readFileSync(config)).other, true);
  // Uninstall must leave the project reinstallable, including when users extend the owned rule file.
  await cli(f, ['connect', '--agent', 'cursor']);
  const rule = join(f.project, '.cursor/rules/mindmux.mdc');
  writeFileSync(rule, `${readFileSync(rule, 'utf8')}\nUser extension must survive.\n`);
  await cli(f, ['disconnect', '--agent', 'cursor']);
  assert.match(readFileSync(rule, 'utf8'), /User extension must survive/);
  await cli(f, ['connect', '--agent', 'cursor']);
  assert.equal(JSON.parse(readFileSync(config)).hooks.sessionStart.length, 2);
  assert.match(readFileSync(rule, 'utf8'), /User extension must survive/);
});

test('malformed settings and marker blocks fail before changing rules', async t => {
  const f = fixture(t); mkdirSync(join(f.project, '.claude'));
  writeFileSync(join(f.project, 'CLAUDE.md'), 'User instructions\n');
  writeFileSync(join(f.project, '.claude/settings.json'), '{bad');
  await cli(f, ['connect', '--agent', 'claude-code'], '', { fail: true });
  assert.equal(readFileSync(join(f.project, 'CLAUDE.md'), 'utf8'), 'User instructions\n');
  writeFileSync(join(f.project, '.claude/settings.json'), '{}');
  writeFileSync(join(f.project, 'CLAUDE.md'), '<!-- BEGIN mindmux-cli -->');
  await cli(f, ['connect', '--agent', 'claude-code'], '', { fail: true });
  assert.equal(readFileSync(join(f.project, '.claude/settings.json'), 'utf8'), '{}');
});

test('Cursor prompt retrieval is delivered once at preToolUse and raw prompts are not saved', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']); await seed(f);
  const payload = { conversation_id: 'session-one', prompt: '帮我实现认证方案 SECRET_PROMPT_MARKER' };
  assert.deepEqual(await cli(f, ['hook', 'prompt', '--agent', 'cursor'], JSON.stringify(payload)), { continue: true });
  const delivered = await cli(f, ['hook', 'pre-tool', '--agent', 'cursor'], JSON.stringify(payload));
  assert.match(delivered.additional_context, /OAuth/);
  assert.deepEqual(await cli(f, ['hook', 'pre-tool', '--agent', 'cursor'], JSON.stringify(payload)), {});
  const sessions = join(f.project, '.mindmux/cli/sessions');
  for (const path of readdirSync(sessions)) assert.ok(!readFileSync(join(sessions, path), 'utf8').includes(payload.prompt));
  const doctor = await cli(f, ['doctor']);
  assert.ok(doctor.receipts.some(receipt => receipt.status === 'retrieved'));
  assert.ok(doctor.receipts.some(receipt => receipt.status === 'emitted'));
});

test('Claude prompt injection and bounded stop review use host-specific schemas', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']); await seed(f);
  const input = JSON.stringify({ session_id: 's1', prompt: '认证' });
  const result = await cli(f, ['hook', 'prompt', '--agent', 'claude-code'], input);
  assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(result.hookSpecificOutput.additionalContext, /OAuth/);
  const first = await cli(f, ['hook', 'stop', '--agent', 'claude-code'], input);
  assert.equal(first.decision, 'block');
  assert.deepEqual(await cli(f, ['hook', 'stop', '--agent', 'claude-code'], input), {});
  assert.deepEqual(await cli(f, ['hook', 'stop', '--agent', 'cursor'], JSON.stringify({ loop_count: 1 })), {});
});

test('bad preferences fail closed; cloud failures never create local writes or inject stale context', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']); await seed(f);
  const payload = JSON.stringify({ conversation_id: 's1', prompt: '认证' });
  await cli(f, ['hook', 'prompt', '--agent', 'cursor'], payload);
  writeFileSync(join(f.project, '.mindmux/preferences.json'), JSON.stringify({ cloudBrain: { enabled: true, brainId: 'cloud-id' } }));
  await cli(f, ['brain', 'create', '--id', 'should-not-exist', '--title', 'Cloud', '--category', 'decision'], 'cloud only', { fail: true });
  assert.equal(existsSync(join(f.project, 'brain/pages/should-not-exist.md')), false);
  assert.deepEqual(await cli(f, ['hook', 'prompt', '--agent', 'cursor'], payload), { continue: true });
  assert.deepEqual(await cli(f, ['hook', 'pre-tool', '--agent', 'cursor'], payload), {});
  writeFileSync(join(f.project, '.mindmux/preferences.json'), '{invalid');
  await cli(f, ['brain', 'status'], '', { fail: true });
  assert.deepEqual(await cli(f, ['hook', 'prompt', '--agent', 'cursor'], payload), { continue: true });
});

test('UTF-8 context truncation preserves valid Unicode within byte limit', () => {
  const result = truncateBytes('记忆🧠'.repeat(5000));
  assert.ok(Buffer.byteLength(result) <= 8192);
  assert.ok(!result.includes('\ufffd'));
});

test('Cloud uses real SDK transport, validates binding, preserves expectedVersion and supports tools/list', async t => {
  const f = fixture(t);
  const calls = [], sessions = new Set();
  let cloudRoot;
  let failCreate = false;
  let indexAvailable = false;
  let cloudPageVersion = 3;
  let loseWriteReadback = false;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer test-access') { res.writeHead(401).end(); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const mcp = new McpServer({ name: 'test-brain', version: '1' });
    const register = (name, inputSchema, run) => mcp.registerTool(name, { inputSchema }, async args => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: JSON.stringify(run(args)) }] };
    });
    register('resolve_brain', { brainId: z.string() }, args => ({ status: args.brainId === 'chosen' ? 'resolved' : 'unavailable', brain: { name: 'Test Cloud' } }));
    if (indexAvailable) {
      register('read_brain_index', { brainId: z.string() }, () => ({ path: 'brain/index.md', body: '# Brain Index\n- cloud-auth: OAuth summary', pages: [{ id: 'cloud-auth', title: 'OAuth auth', summary: 'OAuth summary', status: 'active' }], rootPages: [], count: 1, source: 'current-pages' }));
      register('reindex_brain', { brainId: z.string() }, () => ({ generated: true, body: '# Brain Index' }));
    }
    register('list_pages', { brainId: z.string() }, () => ({ pages: [{ id: 'cloud-auth', title: 'OAuth auth', status: 'active', version: 3, summary: 'OAuth' }] }));
    register('read_page', { brainId: z.string(), id: z.string() }, () => ({ version: cloudPageVersion, page: { compiledTruth: 'OAuth with PKCE' } }));
    register('search_pages', { brainId: z.string(), query: z.string(), maxResults: z.number().optional() }, () => ({ pages: [] }));
    register('create_project', { workspaceId: z.string(), name: z.string(), description: z.string().optional() }, () => {
      if (failCreate) throw new Error('simulated lost creation response');
      return { brainId: 'chosen', project: { id: 'created-project', name: 'Setup test' } };
    });
    mcp.registerTool('raw_failure', { inputSchema: {} }, async () => ({ isError: true, content: [{ type: 'text', text: 'upstream failure preserved' }] }));
    register('list_root_pages', { brainId: z.string() }, () => ({ rootPages: cloudRoot ? [{ slug: 'background', version: cloudRoot.version }] : [] }));
    register('read_root_page', { brainId: z.string(), slug: z.string() }, () => cloudRoot);
    register('update_root_page', { brainId: z.string(), slug: z.string(), body: z.string(), expectedVersion: z.number().int().positive().optional() }, args => {
      cloudRoot = { version: (cloudRoot?.version || 0) + 1, rootPage: { slug: args.slug, body: args.body } };
      return cloudRoot;
    });
    register('update_compiled_truth', { brainId: z.string(), id: z.string(), compiledTruth: z.string(), expectedVersion: z.number(), timelineEntry: z.object({ kind: z.string(), summary: z.string(), source: z.string() }) }, args => {
      if (!loseWriteReadback) cloudPageVersion = args.expectedVersion + 1;
      return { version: args.expectedVersion + 1 };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    sessions.add(transport);
    try { await mcp.connect(transport); await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined); }
    catch (error) { if (!res.headersSent) res.writeHead(500).end(error.message); }
    finally { await transport.close(); sessions.delete(transport); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const session of sessions) await session.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const hash = createHash('sha256').update(url).digest('hex');
  mkdirSync(join(f.home, 'auth'), { recursive: true });
  writeFileSync(join(f.home, 'auth', `${hash}.json`), JSON.stringify({ tokens: { access_token: 'test-access', token_type: 'Bearer' } }));
  await cli(f, ['brain', 'bind', '--brain-id', 'chosen', '--server', url]);
  assert.equal((await cli(f, ['brain', 'list'])).pages[0].id, 'cloud-auth');
  assert.equal((await cli(f, ['brain', 'index'])).source, 'page-list-compatibility');
  indexAvailable = true;
  const beforeIndex = calls.length;
  assert.match((await cli(f, ['brain', 'index'])).body, /OAuth summary/);
  assert.deepEqual(calls.slice(beforeIndex).map(c => c.name), ['resolve_brain', 'read_brain_index']);
  assert.equal((await cli(f, ['brain', 'reindex'])).generated, true);
  assert.equal(calls.find(c => c.name === 'reindex_brain').args.brainId, 'chosen');
  assert.equal((await cli(f, ['brain', 'read', 'cloud-auth'])).version, 3);
  assert.equal((await cli(f, ['brain', 'update-root', 'background', '--expected-version', 'new'], '# Background\nNew project')).version, 1);
  const creationCall = calls.find(call => call.name === 'update_root_page');
  assert.equal(creationCall.args.expectedVersion, undefined);
  await cli(f, ['brain', 'update-root', 'background', '--expected-version', 'new'], '# Must not replace existing', { fail: true });
  assert.equal((await cli(f, ['brain', 'read-root', 'background'])).version, 1);
  assert.equal((await cli(f, ['brain', 'update-root', 'background', '--expected-version', '1'], '# Background\nUpdated')).version, 2);
  const invalidVersion = await cli(f, ['brain', 'update-root', 'background', '--expected-version', 'nonsense'], '# Invalid', { fail: true });
  assert.match(invalidVersion.stderr, /positive integer/);
  assert.equal((await cli(f, ['brain', 'update', 'cloud-auth', '--expected-version', '3', '--summary', 'confirmed'], 'Updated')).version, 4);
  assert.equal(calls.find(call => call.name === 'update_compiled_truth').args.brainId, 'chosen');
  const reviewInput = { session_id: 'cloud-review', turn_id: 'one', prompt: '认证' };
  const reviewContext = await cli(f, ['hook', '--agent', 'codex', 'prompt'], JSON.stringify(reviewInput));
  const reviewToken = reviewContext.hookSpecificOutput.additionalContext.match(/--review-token ([a-f0-9]{64})/)[1];
  await cli(f, ['brain', 'update', 'cloud-auth', '--review-token', reviewToken, '--expected-version', '4', '--summary', 'verified Cloud write'], 'Verified');
  await cli(f, ['brain', 'update-root', 'background', '--review-token', reviewToken, '--expected-version', '2'], '# Background\nVerified root');
  await cli(f, ['brain', 'review', '--review-token', reviewToken, '--outcome', 'saved', '--reason', 'Verified Page and root versions']);
  assert.deepEqual(await cli(f, ['hook', '--agent', 'codex', 'stop'], JSON.stringify(reviewInput)), {});
  const nextInput = { ...reviewInput, turn_id: 'two' };
  const nextContext = await cli(f, ['hook', '--agent', 'codex', 'prompt'], JSON.stringify(nextInput));
  const nextToken = nextContext.hookSpecificOutput.additionalContext.match(/--review-token ([a-f0-9]{64})/)[1];
  loseWriteReadback = true;
  const lost = await cli(f, ['brain', 'update', 'cloud-auth', '--review-token', nextToken, '--expected-version', '5', '--summary', 'lost read-back'], 'Lost', { fail: true });
  assert.match(lost.stderr, /Write completed but verification failed/);
  const denied = await cli(f, ['brain', 'review', '--review-token', nextToken, '--outcome', 'saved', '--reason', 'Must fail'], '', { fail: true });
  assert.match(denied.stderr, /operation failed/);
  loseWriteReadback = false;
  assert.ok((await cli(f, ['mcp', 'tools'])).tools.some(tool => tool.name === 'read_page'));
  await cli(f, ['brain', 'bind', '--brain-id', 'wrong', '--server', url], '', { fail: true });
  assert.equal((await cli(f, ['brain', 'status'])).brainId, 'chosen');
  const installed = await cli(f, ['setup', '--agent', 'claude-code,codex', '--brain-id', 'chosen', '--server', url, '--yes']);
  assert.equal(installed.mcp.recall, true);
  const client = new Client({ name: 'bridge-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, '--project', f.project, 'mcp', 'serve'], env: { ...process.env, MINDMUX_HOME: f.home }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  await client.connect(transport); t.after(() => client.close());
  const tools = await client.listTools();
  assert.equal(tools.tools.find(tool => tool.name === 'read_page').inputSchema.properties.brainId.const, 'chosen');
  const read = await client.callTool({ name: 'read_page', arguments: { id: 'cloud-auth' } });
  assert.equal(JSON.parse(read.content[0].text).version, cloudPageVersion);
  assert.equal((await client.callTool({ name: 'read_page', arguments: { id: 'cloud-auth', brainId: 'different' } })).isError, true);
  const failure = await client.callTool({ name: 'raw_failure', arguments: {} });
  assert.equal(failure.isError, true); assert.equal(failure.content[0].text, 'upstream failure preserved');
  await client.close();
  await cli(f, ['setup', '--agent', 'codex', '--workspace-id', 'workspace', '--name', 'Setup test', '--confirm', '--yes']);
  await cli(f, ['setup', '--agent', 'codex', '--workspace-id', 'workspace', '--name', 'Setup test', '--confirm', '--yes']);
  assert.equal(calls.filter(call => call.name === 'create_project').length, 1);
  failCreate = true;
  await cli(f, ['setup', '--agent', 'codex', '--workspace-id', 'workspace', '--name', 'Lost response test', '--confirm', '--yes'], '', { fail: true });
  const uncertain = await cli(f, ['setup', '--agent', 'codex', '--workspace-id', 'workspace', '--name', 'Lost response test', '--confirm', '--yes'], '', { fail: true });
  assert.match(uncertain.stderr, /unknown outcome/);
  assert.equal(calls.filter(call => call.name === 'create_project').length, 2);
});

test('OAuth performs discovery, dynamic registration, state validation and PKCE token exchange', async t => {
  const f = fixture(t), originalHome = process.env.MINDMUX_HOME;
  process.env.MINDMUX_HOME = f.home;
  t.after(() => { if (originalHome === undefined) delete process.env.MINDMUX_HOME; else process.env.MINDMUX_HOME = originalHome; });
  let origin, challenge, registeredRedirect, exchanged = false;
  const server = createServer(async (req, res) => {
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url.startsWith('/.well-known/oauth-protected-resource')) return json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['mindmux:brain:read', 'mindmux:brain:write'] });
    if (req.url.startsWith('/.well-known/oauth-authorization-server')) return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] });
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/register') { registeredRedirect = JSON.parse(body).redirect_uris[0]; res.statusCode = 201; return json({ client_id: 'cli-test', redirect_uris: [registeredRedirect], token_endpoint_auth_method: 'none' }); }
    if (req.url === '/token') {
      const data = new URLSearchParams(body);
      assert.equal(data.get('code'), 'valid-code');
      assert.equal(data.get('redirect_uri'), registeredRedirect);
      assert.equal(createHash('sha256').update(data.get('code_verifier')).digest('base64url'), challenge);
      exchanged = true;
      return json({ access_token: 'oauth-token', token_type: 'Bearer', refresh_token: 'refresh-token', expires_in: 3600 });
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let callbackTask;
  await login(`${origin}/mcp`, { open: false, output: () => {}, onAuthorization: url => {
    challenge = url.searchParams.get('code_challenge');
    callbackTask = (async () => {
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('code', 'valid-code'); callback.searchParams.set('state', 'wrong');
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set('state', url.searchParams.get('state'));
      assert.equal((await fetch(callback)).status, 200);
    })();
  } });
  await callbackTask;
  assert.equal(exchanged, true);
  const stored = JSON.parse(readFileSync(credentialPath(`${origin}/mcp`)));
  assert.equal(stored.tokens.access_token, 'oauth-token');
  assert.equal(stored.verifier, undefined);
});

test('Codex hooks inject context, bound Stop review across continuations, and reset on the next real prompt', async t => {
  const f = fixture(t); await cli(f, ['init', '--local']); await seed(f);
  const invoke = (event, input) => cli(f, ['hook', event, '--agent', 'codex'], JSON.stringify(input));
  const input = { session_id: 'codex-session', turn_id: 'turn-one', prompt: '认证 SECRET_CODEX_PROMPT' };
  const startup = await invoke('session-start', { ...input, source: 'startup' });
  assert.equal(startup.hookSpecificOutput.hookEventName, 'SessionStart');
  const prompt = await invoke('prompt', input);
  assert.equal(prompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(prompt.hookSpecificOutput.additionalContext, /OAuth/);
  const receipt = JSON.parse(readFileSync(join(f.project, '.mindmux/cli/last-codex-prompt.json')));
  assert.equal(receipt.status, 'emitted');
  const stop = await invoke('stop', input); assert.equal(stop.decision, 'block');
  assert.deepEqual(await invoke('prompt', { ...input, prompt: stop.reason }), {});
  assert.deepEqual(await invoke('stop', { ...input, stop_hook_active: true }), {});
  assert.deepEqual(await invoke('stop', input), {});
  await invoke('session-start', { ...input, source: 'compact' });
  assert.deepEqual(await invoke('stop', input), {});
  await invoke('prompt', { ...input, turn_id: 'turn-two', prompt: '新的认证要求' });
  assert.equal((await invoke('stop', { ...input, turn_id: 'turn-two' })).decision, 'block');
  assert.deepEqual(await invoke('stop', { ...input, session_id: 'aborted', status: 'aborted' }), {});
  for (const file of readdirSync(join(f.project, '.mindmux/cli/sessions'))) assert.doesNotMatch(readFileSync(join(f.project, '.mindmux/cli/sessions', file), 'utf8'), /SECRET_CODEX_PROMPT/);
  writeFileSync(join(f.project, '.mindmux/preferences.json'), '{invalid');
  assert.deepEqual(await invoke('prompt', input), {});
});

test('writing guidance reaches installed rules, recall hooks and MCP without translating submitted content', async t => {
  const f = fixture(t);
  await cli(f, ['init', '--local']);
  await seed(f);
  await cli(f, ['connect', '--agent', 'codex']);
  const checkPolicy = text => {
    assert.match(text, /Chinese conversations produce Chinese knowledge; English conversations produce English knowledge/);
    assert.match(text, /before headings, dates, provenance or lists/);
    assert.match(text, /Do not infer the knowledge language from CLI prompts/);
  };
  checkPolicy(readFileSync(join(f.project, 'AGENTS.md'), 'utf8'));
  const hook = await cli(f, ['hook', '--agent', 'codex', 'session-start'], JSON.stringify({ session_id: 'writing-policy-check' }));
  checkPolicy(hook.hookSpecificOutput.additionalContext);
  const client = new Client({ name: 'writing-policy-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, '--project', f.project, 'mcp', 'serve'], env: { ...process.env, MINDMUX_HOME: f.home }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    checkPolicy(client.getInstructions());
    const { tools } = await client.listTools();
    checkPolicy(tools.find(tool => tool.name === 'mindmux_brain').description);
  } finally { await client.close(); }
  const english = 'Keep the API compatible. Read this Page when changing the API.\n\n## Details\nPreserve OAuth URLs and field names.';
  const saved = await cli(f, ['brain', 'create', '--id', 'english-contract', '--title', 'API contract', '--category', 'decision', '--source', 'User confirmed in English'], english);
  assert.equal(saved.compiledTruth.trim(), english);
  const index = await cli(f, ['brain', 'index']);
  assert.equal(index.pages.find(page => page.id === 'auth-choice').summary, '认证使用 OAuth，不在仓库保存 API Key。');
  assert.equal(index.pages.find(page => page.id === 'english-contract').summary, english.split('\n')[0]);
});
