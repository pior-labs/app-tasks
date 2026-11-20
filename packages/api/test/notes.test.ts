import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createFixture } from './fixture.js';
import { appOrigin, signIn } from './session.js';

// Task notes. The criteria named below are those of the notes task.

type Task = {
  id: number;
  title: string;
  notes: string | null;
  completed: boolean;
  dueDate: string | null;
  repeat: { every: number; unit: string } | null;
  createdAt: string;
  updatedAt: string;
};
type PatchBody = { task: Task; nextTask: Task | null; removedTaskId: number | null };

let fixture: Awaited<ReturnType<typeof createFixture>>;
before(async () => {
  fixture = await createFixture();
  // Noon UTC on Friday 2026-11-20, so repeat schedules are predictable.
  fixture.setNow(new Date('2026-11-20T12:00:00Z'));
});
after(async () => {
  await fixture?.close();
});

function send(session: string, method: 'POST' | 'PATCH', path: string, body: unknown) {
  return fixture.app.request(path, {
    method,
    headers: { Cookie: session, Origin: appOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  return response.json();
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
}
// The whole stored row, with timestamps as PostgreSQL prints them.
async function stored(id: number) {
  const [row] = await fixture.client`
    select user_id, title, notes, completed, due_date::text as due_date, repeat_unit, repeat_every,
      repeat_anchor::text as repeat_anchor, repeated_from_id, updated_at::text
    from tasks where id = ${id}`;
  return row ? { ...row } : undefined;
}
async function taskRowCount() {
  return (await fixture.client`select count(*)::int as count from tasks`)[0].count as number;
}

const emoji = '\u{1F600}'; // one character, two UTF-16 units
// Notes the API stores as given (the expected stored value follows each).
const keptNotes: [sent: string, stored: string][] = [
  ['Two litres', 'Two litres'],
  // Only the ends are trimmed; inner line breaks and spacing stay exactly.
  ['  \n Line one\n\n  indented line\r\nlast  line \n\t', 'Line one\n\n  indented line\r\nlast  line'],
  ['x'.repeat(5000), 'x'.repeat(5000)],
  [` ${'x'.repeat(5000)}\n`, 'x'.repeat(5000)],
  // The limit counts code points: 5000 emoji are 10000 UTF-16 units.
  [emoji.repeat(5000), emoji.repeat(5000)],
  ['x'.repeat(4999) + emoji, 'x'.repeat(4999) + emoji],
  // Plain text: markup is stored as typed, never interpreted.
  ['<b>bold</b> https://example.test', '<b>bold</b> https://example.test'],
];
// Notes with nothing visible: stored as null, like no notes at all.
const emptyNotes: unknown[] = [null, '', '   ', '\n\t \r\n', '​', ' ​ ﻿ ', '­', '\u0001'];
// Rejected with invalid_notes.
const invalidNotes: unknown[] = [
  'x'.repeat(5001),
  emoji.repeat(5001),
  'x'.repeat(5000) + emoji,
  'a\u0000b',
  '\u0000',
  42,
  true,
  ['a'],
  { text: 'a' },
];

test('notes are trimmed, kept exactly inside, and empty notes are stored as null (notes AC-1)', async () => {
  const session = await signIn(fixture, 0);
  for (const [sent, expected] of keptNotes) {
    const created = await create(session, { title: 'Notes: kept', notes: sent });
    assert.equal(created.notes, expected);
    assert.equal((await stored(created.id))!.notes, expected);

    const task = await create(session, { title: 'Notes: kept on update' });
    const updated = await patch(session, task.id, { notes: sent });
    assert.equal(updated.task.notes, expected);
    assert.equal((await stored(task.id))!.notes, expected);
  }
  for (const notes of emptyNotes) {
    const created = await create(session, { title: 'Notes: empty', notes });
    assert.equal(created.notes, null, JSON.stringify(notes));
    assert.equal((await stored(created.id))!.notes, null);

    // On update, empty notes clear existing ones.
    const task = await create(session, { title: 'Notes: cleared', notes: 'Something' });
    const cleared = await patch(session, task.id, { notes });
    assert.equal(cleared.task.notes, null, JSON.stringify(notes));
    assert.equal((await stored(task.id))!.notes, null);
  }
});

test('invalid notes are rejected with 400 invalid_notes and change nothing (notes AC-1)', async () => {
  const session = await signIn(fixture, 0);
  const task = await create(session, { title: 'Notes: unchanged', notes: 'Keep me' });
  const before = await stored(task.id);
  const count = await taskRowCount();
  for (const notes of invalidNotes) {
    await assertError(await send(session, 'POST', '/api/tasks', { title: 'Notes: never', notes }), 400, 'invalid_notes');
    await assertError(await send(session, 'PATCH', `/api/tasks/${task.id}`, { notes }), 400, 'invalid_notes');
    // Valid fields sent alongside are not applied either.
    await assertError(
      await send(session, 'PATCH', `/api/tasks/${task.id}`, { title: 'Renamed', completed: true, notes }),
      400,
      'invalid_notes',
    );
  }
  assert.equal(await taskRowCount(), count);
  assert.deepEqual(await stored(task.id), before);
});

test('every task in every response has notes; omitted notes are null or unchanged (notes AC-2)', async () => {
  const session = await signIn(fixture, 0);
  const plain = await create(session, { title: 'Notes: none' });
  assert.equal(plain.notes, null);
  const withNotes = await create(session, { title: 'Notes: some', notes: 'Two litres' });
  assert.equal(withNotes.notes, 'Two litres');

  const listed = await listTasks(session);
  for (const task of listed) assert.ok(task.notes === null || typeof task.notes === 'string');
  assert.deepEqual(listed.find((task) => task.id === withNotes.id), withNotes);
  assert.deepEqual(listed.find((task) => task.id === plain.id), plain);

  // A PATCH with only notes is a valid update.
  const noted = await patch(session, plain.id, { notes: 'Added later' });
  assert.equal(noted.task.notes, 'Added later');
  assert.deepEqual([noted.nextTask, noted.removedTaskId], [null, null]);
  assert.equal(noted.task.title, 'Notes: none');

  // Omitting notes leaves them unchanged, whatever else changes.
  const renamed = await patch(session, withNotes.id, { title: 'Notes: renamed', dueDate: '2026-12-01', completed: true });
  assert.equal(renamed.task.notes, 'Two litres');
  assert.equal((await stored(withNotes.id))!.notes, 'Two litres');

  // Notes and other fields change together.
  const both = await patch(session, withNotes.id, { title: 'Notes: both', notes: 'Three litres' });
  assert.deepEqual([both.task.title, both.task.notes], ['Notes: both', 'Three litres']);

  // An empty update is still rejected, and so is one with only unknown keys.
  await assertError(await send(session, 'PATCH', `/api/tasks/${plain.id}`, {}), 400, 'invalid_update');
  await assertError(await send(session, 'PATCH', `/api/tasks/${plain.id}`, { note: 'typo' }), 400, 'invalid_update');
  assert.equal((await stored(plain.id))!.notes, 'Added later');
});

test('users cannot read or change each other\'s notes (notes AC-3)', async () => {
  const one = await signIn(fixture, 0);
  const two = await signIn(fixture, 1);
  const task = await create(one, { title: 'Notes: private', notes: 'Only for one' });
  const before = await stored(task.id);

  assert.equal((await listTasks(two)).some((item) => item.id === task.id || item.notes === 'Only for one'), false);
  for (const body of [{ notes: 'Taken over' }, { notes: null }, { notes: '' }, { notes: 'x', title: 'Mine' }]) {
    await assertError(await send(two, 'PATCH', `/api/tasks/${task.id}`, body), 404, 'task_not_found');
  }
  assert.deepEqual(await stored(task.id), before);
  assert.equal((await listTasks(one)).find((item) => item.id === task.id)!.notes, 'Only for one');
});

test('the next occurrence of a repeating task copies its notes (notes AC-4)', async () => {
  const session = await signIn(fixture, 0);
  const weekly = { every: 1, unit: 'week' };
  const task = await create(session, {
    title: 'Notes: bins',
    notes: 'Green bin\nand recycling',
    dueDate: '2026-11-20',
    repeat: weekly,
  });
  const done = await patch(session, task.id, { completed: true });
  assert.equal(done.nextTask!.notes, 'Green bin\nand recycling');
  assert.equal(done.nextTask!.dueDate, '2026-11-27');
  assert.equal((await stored(done.nextTask!.id))!.notes, 'Green bin\nand recycling');
  assert.deepEqual((await listTasks(session)).find((item) => item.id === done.nextTask!.id), done.nextTask);

  // Un-ticking still removes the open copy.
  const undone = await patch(session, task.id, { completed: false });
  assert.equal(undone.removedTaskId, done.nextTask!.id);
  assert.equal(await stored(done.nextTask!.id), undefined);

  // Notes changed in the completing update are the ones copied, and so are cleared notes.
  const changed = await patch(session, task.id, { completed: true, notes: '  Only the green bin \n' });
  assert.equal(changed.task.notes, 'Only the green bin');
  assert.equal(changed.nextTask!.notes, 'Only the green bin');
  await patch(session, task.id, { completed: false });
  const cleared = await patch(session, task.id, { completed: true, notes: '' });
  assert.equal(cleared.nextTask!.notes, null);

  // A repeating task without notes gives a next occurrence without notes.
  const plain = await create(session, { title: 'Notes: plain repeat', dueDate: '2026-11-20', repeat: weekly });
  assert.equal((await patch(session, plain.id, { completed: true })).nextTask!.notes, null);
});

test('migration 0004 adds nullable notes to existing rows and the database enforces the limit (notes AC-5)', async () => {
  // A scratch database on the fixture's server, migrated to 0003 first, then
  // given a row, then migrated to the latest version.
  const options = fixture.client.options;
  const database = `tasks_test_${randomUUID().replaceAll('-', '')}`;
  await fixture.client.unsafe(`CREATE DATABASE "${database}"`);
  const scratch = postgres({
    host: options.host[0],
    port: options.port[0],
    user: options.user,
    pass: options.pass ?? undefined,
    database,
    max: 1,
    onnotice: () => {},
  });
  const folder = fileURLToPath(new URL('../drizzle', import.meta.url));
  const partial = await mkdtemp(join(tmpdir(), 'tasks-migrations-'));
  try {
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
    const upTo = journal.entries.findIndex((entry: { tag: string }) => entry.tag.startsWith('0003_'));
    assert.ok(upTo > 0);
    const entries = journal.entries.slice(0, upTo + 1);
    await cp(folder, partial, { recursive: true });
    await writeFile(join(partial, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    await migrate(drizzle(scratch), { migrationsFolder: partial });
    const before = await scratch`select column_name from information_schema.columns where table_name = 'tasks' and column_name = 'notes'`;
    assert.equal(before.length, 0);

    const [user] = await scratch`insert into users (name, email) values ('Fixture', 'fixture@example.test') returning id`;
    const [old] = await scratch`insert into tasks (user_id, title) values (${user.id}, 'Before notes') returning id`;

    await migrate(drizzle(scratch), { migrationsFolder: folder });
    const [row] = await scratch`select title, notes from tasks where id = ${old.id}`;
    assert.deepEqual({ ...row }, { title: 'Before notes', notes: null });

    // The check constraint counts code points and refuses empty and over-long notes.
    await scratch`update tasks set notes = ${emoji.repeat(5000)} where id = ${old.id}`;
    for (const notes of ['x'.repeat(5001), emoji.repeat(5001), '']) {
      await assert.rejects(
        scratch`update tasks set notes = ${notes} where id = ${old.id}`,
        (error: { code?: string; constraint_name?: string }) =>
          error.code === '23514' && error.constraint_name === 'tasks_notes_length_check',
      );
      await assert.rejects(
        scratch`insert into tasks (user_id, title, notes) values (${user.id}, 'Too long', ${notes})`,
        (error: { code?: string }) => error.code === '23514',
      );
    }
    assert.equal((await scratch`select notes from tasks where id = ${old.id}`)[0].notes, emoji.repeat(5000));
  } finally {
    await scratch.end();
    await rm(partial, { recursive: true, force: true });
    await fixture.client.unsafe(`DROP DATABASE IF EXISTS "${database}"`);
  }
});

test('the fixture database rejects over-long notes written directly (notes AC-5)', async () => {
  const session = await signIn(fixture, 0);
  const task = await create(session, { title: 'Notes: direct write' });
  await assert.rejects(
    fixture.client`update tasks set notes = ${'x'.repeat(5001)} where id = ${task.id}`,
    (error: { code?: string }) => error.code === '23514',
  );
  assert.equal((await stored(task.id))!.notes, null);
});
