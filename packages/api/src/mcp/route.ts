import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import { utcDate } from '../repeat.js';
import type { AppDatabase } from '../services/database.js';
import { createCallerResolver } from './caller.js';
import type { McpConfig } from './config.js';
import { createMcpServer } from './server.js';
import { householdDay } from './today.js';

// POST /api/mcp: the MCP endpoint, Streamable HTTP without sessions (D-4).
// Every request is complete on its own: it authenticates, builds a server for
// that member and day, answers with JSON and is done. Nothing is pushed later,
// so GET (a server event stream) and DELETE (ending a session) are refused.
//
// It is mounted before the session middleware and takes no cookie: only a
// member token (src/mcp/caller.ts) authorizes it, and a member token
// authorizes nothing else. The checks run in this order:
//
// 1. an Origin other than the app's: 403 (a browser page elsewhere, or DNS
//    rebinding; MCP clients send no Origin);
// 2. no working member token: 401 with a Bearer challenge;
// 3. any method but POST: 405;
// 4. the MCP request itself.
//
// Nothing about the request (headers, body, task content) is logged.
export function createMcpHandler(
  db: AppDatabase,
  appOrigin: string,
  { config, now }: { config: McpConfig; now: () => Date },
) {
  const allowedOrigin = new URL(appOrigin).origin;
  const resolveCaller = createCallerResolver(db, config.tokens);
  // Hono applies headers set with c.header only to answers made with c, so
  // the Cache-Control of the /api middleware (src/app.ts) is set here again
  // on the answers built outside it: the 401 and the MCP response.
  return async (c: Context) => {
    const response = await handle(c);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
  async function handle(c: Context): Promise<Response> {
    const origin = c.req.header('Origin');
    if (origin !== undefined && origin !== allowedOrigin) {
      return c.json({ error: 'forbidden_origin', message: 'This request came from an unexpected origin.' }, 403);
    }
    const caller = await resolveCaller(c.req.raw);
    if (!caller.ok) return caller.response;
    if (c.req.method !== 'POST') {
      c.header('Allow', 'POST');
      return c.json({ error: 'method_not_allowed', message: 'This MCP endpoint takes POST requests only.' }, 405);
    }
    const moment = now();
    const { server } = createMcpServer({
      db,
      user: caller.user,
      day: householdDay(moment, config.timeZone),
      serverToday: utcDate(moment),
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      // With JSON responses the answer is complete when this resolves.
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  }
}
