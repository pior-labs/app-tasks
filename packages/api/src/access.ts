import { type SQL, and, eq, or, sql } from 'drizzle-orm';
import { lists, tasks } from './db/schema.js';

// The one access rule for lists and tasks. A user can read and write:
//
// - a list they own, or any shared list (every Tasks user is the household);
// - a task they own (its user_id), or any task in a shared list.
//
// Every list and task route filters with these instead of user_id alone, so
// anything else stays "not found" (or invalid_list) exactly as for a list or
// task that does not exist. A task in a list always has the list owner's
// user_id (tasks_list_fk), so a task in someone else's unshared list is never
// accessible, and unsharing a list needs no task rewrite.
export const accessibleList = (userId: number): SQL =>
  or(eq(lists.userId, userId), eq(lists.shared, true))!;

export const accessibleTask = (userId: number): SQL =>
  or(
    eq(tasks.userId, userId),
    sql`exists (select 1 from ${lists} where ${lists.id} = ${tasks.listId} and ${lists.shared})`,
  )!;

export const accessibleListById = (userId: number, id: number): SQL => and(eq(lists.id, id), accessibleList(userId))!;
export const accessibleTaskById = (userId: number, id: number): SQL => and(eq(tasks.id, id), accessibleTask(userId))!;
