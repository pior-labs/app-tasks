import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createFixture } from './fixture.js';
import { appOrigin, signIn } from './session.js';

// Shared lists. The criteria named below are those of the shared lists task.

type List = { id: number; name: string; shared: boolean; ownerId: number; createdAt: string; updatedAt: string };
type Task = {
  id: number;
  title: string;
  listId: number | null;
  completed: boolean;
  dueDate: string | null;
  repeat: { every: number; unit: string } | null;
  createdById: number | null;
  completedById: number | null;
  assigneeId: number | null;
  createdAt: string;
  updatedAt: string;
};
type PatchBody = { task: Task; nextTask: Task | null; removedTaskId: number | null };

const taskKeys = [
  'assigneeId',
  'completed',
  'completedById',
  'createdAt',
  'createdById',
  'dueDate',
  'id',
  'listId',
  'notes',
  'repeat',
  'title',
  'updatedAt',
];
const listKeys = ['createdAt', 'id', 'name', 'ownerId', 'shared', 'updatedAt'];

let fixture: Awaited<ReturnType<typeof createFixture>>;
let one: string;
let two: string;
let oneId: number;
let twoId: number;
const userIdOf = async (email: string) =>
  (await fixture.client`select id from users where email = ${email}`)[0].id as number;
before(async () => {
  fixture = await createFixture();
  // Noon UTC on Friday 2026-11-20, so repeat schedules are predictable.
  fixture.setNow(new Date('2026-11-20T12:00:00Z'));
  one = await signIn(fixture, 0);
  two = await signIn(fixture, 1);
  oneId = await userIdOf('one@example.test');
  twoId = await userIdOf('two@example.test');
});
// Every test starts without lists or tasks.
beforeEach(async () => {
  await fixture.client`delete from tasks`;
  await fixture.client`delete from lists`;
});
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
async function get(session: string, path: string) {
  const response = await fixture.app.request(path, { headers: { Cookie: session } });
  assert.equal(response.status, 200, path);
  return response.json();
}
const getLists = async (session: string): Promise<List[]> => (await get(session, '/api/lists')).lists;
const listTasks = async (session: string): Promise<Task[]> => (await get(session, '/api/tasks')).tasks;
async function createList(session: string, name: string, shared = false): Promise<List> {
  const response = await send(session, 'POST', '/api/lists', { name });
  assert.equal(response.status, 201, name);
  const { list } = await response.json();
  if (!shared) return list;
  return patchList(session, list.id, { shared: true });
}
async function patchList(session: string, id: number, body: Record<string, unknown>): Promise<List> {
  const response = await send(session, 'PATCH', `/api/lists/${id}`, body);
  assert.equal(response.status, 200, JSON.stringify(body));
  const answer = await response.json();
  assert.deepEqual(Object.keys(answer), ['list']);
  return answer.list;
}
async function createTask(session: string, body: Record<string, unknown>): Promise<Task> {
  const response = await send(session, 'POST', '/api/tasks', body);
  assert.equal(response.status, 201, JSON.stringify(body));
  return (await response.json()).task;
}
async function patchTask(session: string, id: number, body: Record<string, unknown>): Promise<PatchBody> {
  const response = await send(session, 'PATCH', `/api/tasks/${id}`, body);
  assert.equal(response.status, 200, JSON.stringify(body));
  return response.json();
}
async function assertError(response: Response, status: number, error: string) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error, error);
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0);
  return body.message as string;
}
async function storedTask(id: number) {
  const [row] = await fixture.client`
    select user_id, list_id, title, completed, created_by_id, completed_by_id, assignee_id, updated_at::text
    from tasks where id = ${id}`;
  return row ? { ...row } : undefined;
}
async function storedTasks() {
  return (await fixture.client`select *, updated_at::text as updated from tasks order by id`).map((row) => ({ ...row }));
}
async function storedLists() {
  return (await fixture.client`select *, updated_at::text as updated from lists order by id`).map((row) => ({ ...row }));
}
const ids = (items: { id: number }[]) => items.map((item) => item.id);

test('migration 0006 adds sharing, attribution and assignment; existing rows are backfilled (AC-1)', async () => {
  // A scratch database on the fixture's server, migrated to 0005 first, then
  // given rows, then migrated to the latest version.
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
    const upTo = journal.entries.findIndex((entry: { tag: string }) => entry.tag.startsWith('0005_'));
    assert.ok(upTo > 0);
    assert.ok(journal.entries[upTo + 1]?.tag.startsWith('0006_'), 'migration 0006 follows 0005');
    await cp(folder, partial, { recursive: true });
    await writeFile(join(partial, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo + 1) }));
    await migrate(drizzle(scratch), { migrationsFolder: partial });

    const [a] = await scratch`insert into users (name, email) values ('A', 'a@example.test') returning id`;
    const [b] = await scratch`insert into users (name, email) values ('B', 'b@example.test') returning id`;
    const [list] = await scratch`insert into lists (user_id, name) values (${a.id}, 'Errands') returning id`;
    const [open] = await scratch`insert into tasks (user_id, title, list_id) values (${a.id}, 'Open', ${list.id}) returning id`;
    const [done] = await scratch`insert into tasks (user_id, title, completed) values (${b.id}, 'Done', true) returning id`;

    await migrate(drizzle(scratch), { migrationsFolder: folder });
    assert.deepEqual({ ...(await scratch`select name, shared from lists where id = ${list.id}`)[0] }, { name: 'Errands', shared: false });
    const rows = await scratch`
      select id, user_id, title, list_id, completed, created_by_id, completed_by_id, assignee_id from tasks order by id`;
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { id: open.id, user_id: a.id, title: 'Open', list_id: list.id, completed: false, created_by_id: a.id, completed_by_id: null, assignee_id: null },
      { id: done.id, user_id: b.id, title: 'Done', list_id: null, completed: true, created_by_id: b.id, completed_by_id: null, assignee_id: null },
    ]);
    // New lists are not shared unless asked.
    const [fresh] = await scratch`insert into lists (user_id, name) values (${b.id}, 'Fresh') returning shared`;
    assert.equal(fresh.shared, false);

    // A's shared list holds a task B added, completed and is assigned to.
    await scratch`update lists set shared = true where id = ${list.id}`;
    await scratch`update tasks set created_by_id = ${b.id}, completed_by_id = ${b.id}, assignee_id = ${b.id}, completed = true where id = ${open.id}`;
    // tasks_list_fk still refuses a task whose owner is not its list's owner,
    // shared or not.
    await assert.rejects(
      scratch`insert into tasks (user_id, title, list_id) values (${b.id}, 'Foreign', ${list.id})`,
      (error: { code?: string; constraint_name?: string }) =>
        error.code === '23503' && error.constraint_name === 'tasks_list_fk',
    );
    // The new columns refer to users.
    await assert.rejects(
      scratch`update tasks set assignee_id = 999999 where id = ${open.id}`,
      (error: { code?: string; constraint_name?: string }) =>
        error.code === '23503' && error.constraint_name === 'tasks_assignee_fk',
    );
    // Deleting B keeps A's task and clears B from it; B's own task goes.
    await scratch`delete from users where id = ${b.id}`;
    assert.deepEqual(
      { ...(await scratch`select user_id, created_by_id, completed_by_id, assignee_id, completed from tasks where id = ${open.id}`)[0] },
      { user_id: a.id, created_by_id: null, completed_by_id: null, assignee_id: null, completed: true },
    );
    assert.equal((await scratch`select count(*)::int as count from tasks where id = ${done.id}`)[0].count, 0);
  } finally {
    await scratch.end();
    await rm(partial, { recursive: true, force: true });
    await fixture.client.unsafe(`DROP DATABASE IF EXISTS "${database}"`);
  }
});

test('members are every Tasks user, as id and name only, by name then id; a session is required (AC-2)', async () => {
  const extra = await fixture.client`
    insert into users (name, email) values ('Aardvark', 'aardvark@example.test'), ('Household One', 'one-again@example.test')
    returning id`;
  try {
    const body = await get(one, '/api/members');
    assert.deepEqual(Object.keys(body), ['members']);
    assert.deepEqual(body.members, [
      { id: extra[0].id, name: 'Aardvark' },
      { id: oneId, name: 'Household One' },
      { id: extra[1].id, name: 'Household One' },
      { id: twoId, name: 'Household Two' },
    ]);
    for (const member of body.members) assert.deepEqual(Object.keys(member), ['id', 'name']);
    assert.deepEqual((await get(two, '/api/members')).members, body.members);
  } finally {
    await fixture.client`delete from users where id in ${fixture.client(extra.map((row) => row.id))}`;
  }
  const response = await fixture.app.request('/api/members');
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('a list is shared and unshared by PATCH, alone or with a name; bad bodies change nothing (AC-3)', async () => {
  const created = await createList(one, 'Groceries');
  assert.deepEqual(Object.keys(created).sort(), listKeys);
  assert.deepEqual([created.shared, created.ownerId], [false, oneId]);

  const shared = await patchList(one, created.id, { shared: true });
  assert.deepEqual(Object.keys(shared).sort(), listKeys);
  assert.deepEqual([shared.name, shared.shared, shared.ownerId, shared.createdAt], ['Groceries', true, oneId, created.createdAt]);
  assert.ok(Date.parse(shared.updatedAt) > Date.parse(created.updatedAt));
  assert.deepEqual(await getLists(one), [shared]);

  const both = await patchList(one, created.id, { name: ' Food ', shared: false });
  assert.deepEqual([both.name, both.shared], ['Food', false]);
  const renamed = await patchList(one, created.id, { name: 'Shop' });
  assert.deepEqual([renamed.name, renamed.shared], ['Shop', false]);
  const sharedAgain = await patchList(one, created.id, { shared: true, ownerId: twoId, userId: twoId });
  assert.deepEqual([sharedAgain.shared, sharedAgain.ownerId], [true, oneId]);
  // A new list is never shared, whatever the body says (D-7).
  const response = await send(one, 'POST', '/api/lists', { name: 'Never shared', shared: true });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).list.shared, false);

  const before = await storedLists();
  for (const shared of ['true', 1, 0, null, [], {}]) {
    await assertError(await send(one, 'PATCH', `/api/lists/${created.id}`, { shared }), 400, 'invalid_shared');
    await assertError(await send(one, 'PATCH', `/api/lists/${created.id}`, { name: 'Ok', shared }), 400, 'invalid_shared');
  }
  for (const body of [{}, { title: 'Home' }, { owner: 2 }, [], '7', 'null', '"Home"']) {
    await assertError(await send(one, 'PATCH', `/api/lists/${created.id}`, body), 400, 'invalid_list_update');
  }
  // An invalid name still answers invalid_list_name, also next to a valid shared.
  for (const name of ['', '  ', null, 7, 'Inbox']) {
    await assertError(await send(one, 'PATCH', `/api/lists/${created.id}`, { name, shared: false }), 400, 'invalid_list_name');
  }
  await assertError(await send(one, 'PATCH', `/api/lists/${created.id}`, '{"shared":'), 400, 'invalid_json');
  assert.deepEqual(await storedLists(), before);
});

test('shared lists and their tasks are visible to every user; unshared ones stay invisible (AC-4)', async () => {
  const shared = await createList(one, 'Shared', true);
  const privateList = await createList(one, 'Private');
  const theirs = await createList(two, 'Theirs');
  const sharedTask = await createTask(one, { title: 'In shared', listId: shared.id });
  const privateTask = await createTask(one, { title: 'In private', listId: privateList.id });
  const inboxTask = await createTask(one, { title: 'In Inbox' });
  const theirTask = await createTask(two, { title: 'Their Inbox' });

  // Oldest first across owners.
  assert.deepEqual(ids(await getLists(one)), [shared.id, privateList.id]);
  const seen = await getLists(two);
  assert.deepEqual(ids(seen), [shared.id, theirs.id]);
  assert.deepEqual(seen[0], { ...shared });
  assert.deepEqual(ids(await listTasks(two)), [theirTask.id, sharedTask.id]);
  assert.deepEqual(ids(await listTasks(one)), [inboxTask.id, privateTask.id, sharedTask.id]);

  // The private list and one's other tasks are exactly as invisible as before.
  const before = { lists: await storedLists(), tasks: await storedTasks() };
  await assertError(await send(two, 'PATCH', `/api/lists/${privateList.id}`, { name: 'Taken' }), 404, 'list_not_found');
  await assertError(await send(two, 'PATCH', `/api/lists/${privateList.id}`, { shared: true }), 404, 'list_not_found');
  await assertError(await send(two, 'DELETE', `/api/lists/${privateList.id}`), 404, 'list_not_found');
  for (const task of [privateTask, inboxTask]) {
    await assertError(await send(two, 'PATCH', `/api/tasks/${task.id}`, { title: 'Taken' }), 404, 'task_not_found');
    await assertError(await send(two, 'PATCH', `/api/tasks/${task.id}`, { listId: shared.id }), 404, 'task_not_found');
    await assertError(await send(two, 'DELETE', `/api/tasks/${task.id}`), 404, 'task_not_found');
  }
  await assertError(await send(two, 'POST', '/api/tasks', { title: 'Sneak', listId: privateList.id }), 400, 'invalid_list');
  await assertError(await send(two, 'PATCH', `/api/tasks/${theirTask.id}`, { listId: privateList.id }), 400, 'invalid_list');
  await assertError(await send(one, 'PATCH', `/api/tasks/${inboxTask.id}`, { listId: theirs.id }), 400, 'invalid_list');
  assert.deepEqual({ lists: await storedLists(), tasks: await storedTasks() }, before);

  // A member who signs in to Tasks for the first time after a list was shared
  // sees it: deleting Household Two's app user makes the next sign-in their first.
  await fixture.client`delete from users where id = ${twoId}`;
  two = await signIn(fixture, 1);
  twoId = await userIdOf('two@example.test');
  assert.deepEqual(ids(await getLists(two)), [shared.id]);
  assert.deepEqual(ids(await listTasks(two)), [sharedTask.id]);
});

test('any member renames, shares, unshares and deletes a shared list and changes its tasks (AC-5)', async () => {
  const shared = await createList(one, 'Household', true);
  await createList(one, 'Groceries');
  await createList(two, 'Errands');
  const task = await createTask(one, { title: 'Owner task', listId: shared.id });

  // Names are checked against the owner's lists, not the member's (D-3).
  const message = await assertError(await send(two, 'PATCH', `/api/lists/${shared.id}`, { name: 'groceries' }), 409, 'duplicate_list_name');
  assert.match(message, /owner/);
  const renamed = await patchList(two, shared.id, { name: 'Errands' });
  assert.deepEqual([renamed.name, renamed.ownerId, renamed.shared], ['Errands', oneId, true]);
  // The owner's own duplicate check is unchanged.
  assert.doesNotMatch(await assertError(await send(one, 'PATCH', `/api/lists/${shared.id}`, { name: 'Groceries' }), 409, 'duplicate_list_name'), /owner/);

  // Add, edit, complete, reopen and delete tasks in it.
  const added = await createTask(two, { title: 'Member task', listId: shared.id });
  assert.equal((await storedTask(added.id))!.user_id, oneId);
  const edited = await patchTask(two, task.id, { title: 'Owner task, edited', notes: 'By two', dueDate: '2026-12-01' });
  assert.deepEqual([edited.task.title, edited.task.dueDate], ['Owner task, edited', '2026-12-01']);
  assert.equal((await patchTask(two, task.id, { completed: true })).task.completed, true);
  assert.equal((await patchTask(two, task.id, { completed: false })).task.completed, false);
  assert.equal((await send(two, 'DELETE', `/api/tasks/${added.id}`)).status, 204);
  assert.equal(await storedTask(added.id), undefined);
  assert.equal((await storedTask(task.id))!.user_id, oneId);

  // Unshare and share again, by the member.
  const member = await createTask(two, { title: 'Member task 2', listId: shared.id });
  assert.equal((await patchList(two, shared.id, { shared: false })).shared, false);
  // The member has lost access; the owner keeps the list and every task, also
  // the one the member added (D-2).
  await assertError(await send(two, 'PATCH', `/api/lists/${shared.id}`, { shared: true }), 404, 'list_not_found');
  await assertError(await send(two, 'DELETE', `/api/lists/${shared.id}`), 404, 'list_not_found');
  for (const id of [task.id, member.id]) {
    await assertError(await send(two, 'PATCH', `/api/tasks/${id}`, { completed: true }), 404, 'task_not_found');
    await assertError(await send(two, 'DELETE', `/api/tasks/${id}`), 404, 'task_not_found');
  }
  assert.deepEqual(ids(await getLists(two)).includes(shared.id), false);
  assert.deepEqual(ids(await listTasks(two)), []);
  assert.deepEqual(ids(await listTasks(one)).sort(), [task.id, member.id].sort());
  assert.deepEqual((await listTasks(one)).map((item) => item.listId), [shared.id, shared.id]);

  // Shared again by the owner, then deleted by the member.
  await patchList(one, shared.id, { shared: true });
  const deleted = await send(two, 'DELETE', `/api/lists/${shared.id}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { movedTaskIds: [task.id, member.id].sort((a, b) => a - b) });
  assert.equal((await storedLists()).some((row) => row.id === shared.id), false);
});

test('moving gives a task to its new list\'s owner, or to the mover in Inbox; createdById stays (AC-6)', async () => {
  const oneShared = await createList(one, 'One shared', true);
  const twoShared = await createList(two, 'Two shared', true);
  const twoPrivate = await createList(two, 'Two private');
  const task = await createTask(one, { title: 'Moving', listId: oneShared.id });
  const owner = async () => (await storedTask(task.id))!.user_id;

  // Into the other member's shared list: the owner becomes that list's owner.
  assert.equal((await patchTask(one, task.id, { listId: twoShared.id })).task.listId, twoShared.id);
  assert.equal(await owner(), twoId);
  // Two moves it into their own unshared list: theirs alone now.
  assert.equal((await patchTask(two, task.id, { listId: twoPrivate.id })).task.listId, twoPrivate.id);
  assert.equal(await owner(), twoId);
  assert.equal(ids(await listTasks(one)).includes(task.id), false);
  await assertError(await send(one, 'PATCH', `/api/tasks/${task.id}`, { title: 'Gone' }), 404, 'task_not_found');
  // Back into one's shared list: one owns it again and sees it.
  await patchTask(two, task.id, { listId: oneShared.id });
  assert.equal(await owner(), oneId);
  assert.ok(ids(await listTasks(one)).includes(task.id));
  // Two moves it out to their Inbox: it disappears for one.
  const moved = await patchTask(two, task.id, { listId: null });
  assert.equal(moved.task.listId, null);
  assert.equal(await owner(), twoId);
  assert.equal(ids(await listTasks(one)).includes(task.id), false);
  assert.ok(ids(await listTasks(two)).includes(task.id));
  // A change without a move keeps owner and list.
  await patchTask(two, task.id, { listId: oneShared.id });
  await patchTask(two, task.id, { title: 'Still one\'s' });
  assert.equal(await owner(), oneId);
  // createdById never changed.
  assert.equal((await storedTask(task.id))!.created_by_id, oneId);
  assert.equal((await listTasks(one)).find((item) => item.id === task.id)!.createdById, oneId);
  // Every stored task in a list has the list's owner (tasks_list_fk holds).
  const mismatched = await fixture.client`
    select count(*)::int as count from tasks t join lists l on l.id = t.list_id where t.user_id <> l.user_id`;
  assert.equal(mismatched[0].count, 0);
});

test('deleting a shared list sends each task to its creator\'s Inbox and clears assignees (AC-7)', async () => {
  const shared = await createList(one, 'Shared', true);
  const byOne = await createTask(one, { title: 'By one', listId: shared.id, assigneeId: twoId });
  const byTwo = await createTask(two, { title: 'By two', listId: shared.id, assigneeId: oneId });
  const doneByTwo = await createTask(two, { title: 'Done by two', listId: shared.id });
  await patchTask(one, doneByTwo.id, { completed: true });
  const unknown = await createTask(two, { title: 'Unknown creator', listId: shared.id });
  await fixture.client`update tasks set created_by_id = null where id = ${unknown.id}`;

  const response = await send(two, 'DELETE', `/api/lists/${shared.id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    movedTaskIds: [byOne.id, byTwo.id, doneByTwo.id, unknown.id].sort((a, b) => a - b),
  });
  const where = async (id: number) => {
    const row = (await storedTask(id))!;
    return [row.user_id, row.list_id, row.assignee_id, row.completed];
  };
  assert.deepEqual(await where(byOne.id), [oneId, null, null, false]);
  assert.deepEqual(await where(byTwo.id), [twoId, null, null, false]);
  assert.deepEqual(await where(doneByTwo.id), [twoId, null, null, true]);
  assert.deepEqual(await where(unknown.id), [oneId, null, null, false]);
  assert.deepEqual(ids(await listTasks(one)).sort(), [byOne.id, unknown.id].sort());
  assert.deepEqual(ids(await listTasks(two)).sort(), [byTwo.id, doneByTwo.id].sort());
  assert.equal((await listTasks(two)).find((task) => task.id === byTwo.id)!.assigneeId, null);

  // An unshared list's tasks, also ones another member added while it was
  // shared, go to the owner's Inbox.
  const formerly = await createList(one, 'Formerly shared', true);
  const added = await createTask(two, { title: 'Added while shared', listId: formerly.id });
  await patchList(one, formerly.id, { shared: false });
  const deleted = await send(one, 'DELETE', `/api/lists/${formerly.id}`);
  assert.deepEqual(await deleted.json(), { movedTaskIds: [added.id] });
  assert.deepEqual(await where(added.id), [oneId, null, null, false]);
});

test('a shared list deleted while the other member adds or moves tasks into it never answers 500 (AC-7)', async () => {
  const weekly = { every: 1, unit: 'week' };
  for (let round = 0; round < 10; round++) {
    const list = await createList(one, `Race ${round}`, true);
    const other = await createList(two, `Other ${round}`, true);
    const inList = await createTask(one, { title: `Race: in ${round}`, listId: list.id, dueDate: '2026-11-20', repeat: weekly });
    const outside = await createTask(two, { title: `Race: outside ${round}`, listId: other.id });
    const leaving = await createTask(two, { title: `Race: leaving ${round}`, listId: list.id });
    const requests = [
      send(two, 'POST', '/api/tasks', { title: `Race: added ${round}`, listId: list.id, assigneeId: oneId }),
      send(two, 'PATCH', `/api/tasks/${outside.id}`, { listId: list.id }),
      send(two, 'PATCH', `/api/tasks/${inList.id}`, { completed: true }),
      send(two, 'PATCH', `/api/tasks/${leaving.id}`, { listId: other.id }),
      send(one, 'PATCH', `/api/lists/${list.id}`, { name: `Race renamed ${round}` }),
    ];
    const deleteAt = round % (requests.length + 1);
    requests.splice(deleteAt, 0, send(round % 2 ? one : two, 'DELETE', `/api/lists/${list.id}`));
    const responses = await Promise.all(requests);
    const [deleted] = responses.splice(deleteAt, 1);
    const [added, movedIn, completed, movedOut, renamed] = responses;
    assert.equal(deleted.status, 200);
    assert.ok([201, 400].includes(added.status), `add: ${added.status}`);
    if (added.status === 400) assert.equal((await added.json()).error, 'invalid_list');
    else {
      const row = (await storedTask((await added.json()).task.id))!;
      // Landed in the adder's Inbox, without the assignee.
      assert.deepEqual([row.list_id, row.user_id, row.assignee_id], [null, twoId, null]);
    }
    assert.ok([200, 400].includes(movedIn.status), `move in: ${movedIn.status}`);
    if (movedIn.status === 400) assert.equal((await movedIn.json()).error, 'invalid_list');
    assert.ok([null, other.id].includes((await storedTask(outside.id))!.list_id));
    // After the delete the task is in one's Inbox, which two cannot see.
    assert.ok([200, 404].includes(completed.status), `complete: ${completed.status}`);
    assert.deepEqual([(await storedTask(inList.id))!.list_id, (await storedTask(inList.id))!.user_id], [null, oneId]);
    assert.equal(movedOut.status, 200, 'moving a task out of the list');
    assert.equal((await storedTask(leaving.id))!.list_id, other.id);
    assert.ok([200, 404].includes(renamed.status), `rename: ${renamed.status}`);
    assert.equal((await fixture.client`select count(*)::int as count from tasks where list_id = ${list.id}`)[0].count, 0);
    const mismatched = await fixture.client`
      select count(*)::int as count from tasks t join lists l on l.id = t.list_id where t.user_id <> l.user_id`;
    assert.equal(mismatched[0].count, 0);
  }
});

test('a member who unshares a list while the other changes its tasks never answers 500 (AC-5)', async () => {
  for (let round = 0; round < 8; round++) {
    const list = await createList(one, `Unshare race ${round}`, true);
    const task = await createTask(one, { title: `Unshare race ${round}`, listId: list.id, assigneeId: twoId });
    const requests = [
      send(two, 'PATCH', `/api/tasks/${task.id}`, { title: `Changed ${round}`, assigneeId: twoId }),
      send(two, 'POST', '/api/tasks', { title: `Unshare added ${round}`, listId: list.id }),
      send(two, 'PATCH', `/api/tasks/${task.id}`, { completed: true }),
    ];
    const at = round % (requests.length + 1);
    requests.splice(at, 0, send(round % 2 ? one : two, 'PATCH', `/api/lists/${list.id}`, { shared: false }));
    const responses = await Promise.all(requests);
    const [unshared] = responses.splice(at, 1);
    assert.equal(unshared.status, 200);
    for (const response of responses) assert.ok([200, 201, 400, 404].includes(response.status), `status ${response.status}`);
    // Whatever ran first, the list's tasks are one's and have no assignee.
    const rows = await fixture.client`select user_id, assignee_id from tasks where list_id = ${list.id}`;
    for (const row of rows) assert.deepEqual([row.user_id, row.assignee_id], [oneId, null]);
  }
});

test('createdById and completedById record who added and who completed a task (AC-8)', async () => {
  const shared = await createList(one, 'Shared', true);
  const added = await createTask(two, { title: 'Added by two', listId: shared.id });
  assert.deepEqual([added.createdById, added.completedById, added.assigneeId], [twoId, null, null]);
  assert.equal((await createTask(one, { title: 'Inbox' })).createdById, oneId);

  const done = await patchTask(one, added.id, { completed: true });
  assert.deepEqual([done.task.completedById, done.task.createdById], [oneId, twoId]);
  // Unchanged by other changes, also completed: true again by someone else.
  assert.equal((await patchTask(two, added.id, { title: 'Renamed' })).task.completedById, oneId);
  assert.equal((await patchTask(two, added.id, { completed: true })).task.completedById, oneId);
  assert.equal((await patchTask(two, added.id, { completed: false })).task.completedById, null);
  assert.equal((await patchTask(two, added.id, { completed: true, title: 'Done by two' })).task.completedById, twoId);
  // The client cannot choose these.
  const forged = await patchTask(one, added.id, { title: 'Forged', createdById: oneId, completedById: oneId, userId: oneId });
  assert.deepEqual([forged.task.createdById, forged.task.completedById], [twoId, twoId]);

  // A repeating task's next occurrence keeps its creator, list and assignee.
  const repeating = await createTask(two, {
    title: 'Bins',
    listId: shared.id,
    dueDate: '2026-11-20',
    repeat: { every: 1, unit: 'week' },
    assigneeId: oneId,
  });
  const completed = await patchTask(one, repeating.id, { completed: true });
  const next = completed.nextTask!;
  assert.deepEqual(Object.keys(next).sort(), taskKeys);
  assert.deepEqual(
    [next.createdById, next.completedById, next.assigneeId, next.listId, next.dueDate, next.completed],
    [twoId, null, oneId, shared.id, '2026-11-27', false],
  );
  assert.equal((await storedTask(next.id))!.user_id, oneId);
  assert.deepEqual((await listTasks(two)).find((task) => task.id === next.id), next);
  // Reopening removes the open next occurrence, also for the other member.
  const reopened = await patchTask(two, repeating.id, { completed: false });
  assert.equal(reopened.removedTaskId, next.id);
});

test('a task in a shared list can be assigned to a member; nowhere else (AC-9)', async () => {
  const shared = await createList(one, 'Shared', true);
  const otherShared = await createList(two, 'Other shared', true);
  const privateList = await createList(one, 'Private');
  const task = await createTask(one, { title: 'Assign me', listId: shared.id, assigneeId: twoId });
  assert.equal(task.assigneeId, twoId);
  assert.equal((await createTask(two, { title: 'Nobody', listId: shared.id, assigneeId: null })).assigneeId, null);
  // A PATCH with only assigneeId is a valid update.
  assert.equal((await patchTask(two, task.id, { assigneeId: oneId })).task.assigneeId, oneId);
  assert.equal((await patchTask(two, task.id, { assigneeId: null })).task.assigneeId, null);
  assert.equal((await patchTask(two, task.id, { assigneeId: twoId })).task.assigneeId, twoId);
  // Kept by other changes and by a move to another shared list.
  assert.equal((await patchTask(one, task.id, { title: 'Still assigned', completed: true })).task.assigneeId, twoId);
  assert.equal((await patchTask(one, task.id, { listId: otherShared.id })).task.assigneeId, twoId);
  // Assigned in the same request that moves a task into a shared list.
  const inbox = await createTask(one, { title: 'From Inbox' });
  const movedIn = await patchTask(one, inbox.id, { listId: shared.id, assigneeId: oneId });
  assert.deepEqual([movedIn.task.listId, movedIn.task.assigneeId], [shared.id, oneId]);

  // Refused outside shared lists, for unknown users and for bad values; nothing changes.
  const inPrivate = await createTask(one, { title: 'Private', listId: privateList.id });
  const before = await storedTasks();
  const count = before.length;
  const badValues: unknown[] = ['1', String(twoId), 0, -1, 1.5, true, [twoId], { id: twoId }, 2147483648, 999999];
  for (const assigneeId of badValues) {
    await assertError(await send(one, 'POST', '/api/tasks', { title: 'Never', listId: shared.id, assigneeId }), 400, 'invalid_assignee');
    await assertError(await send(one, 'PATCH', `/api/tasks/${task.id}`, { assigneeId }), 400, 'invalid_assignee');
    await assertError(await send(one, 'PATCH', `/api/tasks/${task.id}`, { title: 'Never', assigneeId }), 400, 'invalid_assignee');
  }
  for (const assigneeId of [oneId, null]) {
    await assertError(await send(one, 'POST', '/api/tasks', { title: 'Never', assigneeId }), 400, 'invalid_assignee');
    await assertError(await send(one, 'POST', '/api/tasks', { title: 'Never', listId: privateList.id, assigneeId }), 400, 'invalid_assignee');
    await assertError(await send(one, 'PATCH', `/api/tasks/${inPrivate.id}`, { assigneeId }), 400, 'invalid_assignee');
    await assertError(await send(one, 'PATCH', `/api/tasks/${inbox.id}`, { listId: null, assigneeId }), 400, 'invalid_assignee');
    // Moving out of a shared list while assigning in the same request.
    await assertError(await send(one, 'PATCH', `/api/tasks/${task.id}`, { listId: privateList.id, assigneeId }), 400, 'invalid_assignee');
  }
  assert.deepEqual(await storedTasks(), before);
  assert.equal((await storedTasks()).length, count);

  // Moving out of a shared list clears the assignee.
  const out = await patchTask(one, inbox.id, { listId: privateList.id });
  assert.deepEqual([out.task.listId, out.task.assigneeId], [privateList.id, null]);
  // Unsharing the list clears its tasks' assignees.
  const stays = await createTask(one, { title: 'Stays', listId: shared.id, assigneeId: twoId });
  await patchList(two, shared.id, { shared: false });
  assert.equal((await storedTask(stays.id))!.assignee_id, null);
  assert.equal((await listTasks(one)).find((item) => item.id === stays.id)!.assigneeId, null);

  // The empty-update message names the new field too.
  const message = await assertError(await send(one, 'PATCH', `/api/tasks/${stays.id}`, {}), 400, 'invalid_update');
  assert.match(message, /assigneeId/);
});

test('every task object has the attribution and assignee fields, never user_id (AC-10)', async () => {
  const shared = await createList(one, 'Shared', true);
  const created = await createTask(two, { title: 'Shape', listId: shared.id, dueDate: '2026-11-20', repeat: { every: 1, unit: 'day' } });
  assert.deepEqual(Object.keys(created).sort(), taskKeys);
  const updated = await patchTask(one, created.id, { completed: true });
  assert.deepEqual(Object.keys(updated.task).sort(), taskKeys);
  assert.deepEqual(Object.keys(updated.nextTask!).sort(), taskKeys);
  for (const session of [one, two]) {
    const listed = await listTasks(session);
    assert.equal(listed.length, 2);
    for (const task of listed) {
      assert.deepEqual(Object.keys(task).sort(), taskKeys);
      for (const field of ['createdById', 'completedById', 'assigneeId'] as const) {
        assert.ok(task[field] === null || Number.isInteger(task[field]));
      }
    }
  }
});
