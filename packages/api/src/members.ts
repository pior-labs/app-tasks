import { asc } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from './app.js';
import { users } from './db/schema.js';
import type { AppDatabase } from './tasks.js';

// The household is every Tasks user: everyone who has signed in to Tasks at
// least once. The web client names who added, completed or is assigned a task
// in a shared list with this, and offers them in the "Assigned to" select.
// Only ids and display names, never email addresses (D-9).
export function createMemberRoutes(db: AppDatabase) {
  const routes = new Hono<AppEnv>();
  routes.get('/', async (c) => {
    const members = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .orderBy(asc(users.name), asc(users.id));
    return c.json({ members });
  });
  return routes;
}
