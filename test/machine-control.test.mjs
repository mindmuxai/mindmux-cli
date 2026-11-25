import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BRAIN_OPERATIONS, brainInputSchema, jsonRequested } from '../src/command-schema.mjs';
import { CliError, errorResult } from '../src/errors.mjs';

const bin = fileURLToPath(new URL('../bin/mmx.mjs', import.meta.url));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mmx-machine-control-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'project'); mkdirSync(root);
  return { dir, root, env: { ...process.env, MINDMUX_HOME: join(dir, 'home'), CODEX_HOME: join(dir, 'codex'), MINDMUX_NO_UPDATE_CHECK: '1' } };
}
function run(f, args, input = '') {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [bin, '--project', f.root, ...args], { env: f.env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      let value; try { value = JSON.parse(stdout); } catch {}
      resolve({ code: error?.code || 0, stdout, stderr, value });
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error; });
    child.stdin.end(input);
  });
}
async function ok(f, args, input = '') {
  const result = await run(f, args, input);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.value;
}
const hook = (f, agent, event, extra = {}) => ok(f, ['hook', event, '--agent', agent], JSON.stringify({ cwd: f.root, session_id: 'test', conversation_id: 'test', turn_id: 'one', prompt: 'knowledge', ...extra }));
const create = (f, id = 'rule', extra = []) => ok(f, ['brain', 'create', '--id', id, '--title', 'Rule', '--category', 'decision', ...extra], 'A confirmed rule. Read when deciding behavior.');
async function mcp(f, t) {
  const client = new Client({ name: 'machine-control-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, '--project', f.root, 'mcp', 'serve'], env: f.env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
  t.after(() => client.close());
  return { client, call: async args => {
    const result = await client.callTool({ name: 'mindmux_brain', arguments: args });
    return { isError: result.isError, value: JSON.parse(result.content[0].text) };
  } };
}

test('schema discovery is offline, independent of project/login, and excludes user-only controls', async t => {
  const f = fixture(t); f.root = join(f.dir, 'missing');
  const catalog = await ok(f, ['schema']);
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(catalog.commands.some(item => item.command === 'setup'));
  assert.ok(!catalog.commands.some(item => /pause|resume/.test(item.command)));
  for (const operation of Object.keys(BRAIN_OPERATIONS)) {
    const result = await ok(f, ['schema', 'brain', operation]);
    assert.deepEqual(result.inputSchema, brainInputSchema(operation));
  }
  const update = await ok(f, ['schema', 'brain', 'update']);
  assert.equal(update.cli.flags['expected-version'], 'expectedVersion');
  assert.equal(update.cli.stdin.required, true);
  assert.ok(update.inputSchema.allOf.length);
  assert.equal(existsSync(f.env.MINDMUX_HOME), false);
  assert.equal(existsSync(f.root), false);
  const skill = (await run(f, ['--skill'])).stdout;
  assert.doesNotMatch(skill, /mmx (pause|resume)/);
  assert.equal((await run(f, ['schema', 'pause', '--json'])).value.code, 'INVALID_ARGUMENT');
});

test('JSON errors cover parser, missing project, invalid command, and stdin without stderr contamination', async t => {
  const f = fixture(t);
  for (const args of [['--json', '--unknown'], ['--json', '--agent'], ['--json', 'no-such-command'], ['schema', 'constructor'], ['schema', 'brain', '__proto__'], ['brain', 'toString', '--json'], ['schema', 'no-such-command'], ['--json', 'brain', 'read']]) {
    const result = await run(f, args);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, '');
    assert.equal(result.value.status, 'error');
    assert.equal(result.value.code, 'INVALID_ARGUMENT');
    assert.equal(result.value.outcome, 'not-started');
    assert.equal(result.value.retryable, false);
    assert.ok(result.value.next);
  }
  const unavailable = await run(f, ['--project', join(f.dir, 'missing'), '--json', 'status']);
  assert.equal(unavailable.value.code, 'PROJECT_UNAVAILABLE');
  const body = await run(f, ['brain', 'create', '--id', 'rule', '--title', 'Rule', '--category', 'decision', '--json']);
  assert.equal(body.value.code, 'INVALID_ARGUMENT');
  const large = await run(f, ['brain', 'create', '--id', 'rule', '--title', 'Rule', '--category', 'decision', '--json'], '文'.repeat(400000));
  assert.equal(large.value.code, 'INVALID_ARGUMENT');
});

test('output flag detection ignores values and the -- delimiter; plain errors remain readable', async t => {
  const f = fixture(t);
  assert.equal(jsonRequested(['--title', '--json', 'bad']), false);
  assert.equal(jsonRequested(['--', '--json']), false);
  assert.equal(jsonRequested(['--title=--json', '--non-interactive']), true);
  assert.equal(jsonRequested(['--agent', '-agent']), false);
  for (const args of [['--name', '--json', 'bad'], ['bad', '--', '--json']]) {
    const result = await run(f, args);
    assert.equal(result.stdout, ''); assert.match(result.stderr, /mmx:/);
  }
  const unknown = errorResult(new Error('Transport lost'));
  assert.equal(unknown.retryable, false); assert.equal(unknown.outcome, 'unknown');
  assert.equal(errorResult(new CliError('AUTH_REQUIRED', 'Sign in')).code, 'AUTH_REQUIRED');
  const upstream = new CliError('UPSTREAM_ERROR', 'Denied', { outcome: 'unknown' });
  upstream.upstreamCode = 'ACCESS_DENIED';
  assert.equal(errorResult(new CliError('UPSTREAM_ERROR', 'Write failed', { cause: upstream, outcome: 'unknown' })).upstreamCode, 'ACCESS_DENIED');
});

test('invalid Brain inputs fail before Cloud authentication and preserve update conditions', async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, '.mindmux'));
  writeFileSync(join(f.root, '.mindmux/preferences.json'), JSON.stringify({ cloudBrain: { enabled: true, brainId: 'test' } }));
  for (const args of [
    ['brain', 'update', 'rule', '--expected-version', '1'],
    ['brain', 'update', 'rule', '--expected-version', '1', '--change-kind', 'correction', '--summary', 'invalid'],
    ['brain', 'create', '--id', 'Invalid', '--title', 'Rule', '--category', 'decision'],
    ['brain', 'archive', 'rule', '--title', 'unused'],
  ]) assert.equal((await run(f, [...args, '--json'], 'body')).value.code, 'INVALID_ARGUMENT');
  assert.equal((await run(f, ['brain', 'index', '--json'])).value.code, 'AUTH_REQUIRED');
});

test('version conflicts stay structured across the CLI and MCP facade', async t => {
  const f = fixture(t); await ok(f, ['init', '--local']);
  const page = await create(f);
  const args = ['brain', 'update', page.id, '--expected-version', 'stale', '--summary', 'Change', '--json'];
  const direct = await run(f, args, 'New content');
  assert.equal(direct.value.code, 'VERSION_CONFLICT');
  assert.equal(direct.value.retryable, false);
  const { call } = await mcp(f, t);
  const invalid = await call({ operation: 'status', query: 'ignored?' });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.value.code, 'INVALID_ARGUMENT');
  const leadingDash = await call({ operation: 'search', query: '--json' });
  assert.deepEqual(leadingDash.value.pages, []);
  const result = await call({ operation: 'update', id: page.id, expectedVersion: 'stale', summary: 'Change', body: 'New content' });
  assert.equal(result.isError, true);
  assert.equal(result.value.code, 'VERSION_CONFLICT');
  assert.equal((await ok(f, ['brain', 'read', page.id])).version, page.version);
});

test('pause suppresses every host event, clears pending contexts, and resume does not replay them', async t => {
  const f = fixture(t); await ok(f, ['init', '--local']); await create(f);
  await hook(f, 'cursor', 'prompt');
  const context = (await hook(f, 'codex', 'prompt')).hookSpecificOutput.additionalContext;
  const oldToken = context.match(/--review-token ([a-f0-9]{64})/)[1];
  assert.equal((await hook(f, 'codex', 'stop')).decision, 'block');
  const paused = await run(f, ['pause']);
  assert.equal(paused.code, 0); assert.match(paused.stdout, /mmx resume/);
  assert.equal(existsSync(join(f.root, '.mindmux/cli/sessions')), false);
  for (const agent of ['codex', 'claude-code', 'cursor']) {
    for (const event of ['session-start', 'prompt', 'pre-tool', 'stop', 'interrupt']) assert.deepEqual(await hook(f, agent, event), {});
  }
  assert.equal((await ok(f, ['status', '--json'])).automation.paused, true);
  assert.match((await run(f, ['status'])).stdout, /Automatic memory: Paused/);
  assert.equal((await ok(f, ['brain', 'status'])).automation.paused, true);
  const denied = await run(f, ['resume', '-agent']);
  assert.equal(denied.code, 1);
  assert.equal((await ok(f, ['brain', 'status'])).automation.paused, true);
  await ok(f, ['resume']);
  assert.deepEqual(await hook(f, 'cursor', 'pre-tool'), {});
  assert.deepEqual(await hook(f, 'codex', 'stop'), {});
  const stale = await run(f, ['brain', 'create', '--id', 'stale', '--title', 'Stale', '--category', 'decision', '--review-token', oldToken, '--json'], 'Do not save');
  assert.equal(stale.code, 1); assert.match(stale.value.error, /stale|expired|closed/);
  assert.equal(existsSync(join(f.root, 'brain/pages/stale.md')), false);
  const fresh = (await hook(f, 'codex', 'prompt')).hookSpecificOutput.additionalContext;
  assert.notEqual(fresh.match(/--review-token ([a-f0-9]{64})/)[1], oldToken);
  assert.equal((await hook(f, 'claude-code', 'prompt')).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

for (const agent of ['claude-code', 'cursor']) {
  test(`${agent} Stop requires a new prompt after resume and runs once per active turn`, async t => {
    const f = fixture(t); await ok(f, ['init', '--local']);
    assert.deepEqual(await hook(f, agent, 'stop'), {});
    await hook(f, agent, 'session-start');
    assert.deepEqual(await hook(f, agent, 'stop'), {});
    await hook(f, agent, 'prompt');
    const session = join(f.root, '.mindmux/cli/sessions', `${agent}-${createHash('sha256').update('test').digest('hex')}.json`);
    const stale = readFileSync(session, 'utf8');
    await ok(f, ['pause']);
    assert.deepEqual(await hook(f, agent, 'prompt'), {});
    await ok(f, ['resume']);
    assert.deepEqual(await hook(f, agent, 'stop'), {});
    // Even an old in-flight recall writing its cache back cannot reactivate Stop.
    mkdirSync(join(session, '..'), { recursive: true });
    writeFileSync(session, stale);
    assert.deepEqual(await hook(f, agent, 'stop'), {});
    await hook(f, agent, 'session-start', { source: 'compact' });
    assert.deepEqual(await hook(f, agent, 'stop'), {});
    const expectReview = result => agent === 'claude-code'
      ? assert.equal(result.decision, 'block') : assert.match(result.followup_message, /MindMux memory check/);
    await hook(f, agent, 'prompt', { turn_id: 'new-turn' });
    // Session restoration retains an active check but never rearms a completed one.
    await hook(f, agent, 'session-start', { source: 'compact' });
    expectReview(await hook(f, agent, 'stop'));
    assert.deepEqual(await hook(f, agent, 'stop'), {});
    await hook(f, agent, 'session-start', { source: 'compact' });
    assert.deepEqual(await hook(f, agent, 'stop'), {});
    await hook(f, agent, 'prompt', { turn_id: 'next-turn' });
    expectReview(await hook(f, agent, 'stop'));
    assert.deepEqual(await hook(f, agent, 'stop'), {});
  });
}

test('pause preserves manual Brain operations and takes effect in an already-running MCP server', async t => {
  const f = fixture(t); await ok(f, ['init', '--local']);
  const { client, call } = await mcp(f, t);
  await ok(f, ['pause']);
  assert.equal((await call({ operation: 'status' })).value.automation.paused, true);
  await create(f);
  const created = await call({ operation: 'create', id: 'manual', title: 'Manual', category: 'decision', body: 'An explicit test write.' });
  assert.equal(created.isError, undefined);
  assert.equal((await call({ operation: 'read', id: 'manual' })).value.compiledTruth.trim(), 'An explicit test write.');
  const { tools } = await client.listTools();
  assert.ok(!JSON.stringify(tools).includes('mmx pause'));
  assert.ok(!JSON.stringify(tools).includes('mmx resume'));
  assert.deepEqual(tools[0].inputSchema.oneOf.find(branch => branch.properties.operation.const === 'update').properties.body, brainInputSchema('update').properties.body);
  await ok(f, ['resume']);
  assert.equal((await call({ operation: 'status' })).value.automation.paused, false);
  const other = { ...f, root: join(f.dir, 'another-worktree') }; mkdirSync(other.root);
  assert.equal((await ok(other, ['brain', 'status'])).automation.paused, false);
  assert.equal(existsSync(join(f.root, 'AGENTS.md')), false);
  assert.equal(existsSync(join(f.root, 'CLAUDE.md')), false);
});

test('setup and refresh preserve pause; clean resets it; corrupt state suppresses Hook fallback guidance', async t => {
  const f = fixture(t);
  await ok(f, ['setup', '--local', '--agent', 'codex', '--yes', '--json']);
  await ok(f, ['pause']);
  await ok(f, ['setup', '--local', '--agent', 'codex', '--yes', '--json']);
  await ok(f, ['update', '--refresh-integrations', '--json']);
  assert.equal((await ok(f, ['status', '--json'])).automation.paused, true);
  writeFileSync(join(f.root, '.mindmux/cli/automation.json'), '{bad');
  assert.deepEqual(await hook(f, 'codex', 'prompt'), {});
  assert.deepEqual(await hook(f, 'claude-code', 'session-start'), {});
  await ok(f, ['resume']);
  await ok(f, ['clean', '--yes', '--keep-login', '--json']);
  assert.equal((await ok(f, ['brain', 'status'])).automation.paused, false);
});

test('manual controls refuse linked configuration before changing another project or gitignore', async t => {
  const f = fixture(t);
  const outside = join(f.dir, 'outside'); mkdirSync(outside);
  mkdirSync(join(f.root, '.mindmux'));
  symlinkSync(outside, join(f.root, '.mindmux/cli'));
  const result = await run(f, ['pause', '--json']);
  assert.equal(result.code, 1);
  assert.match(result.value.error, /symlink/);
  assert.equal(existsSync(join(outside, 'automation.json')), false);
  assert.equal(existsSync(join(f.root, '.gitignore')), false);
});

async function cloudFixture(f, t, handler) {
  const tools = ['resolve_brain', 'read_brain_index', 'list_pages', 'list_root_pages', 'search_pages', 'fail_structured'];
  const server = createServer(async (req, res) => {
    const mcp = new Server({ name: 'machine-fixture', version: '1' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools.map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) }));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      const custom = await handler?.(request.params.name);
      if (custom) return custom;
      const result = { resolve_brain: { status: 'resolved', brain: { name: 'Test' } }, read_brain_index: { body: '# Brain Index', pages: [], rootPages: [], count: 0 }, list_pages: { pages: [] }, list_root_pages: { rootPages: [] }, search_pages: { pages: [] } }[request.params.name] || {};
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    let body = ''; for await (const chunk of req) body += chunk;
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  mkdirSync(join(f.root, '.mindmux'), { recursive: true });
  writeFileSync(join(f.root, '.mindmux/preferences.json'), JSON.stringify({ cloudBrain: { enabled: true, brainId: 'test' }, mindmuxCli: { server: url } }));
  const auth = join(f.env.MINDMUX_HOME, 'auth'); mkdirSync(auth, { recursive: true });
  writeFileSync(join(auth, createHash('sha256').update(url).digest('hex') + '.json'), JSON.stringify({ tokens: { access_token: 'test-only', token_type: 'Bearer' } }));
}

test('pause/resume during Cloud recall suppresses late output and invalidates the in-flight review', async t => {
  const f = fixture(t);
  let signal, release;
  const started = new Promise(resolve => { signal = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await cloudFixture(f, t, async name => { if (name === 'read_brain_index') { signal(); await gate; } });
  t.after(() => release());
  const pending = hook(f, 'codex', 'prompt');
  await started;
  await ok(f, ['pause']);
  await ok(f, ['resume']);
  release();
  assert.deepEqual(await pending, {});
  assert.deepEqual(await hook(f, 'codex', 'stop'), {});
});

test('structured upstream errors retain their code without declaring mutations safe to retry', async t => {
  const f = fixture(t);
  await cloudFixture(f, t, name => name === 'fail_structured' ? { isError: true, structuredContent: { code: 'ACCESS_DENIED', error: 'Access denied' }, content: [{ type: 'text', text: 'Access denied' }] } : undefined);
  const result = await run(f, ['mcp', 'call', 'fail_structured', '--json']);
  assert.equal(result.code, 1);
  assert.equal(result.value.code, 'UPSTREAM_ERROR');
  assert.equal(result.value.upstreamCode, 'ACCESS_DENIED');
  assert.equal(result.value.outcome, 'unknown');
  assert.equal(result.value.retryable, false);
});
