import { asc } from 'drizzle-orm';
import { users } from '../db/schema.js';
import type { AppDatabase } from './database.js';

// The household is every Tasks user: everyone who has signed in to Tasks at
// least once. The web client names who added, completed or is assigned a task
// in a shared list with this, and offers them in the "Assigned to" select;
// the MCP tools name members the same way. Only ids and display names, never
// email addresses (D-9).
export type Member = { id: number; name: string };
export async function listMembers(db: AppDatabase): Promise<Member[]> {
  return db.select({ id: users.id, name: users.name }).from(users).orderBy(asc(users.name), asc(users.id));
}
