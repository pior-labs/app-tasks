import { Hono } from 'hono';
import type { AppEnv } from './app.js';
import type { AppDatabase } from './services/database.js';
import { listMembers } from './services/members.js';

// The household members (services/members.ts): ids and display names only.
export function createMemberRoutes(db: AppDatabase) {
  const routes = new Hono<AppEnv>();
  routes.get('/', async (c) => {
    return c.json({ members: await listMembers(db) });
  });
  return routes;
}
