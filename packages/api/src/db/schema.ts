import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
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

// Task rows belong to exactly one app-local user; every query filters on user_id.
export const tasks = pgTable(
  'tasks',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('tasks_user_id_idx').on(table.userId),
    check('tasks_repeat_unit_check', sql`${table.repeatUnit} in ('day', 'week', 'month', 'year')`),
    check('tasks_repeat_every_check', sql`${table.repeatEvery} between 1 and 99`),
    // A repeat is all or nothing: unit, interval and anchor together.
    check(
      'tasks_repeat_complete_check',
      sql`(${table.repeatUnit} is null) = (${table.repeatEvery} is null) and (${table.repeatUnit} is null) = (${table.repeatAnchor} is null)`,
    ),
  ],
);
