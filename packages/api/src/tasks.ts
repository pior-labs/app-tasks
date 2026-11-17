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

// The one definition of a valid due date, used by both create and update. A
// due date is a calendar day with no time or timezone, exchanged as the exact
// text "YYYY-MM-DD" and stored in a PostgreSQL date column, so the server never
// converts it. The day must exist (no February 30) and fall in the supported
// range; past days are allowed. null means "no due date". The web forms apply
// the same range (packages/web/src/dueDate.ts).
export const MIN_DUE_DATE = '2025-01-01';
export const MAX_DUE_DATE = '2100-12-31';
const DUE_DATE_MESSAGE = `A due date must be a real calendar date from ${MIN_DUE_DATE} through ${MAX_DUE_DATE}, written as YYYY-MM-DD, or null.`;

function isDueDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const exists =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  // Fixed-width text compares in calendar order.
  return exists && value >= MIN_DUE_DATE && value <= MAX_DUE_DATE;
}

const taskDueDate = z
  .string({ error: DUE_DATE_MESSAGE })
  .refine(isDueDate, { error: DUE_DATE_MESSAGE })
  .nullable();

// The first issue decides the error code, so a body with several invalid
// fields answers for the first one (in the order of the schema's keys).
function fieldError(field: PropertyKey | undefined, fallback: string) {
  if (field === 'title') return 'invalid_title';
  if (field === 'completed') return 'invalid_completed';
  if (field === 'dueDate') return 'invalid_due_date';
  return fallback;
}

// A missing or null dueDate both mean "no due date".
const createTaskBody = z.object(
  { title: taskTitle, dueDate: taskDueDate.optional() },
  { error: 'Send a JSON object with a title.' },
);
// Any of the fields may be sent alone. Unknown keys (such as an owner or an id) are dropped.
const UPDATE_FIELDS_MESSAGE =
  'Send a JSON object with a title, a completed value, a due date (dueDate), or any of them together.';
const updateTaskBody = z.object(
  {
    title: taskTitle.optional(),
    completed: z.boolean({ error: 'Completed must be true or false.' }).optional(),
    dueDate: taskDueDate.optional(),
  },
  { error: UPDATE_FIELDS_MESSAGE },
);

// Never expose user_id: the owner is implied by the session.
const taskColumns = {
  id: tasks.id,
  title: tasks.title,
  completed: tasks.completed,
  dueDate: tasks.dueDate,
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
      const [issue] = parsed.error.issues;
      return c.json({ error: fieldError(issue.path[0], 'invalid_title'), message: issue.message }, 400);
    }
    const [task] = await db
      .insert(tasks)
      .values({
        userId: sessionUserId(c),
        title: parsed.data.title,
        dueDate: parsed.data.dueDate ?? null,
      })
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
      return c.json({ error: fieldError(issue.path[0], 'invalid_update'), message: issue.message }, 400);
    }
    const { title, completed, dueDate } = parsed.data;
    if (title === undefined && completed === undefined && dueDate === undefined) {
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
              ...(dueDate === undefined ? {} : { dueDate }),
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
