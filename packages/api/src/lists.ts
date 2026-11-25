import { Hono } from 'hono';
import type { AppEnv } from './app.js';
import { allowedOriginOnly, failed, invalidJson, malformedJson, readJson, routeId, sessionUserId } from './http.js';
import type { AppDatabase } from './services/database.js';
import { createList, deleteList, listLists, updateList } from './services/lists.js';

// The list routes of the web API. The rules (names, the list limit, sharing,
// what deleting a list does to its tasks) live in services/lists.ts, which the
// MCP tools share; these routes read the request and answer with the result.

const invalidListId = { error: 'invalid_list_id', message: 'The list id must be a positive whole number.' };

export function createListRoutes(db: AppDatabase, appOrigin: string) {
  const routes = new Hono<AppEnv>();
  routes.use('*', allowedOriginOnly(appOrigin));

  // The user's own lists and every shared list, oldest first.
  routes.get('/', async (c) => {
    return c.json({ lists: await listLists(db, sessionUserId(c)) });
  });

  routes.post('/', async (c) => {
    const body = await readJson(c);
    if (body === malformedJson) return c.json(invalidJson, 400);
    const result = await createList(db, sessionUserId(c), body);
    if (!result.ok) return failed(c, result.failure);
    return c.json({ list: result.value }, 201);
  });

  routes.patch('/:id', async (c) => {
    const id = routeId(c.req.param('id'));
    if (id === null) return c.json(invalidListId, 400);
    const body = await readJson(c);
    if (body === malformedJson) return c.json(invalidJson, 400);
    const result = await updateList(db, sessionUserId(c), id, body);
    if (!result.ok) return failed(c, result.failure);
    return c.json({ list: result.value }, 200);
  });

  routes.delete('/:id', async (c) => {
    const id = routeId(c.req.param('id'));
    if (id === null) return c.json(invalidListId, 400);
    const result = await deleteList(db, sessionUserId(c), id);
    if (!result.ok) return failed(c, result.failure);
    return c.json({ movedTaskIds: result.value });
  });

  return routes;
}
