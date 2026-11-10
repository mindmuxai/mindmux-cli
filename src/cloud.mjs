import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { homeDir, readJson, writeJson, serverUrl } from './storage.mjs';

export const credentialPath = server => join(homeDir(), 'auth', `${createHash('sha256').update(server).digest('hex')}.json`);
export const timedFetch = (url, options = {}) => fetch(url, { ...options,
  signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000) });

const activeLocks = new Set();
function releaseOnSignal(signal) {
  for (const path of activeLocks) rmSync(path, { recursive: true, force: true });
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
const onInterrupt = () => releaseOnSignal('SIGINT');
const onTerminate = () => releaseOnSignal('SIGTERM');

// Serialize token refresh across overlapping hooks and CLI calls. Never replay a write.
export async function withAuthLock(server, run) {
  const path = `${credentialPath(server)}.lock`;
  mkdirSync(join(homeDir(), 'auth'), { recursive: true, mode: 0o700 });
  const end = Date.now() + 15000;
  for (;;) {
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > end) throw new Error(`Authentication is busy. If a previous process crashed, remove ${path}.`);
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }
  if (!activeLocks.size) { process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate); }
  activeLocks.add(path);
  const cleanup = () => rmSync(path, { recursive: true, force: true });
  process.once('exit', cleanup);
  try { return await run(); } finally {
    process.removeListener('exit', cleanup);
    await rm(path, { recursive: true, force: true });
    activeLocks.delete(path);
    if (!activeLocks.size) { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); }
  }
}

export class AuthProvider {
  constructor(server, { interactive = false, redirectUrl, onRedirect } = {}) {
    this.path = credentialPath(server);
    this.data = readJson(this.path, {});
    this.interactive = interactive;
    this.callback = redirectUrl || this.data.redirectUrl;
    this.onRedirect = onRedirect;
    this.oauthState = randomBytes(32).toString('hex');
  }
  get redirectUrl() { return this.callback; }
  get clientMetadata() { return { client_name: 'MindMux CLI', redirect_uris: [this.callback],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    token_endpoint_auth_method: 'none', scope: 'mindmux:brain:read mindmux:brain:write' }; }
  state() { return this.oauthState; }
  clientInformation() { return this.data.client; }
  saveClientInformation(client) { this.data.client = client; this.save(); }
  tokens() { return this.data.tokens; }
  saveTokens(tokens) { this.data.tokens = tokens; this.save(); }
  saveCodeVerifier(verifier) {
    if (!this.interactive) throw new Error('Cloud login required. Run mmx login.');
    this.verifier = verifier;
  }
  codeVerifier() { if (!this.verifier) throw new Error('Missing OAuth verifier. Run mmx login again.'); return this.verifier; }
  redirectToAuthorization(url) {
    if (!this.interactive) throw new Error('Cloud login required. Run mmx login.');
    this.onRedirect(url);
  }
  invalidateCredentials(scope) {
    if (scope === 'all') this.data = {};
    if (scope === 'tokens') delete this.data.tokens;
    if (scope === 'client') delete this.data.client;
    if (scope === 'verifier') this.verifier = undefined;
    this.save();
  }
  save() { if (!this.staging) writeJson(this.path, { ...this.data, redirectUrl: this.callback }); }
}

export async function withCloud(server, run) {
  server = serverUrl(server);
  return withAuthLock(server, async () => {
    const provider = new AuthProvider(server);
    if (!provider.tokens()) throw new Error(`Cloud login required. Run mmx login --server ${server}.`);
    const client = new Client({ name: 'mindmux-cli', version: '0.1.1' });
    const transport = new StreamableHTTPClientTransport(new URL(server), { authProvider: provider,
      fetch: timedFetch, reconnectionOptions: { maxRetries: 0 } });
    try {
      await client.connect(transport, { timeout: 6000 });
      const call = async (name, args = {}) => {
        const result = await call.raw(name, args);
        const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '';
        if (result.isError) throw new Error(text || `MCP ${name} failed`);
        if (result.structuredContent) return result.structuredContent;
        try { return JSON.parse(text); } catch { return { text }; }
      };
      call.raw = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 6000 });
      call.listTools = async () => {
        const tools = []; let cursor;
        do { const result = await client.listTools({ cursor }, { timeout: 6000 }); tools.push(...result.tools); cursor = result.nextCursor; } while (cursor);
        return { tools };
      };
      return await run(call);
    } finally { await client.close().catch(() => {}); }
  });
}

export const listCloudTools = server => withCloud(server, call => call.listTools());

export async function login(server, { open = true, output = console.error, onAuthorization } = {}) {
  server = serverUrl(server);
  return withAuthLock(server, async () => {
    let provider, resolveCode, rejectCode;
    const codePromise = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    // A callback may reject while discovery is still running.
    codePromise.catch(() => {});
    const callbackServer = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { response.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== provider.oauthState) { response.writeHead(400).end('Invalid OAuth state'); return; }
      if (url.searchParams.has('error')) {
        response.writeHead(400).end('Authorization declined. Return to the terminal.');
        rejectCode(new Error('Authorization declined.')); return;
      }
      const code = url.searchParams.get('code');
      if (!code) { response.writeHead(400).end('Missing code'); return; }
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('MindMux authorization received. Return to the terminal.');
      resolveCode(code);
    });
    await new Promise((resolve, reject) => { callbackServer.once('error', reject); callbackServer.listen(0, '127.0.0.1', resolve); });
    const redirectUrl = `http://127.0.0.1:${callbackServer.address().port}/callback`;
    provider = new AuthProvider(server, { interactive: true, redirectUrl, onRedirect: url => {
      output(`Authorize MindMux CLI in your browser:\n${url.href}`);
      onAuthorization?.(url);
      if (open) {
        const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
        const child = spawn(command, [url.href], { stdio: 'ignore' });
        child.on('error', () => output('Open the authorization URL above manually.'));
        child.unref();
      }
    } });
    // A fresh loopback port needs a fresh dynamic registration. Preserve old credentials until successful login.
    provider.data = {};
    provider.staging = true;
    const timer = setTimeout(() => rejectCode(new Error('Login timed out after 3 minutes.')), 180000);
    try {
      const result = await auth(provider, { serverUrl: server, fetchFn: timedFetch });
      if (result === 'REDIRECT') {
        const code = await codePromise;
        const done = await auth(provider, { serverUrl: server, authorizationCode: code, fetchFn: timedFetch });
        if (done !== 'AUTHORIZED') throw new Error('OAuth authorization did not complete.');
      }
      provider.staging = false;
      provider.save();
      output('MindMux CLI is signed in.');
    } finally { clearTimeout(timer); await new Promise(resolve => callbackServer.close(resolve)); }
  });
}
