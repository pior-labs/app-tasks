import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import * as schema from '../src/db/schema.js';
import { createFixture } from './fixture.js';
import { appOrigin, signIn, signOut } from './session.js';

type Task = { id: number; title: string; completed: boolean; createdAt: string; updatedAt: string };
type App = { request: Awaited<ReturnType<typeof createFixture>>['app']['request'] };

let fixture: Awaited<ReturnType<typeof createFixture>>;
before(async () => {
  fixture = await createFixture();
});
after(async () => {
  await fixture?.close();
});

function send(
  session: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  { origin = appOrigin as string | null, app = fixture.app as App } = {},
) {
  return app.request(path, {
    method,
    headers: {
      Cookie: session,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(origin === null ? {} : { Origin: origin }),
    },
    body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// Title cases shared by the create tests and the rename tests, so both routes
// are held to the same rules.
const emoji = '\u{1F600}'; // one character, two UTF-16 units
const nullCharacterTitles = ['a\u0000b', '\u0000 leading', 'trailing\u0000'];
const tooLongTitles = ['x'.repeat(201), emoji.repeat(201), 'x'.repeat(199) + emoji + 'x'];
const longestTitles = [emoji.repeat(200), 'x'.repeat(199) + emoji];
// Whitespace, control and invisible characters only: these count as empty.
const invisibleTitles = [
  '​', // zero width space
  '​‌‍⁠', // zero width non-joiner, joiner, word joiner
  ' ​ ﻿ ',
  '­', // soft hyphen
  '‎‏', // direction marks
  'ㅤ', // Hangul filler
  ' 　', // no-break and ideographic spaces
  '\u0001\u001F',
  '\u0000', // a lone null character is also nothing visible
  '\u{E0001}', // language tag, outside the BMP
];
const nonTextTitles: unknown[] = [null, 42, ['a'], { text: 'a' }, true];
async function createTask(session: string, title: string): Promise<Task> {
  const response = await send(session, 'POST', '/api/tasks', { title });
  assert.equal(response.status, 201);
  return (await response.json()).task;
}
async function listTasks(session: string, app: App = fixture.app): Promise<Task[]> {
  const response = await app.request('/api/tasks', { headers: { Cookie: session } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await response.json()).tasks;
}
async function taskRowCount() {
  return (await fixture.client`select count(*)::int as count from tasks`)[0].count as number;
}
async function assertError(response: Response, status: number, error: string) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error, error);
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0);
}

test('a signed-in user creates tasks and lists them newest first (AC-1)', async () => {
  const session = await signIn(fixture, 0);
  assert.deepEqual(await listTasks(session), []);

  const first = await createTask(session, 'Buy oat milk');
  assert.equal(first.title, 'Buy oat milk');
  assert.equal(first.completed, false);
  assert.ok(Number.isInteger(first.id));
  assert.deepEqual(Object.keys(first).sort(), ['completed', 'createdAt', 'id', 'title', 'updatedAt']);

  // Surrounding whitespace is trimmed before storing.
  const second = await createTask(session, '   Water the plants \n');
  assert.equal(second.title, 'Water the plants');

  // A title of exactly 200 characters after trimming is accepted.
  const longest = await createTask(session, ` ${'x'.repeat(200)} `);
  assert.equal(longest.title.length, 200);

  const listed = await listTasks(session);
  assert.deepEqual(
    listed.map((task) => task.id),
    [longest.id, second.id, first.id],
  );
  assert.deepEqual(listed[2], first);

  const [me] = await fixture.client`select id from users where email = 'one@example.test'`;
  const rows = await fixture.client`select user_id, title, completed from tasks where id = ${first.id}`;
  assert.deepEqual({ ...rows[0] }, { user_id: me.id, title: 'Buy oat milk', completed: false });
});

test('invalid titles and bodies are rejected with 400 and create no row (AC-2)', async () => {
  const session = await signIn(fixture, 0);
  const before = await taskRowCount();
  const invalidTitles: unknown[] = [
    { title: '' },
    { title: '   ' },
    { title: '\t\n ' },
    { title: 'x'.repeat(201) },
    {},
    { title: null },
    { title: 42 },
    { title: ['a'] },
    { name: 'wrong key' },
    [],
    null,
    '"a bare JSON string"',
    '42',
  ];
  for (const body of invalidTitles) {
    const response = await send(session, 'POST', '/api/tasks', body);
    await assertError(response, 400, 'invalid_title');
  }
  const empty = await send(session, 'POST', '/api/tasks', { title: '  ' });
  assert.equal((await empty.json()).message, 'Enter a task title.');
  const tooLong = await send(session, 'POST', '/api/tasks', { title: 'x'.repeat(201) });
  assert.match((await tooLong.json()).message, /200 characters/);

  for (const raw of ['{"title": "unterminated', '', 'title=form']) {
    await assertError(await send(session, 'POST', '/api/tasks', raw), 400, 'invalid_json');
  }
  assert.equal(await taskRowCount(), before);
});

test('titles that cannot be stored or have nothing visible are rejected with 400 (AC-2)', async () => {
  const session = await signIn(fixture, 0);
  const before = await taskRowCount();
  const message = async (title: string) => {
    const response = await send(session, 'POST', '/api/tasks', { title });
    await assertError(response.clone(), 400, 'invalid_title');
    return (await response.json()).message as string;
  };

  // PostgreSQL text cannot store U+0000; this must be a validation error, not a 500.
  for (const title of nullCharacterTitles) {
    assert.match(await message(title), /null character/);
  }

  // Titles made only of whitespace, control and invisible characters count as empty.
  for (const title of invisibleTitles) {
    assert.equal(await message(title), 'Enter a task title.');
  }
  assert.equal(await taskRowCount(), before);

  // Invisible characters inside a visible title are stored unchanged.
  const joined = 'Family \u{1F468}‍\u{1F469}‍\u{1F467} dinner';
  assert.equal((await createTask(session, joined)).title, joined);
  const zeroWidth = 'a​b';
  assert.equal((await createTask(session, zeroWidth)).title, zeroWidth);
});

test('the 200 limit counts characters (code points), not UTF-16 units (AC-2)', async () => {
  const session = await signIn(fixture, 0);
  const before = await taskRowCount();
  for (const title of tooLongTitles) {
    const response = await send(session, 'POST', '/api/tasks', { title });
    await assertError(response.clone(), 400, 'invalid_title');
    assert.match((await response.json()).message, /200 characters/);
  }
  assert.equal(await taskRowCount(), before);

  for (const title of longestTitles) {
    const task = await createTask(session, `  ${title}  `);
    assert.equal(task.title, title);
    assert.equal([...task.title].length, 200);
    const [row] = await fixture.client`select char_length(title)::int as length from tasks where id = ${task.id}`;
    assert.equal(row.length, 200);
  }
});

test('a task can be completed and cleared again; invalid updates are rejected (AC-3)', async () => {
  const session = await signIn(fixture, 0);
  const task = await createTask(session, 'Toggle me');
  const stored = async () =>
    (await fixture.client`select completed from tasks where id = ${task.id}`)[0].completed;

  const completed = await send(session, 'PATCH', `/api/tasks/${task.id}`, { completed: true });
  assert.equal(completed.status, 200);
  const completedTask: Task = (await completed.json()).task;
  assert.deepEqual(
    { id: completedTask.id, title: completedTask.title, completed: completedTask.completed },
    { id: task.id, title: 'Toggle me', completed: true },
  );
  assert.equal(await stored(), true);
  assert.equal((await listTasks(session)).find((item) => item.id === task.id)?.completed, true);

  const cleared = await send(session, 'PATCH', `/api/tasks/${task.id}`, { completed: false });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).task.completed, false);
  assert.equal(await stored(), false);
  assert.equal((await listTasks(session)).find((item) => item.id === task.id)?.completed, false);

  await send(session, 'PATCH', `/api/tasks/${task.id}`, { completed: true });
  for (const body of [{ completed: 'true' }, { completed: 1 }, { completed: null }]) {
    const response = await send(session, 'PATCH', `/api/tasks/${task.id}`, body);
    await assertError(response, 400, 'invalid_completed');
  }
  // A body with neither field was "invalid_completed" before titles could be
  // updated; it now has its own code (see the rename tests below).
  for (const body of [{}, [], null]) {
    const response = await send(session, 'PATCH', `/api/tasks/${task.id}`, body);
    await assertError(response, 400, 'invalid_update');
  }
  await assertError(await send(session, 'PATCH', `/api/tasks/${task.id}`, '{bad'), 400, 'invalid_json');
  for (const id of ['abc', '0', '-1', '1.5', '1e3', `${task.id}abc`, '%20']) {
    const response = await send(session, 'PATCH', `/api/tasks/${id}`, { completed: false });
    await assertError(response, 400, 'invalid_task_id');
  }
  for (const id of ['999999', '2147483648', '9999999999999999']) {
    const response = await send(session, 'PATCH', `/api/tasks/${id}`, { completed: false });
    await assertError(response, 404, 'task_not_found');
  }
  // None of the rejected requests changed the stored state or title.
  const [row] = await fixture.client`select title, completed from tasks where id = ${task.id}`;
  assert.deepEqual({ ...row }, { title: 'Toggle me', completed: true });
});

test('tasks and completion persist across sign-out, a new session and a new app instance (AC-4)', async () => {
  const session = await signIn(fixture, 0);
  const open = await createTask(session, 'Persist while open');
  const done = await createTask(session, 'Persist while done');
  assert.equal(
    (await send(session, 'PATCH', `/api/tasks/${done.id}`, { completed: true })).status,
    200,
  );
  const expected = (await listTasks(session)).filter((task) => [open.id, done.id].includes(task.id));
  assert.deepEqual(
    expected.map(({ id, completed }) => ({ id, completed })),
    [
      { id: done.id, completed: true },
      { id: open.id, completed: false },
    ],
  );

  await signOut(fixture, session);
  assert.equal(
    (await fixture.app.request('/api/tasks', { headers: { Cookie: session } })).status,
    401,
  );

  const nextSession = await signIn(fixture, 0);
  assert.notEqual(nextSession, session);
  const afterSignIn = (await listTasks(nextSession)).filter((task) =>
    [open.id, done.id].includes(task.id),
  );
  assert.deepEqual(afterSignIn, expected);

  // A separately constructed auth + app on the same database stands in for an API restart.
  const restartedAuth = createAuth(fixture.client, {
    baseURL: appOrigin,
    issuer: fixture.issuer,
    discoveryUrl: `${fixture.issuer}/.well-known/openid-configuration`,
    clientId: 'tasks',
    clientSecret: 'fixture-client-secret',
    secret: 'fixture-session-secret-at-least-32-characters',
  });
  const restarted = createApp(restartedAuth, drizzle(fixture.client, { schema }), appOrigin);
  const afterRestart = (await listTasks(nextSession, restarted)).filter((task) =>
    [open.id, done.id].includes(task.id),
  );
  assert.deepEqual(afterRestart, expected);
  const reopened = await send(
    nextSession,
    'PATCH',
    `/api/tasks/${done.id}`,
    { completed: false },
    { app: restarted },
  );
  assert.equal(reopened.status, 200);
  assert.equal(
    (await listTasks(nextSession)).find((task) => task.id === done.id)?.completed,
    false,
  );
});

test('users only read and change their own tasks; the client cannot choose the owner (AC-5)', async () => {
  const [one, two] = await Promise.all([signIn(fixture, 0), signIn(fixture, 1)]);
  const [userOne] = await fixture.client`select id from users where email = 'one@example.test'`;
  const [userTwo] = await fixture.client`select id from users where email = 'two@example.test'`;
  const mine = await createTask(one, 'Owned by one');
  const theirs = await createTask(two, 'Owned by two');

  const listOne = await listTasks(one);
  const listTwo = await listTasks(two);
  assert.ok(listOne.some((task) => task.id === mine.id));
  assert.ok(listTwo.some((task) => task.id === theirs.id));
  assert.equal(
    listOne.some((task) => listTwo.some((other) => other.id === task.id)),
    false,
  );
  const ownersOne = await fixture.client`select distinct user_id from tasks where id = any(${listOne.map((task) => task.id)})`;
  assert.deepEqual(
    ownersOne.map((row) => row.user_id),
    [userOne.id],
  );

  // Updating another user's task looks exactly like updating a missing task.
  const foreign = await send(one, 'PATCH', `/api/tasks/${theirs.id}`, { completed: true });
  const missing = await send(one, 'PATCH', '/api/tasks/999999', { completed: true });
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), await missing.json());
  const [untouched] = await fixture.client`select user_id, title, completed, updated_at = created_at as unchanged from tasks where id = ${theirs.id}`;
  assert.deepEqual(
    { ...untouched },
    { user_id: userTwo.id, title: 'Owned by two', completed: false, unchanged: true },
  );

  // Owner fields supplied by the client are ignored on create and update. The
  // title in the update is applied now that PATCH accepts one; the owner is not.
  const spoofed = await send(one, 'POST', '/api/tasks', {
    title: 'Spoofed owner',
    userId: userTwo.id,
    user_id: userTwo.id,
    completed: true,
    id: theirs.id,
  });
  assert.equal(spoofed.status, 201);
  const spoofedTask: Task = (await spoofed.json()).task;
  assert.notEqual(spoofedTask.id, theirs.id);
  assert.equal(spoofedTask.completed, false);
  const moved = await send(one, 'PATCH', `/api/tasks/${spoofedTask.id}`, {
    completed: true,
    userId: userTwo.id,
    user_id: userTwo.id,
    title: 'Renamed',
  });
  assert.equal(moved.status, 200);
  const [spoofedRow] = await fixture.client`select user_id, title, completed from tasks where id = ${spoofedTask.id}`;
  assert.deepEqual(
    { ...spoofedRow },
    { user_id: userOne.id, title: 'Renamed', completed: true },
  );
  assert.equal(
    (await listTasks(two)).some((task) => task.id === spoofedTask.id),
    false,
  );
  // A query-string owner is ignored as well.
  const scoped = await fixture.app.request(`/api/tasks?userId=${userTwo.id}`, {
    headers: { Cookie: one },
  });
  assert.deepEqual((await scoped.json()).tasks, await listTasks(one));
});

test('task routes require a valid session (AC-5)', async () => {
  const session = await signIn(fixture, 0);
  const task = await createTask(session, 'Needs a session');
  const before = await taskRowCount();
  for (const value of [
    '',
    'tasks.session_token=invalid',
    `${session}tampered`,
    session.replaceAll('tasks', 'cookbook'),
  ]) {
    const responses = [
      await fixture.app.request('/api/tasks', { headers: { Cookie: value } }),
      await send(value, 'POST', '/api/tasks', { title: 'No session' }),
      await send(value, 'PATCH', `/api/tasks/${task.id}`, { completed: true }),
    ];
    for (const response of responses) {
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(await taskRowCount(), before);
  const [row] = await fixture.client`select completed from tasks where id = ${task.id}`;
  assert.equal(row.completed, false);
});

test('mutating task routes reject foreign and missing origins (AC-5)', async () => {
  const session = await signIn(fixture, 0);
  const task = await createTask(session, 'Origin checked');
  const before = await taskRowCount();
  for (const origin of [
    'https://evil.example',
    'http://localhost:3000',
    'https://localhost:5173',
    'null',
    null,
  ]) {
    const created = await send(session, 'POST', '/api/tasks', { title: 'Cross-site' }, { origin });
    await assertError(created, 403, 'forbidden_origin');
    const updated = await send(
      session,
      'PATCH',
      `/api/tasks/${task.id}`,
      { completed: true },
      { origin },
    );
    await assertError(updated, 403, 'forbidden_origin');
  }
  assert.equal(await taskRowCount(), before);
  const [row] = await fixture.client`select completed from tasks where id = ${task.id}`;
  assert.equal(row.completed, false);

  // Reads are not origin-restricted, and existing identity behavior is unchanged.
  assert.ok((await listTasks(session)).some((item) => item.id === task.id));
  const me = await fixture.app.request('/api/me', { headers: { Cookie: session } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, 'one@example.test');
});

// Edit and delete. The criteria named below are those of the edit and delete
// task; the tests above keep the numbering of the task that introduced them.

// Timestamps are read as text (exact, microsecond precision) for equality and
// as epoch seconds for ordering.
async function storedRow(id: number) {
  const [row] = await fixture.client`
    select user_id, title, completed, created_at::text, updated_at::text,
      extract(epoch from updated_at)::float8 as updated_epoch
    from tasks where id = ${id}`;
  return row ? { ...row } : undefined;
}

test('a task can be renamed; the title is trimmed and nothing else changes (edit AC-1)', async () => {
  const session = await signIn(fixture, 0);
  const older = await createTask(session, 'Older sibling');
  const task = await createTask(session, 'Buy oat mlik');
  const newer = await createTask(session, 'Newer sibling');
  const before = await storedRow(task.id);
  const orderBefore = (await listTasks(session)).map((item) => item.id);

  const renamed = await send(session, 'PATCH', `/api/tasks/${task.id}`, {
    title: '  Buy oat milk \n',
  });
  assert.equal(renamed.status, 200);
  const renamedTask: Task = (await renamed.json()).task;
  assert.deepEqual(Object.keys(renamedTask).sort(), [
    'completed',
    'createdAt',
    'id',
    'title',
    'updatedAt',
  ]);
  assert.deepEqual(
    { id: renamedTask.id, title: renamedTask.title, completed: renamedTask.completed },
    { id: task.id, title: 'Buy oat milk', completed: false },
  );
  assert.equal(renamedTask.createdAt, task.createdAt);
  assert.ok(Date.parse(renamedTask.updatedAt) > Date.parse(task.updatedAt));

  // The stored row agrees: new title, later updated_at, same owner, state and creation time.
  const after = await storedRow(task.id);
  assert.equal(after!.title, 'Buy oat milk');
  assert.equal(after!.completed, false);
  assert.equal(after!.user_id, before!.user_id);
  assert.equal(after!.created_at, before!.created_at);
  assert.ok(after!.updated_epoch > before!.updated_epoch);

  // The list shows the new title in the same position, and the siblings are untouched.
  const listed = await listTasks(session);
  assert.deepEqual(
    listed.map((item) => item.id),
    orderBefore,
  );
  assert.deepEqual(
    listed.find((item) => item.id === task.id),
    renamedTask,
  );
  assert.deepEqual(
    listed.find((item) => item.id === older.id),
    older,
  );
  assert.deepEqual(
    listed.find((item) => item.id === newer.id),
    newer,
  );

  // Renaming a completed task keeps it completed.
  await send(session, 'PATCH', `/api/tasks/${task.id}`, { completed: true });
  const again = await send(session, 'PATCH', `/api/tasks/${task.id}`, { title: 'Buy oat milk today' });
  assert.equal(again.status, 200);
  assert.deepEqual(
    { title: (await storedRow(task.id))!.title, completed: (await storedRow(task.id))!.completed },
    { title: 'Buy oat milk today', completed: true },
  );

  // A title of exactly 200 characters is accepted, counted in code points.
  for (const title of longestTitles) {
    const response = await send(session, 'PATCH', `/api/tasks/${task.id}`, { title: `  ${title} ` });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).task.title, title);
    const [row] = await fixture.client`
      select char_length(title)::int as length from tasks where id = ${task.id}`;
    assert.equal(row.length, 200);
  }
  // Invisible characters inside a visible title are stored unchanged.
  const joined = 'Family \u{1F468}‍\u{1F469}‍\u{1F467} dinner';
  const kept = await send(session, 'PATCH', `/api/tasks/${task.id}`, { title: joined });
  assert.equal((await kept.json()).task.title, joined);
});

test('one update can change the title and the completion state together (edit AC-1)', async () => {
  const session = await signIn(fixture, 0);
  const task = await createTask(session, 'Both at once');
  const both = await send(session, 'PATCH', `/api/tasks/${task.id}`, {
    title: ' Both changed ',
    completed: true,
  });
  assert.equal(both.status, 200);
  const updated: Task = (await both.json()).task;
  assert.deepEqual(
    { id: updated.id, title: updated.title, completed: updated.completed },
    { id: task.id, title: 'Both changed', completed: true },
  );
  const row = await storedRow(task.id);
  assert.deepEqual(
    { title: row!.title, completed: row!.completed },
    { title: 'Both changed', completed: true },
  );
  assert.deepEqual(
    (await listTasks(session)).find((item) => item.id === task.id),
    updated,
  );

  // If either field is invalid, neither is applied.
  const badTitle = await send(session, 'PATCH', `/api/tasks/${task.id}`, {
    title: '  ',
    completed: false,
  });
  await assertError(badTitle, 400, 'invalid_title');
  const badCompleted = await send(session, 'PATCH', `/api/tasks/${task.id}`, {
    title: 'Not applied',
    completed: 'no',
  });
  await assertError(badCompleted, 400, 'invalid_completed');
  const unchanged = await storedRow(task.id);
  assert.deepEqual(
    { title: unchanged!.title, completed: unchanged!.completed },
    { title: 'Both changed', completed: true },
  );
  assert.equal(unchanged!.updated_at, row!.updated_at);
});

test('rename applies the create title rules and rejects an empty update (edit AC-2)', async () => {
  const session = await signIn(fixture, 0);
  const task = await createTask(session, 'Keep this title');
  const before = await storedRow(task.id);
  const rejected = async (body: unknown, error = 'invalid_title') => {
    const response = await send(session, 'PATCH', `/api/tasks/${task.id}`, body);
    await assertError(response.clone(), 400, error);
    return (await response.json()).message as string;
  };

  for (const title of ['', '   ', '\t\n ', ...invisibleTitles]) {
    assert.equal(await rejected({ title }), 'Enter a task title.');
  }
  for (const title of nullCharacterTitles) {
    assert.match(await rejected({ title }), /null character/);
  }
  for (const title of tooLongTitles) {
    assert.match(await rejected({ title }), /200 characters/);
  }
  for (const title of nonTextTitles) {
    assert.equal(await rejected({ title }), 'A task title is required and must be text.');
    // A valid completed value does not rescue an invalid title.
    await rejected({ title, completed: true });
  }

  // Each rule answers with the same message on create and on rename.
  for (const title of ['  ', nullCharacterTitles[0], tooLongTitles[0], 42]) {
    const created = await send(session, 'POST', '/api/tasks', { title });
    await assertError(created.clone(), 400, 'invalid_title');
    assert.equal(await rejected({ title }), (await created.json()).message);
  }

  // Neither field: a distinct, stable code.
  for (const body of [{}, { name: 'wrong key' }, { userId: 1, id: 2 }, [], null, '"text"', '42']) {
    assert.match(await rejected(body, 'invalid_update'), /title.*completed/);
  }
  await rejected('{"title": "unterminated', 'invalid_json');
  for (const id of ['abc', '0', '-1', '1.5', '1e3', `${task.id}abc`]) {
    const response = await send(session, 'PATCH', `/api/tasks/${id}`, { title: 'Valid' });
    await assertError(response, 400, 'invalid_task_id');
  }
  for (const id of ['999999', '2147483648', '9999999999999999']) {
    const response = await send(session, 'PATCH', `/api/tasks/${id}`, { title: 'Valid' });
    await assertError(response, 404, 'task_not_found');
  }

  // No rejected request changed the row, not even its updated_at.
  assert.deepEqual(await storedRow(task.id), before);
});

test('a task can be deleted; it is gone for good and other tasks stay (edit AC-3)', async () => {
  const session = await signIn(fixture, 0);
  const sibling = await createTask(session, 'Stays');
  const task = await createTask(session, 'Goes away');
  const done = await createTask(session, 'Done and deleted');
  await send(session, 'PATCH', `/api/tasks/${done.id}`, { completed: true });
  const count = await taskRowCount();

  const deleted = await send(session, 'DELETE', `/api/tasks/${task.id}`);
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), '');
  assert.equal(deleted.headers.get('cache-control'), 'no-store');
  assert.equal(await taskRowCount(), count - 1);
  assert.equal(await storedRow(task.id), undefined);
  const listed = await listTasks(session);
  assert.equal(
    listed.some((item) => item.id === task.id),
    false,
  );
  assert.deepEqual(
    listed.find((item) => item.id === sibling.id),
    sibling,
  );

  // Deleting again, or updating the deleted task, finds nothing.
  await assertError(await send(session, 'DELETE', `/api/tasks/${task.id}`), 404, 'task_not_found');
  await assertError(
    await send(session, 'PATCH', `/api/tasks/${task.id}`, { title: 'Back again' }),
    404,
    'task_not_found',
  );
  assert.equal(await taskRowCount(), count - 1);

  // A completed task is deleted the same way. A request body is ignored.
  const withBody = await send(session, 'DELETE', `/api/tasks/${done.id}`, { id: sibling.id });
  assert.equal(withBody.status, 204);
  assert.equal(await storedRow(done.id), undefined);
  assert.equal(await taskRowCount(), count - 2);

  for (const id of ['abc', '0', '-1', '1.5', '1e3', `${sibling.id}abc`, '%20']) {
    await assertError(await send(session, 'DELETE', `/api/tasks/${id}`), 400, 'invalid_task_id');
  }
  for (const id of ['999999', '2147483648', '9999999999999999']) {
    await assertError(await send(session, 'DELETE', `/api/tasks/${id}`), 404, 'task_not_found');
  }
  assert.equal(await taskRowCount(), count - 2);
  assert.deepEqual((await storedRow(sibling.id))!.title, 'Stays');
});

test('users cannot rename or delete each other\'s tasks, and cannot move a task (edit AC-4)', async () => {
  const [one, two] = await Promise.all([signIn(fixture, 0), signIn(fixture, 1)]);
  const [userOne] = await fixture.client`select id from users where email = 'one@example.test'`;
  const [userTwo] = await fixture.client`select id from users where email = 'two@example.test'`;
  const mine = await createTask(one, 'Mine to change');
  const theirs = await createTask(two, 'Not yours');
  const theirsBefore = await storedRow(theirs.id);
  const count = await taskRowCount();

  // A foreign task answers exactly like a missing one, for every new write.
  const missingPatch = await send(one, 'PATCH', '/api/tasks/999999', { title: 'Taken over' });
  const missingDelete = await send(one, 'DELETE', '/api/tasks/999999');
  const foreignPatch = await send(one, 'PATCH', `/api/tasks/${theirs.id}`, { title: 'Taken over' });
  const foreignBoth = await send(one, 'PATCH', `/api/tasks/${theirs.id}`, {
    title: 'Taken over',
    completed: true,
  });
  const foreignDelete = await send(one, 'DELETE', `/api/tasks/${theirs.id}`);
  for (const response of [foreignPatch, foreignBoth, foreignDelete]) assert.equal(response.status, 404);
  const missingBody = await missingPatch.json();
  assert.deepEqual(await foreignPatch.json(), missingBody);
  assert.deepEqual(await foreignBoth.json(), missingBody);
  assert.deepEqual(await foreignDelete.json(), await missingDelete.json());
  assert.deepEqual(await storedRow(theirs.id), theirsBefore);
  assert.equal(await taskRowCount(), count);
  assert.deepEqual(
    (await listTasks(two)).find((item) => item.id === theirs.id),
    theirs,
  );

  // An owner or id in the body does not move, retarget or re-own the task.
  const spoofed = await send(one, 'PATCH', `/api/tasks/${mine.id}`, {
    title: 'Still mine',
    userId: userTwo.id,
    user_id: userTwo.id,
    id: theirs.id,
    createdAt: '2000-01-01T00:00:00.000Z',
  });
  assert.equal(spoofed.status, 200);
  const spoofedTask: Task = (await spoofed.json()).task;
  assert.equal(spoofedTask.id, mine.id);
  assert.equal(spoofedTask.createdAt, mine.createdAt);
  const mineAfter = await storedRow(mine.id);
  assert.deepEqual(
    { user_id: mineAfter!.user_id, title: mineAfter!.title },
    { user_id: userOne.id, title: 'Still mine' },
  );
  assert.deepEqual(await storedRow(theirs.id), theirsBefore);
  assert.equal(
    (await listTasks(two)).some((item) => item.id === mine.id),
    false,
  );
  // Only owner fields, no title or completed: nothing to update.
  await assertError(
    await send(one, 'PATCH', `/api/tasks/${mine.id}`, { userId: userTwo.id, id: theirs.id }),
    400,
    'invalid_update',
  );

  // The owner can still delete their own task; the other user's task is unaffected.
  assert.equal((await send(two, 'DELETE', `/api/tasks/${theirs.id}`)).status, 204);
  assert.equal(await storedRow(theirs.id), undefined);
  assert.equal((await storedRow(mine.id))!.title, 'Still mine');
});

test('rename and delete require a valid session and the application origin (edit AC-4)', async () => {
  const session = await signIn(fixture, 0);
  const task = await createTask(session, 'Guarded');
  const before = await storedRow(task.id);
  const count = await taskRowCount();

  for (const value of [
    '',
    'tasks.session_token=invalid',
    `${session}tampered`,
    session.replaceAll('tasks', 'cookbook'),
  ]) {
    const responses = [
      await send(value, 'PATCH', `/api/tasks/${task.id}`, { title: 'No session' }),
      await send(value, 'DELETE', `/api/tasks/${task.id}`),
    ];
    for (const response of responses) {
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }

  for (const origin of [
    'https://evil.example',
    'http://localhost:3000',
    'https://localhost:5173',
    'null',
    null,
  ]) {
    const renamed = await send(
      session,
      'PATCH',
      `/api/tasks/${task.id}`,
      { title: 'Cross-site' },
      { origin },
    );
    await assertError(renamed, 403, 'forbidden_origin');
    const deleted = await send(session, 'DELETE', `/api/tasks/${task.id}`, undefined, { origin });
    await assertError(deleted, 403, 'forbidden_origin');
  }

  // A signed-out session can no longer write either.
  const ended = await signIn(fixture, 0);
  await signOut(fixture, ended);
  assert.equal((await send(ended, 'DELETE', `/api/tasks/${task.id}`)).status, 401);
  assert.equal(
    (await send(ended, 'PATCH', `/api/tasks/${task.id}`, { title: 'Signed out' })).status,
    401,
  );

  assert.deepEqual(await storedRow(task.id), before);
  assert.equal(await taskRowCount(), count);
});
