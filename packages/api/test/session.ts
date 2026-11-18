import assert from 'node:assert/strict';
import type { createFixture } from './fixture.js';

type Fixture = Awaited<ReturnType<typeof createFixture>>;

export const appOrigin = 'http://localhost:5173';

export function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .filter((value) => !value.endsWith('='))
    .join('; ');
}

// Complete the fixture SSO flow and return the application session cookie.
export async function signIn(fixture: Fixture, user = 0) {
  const started = await fixture.app.request(`${appOrigin}/api/auth/sign-in/social`, {
    method: 'POST',
    headers: { Origin: appOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'auth-pior',
      callbackURL: '/',
      errorCallbackURL: '/?error=sign-in',
    }),
  });
  assert.equal(started.status, 200);
  const approval = new URL((await started.json()).url);
  approval.pathname = '/approve';
  approval.searchParams.set('user', String(user));
  const approved = await fetch(approval, { redirect: 'manual' });
  assert.equal(approved.status, 302);
  const callback = await fixture.app.request(approved.headers.get('location')!, {
    headers: { Cookie: cookie(started) },
  });
  assert.equal(callback.status, 302);
  const sessionCookie = cookie(callback);
  assert.match(sessionCookie, /tasks.session_token=/);
  return sessionCookie;
}

export async function signOut(fixture: Fixture, sessionCookie: string) {
  const response = await fixture.app.request('/api/auth/sign-out', {
    method: 'POST',
    headers: { Cookie: sessionCookie, Origin: appOrigin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
}
