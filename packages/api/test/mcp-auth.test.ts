import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createApp } from '../src/app.js';
import * as schema from '../src/db/schema.js';
import { createFixture } from './fixture.js';
import { addTaskRequest, connect, initializeRequest, listen, memberTokens, ok, rpc, send } from './mcp-support.js';
import { appOrigin, signIn } from './session.js';

// The MCP endpoint's boundary: who may reach it, and that it reaches nothing
// else. The criteria named below are those of the MCP server task.

const { tokens, config } = memberTokens();
let fixture: Awaited<ReturnType<typeof createFixture>>;
let http: Awaited<ReturnType<typeof listen>>;
let one: string;
let two: string;
before(async () => {
  fixture = await createFixture(appOrigin, { mcp: { tokens: config, timeZone: 'America/Toronto' } });
  http = await listen(fixture.app);
  one = await signIn(fixture, 0);
  two = await signIn(fixture, 1);
});
beforeEach(async () => {
  await fixture.client`delete from tasks`;
  await fixture.client`delete from lists`;
});
after(async () => {
  await http?.close();
  await fixture?.close();
});

const taskCount = async () => Number((await fixture.client`select count(*)::int as n from tasks`)[0].n);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// Every refused request answers 401 with a Bearer challenge, and runs no MCP:
// a tools/call that would add a task adds nothing.
async function assertUnauthorized(response: Response, tokenSupplied: boolean) {
  assert.equal(response.status, 401);
  assert.equal(
    response.headers.get('WWW-Authenticate'),
    tokenSupplied ? 'Bearer realm="tasks", error="invalid_token"' : 'Bearer realm="tasks"',
  );
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(Object.keys(await response.json()), ['error', 'message']);
}

test('the SDK client initializes and lists exactly the seven tools with their annotations (AC-1)', async () => {
  fixture.setNow(new Date('2026-11-20T12:00:00Z'));
  try {
    const client = await connect(http.url, tokens.one);
    assert.equal(client.getServerVersion()?.name, 'tasks');
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /Today is 2026-11-20 \(Friday\)/);
    assert.match(instructions, /America\/Toronto/);
    assert.match(instructions, /acts as Household One/);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(Object.keys(byName).sort(), [
      'add_task',
      'complete_task',
      'delete_task',
      'list_lists',
      'list_tasks',
      'reopen_task',
      'update_task',
    ]);
    const hints = (name: string) => {
      const { readOnlyHint, destructiveHint, idempotentHint } = byName[name].annotations ?? {};
      return { readOnlyHint, destructiveHint, idempotentHint };
    };
    assert.deepEqual(hints('list_lists'), { readOnlyHint: true, destructiveHint: undefined, idempotentHint: undefined });
    assert.deepEqual(hints('list_tasks'), { readOnlyHint: true, destructiveHint: undefined, idempotentHint: undefined });
    assert.deepEqual(hints('add_task'), { readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    assert.deepEqual(hints('update_task'), { readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    assert.deepEqual(hints('complete_task'), { readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    assert.deepEqual(hints('reopen_task'), { readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    assert.deepEqual(hints('delete_task'), { readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    const properties = (name: string) => Object.keys((byName[name].inputSchema.properties ?? {}) as object).sort();
    assert.deepEqual(properties('list_lists'), []);
    assert.deepEqual(properties('list_tasks'), [
      'assigned_to_me',
      'due_from',
      'due_to',
      'include_completed',
      'limit',
      'list',
      'overdue',
      'search',
    ]);
    assert.deepEqual(properties('add_task'), ['assignee', 'due_date', 'list', 'notes', 'repeat', 'title']);
    assert.deepEqual(byName.add_task.inputSchema.required, ['title']);
    assert.deepEqual(properties('update_task'), ['assignee', 'due_date', 'list', 'notes', 'repeat', 'task_id', 'title']);
    assert.deepEqual(byName.update_task.inputSchema.required, ['task_id']);
    for (const name of ['complete_task', 'reopen_task', 'delete_task']) {
      assert.deepEqual(properties(name), ['task_id']);
      assert.deepEqual(byName[name].inputSchema.required, ['task_id']);
    }
    // AC-3: identity comes only from the token. No tool takes a user, owner or email.
    for (const tool of tools) {
      for (const property of Object.keys((tool.inputSchema.properties ?? {}) as object)) {
        assert.doesNotMatch(property, /user|owner|email|member|creator/i, `${tool.name}.${property}`);
      }
    }
    await client.close();
  } finally {
    fixture.setNow(null);
  }
});

test('a missing, malformed, wrong or revoked token answers 401 and runs nothing (AC-2)', async (t) => {
  const cases: [string, Record<string, string>, boolean][] = [
    ['no Authorization header', {}, false],
    ['the Basic scheme', { Authorization: `Basic ${Buffer.from(`one:${tokens.one}`).toString('base64')}` }, true],
    ['Bearer without a token', { Authorization: 'Bearer' }, true],
    ['Bearer with an empty token', { Authorization: 'Bearer ' }, true],
    ['two tokens', { Authorization: `Bearer ${tokens.one} ${tokens.two}` }, true],
    ['the token without a scheme', { Authorization: tokens.one }, true],
    ['a wrong token', bearer('not-a-real-token')],
    ['a token one character short', bearer(tokens.one.slice(0, -1))],
    ['the configured hash used as the token', bearer(config[0].hash.toString('hex'))],
    ['a revoked (never configured) token', bearer('revoked-token-that-was-removed-from-the-config')],
    ['a token for an email with no Tasks user', bearer(tokens.stranger)],
  ].map(([name, headers, supplied]) => [name as string, headers as Record<string, string>, (supplied ?? true) as boolean]);
  for (const [name, headers, supplied] of cases) {
    await t.test(name, async () => {
      await assertUnauthorized(await rpc(http.url, headers), supplied);
      await assertUnauthorized(await rpc(http.url, headers, addTaskRequest('Should not exist')), supplied);
      assert.equal(await taskCount(), 0);
    });
  }
});

test('the bearer scheme name is case-insensitive and a rotated token works alongside the old one (AC-2)', async () => {
  for (const header of [`Bearer ${tokens.one}`, `bearer ${tokens.one}`, `BEARER ${tokens.oneRotated}`]) {
    const response = await rpc(http.url, { Authorization: header });
    assert.equal(response.status, 200, header.split(' ')[0]);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    assert.equal(body.result.serverInfo.name, 'tasks');
  }
});

test('with no tokens configured every request answers 401 (AC-2)', async () => {
  const unconfigured = createApp(fixture.auth, drizzle(fixture.client, { schema }), appOrigin, { now: fixture.now });
  const server = await listen(unconfigured);
  try {
    for (const headers of [{}, bearer(tokens.one), bearer(tokens.two)]) {
      await assertUnauthorized(await rpc(server.url, headers), 'Authorization' in headers);
      await assertUnauthorized(await rpc(server.url, headers, addTaskRequest('Should not exist')), 'Authorization' in headers);
    }
    for (const method of ['GET', 'DELETE']) {
      await assertUnauthorized(await rpc(server.url, bearer(tokens.one), undefined, method), true);
    }
    assert.equal(await taskCount(), 0);
  } finally {
    await server.close();
  }
});

test('a Tasks session cookie alone does not authorize /api/mcp, and does not choose who a token acts as (AC-2, AC-3)', async () => {
  await assertUnauthorized(await rpc(http.url, { Cookie: one }), false);
  await assertUnauthorized(await rpc(http.url, { Cookie: one, Origin: appOrigin }, addTaskRequest('Cookie only')), false);
  await assertUnauthorized(await rpc(http.url, { Cookie: one, Authorization: 'Bearer wrong' }), true);
  assert.equal(await taskCount(), 0);
  // Member two's cookie with member one's token acts as member one.
  const response = await rpc(http.url, { Cookie: two, ...bearer(tokens.one) }, addTaskRequest('Added as one'));
  assert.equal(response.status, 200);
  const [row] = await fixture.client`
    select t.created_by_id, u.email from tasks t join users u on u.id = t.user_id where t.title = 'Added as one'`;
  assert.equal(row.email, 'one@example.test');
});

test('a member token authorizes no other /api route (AC-2)', async () => {
  const requests: [string, string, unknown?][] = [
    ['GET', '/api/me'],
    ['GET', '/api/tasks'],
    ['POST', '/api/tasks', { title: 'Through the web API' }],
    ['GET', '/api/lists'],
    ['POST', '/api/lists', { name: 'Through the web API' }],
    ['GET', '/api/members'],
    ['POST', '/api/mcp/', initializeRequest],
    ['POST', '/api/mcp/tools', initializeRequest],
    ['POST', '/api/MCP', initializeRequest],
    ['POST', '/api/mcp.json', initializeRequest],
  ];
  for (const [method, path, body] of requests) {
    const response = await fetch(new URL(path, http.base), {
      method,
      headers: {
        ...bearer(tokens.one),
        Origin: appOrigin,
        Accept: 'application/json, text/event-stream',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: 'unauthorized' }, `${method} ${path}`);
  }
  assert.equal(await taskCount(), 0);
  assert.equal(Number((await fixture.client`select count(*)::int as n from lists`)[0].n), 0);
  // The session routes still work with a session.
  assert.equal((await send(fixture, one, 'GET', '/api/tasks')).status, 200);
});

test('a foreign Origin answers 403 and runs nothing, the app origin is allowed (AC-2)', async () => {
  for (const origin of ['https://evil.example', 'http://localhost:5174', 'null', 'http://127.0.0.1:5173']) {
    for (const headers of [{ Origin: origin, ...bearer(tokens.one) }, { Origin: origin }]) {
      const response = await rpc(http.url, headers, addTaskRequest('From another origin'));
      assert.equal(response.status, 403, origin);
      assert.equal((await response.json()).error, 'forbidden_origin');
    }
  }
  assert.equal(await taskCount(), 0);
  const allowed = await rpc(http.url, { Origin: appOrigin, ...bearer(tokens.one) });
  assert.equal(allowed.status, 200);
});

test('GET, DELETE and other methods answer 405 with a valid token, 401 without (AC-2)', async () => {
  for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
    const response = await rpc(http.url, bearer(tokens.one), addTaskRequest('Wrong method'), method);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('Allow'), 'POST');
    await assertUnauthorized(await rpc(http.url, {}, addTaskRequest('Wrong method'), method), false);
  }
  assert.equal(await taskCount(), 0);
});

test('no token, Authorization header, request body or task content is logged (AC-12)', async () => {
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const originals = methods.map((name) => console[name]);
  for (const name of methods) console[name] = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const title = 'Secret broccoli errand 7f3a';
  // A database that fails inside the tool, with the title in its error message.
  const failingDb = new Proxy(drizzle(fixture.client, { schema }), {
    get(target, property, receiver) {
      if (property === 'transaction') return () => Promise.reject(new Error(`insert failed for ${title}`));
      return Reflect.get(target, property, receiver);
    },
  });
  const failing = await listen(
    createApp(fixture.auth, failingDb, appOrigin, { now: fixture.now, mcp: { tokens: config, timeZone: 'America/Toronto' } }),
  );
  let failedResult: unknown;
  try {
    // Refused: a wrong token, a revoked one, and an email with no user, each carrying the title.
    for (const token of ['wrong-token-abc', tokens.stranger, `${tokens.one}x`]) {
      assert.equal((await rpc(http.url, bearer(token), addTaskRequest(title))).status, 401);
    }
    assert.equal((await rpc(http.url, {}, addTaskRequest(title))).status, 401);
    assert.equal((await rpc(http.url, { Origin: 'https://evil.example', ...bearer(tokens.one) }, addTaskRequest(title))).status, 403);
    // A tool that fails on the server.
    const response = await rpc(failing.url, bearer(tokens.one), addTaskRequest(title));
    assert.equal(response.status, 200);
    failedResult = (await response.json()).result;
    // A tool error and a success.
    const client = await connect(http.url, tokens.one);
    await client.callTool({ name: 'add_task', arguments: { title, list: 'No such list' } });
    await ok(client, 'add_task', { title, notes: `notes for ${title}` });
    await client.close();
  } finally {
    for (const [index, name] of methods.entries()) console[name] = originals[index];
    await failing.close();
  }
  // The failed tool answered without the raw error.
  assert.equal((failedResult as { isError: boolean }).isError, true);
  assert.doesNotMatch(JSON.stringify(failedResult), /insert failed|7f3a/);
  const output = lines.join('\n');
  assert.ok(lines.length > 0, 'the refused requests log a generic reason');
  assert.match(output, /MCP request refused: (no credentials|unknown token|the member has no Tasks account yet)/);
  assert.match(output, /MCP tool failed add_task Error/);
  for (const secret of [title, '7f3a', tokens.one, tokens.stranger, 'wrong-token-abc', 'Bearer', 'broccoli', 'one@example.test', 'three@example.test']) {
    assert.ok(!output.includes(secret), `the log contains ${secret === title ? 'the title' : 'a credential or email'}`);
  }
  for (const line of lines) assert.match(line, /^MCP (request refused|tool failed)/, 'only the MCP lines were logged');
});
