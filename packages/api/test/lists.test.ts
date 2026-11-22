import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createFixture } from './fixture.js';
import { appOrigin, signIn } from './session.js';

// Task lists. The criteria named below are those of the lists task.

type List = { id: number; name: string; createdAt: string; updatedAt: string };
type Task = {
  id: number;
  title: string;
  listId: number | null;
  completed: boolean;
  dueDate: string | null;
  repeat: { every: number; unit: string } | null;
  createdAt: string;
  updatedAt: string;
};
type PatchBody = { task: Task; nextTask: Task | null; removedTaskId: number | null };

let fixture: Awaited<ReturnType<typeof createFixture>>;
let one: string;
let two: string;
before(async () => {
  fixture = await createFixture();
  // Noon UTC on Friday 2026-11-20, so repeat schedules are predictable.
  fixture.setNow(new Date('2026-11-20T12:00:00Z'));
  one = await signIn(fixture, 0);
  two = await signIn(fixture, 1);
});
// Every test starts without lists, so names and the 50-list limit do not
// depend on the tests before it. Tasks are moved to Inbox first: the database
// refuses to delete a list that tasks still point at.
beforeEach(async () => {
  await fixture.client`update tasks set list_id = null where list_id is not null`;
  await fixture.client`delete from lists`;
});
after(async () => {
  await fixture?.close();
});

function send(
  session: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  { origin = appOrigin as string | null } = {},
) {
  return fixture.app.request(path, {
    method,
    headers: {
      Cookie: session,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(origin === null ? {} : { Origin: origin }),
    },
    body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function getLists(session: string): Promise<List[]> {
  const response = await fixture.app.request('/api/lists', { headers: { Cookie: session } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['lists']);
  return body.lists;
}
async function createList(session: string, name: string): Promise<List> {
  const response = await send(session, 'POST', '/api/lists', { name });
  assert.equal(response.status, 201, name);
  return (await response.json()).list;
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
// Stored rows, with timestamps as PostgreSQL prints them (exact).
async function storedLists() {
  return (
    await fixture.client`select id, user_id, name, created_at::text, updated_at::text from lists order by id`
  ).map((row) => ({ ...row }));
}
async function storedTask(id: number) {
  const [row] = await fixture.client`
    select user_id, list_id, title, completed, updated_at::text from tasks where id = ${id}`;
  return row ? { ...row } : undefined;
}
async function taskRowCount() {
  return (await fixture.client`select count(*)::int as count from tasks`)[0].count as number;
}

const emoji = '\u{1F600}'; // one character, two UTF-16 units
// Names the API stores as given (the expected stored name follows each).
const keptNames: [sent: string, stored: string][] = [
  ['Errands', 'Errands'],
  ['  Home \n', 'Home'],
  ['x'.repeat(50), 'x'.repeat(50)],
  [` ${'y'.repeat(50)}\t`, 'y'.repeat(50)],
  // The limit counts code points: 50 emoji are 100 UTF-16 units.
  [emoji.repeat(50), emoji.repeat(50)],
  ['z'.repeat(49) + emoji, 'z'.repeat(49) + emoji],
  // Only the reserved names themselves are refused, not names containing them.
  ['Inbox zero', 'Inbox zero'],
  ['All tasks today', 'All tasks today'],
];
const invalidNames: unknown[] = [
  '',
  '   ',
  '\t\n',
  '​', // zero width space
  ' ​ ﻿ ',
  '­', // soft hyphen
  '\u0001',
  'x'.repeat(51),
  emoji.repeat(51),
  'x'.repeat(50) + emoji,
  'a\u0000b',
  '\u0000',
  // Reserved in any letter case, also after trimming.
  'Inbox',
  'inbox',
  'INBOX',
  ' iNbOx ',
  'All tasks',
  'all tasks',
  'ALL TASKS',
  null,
  42,
  true,
  ['Home'],
  { name: 'Home' },
];

test('list names are trimmed and checked like titles, with a 50 character limit (AC-1)', async () => {
  for (const [sent, expected] of keptNames) {
    const list = await createList(one, sent);
    assert.equal(list.name, expected);
    assert.equal((await storedLists()).find((row) => row.id === list.id)!.name, expected);
  }
  // A rename applies the same rules.
  const list = await createList(one, 'Rename me');
  for (const [sent, expected] of [
    ['  Chores \n', 'Chores'],
    ['r'.repeat(50), 'r'.repeat(50)],
    [emoji.repeat(49) + 'r', emoji.repeat(49) + 'r'],
  ]) {
    const response = await send(one, 'PATCH', `/api/lists/${list.id}`, { name: sent });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).list.name, expected);
    assert.equal((await storedLists()).find((row) => row.id === list.id)!.name, expected);
  }
});

test('invalid and reserved list names answer 400 invalid_list_name and change nothing (AC-1)', async () => {
  const list = await createList(one, 'Keep me');
  const before = await storedLists();
  for (const name of invalidNames) {
    await assertError(await send(one, 'POST', '/api/lists', { name }), 400, 'invalid_list_name');
    await assertError(await send(one, 'PATCH', `/api/lists/${list.id}`, { name }), 400, 'invalid_list_name');
  }
  // A body without a name, or that is not an object, is an invalid name too.
  for (const body of [{}, { title: 'Home' }, [], '"Home"', '7', 'null']) {
    await assertError(await send(one, 'POST', '/api/lists', body), 400, 'invalid_list_name');
    await assertError(await send(one, 'PATCH', `/api/lists/${list.id}`, body), 400, 'invalid_list_name');
  }
  assert.deepEqual(await storedLists(), before);
});

test('names are unique per user ignoring letter case; two users may share one (AC-1)', async () => {
  const errands = await createList(one, 'Errands');
  const home = await createList(one, 'Home');
  const before = await storedLists();
  for (const name of ['Errands', 'errands', 'ERRANDS', '  eRRands ']) {
    await assertError(await send(one, 'POST', '/api/lists', { name }), 409, 'duplicate_list_name');
    await assertError(await send(one, 'PATCH', `/api/lists/${home.id}`, { name }), 409, 'duplicate_list_name');
  }
  assert.deepEqual(await storedLists(), before);

  // Renaming a list to itself in another letter case is allowed.
  const renamed = await send(one, 'PATCH', `/api/lists/${errands.id}`, { name: 'ERRANDS' });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).list.name, 'ERRANDS');
  // Renaming to exactly the same name is allowed too.
  assert.equal((await send(one, 'PATCH', `/api/lists/${home.id}`, { name: 'Home' })).status, 200);

  // Another user can have a list with the same name.
  const theirs = await createList(two, 'errands');
  assert.equal(theirs.name, 'errands');
  assert.notEqual(theirs.id, errands.id);
});

// Names that would show as a built-in view's tab: they differ from "Inbox" or
// "All tasks" only by letter case, invisible code points, or the white space
// between the words.
const reservedLookalikes = [
  'Inbox\u200b', // zero width space
  '\u200bInbox',
  'In\u200bbox',
  'In\u00adbox', // soft hyphen
  'In\u200dbox', // zero width joiner
  '\u200eInbox\u200f', // direction marks
  'Inbox\ufeff', // zero width no-break space
  'Inbox\u3164', // Hangul filler, invisible but not white space
  'In\u0001box', // a control character
  'INBOX\u2060', // word joiner
  'All\u00a0tasks', // no-break space
  'All  tasks',
  'All\ttasks',
  'All \u200b tasks',
  'All\u2003tasks', // em space
  'All\u3000TASKS', // ideographic space
  'All\u202ftasks', // narrow no-break space
  'All\u200b tasks\u200b',
];
// Names that only contain or resemble the words stay allowed.
const notReserved = ['Inbox later', 'In box', 'Inboxes', 'Alltasks', 'All tasks 2', 'All my tasks', 'Inbox\u200bzero'];

test('names that only look like "Inbox" or "All tasks" are reserved too (AC-1, D-3)', async () => {
  const list = await createList(one, 'Keep me');
  const before = await storedLists();
  for (const name of reservedLookalikes) {
    const created = await send(one, 'POST', '/api/lists', { name });
    assert.equal(created.status, 400, `POST ${JSON.stringify(name)}`);
    assert.equal((await created.json()).error, 'invalid_list_name');
    const renamed = await send(one, 'PATCH', `/api/lists/${list.id}`, { name });
    assert.equal(renamed.status, 400, `PATCH ${JSON.stringify(name)}`);
    assert.equal((await renamed.json()).error, 'invalid_list_name');
  }
  assert.deepEqual(await storedLists(), before);
  for (const name of notReserved) assert.equal((await createList(one, name)).name, name);
});

// The criteria below (AC-1 to AC-5 of the lists cleanup) compare names by
// their fold (foldListName in packages/api/src/lists.ts): NFKC, white space
// collapsed, invisible code points dropped, trimmed, lowercased.
const reservedByFold = [
  '\uff29\uff4e\uff42\uff4f\uff58', // fullwidth "Inbox"
  '\uff29\uff2e\uff22\uff2f\uff38', // fullwidth "INBOX"
  '\uff41\uff4c\uff4c\u3000\uff54\uff41\uff53\uff4b\uff53', // fullwidth "all tasks", ideographic space
  '\uff21\uff4c\uff4c\u3000\uff54\uff41\uff53\uff4b\uff53\u200b', // and a zero width space
  '\u{1d408}\u{1d427}\u{1d41b}\u{1d428}\u{1d431}', // mathematical bold "Inbox"
  '\u24be\u24dd\u24d1\u24de\u24e7', // circled "Inbox"
  'In\uff42ox', // one fullwidth letter
];
// Letters from other scripts that only look Latin are not folded (D-3).
const homoglyphs = ['\u0406nbox', '\u0410ll tasks', 'Inb\u043ex'];

test('names whose fold is "inbox" or "all tasks" are reserved, fullwidth forms too (cleanup AC-1, D-3)', async () => {
  const list = await createList(one, 'Keep me');
  const before = await storedLists();
  for (const name of reservedByFold) {
    const created = await send(one, 'POST', '/api/lists', { name });
    assert.equal(created.status, 400, `POST ${JSON.stringify(name)}`);
    assert.deepEqual(await created.json(), {
      error: 'invalid_list_name',
      message: '"Inbox" and "All tasks" are built in. Choose another name.',
    });
    const renamed = await send(one, 'PATCH', `/api/lists/${list.id}`, { name });
    assert.equal(renamed.status, 400, `PATCH ${JSON.stringify(name)}`);
    assert.equal((await renamed.json()).error, 'invalid_list_name');
  }
  assert.deepEqual(await storedLists(), before);
  for (const name of ['Inbox zero', 'In box', 'All tasks 2', ...homoglyphs]) {
    assert.equal((await createList(one, name)).name, name);
  }
});

test('two of a user\'s lists cannot share a fold; names are stored as typed (cleanup AC-2)', async () => {
  const home = await createList(one, 'Home');
  const weekly = await createList(one, 'Weekly shop');
  const spare = await createList(one, 'Spare');
  const before = await storedLists();
  for (const name of [
    'HOME',
    '\uff28\uff4f\uff4d\uff45', // fullwidth "Home"
    'Home\u200b', // zero width space
    'Ho\u00adme', // soft hyphen
    '\u2060home', // word joiner
    'Weekly  shop',
    'Weekly\u00a0shop', // no-break space
    'weekly\u3000SHOP', // ideographic space
    'Weekly\t\u200b shop',
  ]) {
    await assertError(await send(one, 'POST', '/api/lists', { name }), 409, 'duplicate_list_name');
    await assertError(await send(one, 'PATCH', `/api/lists/${spare.id}`, { name }), 409, 'duplicate_list_name');
  }
  assert.deepEqual(await storedLists(), before);

  // A rename to the list's own fold is allowed, and stored as typed.
  for (const name of ['\uff37\uff45\uff45\uff4b\uff4c\uff59  \uff53\uff48\uff4f\uff50', 'weekly\u200b shop', 'Weekly shop']) {
    const response = await send(one, 'PATCH', `/api/lists/${weekly.id}`, { name });
    assert.equal(response.status, 200, JSON.stringify(name));
    assert.equal((await response.json()).list.name, name);
    assert.equal((await storedLists()).find((row) => row.id === weekly.id)!.name, name);
  }
  // Another user may have lists with the same names, in any form.
  assert.equal((await createList(two, '\uff28\uff4f\uff4d\uff45')).name, '\uff28\uff4f\uff4d\uff45');
  assert.equal((await createList(two, 'Weekly  shop')).name, 'Weekly  shop');
  assert.equal((await getLists(one)).length, 3);
  assert.equal((await getLists(one)).find((list) => list.id === home.id)!.name, 'Home');
});

test('"\u0130stanbul" then "i\u0307stanbul" is a duplicate; a name only the index refuses answers 409 (cleanup AC-3)', async () => {
  // The fixture database's collation decides what lower() does.
  const [{ ctype, dotted }] = await fixture.client`
    select datctype as ctype, lower('\u0130stanbul') = 'istanbul' as dotted
    from pg_database where datname = current_database()`;
  console.log(`fixture database lc_ctype: ${ctype}; lower('\u0130stanbul') = 'istanbul': ${dotted}`);

  // "Istanbul" with a dotted capital I (U+0130) folds to an i followed by
  // U+0307, the second name here, as in the web form: so it is refused.
  const istanbul = await createList(one, '\u0130stanbul');
  await assertError(await send(one, 'POST', '/api/lists', { name: 'i\u0307stanbul' }), 409, 'duplicate_list_name');
  const other = await createList(one, 'Other');
  await assertError(
    await send(one, 'PATCH', `/api/lists/${other.id}`, { name: 'I\u0307STANBUL' }),
    409,
    'duplicate_list_name',
  );

  // "istanbul" has another fold, so the routes allow it, but where lower()
  // turns U+0130 into a plain i the index refuses it: still 409, never 500.
  if (dotted) {
    await assertError(await send(one, 'POST', '/api/lists', { name: 'istanbul' }), 409, 'duplicate_list_name');
    await assertError(await send(one, 'PATCH', `/api/lists/${other.id}`, { name: 'istanbul' }), 409, 'duplicate_list_name');
  } else {
    assert.equal((await createList(one, 'istanbul')).name, 'istanbul');
  }
  assert.equal((await getLists(one)).find((list) => list.id === istanbul.id)!.name, '\u0130stanbul');
  assert.equal((await getLists(one)).find((list) => list.id === other.id)!.name, 'Other');
});

test('parallel creates and renames of names with one fold leave one list with it (cleanup AC-4)', async () => {
  const forms = ['Groceries', '\uff27\uff52\uff4f\uff43\uff45\uff52\uff49\uff45\uff53', 'groceries\u200b', 'GROCERIES', 'Groceries\u00a0'];
  for (let round = 0; round < 5; round++) {
    await fixture.client`delete from lists`;
    const responses = await Promise.all(forms.map((name) => send(one, 'POST', '/api/lists', { name })));
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [201, 409, 409, 409, 409],
    );
    for (const response of responses) {
      if (response.status === 409) assert.equal((await response.json()).error, 'duplicate_list_name');
    }
    assert.equal((await getLists(one)).length, 1);
  }

  // A create and a rename, and two renames, to one fold.
  for (let round = 0; round < 5; round++) {
    await fixture.client`delete from lists`;
    const first = await createList(one, 'First');
    const second = await createList(one, 'Second');
    const responses = await Promise.all([
      send(one, 'POST', '/api/lists', { name: 'Chores' }),
      send(one, 'PATCH', `/api/lists/${first.id}`, { name: '\uff43\uff48\uff4f\uff52\uff45\uff53' }),
      send(one, 'PATCH', `/api/lists/${second.id}`, { name: 'CHORES\u200b' }),
    ]);
    const statuses = responses.map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 409).length, 2, String(statuses));
    assert.equal(statuses.filter((status) => status === 200 || status === 201).length, 1, String(statuses));
    const names = (await getLists(one)).map((list) => list.name);
    assert.equal(names.filter((name) => name.normalize('NFKC').replace('\u200b', '').toLowerCase() === 'chores').length, 1);
  }
});

test('lists stored before the fold check that share a fold both stay and can keep their names (cleanup AC-5)', async () => {
  const [me] = await fixture.client`select id from users where email = 'one@example.test'`;
  // Possible only for data written before this check: the index on lower()
  // allows both.
  const rows = await fixture.client`
    insert into lists (user_id, name)
    values (${me.id}, 'Home'), (${me.id}, ${'\uff28\uff4f\uff4d\uff45'}), (${me.id}, ${'Weekly shop'}), (${me.id}, ${'Weekly  shop'})
    returning id, name`;
  const before = await storedLists();
  assert.deepEqual(
    (await getLists(one)).map((list) => list.name),
    ['Home', '\uff28\uff4f\uff4d\uff45', 'Weekly shop', 'Weekly  shop'],
  );
  // Each can be renamed to its own name, or to another form of its own fold.
  for (const { id, name } of rows) {
    const response = await send(one, 'PATCH', `/api/lists/${id}`, { name });
    assert.equal(response.status, 200, name);
    assert.equal((await response.json()).list.name, name);
  }
  const weekly = rows.find((row) => row.name === 'Weekly  shop')!;
  const renamed = await send(one, 'PATCH', `/api/lists/${weekly.id}`, { name: 'Weekly   shop' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(
    (await storedLists()).map((row) => row.name),
    before.map((row) => (row.id === weekly.id ? 'Weekly   shop' : row.name)),
  );
  // A new name with that fold is refused, and another name is still fine.
  await assertError(await send(one, 'POST', '/api/lists', { name: 'home' }), 409, 'duplicate_list_name');
  const home = rows.find((row) => row.name === 'Home')!;
  await assertError(await send(one, 'PATCH', `/api/lists/${home.id}`, { name: 'Weekly shop' }), 409, 'duplicate_list_name');
  assert.equal((await send(one, 'PATCH', `/api/lists/${home.id}`, { name: 'House' })).status, 200);
});

test('lists are listed oldest first with their fields; create answers 201 and rename 200 (AC-2)', async () => {
  assert.deepEqual(await getLists(one), []);
  const home = await createList(one, 'Home');
  assert.deepEqual(Object.keys(home).sort(), ['createdAt', 'id', 'name', 'updatedAt']);
  assert.ok(Number.isInteger(home.id));
  assert.equal(home.createdAt, home.updatedAt);
  const errands = await createList(one, 'Errands');
  const work = await createList(one, 'Work');
  // Ties on the creation time are ordered by id.
  await fixture.client`update lists set created_at = (select created_at from lists where id = ${home.id}) where id = ${work.id}`;
  const listed = await getLists(one);
  assert.deepEqual(
    listed.map((list) => list.id),
    [home.id, work.id, errands.id],
  );
  assert.deepEqual(listed[0], home);

  const response = await send(one, 'PATCH', `/api/lists/${errands.id}`, { name: ' Shopping ', id: 999, userId: 2 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['list']);
  assert.equal(body.list.id, errands.id);
  assert.equal(body.list.name, 'Shopping');
  assert.equal(body.list.createdAt, errands.createdAt);
  assert.ok(Date.parse(body.list.updatedAt) > Date.parse(errands.updatedAt));
  assert.deepEqual((await getLists(one)).find((list) => list.id === errands.id), body.list);
  // The client cannot choose the owner: unknown keys are ignored.
  const [row] = await fixture.client`select user_id from lists where id = ${errands.id}`;
  const [me] = await fixture.client`select id from users where email = 'one@example.test'`;
  assert.equal(row.user_id, me.id);
});

test('a user can have at most 50 lists (AC-2)', async () => {
  for (let index = 1; index <= 50; index++) await createList(one, `List ${index}`);
  await assertError(await send(one, 'POST', '/api/lists', { name: 'List 51' }), 409, 'list_limit_reached');
  // Parallel creates cannot pass the limit either.
  const victim = (await getLists(one))[0];
  assert.equal((await send(one, 'DELETE', `/api/lists/${victim.id}`)).status, 200);
  const responses = await Promise.all(
    Array.from({ length: 4 }, (_, index) => send(one, 'POST', '/api/lists', { name: `Parallel ${index}` })),
  );
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [201, 409, 409, 409],
  );
  assert.equal((await getLists(one)).length, 50);
  // The limit is per user.
  await createList(two, 'Theirs');
  // Invalid names are still reported as such at the limit.
  await assertError(await send(one, 'POST', '/api/lists', { name: '' }), 400, 'invalid_list_name');
});

test('malformed JSON and malformed list ids are rejected (AC-2)', async () => {
  const list = await createList(one, 'Home');
  const before = await storedLists();
  await assertError(await send(one, 'POST', '/api/lists', '{"name":'), 400, 'invalid_json');
  await assertError(await send(one, 'PATCH', `/api/lists/${list.id}`, '{"name":'), 400, 'invalid_json');
  for (const id of ['abc', '0', '-1', '1.5', '01', ' 1', '1e3', '99999999999999999']) {
    await assertError(await send(one, 'PATCH', `/api/lists/${encodeURIComponent(id)}`, { name: 'X' }), 400, 'invalid_list_id');
    await assertError(await send(one, 'DELETE', `/api/lists/${encodeURIComponent(id)}`), 400, 'invalid_list_id');
  }
  // Well formed but beyond the id column: not found.
  await assertError(await send(one, 'PATCH', '/api/lists/2147483648', { name: 'X' }), 404, 'list_not_found');
  await assertError(await send(one, 'DELETE', '/api/lists/9999999999'), 404, 'list_not_found');
  assert.deepEqual(await storedLists(), before);
});

test('deleting a list moves its open and completed tasks to Inbox in one step (AC-3)', async () => {
  const errands = await createList(one, 'Errands');
  const home = await createList(one, 'Home');
  const open = await createTask(one, { title: 'Lists: open', listId: errands.id });
  const done = await createTask(one, { title: 'Lists: done', listId: errands.id });
  await patchTask(one, done.id, { completed: true });
  const atHome = await createTask(one, { title: 'Lists: at home', listId: home.id });
  const inbox = await createTask(one, { title: 'Lists: inbox' });
  const theirList = await createList(two, 'Errands');
  const theirs = await createTask(two, { title: 'Lists: theirs', listId: theirList.id });
  const untouched = await Promise.all([atHome.id, inbox.id, theirs.id].map(storedTask));
  const homeRow = (await storedLists()).find((row) => row.id === home.id);
  const before = { open: await storedTask(open.id), done: await storedTask(done.id) };

  const response = await send(one, 'DELETE', `/api/lists/${errands.id}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { movedTaskIds: [open.id, done.id].sort((a, b) => a - b) });

  for (const [id, row] of [[open.id, before.open], [done.id, before.done]] as const) {
    const after = await storedTask(id);
    assert.equal(after!.list_id, null);
    assert.equal(after!.completed, row!.completed);
    assert.equal(after!.title, row!.title);
    assert.ok(after!.updated_at > row!.updated_at, 'updatedAt is refreshed');
  }
  assert.deepEqual(await Promise.all([atHome.id, inbox.id, theirs.id].map(storedTask)), untouched);
  assert.deepEqual((await storedLists()).find((row) => row.id === home.id), homeRow);
  assert.equal((await storedLists()).some((row) => row.id === errands.id), false);
  assert.deepEqual((await getLists(one)).map((list) => list.name), ['Home']);
  const listed = await listTasks(one);
  assert.equal(listed.find((task) => task.id === open.id)!.listId, null);
  assert.equal(listed.find((task) => task.id === done.id)!.listId, null);

  // An empty list answers with no moved tasks.
  const empty = await createList(one, 'Empty');
  const emptied = await send(one, 'DELETE', `/api/lists/${empty.id}`);
  assert.equal(emptied.status, 200);
  assert.deepEqual(await emptied.json(), { movedTaskIds: [] });
});

test('another user\'s, unknown and deleted lists answer 404 and nothing changes (AC-4)', async () => {
  const mine = await createList(one, 'Private');
  const task = await createTask(one, { title: 'Lists: private', listId: mine.id });
  const gone = await createList(one, 'Gone');
  assert.equal((await send(one, 'DELETE', `/api/lists/${gone.id}`)).status, 200);
  const before = await storedLists();
  const taskBefore = await storedTask(task.id);

  for (const [session, id] of [[two, mine.id], [one, gone.id], [one, 2147483647], [two, gone.id]] as const) {
    await assertError(await send(session, 'PATCH', `/api/lists/${id}`, { name: 'Taken over' }), 404, 'list_not_found');
    await assertError(await send(session, 'DELETE', `/api/lists/${id}`), 404, 'list_not_found');
  }
  assert.deepEqual(await storedLists(), before);
  assert.deepEqual(await storedTask(task.id), taskBefore);
  // GET never shows another user's lists.
  assert.deepEqual(await getLists(two), []);
  assert.deepEqual((await getLists(one)).map((list) => list.id), [mine.id]);
});

test('list writes need the application origin and every list route a session (AC-4)', async () => {
  const list = await createList(one, 'Origin checked');
  const before = await storedLists();
  for (const origin of ['https://evil.example', 'http://localhost:3000', 'https://localhost:5173', 'null', null]) {
    await assertError(await send(one, 'POST', '/api/lists', { name: 'Cross-site' }, { origin }), 403, 'forbidden_origin');
    await assertError(await send(one, 'PATCH', `/api/lists/${list.id}`, { name: 'Cross-site' }, { origin }), 403, 'forbidden_origin');
    await assertError(await send(one, 'DELETE', `/api/lists/${list.id}`, undefined, { origin }), 403, 'forbidden_origin');
  }
  assert.deepEqual(await storedLists(), before);
  for (const [method, path] of [['GET', '/api/lists'], ['POST', '/api/lists'], ['PATCH', `/api/lists/${list.id}`], ['DELETE', `/api/lists/${list.id}`]]) {
    const response = await fixture.app.request(path, {
      method,
      headers: { Origin: appOrigin, 'Content-Type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({ name: 'No session' }),
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  assert.deepEqual(await storedLists(), before);
});

test('every task has listId; tasks are created in Inbox or a list and moved by PATCH (AC-5)', async () => {
  const errands = await createList(one, 'Errands');
  const home = await createList(one, 'Home');
  const inboxTask = await createTask(one, { title: 'Lists: no list' });
  assert.equal(inboxTask.listId, null);
  assert.equal((await createTask(one, { title: 'Lists: null list', listId: null })).listId, null);
  const errand = await createTask(one, { title: 'Lists: errand', listId: errands.id });
  assert.equal(errand.listId, errands.id);
  assert.equal((await storedTask(errand.id))!.list_id, errands.id);

  const listed = await listTasks(one);
  for (const task of listed) assert.ok(task.listId === null || Number.isInteger(task.listId));
  assert.deepEqual(listed.find((task) => task.id === errand.id), errand);

  // A PATCH with only listId is a valid update that moves the task.
  const moved = await patchTask(one, errand.id, { listId: home.id });
  assert.equal(moved.task.listId, home.id);
  assert.equal(moved.task.title, 'Lists: errand');
  assert.ok(Date.parse(moved.task.updatedAt) > Date.parse(errand.updatedAt));
  assert.deepEqual([moved.nextTask, moved.removedTaskId], [null, null]);
  // Omitting listId leaves the list unchanged, whatever else changes.
  const renamed = await patchTask(one, errand.id, { title: 'Lists: renamed', completed: true });
  assert.equal(renamed.task.listId, home.id);
  // null moves it to Inbox; listId and other fields change together.
  const toInbox = await patchTask(one, errand.id, { listId: null, title: 'Lists: back', completed: false });
  assert.deepEqual([toInbox.task.listId, toInbox.task.title, toInbox.task.completed], [null, 'Lists: back', false]);
  const toList = await patchTask(one, inboxTask.id, { listId: errands.id, dueDate: '2026-12-01' });
  assert.deepEqual([toList.task.listId, toList.task.dueDate], [errands.id, '2026-12-01']);

  // An empty update is still rejected.
  await assertError(await send(one, 'PATCH', `/api/tasks/${errand.id}`, {}), 400, 'invalid_update');
  await assertError(await send(one, 'PATCH', `/api/tasks/${errand.id}`, { list: home.id }), 400, 'invalid_update');
});

test('invalid, unknown, deleted and foreign list ids answer 400 invalid_list and change nothing (AC-5)', async () => {
  const mine = await createList(one, 'Mine');
  const deleted = await createList(one, 'Deleted');
  assert.equal((await send(one, 'DELETE', `/api/lists/${deleted.id}`)).status, 200);
  const theirs = await createList(two, 'Theirs');
  const task = await createTask(one, { title: 'Lists: stays', listId: mine.id });
  const before = await storedTask(task.id);
  const count = await taskRowCount();
  const badIds: unknown[] = [
    0, -1, 1.5, '1', String(mine.id), true, [mine.id], { id: mine.id }, Number.MAX_SAFE_INTEGER + 2,
    // Well formed but unknown, deleted, beyond the id column, or another user's.
    2147483647, 2147483648, Number.MAX_SAFE_INTEGER, deleted.id, theirs.id,
  ];
  for (const listId of badIds) {
    await assertError(await send(one, 'POST', '/api/tasks', { title: 'Lists: never', listId }), 400, 'invalid_list');
    await assertError(await send(one, 'PATCH', `/api/tasks/${task.id}`, { listId }), 400, 'invalid_list');
    // Valid fields sent alongside are not applied either.
    await assertError(
      await send(one, 'PATCH', `/api/tasks/${task.id}`, { title: 'Renamed', completed: true, listId }),
      400,
      'invalid_list',
    );
  }
  assert.equal(await taskRowCount(), count);
  assert.deepEqual(await storedTask(task.id), before);
  // Another user's task is still not found, whatever list is sent.
  await assertError(await send(two, 'PATCH', `/api/tasks/${task.id}`, { listId: theirs.id }), 404, 'task_not_found');
  assert.deepEqual(await storedTask(task.id), before);
});

test('the database refuses a task in another user\'s list (AC-5, AC-7)', async () => {
  const theirs = await createList(two, 'Theirs');
  const task = await createTask(one, { title: 'Lists: direct write' });
  const [me] = await fixture.client`select id from users where email = 'one@example.test'`;
  const isListReference = (error: { code?: string; constraint_name?: string }) =>
    error.code === '23503' && error.constraint_name === 'tasks_list_fk';
  await assert.rejects(fixture.client`update tasks set list_id = ${theirs.id} where id = ${task.id}`, isListReference);
  await assert.rejects(
    fixture.client`insert into tasks (user_id, title, list_id) values (${me.id}, 'Direct', ${theirs.id})`,
    isListReference,
  );
  // A list that tasks point at cannot be deleted behind the API's back.
  const mine = await createList(one, 'Mine');
  await patchTask(one, task.id, { listId: mine.id });
  await assert.rejects(fixture.client`delete from lists where id = ${mine.id}`, isListReference);
  assert.equal((await storedTask(task.id))!.list_id, mine.id);
});

test('a list deleted while tasks are added to it or moved into it never answers 500 (AC-5)', async () => {
  const weekly = { every: 1, unit: 'week' };
  for (let round = 0; round < 12; round++) {
    const list = await createList(one, `Race ${round}`);
    const other = await createList(one, `Other ${round}`);
    const inList = await createTask(one, { title: `Race: in ${round}`, listId: list.id, dueDate: '2026-11-20', repeat: weekly });
    const outside = await createTask(one, { title: `Race: outside ${round}`, listId: other.id });
    const leaving = await createTask(one, { title: `Race: leaving ${round}`, listId: list.id });
    const requests = [
      send(one, 'POST', '/api/tasks', { title: `Race: added ${round}`, listId: list.id }),
      send(one, 'PATCH', `/api/tasks/${outside.id}`, { listId: list.id }),
      send(one, 'PATCH', `/api/tasks/${inList.id}`, { completed: true }),
      send(one, 'PATCH', `/api/tasks/${leaving.id}`, { listId: other.id }),
    ];
    // Vary which request reaches the server first.
    const deleteAt = round % (requests.length + 1);
    requests.splice(deleteAt, 0, send(one, 'DELETE', `/api/lists/${list.id}`));
    const responses = await Promise.all(requests);
    const [deleted] = responses.splice(deleteAt, 1);
    const [added, movedIn, completed, movedOut] = responses;
    assert.equal(deleted.status, 200);

    assert.ok([201, 400].includes(added.status), `add: ${added.status}`);
    if (added.status === 400) {
      assert.equal((await added.json()).error, 'invalid_list');
      assert.equal((await fixture.client`select count(*)::int as count from tasks where title = ${`Race: added ${round}`}`)[0].count, 0);
    } else {
      assert.equal((await storedTask((await added.json()).task.id))!.list_id, null);
    }
    assert.ok([200, 400].includes(movedIn.status), `move in: ${movedIn.status}`);
    if (movedIn.status === 400) assert.equal((await movedIn.json()).error, 'invalid_list');
    // Either way the task ends up out of the deleted list.
    assert.ok([null, other.id].includes((await storedTask(outside.id))!.list_id));
    assert.equal(completed.status, 200, 'completing a task in the list');
    const { nextTask } = (await completed.json()) as PatchBody;
    assert.equal((await storedTask(inList.id))!.list_id, null);
    if (nextTask) assert.equal((await storedTask(nextTask.id))!.list_id, null);
    assert.equal(movedOut.status, 200, 'moving a task out of the list');
    assert.equal((await storedTask(leaving.id))!.list_id, other.id);
    assert.equal((await fixture.client`select count(*)::int as count from tasks where list_id = ${list.id}`)[0].count, 0);
  }
});

test('the next occurrence of a repeating task stays in its list (AC-6)', async () => {
  const errands = await createList(one, 'Errands');
  const home = await createList(one, 'Home');
  const weekly = { every: 1, unit: 'week' };
  const task = await createTask(one, { title: 'Lists: bins', listId: errands.id, dueDate: '2026-11-20', repeat: weekly });
  const done = await patchTask(one, task.id, { completed: true });
  assert.equal(done.nextTask!.listId, errands.id);
  assert.equal(done.nextTask!.dueDate, '2026-11-27');
  assert.equal((await storedTask(done.nextTask!.id))!.list_id, errands.id);
  assert.deepEqual((await listTasks(one)).find((item) => item.id === done.nextTask!.id), done.nextTask);

  // Un-ticking still removes the open copy.
  const undone = await patchTask(one, task.id, { completed: false });
  assert.equal(undone.removedTaskId, done.nextTask!.id);
  assert.equal(await storedTask(done.nextTask!.id), undefined);

  // A list changed in the completing update is the one the next occurrence gets.
  const changed = await patchTask(one, task.id, { completed: true, listId: home.id });
  assert.deepEqual([changed.task.listId, changed.nextTask!.listId], [home.id, home.id]);
  await patchTask(one, task.id, { completed: false });
  const toInbox = await patchTask(one, task.id, { completed: true, listId: null });
  assert.equal(toInbox.nextTask!.listId, null);

  // A repeating Inbox task gives a next occurrence in Inbox.
  const plain = await createTask(one, { title: 'Lists: inbox repeat', dueDate: '2026-11-20', repeat: weekly });
  assert.equal((await patchTask(one, plain.id, { completed: true })).nextTask!.listId, null);
});

test('migration 0005 adds lists and Inbox for existing tasks; the database enforces the rules (AC-7, AC-4)', async () => {
  // A scratch database on the fixture's server, migrated to 0004 first, then
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
    const upTo = journal.entries.findIndex((entry: { tag: string }) => entry.tag.startsWith('0004_'));
    assert.ok(upTo > 0);
    assert.ok(journal.entries[upTo + 1]?.tag.startsWith('0005_'), 'migration 0005 follows 0004');
    const entries = journal.entries.slice(0, upTo + 1);
    await cp(folder, partial, { recursive: true });
    await writeFile(join(partial, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    await migrate(drizzle(scratch), { migrationsFolder: partial });
    assert.equal((await scratch`select to_regclass('lists') as name`)[0].name, null);

    const [user] = await scratch`insert into users (name, email) values ('Fixture', 'fixture@example.test') returning id`;
    const [other] = await scratch`insert into users (name, email) values ('Other', 'other@example.test') returning id`;
    const [old] = await scratch`insert into tasks (user_id, title, notes) values (${user.id}, 'Before lists', 'Kept') returning id`;

    await migrate(drizzle(scratch), { migrationsFolder: folder });
    const [row] = await scratch`select title, notes, list_id from tasks where id = ${old.id}`;
    assert.deepEqual({ ...row }, { title: 'Before lists', notes: 'Kept', list_id: null });

    const [list] = await scratch`insert into lists (user_id, name) values (${user.id}, ${emoji.repeat(50)}) returning id`;
    // 51 characters, empty names and a case-only duplicate are refused.
    for (const name of ['x'.repeat(51), emoji.repeat(51), '']) {
      await assert.rejects(
        scratch`insert into lists (user_id, name) values (${user.id}, ${name})`,
        (error: { code?: string; constraint_name?: string }) =>
          error.code === '23514' && error.constraint_name === 'lists_name_length_check',
      );
    }
    await scratch`insert into lists (user_id, name) values (${user.id}, 'Errands')`;
    await assert.rejects(
      scratch`insert into lists (user_id, name) values (${user.id}, 'eRRANDS')`,
      (error: { code?: string; constraint_name?: string }) =>
        error.code === '23505' && error.constraint_name === 'lists_user_id_name_idx',
    );
    await scratch`insert into lists (user_id, name) values (${other.id}, 'errands')`;

    // A task can point at its owner's list, never at another user's.
    await scratch`update tasks set list_id = ${list.id} where id = ${old.id}`;
    await assert.rejects(
      scratch`insert into tasks (user_id, title, list_id) values (${other.id}, 'Foreign', ${list.id})`,
      (error: { code?: string; constraint_name?: string }) =>
        error.code === '23503' && error.constraint_name === 'tasks_list_fk',
    );

    // Deleting a user removes their lists and tasks; other users keep theirs.
    await scratch`delete from users where id = ${user.id}`;
    assert.equal((await scratch`select count(*)::int as count from lists where user_id = ${user.id}`)[0].count, 0);
    assert.equal((await scratch`select count(*)::int as count from tasks where user_id = ${user.id}`)[0].count, 0);
    assert.equal((await scratch`select count(*)::int as count from lists where user_id = ${other.id}`)[0].count, 1);
  } finally {
    await scratch.end();
    await rm(partial, { recursive: true, force: true });
    await fixture.client.unsafe(`DROP DATABASE IF EXISTS "${database}"`);
  }
});
