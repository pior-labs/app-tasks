import { serve } from '@hono/node-server';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import * as schema from './db/schema.js';
import { authEnvironment, databaseConnection } from './env.js';
import { loadEnvironment } from './load-env.js';

loadEnvironment();
const connection = databaseConnection();
const client = postgres(connection.url, connection.options);
const env = authEnvironment();
const app = createApp(createAuth(client, env), drizzle(client, { schema }), env.baseURL);
const server = serve({
  fetch: app.fetch,
  port: Number(process.env.API_PORT ?? 3000),
  hostname: '0.0.0.0',
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    void client.end().then(() => process.exit(0));
  });
}
