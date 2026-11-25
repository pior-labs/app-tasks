import { Hono } from 'hono';
import type { AppEnv } from './app.js';
import { allowedOriginOnly, failed, invalidJson, malformedJson, readJson, routeId, sessionUserId } from './http.js';
import { utcDate } from './repeat.js';
import type { AppDatabase } from './services/database.js';
import { createTask, deleteTask, listTasks, updateTask } from './services/tasks.js';

// The task routes of the web API. The rules (validation, access, locking,
// repeats, assignees) live in services/tasks.ts, which the MCP tools share;
// these routes read the request and answer with the service's result.

const invalidTaskId = {
  error: 'invalid_task_id',
  message: 'The task id must be a positive whole number.',
};
const taskId = routeId;

export function createTaskRoutes(db: AppDatabase, appOrigin: string, now: () => Date) {
  const routes = new Hono<AppEnv>();
  routes.use('*', allowedOriginOnly(appOrigin));

  routes.get('/', async (c) => {
    return c.json({ tasks: await listTasks(db, sessionUserId(c)) });
  });

  routes.post('/', async (c) => {
    const body = await readJson(c);
    if (body === malformedJson) {
      return c.json(invalidJson, 400);
    }
    const result = await createTask(db, sessionUserId(c), body);
    if (!result.ok) return failed(c, result.failure);
    return c.json({ task: result.value }, 201);
  });

  routes.patch('/:id', async (c) => {
    const id = taskId(c.req.param('id'));
    if (id === null) return c.json(invalidTaskId, 400);
    const body = await readJson(c);
    if (body === malformedJson) {
      return c.json(invalidJson, 400);
    }
    // The browser sends its local date as `today` when completing; the
    // service accepts it within one day of the server's UTC date.
    const result = await updateTask(db, sessionUserId(c), id, body, utcDate(now()));
    if (!result.ok) return failed(c, result.failure);
    const { task, nextTask, removedTaskId } = result.value;
    return c.json({ task, nextTask, removedTaskId }, 200);
  });

  routes.delete('/:id', async (c) => {
    const id = taskId(c.req.param('id'));
    if (id === null) return c.json(invalidTaskId, 400);
    const result = await deleteTask(db, sessionUserId(c), id);
    if (!result.ok) return failed(c, result.failure);
    return c.body(null, 204);
  });

  return routes;
}
