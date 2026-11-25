import { Hono } from 'hono';
import type { AppAuth } from './auth.js';
import { createListRoutes } from './lists.js';
import { type McpConfig, DEFAULT_TIMEZONE } from './mcp/config.js';
import { createMcpHandler } from './mcp/route.js';
import { createMemberRoutes } from './members.js';
import type { AppDatabase } from './services/database.js';
import { createTaskRoutes } from './tasks.js';

export type AppEnv = { Variables: { user: AppAuth['$Infer']['Session']['user'] } };

// appOrigin is the configured application origin (BETTER_AUTH_URL). `now` is
// the server clock; tests replace it to pin the server's date. `mcp` is the
// MCP endpoint's member tokens and household timezone (src/mcp/config.ts);
// without it no token is accepted.
export function createApp(
  auth: AppAuth,
  db: AppDatabase,
  appOrigin: string,
  {
    now = () => new Date(),
    mcp = { tokens: [], timeZone: DEFAULT_TIMEZONE },
  }: { now?: () => Date; mcp?: McpConfig } = {},
) {
  const app = new Hono<AppEnv>();
  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));
  // The MCP endpoint authorizes with a member token, not a session, so it
  // comes before the session middleware. Only this exact path is exempt;
  // every other method and path below /api still needs a session.
  app.all('/api/mcp', createMcpHandler(db, appOrigin, { config: mcp, now }));
  // Everything added under /api after this middleware requires a real DB session.
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const { response: session, headers } = await auth.api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
    if (!session) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });
  app.get('/api/me', (c) => {
    const { id, name, email } = c.get('user');
    return c.json({ user: { id, name, email } });
  });
  app.route('/api/tasks', createTaskRoutes(db, appOrigin, now));
  app.route('/api/lists', createListRoutes(db, appOrigin));
  app.route('/api/members', createMemberRoutes(db));
  app.onError((error, c) => {
    console.error('API request failed', error.name);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}
