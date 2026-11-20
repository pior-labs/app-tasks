import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { nextDueDate } from '../src/repeat.js';
import { createFixture } from './fixture.js';
import { appOrigin, signIn } from './session.js';

// Repeating tasks. The criteria named below are those of the recurring tasks
// task. This file also runs with TZ=Pacific/Auckland (see the README): the
// schedule never depends on the process timezone.

type Repeat = { every: number; unit: 'day' | 'week' | 'month' | 'year' } | null;
type Task = {
  id: number;
  title: string;
  completed: boolean;
  dueDate: string | null;
  repeat: Repeat;
  createdAt: string;
  updatedAt: string;
};
type PatchBody = { task: Task; nextTask: Task | null; removedTaskId: number | null };

// Unless a test pins it otherwise, the server's clock is noon UTC on Friday
// 2026-11-20, so its UTC date is 2026-11-20.
const SERVER_NOON = new Date('2026-11-20T12:00:00Z');
let fixture: Awaited<ReturnType<typeof createFixture>>;
before(async () => {
  fixture = await createFixture();
  fixture.setNow(SERVER_NOON);
});
afterEach(() => fixture.setNow(SERVER_NOON));
after(async () => {
  await fixture?.close();
});

function send(session: string, method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
  return fixture.app.request(path, {
    method,
    headers: {
      Cookie: session,
      Origin: appOrigin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function create(session: string, body: Record<string, unknown>): Promise<Task> {
  const response = await send(session, 'POST', '/api/tasks', body);
  assert.equal(response.status, 201, JSON.stringify(body));
  return (await response.json()).task;
}
async function patch(session: string, id: number, body: Record<string, unknown>): Promise<PatchBody> {
  const response = await send(session, 'PATCH', `/api/tasks/${id}`, body);
  assert.equal(response.status, 200, JSON.stringify(body));
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ['nextTask', 'removedTaskId', 'task']);
  return result;
}
async function listTasks(session: string): Promise<Task[]> {
  const response = await fixture.app.request('/api/tasks', { headers: { Cookie: session } });
  assert.equal(response.status, 200);
  return (await response.json()).tasks;
}
async function assertError(response: Response, status: number, error: string) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error, error);
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0);
  return body.message as string;
}
// The whole stored row, with dates and timestamps as PostgreSQL prints them.
async function stored(id: number) {
  const [row] = await fixture.client`
    select user_id, title, completed, due_date::text as due_date, repeat_unit, repeat_every,
      repeat_anchor::text as repeat_anchor, repeated_from_id, created_at::text, updated_at::text
    from tasks where id = ${id}`;
  return row ? { ...row } : undefined;
}
async function taskRowCount() {
  return (await fixture.client`select count(*)::int as count from tasks`)[0].count as number;
}
async function successors(id: number) {
  return (await fixture.client`select id from tasks where repeated_from_id = ${id}`).map((row) => row.id as number);
}
async function userId(email: string) {
  return (await fixture.client`select id from users where email = ${email}`)[0].id as number;
}

const weekly = { every: 1, unit: 'week' } as const;
const daily = { every: 1, unit: 'day' } as const;
const monthly = { every: 1, unit: 'month' } as const;
const yearly = { every: 1, unit: 'year' } as const;

test('a repeat is created, changed and stopped, and the anchor follows the due date (recurring AC-2)', async () => {
  const session = await signIn(fixture, 0);
  const created = await create(session, { title: 'Repeat: bins', dueDate: '2026-11-24', repeat: weekly });
  assert.deepEqual(created.repeat, weekly);
  assert.deepEqual(Object.keys(created).sort(), ['completed', 'createdAt', 'dueDate', 'id', 'listId', 'notes', 'repeat', 'title', 'updatedAt']);
  let row = await stored(created.id);
  assert.deepEqual(
    { unit: row!.repeat_unit, every: row!.repeat_every, anchor: row!.repeat_anchor, from: row!.repeated_from_id },
    { unit: 'week', every: 1, anchor: '2026-11-24', from: null },
  );
  // GET returns the repeat exactly as sent, and never the internal columns.
  const listed = (await listTasks(session)).find((task) => task.id === created.id)!;
  assert.deepEqual(listed, created);

  // Without a repeat, or with null, a task does not repeat.
  assert.equal((await create(session, { title: 'Repeat: none', dueDate: '2026-11-24' })).repeat, null);
  const nulled = await create(session, { title: 'Repeat: null', dueDate: '2026-11-24', repeat: null });
  assert.equal(nulled.repeat, null);
  assert.equal((await stored(nulled.id))!.repeat_anchor, null);

  // Change the repeat: returned as sent; the anchor is the due date.
  const changed = await patch(session, created.id, { repeat: { every: 3, unit: 'day' } });
  assert.deepEqual(changed.task.repeat, { every: 3, unit: 'day' });
  assert.deepEqual([changed.nextTask, changed.removedTaskId], [null, null]);
  row = await stored(created.id);
  assert.deepEqual([row!.repeat_unit, row!.repeat_every, row!.repeat_anchor], ['day', 3, '2026-11-24']);

  // Moving the due date moves the anchor; so does a new date sent with a repeat.
  await patch(session, created.id, { dueDate: '2026-12-02' });
  assert.equal((await stored(created.id))!.repeat_anchor, '2026-12-02');
  await patch(session, created.id, { dueDate: '2026-12-05', repeat: monthly, title: 'Repeat: bins monthly' });
  row = await stored(created.id);
  assert.deepEqual(
    [row!.title, row!.due_date, row!.repeat_unit, row!.repeat_every, row!.repeat_anchor],
    ['Repeat: bins monthly', '2026-12-05', 'month', 1, '2026-12-05'],
  );

  // A rename, or the same repeat and date sent again, keeps the anchor.
  await fixture.client`update tasks set repeat_anchor = '2026-11-05' where id = ${created.id}`;
  await patch(session, created.id, { title: 'Repeat: bins again' });
  await patch(session, created.id, { repeat: monthly, dueDate: '2026-12-05' });
  assert.equal((await stored(created.id))!.repeat_anchor, '2026-11-05');

  // Stop repeating: null clears the repeat and its anchor and keeps the date.
  const stopped = await patch(session, created.id, { repeat: null });
  assert.equal(stopped.task.repeat, null);
  assert.equal(stopped.task.dueDate, '2026-12-05');
  row = await stored(created.id);
  assert.deepEqual([row!.repeat_unit, row!.repeat_every, row!.repeat_anchor], [null, null, null]);

  // A task without a date can get a repeat together with a date; removing
  // both at once is allowed too.
  const undated = await create(session, { title: 'Repeat: undated' });
  const dated = await patch(session, undated.id, { dueDate: '2026-11-30', repeat: { every: 2, unit: 'week' } });
  assert.deepEqual(dated.task.repeat, { every: 2, unit: 'week' });
  assert.equal((await stored(undated.id))!.repeat_anchor, '2026-11-30');
  const cleared = await patch(session, undated.id, { dueDate: null, repeat: null });
  assert.deepEqual([cleared.task.dueDate, cleared.task.repeat], [null, null]);
});

const invalidRepeats: unknown[] = [
  // Missing or extra keys.
  {},
  { every: 1 },
  { unit: 'week' },
  { every: 1, unit: 'week', anchor: '2026-11-20' },
  { every: 1, unit: 'week', weekday: 'tue' },
  // every out of range, not an integer, not a number.
  { every: 0, unit: 'week' },
  { every: 100, unit: 'week' },
  { every: -1, unit: 'day' },
  { every: 1.5, unit: 'day' },
  { every: '2', unit: 'day' },
  { every: null, unit: 'day' },
  { every: true, unit: 'day' },
  // Unknown units.
  { every: 1, unit: 'fortnight' },
  { every: 1, unit: 'Week' },
  { every: 1, unit: 'weeks' },
  { every: 1, unit: null },
  // Not an object.
  'weekly',
  7,
  true,
  [],
  [{ every: 1, unit: 'week' }],
];

test('invalid repeats and repeats without a due date are rejected and change nothing (recurring AC-2)', async () => {
  const session = await signIn(fixture, 0);
  const task = await create(session, { title: 'Repeat: keep me', dueDate: '2026-11-24', repeat: weekly });
  const undated = await create(session, { title: 'Repeat: no date' });
  const before = await stored(task.id);
  const undatedBefore = await stored(undated.id);
  const count = await taskRowCount();

  let message: string | undefined;
  for (const repeat of invalidRepeats) {
    for (const response of [
      await send(session, 'POST', '/api/tasks', { title: 'Repeat: never', dueDate: '2026-11-24', repeat }),
      await send(session, 'PATCH', `/api/tasks/${task.id}`, { repeat }),
      await send(session, 'PATCH', `/api/tasks/${task.id}`, { repeat, title: 'Not applied', completed: true }),
    ]) {
      const text = await assertError(response, 400, 'invalid_repeat');
      // One shared definition: the same message for every invalid value.
      message ??= text;
      assert.equal(text, message, JSON.stringify(repeat));
    }
  }
  assert.match(message!, /every.*1.*99.*day, week, month, year/);

  // A repeat needs a due date: on create, on a task without one, and when
  // removing the date of a repeating task without also stopping the repeat.
  const noDate = [
    await send(session, 'POST', '/api/tasks', { title: 'Repeat: never', repeat: weekly }),
    await send(session, 'POST', '/api/tasks', { title: 'Repeat: never', dueDate: null, repeat: weekly }),
    await send(session, 'PATCH', `/api/tasks/${undated.id}`, { repeat: weekly }),
    await send(session, 'PATCH', `/api/tasks/${undated.id}`, { repeat: weekly, dueDate: null }),
    await send(session, 'PATCH', `/api/tasks/${task.id}`, { dueDate: null }),
    await send(session, 'PATCH', `/api/tasks/${task.id}`, { dueDate: null, repeat: daily, completed: true }),
  ];
  for (const response of noDate) assert.match(await assertError(response, 400, 'invalid_repeat'), /due date/);

  // The first invalid field still decides, so the existing codes are unchanged.
  await assertError(await send(session, 'POST', '/api/tasks', { title: ' ', repeat: 'x' }), 400, 'invalid_title');
  await assertError(
    await send(session, 'POST', '/api/tasks', { title: 'Repeat: x', dueDate: 'soon', repeat: 'x' }),
    400,
    'invalid_due_date',
  );
  await assertError(await send(session, 'PATCH', `/api/tasks/${task.id}`, { completed: 'y', repeat: 'x' }), 400, 'invalid_completed');
  await assertError(await send(session, 'PATCH', `/api/tasks/${task.id}`, { dueDate: 'soon', repeat: 'x' }), 400, 'invalid_due_date');
  // An empty update is still invalid_update, also with only today in it.
  for (const body of [{}, { today: '2026-11-20' }, { repeatEvery: 1 }]) {
    assert.match(
      await assertError(await send(session, 'PATCH', `/api/tasks/${task.id}`, body), 400, 'invalid_update'),
      /title.*completed.*due date.*repeat/,
    );
  }
  // Ids, foreign and missing tasks keep their codes.
  await assertError(await send(session, 'PATCH', '/api/tasks/abc', { repeat: weekly }), 400, 'invalid_task_id');
  await assertError(await send(session, 'PATCH', '/api/tasks/999999', { repeat: weekly }), 404, 'task_not_found');
  await assertError(await send(session, 'PATCH', '/api/tasks/2147483648', { repeat: null }), 404, 'task_not_found');

  // Nothing changed, not even updated_at, and nothing was created.
  assert.deepEqual(await stored(task.id), before);
  assert.deepEqual(await stored(undated.id), undatedBefore);
  assert.equal(await taskRowCount(), count);
});

// Creates a repeating task due on `dueDate` and completes it with `today`.
async function completeOnce(
  session: string,
  title: string,
  dueDate: string,
  repeat: NonNullable<Repeat>,
  today?: string,
) {
  const task = await create(session, { title, dueDate, repeat });
  return patch(session, task.id, { completed: true, ...(today === undefined ? {} : { today }) });
}

test('completing a repeating task creates the next occurrence on the fixed schedule (recurring AC-3)', async () => {
  const session = await signIn(fixture, 0);
  const me = await userId('one@example.test');
  // Today is Friday 2026-11-20 (the server's UTC date) unless stated.
  const cases: { name: string; dueDate: string; repeat: NonNullable<Repeat>; today?: string; next: string }[] = [
    { name: 'weekly on time', dueDate: '2026-11-20', repeat: weekly, next: '2026-11-27' },
    { name: 'weekly on time, today sent', dueDate: '2026-11-20', repeat: weekly, today: '2026-11-20', next: '2026-11-27' },
    // Done early: the occurrence after the current due date, not after today.
    { name: 'weekly early', dueDate: '2026-11-24', repeat: weekly, next: '2026-12-01' },
    // Late by less than one interval: the next occurrence, which is after today.
    { name: 'weekly late by days', dueDate: '2026-11-17', repeat: weekly, next: '2026-11-24' },
    // Late by several intervals: skips to the first occurrence not before
    // today, never into the past (Oct 27 + 4 weeks = Nov 24).
    { name: 'weekly late by weeks', dueDate: '2026-10-27', repeat: weekly, next: '2026-11-24' },
    // An occurrence that falls on today is not in the past.
    { name: 'weekly late, lands on today', dueDate: '2026-11-06', repeat: weekly, next: '2026-11-20' },
    { name: 'daily on time', dueDate: '2026-11-20', repeat: daily, next: '2026-11-21' },
    { name: 'daily early', dueDate: '2026-11-25', repeat: daily, next: '2026-11-26' },
    { name: 'daily late', dueDate: '2026-11-01', repeat: daily, next: '2026-11-20' },
    { name: 'every 2 weeks on time', dueDate: '2026-11-20', repeat: { every: 2, unit: 'week' }, next: '2026-12-04' },
    { name: 'every 2 weeks late', dueDate: '2026-10-30', repeat: { every: 2, unit: 'week' }, next: '2026-11-27' },
    { name: 'every 3 days late', dueDate: '2026-11-14', repeat: { every: 3, unit: 'day' }, next: '2026-11-20' },
    { name: 'monthly on time', dueDate: '2026-11-20', repeat: monthly, next: '2026-12-20' },
    { name: 'monthly late by months', dueDate: '2026-08-19', repeat: monthly, next: '2026-12-19' },
    { name: 'every 3 months', dueDate: '2026-11-20', repeat: { every: 3, unit: 'month' }, next: '2027-02-20' },
    { name: 'yearly on time', dueDate: '2026-11-20', repeat: yearly, next: '2027-11-20' },
    { name: 'yearly late', dueDate: '2025-01-15', repeat: yearly, next: '2027-01-15' },
    // 2125 is past the supported range: no next occurrence.
    { name: 'every 99 years', dueDate: '2026-11-20', repeat: { every: 99, unit: 'year' }, next: 'none' },
  ];
  for (const { name, dueDate, repeat, today, next } of cases) {
    const result = await completeOnce(session, `Schedule: ${name}`, dueDate, repeat, today);
    assert.equal(result.task.completed, true, name);
    assert.equal(result.removedTaskId, null);
    if (next === 'none') {
      assert.equal(result.nextTask, null, name);
      assert.deepEqual(await successors(result.task.id), []);
      continue;
    }
    const nextTask = result.nextTask!;
    assert.ok(nextTask, name);
    assert.deepEqual(
      { title: nextTask.title, completed: nextTask.completed, dueDate: nextTask.dueDate, repeat: nextTask.repeat },
      { title: `Schedule: ${name}`, completed: false, dueDate: next, repeat },
      name,
    );
    assert.notEqual(nextTask.id, result.task.id);
    // In GET and in the table, owned by the same user, linked to the completed one.
    assert.deepEqual(
      (await listTasks(session)).find((task) => task.id === nextTask.id),
      nextTask,
    );
    const row = await stored(nextTask.id);
    assert.deepEqual(
      { user: row!.user_id, from: row!.repeated_from_id, anchor: row!.repeat_anchor, due: row!.due_date },
      { user: me, from: result.task.id, anchor: dueDate, due: next },
      name,
    );
  }
});

// Completes the task and then each next occurrence, returning the due dates.
async function chain(session: string, first: Task, steps: number, today?: string) {
  const dates = [first.dueDate];
  let current = first;
  for (let step = 0; step < steps; step++) {
    const { nextTask } = await patch(session, current.id, { completed: true, ...(today ? { today } : {}) });
    assert.ok(nextTask);
    dates.push(nextTask.dueDate);
    current = nextTask;
  }
  return dates;
}

test('month-end and leap-day schedules keep their day without drifting (recurring AC-3)', async () => {
  const session = await signIn(fixture, 0);
  // Monthly on the 31st: February clamps to its last day, the next months go
  // back to the 31st (or the 30th in April), across a year boundary.
  const thirtyFirst = await create(session, { title: 'Month end: rent', dueDate: '2026-12-31', repeat: monthly });
  assert.deepEqual(await chain(session, thirtyFirst, 5), [
    '2026-12-31',
    '2027-01-31',
    '2027-02-28',
    '2027-03-31',
    '2027-04-30',
    '2027-05-31',
  ]);
  // In a leap year February has 29 days.
  const leap = await create(session, { title: 'Month end: leap', dueDate: '2028-01-31', repeat: monthly });
  assert.deepEqual(await chain(session, leap, 3), ['2028-01-31', '2028-02-29', '2028-03-31', '2028-04-30']);
  // Every 2 months from the 31st.
  const twoMonths = await create(session, { title: 'Month end: two', dueDate: '2026-12-31', repeat: { every: 2, unit: 'month' } });
  assert.deepEqual(await chain(session, twoMonths, 3), ['2026-12-31', '2027-02-28', '2027-04-30', '2027-06-30']);
  // Yearly on February 29: the 28th in common years, the 29th in leap years.
  const leapDay = await create(session, { title: 'Leap day: yearly', dueDate: '2028-02-29', repeat: yearly });
  assert.deepEqual(await chain(session, leapDay, 4), [
    '2028-02-29',
    '2029-02-28',
    '2030-02-28',
    '2031-02-28',
    '2032-02-29',
  ]);
  // Monthly on the 31st completed late, across a month end: never in the past.
  fixture.setNow(new Date('2027-03-02T12:00:00Z'));
  const late = await completeOnce(session, 'Month end: late', '2027-01-31', monthly, '2027-03-02');
  assert.equal(late.nextTask!.dueDate, '2027-03-31');
});

test('moving the due date of a repeating task realigns its schedule (recurring AC-3)', async () => {
  const session = await signIn(fixture, 0);
  const task = await create(session, { title: 'Realign: rent', dueDate: '2026-12-31', repeat: monthly });
  // Moved to the 15th: the schedule now counts from the 15th.
  await patch(session, task.id, { dueDate: '2026-12-15' });
  const { nextTask } = await patch(session, task.id, { completed: true });
  assert.equal(nextTask!.dueDate, '2027-01-15');
  // The copy inherits the realigned schedule.
  assert.equal((await stored(nextTask!.id))!.repeat_anchor, '2026-12-15');
  const third = await patch(session, nextTask!.id, { completed: true });
  assert.equal(third.nextTask!.dueDate, '2027-02-15');

  // Weekly bins on Tuesdays, moved to Thursday in the same request that
  // completes it: from now on Thursdays. Other fields of that request apply
  // to the next occurrence too.
  const bins = await create(session, { title: 'Realign: bins', dueDate: '2026-11-24', repeat: weekly });
  const moved = await patch(session, bins.id, { dueDate: '2026-11-26', title: 'Realign: bins Thursday', completed: true });
  assert.deepEqual(
    { title: moved.nextTask!.title, dueDate: moved.nextTask!.dueDate },
    { title: 'Realign: bins Thursday', dueDate: '2026-12-03' },
  );
  // Changing the repeat while completing applies the new one.
  const changed = await create(session, { title: 'Realign: interval', dueDate: '2026-11-20', repeat: weekly });
  const result = await patch(session, changed.id, { repeat: { every: 10, unit: 'day' }, completed: true });
  assert.deepEqual(
    { dueDate: result.nextTask!.dueDate, repeat: result.nextTask!.repeat },
    { dueDate: '2026-11-30', repeat: { every: 10, unit: 'day' } },
  );
  // Stopping the repeat while completing creates nothing.
  const stopped = await create(session, { title: 'Realign: stop', dueDate: '2026-11-20', repeat: weekly });
  assert.equal((await patch(session, stopped.id, { repeat: null, completed: true })).nextTask, null);
});

test('no occurrence after 2100-12-31, and none for tasks that do not repeat (recurring AC-3)', async () => {
  const session = await signIn(fixture, 0);
  const count = await taskRowCount();
  const last = await completeOnce(session, 'Limit: yearly at the end', '2100-06-01', yearly);
  assert.equal(last.nextTask, null);
  assert.equal(last.task.completed, true);
  const end = await completeOnce(session, 'Limit: daily on the last day', '2100-12-31', daily);
  assert.equal(end.nextTask, null);
  // The last supported day itself is still created.
  const edge = await completeOnce(session, 'Limit: daily the day before', '2100-12-30', daily);
  assert.equal(edge.nextTask!.dueDate, '2100-12-31');

  for (const body of [{ title: 'Limit: plain', dueDate: '2026-11-20' }, { title: 'Limit: undated' }]) {
    const plain = await create(session, body);
    const result = await patch(session, plain.id, { completed: true, today: '2026-11-20' });
    assert.deepEqual([result.task.completed, result.nextTask, result.removedTaskId], [true, null, null]);
  }
  // Only the five created tasks and the one occurrence on 2100-12-31 exist.
  assert.equal(await taskRowCount(), count + 6);
});

test('today within one day of the server date decides the schedule; others are refused (recurring AC-4)', async () => {
  const session = await signIn(fixture, 0);
  // Weekly on Fridays, last due 2026-11-13; the server's UTC date is
  // 2026-11-20, itself an occurrence.
  const nextFor = async (today: string | undefined) =>
    (await completeOnce(session, `Today: ${today ?? 'absent'}`, '2026-11-13', weekly, today)).nextTask!.dueDate;
  // Both edges are accepted and decide the skip rule.
  assert.equal(await nextFor('2026-11-19'), '2026-11-20');
  assert.equal(await nextFor('2026-11-20'), '2026-11-20');
  assert.equal(await nextFor('2026-11-21'), '2026-11-27');
  // Without today the server's UTC date is used.
  assert.equal(await nextFor(undefined), '2026-11-20');

  // One day beyond each edge, and malformed values, are refused; nothing changes.
  const task = await create(session, { title: 'Today: refused', dueDate: '2026-11-13', repeat: weekly });
  const plain = await create(session, { title: 'Today: refused plain', dueDate: '2026-11-13' });
  const before = await stored(task.id);
  const plainBefore = await stored(plain.id);
  const count = await taskRowCount();
  for (const today of ['2026-11-18', '2026-11-22', '2026-11-31', '2026-1-20', '20261120', 'today', '', null, 20261120, {}]) {
    for (const id of [task.id, plain.id]) {
      const response = await send(session, 'PATCH', `/api/tasks/${id}`, { completed: true, today });
      assert.match(await assertError(response, 400, 'invalid_today'), /YYYY-MM-DD/, JSON.stringify(today));
    }
    const withTitle = await send(session, 'PATCH', `/api/tasks/${task.id}`, { completed: true, title: 'No', today });
    await assertError(withTitle, 400, 'invalid_today');
  }
  assert.deepEqual(await stored(task.id), before);
  assert.deepEqual(await stored(plain.id), plainBefore);
  assert.equal(await taskRowCount(), count);

  // today is ignored by requests that do not complete a task.
  await patch(session, task.id, { title: 'Today: renamed', today: 'garbage' });
  await patch(session, task.id, { completed: false, today: 'garbage' });
  await patch(session, task.id, { completed: true, today: '2026-11-20' });
  await patch(session, task.id, { completed: true, today: 'already completed' });
});

test('without today the server uses its UTC date, whatever the process timezone (recurring AC-4)', async () => {
  const session = await signIn(fixture, 0);
  // 23:30 UTC on 2026-11-20 is already 2026-11-21 in Auckland and still
  // 2026-11-20 in Toronto. The server's date is the UTC one.
  fixture.setNow(new Date('2026-11-20T23:30:00Z'));
  const late = await completeOnce(session, 'UTC: daily late', '2026-11-10', daily);
  assert.equal(late.nextTask!.dueDate, '2026-11-20');
  // The window follows the UTC date as well: the 21st is in, the 22nd is out.
  const east = await completeOnce(session, 'UTC: east', '2026-11-10', daily, '2026-11-21');
  assert.equal(east.nextTask!.dueDate, '2026-11-21');
  const tooFar = await create(session, { title: 'UTC: too far', dueDate: '2026-11-10', repeat: daily });
  await assertError(
    await send(session, 'PATCH', `/api/tasks/${tooFar.id}`, { completed: true, today: '2026-11-22' }),
    400,
    'invalid_today',
  );
  // 00:30 UTC on 2026-11-21: UTC-12 is still on the 20th, which is accepted.
  fixture.setNow(new Date('2026-11-21T00:30:00Z'));
  const west = await completeOnce(session, 'UTC: west', '2026-11-10', daily, '2026-11-20');
  assert.equal(west.nextTask!.dueDate, '2026-11-20');
  assert.equal((await completeOnce(session, 'UTC: next day', '2026-11-10', daily)).nextTask!.dueDate, '2026-11-21');
});

test('un-completing removes an open next occurrence, keeps a completed one, and never duplicates (recurring AC-5)', async () => {
  const session = await signIn(fixture, 0);
  const task = await create(session, { title: 'Undo: plants', dueDate: '2026-11-20', repeat: weekly });
  const first = await patch(session, task.id, { completed: true });
  const next = first.nextTask!;
  assert.equal(next.dueDate, '2026-11-27');

  // Un-complete: the open next occurrence is deleted and its id returned.
  const undone = await patch(session, task.id, { completed: false });
  assert.deepEqual([undone.task.completed, undone.nextTask, undone.removedTaskId], [false, null, next.id]);
  assert.equal(await stored(next.id), undefined);
  assert.equal((await listTasks(session)).some((item) => item.id === next.id), false);
  // Completing again creates a new one, since the old one is gone.
  const again = await patch(session, task.id, { completed: true });
  assert.notEqual(again.nextTask!.id, next.id);
  assert.equal(again.nextTask!.dueDate, '2026-11-27');

  // A next occurrence that was renamed and re-dated meanwhile is still removed while open.
  await patch(session, again.nextTask!.id, { title: 'Undo: plants, renamed', dueDate: '2026-11-29' });
  const undoneEdited = await patch(session, task.id, { completed: false });
  assert.equal(undoneEdited.removedTaskId, again.nextTask!.id);

  // A next occurrence that was completed itself is kept, and completing the
  // first one again creates no second copy while it exists.
  const third = (await patch(session, task.id, { completed: true })).nextTask!;
  const fourth = (await patch(session, third.id, { completed: true })).nextTask!;
  const kept = await patch(session, task.id, { completed: false });
  assert.equal(kept.removedTaskId, null);
  assert.equal((await stored(third.id))!.completed, true);
  const recompleted = await patch(session, task.id, { completed: true });
  assert.equal(recompleted.nextTask, null);
  assert.deepEqual(await successors(task.id), [third.id]);
  // Un-completing the middle one removes its own open successor only.
  const middle = await patch(session, third.id, { completed: false });
  assert.equal(middle.removedTaskId, fourth.id);
  assert.deepEqual(await successors(task.id), [third.id]);
  // Un-completing a task that does not repeat removes nothing.
  const plain = await create(session, { title: 'Undo: plain', dueDate: '2026-11-20' });
  await patch(session, plain.id, { completed: true });
  assert.equal((await patch(session, plain.id, { completed: false })).removedTaskId, null);
});

test('parallel completions of one task create exactly one next occurrence (recurring AC-5)', async () => {
  const session = await signIn(fixture, 0);
  for (let round = 0; round < 3; round++) {
    const task = await create(session, { title: `Parallel: ${round}`, dueDate: '2026-11-20', repeat: daily });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => send(session, 'PATCH', `/api/tasks/${task.id}`, { completed: true, today: '2026-11-20' })),
    );
    const bodies: PatchBody[] = [];
    for (const response of responses) {
      assert.equal(response.status, 200);
      bodies.push(await response.json());
    }
    assert.equal(bodies.filter((body) => body.nextTask !== null).length, 1);
    assert.equal((await successors(task.id)).length, 1);
  }
  // The database refuses a second occurrence for the same task as well.
  const task = await create(session, { title: 'Parallel: unique', dueDate: '2026-11-20', repeat: daily });
  const { nextTask } = await patch(session, task.id, { completed: true });
  const [owner] = await fixture.client`select user_id from tasks where id = ${task.id}`;
  await assert.rejects(
    fixture.client`insert into tasks (user_id, title, repeated_from_id) values (${owner.user_id}, 'Duplicate', ${task.id})`,
    /tasks_repeated_from_id_unique/,
  );
  assert.deepEqual(await successors(task.id), [nextTask!.id]);
});

test('deleting a task keeps its next occurrence, unlinked (recurring AC-5)', async () => {
  const session = await signIn(fixture, 0);
  const task = await create(session, { title: 'Delete: series', dueDate: '2026-11-20', repeat: weekly });
  const { nextTask } = await patch(session, task.id, { completed: true });
  const count = await taskRowCount();
  assert.equal((await send(session, 'DELETE', `/api/tasks/${task.id}`)).status, 204);
  assert.equal(await taskRowCount(), count - 1);
  const row = await stored(nextTask!.id);
  assert.deepEqual(
    { from: row!.repeated_from_id, due: row!.due_date, unit: row!.repeat_unit, completed: row!.completed },
    { from: null, due: '2026-11-27', unit: 'week', completed: false },
  );
  // The kept occurrence keeps repeating.
  assert.equal((await patch(session, nextTask!.id, { completed: true })).nextTask!.dueDate, '2026-12-04');
});

test('another user\'s task cannot be completed, un-completed or given a repeat (recurring AC-6)', async () => {
  const [one, two] = await Promise.all([signIn(fixture, 0), signIn(fixture, 1)]);
  const userOne = await userId('one@example.test');
  const userTwo = await userId('two@example.test');
  const theirs = await create(two, { title: 'Isolation: theirs', dueDate: '2026-11-20', repeat: weekly });
  const theirsDone = await create(two, { title: 'Isolation: theirs done', dueDate: '2026-11-20', repeat: weekly });
  const theirsNext = (await patch(two, theirsDone.id, { completed: true })).nextTask!;
  const before = await Promise.all([theirs.id, theirsDone.id, theirsNext.id].map(stored));
  const count = await taskRowCount();
  const missing = await (await send(one, 'PATCH', '/api/tasks/999999', { completed: true })).json();

  for (const [id, body] of [
    [theirs.id, { completed: true }],
    [theirs.id, { completed: true, today: '2026-11-20' }],
    [theirs.id, { repeat: daily }],
    [theirs.id, { repeat: null }],
    [theirs.id, { dueDate: null }],
    [theirsDone.id, { completed: false }],
    [theirsNext.id, { completed: true, repeat: monthly }],
  ] as const) {
    const response = await send(one, 'PATCH', `/api/tasks/${id}`, body);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), missing);
  }
  assert.deepEqual(await Promise.all([theirs.id, theirsDone.id, theirsNext.id].map(stored)), before);
  assert.equal(await taskRowCount(), count);

  // A completion always creates the next occurrence for the session user.
  const mine = await create(one, { title: 'Isolation: mine', dueDate: '2026-11-20', repeat: weekly, userId: userTwo });
  const { nextTask } = await patch(one, mine.id, { completed: true, user_id: userTwo });
  assert.equal((await stored(nextTask!.id))!.user_id, userOne);
  assert.equal((await listTasks(two)).some((task) => task.id === nextTask!.id), false);

  // Even a row of another user that points at this task (which the API never
  // creates) is neither removed by an undo nor counted as this task's successor.
  const mineToo = await create(one, { title: 'Isolation: linked', dueDate: '2026-11-20', repeat: weekly });
  const [planted] = await fixture.client`
    insert into tasks (user_id, title, repeated_from_id) values (${userTwo}, 'Isolation: planted', ${mineToo.id})
    returning id`;
  const completed = await patch(one, mineToo.id, { completed: true });
  assert.equal(completed.nextTask, null);
  const reopened = await patch(one, mineToo.id, { completed: false });
  assert.equal(reopened.removedTaskId, null);
  assert.equal((await stored(planted.id))!.user_id, userTwo);
});

test('the schedule arithmetic is plain calendar arithmetic (recurring AC-3)', () => {
  const next = (anchor: string, dueDate: string, today: string, every: number, unit: 'day' | 'week' | 'month' | 'year') =>
    nextDueDate({ anchor, dueDate, today, every, unit });
  // A due date that is not on the schedule (not possible through the API)
  // still gives the first occurrence after it.
  assert.equal(next('2026-11-20', '2026-11-22', '2026-11-20', 1, 'week'), '2026-11-27');
  // Far behind: many intervals are skipped at once.
  assert.equal(next('2025-01-01', '2025-01-01', '2100-12-30', 1, 'day'), '2100-12-30');
  assert.equal(next('2025-01-31', '2025-01-31', '2099-03-01', 1, 'month'), '2099-03-31');
  // Across a daylight saving change the day count is exact.
  assert.equal(next('2026-03-01', '2026-03-01', '2026-03-01', 1, 'week'), '2026-03-08');
  assert.equal(next('2026-10-25', '2026-10-25', '2026-10-25', 1, 'day'), '2026-10-26');
});
