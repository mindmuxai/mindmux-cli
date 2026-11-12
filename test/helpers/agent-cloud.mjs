import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Local OAuth + MCP fixture. No production identity or Cloud writes.
export async function agentCloud() {
  const calls = [], codes = new Map(); let origin, registrations = 0;
  const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(res, { resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['mindmux:brain:read', 'mindmux:brain:write'] });
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) return json(res, { issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
      if (url.pathname === '/register') {
        const body = JSON.parse(await readBody(req)); registrations++;
        return json(res, { ...body, client_id: 'fixture-client' }, 201);
      }
      if (url.pathname === '/authorize') {
        const callback = new URL(url.searchParams.get('redirect_uri'));
        if (url.searchParams.has('deny')) {
          callback.searchParams.set('state', url.searchParams.get('state'));
          callback.searchParams.set('error', 'access_denied');
          res.writeHead(302, { location: callback.href }); return res.end();
        }
        const code = randomUUID(); codes.set(code, url.searchParams.get('code_challenge'));
        callback.searchParams.set('state', url.searchParams.get('state'));
        callback.searchParams.set('code', code);
        res.writeHead(302, { location: callback.href }); return res.end();
      }
      if (url.pathname === '/token') {
        const body = new URLSearchParams(await readBody(req));
        const expected = codes.get(body.get('code'));
        if (!expected || createHash('sha256').update(body.get('code_verifier') || '').digest('base64url') !== expected) return json(res, { error: 'invalid_grant' }, 400);
        codes.delete(body.get('code'));
        return json(res, { access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fixture-refresh-token' });
      }
      if (url.pathname !== '/mcp') { res.writeHead(404); return res.end(); }
      if (req.headers.authorization !== 'Bearer fixture-access-token') {
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }); return res.end();
      }
      const mcp = new Server({ name: 'fixture-cloud', version: '1' }, { capabilities: { tools: {} } });
      const names = ['list_workspaces','list_projects','resolve_brain','create_project','get_brain_index','list_pages','list_root_pages','search_pages'];
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: names.map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) }));
      mcp.setRequestHandler(CallToolRequestSchema, async request => {
        const name = request.params.name; calls.push(name);
        const values = {
          list_workspaces: { workspaces: [{ id: 'test-workspace', name: 'Agent Test Workspace' }] },
          list_projects: { projects: [{ brainId: 'test-brain', name: 'Agent Test Project' }] },
          resolve_brain: { status: 'resolved', brain: { name: 'Agent Test Project' } },
          create_project: { brainId: 'created-brain' },
          get_brain_index: { body: '# MindMux Brain Index\n', pages: [], rootPages: [], count: 0 },
          list_pages: { pages: [] }, list_root_pages: { rootPages: [] }, search_pages: { pages: [] },
        };
        return { content: [{ type: 'text', text: JSON.stringify(values[name] || {}) }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.method === 'POST' ? JSON.parse(await readBody(req)) : undefined);
    } catch (error) { if (!res.headersSent) json(res, { error: error.message }, 500); else res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  return { serverUrl: origin + '/mcp', calls, registrations: () => registrations,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
async function readBody(req) { let body = ''; for await (const chunk of req) body += chunk; return body; }
