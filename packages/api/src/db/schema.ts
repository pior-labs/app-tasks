import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();

// service-auth owns identities; these rows belong exclusively to this app.
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
export const sessions = pgTable(
  'sessions',
  {
    id: serial('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
);
export const accounts = pgTable(
  'accounts',
  {
    id: serial('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('accounts_user_id_idx').on(table.userId),
    uniqueIndex('accounts_provider_subject_idx').on(table.providerId, table.accountId),
  ],
);
export const verifications = pgTable(
  'verifications',
  {
    id: serial('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);

// Lists the user names, such as "Home" or "Errands". Inbox is not a row: a
// task with no list (list_id null) is in Inbox. user_id is the list's owner
// (its creator, for good). Every query filters by access (accessibleList in
// packages/api/src/access.ts): the owner's lists, plus every shared list.
export const lists = pgTable(
  'lists',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Shared with the household: every Tasks user can see the list and its
    // tasks and do everything with them that the owner can.
    shared: boolean('shared').default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One user cannot have two lists whose names differ only in letter case.
    // It also serves lookups by user_id, its first column.
    uniqueIndex('lists_user_id_name_idx').on(table.userId, sql`lower(${table.name})`),
    // Finds the shared lists, which every access check and listing includes
    // next to the user's own (the user_id index above serves those).
    index('lists_shared_idx').on(table.id).where(sql`${table.shared}`),
    // The target of the tasks foreign key below, which pairs a list with its owner.
    unique('lists_id_user_id_unique').on(table.id, table.userId),
    // char_length counts code points, like the API and the web form, so an
    // emoji is one of the 50 characters.
    check('lists_name_length_check', sql`char_length(${table.name}) between 1 and 50`),
  ],
);

// Task rows belong to exactly one app-local user (user_id), who is the owner
// of the task's list when it is in one (tasks_list_fk). Every query filters by
// access (accessibleTask in packages/api/src/access.ts): the user's own tasks,
// plus every task in a shared list.
export const tasks = pgTable(
  'tasks',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // The list the task is in, or null for Inbox. See tasks_list_fk below.
    listId: integer('list_id'),
    // Optional plain-text notes, null when there are none. Never an empty
    // string: the API stores notes with nothing visible as null.
    notes: text('notes'),
    completed: boolean('completed').default(false).notNull(),
    // A calendar date without a time or timezone. String mode keeps it as
    // "YYYY-MM-DD" end to end, so no timezone conversion can shift the day.
    dueDate: date('due_date', { mode: 'string' }),
    // A repeat is an interval: every `repeat_every` days, weeks, months or
    // years. Both are null for a task that does not repeat.
    repeatUnit: text('repeat_unit'),
    repeatEvery: integer('repeat_every'),
    // The day the schedule counts from: the due date when the repeat was set
    // or the due date last changed. Occurrences are this day plus whole
    // intervals (months and years keep its day of month, clamped to shorter
    // months), so month-end schedules do not drift. Internal, never returned.
    repeatAnchor: date('repeat_anchor', { mode: 'string' }),
    // The occurrence whose completion created this task. Unique, so one
    // completed occurrence can never have two next occurrences.
    repeatedFromId: integer('repeated_from_id')
      .references((): AnyPgColumn => tasks.id, { onDelete: 'set null' })
      .unique('tasks_repeated_from_id_unique'),
    // Who added the task, who completed it (null while open, and for tasks
    // completed before this was recorded), and the member it is assigned to
    // (only in a shared list). Deleting a user clears these on other users'
    // tasks instead of deleting them.
    createdById: integer('created_by_id'),
    completedById: integer('completed_by_id'),
    assigneeId: integer('assignee_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('tasks_user_id_idx').on(table.userId),
    index('tasks_list_id_idx').on(table.listId),
    // The list and the task have the same owner, so the database itself refuses
    // a task in another user's list. A list that tasks still point at cannot be
    // deleted (no action): the API moves its tasks to Inbox first.
    // A task added to another member's shared list is stored with the list
    // owner's user_id (and the adder in created_by_id), so this holds for
    // shared lists too.
    foreignKey({
      name: 'tasks_list_fk',
      columns: [table.listId, table.userId],
      foreignColumns: [lists.id, lists.userId],
    }),
    foreignKey({ name: 'tasks_created_by_fk', columns: [table.createdById], foreignColumns: [users.id] }).onDelete('set null'),
    foreignKey({ name: 'tasks_completed_by_fk', columns: [table.completedById], foreignColumns: [users.id] }).onDelete('set null'),
    foreignKey({ name: 'tasks_assignee_fk', columns: [table.assigneeId], foreignColumns: [users.id] }).onDelete('set null'),
    // char_length counts code points, like the API and the web form, so an
    // emoji is one of the 5000 characters.
    check('tasks_notes_length_check', sql`${table.notes} is null or char_length(${table.notes}) between 1 and 5000`),
    check('tasks_repeat_unit_check', sql`${table.repeatUnit} in ('day', 'week', 'month', 'year')`),
    check('tasks_repeat_every_check', sql`${table.repeatEvery} between 1 and 99`),
    // A repeat is all or nothing: unit, interval and anchor together.
    check(
      'tasks_repeat_complete_check',
      sql`(${table.repeatUnit} is null) = (${table.repeatEvery} is null) and (${table.repeatUnit} is null) = (${table.repeatAnchor} is null)`,
    ),
  ],
);
