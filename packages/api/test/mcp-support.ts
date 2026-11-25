import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { hashToken, parseMcpTokens } from '../src/mcp/config.js';
import { createFixture } from './fixture.js';
import { appOrigin } from './session.js';

type Fixture = Awaited<ReturnType<typeof createFixture>>;

// Member tokens for the MCP tests: one per fixture user, a second one for
// member one (a rotation overlap), and one for an email that never signed in.
// Random per run; they exist only in this process.
export function memberTokens() {
  const tokens = {
    one: randomBytes(32).toString('base64url'),
    oneRotated: randomBytes(32).toString('base64url'),
    two: randomBytes(32).toString('base64url'),
    stranger: randomBytes(32).toString('base64url'),
  };
  const config = parseMcpTokens(
    [
      `one@example.test:${hashToken(tokens.one)}`,
      `ONE@example.test:${hashToken(tokens.oneRotated)}`,
      `two@example.test:${hashToken(tokens.two)}`,
      `three@example.test:${hashToken(tokens.stranger)}`,
    ].join(', '),
  );
  return { tokens, config };
}

// The fixture app on a real HTTP listener, as MCP clients reach it.
export async function listen(app: Fixture['app']) {
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    url: new URL('/api/mcp', base),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// The official SDK client, connected with a member token.
export async function connect(url: URL, token: string) {
  const client = new Client({ name: 'tasks-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

export type ToolResult = CallToolResult & { structuredContent: Record<string, any> };

export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

// A successful result: its structured content.
export async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

// A tool error: its message (the first text).
export async function refused(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  assert.equal(result.isError, true, `${name} should have failed: ${JSON.stringify(result.structuredContent)}`);
  return (result.content[0] as { text: string }).text;
}

// A raw JSON-RPC POST to the endpoint, for the HTTP-level checks.
export function rpc(url: URL, headers: Record<string, string>, body: unknown = initializeRequest, method = 'POST') {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
  });
}
export const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
};
export const addTaskRequest = (title: string) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'add_task', arguments: { title } },
});

// A web API request with a session cookie.
export function send(fixture: Fixture, session: string, method: string, path: string, body?: unknown) {
  return fixture.app.request(path, {
    method,
    headers: {
      Cookie: session,
      Origin: appOrigin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
