import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { after, before, beforeEach, test } from 'node:test';
import { createFixture } from './fixture.js';
import { call, connect, listen, memberTokens, ok, refused, send } from './mcp-support.js';
import { appOrigin, signIn } from './session.js';

// The seven MCP tools against the real services, as two household members.
// The criteria named below are those of the MCP server task.

const { tokens, config } = memberTokens();
let fixture: Awaited<ReturnType<typeof createFixture>>;
let http: Awaited<ReturnType<typeof listen>>;
let one: string;
let two: string;
let oneId: number;
let twoId: number;
let mcpOne: Client;
let mcpTwo: Client;
const userIdOf = async (email: string) =>
  (await fixture.client`select id from users where email = ${email}`)[0].id as number;
before(async () => {
  fixture = await createFixture(appOrigin, { mcp: { tokens: config, timeZone: 'America/Toronto' } });
  http = await listen(fixture.app);
  one = await signIn(fixture, 0);
  two = await signIn(fixture, 1);
  oneId = await userIdOf('one@example.test');
  twoId = await userIdOf('two@example.test');
  mcpOne = await connect(http.url, tokens.one);
  mcpTwo = await connect(http.url, tokens.two);
});
// Every test starts without lists or tasks, at noon UTC on Friday 2026-11-20
// (07:00 that morning in Toronto).
beforeEach(async () => {
  await fixture.client`delete from tasks`;
  await fixture.client`delete from lists`;
  fixture.setNow(new Date('2026-11-20T12:00:00Z'));
});
after(async () => {
  await mcpOne?.close();
  await mcpTwo?.close();
  await http?.close();
  await fixture?.close();
});

// Web API helpers, with a member's session.
async function web(session: string, method: string, path: string, body?: unknown) {
  const response = await send(fixture, session, method, path, body);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function createList(session: string, name: string, shared = false) {
  const { body } = await web(session, 'POST', '/api/lists', { name });
  if (shared) await web(session, 'PATCH', `/api/lists/${body.list.id}`, { shared: true });
  return body.list.id as number;
}
async function webTask(session: string, body: Record<string, unknown>) {
  const response = await web(session, 'POST', '/api/tasks', body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.task as { id: number; title: string; dueDate: string | null };
}
const row = async (id: number) =>
  (await fixture.client`select * from tasks where id = ${id}`)[0] as Record<string, any> | undefined;
const titles = (tasks: { title: string }[]) => tasks.map((task) => task.title);

test('"Add for tomorrow to buy broccoli" ends up in the web app on the household tomorrow (AC-4)', async () => {
  // 03:30 UTC on Saturday 2026-11-21 is still Friday evening in Toronto, so
  // tomorrow is Saturday 2026-11-21 there, not Sunday.
  fixture.setNow(new Date('2026-11-21T03:30:00Z'));
  const listed = await ok(mcpOne, 'list_tasks');
  assert.equal(listed.today, '2026-11-20');
  const added = await ok(mcpOne, 'add_task', { title: 'Buy broccoli', due_date: '2026-11-21' });
  assert.equal(added.task.title, 'Buy broccoli');
  assert.equal(added.task.list, 'Inbox');
  assert.equal(added.task.completed, false);
  const { body } = await web(one, 'GET', '/api/tasks');
  assert.equal(body.tasks.length, 1);
  assert.equal(body.tasks[0].id, added.task.id);
  assert.equal(body.tasks[0].title, 'Buy broccoli');
  assert.equal(body.tasks[0].dueDate, '2026-11-21');
  assert.equal(body.tasks[0].listId, null);
  assert.equal(body.tasks[0].completed, false);
  assert.equal(body.tasks[0].createdById, oneId);
  const due = await ok(mcpOne, 'list_tasks', { due_from: '2026-11-21', due_to: '2026-11-21' });
  assert.deepEqual(titles(due.tasks), ['Buy broccoli']);
  // Member two does not see member one's Inbox.
  assert.deepEqual((await web(two, 'GET', '/api/tasks')).body.tasks, []);
});

test('every result reports the household today across a UTC midnight, and completions use it (AC-8)', async () => {
  // 03:00 UTC on 2026-03-10 is 23:00 on 2026-03-09 in Toronto (EDT, UTC-4).
  fixture.setNow(new Date('2026-03-10T03:00:00Z'));
  const instructionsClient = await connect(http.url, tokens.one);
  assert.match(instructionsClient.getInstructions() ?? '', /Today is 2026-03-09 \(Monday\) in the household's timezone, America\/Toronto/);
  await instructionsClient.close();
  const daily = await ok(mcpOne, 'add_task', { title: 'Water plants', due_date: '2026-03-01', repeat: { every: 1, unit: 'day' } });
  const twin = await webTask(one, { title: 'Water plants (web)', dueDate: '2026-03-01', repeat: { every: 1, unit: 'day' } });
  const results = [
    await call(mcpOne, 'list_lists'),
    await call(mcpOne, 'list_tasks'),
    await call(mcpOne, 'add_task', { title: 'Another' }),
    await call(mcpOne, 'update_task', { task_id: daily.task.id, notes: 'Front room' }),
    await call(mcpOne, 'complete_task', { task_id: daily.task.id }),
    await call(mcpOne, 'reopen_task', { task_id: daily.task.id }),
    await call(mcpOne, 'delete_task', { task_id: 999_999 }),
    await call(mcpOne, 'list_tasks', { list: 'Nowhere' }),
  ];
  for (const result of results) {
    assert.equal(result.structuredContent.today, '2026-03-09');
    assert.equal(result.structuredContent.timezone, 'America/Toronto');
    assert.ok(
      result.content.some((part) => part.type === 'text' && part.text.includes('Today is 2026-03-09 (Monday) in America/Toronto.')),
    );
  }
  // Completed late, the next occurrence is the household today (03-09), not
  // the UTC date (03-10).
  const completed = await ok(mcpOne, 'complete_task', { task_id: daily.task.id });
  assert.equal(completed.next_task.due_date, '2026-03-09');
  // The web API without a browser date uses the server's UTC date.
  const webCompleted = await web(one, 'PATCH', `/api/tasks/${twin.id}`, { completed: true });
  assert.equal(webCompleted.body.nextTask.dueDate, '2026-03-10');
  // Overdue is relative to the household today: due 03-09 is not overdue yet.
  await ok(mcpOne, 'add_task', { title: 'Due household today', due_date: '2026-03-09' });
  await ok(mcpOne, 'add_task', { title: 'Due yesterday', due_date: '2026-03-08' });
  const overdue = await ok(mcpOne, 'list_tasks', { overdue: true });
  assert.deepEqual(titles(overdue.tasks), ['Due yesterday']);
});

test('list_lists shows Inbox, the member\'s own lists and shared lists with owner names, never others\' private lists (AC-3)', async () => {
  const errands = await createList(one, 'Errands');
  const home = await createList(two, 'Home', true);
  await createList(two, 'Private of two');
  const lists = (await ok(mcpOne, 'list_lists')).lists;
  assert.deepEqual(lists, [
    { id: null, name: 'Inbox', shared: false, owner: 'Household One', mine: true },
    { id: errands, name: 'Errands', shared: false, owner: 'Household One', mine: true },
    { id: home, name: 'Home', shared: true, owner: 'Household Two', mine: false },
  ]);
  assert.doesNotMatch(JSON.stringify(lists), /@example/);
});

test('one member\'s token never reads or changes the other\'s private tasks or lists (AC-3)', async () => {
  const secret = await createList(one, 'Secret');
  const inbox = await webTask(one, { title: 'Private inbox task' });
  const inList = await webTask(one, { title: 'Private list task', listId: secret });
  const notFound = 'That task could not be found.';
  assert.deepEqual((await ok(mcpTwo, 'list_tasks', { include_completed: true })).tasks, []);
  assert.deepEqual((await ok(mcpTwo, 'list_lists')).lists.map((list: { name: string }) => list.name), ['Inbox']);
  for (const id of [inbox.id, inList.id]) {
    assert.equal(await refused(mcpTwo, 'update_task', { task_id: id, title: 'Taken over' }), notFound);
    assert.equal(await refused(mcpTwo, 'complete_task', { task_id: id }), notFound);
    assert.equal(await refused(mcpTwo, 'reopen_task', { task_id: id }), notFound);
    assert.equal(await refused(mcpTwo, 'delete_task', { task_id: id }), notFound);
    // The web API answers member two the same way.
    const webAnswer = await web(two, 'PATCH', `/api/tasks/${id}`, { title: 'Taken over' });
    assert.equal(webAnswer.status, 404);
    assert.equal(webAnswer.body.message, notFound);
  }
  assert.match(await refused(mcpTwo, 'add_task', { title: 'Sneak in', list: 'Secret' }), /No list is named "Secret"/);
  assert.match(await refused(mcpTwo, 'add_task', { title: 'Sneak in', list: secret }), /No list with id/);
  assert.match(await refused(mcpTwo, 'list_tasks', { list: secret }), /No list with id/);
  assert.match(await refused(mcpTwo, 'update_task', { task_id: inbox.id, list: secret }), /No list with id/);
  // Nothing changed.
  assert.equal((await row(inbox.id))!.title, 'Private inbox task');
  assert.equal((await row(inList.id))!.completed, false);
  assert.equal(Number((await fixture.client`select count(*)::int as n from tasks`)[0].n), 2);
});

test('shared lists work for both members, and MCP records created_by and completed_by (AC-3)', async () => {
  const home = await createList(one, 'Home', true);
  const added = await ok(mcpTwo, 'add_task', { title: 'Fix the gate', list: 'home', assignee: 'Household One' });
  assert.equal(added.task.list, 'Home');
  assert.equal(added.task.created_by, 'Household Two');
  assert.equal(added.task.assignee, 'Household One');
  const stored = (await row(added.task.id))!;
  assert.equal(stored.created_by_id, twoId);
  assert.equal(stored.user_id, oneId, 'a task in a shared list belongs to the list owner');
  assert.equal(stored.list_id, home);
  // Member one sees it through MCP and the web, and completes it.
  assert.deepEqual(titles((await ok(mcpOne, 'list_tasks', { list: home })).tasks), ['Fix the gate']);
  assert.deepEqual(titles((await web(one, 'GET', '/api/tasks')).body.tasks), ['Fix the gate']);
  const completed = await ok(mcpOne, 'complete_task', { task_id: added.task.id });
  assert.equal(completed.task.completed_by, 'Household One');
  assert.equal((await row(added.task.id))!.completed_by_id, oneId);
  // Member two reopens it; nobody completed it any more.
  await ok(mcpTwo, 'reopen_task', { task_id: added.task.id });
  assert.equal((await row(added.task.id))!.completed_by_id, null);
  // A web task in the shared list is reachable through member two's MCP.
  const webAdded = await webTask(one, { title: 'Sweep porch', listId: home });
  const updated = await ok(mcpTwo, 'update_task', { task_id: webAdded.id, title: 'Sweep the porch' });
  assert.equal(updated.task.title, 'Sweep the porch');
  assert.equal(updated.task.created_by, 'Household One');
});

test('list_tasks filters by list, due range, overdue, assignee, completion and search, combined with AND (AC-5)', async () => {
  const groceries = await createList(one, 'Groceries');
  const home = await createList(two, 'Home', true);
  const milk = await webTask(one, { title: 'Buy milk', dueDate: '2026-11-18' });
  await webTask(one, { title: 'Call plumber', dueDate: '2026-11-21' });
  await webTask(one, { title: 'Buy bread', dueDate: '2026-11-20', listId: groceries });
  await webTask(one, { title: 'Fix sink', listId: home, assigneeId: oneId });
  const done = await webTask(one, { title: 'Old buy errand', dueDate: '2026-11-19' });
  await web(one, 'PATCH', `/api/tasks/${done.id}`, { completed: true });
  await webTask(two, { title: 'Paint fence', dueDate: '2026-11-25', listId: home, assigneeId: twoId });
  await webTask(one, { title: '100% done_ish', dueDate: '2026-11-22' });
  await webTask(two, { title: 'Buy two\'s private thing', dueDate: '2026-11-20' });

  const cases: [string, Record<string, unknown>, string[]][] = [
    ['no filters: open tasks by due date, none last', {}, ['Buy milk', 'Buy bread', 'Call plumber', '100% done_ish', 'Paint fence', 'Fix sink']],
    ['include_completed', { include_completed: true }, ['Buy milk', 'Old buy errand', 'Buy bread', 'Call plumber', '100% done_ish', 'Paint fence', 'Fix sink']],
    ['Inbox', { list: 'Inbox' }, ['Buy milk', 'Call plumber', '100% done_ish']],
    ['inbox, any case', { list: ' inbox ' }, ['Buy milk', 'Call plumber', '100% done_ish']],
    ['a list by name', { list: 'groceries' }, ['Buy bread']],
    ['a list by id', { list: home }, ['Paint fence', 'Fix sink']],
    ['a list id as text', { list: String(home) }, ['Paint fence', 'Fix sink']],
    ['a due range', { due_from: '2026-11-20', due_to: '2026-11-21' }, ['Buy bread', 'Call plumber']],
    ['due from only', { due_from: '2026-11-22' }, ['100% done_ish', 'Paint fence']],
    ['due to only', { due_to: '2026-11-19', include_completed: true }, ['Buy milk', 'Old buy errand']],
    ['overdue (before today, open only)', { overdue: true, include_completed: true }, ['Buy milk']],
    ['assigned to me', { assigned_to_me: true }, ['Fix sink']],
    ['search ignores case', { search: 'BUY' }, ['Buy milk', 'Buy bread']],
    ['search with completed', { search: 'buy', include_completed: true }, ['Buy milk', 'Old buy errand', 'Buy bread']],
    ['search treats % and _ as text', { search: '% done_' }, ['100% done_ish']],
    ['search for a wildcard alone', { search: '_' }, ['100% done_ish']],
    ['list and search', { list: 'Inbox', search: 'buy' }, ['Buy milk']],
    ['list, due range and completed', { list: 'Inbox', due_to: '2026-11-19', include_completed: true }, ['Buy milk', 'Old buy errand']],
    ['assigned to me in another list', { assigned_to_me: true, list: 'Groceries' }, []],
    ['overdue false is no filter', { overdue: false, list: 'Inbox' }, ['Buy milk', 'Call plumber', '100% done_ish']],
  ];
  for (const [name, args, expected] of cases) {
    const result = await ok(mcpOne, 'list_tasks', args);
    assert.deepEqual(titles(result.tasks), expected, name);
    assert.equal(result.truncated, false, name);
  }
  {
    // tasks name their list, people by display name only
    const result = await ok(mcpOne, 'list_tasks', { list: home });
    assert.deepEqual(
      result.tasks.map((task: Record<string, unknown>) => [task.list, task.assignee, task.created_by]),
      [
        ['Home', 'Household Two', 'Household Two'],
        ['Home', 'Household One', 'Household One'],
      ],
    );
    assert.doesNotMatch(JSON.stringify(result), /@example/);
    const inbox = await ok(mcpOne, 'list_tasks', { list: 'Inbox', search: 'milk' });
    assert.equal(inbox.tasks[0].id, milk.id);
    assert.equal(inbox.tasks[0].list, 'Inbox');
    assert.equal(inbox.tasks[0].list_id, null);
  }
  {
    // an unknown list is a tool error, not an empty result
    assert.match(await refused(mcpOne, 'list_tasks', { list: 'Garden' }), /No list is named "Garden"\. The lists are Inbox, "Groceries", "Home"/);
    assert.match(await refused(mcpOne, 'list_tasks', { list: 999_999 }), /No list with id 999999/);
  }
  {
    // bad dates are tool errors
    assert.match(await refused(mcpOne, 'list_tasks', { due_from: 'tomorrow' }), /due_from must be a real calendar date/);
    assert.match(await refused(mcpOne, 'list_tasks', { due_to: '2026-02-30' }), /due_to must be a real calendar date/);
    assert.match(await refused(mcpOne, 'list_tasks', { due_from: '2026-11-22', due_to: '2026-11-21' }), /due_from is after due_to/);
  }
  {
    // a limit cuts the result and says so
    const result = await call(mcpOne, 'list_tasks', { limit: 2 });
    assert.deepEqual(titles(result.structuredContent.tasks), ['Buy milk', 'Buy bread']);
    assert.equal(result.structuredContent.truncated, true);
    assert.match((result.content[0] as { text: string }).text, /only the first 2; more match/);
    const exact = await ok(mcpOne, 'list_tasks', { limit: 6 });
    assert.equal(exact.tasks.length, 6);
    assert.equal(exact.truncated, false);
    assert.equal((await call(mcpOne, 'list_tasks', { limit: 0 })).isError, true);
    assert.equal((await call(mcpOne, 'list_tasks', { limit: 201 })).isError, true);
  }
});

test('list_tasks returns at most 100 tasks by default and 200 with a limit, ordered by due date then creation (AC-5)', async () => {
  await fixture.client`
    insert into tasks (user_id, created_by_id, title, due_date, created_at)
    select ${oneId}, ${oneId}, 'Bulk ' || lpad(n::text, 3, '0'),
      case when n % 2 = 0 then null else date '2026-12-01' end,
      now() - (n || ' minutes')::interval
    from generate_series(1, 250) as n`;
  const first = await ok(mcpOne, 'list_tasks');
  assert.equal(first.tasks.length, 100);
  assert.equal(first.truncated, true);
  // Due ones first; among the same due date, the oldest (the highest n) first.
  assert.equal(first.tasks[0].title, 'Bulk 249');
  assert.equal(first.tasks[1].title, 'Bulk 247');
  const most = await ok(mcpOne, 'list_tasks', { limit: 200 });
  assert.equal(most.tasks.length, 200);
  assert.equal(most.truncated, true);
  assert.equal(most.tasks[124].title, 'Bulk 001');
  assert.equal(most.tasks[125].title, 'Bulk 250');
  assert.equal(most.tasks[125].due_date, null);
});

test('update_task, complete_task, reopen_task and delete_task match the web API (AC-6)', async (t) => {
  await t.test('completing a repeating task adds the next occurrence, reopening removes it', async () => {
    const mcp = await ok(mcpOne, 'add_task', { title: 'Bins out', due_date: '2026-11-20', repeat: { every: 1, unit: 'week' } });
    const webTwin = await webTask(one, { title: 'Bins out (web)', dueDate: '2026-11-20', repeat: { every: 1, unit: 'week' } });
    const completed = await ok(mcpOne, 'complete_task', { task_id: mcp.task.id });
    const webCompleted = await web(one, 'PATCH', `/api/tasks/${webTwin.id}`, { completed: true, today: '2026-11-20' });
    assert.equal(completed.task.completed, true);
    assert.equal(completed.changed, true);
    assert.equal(completed.next_task.due_date, webCompleted.body.nextTask.dueDate);
    assert.equal(completed.next_task.due_date, '2026-11-27');
    assert.deepEqual(completed.next_task.repeat, { every: 1, unit: 'week' });
    // Completing again changes nothing and adds no second occurrence.
    const again = await ok(mcpOne, 'complete_task', { task_id: mcp.task.id });
    assert.equal(again.changed, false);
    assert.equal(again.next_task, null);
    const reopened = await ok(mcpOne, 'reopen_task', { task_id: mcp.task.id });
    const webReopened = await web(one, 'PATCH', `/api/tasks/${webTwin.id}`, { completed: false });
    assert.equal(reopened.removed_task_id, completed.next_task.id);
    assert.equal(webReopened.body.removedTaskId, webCompleted.body.nextTask.id);
    assert.equal(await row(completed.next_task.id), undefined);
    assert.equal(reopened.task.completed, false);
    const reopenedAgain = await ok(mcpOne, 'reopen_task', { task_id: mcp.task.id });
    assert.equal(reopenedAgain.changed, false);
    assert.equal(reopenedAgain.removed_task_id, null);
  });
  await t.test('an assignee only in shared lists, cleared when the task leaves one', async () => {
    const home = await createList(two, 'Home', true);
    const webRefusal = await web(one, 'POST', '/api/tasks', { title: 'x', assigneeId: twoId });
    assert.equal(webRefusal.status, 400);
    assert.equal(await refused(mcpOne, 'add_task', { title: 'Inbox with assignee', assignee: 'Household Two' }), webRefusal.body.message);
    const inbox = await ok(mcpOne, 'add_task', { title: 'Move me' });
    assert.equal(await refused(mcpOne, 'update_task', { task_id: inbox.task.id, assignee: 'me' }), webRefusal.body.message);
    const moved = await ok(mcpOne, 'update_task', { task_id: inbox.task.id, list: 'Home', assignee: 'Household Two' });
    assert.equal(moved.task.assignee, 'Household Two');
    assert.equal(moved.task.list_id, home);
    const back = await ok(mcpOne, 'update_task', { task_id: inbox.task.id, list: null });
    assert.equal(back.task.assignee, null);
    assert.equal(back.task.list, 'Inbox');
    assert.equal((await row(inbox.task.id))!.assignee_id, null);
  });
  await t.test('moving between lists changes the owner as the web API does', async () => {
    const home = await createList(two, 'Home again', true);
    const mine = await createList(one, 'Mine');
    const task = await ok(mcpOne, 'add_task', { title: 'Wander' });
    assert.equal((await row(task.task.id))!.user_id, oneId);
    await ok(mcpOne, 'update_task', { task_id: task.task.id, list: 'Home again' });
    assert.equal((await row(task.task.id))!.user_id, twoId, 'into a shared list: the list owner');
    // Member two moves it to their Inbox; it becomes theirs and leaves member one's view.
    await ok(mcpTwo, 'update_task', { task_id: task.task.id, list: 'Inbox' });
    assert.equal((await row(task.task.id))!.user_id, twoId);
    assert.equal(await refused(mcpOne, 'update_task', { task_id: task.task.id, title: 'Mine?' }), 'That task could not be found.');
    // A web twin follows the same path.
    const twin = await webTask(one, { title: 'Wander (web)' });
    await web(one, 'PATCH', `/api/tasks/${twin.id}`, { listId: home });
    await web(two, 'PATCH', `/api/tasks/${twin.id}`, { listId: null });
    assert.equal((await row(twin.id))!.user_id, twoId);
    // Into one's own list and back to Inbox.
    const own = await ok(mcpOne, 'add_task', { title: 'Settle', list: 'Mine' });
    assert.equal(own.task.list_id, mine);
    assert.equal((await ok(mcpOne, 'update_task', { task_id: own.task.id, list: 'Inbox' })).task.list_id, null);
  });
  await t.test('due date null clears it, and is refused while a repeat is set', async () => {
    const plain = await ok(mcpOne, 'add_task', { title: 'Dated', due_date: '2026-11-22', notes: 'Some notes' });
    const cleared = await ok(mcpOne, 'update_task', { task_id: plain.task.id, due_date: null, notes: null });
    assert.equal(cleared.task.due_date, null);
    assert.equal(cleared.task.notes, null);
    const repeating = await ok(mcpOne, 'add_task', { title: 'Repeating', due_date: '2026-11-22', repeat: { every: 2, unit: 'day' } });
    const webTwin = await webTask(one, { title: 'Repeating (web)', dueDate: '2026-11-22', repeat: { every: 2, unit: 'day' } });
    const webRefusal = await web(one, 'PATCH', `/api/tasks/${webTwin.id}`, { dueDate: null });
    assert.equal(webRefusal.status, 400);
    assert.equal(await refused(mcpOne, 'update_task', { task_id: repeating.task.id, due_date: null }), webRefusal.body.message);
    assert.equal((await row(repeating.task.id))!.due_date, '2026-11-22');
    // Both at once is allowed, as in the web API.
    const both = await ok(mcpOne, 'update_task', { task_id: repeating.task.id, due_date: null, repeat: null });
    assert.equal(both.task.due_date, null);
    assert.equal(both.task.repeat, null);
    // A repeat without a due date is refused at creation too.
    const webCreate = await web(one, 'POST', '/api/tasks', { title: 'x', repeat: { every: 1, unit: 'day' } });
    assert.equal(await refused(mcpOne, 'add_task', { title: 'x', repeat: { every: 1, unit: 'day' } }), webCreate.body.message);
  });
  await t.test('invalid values are refused with the web API\'s messages', async () => {
    const task = await ok(mcpOne, 'add_task', { title: 'Valid' });
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ title: '   ' }, { title: '   ' }],
      [{ title: 'x'.repeat(201) }, { title: 'x'.repeat(201) }],
      [{ due_date: '2026-02-30' }, { dueDate: '2026-02-30' }],
      [{ due_date: '2024-12-31' }, { dueDate: '2024-12-31' }],
      [{ notes: 'x'.repeat(5001) }, { notes: 'x'.repeat(5001) }],
      [{ repeat: { every: 0, unit: 'day' } }, { repeat: { every: 0, unit: 'day' } }],
      [{ repeat: { every: 100, unit: 'week' } }, { repeat: { every: 100, unit: 'week' } }],
    ];
    for (const [mcpArgs, webBody] of cases) {
      const webAnswer = await web(one, 'PATCH', `/api/tasks/${task.task.id}`, webBody);
      assert.equal(webAnswer.status, 400);
      assert.equal(await refused(mcpOne, 'update_task', { task_id: task.task.id, ...mcpArgs }), webAnswer.body.message);
      if (!('title' in mcpArgs)) {
        const webCreate = await web(one, 'POST', '/api/tasks', { title: 'x', ...webBody });
        assert.equal(await refused(mcpOne, 'add_task', { title: 'x', ...mcpArgs }), webCreate.body.message);
      }
    }
    const webCreate = await web(one, 'POST', '/api/tasks', { title: '​' });
    assert.equal(await refused(mcpOne, 'add_task', { title: '​' }), webCreate.body.message);
    assert.match(await refused(mcpOne, 'update_task', { task_id: task.task.id }), /Give at least one of/);
    assert.equal((await row(task.task.id))!.title, 'Valid');
  });
  await t.test('delete is permanent and then not found', async () => {
    const task = await ok(mcpOne, 'add_task', { title: 'Delete me' });
    const deleted = await call(mcpOne, 'delete_task', { task_id: task.task.id });
    assert.notEqual(deleted.isError, true);
    assert.equal(deleted.structuredContent.deleted_task_id, task.task.id);
    assert.match((deleted.content[0] as { text: string }).text, /Deleted task #\d+ "Delete me" permanently/);
    assert.equal(await row(task.task.id), undefined);
    for (const tool of ['delete_task', 'complete_task', 'reopen_task']) {
      assert.equal(await refused(mcpOne, tool, { task_id: task.task.id }), 'That task could not be found.');
    }
    assert.equal(await refused(mcpOne, 'update_task', { task_id: task.task.id, title: 'Back' }), 'That task could not be found.');
    assert.equal((await web(one, 'DELETE', `/api/tasks/${task.task.id}`)).status, 404);
    // Ids beyond the column range are simply not found.
    assert.equal(await refused(mcpOne, 'delete_task', { task_id: 2_147_483_648 }), 'That task could not be found.');
    assert.equal(await refused(mcpOne, 'update_task', { task_id: 2_147_483_648, title: 'x' }), 'That task could not be found.');
  });
});

test('lists are found by folded name, Inbox means no list, and an ambiguous name changes nothing (AC-7)', async () => {
  const groceries = await createList(one, 'Groceries');
  const sharedGroceries = await createList(two, 'GROCERIES', true);
  const fancy = await createList(one, 'Ｈｏｍｅ　 Projects');
  {
    // fold matches
    assert.equal((await ok(mcpOne, 'add_task', { title: 'Spaces', list: 'home projects' })).task.list_id, fancy);
    assert.equal((await ok(mcpTwo, 'add_task', { title: 'Own', list: 'groceries' })).task.list_id, sharedGroceries);
  }
  {
    // Inbox
    assert.equal((await ok(mcpOne, 'add_task', { title: 'In', list: 'INBOX' })).task.list_id, null);
    assert.equal((await ok(mcpOne, 'add_task', { title: 'In', list: null })).task.list_id, null);
  }
  {
    // ambiguous names name the candidates and change nothing
    const before = Number((await fixture.client`select count(*)::int as n from tasks`)[0].n);
    const message = await refused(mcpOne, 'add_task', { title: 'Which one', list: 'groceries' });
    assert.match(message, /More than one list is named "groceries"/);
    assert.ok(message.includes(`"Groceries" (id ${groceries}, yours)`), message);
    assert.ok(message.includes(`"GROCERIES" (id ${sharedGroceries}, Household Two's, shared)`), message);
    const task = await ok(mcpOne, 'add_task', { title: 'Stay put', list: 'Home Projects' });
    assert.match(await refused(mcpOne, 'update_task', { task_id: task.task.id, list: 'Groceries', title: 'Renamed' }), /More than one list/);
    assert.match(await refused(mcpOne, 'list_tasks', { list: 'Groceries' }), /More than one list/);
    assert.equal(Number((await fixture.client`select count(*)::int as n from tasks`)[0].n), before + 1);
    const stored = (await row(task.task.id))!;
    assert.equal(stored.title, 'Stay put');
    assert.equal(stored.list_id, fancy);
    // The id settles it.
    assert.equal((await ok(mcpOne, 'add_task', { title: 'This one', list: sharedGroceries })).task.list_id, sharedGroceries);
  }
});

test('an assignee is a member\'s display name, id or "me"; unknown and ambiguous names are errors (AC-7)', async () => {
  const home = await createList(one, 'Shared home', true);
  const byName = await ok(mcpOne, 'add_task', { title: 'By name', list: home, assignee: '  household   TWO ' });
  assert.equal(byName.task.assignee_id, twoId);
  const byId = await ok(mcpOne, 'add_task', { title: 'By id', list: home, assignee: twoId });
  assert.equal(byId.task.assignee_id, twoId);
  const byIdText = await ok(mcpOne, 'add_task', { title: 'By id text', list: home, assignee: String(twoId) });
  assert.equal(byIdText.task.assignee_id, twoId);
  const me = await ok(mcpTwo, 'add_task', { title: 'Me', list: home, assignee: 'Me' });
  assert.equal(me.task.assignee_id, twoId);
  const nobody = await ok(mcpOne, 'update_task', { task_id: me.task.id, assignee: null });
  assert.equal(nobody.task.assignee_id, null);
  assert.match(await refused(mcpOne, 'add_task', { title: 'x', list: home, assignee: 'Household Three' }), /No household member is named "Household Three"\. The members are Household One \(id \d+\), Household Two \(id \d+\)/);
  assert.match(await refused(mcpOne, 'add_task', { title: 'x', list: home, assignee: 999_999 }), /No household member has id 999999/);
  // A second member with the same display name (a disposable fixture row).
  const [twin] = await fixture.client`
    insert into users (name, email) values ('Household two', 'twin@example.test') returning id`;
  try {
    const message = await refused(mcpOne, 'update_task', { task_id: byName.task.id, assignee: 'Household Two', title: 'Changed' });
    assert.match(message, /More than one household member is named "Household Two"/);
    assert.ok(message.includes(`(id ${twoId})`) && message.includes(`(id ${twin.id})`), message);
    assert.doesNotMatch(message, /@example/);
    assert.equal((await row(byName.task.id))!.title, 'By name');
    assert.equal((await ok(mcpOne, 'update_task', { task_id: byName.task.id, assignee: twin.id })).task.assignee, 'Household two');
  } finally {
    await fixture.client`update tasks set assignee_id = null where assignee_id = ${twin.id}`;
    await fixture.client`delete from users where id = ${twin.id}`;
  }
});

// A reference made only of digits can be a list's id or a list's name. Both
// readings count; two different lists are an error that names each (R1-F1).
test('a digit string that is one list\'s name and another list\'s id is ambiguous in every tool (AC-7)', async () => {
  const other = await createList(one, 'Other');
  const named = await createList(one, String(other));
  const home = await createList(one, 'Shared home', true);
  const task = await ok(mcpOne, 'add_task', { title: 'Stay put', list: home });
  const count = async () => Number((await fixture.client`select count(*)::int as n from tasks`)[0].n);
  const before = await count();
  const reference = String(other);
  const checks = [
    await refused(mcpOne, 'add_task', { title: 'x', list: reference }),
    await refused(mcpOne, 'update_task', { task_id: task.task.id, list: reference, title: 'Moved' }),
    await refused(mcpOne, 'list_tasks', { list: reference }),
  ];
  for (const message of checks) {
    assert.match(message, new RegExp(`More than one list fits "${other}"`));
    assert.ok(message.includes(`"Other" (id ${other}, yours)`), message);
    assert.ok(message.includes(`"${other}" (id ${named}, yours)`), message);
  }
  assert.equal(await count(), before);
  const stored = (await row(task.task.id))!;
  assert.equal(stored.title, 'Stay put');
  assert.equal(stored.list_id, home);
  // A number is always the id, and the other list's id settles the name.
  assert.equal((await ok(mcpOne, 'add_task', { title: 'By id', list: other })).task.list_id, other);
  assert.equal((await ok(mcpOne, 'add_task', { title: 'By other id', list: named })).task.list_id, named);
});

test('a digit string that is only a list id, only a list name, or both of one list resolves (AC-7)', async () => {
  const plain = await createList(one, 'Plain');
  assert.equal((await ok(mcpOne, 'add_task', { title: 'Id only', list: String(plain) })).task.list_id, plain);
  const nameOnly = await createList(one, '2000000000');
  assert.equal((await ok(mcpOne, 'add_task', { title: 'Name only', list: '2000000000' })).task.list_id, nameOnly);
  // A list whose own name is its own id is a single distinct match.
  const [{ nextval }] = await fixture.client`select nextval(pg_get_serial_sequence('lists', 'id')) as nextval`;
  const [self] = await fixture.client`
    insert into lists (id, name, user_id) values (${Number(nextval) + 1}, ${String(Number(nextval) + 1)}, ${oneId})
    returning id`;
  assert.equal((await ok(mcpOne, 'add_task', { title: 'Self', list: String(self.id) })).task.list_id, self.id);
  assert.match(await refused(mcpOne, 'add_task', { title: 'x', list: '999999' }), /No list with id 999999/);
});

test('a digit string that is one member\'s name and another member\'s id is ambiguous for every assignee (AC-7)', async () => {
  const home = await createList(one, 'Shared home', true);
  const task = await ok(mcpOne, 'add_task', { title: 'Stay put', list: home });
  const [twin] = await fixture.client`
    insert into users (name, email) values (${String(twoId)}, 'digits@example.test') returning id`;
  try {
    const count = async () => Number((await fixture.client`select count(*)::int as n from tasks`)[0].n);
    const before = await count();
    for (const message of [
      await refused(mcpOne, 'add_task', { title: 'x', list: home, assignee: String(twoId) }),
      await refused(mcpOne, 'update_task', { task_id: task.task.id, assignee: String(twoId), title: 'Changed' }),
    ]) {
      assert.match(message, new RegExp(`More than one household member fits "${twoId}"`));
      assert.ok(message.includes(`Household Two (id ${twoId})`), message);
      assert.ok(message.includes(`${twoId} (id ${twin.id})`), message);
    }
    assert.equal(await count(), before);
    assert.equal((await row(task.task.id))!.title, 'Stay put');
    assert.equal((await row(task.task.id))!.assignee_id, null);
    // The number settles it, and the other id reaches the other member.
    assert.equal((await ok(mcpOne, 'update_task', { task_id: task.task.id, assignee: twoId })).task.assignee_id, twoId);
  } finally {
    await fixture.client`update tasks set assignee_id = null where assignee_id = ${twin.id}`;
    await fixture.client`delete from users where id = ${twin.id}`;
  }
});

test('a digit string that is only a member id or only a member name resolves, as does a member named by their own id (AC-7)', async () => {
  const home = await createList(one, 'Shared home', true);
  assert.equal((await ok(mcpOne, 'add_task', { title: 'Id', list: home, assignee: String(twoId) })).task.assignee_id, twoId);
  const [named] = await fixture.client`
    insert into users (name, email) values ('2000000001', 'named@example.test') returning id`;
  const [selfNamed] = await fixture.client`
    insert into users (name, email) values (${'x'}, 'selfnamed@example.test') returning id`;
  await fixture.client`update users set name = ${String(selfNamed.id)} where id = ${selfNamed.id}`;
  try {
    assert.equal((await ok(mcpOne, 'add_task', { title: 'Name', list: home, assignee: '2000000001' })).task.assignee_id, named.id);
    assert.equal((await ok(mcpOne, 'add_task', { title: 'Self', list: home, assignee: String(selfNamed.id) })).task.assignee_id, selfNamed.id);
  } finally {
    await fixture.client`update tasks set assignee_id = null where assignee_id in (${named.id}, ${selfNamed.id})`;
    await fixture.client`delete from users where id in (${named.id}, ${selfNamed.id})`;
  }
});
