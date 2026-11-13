import { and, desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './app.js';
import * as schema from './db/schema.js';
import { tasks } from './db/schema.js';

export type AppDatabase = PostgresJsDatabase<typeof schema>;

export const MAX_TITLE_LENGTH = 200;
const MAX_TASK_ID = 2_147_483_647; // tasks.id is a 32-bit serial.

const createTaskBody = z.object(
  {
    title: z
      .string({ error: 'A task title is required and must be text.' })
      .trim()
      .min(1, { error: 'Enter a task title.' })
      .max(MAX_TITLE_LENGTH, {
        error: `Task titles can be at most ${MAX_TITLE_LENGTH} characters.`,
      }),
  },
  { error: 'Send a JSON object with a title.' },
);
const updateTaskBody = z.object(
  { completed: z.boolean({ error: 'Completed must be true or false.' }) },
  { error: 'Send a JSON object with a completed value.' },
);

// Never expose user_id: the owner is implied by the session.
const taskColumns = {
  id: tasks.id,
  title: tasks.title,
  completed: tasks.completed,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

const malformedJson = Symbol('malformed JSON');
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return malformedJson;
  }
}

function sessionUserId(c: Context<AppEnv>): number {
  const id = Number(c.get('user').id);
  if (!Number.isSafeInteger(id)) throw new Error('Session user id is not an integer');
  return id;
}

export function createTaskRoutes(db: AppDatabase, appOrigin: string) {
  const allowedOrigin = new URL(appOrigin).origin;
  const routes = new Hono<AppEnv>();

  // Session cookies are SameSite=Lax; this additionally rejects cross-site writes.
  routes.use('*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (c.req.header('Origin') !== allowedOrigin) {
        return c.json(
          { error: 'forbidden_origin', message: 'This request came from an unexpected origin.' },
          403,
        );
      }
    }
    await next();
  });

  routes.get('/', async (c) => {
    const rows = await db
      .select(taskColumns)
      .from(tasks)
      .where(eq(tasks.userId, sessionUserId(c)))
      .orderBy(desc(tasks.createdAt), desc(tasks.id));
    return c.json({ tasks: rows });
  });

  routes.post('/', async (c) => {
    const body = await readJson(c);
    if (body === malformedJson) {
      return c.json({ error: 'invalid_json', message: 'The request body must be valid JSON.' }, 400);
    }
    const parsed = createTaskBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_title', message: parsed.error.issues[0].message }, 400);
    }
    const [task] = await db
      .insert(tasks)
      .values({ userId: sessionUserId(c), title: parsed.data.title })
      .returning(taskColumns);
    return c.json({ task }, 201);
  });

  routes.patch('/:id', async (c) => {
    const rawId = c.req.param('id');
    if (!/^[1-9]\d{0,15}$/.test(rawId)) {
      return c.json(
        { error: 'invalid_task_id', message: 'The task id must be a positive whole number.' },
        400,
      );
    }
    const body = await readJson(c);
    if (body === malformedJson) {
      return c.json({ error: 'invalid_json', message: 'The request body must be valid JSON.' }, 400);
    }
    const parsed = updateTaskBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_completed', message: parsed.error.issues[0].message }, 400);
    }
    const id = Number(rawId);
    // Unknown ids and other users' tasks are indistinguishable to the caller.
    const [task] =
      id > MAX_TASK_ID
        ? []
        : await db
            .update(tasks)
            .set({ completed: parsed.data.completed, updatedAt: sql`now()` })
            .where(and(eq(tasks.id, id), eq(tasks.userId, sessionUserId(c))))
            .returning(taskColumns);
    if (!task) {
      return c.json({ error: 'task_not_found', message: 'That task could not be found.' }, 404);
    }
    return c.json({ task });
  });

  return routes;
}
