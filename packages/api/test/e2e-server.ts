import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { mcpEnvironment } from '../src/mcp/config.js';
import { createFixture } from './fixture.js';

// The API server for the browser end-to-end suite (packages/e2e). It serves the
// real application on the test fixture: a newly created tasks_test_* database
// and the fixture SSO provider. It never reads the development configuration.
function required(key: string) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Set ${key}`);
  return value;
}
// The origin the browser uses (the web dev server). Better Auth and the origin
// check must agree with it.
const webOrigin = required('E2E_WEB_ORIGIN');
const port = Number(required('E2E_API_PORT'));
if (!Number.isInteger(port) || port <= 0) throw new Error('E2E_API_PORT must be a port number');

// The MCP endpoint reads TASKS_MCP_TOKENS and TASKS_TIMEZONE like the real
// API, so it can be tried by hand with tokens for the fixture users. Without
// them it accepts no token.
const fixture = await createFixture(webOrigin, { mcp: mcpEnvironment() });
// The browser tests fix the browser clock, and the API checks the browser's
// "today" against its own date, so the tests set the API clock to match. This
// route exists only in this test server, never in the application.
const testServer = new Hono();
testServer.put('/e2e/clock', async (c) => {
  const { time } = (await c.req.json()) as { time: string | null };
  fixture.setNow(time === null ? null : new Date(time));
  return c.json({ now: fixture.now().toISOString() });
});
// Every browser test starts from an empty task domain (packages/e2e/tests/
// fixtures.ts calls this before each test), so no test sees another's lists or
// tasks and the order of the spec files does not matter. Users and sessions
// stay: they come from signing in, which every test does itself. Tasks go
// first, because tasks_list_fk refuses to delete a list that tasks still use.
// Like the clock, this route exists only in this test server.
testServer.post('/e2e/reset', async (c) => {
  await fixture.client.begin(async (sql) => {
    await sql`delete from tasks`;
    await sql`delete from lists`;
  });
  return c.json({ ok: true });
});
testServer.all('*', (c) => fixture.app.fetch(c.req.raw));
const server = serve({ fetch: testServer.fetch, port, hostname: 'localhost' }, () => {
  console.log(`End-to-end API for ${webOrigin} listening on http://localhost:${port}`);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  // The dev server's proxy keeps connections open; do not wait for them.
  (server as Server).closeAllConnections();
  try {
    // Drops the disposable database and stops the container the fixture started.
    await fixture.close();
  } finally {
    process.exit(0);
  }
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown());
server.on('error', (error) => {
  console.error('End-to-end API could not start:', error.message);
  process.exitCode = 1;
  void shutdown();
});
