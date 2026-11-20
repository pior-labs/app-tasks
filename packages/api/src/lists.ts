import { and, asc, count, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from './app.js';
import { lists, tasks, users } from './db/schema.js';
import {
  type AppDatabase,
  MAX_SERIAL_ID,
  VISIBLE_CHARACTER,
  allowedOriginOnly,
  databaseError,
  invalidJson,
  malformedJson,
  readJson,
  retryOnDeadlock,
  routeId,
  sessionUserId,
} from './tasks.js';

export const MAX_LIST_NAME_LENGTH = 50;
// So the tab row stays usable. The web client shows the error.
export const MAX_LISTS = 50;
// The built-in views. A list whose name shows as one of them would look like
// its tab, so the check compares what a person would see: letter case is
// ignored, invisible code points (default ignorables such as a zero width
// space, joiners, direction marks and the soft hyphen, and control
// characters) are dropped, and any run of white space (a no-break space,
// repeated spaces) counts as one space. Names that merely contain the words,
// such as "Inbox zero", are allowed. Only this check uses the folded form:
// names are stored as typed, and duplicates compare with lower() like the
// database index. The web form folds the same way (packages/web/src/lists.ts).
const RESERVED_LIST_NAMES = ['inbox', 'all tasks'];
const isReservedListName = (name: string) =>
  RESERVED_LIST_NAMES.includes(
    name
      .replace(/\p{White_Space}+/gu, ' ')
      .replace(/[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, '')
      .replace(/ +/g, ' ')
      .trim()
      .toLowerCase(),
  );

// The one definition of a valid list name, used by both create and rename. The
// rules are those of task titles (packages/api/src/tasks.ts): trimmed, at least
// one visible character, no U+0000, and the length in code points. The
// database checks the same length (lists_name_length_check). Names are stored
// as typed; uniqueness ignores letter case (lists_user_id_name_idx). The web
// forms apply the same rules (listNameProblem in packages/web/src/lists.ts).
const NAME_MESSAGE = 'A list name is required and must be text.';
const listName = z
  .string({ error: NAME_MESSAGE })
  .trim()
  .refine((name) => VISIBLE_CHARACTER.test(name), { error: 'Enter a list name.', abort: true })
  // PostgreSQL text cannot store U+0000, so reject it here instead of failing the write.
  .refine((name) => !name.includes('\u0000'), {
    error: 'List names cannot contain a null character.',
    abort: true,
  })
  .max(MAX_LIST_NAME_LENGTH, { error: `List names can be at most ${MAX_LIST_NAME_LENGTH} characters.` })
  .refine((name) => !isReservedListName(name), {
    error: '"Inbox" and "All tasks" are built in. Choose another name.',
  });
// Create and rename take the same body. Unknown keys (such as an owner or an
// id) are dropped.
const listBody = z.object({ name: listName }, { error: 'Send a JSON object with a name.' });

// Never expose user_id: the owner is implied by the session.
const listColumns = {
  id: lists.id,
  name: lists.name,
  createdAt: lists.createdAt,
  updatedAt: lists.updatedAt,
};

const invalidListId = { error: 'invalid_list_id', message: 'The list id must be a positive whole number.' };
const listNotFound = { error: 'list_not_found', message: 'That list could not be found.' };
const duplicateName = {
  error: 'duplicate_list_name',
  message: 'You already have a list with that name.',
};
const limitReached = {
  error: 'list_limit_reached',
  message: `You can have at most ${MAX_LISTS} lists. Delete one to make room.`,
};
const isDuplicateName = (error: unknown) => {
  const cause = databaseError(error);
  return cause?.code === '23505' && cause.constraint_name === 'lists_user_id_name_idx';
};

export function createListRoutes(db: AppDatabase, appOrigin: string) {
  const routes = new Hono<AppEnv>();
  routes.use('*', allowedOriginOnly(appOrigin));

  // Oldest first, in the order they were created.
  routes.get('/', async (c) => {
    const rows = await db
      .select(listColumns)
      .from(lists)
      .where(eq(lists.userId, sessionUserId(c)))
      .orderBy(asc(lists.createdAt), asc(lists.id));
    return c.json({ lists: rows });
  });

  routes.post('/', async (c) => {
    const body = await readJson(c);
    if (body === malformedJson) return c.json(invalidJson, 400);
    const parsed = listBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_list_name', message: parsed.error.issues[0].message }, 400);
    }
    const userId = sessionUserId(c);
    try {
      const result = await db.transaction(async (tx) => {
        // Locking the user's row makes creates for one user run one after
        // another, so parallel requests cannot pass the limit. This lock does
        // not block task writes, which only take a key share on the user row.
        await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('no key update');
        const [{ lists: existing }] = await tx
          .select({ lists: count() })
          .from(lists)
          .where(eq(lists.userId, userId));
        if (existing >= MAX_LISTS) return { status: 409 as const, body: limitReached };
        const [list] = await tx.insert(lists).values({ userId, name: parsed.data.name }).returning(listColumns);
        return { status: 201 as const, body: { list } };
      });
      return c.json(result.body, result.status);
    } catch (error) {
      if (isDuplicateName(error)) return c.json(duplicateName, 409);
      throw error;
    }
  });

  routes.patch('/:id', async (c) => {
    const id = routeId(c.req.param('id'));
    if (id === null) return c.json(invalidListId, 400);
    const body = await readJson(c);
    if (body === malformedJson) return c.json(invalidJson, 400);
    const parsed = listBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_list_name', message: parsed.error.issues[0].message }, 400);
    }
    // Unknown ids and other users' lists are indistinguishable to the caller.
    if (id > MAX_SERIAL_ID) return c.json(listNotFound, 404);
    try {
      const [list] = await db
        .update(lists)
        .set({ name: parsed.data.name, updatedAt: sql`now()` })
        .where(and(eq(lists.id, id), eq(lists.userId, sessionUserId(c))))
        .returning(listColumns);
      if (!list) return c.json(listNotFound, 404);
      return c.json({ list });
    } catch (error) {
      if (isDuplicateName(error)) return c.json(duplicateName, 409);
      throw error;
    }
  });

  // Deleting a list never deletes a task: its tasks, open and completed, move
  // to Inbox in the same transaction, and the answer names them so the client
  // can move them without reloading.
  routes.delete('/:id', async (c) => {
    const id = routeId(c.req.param('id'));
    if (id === null) return c.json(invalidListId, 400);
    if (id > MAX_SERIAL_ID) return c.json(listNotFound, 404);
    const userId = sessionUserId(c);
    const inList = and(eq(tasks.listId, id), eq(tasks.userId, userId));
    const result = await retryOnDeadlock(() =>
      db.transaction(async (tx) => {
        // The list's tasks are locked before the list, the order a task update
        // takes them in (the task, then its list through tasks_list_fk), so a
        // task being completed or moved meanwhile finishes first.
        await tx.select({ id: tasks.id }).from(tasks).where(inList).for('update');
        // Locking the list waits for tasks being added to it or moved into it
        // right now, and makes those that come later fail (the API answers
        // them invalid_list). The update below then sees every task in it.
        const [list] = await tx
          .select({ id: lists.id })
          .from(lists)
          .where(and(eq(lists.id, id), eq(lists.userId, userId)))
          .for('update');
        if (!list) return null;
        const moved = await tx
          .update(tasks)
          .set({ listId: null, updatedAt: sql`now()` })
          .where(inList)
          .returning({ id: tasks.id });
        await tx.delete(lists).where(and(eq(lists.id, id), eq(lists.userId, userId)));
        return moved.map((task) => task.id).sort((a, b) => a - b);
      }),
    );
    if (result === null) return c.json(listNotFound, 404);
    return c.json({ movedTaskIds: result });
  });

  return routes;
}
