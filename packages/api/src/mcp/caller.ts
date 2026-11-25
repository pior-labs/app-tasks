import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { users } from '../db/schema.js';
import type { AppDatabase } from '../services/database.js';
import type { MemberToken } from './config.js';

// The one place that decides who an MCP request acts as (the caller seam).
// Everything after it (src/mcp/route.ts, the tools) only sees the ActingUser,
// so replacing member tokens with OAuth through service-auth means replacing
// this module: verify the access token instead of comparing hashes, map its
// subject to a Tasks user, and add the resource metadata to the 401 answer
// (docs/decisions/0001-mcp-member-tokens.md).
//
// Identity comes only from the credential. No tool takes a user, owner or
// email argument.

export type ActingUser = { id: number; name: string };
export type Caller = { ok: true; user: ActingUser } | { ok: false; response: Response };

// RFC 6750: without credentials the challenge carries no error code; with a
// credential that did not work it says invalid_token. The answer is the same
// for every kind of failure, so it reveals nothing about which one it was.
function unauthorized(tokenSupplied: boolean): Response {
  return new Response(
    JSON.stringify({ error: 'unauthorized', message: 'Send a Tasks member token as "Authorization: Bearer <token>".' }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': tokenSupplied ? 'Bearer realm="tasks", error="invalid_token"' : 'Bearer realm="tasks"',
      },
    },
  );
}

// Logs only a fixed reason: never the token, the header or the email.
function refuse(reason: string, tokenSupplied: boolean): Caller {
  console.warn(`MCP request refused: ${reason}`);
  return { ok: false, response: unauthorized(tokenSupplied) };
}

export function createCallerResolver(db: AppDatabase, tokens: MemberToken[]) {
  return async function resolveCaller(request: Request): Promise<Caller> {
    const header = request.headers.get('Authorization');
    if (header === null) return refuse('no credentials', false);
    const token = /^Bearer +([^\s]+) *$/i.exec(header)?.[1];
    if (token === undefined) return refuse('malformed credentials', true);
    if (tokens.length === 0) return refuse('no member tokens are configured', true);
    // Compare hashes, in constant time, with every configured entry, so the
    // time taken says nothing about which entry (if any) came close.
    const supplied = createHash('sha256').update(token, 'utf8').digest();
    let email: string | null = null;
    for (const entry of tokens) {
      if (timingSafeEqual(entry.hash, supplied) && email === null) email = entry.email;
    }
    if (email === null) return refuse('unknown token', true);
    // Resolved on every request, so a member who signs in to Tasks for the
    // first time after a deploy is found without a restart.
    const members = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);
    if (members.length !== 1) return refuse('the member has no Tasks account yet', true);
    return { ok: true, user: members[0] };
  };
}
