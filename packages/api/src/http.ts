import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from './app.js';
import type { Failure, FailureKind } from './services/result.js';

// What the web API routes (src/tasks.ts, src/lists.ts) share: reading the
// request, the session user, the origin check, and the answer for a service
// failure. The rules themselves live in src/services/.

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

// A route id is a positive decimal integer. Ids beyond the column range are
// well formed but cannot exist, so callers answer those with "not found".
export function routeId(raw: string): number | null {
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
}

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

const statusOf = { invalid: 400, not_found: 404, conflict: 409 } as const satisfies Record<FailureKind, number>;

// A service failure as the web API answers it: its status and { error, message }.
export function failed(c: Context, { kind, error, message }: Failure) {
  return c.json({ error, message }, statusOf[kind]);
}
