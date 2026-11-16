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

// A title needs at least one character a person can see. Whitespace, control
// characters and Unicode "default ignorable" code points (zero width space and
// joiners, soft hyphen, direction marks, fillers) render as nothing, so a title
// made only of those is treated like an empty one. This only decides whether a
// title is empty: visible titles are stored exactly as sent (after trimming).
// The web form applies the same rules in packages/web/src/Tasks.tsx.
const VISIBLE_CHARACTER = /[^\p{White_Space}\p{Cc}\p{Default_Ignorable_Code_Point}]/u;

// The one definition of a valid title, used by both create and rename.
const taskTitle = z
  .string({ error: 'A task title is required and must be text.' })
  .trim()
  .refine((title) => VISIBLE_CHARACTER.test(title), {
    error: 'Enter a task title.',
    abort: true,
  })
  // PostgreSQL text cannot store U+0000, so reject it here instead of failing the write.
  .refine((title) => !title.includes('\u0000'), {
    error: 'Task titles cannot contain a null character.',
    abort: true,
  })
  // zod counts Unicode code points here, so an emoji is one character. The
  // web form counts the same way; tests on both sides pin the boundary.
  .max(MAX_TITLE_LENGTH, {
    error: `Task titles can be at most ${MAX_TITLE_LENGTH} characters.`,
  });

const createTaskBody = z.object({ title: taskTitle }, { error: 'Send a JSON object with a title.' });
// Either field may be sent alone. Unknown keys (such as an owner or an id) are dropped.
const UPDATE_FIELDS_MESSAGE = 'Send a JSON object with a title, a completed value, or both.';
const updateTaskBody = z.object(
  {
    title: taskTitle.optional(),
    completed: z.boolean({ error: 'Completed must be true or false.' }).optional(),
  },
  { error: UPDATE_FIELDS_MESSAGE },
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

const invalidTaskId = {
  error: 'invalid_task_id',
  message: 'The task id must be a positive whole number.',
};
const taskNotFound = { error: 'task_not_found', message: 'That task could not be found.' };

// A route id is a positive decimal integer. Ids beyond the column range are
// well formed but cannot exist, so callers answer those with "not found".
function taskId(raw: string): number | null {
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
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
    const id = taskId(c.req.param('id'));
    if (id === null) return c.json(invalidTaskId, 400);
    const body = await readJson(c);
    if (body === malformedJson) {
      return c.json({ error: 'invalid_json', message: 'The request body must be valid JSON.' }, 400);
    }
    const parsed = updateTaskBody.safeParse(body);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const error =
        issue.path[0] === 'title'
          ? 'invalid_title'
          : issue.path[0] === 'completed'
            ? 'invalid_completed'
            : 'invalid_update';
      return c.json({ error, message: issue.message }, 400);
    }
    const { title, completed } = parsed.data;
    if (title === undefined && completed === undefined) {
      return c.json({ error: 'invalid_update', message: UPDATE_FIELDS_MESSAGE }, 400);
    }
    // Unknown ids and other users' tasks are indistinguishable to the caller.
    const [task] =
      id > MAX_TASK_ID
        ? []
        : await db
            .update(tasks)
            .set({
              ...(title === undefined ? {} : { title }),
              ...(completed === undefined ? {} : { completed }),
              updatedAt: sql`now()`,
            })
            .where(and(eq(tasks.id, id), eq(tasks.userId, sessionUserId(c))))
            .returning(taskColumns);
    if (!task) return c.json(taskNotFound, 404);
    return c.json({ task });
  });

  routes.delete('/:id', async (c) => {
    const id = taskId(c.req.param('id'));
    if (id === null) return c.json(invalidTaskId, 400);
    // The owner filter is part of the delete itself, so a missing, already
    // deleted or foreign task all end the same way.
    const [deleted] =
      id > MAX_TASK_ID
        ? []
        : await db
            .delete(tasks)
            .where(and(eq(tasks.id, id), eq(tasks.userId, sessionUserId(c))))
            .returning({ id: tasks.id });
    if (!deleted) return c.json(taskNotFound, 404);
    return c.body(null, 204);
  });

  return routes;
}
