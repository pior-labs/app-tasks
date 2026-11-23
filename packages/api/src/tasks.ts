import { and, desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './app.js';
import { accessibleListById, accessibleTask, accessibleTaskById } from './access.js';
import * as schema from './db/schema.js';
import { lists, tasks, users } from './db/schema.js';
import {
  MAX_REPEAT_EVERY,
  MIN_REPEAT_EVERY,
  REPEAT_UNITS,
  type RepeatUnit,
  addDays,
  isCalendarDate,
  nextDueDate,
  utcDate,
} from './repeat.js';

export type AppDatabase = PostgresJsDatabase<typeof schema>;

export const MAX_TITLE_LENGTH = 200;
// tasks.id and lists.id are 32-bit serials.
export const MAX_SERIAL_ID = 2_147_483_647;
const MAX_TASK_ID = MAX_SERIAL_ID;

// A title needs at least one character a person can see. Whitespace, control
// characters and Unicode "default ignorable" code points (zero width space and
// joiners, soft hyphen, direction marks, fillers) render as nothing, so a title
// made only of those is treated like an empty one. This only decides whether a
// title is empty: visible titles are stored exactly as sent (after trimming).
// The web forms apply the same rules (VISIBLE_CHARACTER in
// packages/web/src/text.ts, titleProblem in packages/web/src/Tasks.tsx).
export const VISIBLE_CHARACTER = /[^\p{White_Space}\p{Cc}\p{Default_Ignorable_Code_Point}]/u;

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

// The one definition of valid notes, used by both create and update. Notes are
// optional plain text. Only the ends are trimmed; line breaks and spacing
// inside are stored exactly as sent. Notes with nothing visible after trimming
// (the title rule above) are stored as null, and so are null and "". The
// database checks the same limit (tasks_notes_length_check). The web forms
// apply the same rules in packages/web/src/Tasks.tsx.
export const MAX_NOTES_LENGTH = 5000;
const NOTES_MESSAGE = `Notes must be text of at most ${MAX_NOTES_LENGTH} characters, or null.`;
const taskNotes = z
  .string({ error: NOTES_MESSAGE })
  .trim()
  // PostgreSQL text cannot store U+0000, so reject it here instead of failing the write.
  .refine((notes) => !notes.includes('\u0000'), {
    error: 'Notes cannot contain a null character.',
    abort: true,
  })
  // Code points, as for titles: an emoji is one character.
  .max(MAX_NOTES_LENGTH, { error: NOTES_MESSAGE })
  .transform((notes) => (VISIBLE_CHARACTER.test(notes) ? notes : null))
  .nullable();

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
  // Fixed-width text compares in calendar order.
  return isCalendarDate(value) && value >= MIN_DUE_DATE && value <= MAX_DUE_DATE;
}

const taskDueDate = z
  .string({ error: DUE_DATE_MESSAGE })
  .refine(isDueDate, { error: DUE_DATE_MESSAGE })
  .nullable();

// The one definition of a valid repeat, used by both create and update: an
// object with exactly an integer `every` from 1 to 99 and one of the units,
// or null for "does not repeat". A repeat also needs a due date, which the
// routes check against the task as it will be stored.
const REPEAT_MESSAGE = `A repeat must be null or an object with exactly an integer "every" from ${MIN_REPEAT_EVERY} to ${MAX_REPEAT_EVERY} and a "unit" of ${REPEAT_UNITS.join(', ')}.`;
const REPEAT_NEEDS_DUE_DATE_MESSAGE = 'A repeating task needs a due date. Set a due date, or send "repeat": null.';
const taskRepeat = z
  .strictObject(
    {
      every: z.int({ error: REPEAT_MESSAGE }).min(MIN_REPEAT_EVERY, { error: REPEAT_MESSAGE }).max(MAX_REPEAT_EVERY, { error: REPEAT_MESSAGE }),
      unit: z.enum(REPEAT_UNITS, { error: REPEAT_MESSAGE }),
    },
    { error: REPEAT_MESSAGE },
  )
  .nullable();
type Repeat = { every: number; unit: RepeatUnit } | null;
const invalidRepeat = (message: string) => ({ error: 'invalid_repeat', message });

// "Today" for the fixed schedule is the user's local date, which only the
// browser knows. It is accepted within one day of the server's UTC date, which
// covers every timezone from UTC-12 to UTC+14.
const TODAY_MESSAGE =
  'today must be your local date, written as YYYY-MM-DD, within one day of the server\'s date.';
function acceptedToday(value: unknown, serverToday: string): string | null {
  if (typeof value !== 'string' || !isCalendarDate(value)) return null;
  return value >= addDays(serverToday, -1) && value <= addDays(serverToday, 1) ? value : null;
}

// The first issue decides the error code, so a body with several invalid
// fields answers for the first one (in the order of the schema's keys).
function fieldError(field: PropertyKey | undefined, fallback: string) {
  if (field === 'title') return 'invalid_title';
  if (field === 'notes') return 'invalid_notes';
  if (field === 'completed') return 'invalid_completed';
  if (field === 'dueDate') return 'invalid_due_date';
  if (field === 'repeat') return 'invalid_repeat';
  if (field === 'listId') return 'invalid_list';
  if (field === 'assigneeId') return 'invalid_assignee';
  return fallback;
}

// The one definition of a valid list reference, used by both create and update:
// a list id, or null for Inbox. The list must be one the user can access (their
// own or a shared one, see access.ts), which the routes check with the list
// locked; the database backs this up (tasks_list_fk), so a list deleted at the
// same moment cannot slip through. Ids beyond the column range cannot exist.
const LIST_MESSAGE = 'listId must be the id of one of your lists or a shared list, or null for Inbox.';
const invalidList = { error: 'invalid_list', message: LIST_MESSAGE };
const taskListId = z
  .int({ error: LIST_MESSAGE })
  .positive({ error: LIST_MESSAGE })
  .max(MAX_SERIAL_ID, { error: LIST_MESSAGE })
  .nullable();

// The one definition of a valid assignee, used by both create and update: the
// id of a Tasks user, or null for nobody. Assigning exists only in shared
// lists: the routes accept assigneeId (null too) only when the task ends up in
// a shared list after the same request, and check that the user exists. A
// task that leaves a shared list (moved out, the list unshared or deleted)
// loses its assignee.
const ASSIGNEE_MESSAGE =
  'assigneeId must be the id of a Tasks user, or null for nobody, and only a task in a shared list can have one.';
const invalidAssignee = { error: 'invalid_assignee', message: ASSIGNEE_MESSAGE };
const taskAssigneeId = z
  .int({ error: ASSIGNEE_MESSAGE })
  .positive({ error: ASSIGNEE_MESSAGE })
  .max(MAX_SERIAL_ID, { error: ASSIGNEE_MESSAGE })
  .nullable();

// A missing or null dueDate both mean "no due date"; the same for notes and
// repeat, and a missing or null listId means Inbox. A missing assigneeId means
// nobody.
const createTaskBody = z.object(
  {
    title: taskTitle,
    notes: taskNotes.optional(),
    dueDate: taskDueDate.optional(),
    repeat: taskRepeat.optional(),
    listId: taskListId.optional(),
    assigneeId: taskAssigneeId.optional(),
  },
  { error: 'Send a JSON object with a title.' },
);
// Any of the fields may be sent alone. Unknown keys (such as an owner or an id)
// are dropped. `today` is read separately: it only matters when completing.
const UPDATE_FIELDS_MESSAGE =
  'Send a JSON object with a title, notes, a completed value, a due date (dueDate), a repeat, a list (listId), an assignee (assigneeId), or any of them together.';
const updateTaskBody = z.object(
  {
    title: taskTitle.optional(),
    notes: taskNotes.optional(),
    completed: z.boolean({ error: 'Completed must be true or false.' }).optional(),
    dueDate: taskDueDate.optional(),
    repeat: taskRepeat.optional(),
    listId: taskListId.optional(),
    assigneeId: taskAssigneeId.optional(),
    today: z.unknown().optional(),
  },
  { error: UPDATE_FIELDS_MESSAGE },
);

// Never expose user_id, repeat_anchor or repeated_from_id: the owner follows
// from the task's list (or is the session user, for Inbox), and the other two
// are internal to the schedule. createdById, completedById and assigneeId are
// user ids, or null when unknown or none.
const taskColumns = {
  id: tasks.id,
  title: tasks.title,
  listId: tasks.listId,
  notes: tasks.notes,
  completed: tasks.completed,
  dueDate: tasks.dueDate,
  repeatEvery: tasks.repeatEvery,
  repeatUnit: tasks.repeatUnit,
  createdById: tasks.createdById,
  completedById: tasks.completedById,
  assigneeId: tasks.assigneeId,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};
type TaskRow = {
  id: number;
  title: string;
  listId: number | null;
  notes: string | null;
  completed: boolean;
  dueDate: string | null;
  repeatEvery: number | null;
  repeatUnit: string | null;
  createdById: number | null;
  completedById: number | null;
  assigneeId: number | null;
  createdAt: Date;
  updatedAt: Date;
};
function repeatOf(row: { repeatEvery: number | null; repeatUnit: string | null }): Repeat {
  return row.repeatEvery === null || row.repeatUnit === null
    ? null
    : { every: row.repeatEvery, unit: row.repeatUnit as RepeatUnit };
}
// The API shape of a task.
function toTask({ repeatEvery, repeatUnit, ...task }: TaskRow) {
  return { ...task, repeat: repeatOf({ repeatEvery, repeatUnit }) };
}

export const malformedJson = Symbol('malformed JSON');
export const invalidJson = { error: 'invalid_json', message: 'The request body must be valid JSON.' };
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return malformedJson;
  }
}

export function sessionUserId(c: Context<AppEnv>): number {
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
export function routeId(raw: string): number | null {
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
}
const taskId = routeId;

// Session cookies are SameSite=Lax; this additionally rejects cross-site
// writes. The task and list routes both use it.
export function allowedOriginOnly(appOrigin: string): MiddlewareHandler<AppEnv> {
  const allowedOrigin = new URL(appOrigin).origin;
  return async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (c.req.header('Origin') !== allowedOrigin) {
        return c.json(
          { error: 'forbidden_origin', message: 'This request came from an unexpected origin.' },
          403,
        );
      }
    }
    await next();
  };
}

// The PostgreSQL error behind a failed query. Drizzle wraps it as the cause.
export function databaseError(error: unknown): { code?: string; constraint_name?: string } | null {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') {
      return current as { code: string; constraint_name?: string };
    }
  }
  return null;
}
// A task pointed at a list that does not exist, or is not the user's.
const isListReferenceError = (error: unknown) => {
  const cause = databaseError(error);
  return cause?.code === '23503' && cause.constraint_name === 'tasks_list_fk';
};
// The assignee's user was deleted at this moment.
const isAssigneeReferenceError = (error: unknown) => {
  const cause = databaseError(error);
  return cause?.code === '23503' && cause.constraint_name === 'tasks_assignee_fk';
};

export type Transaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

// Locks a list the user can access and answers its owner and whether it is
// shared, or null for an unknown, deleted or inaccessible list. FOR SHARE
// waits for a delete, rename, share or unshare of the list in progress and
// holds them off until this transaction ends, so the answer stays true for
// the task written with it.
export async function lockAccessibleList(tx: Transaction, userId: number, id: number) {
  const [list] = await tx
    .select({ ownerId: lists.userId, shared: lists.shared })
    .from(lists)
    .where(accessibleListById(userId, id))
    .for('share');
  return list ?? null;
}

// Locks a task the user can access, or answers null. The task is locked
// first, then its list (the order a list delete or unshare takes them in
// reverse, see lists.ts). The access check is repeated on the locked list:
// a list unshared while this transaction waited for the task is seen here, so
// a member who just lost access cannot still change the task.
async function lockAccessibleTask(tx: Transaction, userId: number, id: number) {
  const [task] = await tx
    .select({
      userId: tasks.userId,
      listId: tasks.listId,
      completed: tasks.completed,
      dueDate: tasks.dueDate,
      repeatEvery: tasks.repeatEvery,
      repeatUnit: tasks.repeatUnit,
      repeatAnchor: tasks.repeatAnchor,
      createdById: tasks.createdById,
      assigneeId: tasks.assigneeId,
    })
    .from(tasks)
    .where(accessibleTaskById(userId, id))
    .for('update');
  if (!task) return null;
  let listShared = false;
  if (task.listId !== null) {
    const [list] = await tx
      .select({ shared: lists.shared })
      .from(lists)
      .where(eq(lists.id, task.listId))
      .for('share');
    listShared = list?.shared ?? false;
  }
  if (task.userId !== userId && !listShared) return null;
  return { ...task, listShared };
}

// Whether a user with this id exists (a Tasks user, so a member to assign).
async function isMember(tx: Transaction, id: number) {
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, id));
  return user !== undefined;
}

// Runs a transaction again when PostgreSQL chose it as the victim of a
// deadlock. Deleting a list locks its tasks and then the list, while a task
// update locks the task and then (through tasks_list_fk) its list, so the two
// can rarely wait for each other. The aborted attempt changed nothing.
export async function retryOnDeadlock<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 3 || databaseError(error)?.code !== '40P01') throw error;
    }
  }
}

export function createTaskRoutes(db: AppDatabase, appOrigin: string, now: () => Date) {
  const routes = new Hono<AppEnv>();
  routes.use('*', allowedOriginOnly(appOrigin));

  routes.get('/', async (c) => {
    const rows = await db
      .select(taskColumns)
      .from(tasks)
      .where(accessibleTask(sessionUserId(c)))
      .orderBy(desc(tasks.createdAt), desc(tasks.id));
    return c.json({ tasks: rows.map(toTask) });
  });

  routes.post('/', async (c) => {
    const body = await readJson(c);
    if (body === malformedJson) {
      return c.json(invalidJson, 400);
    }
    const parsed = createTaskBody.safeParse(body);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      return c.json({ error: fieldError(issue.path[0], 'invalid_title'), message: issue.message }, 400);
    }
    const dueDate = parsed.data.dueDate ?? null;
    const repeat = parsed.data.repeat ?? null;
    if (repeat && dueDate === null) return c.json(invalidRepeat(REPEAT_NEEDS_DUE_DATE_MESSAGE), 400);
    const userId = sessionUserId(c);
    const listId = parsed.data.listId ?? null;
    const { assigneeId } = parsed.data;
    let result: { status: 400; body: typeof invalidList } | { status: 201; body: { task: ReturnType<typeof toTask> } };
    try {
      result = await db.transaction(async (tx) => {
        // A task in a list is stored with the list owner's user_id
        // (tasks_list_fk), also when another member adds it to their shared
        // list; the adder is kept in created_by_id. In Inbox the adder owns it.
        const list = listId === null ? null : await lockAccessibleList(tx, userId, listId);
        if (listId !== null && !list) return { status: 400 as const, body: invalidList };
        if (assigneeId !== undefined) {
          if (!list?.shared) return { status: 400 as const, body: invalidAssignee };
          if (assigneeId !== null && !(await isMember(tx, assigneeId))) {
            return { status: 400 as const, body: invalidAssignee };
          }
        }
        const [task]: TaskRow[] = await tx
          .insert(tasks)
          .values({
            userId: list?.ownerId ?? userId,
            createdById: userId,
            assigneeId: assigneeId ?? null,
            title: parsed.data.title,
            listId,
            notes: parsed.data.notes ?? null,
            dueDate,
            repeatEvery: repeat?.every ?? null,
            repeatUnit: repeat?.unit ?? null,
            repeatAnchor: repeat ? dueDate : null,
          })
          .returning(taskColumns);
        return { status: 201 as const, body: { task: toTask(task) } };
      });
    } catch (error) {
      // An unknown, deleted or inaccessible list: the same answer for all three.
      if (isListReferenceError(error)) return c.json(invalidList, 400);
      if (isAssigneeReferenceError(error)) return c.json(invalidAssignee, 400);
      throw error;
    }
    return c.json(result.body, result.status);
  });

  routes.patch('/:id', async (c) => {
    const id = taskId(c.req.param('id'));
    if (id === null) return c.json(invalidTaskId, 400);
    const body = await readJson(c);
    if (body === malformedJson) {
      return c.json(invalidJson, 400);
    }
    const parsed = updateTaskBody.safeParse(body);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      return c.json({ error: fieldError(issue.path[0], 'invalid_update'), message: issue.message }, 400);
    }
    const { title, notes, completed, dueDate, repeat, listId, assigneeId } = parsed.data;
    if (
      title === undefined &&
      notes === undefined &&
      completed === undefined &&
      dueDate === undefined &&
      repeat === undefined &&
      listId === undefined &&
      assigneeId === undefined
    ) {
      return c.json({ error: 'invalid_update', message: UPDATE_FIELDS_MESSAGE }, 400);
    }
    // Unknown ids and other users' tasks are indistinguishable to the caller.
    if (id > MAX_TASK_ID) return c.json(taskNotFound, 404);
    const userId = sessionUserId(c);
    const serverToday = utcDate(now());

    // One transaction: the update, and the next occurrence created or removed
    // with it. The row is locked first, so concurrent changes to one task run
    // one after another and see each other's result.
    const transaction = () => db.transaction(async (tx) => {
      const current = await lockAccessibleTask(tx, userId, id);
      if (!current) return { status: 404 as const, body: taskNotFound };

      const currentRepeat = repeatOf(current);
      const newRepeat = repeat === undefined ? currentRepeat : repeat;
      const newDueDate = dueDate === undefined ? current.dueDate : dueDate;
      if (newRepeat && newDueDate === null) {
        return { status: 400 as const, body: invalidRepeat(REPEAT_NEEDS_DUE_DATE_MESSAGE) };
      }
      const completing = completed === true && !current.completed;
      const reopening = completed === false && current.completed;
      let today = serverToday;
      if (completing && parsed.data.today !== undefined) {
        const accepted = acceptedToday(parsed.data.today, serverToday);
        if (accepted === null) {
          return { status: 400 as const, body: { error: 'invalid_today', message: TODAY_MESSAGE } };
        }
        today = accepted;
      }
      // The schedule restarts from the due date when the repeat is set or
      // changed, and whenever the due date of a repeating task changes.
      const repeatChanged =
        repeat !== undefined &&
        (currentRepeat === null ||
          repeat === null ||
          repeat.every !== currentRepeat.every ||
          repeat.unit !== currentRepeat.unit);
      const newAnchor = !newRepeat
        ? null
        : repeatChanged || newDueDate !== current.dueDate || current.repeatAnchor === null
          ? newDueDate
          : current.repeatAnchor;

      // Where the task ends up, and so who owns it (tasks_list_fk): moving it
      // into a list gives it to that list's owner, moving it to Inbox gives it
      // to the mover. Without a move, owner and list stay.
      let owner = current.userId;
      let endsShared = current.listShared;
      if (listId === null) {
        owner = userId;
        endsShared = false;
      } else if (listId !== undefined) {
        const list = await lockAccessibleList(tx, userId, listId);
        if (!list) return { status: 400 as const, body: invalidList };
        owner = list.ownerId;
        endsShared = list.shared;
      }
      // Only a task in a shared list has an assignee (see taskAssigneeId).
      if (assigneeId !== undefined) {
        if (!endsShared) return { status: 400 as const, body: invalidAssignee };
        if (assigneeId !== null && !(await isMember(tx, assigneeId))) {
          return { status: 400 as const, body: invalidAssignee };
        }
      }
      const newAssignee = !endsShared ? null : assigneeId === undefined ? current.assigneeId : assigneeId;

      const [task] = await tx
        .update(tasks)
        .set({
          ...(title === undefined ? {} : { title }),
          ...(notes === undefined ? {} : { notes }),
          ...(listId === undefined ? {} : { listId }),
          ...(completed === undefined ? {} : { completed }),
          ...(dueDate === undefined ? {} : { dueDate }),
          ...(repeat === undefined ? {} : { repeatEvery: repeat?.every ?? null, repeatUnit: repeat?.unit ?? null }),
          // Who completed it: the session user when this update completes
          // it, nobody once it is open again, otherwise unchanged.
          ...(completing ? { completedById: userId } : reopening ? { completedById: null } : {}),
          userId: owner,
          assigneeId: newAssignee,
          repeatAnchor: newAnchor,
          updatedAt: sql`now()`,
        })
        .where(eq(tasks.id, id))
        .returning({ ...taskColumns, userId: tasks.userId });

      let nextTask: TaskRow | null = null;
      if (completing && newRepeat && newDueDate !== null && newAnchor !== null) {
        // Completing again while an earlier next occurrence still exists (it
        // was completed itself, so un-completing kept it) creates no second one.
        const [existing] = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.repeatedFromId, id));
        const next = nextDueDate({
          anchor: newAnchor,
          dueDate: newDueDate,
          today,
          every: newRepeat.every,
          unit: newRepeat.unit,
        });
        if (!existing && next <= MAX_DUE_DATE) {
          // The unique repeated_from_id backs this up: a conflicting insert
          // creates nothing instead of a duplicate.
          [nextTask = null] = await tx
            .insert(tasks)
            .values({
              // The next occurrence carries the title, notes, list (and so
              // owner) and assignee as this update stored them, and the
              // original's creator. Nobody has completed it yet.
              userId: task.userId,
              createdById: task.createdById,
              assigneeId: task.assigneeId,
              title: task.title,
              listId: task.listId,
              notes: task.notes,
              dueDate: next,
              repeatEvery: newRepeat.every,
              repeatUnit: newRepeat.unit,
              repeatAnchor: newAnchor,
              repeatedFromId: id,
            })
            .onConflictDoNothing({ target: tasks.repeatedFromId })
            .returning(taskColumns);
        }
      }
      let removedTaskId: number | null = null;
      if (reopening) {
        // Undo: the next occurrence goes away while it is still open. One that
        // was completed meanwhile is kept, and so is one the user cannot
        // access (another member moved it to their own Inbox).
        const [removed] = await tx
          .delete(tasks)
          .where(and(eq(tasks.repeatedFromId, id), eq(tasks.completed, false), accessibleTask(userId)))
          .returning({ id: tasks.id });
        removedTaskId = removed?.id ?? null;
      }
      const { userId: _owner, ...stored } = task;
      return {
        status: 200 as const,
        body: { task: toTask(stored), nextTask: nextTask && toTask(nextTask), removedTaskId },
      };
    });
    let result: Awaited<ReturnType<typeof transaction>>;
    try {
      result = await retryOnDeadlock(transaction);
    } catch (error) {
      // The list was unknown, deleted (perhaps at this moment) or another
      // user's. The whole transaction was rolled back, so nothing changed.
      if (isListReferenceError(error)) return c.json(invalidList, 400);
      if (isAssigneeReferenceError(error)) return c.json(invalidAssignee, 400);
      throw error;
    }
    return c.json(result.body, result.status);
  });

  routes.delete('/:id', async (c) => {
    const id = taskId(c.req.param('id'));
    if (id === null) return c.json(invalidTaskId, 400);
    const userId = sessionUserId(c);
    // The task is locked with the access check (see lockAccessibleTask), so a
    // missing, already deleted or inaccessible task all end the same way.
    const deleted =
      id > MAX_TASK_ID
        ? false
        : await retryOnDeadlock(() =>
            db.transaction(async (tx) => {
              if (!(await lockAccessibleTask(tx, userId, id))) return false;
              await tx.delete(tasks).where(eq(tasks.id, id));
              return true;
            }),
          );
    if (!deleted) return c.json(taskNotFound, 404);
    return c.body(null, 204);
  });

  return routes;
}
