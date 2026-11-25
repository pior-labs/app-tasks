import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { accessibleList, accessibleListById } from '../access.js';
import { lists, tasks, users } from '../db/schema.js';
import { type AppDatabase, type Transaction, MAX_SERIAL_ID, databaseError, retryOnDeadlock } from './database.js';
import { type Failure, type Result, failure, success } from './result.js';
import { VISIBLE_CHARACTER } from './tasks.js';

// The list rules shared by the web API (src/lists.ts) and the MCP tools
// (src/mcp/tools.ts). Every function takes the acting user's id.

export const MAX_LIST_NAME_LENGTH = 50;
// So the tab row stays usable. The web client shows the error.
export const MAX_LISTS = 50;
// When two list names count as the same, and whether a name is a built-in
// view's: both compare what a person would see. The fold applies Unicode NFKC
// (fullwidth and other compatibility forms become their plain letters), turns
// any run of white space (a no-break space, repeated spaces) into one space,
// drops invisible code points (default ignorables such as a zero width space,
// joiners, direction marks and the soft hyphen, and control characters),
// applies NFKC again (so an invisible one between a letter and its combining
// mark does not keep them apart), trims, and lowercases. Letters from other
// scripts that only look Latin are not folded. Names are stored as typed;
// only these checks use the folded form. The web form folds the same way
// (foldListName in packages/web/src/lists.ts). The MCP tools find lists and
// members by name with it too.
export const foldListName = (name: string) =>
  name
    .normalize('NFKC')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, '')
    .normalize('NFKC')
    .replace(/ +/g, ' ')
    .trim()
    .toLowerCase();
// The built-in views. A list whose name folds to one of them would look like
// its tab. Names that merely contain the words, such as "Inbox zero" or
// "Assigned to me later", are allowed. Lists stored with such a name before it
// was reserved keep it; only creates and renames to it are refused.
const RESERVED_LIST_NAMES = ['inbox', 'all tasks', 'assigned to me'];
const isReservedListName = (name: string) => RESERVED_LIST_NAMES.includes(foldListName(name));

// The one definition of a valid list name, used by both create and rename. The
// rules are those of task titles (services/tasks.ts): trimmed, at least one
// visible character, no U+0000, and the length in code points. The database
// checks the same length (lists_name_length_check). Names are stored as typed.
// A user's names are unique by their fold (foldListName), which the service
// checks; the database index on lower(name) (lists_user_id_name_idx) stays as
// a backstop. The web forms apply the same rules (listNameProblem in
// packages/web/src/lists.ts).
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
    error: '"Inbox", "All tasks" and "Assigned to me" are built in. Choose another name.',
  });
// Create takes a name. Unknown keys (such as an owner, an id or shared) are
// dropped: a new list is never shared (sharing is a change to an existing list).
const listBody = z.object({ name: listName }, { error: 'Send a JSON object with a name.' });
// An update renames the list, shares or unshares it, or both. The first
// invalid field decides the error code (name before shared), and a body with
// neither (or that is not an object) answers invalid_list_update. Unknown keys
// are dropped.
const UPDATE_LIST_MESSAGE = 'Send a JSON object with a name, a shared value, or both.';
const invalidListUpdate: Failure = { kind: 'invalid', error: 'invalid_list_update', message: UPDATE_LIST_MESSAGE };
const listUpdateBody = z.object(
  {
    name: listName.optional(),
    shared: z.boolean({ error: 'Shared must be true or false.' }).optional(),
  },
  { error: UPDATE_LIST_MESSAGE },
);
const listUpdateError = (field: PropertyKey | undefined) =>
  field === 'name' ? 'invalid_list_name' : field === 'shared' ? 'invalid_shared' : 'invalid_list_update';

// The API shape of a list. ownerId is the user who created (and owns) it;
// shared lists are listed for every user, so the client needs it to tell
// whose a list is.
const listColumns = {
  id: lists.id,
  name: lists.name,
  shared: lists.shared,
  ownerId: lists.userId,
  createdAt: lists.createdAt,
  updatedAt: lists.updatedAt,
};
export type List = { id: number; name: string; shared: boolean; ownerId: number; createdAt: Date; updatedAt: Date };

const listNotFound: Failure = { kind: 'not_found', error: 'list_not_found', message: 'That list could not be found.' };
const duplicateName: Failure = {
  kind: 'conflict',
  error: 'duplicate_list_name',
  message: 'You already have a list with that name.',
};
// Names are unique among the owner's lists (D-3), so a member renaming
// someone else's shared list hears about the owner's lists.
const ownersDuplicateName: Failure = {
  kind: 'conflict',
  error: 'duplicate_list_name',
  message: 'The owner of this list already has a list with that name.',
};
const limitReached: Failure = {
  kind: 'conflict',
  error: 'list_limit_reached',
  message: `You can have at most ${MAX_LISTS} lists. Delete one to make room.`,
};
// The fold decides duplicates, but PostgreSQL's lower() can fold a letter that
// JavaScript's toLowerCase() does not (it turns a dotted capital I into a plain
// i), so the index can still refuse a name the fold allows. That answers 409
// too.
const isDuplicateName = (error: unknown) => {
  const cause = databaseError(error);
  return cause?.code === '23505' && cause.constraint_name === 'lists_user_id_name_idx';
};

// Serialises one user's list creates and renames (see createList).
const lockListsOf = (tx: Transaction, userId: number) =>
  tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('no key update');

// The user's own lists and every shared list, oldest first, in the order
// they were created.
export async function listLists(db: AppDatabase, userId: number): Promise<List[]> {
  return db
    .select(listColumns)
    .from(lists)
    .where(accessibleList(userId))
    .orderBy(asc(lists.createdAt), asc(lists.id));
}

// Creates a list from a body in the web API's shape (listBody).
export async function createList(db: AppDatabase, userId: number, body: unknown): Promise<Result<List>> {
  const parsed = listBody.safeParse(body);
  if (!parsed.success) {
    return failure({ kind: 'invalid', error: 'invalid_list_name', message: parsed.error.issues[0].message });
  }
  try {
    return await db.transaction(async (tx): Promise<Result<List>> => {
      // Locking the user's row makes list creates and renames for one user
      // run one after another, so parallel requests cannot pass the limit or
      // add two names with the same fold. This lock does not block task
      // writes, which only take a key share on the user row.
      await lockListsOf(tx, userId);
      const existing = await tx.select({ name: lists.name }).from(lists).where(eq(lists.userId, userId));
      if (existing.length >= MAX_LISTS) return failure(limitReached);
      const folded = foldListName(parsed.data.name);
      if (existing.some((list) => foldListName(list.name) === folded)) {
        return failure(duplicateName);
      }
      const [list] = await tx.insert(lists).values({ userId, name: parsed.data.name }).returning(listColumns);
      return success(list);
    });
  } catch (error) {
    if (isDuplicateName(error)) return failure(duplicateName);
    throw error;
  }
}

// Renames, shares or unshares a list the user can access (their own or a
// shared one): every member has the owner's rights on a shared list. Name
// checks compare the owner's lists, so a member's own lists do not matter.
export async function updateList(
  db: AppDatabase,
  userId: number,
  id: number,
  body: unknown,
): Promise<Result<List>> {
  const parsed = listUpdateBody.safeParse(body);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const error = listUpdateError(issue.path[0]);
    return failure(error === 'invalid_list_update' ? invalidListUpdate : { kind: 'invalid', error, message: issue.message });
  }
  const { name, shared } = parsed.data;
  if (name === undefined && shared === undefined) return failure(invalidListUpdate);
  // Unknown ids and lists the user cannot access are indistinguishable.
  if (id > MAX_SERIAL_ID) return failure(listNotFound);
  try {
    return await retryOnDeadlock(() =>
      db.transaction(async (tx): Promise<Result<List>> => {
        const [found] = await tx
          .select({ ownerId: lists.userId })
          .from(lists)
          .where(accessibleListById(userId, id));
        if (!found) return failure(listNotFound);
        const { ownerId } = found;
        // A rename takes the owner's lock, as create does, so a rename and a
        // create (or two renames) cannot both take one fold.
        if (name !== undefined) await lockListsOf(tx, ownerId);
        // Unsharing clears the assignees of the list's tasks. Its tasks are
        // locked before the list, the order a list delete takes them in, so
        // the two cannot deadlock, and a task change in progress (which
        // holds the task and then shares the list lock) finishes first.
        if (shared === false) {
          await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.listId, id)).for('update');
        }
        // Locked and checked again: it may have been unshared or deleted
        // since the first look.
        const [current] = await tx
          .select({ name: lists.name })
          .from(lists)
          .where(accessibleListById(userId, id))
          .for('update');
        if (!current) return failure(listNotFound);
        if (name !== undefined) {
          const existing = await tx
            .select({ id: lists.id, name: lists.name })
            .from(lists)
            .where(eq(lists.userId, ownerId));
          // Only a new fold is checked: a list may keep its own fold (another
          // letter case, say) even if another list already shares it, which
          // only lists stored before this check can.
          const folded = foldListName(name);
          if (
            folded !== foldListName(current.name) &&
            existing.some((list) => list.id !== id && foldListName(list.name) === folded)
          ) {
            return failure(ownerId === userId ? duplicateName : ownersDuplicateName);
          }
        }
        const [list] = await tx
          .update(lists)
          .set({
            ...(name === undefined ? {} : { name }),
            ...(shared === undefined ? {} : { shared }),
            updatedAt: sql`now()`,
          })
          .where(eq(lists.id, id))
          .returning(listColumns);
        // Only a task in a shared list has an assignee. The tasks stay the
        // owner's (they already have the owner's user_id, see tasks_list_fk),
        // including those other members added (D-2).
        if (!list.shared) {
          await tx
            .update(tasks)
            .set({ assigneeId: null, updatedAt: sql`now()` })
            .where(and(eq(tasks.listId, id), sql`${tasks.assigneeId} is not null`));
        }
        return success(list);
      }),
    );
  } catch (error) {
    if (isDuplicateName(error)) return failure(duplicateName);
    throw error;
  }
}

// Deleting a list never deletes a task: its tasks, open and completed, move
// to Inbox in the same transaction, and the answer names them so the client
// can move them without reloading. Any member may delete a shared list; its
// tasks then go to the Inbox of whoever added each one (the list owner when
// that is unknown), so nobody loses their own tasks (D-4), and lose their
// assignee. An unshared list's tasks go to the owner's Inbox (D-2).
export async function deleteList(db: AppDatabase, userId: number, id: number): Promise<Result<number[]>> {
  if (id > MAX_SERIAL_ID) return failure(listNotFound);
  const inList = eq(tasks.listId, id);
  const result = await retryOnDeadlock(() =>
    db.transaction(async (tx) => {
      // Nothing is locked for a list the user cannot access.
      const [visible] = await tx.select({ id: lists.id }).from(lists).where(accessibleListById(userId, id));
      if (!visible) return null;
      // The list's tasks are locked before the list, the order a task update
      // takes them in (the task, then its list), so a task being completed
      // or moved meanwhile finishes first.
      await tx.select({ id: tasks.id }).from(tasks).where(inList).for('update');
      // Locking the list waits for tasks being added to it or moved into it
      // right now, and makes those that come later fail (the API answers
      // them invalid_list). The update below then sees every task in it.
      // Checked again, as it may have been unshared meanwhile.
      const [list] = await tx
        .select({ shared: lists.shared })
        .from(lists)
        .where(accessibleListById(userId, id))
        .for('update');
      if (!list) return null;
      const moved = await tx
        .update(tasks)
        .set({
          listId: null,
          ...(list.shared ? { userId: sql`coalesce(${tasks.createdById}, ${tasks.userId})`, assigneeId: null } : {}),
          updatedAt: sql`now()`,
        })
        .where(inList)
        .returning({ id: tasks.id });
      await tx.delete(lists).where(eq(lists.id, id));
      return moved.map((task) => task.id).sort((a, b) => a - b);
    }),
  );
  return result === null ? failure(listNotFound) : success(result);
}
