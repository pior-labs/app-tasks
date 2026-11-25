import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../db/schema.js';

export type AppDatabase = PostgresJsDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

// tasks.id and lists.id are 32-bit serials.
export const MAX_SERIAL_ID = 2_147_483_647;

// The PostgreSQL error behind a failed query. Drizzle wraps it as the cause.
export function databaseError(error: unknown): { code?: string; constraint_name?: string } | null {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') {
      return current as { code: string; constraint_name?: string };
    }
  }
  return null;
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
