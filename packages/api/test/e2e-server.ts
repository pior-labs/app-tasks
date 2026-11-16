import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
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

const fixture = await createFixture(webOrigin);
const server = serve({ fetch: fixture.app.fetch, port, hostname: 'localhost' }, () => {
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
