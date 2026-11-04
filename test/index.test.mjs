import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recall } from '../src/recall.mjs';
import { runBrainTool } from '../src/mcp-server.mjs';
import { renderIndex } from '../src/brain-index.mjs';
const exec = promisify(execFile);
const bin = new URL('../bin/mmx.mjs', import.meta.url).pathname;

test('local index includes summaries and roots; reindex regenerates the real brain.md index', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mmx-index-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { env: { ...process.env, MINDMUX_HOME: join(root, 'home') } };
  const cli = async (...args) => JSON.parse((await exec(process.execPath, [bin, '--project', root, ...args], options)).stdout);
  await cli('init', '--local');
  const child = execFile(process.execPath, [bin, '--project', root, 'brain', 'create', '--id', 'auth', '--title', 'Authentication', '--category', 'decision'], options);
  child.stdin.end('Use OAuth with PKCE.');
  await new Promise((resolve, reject) => child.on('exit', code => code ? reject(new Error('create failed')) : resolve()));
  const rootWrite = execFile(process.execPath, [bin, '--project', root, 'brain', 'update-root', 'background', '--expected-version', 'new'], options);
  rootWrite.stdin.end('# Product background\nA durable project overview.');
  await new Promise((resolve, reject) => rootWrite.on('exit', code => code ? reject(new Error('root creation failed')) : resolve()));
  const index = await cli('brain', 'index');
  assert.match(index.body, /Product background/);
  assert.equal(index.rootPages[0].slug, 'background');
  assert.match(index.body, /Use OAuth with PKCE/);
  assert.equal(index.pages[0].summary, 'Use OAuth with PKCE.');
  writeFileSync(join(root, 'brain/index.md'), 'stale index');
  const rebuilt = await cli('brain', 'reindex');
  assert.equal(rebuilt.generated, true);
  const storedBody = readFileSync(join(root, 'brain/index.md'), 'utf8');
  assert.equal(rebuilt.storedIndexPresent, true);
  assert.equal(rebuilt.storedBody, undefined);
  const before = await cli('brain', 'read', 'auth');
  const update = execFile(process.execPath, [bin, '--project', root, 'brain', 'update', 'auth', '--expected-version', before.version, '--summary', 'Confirmed change'], options);
  update.stdin.end('Use passkeys instead of passwords.');
  await new Promise((resolve, reject) => update.on('exit', code => code ? reject(new Error('update failed')) : resolve()));
  assert.match((await cli('brain', 'index')).body, /Use passkeys/);
  assert.match(storedBody, /Use OAuth with PKCE/);
  assert.doesNotMatch(storedBody, /stale index/);
  assert.equal((await cli('brain', 'list')).pages[0].summary, 'Use passkeys instead of passwords.');
  const bodyOnly = execFile(process.execPath, [bin, '--project', root, 'brain', 'update', 'auth', '--expected-version', (await cli('brain', 'read', 'auth')).version, '--summary', 'Add rotation details'], options);
  bodyOnly.stdin.end('Use passkeys instead of passwords.\n\nRotate uniquequartz credentials.');
  await new Promise((resolve, reject) => bodyOnly.on('exit', code => code ? reject(new Error('update failed')) : resolve()));
  assert.deepEqual((await cli('brain', 'recall', 'uniquequartz')).pageIds, ['auth']);
  assert.equal((await runBrainTool(root, { operation: 'index' })).pages[0].id, 'auth');
  assert.equal((await runBrainTool(root, { operation: 'reindex' })).generated, true);
});

test('recall reads index first and preserves full-text hits missing keywords in summaries', async () => {
  const calls = [];
  const pages = [{ id: 'auth', title: 'Authentication', category: 'decision', status: 'active', summary: 'Uses OAuth.' }];
  const rootPages = [{ slug: 'flow', title: 'Sign-in flow' }];
  const brain = { target: { kind: 'cloud', brainId: 'bound' },
    index: async () => { calls.push('index'); return { pages, rootPages, body: renderIndex(pages, rootPages), source: 'current-pages' }; },
    list: async () => { throw new Error('Do not list again'); },
    search: async () => { calls.push('search'); return pages; },
    read: async id => { calls.push('read'); return { version: 2, page: { compiledTruth: 'Token rotation every hour.' } }; },
    readRoot: async () => { throw new Error('Flow is navigation, not an automatic root body'); },
  };
  const result = await recall(brain, 'rotation');
  assert.equal(calls[0], 'index');
  assert.deepEqual(result.pageIds, ['auth']);
  assert.match(result.context, /Uses OAuth/);
  assert.match(result.context, /Sign-in flow/);
  assert.match(result.context, /Token rotation/);
});

test('no keyword match still delivers page summaries and more than twenty index entries', async () => {
  const pages = Array.from({ length: 25 }, (_, n) => ({ id: `page-${n}`, title: `Topic ${n}`, summary: `Useful knowledge ${n}`, category: 'reference', status: 'active' }));
  const brain = { target: { kind: 'local', directory: '/fixture' }, index: async () => ({ pages, rootPages: [], body: renderIndex(pages) }), read: async () => { throw new Error('No match'); } };
  const result = await recall(brain, 'hello');
  assert.deepEqual(result.pageIds, []);
  assert.match(result.context, /Useful knowledge 0/);
  // Rows include freshness metadata, so this preview may be truncated.
  assert.match(result.context, /version: /);
  const large = await recall({ ...brain, index: async () => ({ pages: [...pages, ...pages, ...pages], rootPages: [], body: renderIndex([...pages, ...pages, ...pages]) }) }, 'hello');
  assert.match(large.context, /Index preview truncated/);
  assert.match(large.context, /brain index/);
  assert.ok(Buffer.byteLength(large.context) <= 8192);
  assert.ok(Buffer.byteLength(result.context) <= 8192);
});


test('recall excludes archived, draft and absent pages returned by search', async () => {
  const pages = [{ id: 'current', title: 'Current', status: 'active', summary: 'Current fact' }];
  const readIds = [];
  const brain = { target: { kind: 'cloud', brainId: 'fixture' },
    index: async () => ({ pages, rootPages: [], body: renderIndex(pages) }),
    search: async () => [{ id: 'old', status: 'archived' }, { id: 'draft', status: 'draft' }, { id: 'missing' }, ...pages],
    read: async id => { readIds.push(id); return { version: 1, page: { compiledTruth: 'Current fact' } }; },
  };
  assert.deepEqual((await recall(brain, 'rotation')).pageIds, ['current']);
  assert.deepEqual(readIds, ['current']);
});
