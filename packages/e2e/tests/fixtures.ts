import { type APIRequestContext, test as base, expect } from '@playwright/test';

// The one test function every spec file uses. Before each test it puts the
// test API (packages/api/test/e2e-server.ts) back to a known state: the real
// clock, and no lists or tasks for anyone. So a test sees only what it
// creates, may reuse names other tests use, and needs no clean-up, and the
// spec files can run in any order. The run still shares one API, so the tests
// run one after another (playwright.config.ts).
//
// The API checks the "today" a completing browser sends against its own date,
// so a test that fixes the browser clock sets the API clock to the same moment
// with setServerClock. Both keep running from there.
export const apiOrigin = `http://localhost:${process.env.E2E_API_PORT ?? 3173}`;

export async function setServerClock(request: APIRequestContext, time: Date | null) {
  const response = await request.put(`${apiOrigin}/e2e/clock`, { data: { time: time?.toISOString() ?? null } });
  expect(response.ok()).toBe(true);
}

export const test = base.extend<{ freshApi: void }>({
  freshApi: [
    async ({ request }, use) => {
      await setServerClock(request, null);
      const response = await request.post(`${apiOrigin}/e2e/reset`);
      expect(response.ok()).toBe(true);
      await use();
    },
    { auto: true },
  ],
});

export { expect };
