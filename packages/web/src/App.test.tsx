import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { App } from './App';
import { dueLabel } from './dueDate';

type Reply = Response | Promise<Response> | (() => Response | Promise<Response>);
type Call = { method: string; path: string; body: unknown };

const signedInUser = { id: '1', name: 'Household One', email: 'one@example.test' };
const fixtureMembers = [
  { id: 1, name: 'Household One' },
  { id: 2, name: 'Household Two' },
];
const milk = { id: 1, title: 'Buy oat milk', listId: null, notes: null, completed: false, dueDate: null, repeat: null };
const plants = { id: 2, title: 'Water the plants', listId: null, notes: null, completed: true, dueDate: null, repeat: null };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Stub fetch with queued replies per "METHOD path"; an unexpected request fails
// the test. GET /api/lists answers no lists, and GET /api/members the two
// fixture members, unless a test queued a reply.
let replies: Map<string, Reply[]>;
let calls: Call[];
function reply(route: string, ...queued: Reply[]) {
  replies.set(route, [...(replies.get(route) ?? []), ...queued]);
}
function callsTo(route: string) {
  return calls.filter((call) => `${call.method} ${call.path}` === route);
}
function signedIn(tasks: unknown[] | Reply = []) {
  reply('GET /api/me', json({ user: signedInUser }));
  reply('GET /api/tasks', Array.isArray(tasks) ? json({ tasks }) : tasks);
}
// The smallest element that holds every task list (found by role, including
// the collapsed Completed list). Rows in a collapsed list are hidden, so
// queries inside it only find the rows a user can see.
function taskList() {
  const lists = screen.getAllByRole('list', { hidden: true });
  let container: HTMLElement = lists[0];
  while (!lists.every((list) => container.contains(list))) container = container.parentElement!;
  return container;
}
// Sign out lives in the account menu: open it, then choose Sign out.
async function signOut() {
  await userEvent.click(screen.getByRole('button', { name: 'Household One, account' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
}
// The Completed section starts collapsed behind "Show N done"; this opens it.
async function expandCompleted() {
  const toggle = await screen.findByRole('button', { name: /^Show \d+ done$/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  await userEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.textContent).toBe('Hide done');
}
// The add sheet opens from the round + button ("Add a task"); focus starts in
// its title field, "New task", which this returns.
async function openAddSheet() {
  await userEvent.click(await screen.findByRole('button', { name: 'Add a task' }));
  return newTaskField();
}
const addSheet = () => screen.getByRole('dialog', { name: 'New task' });
const newTaskField = () => within(addSheet()).getByRole('textbox', { name: 'New task' }) as HTMLInputElement;
// A chip of the add sheet, by the start of its name ("Due date", "Repeat",
// "List", "Notes"); its full name states its value.
const chip = (name: string) =>
  within(addSheet()).getByRole('button', { name: new RegExp(`^${name}: `) }) as HTMLButtonElement;
// Shows a chip's options, unless they show already.
async function openChip(name: string) {
  if (chip(name).getAttribute('aria-expanded') !== 'true') await userEvent.click(chip(name));
  expect(chip(name).getAttribute('aria-expanded')).toBe('true');
}
// The view title, which is the button that opens the view picker.
const viewTitle = () => document.getElementById('view-title') as HTMLButtonElement;
// Opens the view picker unless it is open, and returns its menu.
async function openPicker() {
  if (viewTitle().getAttribute('aria-expanded') !== 'true') await userEvent.click(viewTitle());
  return screen.getByRole('menu', { name: 'Views and lists' });
}
// Chooses a view (or "New list", "Manage lists") from the view picker.
async function pick(name: string) {
  const menu = await openPicker();
  const item =
    within(menu).queryByRole('menuitemradio', { name }) ?? within(menu).getByRole('menuitem', { name });
  await userEvent.click(item);
}
// The picker's items stay on the page while it is closed (hidden), so these
// read them without opening it: a view's item, the views and lists in order,
// and the view the picker marks as shown.
const viewMenu = () => document.getElementById('view-menu')!;
const tab = (name: string) => within(viewMenu()).getByRole('menuitemradio', { name, hidden: true });
const tabNames = () =>
  within(viewMenu())
    .getAllByRole('menuitemradio', { hidden: true })
    .map((item) => item.textContent);
const selectedTab = () =>
  within(viewMenu())
    .getAllByRole('menuitemradio', { hidden: true })
    .filter((item) => item.getAttribute('aria-checked') === 'true')
    .map((item) => item.textContent);
// The picker's "Manage lists" item, if it offers one.
const manageItem = () => within(viewMenu()).queryByRole('menuitem', { name: 'Manage lists', hidden: true });
// The page has loaded its tasks and lists.
async function ready() {
  await screen.findByRole('button', { name: 'Add a task' });
  await waitFor(() => expect(viewTitle()).toBeTruthy());
}
async function openManage() {
  await pick('Manage lists');
  expect(screen.getByRole('region', { name: 'Manage lists' })).toBeTruthy();
}
// Where the add sheet adds now: the value its List chip states.
async function addDestination() {
  const open = screen.queryByRole('dialog', { name: 'New task' });
  if (!open) await openAddSheet();
  const value = chip('List').getAttribute('aria-label')!.replace(/^List: /, '');
  if (!open) await userEvent.click(within(addSheet()).getByRole('button', { name: 'Cancel' }));
  return value;
}
// The title of each visible row, in page order across the group lists: the
// text of the label around its checkbox.
// A row in edit mode shows no title, only its field, and reads "editing: ...".
// Rows also hold Edit and Delete controls, so the row text is more than the title.
function taskTitles() {
  return within(taskList())
    .getAllByRole('listitem')
    .map((item) => {
      const field = item.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
      return field ? `editing: ${field.value}` : item.querySelector('label')?.textContent;
    });
}

beforeEach(() => {
  replies = new Map();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        method: init?.method ?? 'GET',
        path: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const next = replies.get(`${call.method} ${call.path}`)?.shift();
      if (!next && `${call.method} ${call.path}` === 'GET /api/lists') return json({ lists: [] });
      if (!next && `${call.method} ${call.path}` === 'GET /api/members') return json({ members: fixtureMembers });
      if (!next) throw new Error(`Unexpected request: ${call.method} ${call.path}`);
      const answer = typeof next === 'function' ? next() : next;
      const signal = init?.signal;
      if (!signal) return answer;
      // Like a real fetch, an aborted request rejects.
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort);
        Promise.resolve(answer).then(resolve, reject);
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

describe('signed-out view', () => {
  test('shows only the sign-in control and requests no tasks', async () => {
    reply('GET /api/me', json({ error: 'unauthorized' }, 401));
    render(<App />);
    expect(screen.getByRole('status').textContent).toBe('Loading your session...');
    expect(await screen.findByRole('button', { name: 'Sign in with Pior Labs' })).toBeTruthy();
    expect(screen.getByText('A little space for what comes next.')).toBeTruthy();
    expect(screen.queryByLabelText('New task')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(callsTo('GET /api/tasks')).toHaveLength(0);
  });

  test('sign-in starts the SSO flow', async () => {
    reply('GET /api/me', json({ error: 'unauthorized' }, 401));
    reply('POST /api/auth/sign-in/social', json({ url: '#fixture-sso' }));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Pior Labs' }));
    await waitFor(() => expect(location.hash).toBe('#fixture-sso'));
    expect(callsTo('POST /api/auth/sign-in/social')[0].body).toEqual({
      provider: 'auth-pior',
      callbackURL: '/',
      errorCallbackURL: '/?error=sign-in',
    });
  });
});

describe('task list states', () => {
  test('shows a loading state until the tasks arrive, then the saved tasks', async () => {
    let finish!: (response: Response) => void;
    signedIn(new Promise<Response>((resolve) => (finish = resolve)));
    render(<App />);
    expect((await screen.findByText('Loading your tasks...')).getAttribute('role')).toBe('status');
    expect(screen.getByRole('button', { name: 'Household One, account' })).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByLabelText('New task')).toBeNull();

    finish(json({ tasks: [plants, milk] }));
    // Open tasks come first; the completed task is in the collapsed Completed section.
    await waitFor(() => expect(taskTitles()).toEqual(['Buy oat milk']));
    expect(screen.queryByRole('status')).toBeNull();
    await expandCompleted();
    expect(taskTitles()).toEqual(['Buy oat milk', 'Water the plants']);
    expect((screen.getByRole('checkbox', { name: 'Water the plants' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Buy oat milk' }) as HTMLInputElement).checked).toBe(false);
    // Completed tasks are visually distinguished.
    expect(screen.getByText('Water the plants').className).toContain('line-through');
    expect(screen.getByText('Buy oat milk').className).not.toContain('line-through');
    expect(screen.getByRole('button', { name: 'Household One, account' })).toBeTruthy();
  });

  test('shows an empty state when there are no tasks', async () => {
    signedIn([]);
    render(<App />);
    expect(await screen.findByText('No tasks yet. Add your first one with the + button.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a task' })).toBeTruthy();
  });

  test('shows a load failure with a retry action that recovers', async () => {
    signedIn(json({ error: 'internal_error' }, 500));
    reply('GET /api/tasks', () => Promise.reject(new TypeError('network down')), json({ tasks: [milk] }));
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toBe('Your tasks could not be loaded.');
    expect(screen.queryByText('No tasks yet. Add your first one with the + button.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a task' })).toBeNull();

    // A second failure (network error this time) keeps the failure state.
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Your tasks could not be loaded.');
    expect(callsTo('GET /api/tasks')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(taskTitles()).toEqual(['Buy oat milk']));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(callsTo('GET /api/tasks')).toHaveLength(3);
  });
});

describe('creating a task', () => {
  test('adds the task the server returned to the top of the list', async () => {
    signedIn([milk]);
    reply('POST /api/tasks', json({ task: { id: 7, title: 'Call the plumber', completed: false, dueDate: null } }, 201));
    render(<App />);
    const input = await openAddSheet();
    await userEvent.type(input, '  Call the plumber  ');
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await waitFor(() => expect(taskTitles()).toEqual(['Call the plumber', 'Buy oat milk']));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Call the plumber' });
    expect((screen.getByRole('checkbox', { name: 'Call the plumber' }) as HTMLInputElement).checked).toBe(false);
    // The sheet closed; it opens again with an empty draft.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((await openAddSheet()).value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('rejects empty and whitespace-only titles inline without a request', async () => {
    signedIn([milk]);
    render(<App />);
    const input = await openAddSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter a task title.');
    expect(input.getAttribute('aria-invalid')).toBe('true');

    // Editing clears the message; whitespace alone is rejected again on submit.
    await userEvent.type(input, '   ');
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('Enter a task title.');

    expect(callsTo('POST /api/tasks')).toHaveLength(0);
    expect(taskTitles()).toEqual(['Buy oat milk']);
  });

  test('rejects a title with nothing visible like an empty one, without a request', async () => {
    signedIn([milk]);
    render(<App />);
    const input = await openAddSheet();
    for (const invisible of ['\u200B', ' \u200B\u200D\u2060\uFEFF ', '\u00AD\u200E', '\u3164']) {
      fireEvent.change(input, { target: { value: invisible } });
      expect(screen.queryByRole('alert')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
      expect(screen.getByRole('alert').textContent).toBe('Enter a task title.');
    }
    expect(callsTo('POST /api/tasks')).toHaveLength(0);
    expect(taskTitles()).toEqual(['Buy oat milk']);
  });

  test('counts the 200 limit in characters, the same way the server does', async () => {
    const emoji = '\u{1F600}'; // one character, two UTF-16 units
    const longest = emoji.repeat(200);
    signedIn([milk]);
    reply('POST /api/tasks', json({ task: { id: 8, title: longest, completed: false, dueDate: null } }, 201));
    render(<App />);
    const input = await openAddSheet();

    for (const tooLong of ['x'.repeat(201), emoji.repeat(201), `  ${'x'.repeat(199)}${emoji}x  `]) {
      fireEvent.change(input, { target: { value: tooLong } });
      await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
      expect(screen.getByRole('alert').textContent).toBe('Task titles can be at most 200 characters.');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.value).toBe(tooLong);
    }
    expect(callsTo('POST /api/tasks')).toHaveLength(0);

    // Exactly 200 characters is sent, even though it is 400 UTF-16 units.
    fireEvent.change(input, { target: { value: ` ${longest} ` } });
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(callsTo('POST /api/tasks')).toHaveLength(1));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: longest });
    await waitFor(() => expect(taskTitles()).toEqual([longest, 'Buy oat milk']));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('keeps focus in the title field and ignores repeat submits while saving; then focus returns to + (D-2)', async () => {
    signedIn([milk]);
    let finish!: (response: Response) => void;
    reply(
      'POST /api/tasks',
      new Promise<Response>((resolve) => (finish = resolve)),
      json({ task: { id: 9, title: 'Second', completed: false, dueDate: null } }, 201),
    );
    render(<App />);
    const input = await openAddSheet();
    await userEvent.type(input, 'First{Enter}');
    const button = screen.getByRole('button', { name: 'Adding...' }) as HTMLButtonElement;

    // Locked without the disabled attribute, which would make a browser drop focus.
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(input);

    // Repeat submits and typing while the request is pending change nothing.
    await userEvent.keyboard('{Enter}');
    await userEvent.click(button);
    await userEvent.type(input, 'ignored', { skipClick: true });
    expect(callsTo('POST /api/tasks')).toHaveLength(1);
    expect(input.value).toBe('First');

    // Escape and Cancel do not close the sheet while the add is pending.
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeTruthy();

    finish(json({ task: { id: 7, title: 'First', completed: false, dueDate: null } }, 201));
    await waitFor(() => expect(taskTitles()).toEqual(['First', 'Buy oat milk']));
    // The submit click moved focus to the button; a successful add closes the
    // sheet and returns focus to the + button.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a task' }));

    await userEvent.keyboard('{Enter}');
    expect(newTaskField().readOnly).toBe(false);
    expect(newTaskField().value).toBe('');
    expect(document.activeElement).toBe(newTaskField());
    await userEvent.keyboard('Second{Enter}');
    await waitFor(() => expect(taskTitles()).toEqual(['Second', 'First', 'Buy oat milk']));
    expect(callsTo('POST /api/tasks')).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a task' }));
  });

  test('shows the server message when the server rejects the title', async () => {
    signedIn([milk]);
    reply('POST /api/tasks', json({ error: 'invalid_title', message: 'Enter a task title.' }, 400));
    render(<App />);
    const input = await openAddSheet();
    await userEvent.type(input, 'Rejected by server{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a task title.');
    expect(taskTitles()).toEqual(['Buy oat milk']);
    // The sheet stays open with the draft.
    expect(within(addSheet()).getByRole('alert')).toBeTruthy();
    expect(input.value).toBe('Rejected by server');
  });

  test('shows a create failure and does not show the unsaved task as saved', async () => {
    signedIn([milk]);
    reply('POST /api/tasks', json({ error: 'internal_error' }, 500), () =>
      Promise.reject(new TypeError('network down')),
    );
    render(<App />);
    const input = await openAddSheet();
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 1) await userEvent.type(input, 'Never saved');
      await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
      expect((await screen.findByRole('alert')).textContent).toBe(
        'The task could not be saved. Please try again.',
      );
      await waitFor(() => expect(callsTo('POST /api/tasks')).toHaveLength(attempt));
      expect(taskTitles()).toEqual(['Buy oat milk']);
      // The sheet stays open and the typed title is kept so the user can retry.
      expect(newTaskField()).toBe(input);
      expect(input.value).toBe('Never saved');
      await waitFor(() => expect(input.readOnly).toBe(false));
    }
  });
});

describe('completing a task', () => {
  test('marks a task complete and clears it again from the server response', async () => {
    // Completing sends the browser's local date, so the clock is fixed.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 20, 12, 0, 0));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    signedIn([milk]);
    let finish!: (response: Response) => void;
    reply(
      'PATCH /api/tasks/1',
      new Promise<Response>((resolve) => (finish = resolve)),
      json({ task: { ...milk, completed: false } }),
    );
    render(<App />);
    const checkbox = (await screen.findByRole('checkbox', { name: 'Buy oat milk' })) as HTMLInputElement;
    await userEvent.click(checkbox);
    // Until the server answers, the stored state is still shown and the control is locked.
    expect(checkbox.checked).toBe(false);
    // Locked with aria-disabled, not disabled, so a keyboard user keeps focus on it.
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(checkbox);
    await userEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(callsTo('PATCH /api/tasks/1')).toHaveLength(1);
    expect(callsTo('PATCH /api/tasks/1')[0].body).toEqual({ completed: true, today: '2026-11-20' });

    // Stored: the task moves to the collapsed Completed section. Focus moves to
    // the Completed toggle (there is no other row) and a status message says where it went.
    finish(json({ task: { ...milk, completed: true } }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Buy oat milk' })).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('"Buy oat milk" was moved to Completed.');
    await waitFor(() => expect(document.activeElement).toBe(button('Show 1 done')));
    await expandCompleted();
    const completed = screen.getByRole('checkbox', { name: 'Buy oat milk' }) as HTMLInputElement;
    expect(completed.checked).toBe(true);
    expect(completed.getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByText('Buy oat milk').className).toContain('line-through');

    // Clearing it moves it back to the open tasks; focus follows the checkbox.
    await userEvent.click(completed);
    await waitFor(() =>
      expect((screen.getByRole('checkbox', { name: 'Buy oat milk' }) as HTMLInputElement).checked).toBe(false),
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Buy oat milk' })));
    expect(screen.queryByRole('button', { name: /done$/ })).toBeNull();
    expect(callsTo('PATCH /api/tasks/1')[1].body).toEqual({ completed: false });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('shows an update failure and keeps the stored completion state', async () => {
    signedIn([plants, milk]);
    reply('PATCH /api/tasks/1', json({ error: 'internal_error' }, 500));
    reply('PATCH /api/tasks/2', json({ error: 'task_not_found', message: 'That task could not be found.' }, 404));
    reply('PATCH /api/tasks/1', json({ task: { ...milk, completed: true } }));
    render(<App />);
    const open = (await screen.findByRole('checkbox', { name: 'Buy oat milk' })) as HTMLInputElement;
    await expandCompleted();
    const done = screen.getByRole('checkbox', { name: 'Water the plants' }) as HTMLInputElement;

    await userEvent.click(open);
    expect((await screen.findByRole('alert')).textContent).toBe(
      '"Buy oat milk" could not be updated. Please try again.',
    );
    expect(open.checked).toBe(false);
    await waitFor(() => expect(open.getAttribute('aria-disabled')).toBeNull());

    await userEvent.click(done);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        '"Water the plants" could not be updated. Please try again.',
      ),
    );
    expect(done.checked).toBe(true);
    expect(taskTitles()).toEqual(['Buy oat milk', 'Water the plants']);

    // A later successful update clears the failure message.
    await waitFor(() => expect(done.getAttribute('aria-disabled')).toBeNull());
    await userEvent.click(open);
    await waitFor(() =>
      expect((screen.getByRole('checkbox', { name: 'Buy oat milk' }) as HTMLInputElement).checked).toBe(true),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

function noContent() {
  return new Response(null, { status: 204 });
}
function pending() {
  let finish!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => (finish = resolve));
  return { response, finish: (value: Response) => finish(value) };
}
function button(name: string) {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}
function editField(title: string) {
  return screen.getByRole('textbox', { name: `New title for "${title}"` }) as HTMLInputElement;
}
async function startEditing(title: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Edit "${title}"` }));
  return editField(title);
}
const tea = { id: 3, title: 'Order tea', listId: null, notes: null, completed: false, dueDate: null, repeat: null };

describe('renaming a task', () => {
  test('saves with the Save control and shows the new title only after the server stored it', async () => {
    signedIn([plants, milk]);
    const save = pending();
    reply('PATCH /api/tasks/1', save.response);
    render(<App />);
    await expandCompleted();
    const field = await startEditing('Buy oat milk');

    // Edit mode: the field is prefilled and focused, with the caret at the end.
    expect(field.value).toBe('Buy oat milk');
    expect(document.activeElement).toBe(field);
    expect(screen.queryByRole('checkbox', { name: 'Buy oat milk' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit "Buy oat milk"' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete "Buy oat milk"' })).toBeNull();
    await userEvent.keyboard('!');
    expect(field.value).toBe('Buy oat milk!');

    await userEvent.clear(field);
    await userEvent.type(field, '  Buy oat milk and bread  ');
    await userEvent.click(button('Save'));

    // Pending: locked without the disabled attribute, the typed text still in the field.
    const saving = button('Saving...');
    expect(saving.disabled).toBe(false);
    expect(saving.getAttribute('aria-disabled')).toBe('true');
    expect(button('Cancel').getAttribute('aria-disabled')).toBe('true');
    expect(field.disabled).toBe(false);
    expect(field.readOnly).toBe(true);
    expect(document.activeElement).toBe(saving);
    expect(taskTitles()).toEqual(['editing:   Buy oat milk and bread  ', 'Water the plants']);
    expect(screen.queryByText('Buy oat milk and bread')).toBeNull();

    // Repeat input while the request is pending changes nothing.
    await userEvent.click(saving);
    await userEvent.click(button('Cancel'));
    await userEvent.type(field, 'ignored{Enter}{Escape}', { skipClick: true });
    expect(callsTo('PATCH /api/tasks/1')).toHaveLength(1);
    expect(callsTo('PATCH /api/tasks/1')[0].body).toEqual({ title: 'Buy oat milk and bread' });
    expect(field.value).toBe('  Buy oat milk and bread  ');
    expect(screen.getByRole('textbox', { name: 'New title for "Buy oat milk"' })).toBe(field);

    save.finish(json({ task: { ...milk, title: 'Buy oat milk and bread' } }));
    await waitFor(() => expect(taskTitles()).toEqual(['Buy oat milk and bread', 'Water the plants']));
    // The controls are named after the new title, and focus is back on Edit
    // (moved by an effect after that render, so this waits for it).
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Buy oat milk and bread"')));
    expect(button('Delete "Buy oat milk and bread"')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Buy oat milk and bread' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('saves with Enter, and a completed task stays completed', async () => {
    signedIn([plants, milk]);
    reply('PATCH /api/tasks/2', json({ task: { ...plants, title: 'Water the ferns' } }));
    render(<App />);
    await expandCompleted();
    const field = await startEditing('Water the plants');
    await userEvent.clear(field);
    await userEvent.type(field, 'Water the ferns{Enter}');

    await waitFor(() => expect(taskTitles()).toEqual(['Buy oat milk', 'Water the ferns']));
    expect(callsTo('PATCH /api/tasks/2')).toEqual([
      { method: 'PATCH', path: '/api/tasks/2', body: { title: 'Water the ferns' } },
    ]);
    expect((screen.getByRole('checkbox', { name: 'Water the ferns' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Water the ferns').className).toContain('line-through');
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Water the ferns"')));
  });

  test('Escape and Cancel restore the original title without a request', async () => {
    signedIn([plants, milk]);
    render(<App />);
    await expandCompleted();
    let field = await startEditing('Buy oat milk');
    await userEvent.clear(field);
    await userEvent.type(field, 'Thrown away{Escape}');
    expect(taskTitles()).toEqual(['Buy oat milk', 'Water the plants']);
    expect(document.activeElement).toBe(button('Edit "Buy oat milk"'));

    field = await startEditing('Buy oat milk');
    // A cancelled edit leaves nothing behind: the field starts from the stored title again.
    expect(field.value).toBe('Buy oat milk');
    await userEvent.type(field, ' also thrown away');
    await userEvent.click(button('Cancel'));
    expect(taskTitles()).toEqual(['Buy oat milk', 'Water the plants']);
    expect(document.activeElement).toBe(button('Edit "Buy oat milk"'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('rejects invalid titles next to the field without a request', async () => {
    const emoji = '\u{1F600}';
    signedIn([milk]);
    render(<App />);
    const field = await startEditing('Buy oat milk');
    const cases: [string, string][] = [
      ['', 'Enter a task title.'],
      ['   ', 'Enter a task title.'],
      [' ​‍⁠﻿ ', 'Enter a task title.'],
      ['ㅤ', 'Enter a task title.'],
      ['x'.repeat(201), 'Task titles can be at most 200 characters.'],
      [emoji.repeat(201), 'Task titles can be at most 200 characters.'],
    ];
    for (const [value, message] of cases) {
      fireEvent.change(field, { target: { value } });
      // Editing the text clears the previous message.
      expect(screen.queryByRole('alert')).toBeNull();
      expect(field.getAttribute('aria-invalid')).toBeNull();
      await userEvent.click(button('Save'));
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toBe(message);
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(field.getAttribute('aria-describedby')).toBe(alert.id);
      // The message sits inside the row being edited, and the text is kept.
      expect(within(taskList()).getByRole('alert')).toBe(alert);
      expect(field.value).toBe(value);
    }
    fireEvent.change(field, { target: { value: '  ' } });
    await userEvent.type(field, '{Enter}', { skipClick: true });
    expect(screen.getByRole('alert').textContent).toBe('Enter a task title.');
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);

    // Exactly 200 characters is sent, counted in code points like the server does.
    const longest = emoji.repeat(200);
    reply('PATCH /api/tasks/1', json({ task: { ...milk, title: longest } }));
    fireEvent.change(field, { target: { value: ` ${longest} ` } });
    await userEvent.click(button('Save'));
    await waitFor(() => expect(taskTitles()).toEqual([longest]));
    expect(callsTo('PATCH /api/tasks/1')[0].body).toEqual({ title: longest });
  });

  test('an unchanged title leaves edit mode without a request', async () => {
    signedIn([milk]);
    render(<App />);
    let field = await startEditing('Buy oat milk');
    await userEvent.click(button('Save'));
    expect(taskTitles()).toEqual(['Buy oat milk']);
    expect(document.activeElement).toBe(button('Edit "Buy oat milk"'));

    // Only surrounding whitespace differs: still unchanged after trimming.
    field = await startEditing('Buy oat milk');
    fireEvent.change(field, { target: { value: '   Buy oat milk  ' } });
    await userEvent.type(field, '{Enter}', { skipClick: true });
    expect(taskTitles()).toEqual(['Buy oat milk']);
    expect(document.activeElement).toBe(button('Edit "Buy oat milk"'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('only one row is in edit mode at a time', async () => {
    signedIn([plants, milk]);
    render(<App />);
    await expandCompleted();
    const first = await startEditing('Buy oat milk');
    await userEvent.type(first, ' unsaved');
    const second = await startEditing('Water the plants');
    expect(document.activeElement).toBe(second);
    expect(second.value).toBe('Water the plants');
    // The first row is back to its stored title; its unsaved text is dropped.
    expect(taskTitles()).toEqual(['Buy oat milk', 'editing: Water the plants']);
    // jsdom also gives the date field the textbox role, so count title fields.
    expect(within(taskList()).getAllByRole('textbox', { name: /^New title for/ })).toHaveLength(1);
    expect(button('Edit "Buy oat milk"')).toBeTruthy();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('a failed save keeps edit mode and the typed text, with an error', async () => {
    signedIn([plants, milk]);
    reply(
      'PATCH /api/tasks/1',
      json({ error: 'internal_error' }, 500),
      () => Promise.reject(new TypeError('network down')),
      json({ error: 'invalid_title', message: 'Task titles cannot contain a null character.' }, 400),
      json({ task: { ...milk, title: 'Buy soy milk' } }),
    );
    render(<App />);
    await expandCompleted();
    const field = await startEditing('Buy oat milk');
    await userEvent.clear(field);
    await userEvent.type(field, 'Buy soy milk');

    for (const [attempt, message] of [
      [1, 'The new title could not be saved. Please try again.'],
      [2, 'The new title could not be saved. Please try again.'],
      [3, 'Task titles cannot contain a null character.'],
    ] as const) {
      await userEvent.click(button('Save'));
      await waitFor(() => expect(callsTo('PATCH /api/tasks/1')).toHaveLength(attempt));
      const alert = await within(taskList()).findByRole('alert');
      expect(alert.textContent).toBe(message);
      // Still editing, text intact, nothing shown as saved, and ready for a retry.
      expect(taskTitles()).toEqual(['editing: Buy soy milk', 'Water the plants']);
      expect(screen.queryByText('Buy soy milk')).toBeNull();
      await waitFor(() => expect(field.readOnly).toBe(false));
      expect(button('Save').getAttribute('aria-disabled')).toBeNull();
    }

    await userEvent.type(field, '{Enter}');
    await waitFor(() => expect(taskTitles()).toEqual(['Buy soy milk', 'Water the plants']));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(callsTo('PATCH /api/tasks/1')).toHaveLength(4);
  });

  test('a 404 removes the row with a notice and moves focus to the next row', async () => {
    signedIn([plants, milk, tea]);
    reply('PATCH /api/tasks/1', json({ error: 'task_not_found', message: 'That task could not be found.' }, 404));
    render(<App />);
    await expandCompleted();
    const field = await startEditing('Buy oat milk');
    await userEvent.type(field, ' today{Enter}');

    await waitFor(() => expect(taskTitles()).toEqual(['Order tea', 'Water the plants']));
    expect(screen.getByRole('status').textContent).toBe(
      '"Buy oat milk" no longer exists, so it was removed from the list.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('textbox', { name: /New title/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Order tea' }));

    // The notice goes away with the next task action.
    reply('PATCH /api/tasks/3', json({ task: { ...tea, completed: true } }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Order tea' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  test('editing waits for a pending completion change on the same task', async () => {
    signedIn([milk]);
    const update = pending();
    reply('PATCH /api/tasks/1', update.response);
    render(<App />);
    const checkbox = (await screen.findByRole('checkbox', { name: 'Buy oat milk' })) as HTMLInputElement;
    await userEvent.click(checkbox);
    const edit = button('Edit "Buy oat milk"');
    expect(edit.disabled).toBe(false);
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(edit);
    expect(screen.queryByRole('textbox', { name: /New title/ })).toBeNull();
    expect(document.activeElement).toBe(edit);

    // Stored: the task moved to the collapsed Completed section; Edit works there.
    update.finish(json({ task: { ...milk, completed: true } }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Buy oat milk' })).toBeNull());
    await expandCompleted();
    expect((screen.getByRole('checkbox', { name: 'Buy oat milk' }) as HTMLInputElement).checked).toBe(true);
    const unlocked = button('Edit "Buy oat milk"');
    expect(unlocked.getAttribute('aria-disabled')).toBeNull();
    await userEvent.click(unlocked);
    expect(editField('Buy oat milk').value).toBe('Buy oat milk');
  });

  test('Escape on Save or Cancel also cancels, but not while the save is pending', async () => {
    signedIn([plants, milk]);
    const save = pending();
    reply('PATCH /api/tasks/1', save.response);
    render(<App />);
    await expandCompleted();
    for (const control of ['Save', 'Cancel']) {
      const field = await startEditing('Buy oat milk');
      await userEvent.type(field, ' thrown away');
      button(control).focus();
      await userEvent.keyboard('{Escape}');
      expect(taskTitles()).toEqual(['Buy oat milk', 'Water the plants']);
      expect(document.activeElement).toBe(button('Edit "Buy oat milk"'));
    }
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);

    // While the save is pending, Escape on any control of the form changes nothing.
    const field = await startEditing('Buy oat milk');
    await userEvent.type(field, ' and bread{Enter}');
    for (const target of [field, button('Saving...'), button('Cancel')]) {
      target.focus();
      await userEvent.keyboard('{Escape}');
      expect(taskTitles()).toEqual(['editing: Buy oat milk and bread', 'Water the plants']);
      expect(document.activeElement).toBe(target);
    }
    save.finish(json({ task: { ...milk, title: 'Buy oat milk and bread' } }));
    await waitFor(() => expect(taskTitles()).toEqual(['Buy oat milk and bread', 'Water the plants']));
    expect(callsTo('PATCH /api/tasks/1')).toHaveLength(1);
  });

  test('while a save is pending, Edit on other rows is visibly locked and ignored', async () => {
    signedIn([plants, milk]);
    const save = pending();
    reply('PATCH /api/tasks/1', save.response);
    render(<App />);
    await expandCompleted();
    const field = await startEditing('Buy oat milk');
    expect(button('Edit "Water the plants"').getAttribute('aria-disabled')).toBeNull();
    await userEvent.type(field, ' and bread{Enter}');

    const other = button('Edit "Water the plants"');
    expect(other.disabled).toBe(false);
    expect(other.getAttribute('aria-disabled')).toBe('true');
    expect(other.className).toContain('aria-disabled:opacity-50');
    await userEvent.click(other);
    expect(document.activeElement).toBe(other);
    expect(screen.queryByRole('textbox', { name: 'New title for "Water the plants"' })).toBeNull();
    expect(taskTitles()).toEqual(['editing: Buy oat milk and bread', 'Water the plants']);

    save.finish(json({ task: { ...milk, title: 'Buy oat milk and bread' } }));
    await waitFor(() => expect(taskTitles()).toEqual(['Buy oat milk and bread', 'Water the plants']));
    expect(other.getAttribute('aria-disabled')).toBeNull();
    await userEvent.click(other);
    expect(editField('Water the plants').value).toBe('Water the plants');
  });
});

describe('deleting a task', () => {
  test('asks for confirmation in the row, and Cancel leaves the task', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    signedIn([plants, milk]);
    render(<App />);
    await expandCompleted();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete "Buy oat milk"' }));

    const row = within(taskList()).getAllByRole('listitem')[0];
    expect(within(row).getByText('Delete this task?')).toBeTruthy();
    expect(within(row).getByRole('group', { name: 'Delete "Buy oat milk"?' })).toBeTruthy();
    expect(button('Confirm deleting "Buy oat milk"').textContent).toBe('Confirm');
    const cancel = button('Cancel deleting "Buy oat milk"');
    expect(cancel.textContent).toBe('Cancel');
    // Focus lands on Cancel, so a repeated Enter or click cannot delete.
    expect(document.activeElement).toBe(cancel);
    expect(screen.queryByRole('button', { name: 'Delete "Buy oat milk"' })).toBeNull();
    // The other row is not asking, and the task is still listed with a working checkbox.
    expect(button('Delete "Water the plants"')).toBeTruthy();
    expect(screen.getAllByText('Delete this task?')).toHaveLength(1);
    expect(taskTitles()).toEqual(['Buy oat milk', 'Water the plants']);

    await userEvent.click(cancel);
    expect(screen.queryByText('Delete this task?')).toBeNull();
    expect(taskTitles()).toEqual(['Buy oat milk', 'Water the plants']);
    expect(document.activeElement).toBe(button('Delete "Buy oat milk"'));
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test('after deleting the bottom row focus moves up; after the last task, to the + button', async () => {
    signedIn([plants, milk]);
    reply('DELETE /api/tasks/1', noContent());
    reply('DELETE /api/tasks/2', noContent());
    render(<App />);
    // The open task comes first and the completed one is the bottom row.
    await expandCompleted();
    expect(taskTitles()).toEqual(['Buy oat milk', 'Water the plants']);
    // A completed task is deleted like any other.
    await userEvent.click(await screen.findByRole('button', { name: 'Delete "Water the plants"' }));
    await userEvent.click(button('Confirm deleting "Water the plants"'));
    await waitFor(() => expect(taskTitles()).toEqual(['Buy oat milk']));
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Buy oat milk' }));

    // Deleting the last one shows the empty state.
    await userEvent.click(button('Delete "Buy oat milk"'));
    await userEvent.click(button('Confirm deleting "Buy oat milk"'));
    expect(await screen.findByText('No tasks yet. Add your first one with the + button.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a task' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a failed delete keeps the row and shows an error; a retry can succeed', async () => {
    signedIn([plants, milk]);
    reply(
      'DELETE /api/tasks/1',
      json({ error: 'internal_error' }, 500),
      () => Promise.reject(new TypeError('network down')),
      noContent(),
    );
    render(<App />);
    await expandCompleted();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete "Buy oat milk"' }));
    const confirm = button('Confirm deleting "Buy oat milk"');
    for (const attempt of [1, 2]) {
      await userEvent.click(confirm);
      await waitFor(() => expect(callsTo('DELETE /api/tasks/1')).toHaveLength(attempt));
      expect((await screen.findByRole('alert')).textContent).toBe(
        '"Buy oat milk" could not be deleted. Please try again.',
      );
      expect(taskTitles()).toEqual(['Buy oat milk', 'Water the plants']);
      // The confirmation stays open and unlocked, with focus still on Confirm.
      await waitFor(() => expect(confirm.getAttribute('aria-disabled')).toBeNull());
      expect(confirm.textContent).toBe('Confirm');
      expect(document.activeElement).toBe(confirm);
    }
    await userEvent.click(confirm);
    await waitFor(() => expect(taskTitles()).toEqual(['Water the plants']));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a 404 removes the row with a notice', async () => {
    signedIn([plants, milk]);
    reply('DELETE /api/tasks/2', json({ error: 'task_not_found', message: 'That task could not be found.' }, 404));
    render(<App />);
    await expandCompleted();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete "Water the plants"' }));
    await userEvent.click(button('Confirm deleting "Water the plants"'));
    await waitFor(() => expect(taskTitles()).toEqual(['Buy oat milk']));
    expect(screen.getByRole('status').textContent).toBe(
      '"Water the plants" no longer exists, so it was removed from the list.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Buy oat milk' }));
  });

  test('the checkbox keeps working while another row is edited or asks for confirmation', async () => {
    signedIn([plants, milk, tea]);
    reply('PATCH /api/tasks/3', json({ task: { ...tea, completed: true } }));
    reply('PATCH /api/tasks/2', json({ task: { ...plants, completed: false } }));
    render(<App />);
    await expandCompleted();
    await startEditing('Buy oat milk');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Order tea' }));
    await waitFor(() =>
      expect((screen.getByRole('checkbox', { name: 'Order tea' }) as HTMLInputElement).checked).toBe(true),
    );
    // The edit in the other row is untouched by that.
    expect(editField('Buy oat milk').value).toBe('Buy oat milk');

    // A row that asks for confirmation (but is not deleting yet) can still be toggled.
    await userEvent.click(button('Delete "Water the plants"'));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Water the plants' }));
    await waitFor(() =>
      expect((screen.getByRole('checkbox', { name: 'Water the plants' }) as HTMLInputElement).checked).toBe(false),
    );
    expect(screen.getByText('Delete this task?')).toBeTruthy();
  });

  test('deleting waits for a pending completion change on the same task', async () => {
    signedIn([plants, milk]);
    const first = pending();
    const second = pending();
    reply('PATCH /api/tasks/1', first.response, second.response);
    reply('DELETE /api/tasks/1', noContent());
    render(<App />);
    await expandCompleted();
    // Each completion change moves the row to another group, so its controls are looked up again.
    const checkbox = () => screen.getByRole('checkbox', { name: 'Buy oat milk' }) as HTMLInputElement;
    const remove = () => button('Delete "Buy oat milk"');

    // From the plain row: Delete is locked (but focusable) while the change is pending.
    await userEvent.click(checkbox());
    expect(remove().disabled).toBe(false);
    expect(remove().getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(remove());
    expect(document.activeElement).toBe(remove());
    expect(screen.queryByText('Delete this task?')).toBeNull();
    first.finish(json({ task: { ...milk, completed: true } }));
    await waitFor(() => expect(checkbox().checked).toBe(true));
    await waitFor(() => expect(remove().getAttribute('aria-disabled')).toBeNull());

    // With the question open: Confirm is locked while a change started there is pending.
    await userEvent.click(remove());
    await userEvent.click(checkbox());
    let confirm = button('Confirm deleting "Buy oat milk"');
    expect(confirm.disabled).toBe(false);
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(confirm);
    expect(document.activeElement).toBe(confirm);
    expect(confirm.textContent).toBe('Confirm');
    expect(callsTo('DELETE /api/tasks/1')).toHaveLength(0);

    second.finish(json({ task: { ...milk, completed: false } }));
    await waitFor(() => expect(checkbox().checked).toBe(false));
    // The question stays open on the moved row.
    confirm = button('Confirm deleting "Buy oat milk"');
    await waitFor(() => expect(confirm.getAttribute('aria-disabled')).toBeNull());
    await userEvent.click(confirm);
    await waitFor(() => expect(taskTitles()).toEqual(['Water the plants']));
    expect(callsTo('DELETE /api/tasks/1')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('Escape in the question cancels it and returns focus to Delete, but not while deleting', async () => {
    signedIn([plants, milk]);
    const removal = pending();
    reply('DELETE /api/tasks/1', removal.response);
    render(<App />);
    await expandCompleted();
    for (const control of ['Cancel deleting "Buy oat milk"', 'Confirm deleting "Buy oat milk"']) {
      await userEvent.click(await screen.findByRole('button', { name: 'Delete "Buy oat milk"' }));
      button(control).focus();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByText('Delete this task?')).toBeNull();
      expect(document.activeElement).toBe(button('Delete "Buy oat milk"'));
    }
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);

    await userEvent.click(button('Delete "Buy oat milk"'));
    const confirm = button('Confirm deleting "Buy oat milk"');
    await userEvent.click(confirm);
    await userEvent.keyboard('{Escape}');
    button('Cancel deleting "Buy oat milk"').focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('Delete this task?')).toBeTruthy();
    removal.finish(noContent());
    await waitFor(() => expect(taskTitles()).toEqual(['Water the plants']));
  });

  test('while a delete is pending, Delete on other rows is visibly locked and ignored', async () => {
    signedIn([plants, milk]);
    const removal = pending();
    reply('DELETE /api/tasks/1', removal.response);
    render(<App />);
    await expandCompleted();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete "Buy oat milk"' }));
    expect(button('Delete "Water the plants"').getAttribute('aria-disabled')).toBeNull();
    await userEvent.click(button('Confirm deleting "Buy oat milk"'));

    const other = button('Delete "Water the plants"');
    expect(other.disabled).toBe(false);
    expect(other.getAttribute('aria-disabled')).toBe('true');
    expect(other.className).toContain('aria-disabled:opacity-50');
    await userEvent.click(other);
    expect(document.activeElement).toBe(other);
    expect(screen.queryByRole('group', { name: 'Delete "Water the plants"?' })).toBeNull();

    removal.finish(noContent());
    await waitFor(() => expect(taskTitles()).toEqual(['Water the plants']));
    expect(other.getAttribute('aria-disabled')).toBeNull();
    await userEvent.click(other);
    expect(screen.getByRole('group', { name: 'Delete "Water the plants"?' })).toBeTruthy();
  });
});

describe('session handling', () => {
  async function expectSignedOut() {
    expect(await screen.findByRole('button', { name: 'Sign in with Pior Labs' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Your session has ended. Please sign in again.');
    expect(screen.queryByRole('button', { name: 'Add a task' })).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Household One, account' })).toBeNull();
  }

  test('a 401 while loading tasks returns to the signed-out view', async () => {
    signedIn(json({ error: 'unauthorized' }, 401));
    render(<App />);
    await expectSignedOut();
  });

  test('a 401 while creating a task returns to the signed-out view', async () => {
    signedIn([milk]);
    reply('POST /api/tasks', json({ error: 'unauthorized' }, 401));
    render(<App />);
    await userEvent.type(await openAddSheet(), 'Too late{Enter}');
    await expectSignedOut();
  });

  test('a 401 while updating a task returns to the signed-out view', async () => {
    signedIn([milk]);
    reply('PATCH /api/tasks/1', json({ error: 'unauthorized' }, 401));
    render(<App />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Buy oat milk' }));
    await expectSignedOut();
  });

  test('a 401 while renaming a task returns to the signed-out view', async () => {
    signedIn([milk]);
    reply('PATCH /api/tasks/1', json({ error: 'unauthorized' }, 401));
    render(<App />);
    const field = await startEditing('Buy oat milk');
    await userEvent.type(field, ' too late{Enter}');
    await expectSignedOut();
  });

  test('a 401 while deleting a task returns to the signed-out view', async () => {
    signedIn([milk]);
    reply('DELETE /api/tasks/1', json({ error: 'unauthorized' }, 401));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete "Buy oat milk"' }));
    await userEvent.click(button('Confirm deleting "Buy oat milk"'));
    await expectSignedOut();
  });

  test('a rename or delete that fails with 401 after an explicit sign-out shows no session error', async () => {
    signedIn([plants, milk]);
    const rename = pending();
    const removal = pending();
    reply('PATCH /api/tasks/1', rename.response);
    reply('DELETE /api/tasks/2', removal.response);
    reply('POST /api/auth/sign-out', json({ success: true }));
    render(<App />);
    await expandCompleted();
    const field = await startEditing('Buy oat milk');
    await userEvent.type(field, ' in flight{Enter}');
    await userEvent.click(button('Delete "Water the plants"'));
    await userEvent.click(button('Confirm deleting "Water the plants"'));
    await signOut();
    expect(await screen.findByRole('button', { name: 'Sign in with Pior Labs' })).toBeTruthy();

    rename.finish(json({ error: 'unauthorized' }, 401));
    removal.finish(json({ error: 'unauthorized' }, 401));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in with Pior Labs' })).toBeTruthy();
  });

  test('a task request that fails with 401 after an explicit sign-out shows no session error', async () => {
    signedIn([milk]);
    let finishUpdate!: (response: Response) => void;
    let finishCreate!: (response: Response) => void;
    reply('PATCH /api/tasks/1', new Promise<Response>((resolve) => (finishUpdate = resolve)));
    reply('POST /api/tasks', new Promise<Response>((resolve) => (finishCreate = resolve)));
    reply('POST /api/auth/sign-out', json({ success: true }));
    render(<App />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Buy oat milk' }));
    await userEvent.type(await openAddSheet(), 'In flight{Enter}');
    await signOut();
    expect(await screen.findByRole('button', { name: 'Sign in with Pior Labs' })).toBeTruthy();

    finishUpdate(json({ error: 'unauthorized' }, 401));
    finishCreate(json({ error: 'unauthorized' }, 401));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in with Pior Labs' })).toBeTruthy();
  });

  test('a 401 that arrives while sign-out is in progress leaves no session error', async () => {
    signedIn([milk]);
    let finishSignOut!: (response: Response) => void;
    reply('PATCH /api/tasks/1', json({ error: 'unauthorized' }, 401));
    reply('POST /api/auth/sign-out', new Promise<Response>((resolve) => (finishSignOut = resolve)));
    render(<App />);
    const checkbox = await screen.findByRole('checkbox', { name: 'Buy oat milk' });
    await signOut();
    await userEvent.click(checkbox);
    await waitFor(() => expect(screen.queryByRole('list')).toBeNull());

    finishSignOut(json({ success: true }));
    expect(await screen.findByRole('button', { name: 'Sign in with Pior Labs' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('sign-out returns to the signed-out view without an error', async () => {
    signedIn([milk]);
    reply('POST /api/auth/sign-out', json({ success: true }));
    render(<App />);
    await screen.findByRole('checkbox', { name: 'Buy oat milk' });
    await signOut();
    expect(await screen.findByRole('button', { name: 'Sign in with Pior Labs' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(callsTo('POST /api/auth/sign-out')[0].body).toEqual({});
  });
});

describe('under StrictMode', () => {
  test('ignores the discarded first load and still creates tasks', async () => {
    // StrictMode runs each effect twice in development: two session and two task requests.
    let finishDiscarded!: (response: Response) => void;
    reply('GET /api/me', json({ user: signedInUser }), json({ user: signedInUser }));
    reply(
      'GET /api/tasks',
      new Promise<Response>((resolve) => (finishDiscarded = resolve)),
      json({ tasks: [milk] }),
    );
    reply('POST /api/tasks', json({ task: { id: 7, title: 'Call the plumber', completed: false, dueDate: null } }, 201));
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await waitFor(() => expect(taskTitles()).toEqual(['Buy oat milk']));
    expect(callsTo('GET /api/tasks')).toHaveLength(2);

    // The first, discarded request answers late with different data and must not win.
    finishDiscarded(json({ tasks: [plants] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(taskTitles()).toEqual(['Buy oat milk']);

    await userEvent.type(await openAddSheet(), 'Call the plumber{Enter}');
    await waitFor(() => expect(taskTitles()).toEqual(['Call the plumber', 'Buy oat milk']));
    expect(callsTo('POST /api/tasks')).toHaveLength(1);
  });
});

// Due dates. "Today" is the browser's local date, so these tests fix the clock
// at local noon on Friday 2026-11-20 (timers keep running so waits still work).
describe('due dates', () => {
  beforeEach(() => {
    // Only the clock and timers are faked; React's scheduler keeps its real
    // setImmediate, so effects (such as moving focus) run as in a browser.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    vi.setSystemTime(new Date(2026, 10, 20, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Focus is moved by an effect after the render that moves a row, so focus
  // checks wait for it.
  const due = (id: number, title: string, dueDate: string | null, completed = false) => ({
    id,
    title,
    listId: null,
    notes: null,
    completed,
    dueDate,
    repeat: null,
  });
  function group(name: string | RegExp) {
    return screen.getByRole('list', { name });
  }
  // Like taskTitles, for one group's list.
  function rowTitles(list: HTMLElement) {
    return within(list)
      .getAllByRole('listitem')
      .map((item) => {
        const field = item.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
        return field ? `editing: ${field.value}` : item.querySelector('label')?.textContent;
      });
  }
  // The row of a task, in view or in edit mode.
  function row(title: string) {
    const control =
      screen.queryByRole('checkbox', { name: title }) ??
      screen.getByRole('textbox', { name: `New title for "${title}"` });
    return control.closest('li')!;
  }
  // The visible text of the group headings; the toggle's arrow is decoration.
  function headings() {
    return screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent!.replace('\u25B8', ''));
  }
  function dateField(title: string) {
    return screen.getByLabelText(`Due date for "${title}"`) as HTMLInputElement;
  }

  test('groups open tasks by due date and keeps completed tasks in a collapsed section', async () => {
    // Server order: newest created first.
    signedIn([
      due(12, 'Overdue newer', '2026-11-18'),
      due(11, 'Done without date', null, true),
      due(10, 'Next week', '2026-11-27'),
      due(9, 'Today newer', '2026-11-20'),
      due(8, 'Someday newer', null),
      due(7, 'Long overdue', '2026-11-10'),
      due(6, 'Tomorrow', '2026-11-21'),
      due(5, 'Overdue older', '2026-11-18'),
      due(4, 'Done and late', '2026-11-01', true),
      due(3, 'Today older', '2026-11-20'),
      due(2, 'Someday older', null),
    ]);
    render(<App />);
    await screen.findByRole('list', { name: 'Overdue' });

    // Headings in order, each followed by its own list named after it.
    expect(headings()).toEqual([
      'Overdue',
      'Today',
      'Upcoming',
      'No date',
    ]);
    expect(rowTitles(group('Overdue'))).toEqual(['Long overdue', 'Overdue newer', 'Overdue older']);
    expect(rowTitles(group('Today'))).toEqual(['Today newer', 'Today older']);
    expect(rowTitles(group('Upcoming'))).toEqual(['Tomorrow', 'Next week']);
    expect(rowTitles(group('No date'))).toEqual(['Someday newer', 'Someday older']);
    expect(taskTitles()).toEqual([
      'Long overdue',
      'Overdue newer',
      'Overdue older',
      'Today newer',
      'Today older',
      'Tomorrow',
      'Next week',
      'Someday newer',
      'Someday older',
    ]);

    // Completed: collapsed by default behind "Show N done", a button with
    // aria-expanded and aria-controls, which reads "Hide done" when open (AC-7).
    const toggle = button('Show 2 done');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const controlled = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(controlled.tagName).toBe('UL');
    expect(controlled.getAttribute('aria-label')).toBe('Completed');
    expect(controlled.hidden).toBe(true);
    expect(screen.queryByRole('checkbox', { name: 'Done and late' })).toBeNull();
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide done');
    expect(controlled.hidden).toBe(false);
    expect(rowTitles(group(/^Completed/))).toEqual(['Done without date', 'Done and late']);
    expect(within(group(/^Completed/)).getAllByRole('checkbox').every((box) => (box as HTMLInputElement).checked)).toBe(true);
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Show 2 done');
    expect(screen.queryByRole('checkbox', { name: 'Done and late' })).toBeNull();
  });

  test('empty groups are hidden, and the Completed section only exists with completed tasks', async () => {
    signedIn([due(2, 'Due tomorrow', '2026-11-21'), due(1, 'No rush', null)]);
    render(<App />);
    await screen.findByRole('list', { name: 'Upcoming' });
    expect(headings()).toEqual([
      'Upcoming',
      'No date',
    ]);
    expect(screen.queryByRole('list', { name: 'Overdue' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Today' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Show \d+ done$/ })).toBeNull();
  });

  test('with only completed tasks there is no empty state, only the Completed section', async () => {
    signedIn([due(1, 'All done', '2026-11-19', true)]);
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Show 1 done' })).toBeTruthy();
    expect(screen.queryByText('No tasks yet. Add your first one with the + button.')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  test('due dates read as words near today and as a locale date otherwise; overdue is said in words', async () => {
    signedIn([
      due(7, 'Was yesterday', '2026-11-19'),
      due(6, 'Is today', '2026-11-20'),
      due(5, 'Is tomorrow', '2026-11-21'),
      due(4, 'Later this year', '2026-11-27'),
      due(3, 'Next year', '2027-01-05'),
      due(2, 'Last year', '2025-12-31'),
      due(1, 'Done yesterday', '2026-11-19', true),
    ]);
    render(<App />);
    await screen.findByRole('list', { name: 'Overdue' });
    const label = (title: string) => document.getElementById(
      screen.getByRole('checkbox', { name: title }).getAttribute('aria-describedby')!,
    )!;

    // The overdue rows say so in text, in the destructive colour, and the
    // checkbox description includes it.
    expect(label('Was yesterday').textContent).toBe('Overdue \u00B7 Due yesterday');
    expect(label('Was yesterday').className).toContain('text-destructive');
    expect(within(label('Was yesterday')).getByText('Overdue')).toBeTruthy();
    expect(label('Last year').textContent).toMatch(/^Overdue \u00B7 Due .*2025$/);
    // Not overdue: no word, no destructive colour.
    for (const [title, text] of [
      ['Is today', 'Due today'],
      ['Is tomorrow', 'Due tomorrow'],
    ]) {
      expect(label(title).textContent).toBe(text);
      expect(label(title).className).not.toContain('text-destructive');
    }
    // Other dates in the browser's locale with a weekday; the year only outside this year.
    expect(label('Later this year').textContent).toMatch(/^Due \S.*27/);
    expect(label('Later this year').textContent).not.toMatch(/2026/);
    expect(label('Next year').textContent).toMatch(/^Due \S.*5.*2027$/);
    // The title alone names the checkbox.
    expect(screen.getByRole('checkbox', { name: 'Was yesterday' })).toBeTruthy();

    // A completed task shows its date but no overdue marking.
    await expandCompleted();
    expect(label('Done yesterday').textContent).toBe('Due yesterday');
    expect(label('Done yesterday').className).not.toContain('text-destructive');
    // A task without a date shows no date line.
    expect(screen.getAllByText('Overdue', { selector: 'span' })).toHaveLength(2);
  });

  test('adds a task with a due date into its group, then clears both fields', async () => {
    signedIn([milk]);
    reply('POST /api/tasks', json({ task: due(7, 'Call the plumber', '2026-11-21') }, 201));
    reply('POST /api/tasks', json({ task: due(8, 'Pay the bill', '2026-11-12') }, 201));
    render(<App />);
    let title = await openAddSheet();
    await openChip('Due date');
    let date = screen.getByLabelText('Due date') as HTMLInputElement;
    expect(date.type).toBe('date');
    expect(date.min).toBe('2025-01-01');
    expect(date.max).toBe('2100-12-31');

    await userEvent.type(title, 'Call the plumber');
    fireEvent.change(date, { target: { value: '2026-11-21' } });
    await userEvent.click(button('Add task'));
    await waitFor(() => expect(rowTitles(group('Upcoming'))).toEqual(['Call the plumber']));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Call the plumber', dueDate: '2026-11-21' });
    await waitFor(() => expect(document.activeElement).toBe(button('Add a task')));
    title = await openAddSheet();
    date = screen.getByLabelText('Due date') as HTMLInputElement;
    expect(title.value).toBe('');
    expect(date.value).toBe('');
    expect(chip('Due date').getAttribute('aria-label')).toBe('Due date: none');

    // A past date in the supported range is allowed: the task is overdue at once.
    await userEvent.type(title, 'Pay the bill');
    fireEvent.change(date, { target: { value: '2026-11-12' } });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(rowTitles(group('Overdue'))).toEqual(['Pay the bill']));
    expect(callsTo('POST /api/tasks')[1].body).toEqual({ title: 'Pay the bill', dueDate: '2026-11-12' });
    expect(rowTitles(group('No date'))).toEqual(['Buy oat milk']);
  });

  test('refuses a due date outside the range inline, and shows a server rejection on the date field', async () => {
    signedIn([milk]);
    reply(
      'POST /api/tasks',
      json({ error: 'invalid_due_date', message: 'A due date must be a real calendar date.' }, 400),
    );
    render(<App />);
    const title = await openAddSheet();
    const date = screen.getByLabelText('Due date') as HTMLInputElement;
    await userEvent.type(title, 'Too early');
    for (const value of ['2024-12-31', '2101-01-01']) {
      fireEvent.change(date, { target: { value } });
      expect(screen.queryByRole('alert')).toBeNull();
      await userEvent.click(button('Add task'));
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toBe('Choose a due date from January 1, 2025 to December 31, 2100.');
      expect(date.getAttribute('aria-invalid')).toBe('true');
      expect(date.getAttribute('aria-describedby')).toBe(alert.id);
      expect(title.getAttribute('aria-invalid')).toBeNull();
      // The message shows with the date options, which the error opened (AC-5).
      expect(chip('Due date').getAttribute('aria-expanded')).toBe('true');
      expect(document.getElementById('new-task-date-options')!.contains(alert)).toBe(true);
    }
    expect(callsTo('POST /api/tasks')).toHaveLength(0);

    fireEvent.change(date, { target: { value: '2026-11-30' } });
    await userEvent.click(button('Add task'));
    expect((await screen.findByRole('alert')).textContent).toBe('A due date must be a real calendar date.');
    expect(date.getAttribute('aria-invalid')).toBe('true');
    // Nothing is shown as saved and the typed values are kept.
    expect(taskTitles()).toEqual(['Buy oat milk']);
    expect(title.value).toBe('Too early');
    expect(date.value).toBe('2026-11-30');
  });

  test('sets a due date in edit mode; only the date is sent and the row moves after the server stored it', async () => {
    signedIn([milk]);
    const save = pending();
    reply('PATCH /api/tasks/1', save.response);
    render(<App />);
    await startEditing('Buy oat milk');
    const date = dateField('Buy oat milk');
    expect(date.value).toBe('');
    expect(date.min).toBe('2025-01-01');
    expect(date.max).toBe('2100-12-31');
    // Nothing to remove yet.
    expect(screen.queryByRole('button', { name: 'Remove due date for "Buy oat milk"' })).toBeNull();

    fireEvent.change(date, { target: { value: '2026-11-20' } });
    await userEvent.click(button('Save'));
    expect(callsTo('PATCH /api/tasks/1')[0].body).toEqual({ dueDate: '2026-11-20' });
    // Pending: still in edit mode in the old group, the date field locked.
    expect(date.readOnly).toBe(true);
    expect(rowTitles(group('No date'))).toEqual(['editing: Buy oat milk']);
    expect(screen.queryByRole('list', { name: 'Today' })).toBeNull();

    save.finish(json({ task: due(1, 'Buy oat milk', '2026-11-20') }));
    await waitFor(() => expect(rowTitles(group('Today'))).toEqual(['Buy oat milk']));
    expect(screen.queryByRole('list', { name: 'No date' })).toBeNull();
    // Focus is on the row's Edit control in its new position.
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Buy oat milk"')));
    expect(within(row('Buy oat milk')).getByText('Due today')).toBeTruthy();
  });

  test('changes a due date with Enter and removes one with the Remove control', async () => {
    signedIn([due(4, 'Pay rent', '2026-11-25')]);
    reply('PATCH /api/tasks/4', json({ task: due(4, 'Pay rent', '2026-11-18') }));
    reply('PATCH /api/tasks/4', json({ task: due(4, 'Pay rent', null) }));
    render(<App />);
    await startEditing('Pay rent');
    expect(dateField('Pay rent').value).toBe('2026-11-25');
    fireEvent.change(dateField('Pay rent'), { target: { value: '2026-11-18' } });
    await userEvent.type(dateField('Pay rent'), '{Enter}', { skipClick: true });
    await waitFor(() => expect(rowTitles(group('Overdue'))).toEqual(['Pay rent']));
    expect(callsTo('PATCH /api/tasks/4')[0].body).toEqual({ dueDate: '2026-11-18' });
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Pay rent"')));

    await userEvent.click(button('Edit "Pay rent"'));
    const remove = button('Remove due date for "Pay rent"');
    expect(remove.textContent).toBe('Remove due date');
    await userEvent.click(remove);
    // The control goes away with the date; focus moves to the date field.
    expect(dateField('Pay rent').value).toBe('');
    expect(screen.queryByRole('button', { name: 'Remove due date for "Pay rent"' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(dateField('Pay rent')));
    await userEvent.click(button('Save'));
    await waitFor(() => expect(rowTitles(group('No date'))).toEqual(['Pay rent']));
    expect(callsTo('PATCH /api/tasks/4')[1].body).toEqual({ dueDate: null });
    expect(screen.queryByRole('list', { name: 'Overdue' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Pay rent"')));
    expect(within(row('Pay rent')).queryByText(/^Due/)).toBeNull();
  });

  test('sends the title and the date together only when both changed; an unchanged edit sends nothing', async () => {
    signedIn([due(4, 'Pay rent', '2026-11-25')]);
    reply('PATCH /api/tasks/4', json({ task: due(4, 'Pay the rent', '2026-11-26') }));
    reply('PATCH /api/tasks/4', json({ task: due(4, 'Pay the rent now', '2026-11-26') }));
    render(<App />);

    // Unchanged (also after typing and restoring the same date): no request.
    let field = await startEditing('Pay rent');
    fireEvent.change(dateField('Pay rent'), { target: { value: '2026-11-30' } });
    fireEvent.change(dateField('Pay rent'), { target: { value: '2026-11-25' } });
    await userEvent.type(field, '{Enter}', { skipClick: true });
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Pay rent"')));
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);

    field = await startEditing('Pay rent');
    fireEvent.change(field, { target: { value: ' Pay the rent ' } });
    fireEvent.change(dateField('Pay rent'), { target: { value: '2026-11-26' } });
    await userEvent.click(button('Save'));
    await waitFor(() => expect(taskTitles()).toEqual(['Pay the rent']));
    expect(callsTo('PATCH /api/tasks/4')[0].body).toEqual({ title: 'Pay the rent', dueDate: '2026-11-26' });

    // Only the title changed: only the title is sent.
    field = await startEditing('Pay the rent');
    fireEvent.change(field, { target: { value: 'Pay the rent now' } });
    await userEvent.click(button('Save'));
    await waitFor(() => expect(taskTitles()).toEqual(['Pay the rent now']));
    expect(callsTo('PATCH /api/tasks/4')[1].body).toEqual({ title: 'Pay the rent now' });
    expect(within(row('Pay the rent now')).getByText(/^Due/).textContent).toMatch(/26/);
  });

  test('Escape and Cancel restore the stored date without a request', async () => {
    signedIn([due(4, 'Pay rent', '2026-11-25')]);
    render(<App />);
    await startEditing('Pay rent');
    fireEvent.change(dateField('Pay rent'), { target: { value: '2026-11-19' } });
    dateField('Pay rent').focus();
    await userEvent.keyboard('{Escape}');
    expect(rowTitles(group('Upcoming'))).toEqual(['Pay rent']);
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Pay rent"')));

    await userEvent.click(button('Edit "Pay rent"'));
    expect(dateField('Pay rent').value).toBe('2026-11-25');
    await userEvent.click(button('Remove due date for "Pay rent"'));
    await userEvent.click(button('Cancel'));
    expect(rowTitles(group('Upcoming'))).toEqual(['Pay rent']);
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Pay rent"')));
    await userEvent.click(button('Edit "Pay rent"'));
    expect(dateField('Pay rent').value).toBe('2026-11-25');
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('a due date error stays inline in edit mode with the typed values', async () => {
    signedIn([due(4, 'Pay rent', '2026-11-25')]);
    reply(
      'PATCH /api/tasks/4',
      json({ error: 'invalid_due_date', message: 'A due date must be a real calendar date.' }, 400),
      json({ error: 'internal_error' }, 500),
      json({ task: due(4, 'Pay rent', '2026-12-01') }),
    );
    render(<App />);
    const field = await startEditing('Pay rent');

    // Outside the range: refused without a request.
    fireEvent.change(dateField('Pay rent'), { target: { value: '2101-01-01' } });
    await userEvent.click(button('Save'));
    let alert = within(row('Pay rent')).getByRole('alert');
    expect(alert.textContent).toBe('Choose a due date from January 1, 2025 to December 31, 2100.');
    expect(dateField('Pay rent').getAttribute('aria-invalid')).toBe('true');
    expect(dateField('Pay rent').getAttribute('aria-describedby')).toBe(alert.id);
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(callsTo('PATCH /api/tasks/4')).toHaveLength(0);

    // Rejected by the server: its message, on the date field.
    fireEvent.change(dateField('Pay rent'), { target: { value: '2026-12-01' } });
    expect(within(row('Pay rent')).queryByRole('alert')).toBeNull();
    await userEvent.click(button('Save'));
    alert = await within(row('Pay rent')).findByRole('alert');
    expect(alert.textContent).toBe('A due date must be a real calendar date.');
    expect(dateField('Pay rent').getAttribute('aria-invalid')).toBe('true');
    expect(dateField('Pay rent').value).toBe('2026-12-01');
    expect(rowTitles(group('Upcoming'))).toEqual(['editing: Pay rent']);

    // A failed request: a retry message, still editing.
    await waitFor(() => expect(dateField('Pay rent').readOnly).toBe(false));
    await userEvent.click(button('Save'));
    expect((await within(row('Pay rent')).findByRole('alert')).textContent).toBe(
      'The new due date could not be saved. Please try again.',
    );
    expect(dateField('Pay rent').value).toBe('2026-12-01');

    await waitFor(() => expect(dateField('Pay rent').readOnly).toBe(false));
    await userEvent.click(button('Save'));
    await waitFor(() => expect(rowTitles(group('Upcoming'))).toEqual(['Pay rent']));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('completing while Completed is collapsed moves focus to the next row, else the previous, with a status', async () => {
    signedIn([due(3, 'First', '2026-11-19'), due(2, 'Second', null), due(1, 'Third', null)]);
    reply('PATCH /api/tasks/2', json({ task: due(2, 'Second', null, true) }));
    reply('PATCH /api/tasks/1', json({ task: due(1, 'Third', null, true) }));
    reply('PATCH /api/tasks/3', json({ task: due(3, 'First', '2026-11-19', true) }));
    render(<App />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Second' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Second' })).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('"Second" was moved to Completed.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Third' })));
    expect(taskTitles()).toEqual(['First', 'Third']);
    expect(button('Show 1 done').getAttribute('aria-expanded')).toBe('false');

    // The last visible row: focus moves up, across groups.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Third' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Third' })).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('"Third" was moved to Completed.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'First' })));

    // No row left in view: focus moves to the Completed toggle. The overdue
    // task is now completed, so it is no longer marked overdue.
    await userEvent.click(screen.getByRole('checkbox', { name: 'First' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'First' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button('Show 3 done')));
    await expandCompleted();
    expect(rowTitles(group(/^Completed/))).toEqual(['First', 'Second', 'Third']);
    expect(within(row('First')).queryByText('Overdue')).toBeNull();
  });

  test('completing while Completed is expanded, and clearing, keep focus on the moved checkbox', async () => {
    signedIn([due(2, 'Open one', '2026-11-20'), due(1, 'Done one', '2026-11-19', true)]);
    reply('PATCH /api/tasks/2', json({ task: due(2, 'Open one', '2026-11-20', true) }));
    reply('PATCH /api/tasks/1', json({ task: due(1, 'Done one', '2026-11-19') }));
    render(<App />);
    await expandCompleted();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Open one' }));
    await waitFor(() => expect(rowTitles(group(/^Completed/))).toEqual(['Open one', 'Done one']));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Open one' })));
    expect(screen.queryByRole('status')).toBeNull();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Done one' }));
    await waitFor(() => expect(rowTitles(group('Overdue'))).toEqual(['Done one']));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Done one' })));
    expect(within(row('Done one')).getByText('Overdue')).toBeTruthy();
  });

  test('after a delete, focus moves to the neighbour in page order across groups', async () => {
    signedIn([due(2, 'Late', '2026-11-19'), due(1, 'Undated', null)]);
    reply('DELETE /api/tasks/2', noContent());
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete "Late"' }));
    await userEvent.click(button('Confirm deleting "Late"'));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Overdue' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Undated' })));
  });

  test('at local midnight, groups and labels follow the new date without a reload', async () => {
    vi.setSystemTime(new Date(2026, 10, 20, 23, 59, 0));
    signedIn([due(3, 'Bins out', '2026-11-20'), due(2, 'Dentist', '2026-11-21'), due(1, 'Later', '2026-11-22')]);
    render(<App />);
    await screen.findByRole('list', { name: 'Today' });
    expect(rowTitles(group('Today'))).toEqual(['Bins out']);
    expect(rowTitles(group('Upcoming'))).toEqual(['Dentist', 'Later']);

    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(rowTitles(group('Overdue'))).toEqual(['Bins out']);
    expect(rowTitles(group('Today'))).toEqual(['Dentist']);
    expect(rowTitles(group('Upcoming'))).toEqual(['Later']);
    expect(within(row('Bins out')).getByText('Due yesterday')).toBeTruthy();
    expect(within(row('Bins out')).getByText('Overdue')).toBeTruthy();
    expect(within(row('Later')).getByText('Due tomorrow')).toBeTruthy();

    // And again the next midnight.
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });
    expect(rowTitles(group('Overdue'))).toEqual(['Bins out', 'Dentist']);
    expect(rowTitles(group('Today'))).toEqual(['Later']);
    // The second request is the 30-second background refresh (shared lists
    // AC-14), still unanswered: the rows above moved without it.
    expect(callsTo('GET /api/tasks')).toHaveLength(2);
  });

  test('at midnight, focus stays on the same control of a row that moved group', async () => {
    vi.setSystemTime(new Date(2026, 10, 20, 23, 59, 0));
    signedIn([due(2, 'Bins out', '2026-11-20'), due(1, 'Dentist', '2026-11-21')]);
    render(<App />);
    const checkbox = (await screen.findByRole('checkbox', { name: 'Bins out' })) as HTMLInputElement;
    checkbox.focus();

    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(rowTitles(group('Overdue'))).toEqual(['Bins out']);
    // A new element in the Overdue list, with focus on it.
    const moved = screen.getByRole('checkbox', { name: 'Bins out' });
    expect(moved).not.toBe(checkbox);
    await waitFor(() => expect(document.activeElement).toBe(moved));

    // A row in edit mode: the typed text stays, the field keeps focus and the
    // caret, so typing goes on where it was. Dentist is due today now.
    const field = await startEditing('Dentist');
    await userEvent.type(field, ' first', { skipClick: true });
    field.setSelectionRange(3, 3);
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });
    expect(rowTitles(group('Overdue'))).toEqual(['Bins out', 'editing: Dentist first']);
    const movedField = editField('Dentist');
    expect(movedField).not.toBe(field);
    await waitFor(() => expect(document.activeElement).toBe(movedField));
    expect(movedField.selectionStart).toBe(3);
    await userEvent.keyboard('X');
    expect(movedField.value).toBe('DenXtist first');

    // The date field of an edited row keeps focus too.
    dateField('Dentist').focus();
    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });
    await waitFor(() => expect(document.activeElement).toBe(dateField('Dentist')));
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('when the page becomes visible again, focus stays on the moved row', async () => {
    let state: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    signedIn([due(1, 'Bins out', '2026-11-20')]);
    render(<App />);
    const edit = await screen.findByRole('button', { name: 'Edit "Bins out"' });
    edit.focus();
    state = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    vi.setSystemTime(new Date(2026, 10, 21, 9, 0, 0));
    state = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(rowTitles(group('Overdue'))).toEqual(['Bins out']);
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Bins out"')));
    expect(button('Edit "Bins out"')).not.toBe(edit);
  });

  test('when the page becomes visible again, groups follow the date', async () => {
    let state: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    signedIn([due(1, 'Bins out', '2026-11-20')]);
    render(<App />);
    await screen.findByRole('list', { name: 'Today' });

    // The page is hidden and the clock moves on without the timer firing (a sleeping computer).
    state = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    vi.setSystemTime(new Date(2026, 10, 22, 9, 0, 0));
    expect(rowTitles(group('Today'))).toEqual(['Bins out']);
    state = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(rowTitles(group('Overdue'))).toEqual(['Bins out']);
    // Two days later: a date, not "yesterday".
    expect(document.getElementById('task-1-due')!.textContent).toMatch(/^Overdue \u00B7 Due \S.*20$/);
    // The second request is the background refresh on becoming visible
    // (shared lists AC-14), still unanswered: the rows above moved without it.
    expect(callsTo('GET /api/tasks')).toHaveLength(2);
  });
});

describe('repeating tasks', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    // Friday 2026-11-20, noon local time.
    vi.setSystemTime(new Date(2026, 10, 20, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Repeat = { every: number; unit: 'day' | 'week' | 'month' | 'year' } | null;
  const weekly: Repeat = { every: 1, unit: 'week' };
  const task = (id: number, title: string, dueDate: string | null, repeat: Repeat = null, completed = false) => ({
    id,
    title,
    listId: null,
    notes: null,
    completed,
    dueDate,
    repeat,
  });
  const group = (name: string | RegExp) => screen.getByRole('list', { name });
  const checkbox = (title: string) => screen.getByRole('checkbox', { name: title }) as HTMLInputElement;
  const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
  const description = (title: string) =>
    document.getElementById(checkbox(title).getAttribute('aria-describedby')!)!.textContent;
  // The words the rows use for a date, without "Due ".
  const when = (dueDate: string) => dueLabel(dueDate, '2026-11-20').replace(/^Due /, '');
  const status = () => screen.getByRole('status').textContent;
  function rowTitles(list: HTMLElement) {
    return within(list)
      .getAllByRole('listitem')
      .map((item) => {
        const field = item.querySelector<HTMLInputElement>('input:not([type="checkbox"])');
        return field ? `editing: ${field.value}` : item.querySelector('label')?.textContent;
      });
  }

  test('rows show their repeat beside the due date, also when completed', async () => {
    signedIn([
      task(7, 'Daily walk', '2026-11-20', { every: 1, unit: 'day' }),
      task(6, 'Bins out', '2026-11-19', weekly),
      task(5, 'Pay rent', '2026-11-30', { every: 1, unit: 'month' }),
      task(4, 'Renew passport', '2026-12-01', { every: 1, unit: 'year' }),
      task(3, 'Water ferns', '2026-11-23', { every: 3, unit: 'day' }),
      task(2, 'Clean gutters', '2026-11-24', { every: 2, unit: 'week' }),
      task(1, 'Was weekly', '2026-11-18', weekly, true),
      task(8, 'Plain', '2026-11-21'),
    ]);
    render(<App />);
    await screen.findByRole('list', { name: 'Today' });
    expect(description('Daily walk')).toBe('Due today · Repeats daily');
    expect(description('Bins out')).toBe('Overdue · Due yesterday · Repeats weekly');
    expect(description('Pay rent')).toMatch(/^Due \S.* · Repeats monthly$/);
    expect(description('Renew passport')).toMatch(/ · Repeats yearly$/);
    expect(description('Water ferns')).toMatch(/ · Repeats every 3 days$/);
    expect(description('Clean gutters')).toMatch(/ · Repeats every 2 weeks$/);
    expect(description('Plain')).toBe('Due tomorrow');
    await expandCompleted();
    expect(description('Was weekly')).toMatch(/^Due \S.* · Repeats weekly$/);
  });

  test('the add sheet offers Repeat only with a due date, with presets and Custom (D-8)', async () => {
    signedIn([]);
    reply('POST /api/tasks', json({ task: task(1, 'Bins out', '2026-11-24', weekly) }, 201));
    reply('POST /api/tasks', json({ task: task(2, 'Gutters', '2026-11-30', { every: 2, unit: 'week' }) }, 201));
    reply('POST /api/tasks', json({ task: task(3, 'No repeat', '2026-11-30') }, 201));
    render(<App />);
    let title = await openAddSheet();
    let date = screen.getByLabelText('Due date') as HTMLInputElement;
    // No date yet: there is no Repeat chip and no repeat control.
    expect(within(addSheet()).queryByRole('button', { name: /^Repeat: / })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Repeats' })).toBeNull();
    expect(screen.queryByText('Set a due date to repeat')).toBeNull();

    // With a date it is offered, as a chip that opens the repeat control.
    await userEvent.type(title, 'Bins out');
    fireEvent.change(date, { target: { value: '2026-11-24' } });
    expect(chip('Repeat').getAttribute('aria-label')).toBe('Repeat: none');
    await openChip('Repeat');
    const repeats = select('Repeats');
    expect(repeats.value).toBe('none');
    expect(repeats.disabled).toBe(false);
    expect(repeats.getAttribute('aria-disabled')).toBeNull();
    expect([...repeats.options].map((option) => option.textContent)).toEqual([
      'Does not repeat',
      'Daily',
      'Weekly',
      'Monthly',
      'Yearly',
      'Custom',
    ]);
    await userEvent.selectOptions(repeats, 'weekly');
    expect(repeats.value).toBe('weekly');
    expect(chip('Repeat').getAttribute('aria-label')).toBe('Repeat: Weekly');
    await userEvent.click(button('Add task'));
    await waitFor(() => expect(callsTo('POST /api/tasks')).toHaveLength(1));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Bins out', dueDate: '2026-11-24', repeat: weekly });
    // Stored: the row shows it, and the draft is reset, repeat included.
    await waitFor(() => expect(description('Bins out')).toMatch(/Repeats weekly$/));
    title = await openAddSheet();
    date = screen.getByLabelText('Due date') as HTMLInputElement;
    expect(within(addSheet()).queryByRole('button', { name: /^Repeat: / })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Repeats' })).toBeNull();

    // Custom reveals the number and the unit.
    await userEvent.type(title, 'Gutters');
    fireEvent.change(date, { target: { value: '2026-11-30' } });
    expect(screen.queryByRole('spinbutton', { name: 'Every' })).toBeNull();
    await openChip('Repeat');
    await userEvent.selectOptions(select('Repeats'), 'custom');
    const every = screen.getByRole('spinbutton', { name: 'Every' }) as HTMLInputElement;
    const unit = select('Repeat unit');
    expect([...unit.options].map((option) => option.textContent)).toEqual(['days', 'weeks', 'months', 'years']);
    // Out of range or not a whole number: refused inline without a request.
    for (const value of ['0', '100', '', '1.5']) {
      fireEvent.change(every, { target: { value } });
      await userEvent.click(button('Add task'));
      expect(screen.getByRole('alert').textContent).toBe(
        'Enter a whole number from 1 to 99 for how often it repeats.',
      );
      expect(every.getAttribute('aria-invalid')).toBe('true');
    }
    expect(callsTo('POST /api/tasks')).toHaveLength(1);
    fireEvent.change(every, { target: { value: '2' } });
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.selectOptions(unit, 'week');
    await userEvent.click(button('Add task'));
    await waitFor(() => expect(callsTo('POST /api/tasks')).toHaveLength(2));
    expect(callsTo('POST /api/tasks')[1].body).toEqual({
      title: 'Gutters',
      dueDate: '2026-11-30',
      repeat: { every: 2, unit: 'week' },
    });
    await waitFor(() => expect(description('Gutters')).toMatch(/Repeats every 2 weeks$/));

    // Removing the date resets the repeat, so nothing repeating is sent.
    title = await openAddSheet();
    date = screen.getByLabelText('Due date') as HTMLInputElement;
    await userEvent.type(title, 'No repeat');
    fireEvent.change(date, { target: { value: '2026-11-30' } });
    await openChip('Repeat');
    await userEvent.selectOptions(select('Repeats'), 'monthly');
    fireEvent.change(date, { target: { value: '' } });
    expect(screen.queryByRole('combobox', { name: 'Repeats' })).toBeNull();
    expect(within(addSheet()).queryByRole('button', { name: /^Repeat: / })).toBeNull();
    fireEvent.change(date, { target: { value: '2026-11-30' } });
    expect(chip('Repeat').getAttribute('aria-label')).toBe('Repeat: none');
    await openChip('Repeat');
    expect(select('Repeats').value).toBe('none');
    await userEvent.click(button('Add task'));
    await waitFor(() => expect(callsTo('POST /api/tasks')).toHaveLength(3));
    expect(callsTo('POST /api/tasks')[2].body).toEqual({ title: 'No repeat', dueDate: '2026-11-30' });
  });

  test('the add form shows a server repeat error on the repeat control', async () => {
    signedIn([]);
    reply('POST /api/tasks', json({ error: 'invalid_repeat', message: 'A repeat must be null or an object.' }, 400));
    render(<App />);
    const title = await openAddSheet();
    await userEvent.type(title, 'Rejected');
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-11-24' } });
    await openChip('Repeat');
    await userEvent.selectOptions(select('Repeats'), 'daily');
    // Closed again: the error opens it.
    await userEvent.click(chip('Repeat'));
    await userEvent.click(button('Add task'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('A repeat must be null or an object.');
    expect(select('Repeats').getAttribute('aria-invalid')).toBe('true');
    expect(select('Repeats').getAttribute('aria-describedby')).toBe(alert.id);
    expect(title.getAttribute('aria-invalid')).toBeNull();
    expect(select('Repeats').value).toBe('daily');
    expect(chip('Repeat').getAttribute('aria-expanded')).toBe('true');
  });

  test('the edit row changes and stops a repeat, sending only what changed', async () => {
    signedIn([task(4, 'Bins out', '2026-11-24', weekly)]);
    reply('PATCH /api/tasks/4', json({ task: task(4, 'Bins out', '2026-11-24', { every: 1, unit: 'month' }) }));
    reply('PATCH /api/tasks/4', json({ task: task(4, 'Bins out', '2026-11-24', { every: 10, unit: 'day' }) }));
    reply('PATCH /api/tasks/4', json({ task: task(4, 'Bins out', '2026-11-24') }));
    reply('PATCH /api/tasks/4', json({ task: task(4, 'Bins out', '2026-11-26', weekly) }));
    reply('PATCH /api/tasks/4', json({ task: task(4, 'Bins out', null) }));
    render(<App />);
    await startEditing('Bins out');
    const repeats = () => select('Repeats for "Bins out"');
    const row4 = () => repeats().closest('li')!;
    expect(repeats().value).toBe('weekly');
    expect(repeats().disabled).toBe(false);
    expect(repeats().getAttribute('aria-disabled')).toBeNull();
    // Unchanged: no request.
    await userEvent.click(button('Save'));
    expect(callsTo('PATCH /api/tasks/4')).toHaveLength(0);

    await userEvent.click(button('Edit "Bins out"'));
    await userEvent.selectOptions(repeats(), 'monthly');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(description('Bins out')).toMatch(/Repeats monthly$/));
    expect(callsTo('PATCH /api/tasks/4')[0].body).toEqual({ repeat: { every: 1, unit: 'month' } });

    // Custom: the stored repeat comes back as its preset; every 10 days.
    await userEvent.click(button('Edit "Bins out"'));
    expect(repeats().value).toBe('monthly');
    await userEvent.selectOptions(repeats(), 'custom');
    const every = screen.getByRole('spinbutton', { name: 'Repeat interval for "Bins out"' }) as HTMLInputElement;
    expect(every.value).toBe('1');
    expect(select('Repeat unit for "Bins out"').value).toBe('month');
    fireEvent.change(every, { target: { value: '10' } });
    await userEvent.selectOptions(select('Repeat unit for "Bins out"'), 'day');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(description('Bins out')).toMatch(/Repeats every 10 days$/));
    expect(callsTo('PATCH /api/tasks/4')[1].body).toEqual({ repeat: { every: 10, unit: 'day' } });

    // Stop repeating.
    await userEvent.click(button('Edit "Bins out"'));
    expect(repeats().value).toBe('custom');
    expect((screen.getByRole('spinbutton', { name: 'Repeat interval for "Bins out"' }) as HTMLInputElement).value).toBe('10');
    await userEvent.selectOptions(repeats(), 'none');
    expect(screen.queryByRole('spinbutton', { name: 'Repeat interval for "Bins out"' })).toBeNull();
    await userEvent.click(button('Save'));
    await waitFor(() => expect(description('Bins out')).not.toMatch(/Repeats/));
    expect(callsTo('PATCH /api/tasks/4')[2].body).toEqual({ repeat: null });

    // A new date and a repeat are sent together.
    await userEvent.click(button('Edit "Bins out"'));
    fireEvent.change(screen.getByLabelText('Due date for "Bins out"'), { target: { value: '2026-11-26' } });
    await userEvent.selectOptions(repeats(), 'weekly');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(description('Bins out')).toMatch(/Repeats weekly$/));
    expect(callsTo('PATCH /api/tasks/4')[3].body).toEqual({ dueDate: '2026-11-26', repeat: weekly });

    // Remove due date resets the repeat: the control is disabled with the
    // hint, and both are sent.
    await userEvent.click(button('Edit "Bins out"'));
    await userEvent.click(button('Remove due date for "Bins out"'));
    expect(repeats().value).toBe('none');
    expect(repeats().disabled).toBe(true);
    expect(repeats().getAttribute('aria-disabled')).toBeNull();
    const hint = document.getElementById(repeats().getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toBe('Set a due date to repeat');
    expect(row4().contains(hint)).toBe(true);
    await userEvent.selectOptions(repeats(), 'daily');
    expect(repeats().value).toBe('none');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(rowTitles(group('No date'))).toEqual(['Bins out']));
    expect(callsTo('PATCH /api/tasks/4')[4].body).toEqual({ dueDate: null, repeat: null });
  });

  test('the edit row clears a repeat with a removed date, and keeps server errors inline', async () => {
    signedIn([task(4, 'Bins out', '2026-11-24', weekly), task(3, 'Undated', null)]);
    reply('PATCH /api/tasks/4', json({ error: 'invalid_repeat', message: 'A repeating task needs a due date.' }, 400));
    render(<App />);
    // A task without a date: the control is disabled with the hint.
    await startEditing('Undated');
    const repeats = select('Repeats for "Undated"');
    expect(repeats.disabled).toBe(true);
    expect(repeats.getAttribute('aria-disabled')).toBeNull();
    expect(within(repeats.closest('li')!).getByText('Set a due date to repeat').id).toBe(
      repeats.getAttribute('aria-describedby'),
    );
    await userEvent.click(button('Cancel'));

    // Emptying the date field also resets the repeat.
    await startEditing('Bins out');
    fireEvent.change(screen.getByLabelText('Due date for "Bins out"'), { target: { value: '' } });
    expect(select('Repeats for "Bins out"').value).toBe('none');
    fireEvent.change(screen.getByLabelText('Due date for "Bins out"'), { target: { value: '2026-11-25' } });
    await userEvent.selectOptions(select('Repeats for "Bins out"'), 'custom');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Repeat interval for "Bins out"' }), {
      target: { value: '0' },
    });
    await userEvent.click(button('Save'));
    expect(screen.getByRole('alert').textContent).toBe('Enter a whole number from 1 to 99 for how often it repeats.');
    expect(callsTo('PATCH /api/tasks/4')).toHaveLength(0);

    // A server rejection stays inline with the typed values, still editing.
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Repeat interval for "Bins out"' }), {
      target: { value: '3' },
    });
    await userEvent.click(button('Save'));
    expect((await screen.findByRole('alert')).textContent).toBe('A repeating task needs a due date.');
    expect(callsTo('PATCH /api/tasks/4')[0].body).toEqual({ dueDate: '2026-11-25', repeat: { every: 3, unit: 'week' } });
    const every = screen.getByRole('spinbutton', { name: 'Repeat interval for "Bins out"' }) as HTMLInputElement;
    expect(every.getAttribute('aria-invalid')).toBe('true');
    expect(every.value).toBe('3');
    expect(rowTitles(group('Upcoming'))).toEqual(['editing: Bins out']);
  });

  // R3-F1: Chromium reports a partly typed date as value '' with badInput.
  // When the last part is emptied, badInput turns false with no input or
  // change event, so the value React tracks stays ''. jsdom has no date
  // parts, so these tests set badInput themselves and send only the events
  // Chromium sends. The returned function empties the last part.
  function typePartOfDate(field: HTMLInputElement) {
    let partial = true;
    Object.defineProperty(field, 'validity', { configurable: true, get: () => ({ badInput: partial }) });
    fireEvent.change(field, { target: { value: '' } });
    return () => {
      partial = false;
    };
  }

  test('the add sheet resets the repeat once a date emptied part by part has no part left (R3-F1)', async () => {
    signedIn([]);
    render(<App />);
    await openAddSheet();
    const date = screen.getByLabelText('Due date') as HTMLInputElement;
    // The reset comes with the key that emptied the last part, or on leaving the field.
    for (const finish of [() => fireEvent.keyUp(date, { key: 'Backspace' }), () => fireEvent.blur(date)]) {
      fireEvent.change(date, { target: { value: '2026-11-24' } });
      await openChip('Repeat');
      await userEvent.selectOptions(select('Repeats'), 'weekly');
      // Partly typed: no date, so no Repeat chip, but the choice is kept.
      typePartOfDate(date);
      expect(within(addSheet()).queryByRole('button', { name: /^Repeat: / })).toBeNull();
      fireEvent.change(date, { target: { value: '2026-11-25' } });
      expect(chip('Repeat').getAttribute('aria-label')).toBe('Repeat: Weekly');
      const emptyLastPart = typePartOfDate(date);
      emptyLastPart();
      finish();
      fireEvent.change(date, { target: { value: '2026-11-24' } });
      expect(chip('Repeat').getAttribute('aria-label')).toBe('Repeat: none');
      Reflect.deleteProperty(date, 'validity');
    }
  });

  test('the edit row resets the repeat once a date emptied part by part has no part left (R3-F1)', async () => {
    signedIn([task(4, 'Bins out', '2026-11-24', weekly)]);
    render(<App />);
    await startEditing('Bins out');
    const date = screen.getByLabelText('Due date for "Bins out"') as HTMLInputElement;
    for (const finish of [() => fireEvent.keyUp(date, { key: 'Delete' }), () => fireEvent.blur(date)]) {
      fireEvent.change(date, { target: { value: '2026-11-24' } });
      await userEvent.selectOptions(select('Repeats for "Bins out"'), 'weekly');
      const emptyLastPart = typePartOfDate(date);
      expect(select('Repeats for "Bins out"').value).toBe('weekly');
      expect(select('Repeats for "Bins out"').disabled).toBe(true);
      emptyLastPart();
      finish();
      expect(select('Repeats for "Bins out"').value).toBe('none');
      expect(select('Repeats for "Bins out"').disabled).toBe(true);
      Reflect.deleteProperty(date, 'validity');
    }
    expect(callsTo('PATCH /api/tasks/4')).toHaveLength(0);
  });

  test('the Repeats controls are disabled without a date and keep the aria-disabled lock while pending (D-11)', async () => {
    signedIn([task(4, 'Bins out', '2026-11-24', { every: 2, unit: 'week' })]);
    const save = pending();
    reply('PATCH /api/tasks/4', save.response);
    const create = pending();
    reply('POST /api/tasks', create.response);
    render(<App />);
    await startEditing('Bins out');
    const repeats = () => select('Repeats for "Bins out"');
    const every = () => screen.getByRole('spinbutton', { name: 'Repeat interval for "Bins out"' }) as HTMLInputElement;
    const unit = () => select('Repeat unit for "Bins out"');
    // With a date: enabled, Custom fields included.
    expect(repeats().value).toBe('custom');
    for (const control of [repeats(), every(), unit()]) expect(control.disabled).toBe(false);

    // Pending save: locked with aria-disabled and readOnly, not disabled, so focus stays.
    repeats().focus();
    fireEvent.change(every(), { target: { value: '3' } });
    fireEvent.submit(repeats().closest('form')!);
    await waitFor(() => expect(repeats().getAttribute('aria-disabled')).toBe('true'));
    expect(repeats().disabled).toBe(false);
    expect(unit().disabled).toBe(false);
    expect(unit().getAttribute('aria-disabled')).toBe('true');
    expect(every().disabled).toBe(false);
    expect(every().readOnly).toBe(true);
    expect(document.activeElement).toBe(repeats());
    fireEvent.change(repeats(), { target: { value: 'daily' } });
    expect(repeats().value).toBe('custom');
    save.finish(json({ task: task(4, 'Bins out', '2026-11-24', { every: 3, unit: 'week' }) }));
    await waitFor(() => expect(description('Bins out')).toMatch(/Repeats every 3 weeks$/));

    // The add sheet while creating: a date is set, so the lock is aria-disabled.
    await userEvent.type(await openAddSheet(), 'Gutters');
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-11-30' } });
    await openChip('Repeat');
    await userEvent.selectOptions(select('Repeats'), 'weekly');
    await userEvent.click(button('Add task'));
    expect(select('Repeats').getAttribute('aria-disabled')).toBe('true');
    expect(select('Repeats').disabled).toBe(false);
    create.finish(json({ task: task(5, 'Gutters', '2026-11-30', weekly) }, 201));
    await waitFor(() => expect(description('Gutters')).toMatch(/Repeats weekly$/));
    // Reset after creating: no date, so no Repeat chip or control (D-8).
    await openAddSheet();
    expect(screen.queryByRole('combobox', { name: 'Repeats' })).toBeNull();
  });

  test('ticking a repeating task adds the next occurrence and moves focus to it (Completed collapsed)', async () => {
    signedIn([task(2, 'Water the plants', '2026-11-20', weekly), task(1, 'Buy oat milk', null)]);
    const tick = pending();
    reply('PATCH /api/tasks/2', tick.response);
    render(<App />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Water the plants' }));
    expect(callsTo('PATCH /api/tasks/2')[0].body).toEqual({ completed: true, today: '2026-11-20' });
    // Nothing moves before the server answers.
    expect(rowTitles(group('Today'))).toEqual(['Water the plants']);
    tick.finish(
      json({
        task: task(2, 'Water the plants', '2026-11-20', weekly, true),
        nextTask: task(9, 'Water the plants', '2026-11-27', weekly),
        removedTaskId: null,
      }),
    );
    await waitFor(() => expect(rowTitles(group('Upcoming'))).toEqual(['Water the plants']));
    expect(screen.queryByRole('list', { name: 'Today' })).toBeNull();
    expect(status()).toBe(`"Water the plants" is next due ${when('2026-11-27')}.`);
    expect(status()).toMatch(/^"Water the plants" is next due \S+, \S+ 27\.$/);
    await waitFor(() => expect(document.activeElement).toBe(checkbox('Water the plants')));
    expect(checkbox('Water the plants').checked).toBe(false);
    expect(button('Show 1 done').getAttribute('aria-expanded')).toBe('false');
    await expandCompleted();
    expect(rowTitles(group(/^Completed/))).toEqual(['Water the plants']);
  });

  test('ticking with Completed expanded also focuses the next occurrence; un-ticking removes it', async () => {
    signedIn([task(2, 'Water the plants', '2026-11-19', weekly), task(1, 'Done', null, null, true)]);
    reply(
      'PATCH /api/tasks/2',
      json({
        task: task(2, 'Water the plants', '2026-11-19', weekly, true),
        nextTask: task(9, 'Water the plants', '2026-11-26', weekly),
        removedTaskId: null,
      }),
      json({ task: task(2, 'Water the plants', '2026-11-19', weekly), nextTask: null, removedTaskId: 9 }),
    );
    render(<App />);
    await expandCompleted();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Water the plants' }));
    await waitFor(() => expect(rowTitles(group('Upcoming'))).toEqual(['Water the plants']));
    expect(rowTitles(group(/^Completed/))).toEqual(['Water the plants', 'Done']);
    expect(status()).toBe(`"Water the plants" is next due ${when('2026-11-26')}.`);
    const next = within(group('Upcoming')).getByRole('checkbox', { name: 'Water the plants' });
    await waitFor(() => expect(document.activeElement).toBe(next));

    // Un-tick the completed one: the server removed the next occurrence.
    const done = within(group(/^Completed/)).getByRole('checkbox', { name: 'Water the plants' });
    await userEvent.click(done);
    expect(callsTo('PATCH /api/tasks/2')[1].body).toEqual({ completed: false });
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Upcoming' })).toBeNull());
    expect(rowTitles(group('Overdue'))).toEqual(['Water the plants']);
    expect(status()).toBe('"Water the plants" is open again, and its next occurrence was removed.');
    // Focus follows the un-ticked row.
    await waitFor(() => expect(document.activeElement).toBe(checkbox('Water the plants')));
    expect(within(group('Overdue')).getByRole('checkbox', { name: 'Water the plants' })).toBe(document.activeElement);
  });

  test('when no next occurrence was created the status says so; a plain task is unchanged', async () => {
    signedIn([task(3, 'Last one', '2100-12-31', { every: 1, unit: 'day' }), task(2, 'Plain', '2026-11-20'), task(1, 'Other', null)]);
    reply('PATCH /api/tasks/3', json({ task: task(3, 'Last one', '2100-12-31', { every: 1, unit: 'day' }, true), nextTask: null, removedTaskId: null }));
    reply('PATCH /api/tasks/2', json({ task: task(2, 'Plain', '2026-11-20', null, true), nextTask: null, removedTaskId: null }));
    render(<App />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Last one' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Last one' })).toBeNull());
    expect(status()).toBe(
      '"Last one" was moved to Completed. No further occurrence was created, because it would be after December 31, 2100.',
    );
    // The usual focus rule: the next row in page order.
    await waitFor(() => expect(document.activeElement).toBe(checkbox('Other')));
    await userEvent.click(checkbox('Plain'));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Plain' })).toBeNull());
    expect(status()).toBe('"Plain" was moved to Completed.');
    expect(callsTo('PATCH /api/tasks/2')[0].body).toEqual({ completed: true, today: '2026-11-20' });
  });

  test('re-ticking a task whose next occurrence was kept says it already exists (R1-F1)', async () => {
    const plants = (completed: boolean) => task(2, 'Water the plants', '2026-11-20', weekly, completed);
    signedIn([task(9, 'Water the plants', '2026-11-27', weekly, true), plants(true)]);
    reply(
      'PATCH /api/tasks/2',
      // Un-ticked: its next occurrence was completed, so the server kept it.
      json({ task: plants(false), nextTask: null, removedTaskId: null }),
      // Ticked again: the next occurrence already exists, so none is created.
      json({ task: plants(true), nextTask: null, removedTaskId: null }),
    );
    render(<App />);
    await expandCompleted();
    await userEvent.click(within(group(/^Completed/)).getAllByRole('checkbox', { name: 'Water the plants' })[1]);
    await waitFor(() => expect(rowTitles(group('Today'))).toEqual(['Water the plants']));
    await userEvent.click(within(group('Today')).getByRole('checkbox', { name: 'Water the plants' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Today' })).toBeNull());
    expect(status()).toBe('"Water the plants" was moved to Completed. Its next occurrence already exists.');
  });

  test('ticking a task whose next date would be after 2100 says why none was created (R1-F1)', async () => {
    const cases = [
      [task(3, 'Daily end', '2100-12-31', { every: 1, unit: 'day' }), true],
      [task(4, 'Monthly end', '2100-12-05', { every: 1, unit: 'month' }), true],
      [task(5, 'Monthly last', '2100-11-30', { every: 1, unit: 'month' }), false],
      [task(6, 'Yearly', '2100-01-31', { every: 1, unit: 'year' }), true],
    ] as const;
    signedIn(cases.map(([item]) => item));
    for (const [item] of cases) {
      reply(`PATCH /api/tasks/${item.id}`, json({ task: { ...item, completed: true }, nextTask: null, removedTaskId: null }));
    }
    render(<App />);
    await screen.findByRole('list', { name: 'Upcoming' });
    for (const [item, beyond] of cases) {
      await userEvent.click(checkbox(item.title));
      await waitFor(() => expect(screen.queryByRole('checkbox', { name: item.title })).toBeNull());
      expect(status()).toBe(
        beyond
          ? `"${item.title}" was moved to Completed. No further occurrence was created, because it would be after December 31, 2100.`
          : `"${item.title}" was moved to Completed. Its next occurrence already exists.`,
      );
    }
  });

  test('Custom starts from the stored repeat, not from presets passed on the way (R1-F2)', async () => {
    signedIn([task(4, 'Bins out', '2026-11-24', weekly), task(3, 'Every 5 days', '2026-11-24', { every: 5, unit: 'day' })]);
    render(<App />);
    await startEditing('Bins out');
    // Arrowing down from Weekly passes Monthly and Yearly before Custom.
    for (const choice of ['monthly', 'yearly', 'custom']) {
      fireEvent.change(select('Repeats for "Bins out"'), { target: { value: choice } });
    }
    expect((screen.getByRole('spinbutton', { name: 'Repeat interval for "Bins out"' }) as HTMLInputElement).value).toBe('1');
    expect(select('Repeat unit for "Bins out"').value).toBe('week');
    await userEvent.click(button('Cancel'));

    // A stored custom repeat comes back after passing through presets.
    await startEditing('Every 5 days');
    for (const choice of ['none', 'daily', 'custom']) {
      fireEvent.change(select('Repeats for "Every 5 days"'), { target: { value: choice } });
    }
    expect((screen.getByRole('spinbutton', { name: 'Repeat interval for "Every 5 days"' }) as HTMLInputElement).value).toBe('5');
    expect(select('Repeat unit for "Every 5 days"').value).toBe('day');
    await userEvent.click(button('Cancel'));

    // The add sheet has no stored repeat: Custom starts at every 1 week.
    await openAddSheet();
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-11-24' } });
    await openChip('Repeat');
    for (const choice of ['monthly', 'yearly', 'custom']) {
      fireEvent.change(select('Repeats'), { target: { value: choice } });
    }
    expect((screen.getByRole('spinbutton', { name: 'Every' }) as HTMLInputElement).value).toBe('1');
    expect(select('Repeat unit').value).toBe('week');
  });

  test('the local date at the moment of ticking is sent as today', async () => {
    signedIn([task(2, 'Late night', '2026-11-20', weekly)]);
    reply(
      'PATCH /api/tasks/2',
      json({ task: task(2, 'Late night', '2026-11-20', weekly, true), nextTask: task(3, 'Late night', '2026-11-27', weekly), removedTaskId: null }),
    );
    // 23:59:50 local time; ticking happens after local midnight.
    vi.setSystemTime(new Date(2026, 10, 20, 23, 59, 50));
    render(<App />);
    await screen.findByRole('checkbox', { name: 'Late night' });
    vi.setSystemTime(new Date(2026, 10, 21, 0, 0, 5));
    await userEvent.click(checkbox('Late night'));
    expect(callsTo('PATCH /api/tasks/2')[0].body).toEqual({ completed: true, today: '2026-11-21' });
  });

  test('edit and delete wait for a pending tick of a repeating task', async () => {
    signedIn([task(2, 'Bins out', '2026-11-20', weekly)]);
    const tick = pending();
    reply('PATCH /api/tasks/2', tick.response);
    render(<App />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Bins out' }));
    await userEvent.click(checkbox('Bins out'));
    expect(callsTo('PATCH /api/tasks/2')).toHaveLength(1);
    expect(button('Edit "Bins out"').getAttribute('aria-disabled')).toBe('true');
    tick.finish(
      json({ task: task(2, 'Bins out', '2026-11-20', weekly, true), nextTask: task(5, 'Bins out', '2026-11-27', weekly), removedTaskId: null }),
    );
    await waitFor(() => expect(rowTitles(group('Upcoming'))).toEqual(['Bins out']));
    expect(callsTo('PATCH /api/tasks/2')).toHaveLength(1);
  });
});

describe('notes', () => {
  const withNotes = (notes: string | null) => ({ ...milk, notes });
  const notesToggle = () => chip('Notes');
  const addNotesField = () => screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
  const editNotesField = (title: string) =>
    screen.getByRole('textbox', { name: `Notes for "${title}"` }) as HTMLTextAreaElement;
  // The notes shown in a row, found by their text inside the row.
  const rowNotes = (title: string) =>
    screen.getByRole('checkbox', { name: title }).closest('li')!.querySelector<HTMLElement>('[data-notes]');

  test('the Notes chip reveals a labelled notes field; Ctrl+Enter adds with notes', async () => {
    signedIn([]);
    reply(
      'POST /api/tasks',
      json({ task: { id: 7, title: 'Call the plumber', notes: 'Kitchen tap\n  and the shower', completed: false, dueDate: null, repeat: null } }, 201),
    );
    render(<App />);
    const title = await openAddSheet();
    const toggle = notesToggle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Notes: none');
    expect(screen.queryByRole('textbox', { name: 'Notes' })).toBeNull();

    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const notes = addNotesField();
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)!.contains(notes)).toBe(true);
    await userEvent.type(title, 'Call the plumber');
    // Enter in the notes field is a new line, not a submit.
    await userEvent.type(notes, '  Kitchen tap{Enter}  and the shower  ');
    expect(notes.value).toBe('  Kitchen tap\n  and the shower  ');
    expect(notesToggle().getAttribute('aria-label')).toBe('Notes: added');
    expect(callsTo('POST /api/tasks')).toHaveLength(0);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(taskTitles()).toEqual(['Call the plumber']));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Call the plumber', notes: 'Kitchen tap\n  and the shower' });
    // The sheet closed; focus is on the + button. The draft's notes are cleared.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add a task' }));
    await openAddSheet();
    expect(notesToggle().getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(notesToggle());
    expect(addNotesField().value).toBe('');
    expect(rowNotes('Call the plumber')!.textContent).toBe('Kitchen tap\n  and the shower');
  });

  test('Cmd+Enter also adds; empty notes are not sent; notes with text are sent with their field closed (D-4)', async () => {
    signedIn([]);
    reply(
      'POST /api/tasks',
      json({ task: { id: 7, title: 'First', notes: null, completed: false, dueDate: null, repeat: null } }, 201),
      json({ task: { id: 8, title: 'Second', notes: 'Hidden', completed: false, dueDate: null, repeat: null } }, 201),
      json({ task: { id: 9, title: 'Third', notes: null, completed: false, dueDate: null, repeat: null } }, 201),
    );
    render(<App />);
    let title = await openAddSheet();
    // Notes with nothing visible are no notes: only the title is sent.
    await userEvent.click(notesToggle());
    await userEvent.type(title, 'First');
    await userEvent.type(addNotesField(), ' {Enter}​ ');
    expect(notesToggle().getAttribute('aria-label')).toBe('Notes: added');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await waitFor(() => expect(callsTo('POST /api/tasks')).toHaveLength(1));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'First' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Notes typed and then hidden again are still the draft's notes: sent.
    title = await openAddSheet();
    await userEvent.click(notesToggle());
    await userEvent.type(addNotesField(), 'Hidden');
    await userEvent.click(notesToggle());
    expect(screen.queryByRole('textbox', { name: 'Notes' })).toBeNull();
    expect(notesToggle().getAttribute('aria-label')).toBe('Notes: added');
    await userEvent.type(title, 'Second{Enter}');
    await waitFor(() => expect(callsTo('POST /api/tasks')).toHaveLength(2));
    expect(callsTo('POST /api/tasks')[1].body).toEqual({ title: 'Second', notes: 'Hidden' });
    await waitFor(() => expect(taskTitles()).toEqual(['Second', 'First']));

    // Clearing the chip clears them, so nothing is sent.
    title = await openAddSheet();
    await userEvent.click(notesToggle());
    await userEvent.type(addNotesField(), 'Dropped');
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Clear notes' }));
    expect(addNotesField().value).toBe('');
    expect(notesToggle().getAttribute('aria-label')).toBe('Notes: none');
    expect(within(addSheet()).queryByRole('button', { name: 'Clear notes' })).toBeNull();
    await userEvent.type(title, 'Third{Enter}');
    await waitFor(() => expect(callsTo('POST /api/tasks')).toHaveLength(3));
    expect(callsTo('POST /api/tasks')[2].body).toEqual({ title: 'Third' });
  });

  test('R1-F1: notes typed and then hidden survive dismissing the sheet, and are shown again on reopening (D-3)', async () => {
    signedIn([]);
    reply(
      'POST /api/tasks',
      json({ task: { id: 7, title: 'Plain', notes: 'Keep me', completed: false, dueDate: null, repeat: null } }, 201),
    );
    render(<App />);
    let title = await openAddSheet();
    await userEvent.type(title, 'Plain');
    await userEvent.click(notesToggle());
    await userEvent.type(addNotesField(), 'Keep me');
    await userEvent.click(notesToggle());
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(callsTo('POST /api/tasks')).toHaveLength(0);
    title = await openAddSheet();
    expect(title.value).toBe('Plain');
    await userEvent.click(notesToggle());
    expect(addNotesField().value).toBe('Keep me');
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(taskTitles()).toEqual(['Plain']));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Plain', notes: 'Keep me' });
  });

  test('over-limit notes in the add form show an error on the field and send nothing', async () => {
    const emoji = '\u{1F600}';
    signedIn([]);
    reply(
      'POST /api/tasks',
      json({ task: { id: 7, title: 'Long', notes: emoji.repeat(5000), completed: false, dueDate: null, repeat: null } }, 201),
    );
    render(<App />);
    const title = await openAddSheet();
    await userEvent.type(title, 'Long');
    await userEvent.click(notesToggle());
    const notes = addNotesField();
    const cases: [string, string][] = [
      ['x'.repeat(5001), 'Notes can be at most 5000 characters.'],
      [emoji.repeat(5001), 'Notes can be at most 5000 characters.'],
      ['a\u0000b', 'Notes cannot contain a null character.'],
    ];
    for (const [value, message] of cases) {
      fireEvent.change(notes, { target: { value } });
      await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toBe(message);
      expect(notes.getAttribute('aria-invalid')).toBe('true');
      expect(notes.getAttribute('aria-describedby')).toBe(alert.id);
      expect(title.getAttribute('aria-invalid')).toBeNull();
      // Even with the notes closed, the error opens them again (AC-5).
      await userEvent.click(notesToggle());
      await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
      expect(notesToggle().getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('alert').textContent).toBe(message);
    }
    expect(callsTo('POST /api/tasks')).toHaveLength(0);
    // Typing clears the error; 5000 characters counted as code points is fine.
    fireEvent.change(notes, { target: { value: ` ${emoji.repeat(5000)} ` } });
    expect(notes.getAttribute('aria-invalid')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(callsTo('POST /api/tasks')).toHaveLength(1));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Long', notes: emoji.repeat(5000) });
  });

  test('a server notes error in the add form is shown on the notes field', async () => {
    signedIn([]);
    reply('POST /api/tasks', json({ error: 'invalid_notes', message: 'Notes must be text of at most 5000 characters, or null.' }, 400));
    render(<App />);
    await userEvent.type(await openAddSheet(), 'Milk');
    await userEvent.click(notesToggle());
    await userEvent.type(addNotesField(), 'Two litres');
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Notes must be text of at most 5000 characters, or null.');
    expect(addNotesField().getAttribute('aria-invalid')).toBe('true');
    expect(addNotesField().getAttribute('aria-describedby')).toBe(alert.id);
    expect(addNotesField().value).toBe('Two litres');
  });

  test('the edit row prefills notes after the repeat controls; Enter is a new line and Ctrl+Enter saves only the notes', async () => {
    signedIn([withNotes('Two litres')]);
    const save = pending();
    reply('PATCH /api/tasks/1', save.response);
    render(<App />);
    const title = await startEditing('Buy oat milk');
    const notes = editNotesField('Buy oat milk');
    expect(notes.value).toBe('Two litres');
    // After the date and repeat controls, before Save.
    const date = screen.getByLabelText('Due date for "Buy oat milk"');
    expect(date.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notes.compareDocumentPosition(button('Save')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(title.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.click(notes);
    await userEvent.keyboard('{Enter}of oat milk');
    expect(notes.value).toBe('Two litres\nof oat milk');
    expect(callsTo('PATCH /api/tasks/1')).toHaveLength(0);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    // Read-only while saving, like the other fields; Escape is ignored then.
    expect(notes.readOnly).toBe(true);
    expect(notes.disabled).toBe(false);
    await userEvent.keyboard('{Escape}');
    expect(callsTo('PATCH /api/tasks/1')).toHaveLength(1);
    expect(callsTo('PATCH /api/tasks/1')[0].body).toEqual({ notes: 'Two litres\nof oat milk' });
    save.finish(json({ task: withNotes('Two litres\nof oat milk') }));
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Buy oat milk"')));
    expect(rowNotes('Buy oat milk')!.textContent).toBe('Two litres\nof oat milk');
  });

  test('the edit row sends notes only when they changed, null when emptied, and Escape cancels', async () => {
    signedIn([withNotes('Two litres')]);
    reply('PATCH /api/tasks/1', json({ task: { ...withNotes('Two litres'), title: 'Buy soy milk' } }));
    reply('PATCH /api/tasks/1', json({ task: { ...withNotes(null), title: 'Buy soy milk' } }));
    render(<App />);

    // Only spacing at the ends changed: no change, no request.
    await startEditing('Buy oat milk');
    await userEvent.type(editNotesField('Buy oat milk'), '  {Enter} ');
    await userEvent.click(button('Save'));
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Buy oat milk"')));

    // Escape cancels a notes change without a request.
    await startEditing('Buy oat milk');
    await userEvent.type(editNotesField('Buy oat milk'), ' thrown away{Escape}');
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(rowNotes('Buy oat milk')!.textContent).toBe('Two litres');
    expect(document.activeElement).toBe(button('Edit "Buy oat milk"'));

    // A title change alone sends only the title.
    const field = await startEditing('Buy oat milk');
    expect(editNotesField('Buy oat milk').value).toBe('Two litres');
    await userEvent.clear(field);
    await userEvent.type(field, 'Buy soy milk{Enter}');
    await waitFor(() => expect(callsTo('PATCH /api/tasks/1')).toHaveLength(1));
    expect(callsTo('PATCH /api/tasks/1')[0].body).toEqual({ title: 'Buy soy milk' });

    // Emptied notes are sent as null.
    await waitFor(() => expect(button('Edit "Buy soy milk"')).toBeTruthy());
    await startEditing('Buy soy milk');
    await userEvent.clear(editNotesField('Buy soy milk'));
    await userEvent.click(button('Save'));
    await waitFor(() => expect(callsTo('PATCH /api/tasks/1')).toHaveLength(2));
    expect(callsTo('PATCH /api/tasks/1')[1].body).toEqual({ notes: null });
    await waitFor(() => expect(rowNotes('Buy soy milk')).toBeNull());
  });

  test('notes errors in the edit row stay on the notes field', async () => {
    signedIn([withNotes('Two litres')]);
    reply('PATCH /api/tasks/1', json({ error: 'invalid_notes', message: 'Notes cannot contain a null character.' }, 400));
    render(<App />);
    await startEditing('Buy oat milk');
    const notes = editNotesField('Buy oat milk');

    // Over the limit: refused before any request.
    fireEvent.change(notes, { target: { value: 'x'.repeat(5001) } });
    await userEvent.click(button('Save'));
    let alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Notes can be at most 5000 characters.');
    expect(notes.getAttribute('aria-invalid')).toBe('true');
    expect(notes.getAttribute('aria-describedby')).toBe(alert.id);
    expect(editField('Buy oat milk').getAttribute('aria-invalid')).toBeNull();
    expect(callsTo('PATCH /api/tasks/1')).toHaveLength(0);

    // The server's notes error is shown on the notes field, with the typed text kept.
    fireEvent.change(notes, { target: { value: 'Three litres' } });
    expect(notes.getAttribute('aria-invalid')).toBeNull();
    await userEvent.click(button('Save'));
    alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Notes cannot contain a null character.');
    expect(notes.getAttribute('aria-invalid')).toBe('true');
    expect(notes.getAttribute('aria-describedby')).toBe(alert.id);
    expect(notes.value).toBe('Three litres');
  });

  test('notes show as plain text with their line breaks, muted when completed, outside the checkbox description', async () => {
    const markup = '<b>bold</b> and **stars**\nhttps://example.test/page\n\n  indented';
    signedIn([
      { ...milk, notes: markup, dueDate: '2026-11-20' },
      { ...plants, notes: 'Done notes' },
      tea,
    ]);
    render(<App />);
    const notes = await waitFor(() => rowNotes('Buy oat milk')!);
    expect(notes.textContent).toBe(markup);
    expect(notes.querySelector('b, a, strong')).toBeNull();
    expect(within(taskList()).queryByRole('link')).toBeNull();
    expect(notes.className).toContain('whitespace-pre-wrap');
    expect(notes.className).toContain('max-h-40');
    expect(notes.className).toContain('overflow-y-auto');
    expect(notes.className).not.toContain('text-muted-foreground');
    // Short notes add no Tab stop and no region (jsdom lays nothing out, so nothing overflows).
    expect(notes.getAttribute('tabindex')).toBeNull();
    expect(notes.getAttribute('role')).toBeNull();
    // The checkbox is still described by the due date line only.
    const checkbox = screen.getByRole('checkbox', { name: 'Buy oat milk' });
    expect(document.getElementById(checkbox.getAttribute('aria-describedby')!)!.textContent).not.toContain('bold');
    // A task without notes shows none.
    expect(rowNotes('Order tea')).toBeNull();
    await expandCompleted();
    expect(rowNotes('Water the plants')!.className).toContain('text-muted-foreground');
  });

  test('notes taller than the cap become a focusable region named after the task', async () => {
    // jsdom has no layout: long notes report a scroll height over their box.
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-notes') && (this.textContent ?? '').length > 100 ? 600 : 0;
    });
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-notes') && (this.textContent ?? '').length > 100 ? 160 : 0;
    });
    onTestFinished(() => {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    });
    signedIn([withNotes('line\n'.repeat(40)), { ...tea, notes: 'Short' }]);
    render(<App />);
    const region = await screen.findByRole('region', { name: 'Notes for "Buy oat milk"' });
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region).toBe(rowNotes('Buy oat milk'));
    expect(rowNotes('Order tea')!.getAttribute('tabindex')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Notes for "Order tea"' })).toBeNull();
  });

  test('overflowing notes show a bottom fade cue until scrolled to the end', async () => {
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-notes') && (this.textContent ?? '').length > 100 ? 600 : 0;
    });
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-notes') && (this.textContent ?? '').length > 100 ? 160 : 0;
    });
    onTestFinished(() => {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    });
    signedIn([withNotes('line\n'.repeat(40)), { ...tea, notes: 'Short' }]);
    render(<App />);
    const region = await screen.findByRole('region', { name: 'Notes for "Buy oat milk"' });
    // Overflowing and at the top: more text below.
    expect(region.hasAttribute('data-notes-more')).toBe(true);
    // Short notes never show the cue.
    expect(rowNotes('Order tea')!.hasAttribute('data-notes-more')).toBe(false);
    // Part way down: still more below.
    region.scrollTop = 200;
    fireEvent.scroll(region);
    expect(region.hasAttribute('data-notes-more')).toBe(true);
    // At the end (within a pixel or two): the cue is gone.
    region.scrollTop = 439;
    fireEvent.scroll(region);
    expect(region.hasAttribute('data-notes-more')).toBe(false);
    // Back up: the cue returns.
    region.scrollTop = 0;
    fireEvent.scroll(region);
    expect(region.hasAttribute('data-notes-more')).toBe(true);
  });
});

// Task lists. The criteria named below are those of the lists task.
describe('lists', () => {
  const list = (id: number, name: string) => ({
    id,
    name,
    createdAt: '2026-11-20T12:00:00.000Z',
    updatedAt: '2026-11-20T12:00:00.000Z',
  });
  const errands = list(10, 'Errands');
  const home = list(11, 'Home');
  const inList = (id: number, title: string, listId: number | null, completed = false) => ({
    ...milk,
    id,
    title,
    listId,
    completed,
  });
  const stamps = inList(4, 'Buy stamps', 10);
  const post = inList(5, 'Post the letter', 10, true);
  const withLists = (...lists: unknown[]) => reply('GET /api/lists', json({ lists }));
  const status = () => screen.getByRole('status').textContent;
  const listField = (title: string) => screen.getByRole('combobox', { name: `List for "${title}"` }) as HTMLSelectElement;
  // The muted list label of a row, if it has one.
  const rowLabel = (title: string) =>
    screen.getByRole('checkbox', { name: title }).closest('li')!.querySelector('[data-list-label]')?.textContent ?? null;

  test('the view picker lists All tasks, Inbox, Assigned to me and the lists in creation order; arrows, Home and End move, Enter chooses (AC-2; assigned-to-me AC-1)', async () => {
    signedIn([milk, stamps]);
    withLists(errands, home);
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Errands', 'Home']));
    expect(selectedTab()).toEqual(['All tasks']);
    // The view's name is the page title and the button that opens the menu.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('All tasks');
    expect(screen.getByRole('heading', { level: 1 }).contains(viewTitle())).toBe(true);
    expect(viewTitle().textContent).toBe('All tasks');
    expect(viewTitle().getAttribute('aria-haspopup')).toBe('menu');
    expect(viewTitle().getAttribute('aria-expanded')).toBe('false');
    expect(viewTitle().getAttribute('aria-controls')).toBe(viewMenu().id);
    expect(screen.queryByRole('menu', { name: 'Views and lists' })).toBeNull();

    // Opening it focuses the checked item; New list and Manage lists come after the views.
    await userEvent.click(viewTitle());
    const menu = screen.getByRole('menu', { name: 'Views and lists' });
    expect(viewTitle().getAttribute('aria-expanded')).toBe('true');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['New list', 'Manage lists']);
    expect(document.activeElement).toBe(tab('All tasks'));
    // Arrow keys move focus only; nothing is chosen yet.
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(tab('Inbox'));
    expect(selectedTab()).toEqual(['All tasks']);
    expect(location.search).toBe('');
    // Enter chooses: the menu closes, focus is back on the title, the URL follows.
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('menu', { name: 'Views and lists' })).toBeNull();
    expect(document.activeElement).toBe(viewTitle());
    expect(viewTitle().textContent).toBe('Inbox');
    expect(selectedTab()).toEqual(['Inbox']);
    expect(location.search).toBe('?list=inbox');
    expect(taskTitles()).toEqual(['Buy oat milk']);

    // From the title, the down arrow opens the menu at the checked item.
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(tab('Inbox'));
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(tab('All tasks'));
    // Past the first item: the last one, Manage lists.
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Manage lists' }));
    // Past the last item: back to the first.
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(tab('All tasks'));
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Manage lists' }));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(tab('All tasks'));
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(tab('Assigned to me'));
    // Escape closes without choosing and returns focus to the title.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Views and lists' })).toBeNull();
    expect(document.activeElement).toBe(viewTitle());
    expect(selectedTab()).toEqual(['Inbox']);

    // Enter on the title opens it too; Space chooses like Enter.
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(tab('Inbox'));
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard(' ');
    expect(selectedTab()).toEqual(['Assigned to me']);
    expect(location.search).toBe('?list=assigned');
    expect(document.activeElement).toBe(viewTitle());

    // A click chooses a list.
    await pick('Errands');
    expect(selectedTab()).toEqual(['Errands']);
    expect(viewTitle().textContent).toBe('Errands');
    expect(location.search).toBe('?list=10');
    expect(taskTitles()).toEqual(['Buy stamps']);

    // A click outside closes it and hands focus back to the title.
    await userEvent.click(viewTitle());
    expect(screen.getByRole('menu', { name: 'Views and lists' })).toBeTruthy();
    await userEvent.click(document.body);
    expect(screen.queryByRole('menu', { name: 'Views and lists' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(viewTitle()));
    // Tab closes it and moves on, as if it had not been open.
    await userEvent.click(viewTitle());
    await userEvent.tab();
    expect(screen.queryByRole('menu', { name: 'Views and lists' })).toBeNull();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('the view comes from the URL; none, unknown or deleted lists show All tasks (AC-8, D-5)', async () => {
    for (const [search, expected] of [
      ['?list=10', 'Errands'],
      ['?list=inbox', 'Inbox'],
      ['?list=assigned', 'Assigned to me'],
      ['?list=all', 'All tasks'],
      ['', 'All tasks'],
      ['?list=99', 'All tasks'],
      ['?list=0', 'All tasks'],
      ['?list=Errands', 'All tasks'],
      ['?error=sign-in&list=11', 'Home'],
    ]) {
      history.replaceState(null, '', `/${search}`);
      signedIn([milk, stamps]);
      withLists(errands, home);
      render(<App />);
      await ready();
      await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Errands', 'Home']));
      expect(selectedTab(), search).toEqual([expected]);
      cleanup();
    }
  });

  test('each view shows its tasks with the usual groups; All tasks labels named lists (AC-9, D-6)', async () => {
    const dueStamps = { ...stamps, dueDate: '2026-11-19' };
    signedIn([milk, dueStamps, post, inList(6, 'Fix the shelf', 11), plants]);
    withLists(errands, home, list(12, 'Work'));
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Work'));

    // All tasks: every task, in the usual groups; rows in a named list show it.
    expect(taskTitles()).toEqual(['Buy stamps', 'Buy oat milk', 'Fix the shelf']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((item) => item.textContent!.replace('▸', ''))).toEqual([
      'Overdue',
      'No date',
    ]);
    expect(button('Show 2 done')).toBeTruthy();
    expect(rowLabel('Buy stamps')).toBe('List: Errands');
    expect(rowLabel('Fix the shelf')).toBe('List: Home');
    expect(rowLabel('Buy oat milk')).toBeNull();
    const label = screen.getByRole('checkbox', { name: 'Buy stamps' }).closest('li')!.querySelector('[data-list-label]')!;
    expect(label.className).toContain('text-muted-foreground');
    // After the due date line, and not part of the checkbox description.
    const dueLine = document.getElementById(screen.getByRole('checkbox', { name: 'Buy stamps' }).getAttribute('aria-describedby')!)!;
    expect(dueLine.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dueLine.contains(label)).toBe(false);
    await expandCompleted();
    expect(taskTitles()).toEqual(['Buy stamps', 'Buy oat milk', 'Fix the shelf', 'Post the letter', 'Water the plants']);
    expect(rowLabel('Post the letter')).toBe('List: Errands');

    // A named list: only its tasks, open and completed, without labels. The
    // Completed section stays expanded across views.
    await pick('Errands');
    expect(button('Hide done').getAttribute('aria-expanded')).toBe('true');
    expect(taskTitles()).toEqual(['Buy stamps', 'Post the letter']);
    expect(rowLabel('Buy stamps')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 }).map((item) => item.textContent!.replace('▸', ''))).toEqual([
      'Overdue',
    ]);

    // Inbox: only tasks without a list.
    await pick('Inbox');
    expect(taskTitles()).toEqual(['Buy oat milk', 'Water the plants']);
    expect(rowLabel('Buy oat milk')).toBeNull();

    // Each view has its own empty state.
    await pick('Work');
    expect(screen.getByText('No tasks in Work yet.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  test('empty states name the view; with no tasks at all All tasks keeps its message (AC-9)', async () => {
    signedIn([stamps]);
    withLists(errands);
    render(<App />);
    await ready();
    await pick('Inbox');
    expect(screen.getByText('No tasks in Inbox yet.')).toBeTruthy();
    cleanup();

    history.replaceState(null, '', '/');
    signedIn([]);
    render(<App />);
    expect(await screen.findByText('No tasks yet. Add your first one with the + button.')).toBeTruthy();
  });

  test('a task added in a named list is created there; All tasks and Inbox send no listId (AC-10)', async () => {
    signedIn([milk]);
    withLists(errands);
    reply('POST /api/tasks', json({ task: inList(7, 'Buy envelopes', 10) }, 201));
    reply('POST /api/tasks', json({ task: inList(8, 'Call the plumber', null) }, 201));
    reply('POST /api/tasks', json({ task: inList(9, 'Order tea', null) }, 201));
    render(<App />);
    await ready();

    // All tasks: the add goes to Inbox and its List chip says so.
    expect(await addDestination()).toBe('Inbox');
    await pick('Errands');
    expect(await addDestination()).toBe('Errands');
    await userEvent.type(await openAddSheet(), 'Buy envelopes{Enter}');
    await waitFor(() => expect(taskTitles()).toEqual(['Buy envelopes']));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Buy envelopes', listId: 10 });
    expect(document.activeElement).toBe(button('Add a task'));

    await pick('All tasks');
    await userEvent.type(await openAddSheet(), 'Call the plumber{Enter}');
    await waitFor(() => expect(taskTitles()).toEqual(['Call the plumber', 'Buy envelopes', 'Buy oat milk']));
    expect(callsTo('POST /api/tasks')[1].body).toEqual({ title: 'Call the plumber' });

    await pick('Inbox');
    expect(await addDestination()).toBe('Inbox');
    await userEvent.type(await openAddSheet(), 'Order tea{Enter}');
    await waitFor(() => expect(taskTitles()).toEqual(['Order tea', 'Call the plumber', 'Buy oat milk']));
    expect(callsTo('POST /api/tasks')[2].body).toEqual({ title: 'Order tea' });
  });

  test('"New list" creates a list with Enter, adds it to the picker and shows it; Escape and Cancel send nothing (AC-11)', async () => {
    signedIn([milk]);
    reply('POST /api/lists', json({ list: errands }, 201));
    render(<App />);
    await ready();
    // Without lists there is nothing to manage.
    expect(manageItem()).toBeNull();
    expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me']);

    // Escape closes the field without a request, and focus returns to the view title.
    await pick('New list');
    const field = screen.getByRole('textbox', { name: 'List name' }) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    await userEvent.type(field, 'Thrown away{Escape}');
    expect(screen.queryByRole('textbox', { name: 'List name' })).toBeNull();
    expect(document.activeElement).toBe(viewTitle());
    // So does Cancel; the field starts empty again.
    await pick('New list');
    expect((screen.getByRole('textbox', { name: 'List name' }) as HTMLInputElement).value).toBe('');
    await userEvent.click(button('Cancel new list'));
    expect(screen.queryByRole('textbox', { name: 'List name' })).toBeNull();
    expect(callsTo('POST /api/lists')).toHaveLength(0);

    await pick('New list');
    await userEvent.type(screen.getByRole('textbox', { name: 'List name' }), '  Errands {Enter}');
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Errands']));
    expect(callsTo('POST /api/lists')[0].body).toEqual({ name: 'Errands' });
    expect(selectedTab()).toEqual(['Errands']);
    expect(document.activeElement).toBe(viewTitle());
    expect(location.search).toBe('?list=10');
    expect(screen.queryByRole('textbox', { name: 'List name' })).toBeNull();
    expect(screen.getByText('No tasks in Errands yet.')).toBeTruthy();
    expect(manageItem()).toBeTruthy();
  });

  test('the new list field checks names like the server and shows server errors on the field (AC-11)', async () => {
    signedIn([milk]);
    withLists(errands);
    reply('POST /api/lists', json({ error: 'duplicate_list_name', message: 'You already have a list with that name.' }, 409));
    reply('POST /api/lists', json({ error: 'list_limit_reached', message: 'You can have at most 50 lists. Delete one to make room.' }, 409));
    reply('POST /api/lists', json({ error: 'invalid_list_name', message: 'List names cannot contain a null character.' }, 400));
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Errands'));
    await pick('New list');
    const field = screen.getByRole('textbox', { name: 'List name' }) as HTMLInputElement;
    const emoji = '\u{1F600}';
    const expectError = (message: string) => {
      expect(screen.getByRole('alert').textContent).toBe(message);
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(field.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    };
    for (const [typed, message] of [
      ['', 'Enter a list name.'],
      ['   ', 'Enter a list name.'],
      ['​', 'Enter a list name.'],
      ['x'.repeat(51), 'List names can be at most 50 characters.'],
      [emoji.repeat(51), 'List names can be at most 50 characters.'],
      ['inbox', '"Inbox", "All tasks" and "Assigned to me" are built in. Choose another name.'],
      [' ALL TASKS ', '"Inbox", "All tasks" and "Assigned to me" are built in. Choose another name.'],
      ['Assigned to ME', '"Inbox", "All tasks" and "Assigned to me" are built in. Choose another name.'],
      ['eRRANDS', 'You already have a list with that name.'],
    ]) {
      fireEvent.change(field, { target: { value: typed } });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(field.hasAttribute('aria-invalid')).toBe(false);
      await userEvent.click(button('Create list'));
      expectError(message);
    }
    expect(callsTo('POST /api/lists')).toHaveLength(0);
    // 50 emoji are 50 characters, so the server decides; here, it refuses.
    fireEvent.change(field, { target: { value: emoji.repeat(50) } });
    await userEvent.click(button('Create list'));
    await waitFor(() => expectError('You already have a list with that name.'));
    fireEvent.change(field, { target: { value: 'Shopping' } });
    await userEvent.type(field, '{Enter}');
    await waitFor(() => expectError('You can have at most 50 lists. Delete one to make room.'));
    fireEvent.change(field, { target: { value: 'Groceries' } });
    await userEvent.type(field, '{Enter}');
    await waitFor(() => expectError('List names cannot contain a null character.'));
    expect(callsTo('POST /api/lists').map((call) => call.body)).toEqual([
      { name: emoji.repeat(50) },
      { name: 'Shopping' },
      { name: 'Groceries' },
    ]);
    // Nothing was added, and the field keeps the typed name.
    expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Errands']);
    expect(field.value).toBe('Groceries');
  });

  test('the new list field refuses names that only look like a built-in view, as the server does (AC-11, D-3)', async () => {
    signedIn([milk]);
    reply('POST /api/lists', json({ list: list(11, 'Inbox zero') }, 201));
    render(<App />);
    await ready();
    await pick('New list');
    const field = screen.getByRole('textbox', { name: 'List name' }) as HTMLInputElement;
    // Letter case, invisible code points, and the white space between the words.
    for (const typed of [
      'Inbox\u200b',
      'In\u00adbox',
      '\u200eINBOX\u200f',
      'Inbox\u3164',
      'In\u0001box',
      'All\u00a0tasks',
      'all  TASKS',
      'All\u3000tasks',
      'All \u200b tasks',
      'Assigned\u00a0to me',
      'assigned  TO\u200b me',
      '\uff21ssigned to me',
    ]) {
      fireEvent.change(field, { target: { value: typed } });
      await userEvent.click(button('Create list'));
      expect(screen.getByRole('alert').textContent).toBe('"Inbox", "All tasks" and "Assigned to me" are built in. Choose another name.');
      expect(field.getAttribute('aria-invalid')).toBe('true');
    }
    expect(callsTo('POST /api/lists')).toHaveLength(0);
    // A name that only contains the word is a normal name.
    fireEvent.change(field, { target: { value: 'Inbox zero' } });
    await userEvent.click(button('Create list'));
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Inbox zero']));
    expect(callsTo('POST /api/lists').map((call) => call.body)).toEqual([{ name: 'Inbox zero' }]);
  });

  // The lists cleanup: names compare by their fold (foldListName in
  // packages/web/src/lists.ts), the same as the server.
  test('the new list field compares names by their fold, as the server does (cleanup AC-1, AC-2, AC-3)', async () => {
    signedIn([milk]);
    withLists(list(11, 'Home'), list(12, 'Weekly shop'), list(13, '\u0130stanbul'));
    reply('POST /api/lists', json({ error: 'duplicate_list_name', message: 'You already have a list with that name.' }, 409));
    reply('POST /api/lists', json({ list: list(14, '\u0406nbox') }, 201));
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Weekly shop'));
    await pick('New list');
    const field = screen.getByRole('textbox', { name: 'List name' }) as HTMLInputElement;
    const expectError = (message: string) => {
      expect(screen.getByRole('alert').textContent).toBe(message);
      expect(field.getAttribute('aria-invalid')).toBe('true');
    };
    const reserved = '"Inbox", "All tasks" and "Assigned to me" are built in. Choose another name.';
    const duplicate = 'You already have a list with that name.';
    for (const [typed, message] of [
      ['\uff29\uff4e\uff42\uff4f\uff58', reserved], // fullwidth "Inbox"
      ['\uff21\uff4c\uff4c\u3000\uff54\uff41\uff53\uff4b\uff53', reserved], // fullwidth "All tasks"
      ['\u{1d408}\u{1d427}\u{1d41b}\u{1d428}\u{1d431}', reserved], // mathematical bold "Inbox"
      ['In\uff42ox', reserved],
      ['\uff28\uff4f\uff4d\uff45', duplicate], // fullwidth "Home"
      ['Home\u200b', duplicate],
      ['Weekly  shop', duplicate],
      ['weekly\u3000SHOP', duplicate],
      // "Istanbul" with a dotted capital I (U+0130) folds to an i followed by
      // U+0307 on both sides, so this is a duplicate.
      ['i\u0307stanbul', duplicate],
    ]) {
      fireEvent.change(field, { target: { value: typed } });
      await userEvent.click(button('Create list'));
      expectError(message);
    }
    expect(callsTo('POST /api/lists')).toHaveLength(0);
    // "istanbul" has another fold, so the form sends it; where the server's
    // database still refuses it, its 409 shows on the field.
    fireEvent.change(field, { target: { value: 'istanbul' } });
    await userEvent.click(button('Create list'));
    await waitFor(() => expectError(duplicate));
    expect(field.value).toBe('istanbul');
    // A Cyrillic letter that only looks Latin is a normal name (D-3).
    fireEvent.change(field, { target: { value: '\u0406nbox' } });
    await userEvent.click(button('Create list'));
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Home', 'Weekly shop', '\u0130stanbul', '\u0406nbox']));
    expect(callsTo('POST /api/lists').map((call) => call.body)).toEqual([{ name: 'istanbul' }, { name: '\u0406nbox' }]);
  });

  test('a rename may keep the list\'s own fold, even one another list shares (cleanup AC-2, AC-5)', async () => {
    signedIn([milk]);
    // Two lists stored before the fold check, with one fold.
    withLists(list(11, 'Home'), list(12, '\uff28\uff4f\uff4d\uff45'), list(13, 'Work'));
    reply('PATCH /api/lists/12', json({ list: list(12, '\uff28\uff2f\uff2d\uff25') }));
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Work'));
    await openManage();
    await userEvent.click(button('Rename "\uff28\uff4f\uff4d\uff45"'));
    const field = screen.getByRole('textbox', { name: 'New name for "\uff28\uff4f\uff4d\uff45"' }) as HTMLInputElement;
    // Another list's fold, or a built-in view's, is refused.
    for (const [typed, message] of [
      ['WORK\u200b', 'You already have a list with that name.'],
      ['\uff29\uff4e\uff42\uff4f\uff58', '"Inbox", "All tasks" and "Assigned to me" are built in. Choose another name.'],
    ]) {
      fireEvent.change(field, { target: { value: typed } });
      await userEvent.type(field, '{Enter}');
      expect(screen.getByRole('alert').textContent).toBe(message);
    }
    expect(callsTo('PATCH /api/lists/12')).toHaveLength(0);
    // Its own fold in another form is sent.
    fireEvent.change(field, { target: { value: '\uff28\uff2f\uff2d\uff25' } });
    await userEvent.type(field, '{Enter}');
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Home', '\uff28\uff2f\uff2d\uff25', 'Work']));
    expect(callsTo('PATCH /api/lists/12').map((call) => call.body)).toEqual([{ name: '\uff28\uff2f\uff2d\uff25' }]);
  });

  test('an unchanged rename closes without a request, even for an older list the checks now refuse (cleanup R1-F1, AC-5)', async () => {
    signedIn([milk]);
    // Stored before the fold check: a fullwidth "Inbox", and a fullwidth
    // "Home" next to "Home".
    const fullInbox = '\uff29\uff4e\uff42\uff4f\uff58';
    const fullHome = '\uff28\uff4f\uff4d\uff45';
    withLists(list(11, fullInbox), list(12, 'Home'), list(13, fullHome));
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain(fullHome));
    await openManage();
    const nameField = (name: string) => screen.queryByRole('textbox', { name: `New name for "${name}"` }) as HTMLInputElement | null;
    for (const name of [fullInbox, fullHome]) {
      // Enter on the name as it is.
      await userEvent.click(button(`Rename "${name}"`));
      await userEvent.type(nameField(name)!, '{Enter}');
      expect(nameField(name)).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(document.activeElement).toBe(button(`Rename "${name}"`));
      // Save with only surrounding white space added.
      await userEvent.click(button(`Rename "${name}"`));
      fireEvent.change(nameField(name)!, { target: { value: ` ${name} ` } });
      await userEvent.click(button(`Save the new name for "${name}"`));
      expect(nameField(name)).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(document.activeElement).toBe(button(`Rename "${name}"`));
    }
    // A changed name is still checked.
    await userEvent.click(button(`Rename "${fullInbox}"`));
    const field = nameField(fullInbox)!;
    for (const [typed, message] of [
      ['INBOX', '"Inbox", "All tasks" and "Assigned to me" are built in. Choose another name.'],
      ['home', 'You already have a list with that name.'],
    ]) {
      fireEvent.change(field, { target: { value: typed } });
      await userEvent.type(field, '{Enter}');
      expect(screen.getByRole('alert').textContent).toBe(message);
    }
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('names that differ only by invisible code points share a fold, also between a letter and its mark (cleanup R1-F2)', async () => {
    signedIn([milk]);
    withLists(list(11, 'Caf\u00e9'), list(12, '\u00cdnbox'));
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('\u00cdnbox'));
    await pick('New list');
    const field = screen.getByRole('textbox', { name: 'List name' }) as HTMLInputElement;
    for (const [typed, message] of [
      ['Cafe\u00ad\u0301', 'You already have a list with that name.'], // soft hyphen between the e and a combining acute
      ['Cafe\u200b\u0301', 'You already have a list with that name.'], // zero width space
      ['CAFE\u2060\u0301', 'You already have a list with that name.'], // word joiner
      ['I\u00ad\u0301nbox', 'You already have a list with that name.'], // the fold of "\u00cdnbox", not a built-in name
      ['In\u00ad\u200bbox', '"Inbox", "All tasks" and "Assigned to me" are built in. Choose another name.'],
    ]) {
      fireEvent.change(field, { target: { value: typed } });
      await userEvent.click(button('Create list'));
      expect(screen.getByRole('alert').textContent).toBe(message);
    }
    expect(callsTo('POST /api/lists')).toHaveLength(0);
  });

  test('the new list field is read-only while it is saved and ignores repeat submits (AC-11)', async () => {
    signedIn([milk]);
    const created = pending();
    reply('POST /api/lists', created.response);
    render(<App />);
    await ready();
    await pick('New list');
    const field = screen.getByRole('textbox', { name: 'List name' }) as HTMLInputElement;
    await userEvent.type(field, 'Errands{Enter}');
    expect(field.readOnly).toBe(true);
    expect(button('Creating...').getAttribute('aria-disabled')).toBe('true');
    await userEvent.keyboard('{Enter}{Escape}');
    expect(callsTo('POST /api/lists')).toHaveLength(1);
    created.finish(json({ list: errands }, 201));
    await waitFor(() => expect(selectedTab()).toEqual(['Errands']));
  });

  test('Manage lists renames a list; the tab and the labels change at once (AC-12)', async () => {
    signedIn([milk, stamps]);
    withLists(errands, home);
    const renamed = pending();
    reply('PATCH /api/lists/10', json({ error: 'duplicate_list_name', message: 'You already have a list with that name.' }, 409));
    reply('PATCH /api/lists/10', renamed.response);
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Errands'));
    await openManage();
    const manage = screen.getByRole('list', { name: 'Your lists' });
    expect(within(manage).getAllByRole('listitem').map((item) => item.querySelector('[data-list-name]')?.textContent)).toEqual([
      'Errands',
      'Home',
    ]);

    // Escape cancels without a request and returns focus to Rename.
    await userEvent.click(button('Rename "Errands"'));
    const field = screen.getByRole('textbox', { name: 'New name for "Errands"' }) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('Errands');
    await userEvent.type(field, ' and more{Escape}');
    expect(screen.queryByRole('textbox', { name: 'New name for "Errands"' })).toBeNull();
    expect(document.activeElement).toBe(button('Rename "Errands"'));
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);

    // Client checks, as for a new list; the list's own name in other case is fine.
    await userEvent.click(button('Rename "Errands"'));
    const again = screen.getByRole('textbox', { name: 'New name for "Errands"' }) as HTMLInputElement;
    await userEvent.clear(again);
    await userEvent.type(again, 'home{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('You already have a list with that name.');
    expect(again.getAttribute('aria-invalid')).toBe('true');
    expect(again.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    expect(callsTo('PATCH /api/lists/10')).toHaveLength(0);

    // A server error shows on the field.
    await userEvent.clear(again);
    await userEvent.type(again, 'Shopping{Enter}');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('You already have a list with that name.'));
    expect(again.value).toBe('Shopping');

    // Saved: read-only while pending, then the tab and the labels follow.
    await userEvent.type(again, '{Enter}');
    expect(again.readOnly).toBe(true);
    expect(callsTo('PATCH /api/lists/10')[1].body).toEqual({ name: 'Shopping' });
    renamed.finish(json({ list: { ...errands, name: 'Shopping' } }));
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Shopping', 'Home']));
    expect(rowLabel('Buy stamps')).toBe('List: Shopping');
    expect(document.activeElement).toBe(button('Rename "Shopping"'));
  });

  test('deleting a list asks with the task count, then its tasks show in Inbox (AC-12)', async () => {
    history.replaceState(null, '', '/?list=10');
    signedIn([milk, stamps, post, inList(6, 'Fix the shelf', 11)]);
    withLists(errands, home, list(12, 'Work'));
    reply('DELETE /api/lists/10', json({ movedTaskIds: [4, 5] }));
    reply('DELETE /api/lists/12', json({ movedTaskIds: [] }));
    render(<App />);
    await ready();
    await waitFor(() => expect(selectedTab()).toEqual(['Errands']));
    await openManage();

    // The question names the list and counts its tasks, open and completed.
    await userEvent.click(button('Delete list "Errands"'));
    expect(screen.getByRole('group', { name: 'Delete list "Errands"?' }).textContent).toContain(
      'Delete Errands? Its 2 tasks will move to Inbox.',
    );
    expect(document.activeElement).toBe(button('Cancel deleting list "Errands"'));
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(button('Delete list "Errands"'));
    await userEvent.click(button('Delete list "Home"'));
    expect(screen.getByRole('group', { name: 'Delete list "Home"?' }).textContent).toContain(
      'Delete Home? Its 1 task will move to Inbox.',
    );
    await userEvent.click(button('Cancel deleting list "Home"'));
    await userEvent.click(button('Delete list "Work"'));
    expect(screen.getByRole('group', { name: 'Delete list "Work"?' }).textContent).toContain('Delete Work? It has no tasks.');
    await userEvent.click(button('Confirm deleting list "Work"'));
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Errands', 'Home']));
    // Focus goes to the list before it when it was the last one.
    expect(document.activeElement).toBe(button('Rename "Home"'));
    expect(selectedTab()).toEqual(['Errands']);
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([
      { method: 'DELETE', path: '/api/lists/12', body: undefined },
    ]);

    // Deleting the selected list moves the view to Inbox, with its tasks.
    await userEvent.click(button('Delete list "Errands"'));
    await userEvent.click(button('Confirm deleting list "Errands"'));
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Home']));
    expect(selectedTab()).toEqual(['Inbox']);
    expect(location.search).toBe('?list=inbox');
    expect(document.activeElement).toBe(button('Rename "Home"'));
    await userEvent.click(button('Close Manage lists'));
    await expandCompleted();
    expect(taskTitles()).toEqual(['Buy oat milk', 'Buy stamps', 'Post the letter']);
    await pick('All tasks');
    expect(rowLabel('Buy stamps')).toBeNull();
    expect(rowLabel('Fix the shelf')).toBe('List: Home');
  });

  test('after the last list is deleted, Manage lists goes away and focus moves to the view title (AC-12)', async () => {
    signedIn([milk]);
    withLists(errands);
    reply('DELETE /api/lists/10', json({ movedTaskIds: [] }));
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Errands'));
    await openManage();
    await userEvent.click(button('Delete list "Errands"'));
    await userEvent.click(button('Confirm deleting list "Errands"'));
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me']));
    expect(manageItem()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Manage lists' })).toBeNull();
    expect(document.activeElement).toBe(viewTitle());
  });

  test('the edit row has a List select after the date and repeat; only a changed list is sent (AC-13, D-7)', async () => {
    signedIn([milk, stamps]);
    withLists(errands, home);
    reply('PATCH /api/tasks/1', json({ task: { ...milk, title: 'Buy soy milk' } }));
    reply('PATCH /api/tasks/1', json({ task: { ...milk, title: 'Buy soy milk', listId: 11 } }));
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Home'));
    const title = await startEditing('Buy oat milk');
    const select = listField('Buy oat milk');
    expect([...select.options].map((option) => option.textContent)).toEqual(['Inbox', 'Errands', 'Home']);
    expect(select.value).toBe('');
    expect(select.selectedOptions[0].textContent).toBe('Inbox');
    // Title to date is still one Tab; the select comes after the repeat
    // controls and before the notes.
    expect(document.activeElement).toBe(title);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Due date for "Buy oat milk"'));
    const repeat = screen.getByRole('combobox', { name: 'Repeats for "Buy oat milk"' });
    expect(repeat.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const notes = screen.getByRole('textbox', { name: 'Notes for "Buy oat milk"' });
    expect(select.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // A title change alone sends only the title.
    await userEvent.clear(title);
    await userEvent.type(title, 'Buy soy milk{Enter}');
    await waitFor(() => expect(callsTo('PATCH /api/tasks/1')).toHaveLength(1));
    expect(callsTo('PATCH /api/tasks/1')[0].body).toEqual({ title: 'Buy soy milk' });

    // All tasks keeps a moved task in view, with its new label.
    await startEditing('Buy soy milk');
    await userEvent.selectOptions(listField('Buy soy milk'), 'Home');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(callsTo('PATCH /api/tasks/1')).toHaveLength(2));
    expect(callsTo('PATCH /api/tasks/1')[1].body).toEqual({ listId: 11 });
    await waitFor(() => expect(rowLabel('Buy soy milk')).toBe('List: Home'));
    expect(document.activeElement).toBe(button('Edit "Buy soy milk"'));

    // An unchanged list (picked away and back) is no change at all.
    await startEditing('Buy stamps');
    expect(listField('Buy stamps').value).toBe('10');
    await userEvent.selectOptions(listField('Buy stamps'), 'Inbox');
    await userEvent.selectOptions(listField('Buy stamps'), 'Errands');
    await userEvent.click(button('Save'));
    expect(callsTo('PATCH /api/tasks/4')).toHaveLength(0);
  });

  test('a task moved out of the selected view leaves it with a notice; focus moves on (AC-13)', async () => {
    history.replaceState(null, '', '/?list=inbox');
    signedIn([tea, milk, stamps]);
    withLists(errands);
    reply('PATCH /api/tasks/3', json({ task: { ...tea, listId: 10 } }));
    reply('PATCH /api/tasks/1', json({ task: { ...milk, listId: 10 } }));
    reply('PATCH /api/tasks/4', json({ task: { ...stamps, listId: null } }));
    render(<App />);
    await ready();
    await waitFor(() => expect(selectedTab()).toEqual(['Inbox']));
    expect(taskTitles()).toEqual(['Order tea', 'Buy oat milk']);

    await startEditing('Order tea');
    await userEvent.selectOptions(listField('Order tea'), 'Errands');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(taskTitles()).toEqual(['Buy oat milk']));
    expect(callsTo('PATCH /api/tasks/3')[0].body).toEqual({ listId: 10 });
    expect(status()).toBe('Moved "Order tea" to Errands.');
    // As after a delete: the next row, else the previous, else the + button.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Buy oat milk' })));

    await startEditing('Buy oat milk');
    await userEvent.selectOptions(listField('Buy oat milk'), 'Errands');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(screen.getByText('No tasks in Inbox yet.')).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(button('Add a task')));

    // Out of a named list, into Inbox.
    await pick('Errands');
    expect(taskTitles()).toEqual(['Order tea', 'Buy oat milk', 'Buy stamps']);
    await startEditing('Buy stamps');
    await userEvent.selectOptions(listField('Buy stamps'), 'Inbox');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(taskTitles()).toEqual(['Order tea', 'Buy oat milk']));
    expect(status()).toBe('Moved "Buy stamps" to Inbox.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Buy oat milk' })));
  });

  test('a move into a list deleted meanwhile shows an error and reloads the lists (AC-13, AC-14)', async () => {
    signedIn([milk, stamps]);
    withLists(errands, home);
    reply('PATCH /api/tasks/1', json({ error: 'invalid_list', message: 'listId must be the id of one of your lists, or null for Inbox.' }, 400));
    // Errands was deleted in another tab: its tasks are in Inbox now.
    withLists(home);
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Errands'));
    await startEditing('Buy oat milk');
    await userEvent.selectOptions(listField('Buy oat milk'), 'Errands');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(callsTo('GET /api/lists')).toHaveLength(2));
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Home']));
    // Still editing, with the error on the select, which no longer offers the gone list.
    const select = listField('Buy oat milk');
    expect(screen.getByRole('alert').textContent).toBe('That list no longer exists. Choose another list.');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    expect([...select.options].map((option) => option.textContent)).toEqual(['Inbox', 'Home']);
    expect(select.value).toBe('');
    await userEvent.click(button('Cancel'));
    // The task that was in the gone list is shown in Inbox, as the server keeps it.
    expect(rowLabel('Buy stamps')).toBeNull();
    await pick('Inbox');
    expect(taskTitles()).toEqual(['Buy oat milk', 'Buy stamps']);
  });

  test('an add, rename or delete that finds its list gone drops the tab with a notice (AC-14)', async () => {
    history.replaceState(null, '', '/?list=10');
    signedIn([milk, stamps]);
    withLists(errands, home, list(12, 'Work'));
    reply('POST /api/tasks', json({ error: 'invalid_list', message: 'listId must be the id of one of your lists, or null for Inbox.' }, 400));
    reply('PATCH /api/lists/11', json({ error: 'list_not_found', message: 'That list could not be found.' }, 404));
    reply('DELETE /api/lists/12', json({ error: 'list_not_found', message: 'That list could not be found.' }, 404));
    render(<App />);
    await ready();
    await waitFor(() => expect(selectedTab()).toEqual(['Errands']));

    await userEvent.type(await openAddSheet(), 'Buy envelopes{Enter}');
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Home', 'Work']));
    expect(status()).toBe('"Errands" no longer exists, so it was removed. The task was not added.');
    expect(selectedTab()).toEqual(['Inbox']);
    expect(location.search).toBe('?list=inbox');
    // The sheet stays open with the typed task, ready to add to Inbox now;
    // the List chip is open and says why.
    expect(newTaskField().value).toBe('Buy envelopes');
    expect(chip('List').getAttribute('aria-label')).toBe('List: Inbox');
    expect(chip('List').getAttribute('aria-expanded')).toBe('true');
    expect(within(addSheet()).getByRole('alert').textContent).toBe('That list no longer exists. Choose another list.');
    expect(taskTitles()).toEqual(['Buy oat milk', 'Buy stamps']);
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Cancel' }));

    await openManage();
    await userEvent.click(button('Rename "Home"'));
    await userEvent.type(screen.getByRole('textbox', { name: 'New name for "Home"' }), ' office{Enter}');
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Work']));
    expect(status()).toBe('"Home" no longer exists, so it was removed.');
    expect(document.activeElement).toBe(button('Rename "Work"'));

    await userEvent.click(button('Delete list "Work"'));
    await userEvent.click(button('Confirm deleting list "Work"'));
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me']));
    expect(status()).toBe('"Work" no longer exists, so it was removed.');
    expect(document.activeElement).toBe(viewTitle());
  });

  test('lists that fail to load show an error with a retry; tasks still work in All tasks (AC-14)', async () => {
    history.replaceState(null, '', '/?list=10');
    signedIn([milk, stamps]);
    reply('GET /api/lists', json({ error: 'internal_error' }, 500));
    reply('GET /api/lists', () => Promise.reject(new TypeError('network down')));
    withLists(errands);
    reply('POST /api/tasks', json({ task: inList(7, 'Call the plumber', null) }, 201));
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toBe('Your lists could not be loaded.');
    expect(selectedTab()).toEqual(['All tasks']);
    expect(taskTitles()).toEqual(['Buy oat milk', 'Buy stamps']);
    // The picker offers the views only: New list and Manage lists wait for the lists.
    expect(within(viewMenu()).queryAllByRole('menuitem', { hidden: true })).toEqual([]);
    await userEvent.type(await openAddSheet(), 'Call the plumber{Enter}');
    await waitFor(() => expect(taskTitles()).toEqual(['Call the plumber', 'Buy oat milk', 'Buy stamps']));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Call the plumber' });

    await userEvent.click(button('Load lists again'));
    await waitFor(() => expect(callsTo('GET /api/lists')).toHaveLength(2));
    expect((await screen.findByRole('alert')).textContent).toBe('Your lists could not be loaded.');
    await userEvent.click(button('Load lists again'));
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Errands']));
    expect(screen.queryByRole('alert')).toBeNull();
    // The list the URL names exists now, so it is shown.
    expect(selectedTab()).toEqual(['Errands']);
    expect(taskTitles()).toEqual(['Buy stamps']);
    await pick('All tasks');
    expect(rowLabel('Buy stamps')).toBe('List: Errands');
  });

  test('a 401 from any list request returns to the signed-out view (AC-14)', async () => {
    const expectSignedOut = async () => {
      expect(await screen.findByRole('button', { name: 'Sign in with Pior Labs' })).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toBe('Your session has ended. Please sign in again.');
      expect(screen.queryByRole('tablist')).toBeNull();
      cleanup();
    };
    const unauthorized = () => json({ error: 'unauthorized' }, 401);

    signedIn([milk]);
    reply('GET /api/lists', unauthorized());
    render(<App />);
    await expectSignedOut();

    signedIn([milk]);
    reply('POST /api/lists', unauthorized());
    render(<App />);
    await ready();
    await pick('New list');
    await userEvent.type(screen.getByRole('textbox', { name: 'List name' }), 'Errands{Enter}');
    await expectSignedOut();

    for (const [method, action] of [['PATCH', 'rename'], ['DELETE', 'delete']] as const) {
      signedIn([milk]);
      withLists(errands);
      reply(`${method} /api/lists/10`, unauthorized());
      render(<App />);
      await ready();
      await waitFor(() => expect(tabNames()).toContain('Errands'));
      await openManage();
      if (action === 'rename') {
        await userEvent.click(button('Rename "Errands"'));
        await userEvent.type(screen.getByRole('textbox', { name: 'New name for "Errands"' }), 's{Enter}');
      } else {
        await userEvent.click(button('Delete list "Errands"'));
        await userEvent.click(button('Confirm deleting list "Errands"'));
      }
      await expectSignedOut();
    }
  });
});

// Shared lists. The criteria named below are those of the shared lists task.
// The signed-in user is Household One (id 1); Household Two is id 2.
describe('shared lists', () => {
  const list = (id: number, name: string, { shared = false, ownerId = 1 } = {}) => ({
    id,
    name,
    shared,
    ownerId,
    createdAt: '2026-11-20T12:00:00.000Z',
    updatedAt: '2026-11-20T12:00:00.000Z',
  });
  const errands = list(10, 'Errands');
  const home = list(11, 'Home', { shared: true });
  const groceries = list(12, 'Groceries', { shared: true, ownerId: 2 });
  const task = (id: number, title: string, listId: number | null, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    listId,
    notes: null,
    completed: false,
    dueDate: null,
    repeat: null,
    createdById: 1,
    completedById: null,
    assigneeId: null,
    ...extra,
  });
  const withLists = (...lists: unknown[]) => reply('GET /api/lists', json({ lists }));
  const manageRow = (name: string) =>
    within(screen.getByRole('list', { name: 'Your lists' }))
      .getAllByRole('listitem')
      .find((item) => item.querySelector('[data-list-name]')?.textContent === name)!;
  const rowOf = (title: string) => screen.getByRole('checkbox', { name: title }).closest('li')!;
  const shareLabels = (title: string) => rowOf(title).querySelector('[data-share-labels]')?.textContent ?? null;
  const assigneeField = (title: string) =>
    screen.queryByRole('combobox', { name: `Assigned to, for "${title}"` }) as HTMLSelectElement | null;
  const optionTexts = (select: HTMLSelectElement) => [...select.options].map((option) => option.textContent);
  // Triggers a background refresh by focusing the window, and waits until its
  // three requests went out.
  async function refreshOnFocus() {
    const before = callsTo('GET /api/members').length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(callsTo('GET /api/members')).toHaveLength(before + 1));
    expect(callsTo('GET /api/tasks').length).toBeGreaterThan(1);
  }
  // Queues the answers of one refresh.
  function refreshReplies(tasks: unknown[], lists: unknown[], members: unknown[] = fixtureMembers) {
    reply('GET /api/tasks', json({ tasks }));
    reply('GET /api/lists', json({ lists }));
    reply('GET /api/members', json({ members }));
  }

  test('shared lists, own and others\', are tabs in creation order with a shared marker (AC-11)', async () => {
    signedIn([]);
    withLists(errands, home, groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Errands', 'Home (shared)', 'Groceries (shared)']));
    // The accessible name says "shared"; the visible marker is the people icon
    // in place of the list icon every other list tab has.
    for (const name of ['Home (shared)', 'Groceries (shared)']) {
      expect(tab(name).querySelector('svg.lucide-users[aria-hidden="true"]')).toBeTruthy();
      expect(tab(name).querySelector('.sr-only')!.textContent).toBe('(shared)');
    }
    expect(tab('Errands').querySelector('svg.lucide-users')).toBeNull();
    await pick('Groceries (shared)');
    expect(location.search).toBe('?list=12');
    expect(screen.getByText('No tasks in Groceries yet.')).toBeTruthy();
  });

  test('Manage lists shares and stops sharing the user\'s own lists and names other owners (AC-11)', async () => {
    signedIn([task(1, 'Mow', 11, { assigneeId: 2 })]);
    withLists(errands, home, groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Groceries (shared)'));
    expect(shareLabels('Mow')).toBe('Assigned to Household Two');
    await openManage();
    expect(manageRow('Errands').querySelector('[data-list-sharing]')).toBeNull();
    expect(manageRow('Home').querySelector('[data-list-sharing]')!.textContent).toBe('Shared with household');
    expect(manageRow('Groceries').querySelector('[data-list-sharing]')!.textContent).toBe('Shared by Household Two');
    expect(within(manageRow('Errands')).getAllByRole('button').map((item) => item.textContent)).toEqual([
      'Rename',
      'Share with household',
      'Delete',
    ]);
    expect(within(manageRow('Groceries')).getAllByRole('button').map((item) => item.textContent)).toEqual([
      'Rename',
      'Stop sharing',
      'Delete',
    ]);

    // Share: one request, no question; the button and tab follow once stored.
    let finish!: (response: Response) => void;
    reply('PATCH /api/lists/10', new Promise<Response>((resolve) => (finish = resolve)));
    await userEvent.click(button('Share "Errands" with household'));
    expect(callsTo('PATCH /api/lists/10')[0].body).toEqual({ shared: true });
    const pending = button('Share "Errands" with household');
    expect(pending.textContent).toBe('Sharing...');
    expect(pending.getAttribute('aria-disabled')).toBe('true');
    // A pending request ignores more clicks.
    await userEvent.click(pending);
    expect(callsTo('PATCH /api/lists/10')).toHaveLength(1);
    finish(json({ list: { ...errands, shared: true } }));
    await waitFor(() => expect(tabNames()).toContain('Errands (shared)'));
    expect(document.activeElement).toBe(button('Stop sharing "Errands"'));

    // Stop sharing an own list: no question either; assignees go, as on the server.
    reply('PATCH /api/lists/11', json({ list: { ...home, shared: false } }));
    await userEvent.click(button('Stop sharing "Home"'));
    expect(callsTo('PATCH /api/lists/11')[0].body).toEqual({ shared: false });
    await waitFor(() => expect(tabNames()).toContain('Home'));
    expect(manageRow('Home').querySelector('[data-list-sharing]')).toBeNull();
    expect(shareLabels('Mow')).toBeNull();

    // A failure shows an error and changes nothing.
    reply('PATCH /api/lists/10', json({ error: 'internal_error' }, 500));
    await userEvent.click(button('Stop sharing "Errands"'));
    expect((await screen.findByRole('alert')).textContent).toBe('Sharing "Errands" could not be stopped. Please try again.');
    expect(tabNames()).toContain('Errands (shared)');
  });

  test('stopping sharing someone else\'s list asks first, then the list and its tasks go (AC-11, D-2)', async () => {
    history.replaceState(null, '', '/?list=12');
    signedIn([task(1, 'Their milk', 12, { createdById: 2 }), task(2, 'My eggs', 12), task(3, 'Inbox task', null)]);
    withLists(errands, groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(selectedTab()).toEqual(['Groceries (shared)']));
    expect(taskTitles()).toEqual(['Their milk', 'My eggs']);
    await openManage();

    await userEvent.click(button('Stop sharing "Groceries"'));
    const question = screen.getByRole('group', { name: 'Stop sharing "Groceries"?' });
    expect(question.textContent).toContain(
      'Stop sharing Groceries? It goes back to Household Two with all its tasks, and you will lose access to it.',
    );
    expect(document.activeElement).toBe(button('Cancel stopping sharing "Groceries"'));
    expect(callsTo('PATCH /api/lists/12')).toHaveLength(0);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Stop sharing "Groceries"?' })).toBeNull();
    expect(document.activeElement).toBe(button('Stop sharing "Groceries"'));

    // A failed request keeps the question for a retry.
    reply('PATCH /api/lists/12', json({ error: 'internal_error' }, 500), json({ list: { ...groceries, shared: false } }));
    await userEvent.click(button('Stop sharing "Groceries"'));
    await userEvent.click(button('Confirm stopping sharing "Groceries"'));
    expect((await screen.findByRole('alert')).textContent).toBe('Sharing "Groceries" could not be stopped. Please try again.');
    expect(screen.getByRole('group', { name: 'Stop sharing "Groceries"?' })).toBeTruthy();
    await userEvent.click(button('Confirm stopping sharing "Groceries"'));
    expect(callsTo('PATCH /api/lists/12').map((call) => call.body)).toEqual([{ shared: false }, { shared: false }]);
    // The tab goes, the view switches to Inbox, and the list's tasks are gone.
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Errands']));
    expect(selectedTab()).toEqual(['Inbox']);
    expect(location.search).toBe('?list=inbox');
    expect(screen.getByRole('status').textContent).toBe('"Groceries" is no longer shared with you, so it was removed.');
    // Focus moved to the previous list's Rename.
    await waitFor(() => expect(document.activeElement).toBe(button('Rename "Errands"')));
    await userEvent.click(button('Close Manage lists'));
    await pick('All tasks');
    expect(taskTitles()).toEqual(['Inbox task']);
  });

  test('deleting a shared list says where the tasks go, and the other member\'s leave (AC-11, D-4)', async () => {
    signedIn([task(1, 'Their milk', 12, { createdById: 2, assigneeId: 1 }), task(2, 'My eggs', 12, { assigneeId: 2 })]);
    withLists(errands, groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Groceries (shared)'));
    await openManage();
    await userEvent.click(button('Delete list "Groceries"'));
    expect(screen.getByRole('group', { name: 'Delete list "Groceries"?' }).textContent).toContain(
      'Delete Groceries? Its 2 tasks will return to the Inbox of whoever added them.',
    );
    await userEvent.click(button('Cancel deleting list "Groceries"'));
    await userEvent.click(button('Delete list "Errands"'));
    expect(screen.getByRole('group', { name: 'Delete list "Errands"?' }).textContent).toContain(
      'Delete Errands? It has no tasks.',
    );
    await userEvent.click(button('Cancel deleting list "Errands"'));

    reply('DELETE /api/lists/12', json({ movedTaskIds: [1, 2] }));
    await userEvent.click(button('Delete list "Groceries"'));
    await userEvent.click(button('Confirm deleting list "Groceries"'));
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Errands']));
    // My task is in my Inbox now, unassigned; Household Two's went to theirs.
    await userEvent.click(button('Close Manage lists'));
    await pick('Inbox');
    expect(taskTitles()).toEqual(['My eggs']);
    expect(rowOf('My eggs').querySelector('[data-share-labels]')).toBeNull();
  });

  test('rows in shared lists say who added, completed and is assigned; other rows look as before (AC-12, D-5)', async () => {
    signedIn([
      task(1, 'Added by two', 12, { createdById: 2, assigneeId: 1 }),
      task(2, 'Done by two', 12, { completed: true, completedById: 2 }),
      task(3, 'Mine, assigned', 11, { assigneeId: 2 }),
      task(4, 'Unknown member', 12, { createdById: 3, assigneeId: 3 }),
      task(5, 'Done by me', 12, { createdById: 2, completed: true, completedById: 1 }),
      task(6, 'Inbox, by two', null, { createdById: 2 }),
      task(7, 'Unshared list', 10, { createdById: 2, assigneeId: 2 }),
      task(8, 'Unknown completer', 11, { completed: true, completedById: null }),
    ]);
    withLists(errands, home, groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Groceries (shared)'));
    await expandCompleted();
    // In "All tasks".
    const expected: Record<string, string | null> = {
      'Added by two': 'Added by Household Two · Assigned to you',
      'Done by two': 'Done by Household Two',
      'Mine, assigned': 'Assigned to Household Two',
      'Unknown member': null,
      'Done by me': 'Added by Household Two',
      'Inbox, by two': null,
      'Unshared list': null,
      'Unknown completer': null,
    };
    for (const [title, labels] of Object.entries(expected)) expect(shareLabels(title), title).toBe(labels);
    // The same in the list's own view.
    await pick('Groceries (shared)');
    expect(shareLabels('Added by two')).toBe('Added by Household Two · Assigned to you');
    expect(shareLabels('Done by two')).toBe('Done by Household Two');
    // Rows outside shared lists have exactly their usual parts.
    await pick('Inbox');
    expect(rowOf('Inbox, by two').querySelectorAll('p')).toHaveLength(0);
  });

  test('the edit row of a task in a shared list has an "Assigned to" select; others do not (AC-13, D-6)', async () => {
    signedIn([task(1, 'Shared task', 12, { assigneeId: 1 }), task(2, 'Inbox task', null), task(3, 'Errand', 10)]);
    withLists(errands, groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Groceries (shared)'));

    // Outside shared lists there is no select, and edit bodies are unchanged.
    for (const title of ['Inbox task', 'Errand']) {
      await userEvent.click(button(`Edit "${title}"`));
      expect(assigneeField(title)).toBeNull();
      await userEvent.click(button('Cancel'));
    }

    await userEvent.click(button('Edit "Shared task"'));
    const field = assigneeField('Shared task')!;
    expect(optionTexts(field)).toEqual(['Nobody', 'Me (Household One)', 'Household Two']);
    expect(field.value).toBe('1');
    // In Tab order after the List select and before the notes.
    act(() => screen.getByRole('combobox', { name: 'List for "Shared task"' }).focus());
    await userEvent.tab();
    expect(document.activeElement).toBe(field);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Notes for "Shared task"' }));
    // Saving with no change sends nothing.
    await userEvent.click(button('Save'));
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);

    // Only a changed assignee is sent.
    reply('PATCH /api/tasks/1', json({ task: task(1, 'Shared task', 12, { assigneeId: 2 }) }));
    await userEvent.click(button('Edit "Shared task"'));
    await userEvent.selectOptions(assigneeField('Shared task')!, 'Household Two');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(shareLabels('Shared task')).toBe('Assigned to Household Two'));
    expect(callsTo('PATCH /api/tasks/1')[0].body).toEqual({ assigneeId: 2 });
    reply('PATCH /api/tasks/1', json({ task: task(1, 'Renamed', 12, { assigneeId: 2 }) }));
    await userEvent.click(button('Edit "Shared task"'));
    await userEvent.clear(screen.getByRole('textbox', { name: 'New title for "Shared task"' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'New title for "Shared task"' }), 'Renamed{Enter}');
    await waitFor(() => expect(taskTitles()).toContain('Renamed'));
    expect(callsTo('PATCH /api/tasks/1')[1].body).toEqual({ title: 'Renamed' });

    // Moving out of the shared list hides the select and clears the assignee
    // locally; only the move is sent, as the server clears it.
    reply('PATCH /api/tasks/1', json({ task: task(1, 'Renamed', null) }));
    await userEvent.click(button('Edit "Renamed"'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'List for "Renamed"' }), 'Inbox');
    expect(assigneeField('Renamed')).toBeNull();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'List for "Renamed"' }), 'Groceries (shared)');
    expect(assigneeField('Renamed')!.value).toBe('');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'List for "Renamed"' }), 'Inbox');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(callsTo('PATCH /api/tasks/1')).toHaveLength(3));
    expect(callsTo('PATCH /api/tasks/1')[2].body).toEqual({ listId: null });

    // Moving into a shared list offers the select in the same edit.
    reply('PATCH /api/tasks/2', json({ task: task(2, 'Inbox task', 12, { assigneeId: 1 }) }));
    await userEvent.click(button('Edit "Inbox task"'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'List for "Inbox task"' }), 'Groceries (shared)');
    await userEvent.selectOptions(assigneeField('Inbox task')!, 'Me (Household One)');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(callsTo('PATCH /api/tasks/2')).toHaveLength(1));
    expect(callsTo('PATCH /api/tasks/2')[0].body).toEqual({ listId: 12, assigneeId: 1 });

    // An assignee the server refuses is reported on the select.
    reply('PATCH /api/tasks/2', json({ error: 'invalid_assignee', message: 'Not a member.' }, 400));
    await pick('Groceries (shared)');
    await userEvent.click(button('Edit "Inbox task"'));
    await userEvent.selectOptions(assigneeField('Inbox task')!, 'Household Two');
    await userEvent.click(button('Save'));
    expect((await screen.findByRole('alert')).textContent).toBe('Not a member.');
    expect(assigneeField('Inbox task')!.getAttribute('aria-invalid')).toBe('true');
  });

  test('a refresh on focus shows what another member added, changed, completed and deleted (AC-14)', async () => {
    signedIn([task(1, 'Milk', 12), task(2, 'Bread', 12)]);
    withLists(groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(taskTitles()).toEqual(['Milk', 'Bread']));
    expect(callsTo('GET /api/tasks')).toHaveLength(1);

    refreshReplies(
      [
        task(3, 'Eggs', 12, { createdById: 2 }),
        task(1, 'Oat milk', 12, { completed: true, completedById: 2 }),
      ],
      [{ ...groceries, name: 'Food' }, list(13, 'Garden', { shared: true, ownerId: 2 })],
    );
    await refreshOnFocus();
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Food (shared)', 'Garden (shared)']));
    expect(taskTitles()).toEqual(['Eggs']);
    expect(shareLabels('Eggs')).toBe('Added by Household Two');
    await expandCompleted();
    expect(shareLabels('Oat milk')).toBe('Done by Household Two');
    expect(screen.queryByText('Bread')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // A list share is taken back and another deleted.
    refreshReplies([task(3, 'Eggs', 12, { createdById: 2 })], [{ ...groceries, name: 'Food', shared: false, ownerId: 1 }]);
    await refreshOnFocus();
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Food']));
    expect(shareLabels('Eggs')).toBeNull();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('a refresh keeps drafts, the edit row and focus, and a deleted task\'s save shows "not found" (AC-14)', async () => {
    signedIn([task(1, 'Milk', 12), task(2, 'Bread', 12, { dueDate: '2099-01-01' })]);
    withLists(groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(taskTitles()).toEqual(['Bread', 'Milk']));
    // A draft left in the add sheet.
    await userEvent.type(await openAddSheet(), 'Half typed');
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(button('Edit "Milk"'));
    const field = screen.getByRole('textbox', { name: 'New title for "Milk"' }) as HTMLInputElement;
    await userEvent.type(field, ' draft');
    field.setSelectionRange(2, 4);

    // Another member renamed Milk, deleted it even, and moved Bread to another
    // group: the edit row and its draft stay, and focus stays in the field.
    refreshReplies([task(2, 'Bread', 12, { dueDate: null }), task(4, 'Butter', 12, { createdById: 2 })], [groceries]);
    await refreshOnFocus();
    await waitFor(() => expect(screen.getByText('Butter')).toBeTruthy());
    expect(field.value).toBe('Milk draft');
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 4]);
    // The edited row keeps its place.
    expect(taskTitles()).toEqual(['editing: Milk draft', 'Bread', 'Butter']);

    // Saving the deleted task gets the usual "no longer exists" handling.
    reply('PATCH /api/tasks/1', json({ error: 'task_not_found' }, 404));
    await userEvent.click(button('Save'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('"Milk" no longer exists, so it was removed from the list.'));
    expect(taskTitles()).toEqual(['Bread', 'Butter']);
    expect(callsTo('PATCH /api/tasks/1')[0].body).toEqual({ title: 'Milk draft' });
    // The add sheet's draft survived the refresh.
    expect((await openAddSheet()).value).toBe('Half typed');
  });

  test('a refresh moves focus with a row that changes group, and never during a pending change (AC-14)', async () => {
    signedIn([task(1, 'Milk', 12), task(2, 'Bread', 12, { dueDate: '2099-01-01' })]);
    withLists(groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(taskTitles()).toEqual(['Bread', 'Milk']));
    const edit = button('Edit "Bread"');
    act(() => edit.focus());
    refreshReplies([task(2, 'Bread', 12), task(1, 'Milk', 12)], [groceries]);
    await refreshOnFocus();
    await waitFor(() => expect(taskTitles()).toEqual(['Bread', 'Milk']));
    // Bread moved from Upcoming to No date: a new row, focus on the same control.
    expect(screen.queryByRole('list', { name: 'Upcoming' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Bread"')));
    expect(button('Edit "Bread"')).not.toBe(edit);

    // While a completion is pending, a refresh answer (which may predate it)
    // is dropped; the next one applies.
    let finish!: (response: Response) => void;
    reply('PATCH /api/tasks/1', new Promise<Response>((resolve) => (finish = resolve)));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Milk' }));
    refreshReplies([task(2, 'Bread', 12), task(1, 'Milk', 12), task(5, 'Stale', 12)], [groceries]);
    await refreshOnFocus();
    finish(json({ task: task(1, 'Milk', 12, { completed: true, completedById: 1 }) }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('"Milk" was moved to Completed.'));
    expect(screen.queryByText('Stale')).toBeNull();
    refreshReplies([task(1, 'Milk', 12, { completed: true, completedById: 1 }), task(2, 'Bread', 12), task(6, 'Fresh', 12)], [groceries]);
    await refreshOnFocus();
    await waitFor(() => expect(taskTitles()).toEqual(['Bread', 'Fresh']));
    expect(screen.getByRole('button', { name: 'Show 1 done' })).toBeTruthy();
  });

  test('a refresh that finds the selected list gone switches to Inbox with a notice (AC-14)', async () => {
    history.replaceState(null, '', '/?list=12');
    signedIn([task(1, 'Milk', 12, { createdById: 2 }), task(2, 'Mine', null)]);
    withLists(groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(selectedTab()).toEqual(['Groceries (shared)']));
    // Focus on the list's item in the open view picker, which goes away.
    await userEvent.click(viewTitle());
    expect(document.activeElement).toBe(tab('Groceries (shared)'));
    refreshReplies([task(2, 'Mine', null)], []);
    await refreshOnFocus();
    await waitFor(() => expect(selectedTab()).toEqual(['Inbox']));
    expect(location.search).toBe('?list=inbox');
    expect(screen.getByRole('status').textContent).toBe(
      '"Groceries" was deleted or is no longer shared with you, so Inbox is shown.',
    );
    expect(taskTitles()).toEqual(['Mine']);
    // Where focus went to the selected tab, it goes to the view title (AC-8).
    await waitFor(() => expect(document.activeElement).toBe(viewTitle()));
    expect(viewTitle().textContent).toBe('Inbox');
  });

  test('a 401 on refresh signs out; other failures are silent and retried (AC-14)', async () => {
    signedIn([task(1, 'Milk', null)]);
    render(<App />);
    await ready();
    // A server error and a network error: nothing is shown.
    reply('GET /api/tasks', json({ error: 'internal_error' }, 500));
    await refreshOnFocus();
    reply('GET /api/tasks', () => Promise.reject(new TypeError('network down')));
    await refreshOnFocus();
    await waitFor(() => expect(callsTo('GET /api/tasks')).toHaveLength(3));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(taskTitles()).toEqual(['Milk']);
    // The next trigger tries again and applies.
    refreshReplies([task(2, 'Bread', null), task(1, 'Milk', null)], []);
    await refreshOnFocus();
    await waitFor(() => expect(taskTitles()).toEqual(['Bread', 'Milk']));
    // An ended session returns to the signed-out view.
    reply('GET /api/tasks', json({ error: 'unauthorized' }, 401));
    await refreshOnFocus();
    expect(await screen.findByRole('button', { name: 'Sign in with Pior Labs' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Your session has ended. Please sign in again.');
  });

  test('a refresh runs every 30 seconds while the page is visible, and on becoming visible (AC-14, D-8)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let state: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => state);
    signedIn([task(1, 'Milk', null)]);
    render(<App />);
    await ready();
    expect(callsTo('GET /api/tasks')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(callsTo('GET /api/tasks')).toHaveLength(1);
    refreshReplies([task(2, 'Bread', null), task(1, 'Milk', null)], []);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(callsTo('GET /api/tasks')).toHaveLength(2);
    await waitFor(() => expect(taskTitles()).toEqual(['Bread', 'Milk']));
    // Hidden: no refresh, however long.
    state = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(callsTo('GET /api/tasks')).toHaveLength(2);
    // Visible again: at once.
    refreshReplies([task(3, 'Eggs', null), task(2, 'Bread', null), task(1, 'Milk', null)], []);
    state = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(callsTo('GET /api/tasks')).toHaveLength(3);
    await waitFor(() => expect(taskTitles()).toEqual(['Eggs', 'Bread', 'Milk']));
  });

  test('a refresh that loses the task behind the edit row closes the row with a notice (AC-14, R1-F1)', async () => {
    history.replaceState(null, '', '/?list=12');
    signedIn([task(1, 'Sweep porch', 12, { createdById: 2 }), task(2, 'Mine', null)]);
    withLists(groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(selectedTab()).toEqual(['Groceries (shared)']));
    await userEvent.click(button('Edit "Sweep porch"'));
    await userEvent.type(screen.getByRole('textbox', { name: 'New title for "Sweep porch"' }), ' twice');

    // The owner unshared the list: its task is not the viewer's any more.
    refreshReplies([task(2, 'Mine', null)], []);
    await refreshOnFocus();
    await waitFor(() => expect(selectedTab()).toEqual(['Inbox']));
    expect(screen.getByRole('status').textContent).toBe(
      '"Groceries" was deleted or is no longer shared with you, so Inbox is shown. "Sweep porch" is no longer shared with you.',
    );
    // No edit row claims the task is in Inbox, and nothing was saved.
    expect(screen.queryByRole('textbox', { name: /^New title for/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /^List for/ })).toBeNull();
    expect(taskTitles()).toEqual(['Mine']);
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(button('Add a task')));
  });

  test('a refresh that closes a lost edit row moves focus to the neighbour row without restoring a caret there (AC-14, R2-F1)', async () => {
    signedIn([task(1, 'Sweep porch', 12, { createdById: 2 }), task(2, 'Mine', null)]);
    withLists(groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(selectedTab()).toEqual(['All tasks']));
    await userEvent.click(button('Edit "Sweep porch"'));
    const field = screen.getByRole('textbox', { name: 'New title for "Sweep porch"' });
    await userEvent.type(field, ' twice');
    act(() => (field as HTMLInputElement).setSelectionRange(2, 4));
    expect(document.activeElement).toBe(field);

    // The owner unshared the list; "Mine" is still shown next to the closed row.
    refreshReplies([task(2, 'Mine', null)], []);
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /^New title for/ })).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('"Sweep porch" is no longer shared with you.');
    expect(selectedTab()).toEqual(['All tasks']);
    expect(taskTitles()).toEqual(['Mine']);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Mine' })));
    // The page still works: the + button opens the add sheet.
    expect(await openAddSheet()).toBeTruthy();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('a refresh that loses the task behind a confirm-delete row closes the row with a notice (AC-14, R2-F2)', async () => {
    signedIn([task(1, 'Sweep porch', 12, { createdById: 2 }), task(2, 'Mine', null)]);
    withLists(groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(selectedTab()).toEqual(['All tasks']));
    await userEvent.click(button('Delete "Sweep porch"'));
    expect(button('Confirm deleting "Sweep porch"')).toBeTruthy();

    // The owner deleted the list: the task went to its creator's Inbox.
    refreshReplies([task(2, 'Mine', null)], []);
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm deleting "Sweep porch"' })).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('"Sweep porch" is no longer shared with you.');
    expect(taskTitles()).toEqual(['Mine']);
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Mine' })));
  });

  test('the lost-task notice replaces an older notice instead of joining it (AC-14, R2-F3)', async () => {
    signedIn([task(1, 'Sweep porch', 12, { createdById: 2 }), task(2, 'Mine', null)]);
    withLists(groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(selectedTab()).toEqual(['All tasks']));
    reply('PATCH /api/tasks/2', json({ task: task(2, 'Mine', null, { completed: true, completedById: 1 }) }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mine' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('"Mine" was moved to Completed.'));
    await userEvent.click(button('Edit "Sweep porch"'));
    expect(screen.getByRole('status').textContent).toBe('"Mine" was moved to Completed.');

    refreshReplies([task(2, 'Mine', null, { completed: true, completedById: 1 })], []);
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /^New title for/ })).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('"Sweep porch" is no longer shared with you.');
  });

  test('focus on a Manage lists entry that a refresh removes moves to the nearest list left there (AC-14, R3-F1)', async () => {
    signedIn([]);
    withLists(errands, groceries, home);
    render(<App />);
    await ready();
    await openManage();
    const stop = button('Stop sharing "Groceries"');
    act(() => stop.focus());
    expect(document.activeElement).toBe(stop);

    // The owner deleted Groceries: the next list's Rename takes focus.
    refreshReplies([], [errands, home]);
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop sharing "Groceries"' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button('Rename "Home"')));
    expect(screen.getByRole('region', { name: 'Manage lists' })).toBeTruthy();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('focus on the last Manage lists entry goes to the previous list, and to the view title when none is left (AC-14, R3-F1)', async () => {
    signedIn([]);
    withLists(errands, groceries);
    render(<App />);
    await ready();
    await openManage();
    act(() => button('Stop sharing "Groceries"').focus());

    // Groceries was the last entry: the previous list's Rename takes focus.
    refreshReplies([], [errands]);
    await refreshOnFocus();
    await waitFor(() => expect(document.activeElement).toBe(button('Rename "Errands"')));

    // Errands goes too (deleted in another tab): no list is left.
    refreshReplies([], []);
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Manage lists' })).toBeNull());
    expect(manageItem()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(viewTitle()));
  });

  test('a refresh that removes the last list closes Manage lists, so a new list does not reopen it (AC-14, R4-F1)', async () => {
    signedIn([]);
    withLists(groceries);
    reply('POST /api/lists', json({ list: list(13, 'Later') }, 201));
    render(<App />);
    await ready();
    await openManage();
    act(() => button('Stop sharing "Groceries"').focus());

    // The owner deleted Groceries, the only list.
    refreshReplies([], []);
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Manage lists' })).toBeNull());
    expect(manageItem()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(viewTitle()));

    // As after deleting the last list here, Manage lists comes back closed.
    await pick('New list');
    await userEvent.type(screen.getByRole('textbox', { name: 'List name' }), 'Later{Enter}');
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Later']));
    expect(manageItem()).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Manage lists' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Your lists' })).toBeNull();
  });

  test('focus from a removed Manage lists entry goes to the Cancel of a neighbour\'s delete question, not its Confirm (AC-14, R4-F2)', async () => {
    signedIn([]);
    withLists(errands, groceries, home);
    render(<App />);
    await ready();
    await openManage();
    await userEvent.click(button('Delete list "Home"'));
    act(() => button('Stop sharing "Groceries"').focus());

    // The owner deleted Groceries: Home, the next list, is asking a question.
    refreshReplies([], [errands, home]);
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop sharing "Groceries"' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button('Cancel deleting list "Home"')));
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('focus from a removed Manage lists entry goes to the Cancel of a neighbour\'s stop-sharing question, not its Confirm (AC-14, R4-F2)', async () => {
    const garden = list(13, 'Garden', { shared: true, ownerId: 2 });
    signedIn([]);
    withLists(errands, groceries, garden);
    render(<App />);
    await ready();
    await openManage();
    await userEvent.click(button('Stop sharing "Garden"'));
    expect(screen.getByRole('group', { name: 'Stop sharing "Garden"?' })).toBeTruthy();
    act(() => button('Stop sharing "Groceries"').focus());

    // The owner deleted Groceries: Garden, the next list, is asking a question.
    refreshReplies([], [errands, garden]);
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop sharing "Groceries"' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button('Cancel stopping sharing "Garden"')));
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('a closed lost row whose neighbour is lost too moves focus to the nearest row that remains (AC-14, R3-F2)', async () => {
    signedIn([
      task(1, 'Sweep porch', 12, { createdById: 2 }),
      task(2, 'Oil hinge', 12, { createdById: 2 }),
      task(3, 'Mine', null),
    ]);
    withLists(groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(taskTitles()).toEqual(['Sweep porch', 'Oil hinge', 'Mine']));
    await userEvent.click(button('Edit "Sweep porch"'));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'New title for "Sweep porch"' }));

    // The owner unshared the list: the next row ("Oil hinge") goes as well.
    refreshReplies([task(3, 'Mine', null)], []);
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /^New title for/ })).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('"Sweep porch" is no longer shared with you.');
    expect(taskTitles()).toEqual(['Mine']);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Mine' })));
  });

  test('a closed lost last row whose previous neighbour is lost too moves focus to an earlier row (AC-14, R3-F2)', async () => {
    signedIn([
      task(3, 'Mine', null),
      task(2, 'Oil hinge', 12, { createdById: 2 }),
      task(1, 'Sweep porch', 12, { createdById: 2 }),
    ]);
    withLists(groceries);
    render(<App />);
    await ready();
    await waitFor(() => expect(taskTitles()).toEqual(['Mine', 'Oil hinge', 'Sweep porch']));
    await userEvent.click(button('Delete "Sweep porch"'));
    expect(button('Confirm deleting "Sweep porch"')).toBeTruthy();

    refreshReplies([task(3, 'Mine', null)], []);
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm deleting "Sweep porch"' })).toBeNull());
    expect(taskTitles()).toEqual(['Mine']);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Mine' })));
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('a refresh that never answers is aborted and does not block the next trigger (AC-14, R1-F2)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    signedIn([task(1, 'Milk', null)]);
    render(<App />);
    await ready();
    reply('GET /api/tasks', new Promise<Response>(() => {}));
    await refreshOnFocus();
    // While it hangs, further triggers are dropped.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(callsTo('GET /api/tasks')).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    // The next trigger goes out and applies.
    refreshReplies([task(2, 'Bread', null), task(1, 'Milk', null)], []);
    await refreshOnFocus();
    expect(callsTo('GET /api/tasks')).toHaveLength(3);
    await waitFor(() => expect(taskTitles()).toEqual(['Bread', 'Milk']));
  });

  // A Manage lists change that takes a task away from the user closes an open
  // delete question on it in every view, as it closes an open edit row, so the
  // question is not left hidden and shown again when the task comes back. The
  // criteria named below are those of the hidden-delete-question task.
  describe('open rows on tasks a Manage lists change takes away', () => {
    const work = list(13, 'Work', { shared: true, ownerId: 2 });
    const status = () => screen.queryByRole('status')?.textContent ?? null;
    const shown = (title: string) => screen.queryByRole('checkbox', { name: title }) !== null;
    const question = (title: string) => screen.queryByRole('button', { name: `Confirm deleting "${title}"` });
    const editField = (title: string) => screen.queryByRole('textbox', { name: `New title for "${title}"` });
    const inManage = () => document.getElementById('manage-lists')?.contains(document.activeElement) ?? false;

    test('stopping sharing someone else\'s list closes an open delete question or edit row on its tasks, naming them; the question does not come back with the task (hidden-delete-question AC-1, AC-4, AC-5)', async () => {
      signedIn([
        task(1, 'Their milk', 12, { createdById: 2 }),
        task(2, 'Their bread', 12, { createdById: 2 }),
        task(3, 'Their hammer', 13, { createdById: 2 }),
        task(4, 'Inbox task', null),
      ]);
      withLists(errands, groceries, work);
      render(<App />);
      await ready();
      await waitFor(() => expect(tabNames()).toContain('Work (shared)'));
      expect(selectedTab()).toEqual(['All tasks']);

      // A delete question in All tasks.
      await userEvent.click(button('Delete "Their milk"'));
      expect(question('Their milk')).toBeTruthy();
      await openManage();
      reply('PATCH /api/lists/12', json({ list: { ...groceries, shared: false } }));
      await userEvent.click(button('Stop sharing "Groceries"'));
      await userEvent.click(button('Confirm stopping sharing "Groceries"'));
      await waitFor(() => expect(tabNames()).not.toContain('Groceries (shared)'));
      expect(question('Their milk')).toBeNull();
      expect(shown('Their milk')).toBe(false);
      expect(shown('Their bread')).toBe(false);
      expect(selectedTab()).toEqual(['All tasks']);
      expect(inManage()).toBe(true);

      // The owner shares the list again and the tasks come back by refresh. A
      // question left hidden on "Their milk" would show again.
      refreshReplies(
        [
          task(1, 'Their milk', 12, { createdById: 2 }),
          task(2, 'Their bread', 12, { createdById: 2 }),
          task(3, 'Their hammer', 13, { createdById: 2 }),
          task(4, 'Inbox task', null),
        ],
        [errands, groceries, work],
      );
      await refreshOnFocus();
      await waitFor(() => expect(shown('Their milk')).toBe(true));
      expect(question('Their milk')).toBeNull();
      expect(button('Delete "Their milk"')).toBeTruthy();
      // The refresh named nothing new, so the notice of the change stays.
      expect(status()).toBe(
        '"Groceries" is no longer shared with you, so it was removed. "Their milk" is no longer shared with you.',
      );

      // An edit row closes as before, and the notice names its task too.
      await userEvent.click(button('Edit "Their hammer"'));
      await userEvent.type(editField('Their hammer')!, ' draft');
      reply('PATCH /api/lists/13', json({ list: { ...work, shared: false } }));
      await userEvent.click(button('Stop sharing "Work"'));
      await userEvent.click(button('Confirm stopping sharing "Work"'));
      await waitFor(() => expect(tabNames()).not.toContain('Work (shared)'));
      expect(editField('Their hammer')).toBeNull();
      expect(shown('Their hammer')).toBe(false);
      expect(status()).toBe('"Work" is no longer shared with you, so it was removed. "Their hammer" is no longer shared with you.');
      expect(inManage()).toBe(true);
      expect(calls.filter((call) => call.method !== 'GET' && call.method !== 'PATCH')).toEqual([]);
    });

    test('in the list\'s own view, stopping sharing it names the task of an open delete question (hidden-delete-question AC-1, AC-5)', async () => {
      history.replaceState(null, '', '/?list=12');
      signedIn([task(1, 'Their milk', 12, { createdById: 2 }), task(4, 'Inbox task', null)]);
      withLists(errands, groceries);
      render(<App />);
      await ready();
      await waitFor(() => expect(selectedTab()).toEqual(['Groceries (shared)']));
      await userEvent.click(button('Delete "Their milk"'));
      await openManage();
      reply('PATCH /api/lists/12', json({ list: { ...groceries, shared: false } }));
      await userEvent.click(button('Stop sharing "Groceries"'));
      await userEvent.click(button('Confirm stopping sharing "Groceries"'));
      await waitFor(() => expect(tabNames()).not.toContain('Groceries (shared)'));
      expect(selectedTab()).toEqual(['Inbox']);
      expect(status()).toBe(
        '"Groceries" is no longer shared with you, so it was removed. "Their milk" is no longer shared with you.',
      );

      refreshReplies([task(1, 'Their milk', 12, { createdById: 2 }), task(4, 'Inbox task', null)], [errands, groceries]);
      await refreshOnFocus();
      await userEvent.click(button('Close Manage lists'));
      await pick('Groceries (shared)');
      await waitFor(() => expect(shown('Their milk')).toBe(true));
      expect(question('Their milk')).toBeNull();
    });

    test('deleting a shared list closes an open delete question or edit row on a task that goes to someone else\'s Inbox, naming it; one on a task kept in the user\'s Inbox stays and works (hidden-delete-question AC-2, AC-4, AC-5)', async () => {
      signedIn([
        task(1, 'Their milk', 12, { createdById: 2 }),
        task(2, 'My eggs', 12),
        task(3, 'Their hammer', 13, { createdById: 2 }),
        task(4, 'My nails', 13),
        task(5, 'My screws', 13),
      ]);
      withLists(errands, groceries, work);
      render(<App />);
      await ready();
      await waitFor(() => expect(tabNames()).toContain('Work (shared)'));
      expect(selectedTab()).toEqual(['All tasks']);

      // A question on a task that goes to Household Two's Inbox, and an edit
      // row on one that stays the user's.
      await userEvent.click(button('Edit "My eggs"'));
      await userEvent.type(editField('My eggs')!, ' draft');
      await userEvent.click(button('Delete "Their milk"'));
      await openManage();
      reply('DELETE /api/lists/12', json({ movedTaskIds: [1, 2] }));
      await userEvent.click(button('Delete list "Groceries"'));
      await userEvent.click(button('Confirm deleting list "Groceries"'));
      await waitFor(() => expect(tabNames()).not.toContain('Groceries (shared)'));
      expect(question('Their milk')).toBeNull();
      expect(shown('Their milk')).toBe(false);
      expect((editField('My eggs') as HTMLInputElement).value).toBe('My eggs draft');
      expect(inManage()).toBe(true);

      // Household Two moves the task into a list shared with the user; it
      // comes back by refresh without the question.
      refreshReplies(
        [
          task(1, 'Their milk', 13, { createdById: 2 }),
          task(2, 'My eggs', null),
          task(3, 'Their hammer', 13, { createdById: 2 }),
          task(4, 'My nails', 13),
          task(5, 'My screws', 13),
        ],
        [errands, work],
      );
      await refreshOnFocus();
      await waitFor(() => expect(shown('Their milk')).toBe(true));
      expect(question('Their milk')).toBeNull();
      expect((editField('My eggs') as HTMLInputElement).value).toBe('My eggs draft');
      expect(status()).toBe('"Their milk" is no longer shared with you.');
      await userEvent.click(button('Cancel'));

      // A question on a task the user keeps stays open, and Cancel closes it.
      await userEvent.click(button('Delete "My nails"'));
      await userEvent.click(button('Edit "Their hammer"'));
      reply('DELETE /api/lists/13', json({ movedTaskIds: [1, 3, 4, 5] }));
      await userEvent.click(button('Delete list "Work"'));
      await userEvent.click(button('Confirm deleting list "Work"'));
      await waitFor(() => expect(tabNames()).not.toContain('Work (shared)'));
      expect(question('My nails')).toBeTruthy();
      expect(editField('Their hammer')).toBeNull();
      expect(shown('Their hammer')).toBe(false);
      expect(shown('Their milk')).toBe(false);
      // Only the edit row on a task taken away closed.
      expect(status()).toBe('"Their hammer" is no longer shared with you.');
      await userEvent.click(button('Cancel deleting "My nails"'));
      expect(question('My nails')).toBeNull();
      expect(shown('My nails')).toBe(true);

      // And Confirm deletes a kept task.
      await userEvent.click(button('Delete "My screws"'));
      reply('DELETE /api/tasks/5', noContent());
      await userEvent.click(button('Confirm deleting "My screws"'));
      await waitFor(() => expect(shown('My screws')).toBe(false));
      expect(callsTo('DELETE /api/tasks/5')).toHaveLength(1);
    });

    test('deleting a list with no open row on a task it takes away leaves the notice as it was (hidden-delete-question AC-5)', async () => {
      signedIn([task(1, 'Their milk', 12, { createdById: 2 }), task(2, 'My eggs', null)]);
      withLists(errands, groceries);
      render(<App />);
      await ready();
      await waitFor(() => expect(tabNames()).toContain('Groceries (shared)'));
      await userEvent.click(button('Delete "My eggs"'));
      await openManage();
      reply('DELETE /api/lists/12', json({ movedTaskIds: [1] }));
      await userEvent.click(button('Delete list "Groceries"'));
      await userEvent.click(button('Confirm deleting list "Groceries"'));
      await waitFor(() => expect(tabNames()).not.toContain('Groceries (shared)'));
      expect(shown('Their milk')).toBe(false);
      expect(question('My eggs')).toBeTruthy();
      expect(status()).toBeNull();
    });

    test('a Manage lists change that finds the list gone closes an open delete question on a task it takes away; one on a kept task stays (hidden-delete-question AC-3, AC-4, AC-5)', async () => {
      signedIn([
        task(1, 'Their milk', 12, { createdById: 2 }),
        task(2, 'My eggs', 12),
        task(3, 'Their hammer', 13, { createdById: 2 }),
        task(4, 'My nails', 13),
      ]);
      withLists(errands, groceries, work);
      render(<App />);
      await ready();
      await waitFor(() => expect(tabNames()).toContain('Work (shared)'));

      // The list was deleted meanwhile: it goes as if deleted, and a refresh
      // then shows where its tasks went.
      await userEvent.click(button('Edit "My eggs"'));
      await userEvent.type(editField('My eggs')!, ' draft');
      await userEvent.click(button('Delete "Their milk"'));
      await openManage();
      reply('PATCH /api/lists/12', json({ error: 'list_not_found', message: 'That list could not be found.' }, 404));
      refreshReplies(
        [task(2, 'My eggs', null), task(3, 'Their hammer', 13, { createdById: 2 }), task(4, 'My nails', 13)],
        [errands, work],
      );
      await userEvent.click(button('Stop sharing "Groceries"'));
      await userEvent.click(button('Confirm stopping sharing "Groceries"'));
      await waitFor(() => expect(tabNames()).not.toContain('Groceries (shared)'));
      expect(question('Their milk')).toBeNull();
      expect(shown('Their milk')).toBe(false);
      expect((editField('My eggs') as HTMLInputElement).value).toBe('My eggs draft');
      expect(inManage()).toBe(true);
      await waitFor(() => expect(callsTo('GET /api/tasks')).toHaveLength(2));

      // Household Two moves the task into a list shared with the user.
      refreshReplies(
        [
          task(1, 'Their milk', 13, { createdById: 2 }),
          task(2, 'My eggs', null),
          task(3, 'Their hammer', 13, { createdById: 2 }),
          task(4, 'My nails', 13),
        ],
        [errands, work],
      );
      await refreshOnFocus();
      await waitFor(() => expect(shown('Their milk')).toBe(true));
      expect(question('Their milk')).toBeNull();
      expect(status()).toBe('"Groceries" no longer exists, so it was removed. "Their milk" is no longer shared with you.');
      await userEvent.click(button('Cancel'));

      // A question on a kept task stays; an edit row on a task taken away
      // closes and is named.
      await userEvent.click(button('Delete "My nails"'));
      await userEvent.click(button('Edit "Their hammer"'));
      reply('DELETE /api/lists/13', json({ error: 'list_not_found', message: 'That list could not be found.' }, 404));
      refreshReplies([task(2, 'My eggs', null), task(4, 'My nails', null)], [errands]);
      await userEvent.click(button('Delete list "Work"'));
      await userEvent.click(button('Confirm deleting list "Work"'));
      await waitFor(() => expect(tabNames()).not.toContain('Work (shared)'));
      expect(question('My nails')).toBeTruthy();
      expect(editField('Their hammer')).toBeNull();
      expect(status()).toBe('"Work" no longer exists, so it was removed. "Their hammer" is no longer shared with you.');
      await waitFor(() => expect(callsTo('GET /api/tasks')).toHaveLength(4));
      expect(question('My nails')).toBeTruthy();
    });

    test('an edit row on a task the client shows in another list but the server moved with the deleted list closes, and does not come back with the task (hidden-delete-question R1-F1)', async () => {
      // The client still shows "Their hammer" in Work, while the server moved
      // it into Groceries before deleting that list: it is in movedTaskIds.
      signedIn([task(1, 'Their milk', 12, { createdById: 2 }), task(3, 'Their hammer', 13, { createdById: 2 })]);
      withLists(errands, groceries, work);
      render(<App />);
      await ready();
      await waitFor(() => expect(tabNames()).toContain('Work (shared)'));
      await userEvent.click(button('Edit "Their hammer"'));
      await userEvent.type(editField('Their hammer')!, ' draft');
      await openManage();
      reply('DELETE /api/lists/12', json({ movedTaskIds: [1, 3] }));
      await userEvent.click(button('Delete list "Groceries"'));
      await userEvent.click(button('Confirm deleting list "Groceries"'));
      await waitFor(() => expect(tabNames()).not.toContain('Groceries (shared)'));
      expect(shown('Their hammer')).toBe(false);
      expect(status()).toBe('"Their hammer" is no longer shared with you.');

      // Household Two moves it back into Work.
      refreshReplies([task(3, 'Their hammer', 13, { createdById: 2 })], [errands, work]);
      await refreshOnFocus();
      await waitFor(() => expect(shown('Their hammer')).toBe(true));
      expect(editField('Their hammer')).toBeNull();
    });

    // A Manage lists change that finds someone else's list gone cannot tell
    // whether it was deleted (the user's own tasks are in their Inbox now) or
    // stopped being shared by its owner (they are not the user's any more), so
    // it keeps them in Inbox until the refresh it starts settles them.
    test('a task kept in Inbox after stopping sharing finds the list gone, and missing from the next refresh, closes its delete question with a notice and leaves; an ordinary Inbox task\'s edit row stays pinned (hidden-delete-question AC-8)', async () => {
      signedIn([task(3, 'Their hammer', 13, { createdById: 2 }), task(4, 'My nails', 13), task(5, 'Inbox task', null)]);
      withLists(errands, groceries, work);
      render(<App />);
      await ready();
      await waitFor(() => expect(tabNames()).toContain('Work (shared)'));
      await userEvent.click(button('Delete "My nails"'));
      await userEvent.click(button('Edit "Inbox task"'));
      await userEvent.type(editField('Inbox task')!, ' draft');
      await openManage();

      // Household Two stopped sharing Work, and "Inbox task" was deleted in
      // another tab. The refresh answers once the drop is seen.
      reply('PATCH /api/lists/13', json({ error: 'list_not_found', message: 'That list could not be found.' }, 404));
      let answer!: (response: Response) => void;
      reply('GET /api/tasks', new Promise<Response>((resolve) => (answer = resolve)));
      reply('GET /api/lists', json({ lists: [errands, groceries] }));
      await userEvent.click(button('Stop sharing "Work"'));
      await userEvent.click(button('Confirm stopping sharing "Work"'));
      await waitFor(() => expect(tabNames()).not.toContain('Work (shared)'));
      expect(status()).toBe('"Work" no longer exists, so it was removed.');
      expect(shown('My nails')).toBe(true);
      expect(question('My nails')).toBeTruthy();
      expect(shown('Their hammer')).toBe(false);
      await waitFor(() => expect(callsTo('GET /api/tasks')).toHaveLength(2));
      answer(json({ tasks: [] }));
      await waitFor(() => expect(shown('My nails')).toBe(false));
      expect(question('My nails')).toBeNull();
      expect(status()).toBe('"My nails" is no longer shared with you.');
      expect(inManage()).toBe(true);
      // The ordinary Inbox task is pinned by its edit row, as before.
      expect((editField('Inbox task') as HTMLInputElement).value).toBe('Inbox task draft');

      // A later refresh does not bring it back.
      refreshReplies([], [errands, groceries]);
      await refreshOnFocus();
      await waitFor(() => expect(callsTo('GET /api/tasks')).toHaveLength(3));
      await act(async () => {});
      expect(shown('My nails')).toBe(false);
      expect((editField('Inbox task') as HTMLInputElement).value).toBe('Inbox task draft');

      // Saving the deleted Inbox task gets the usual "no longer exists" handling.
      reply('PATCH /api/tasks/5', json({ error: 'task_not_found' }, 404));
      await userEvent.click(button('Save'));
      await waitFor(() => expect(status()).toBe('"Inbox task" no longer exists, so it was removed from the list.'));
      expect(shown('Inbox task')).toBe(false);
    });

    test('a rename that finds the list gone keeps the user\'s tasks in Inbox until the refresh; an edit row there, and a question opened after the drop, close with a notice when the refresh does not return them (hidden-delete-question AC-8)', async () => {
      signedIn([task(4, 'My nails', 13), task(6, 'My screws', 13)]);
      withLists(errands, work);
      render(<App />);
      await ready();
      await waitFor(() => expect(tabNames()).toContain('Work (shared)'));
      await userEvent.click(button('Edit "My nails"'));
      await userEvent.type(editField('My nails')!, ' draft');
      await openManage();

      reply('PATCH /api/lists/13', json({ error: 'list_not_found', message: 'That list could not be found.' }, 404));
      let answer!: (response: Response) => void;
      reply('GET /api/tasks', new Promise<Response>((resolve) => (answer = resolve)));
      reply('GET /api/lists', json({ lists: [errands] }));
      await userEvent.click(button('Rename "Work"'));
      await userEvent.type(screen.getByRole('textbox', { name: 'New name for "Work"' }), ' bench{Enter}');
      await waitFor(() => expect(tabNames()).not.toContain('Work (shared)'));
      expect((editField('My nails') as HTMLInputElement).value).toBe('My nails draft');
      await userEvent.click(button('Delete "My screws"'));
      expect(question('My screws')).toBeTruthy();
      await waitFor(() => expect(callsTo('GET /api/tasks')).toHaveLength(2));
      answer(json({ tasks: [] }));
      await waitFor(() => expect(shown('My screws')).toBe(false));
      expect(editField('My nails')).toBeNull();
      expect(question('My screws')).toBeNull();
      expect(shown('My nails')).toBe(false);
      expect(status()).toBe('"My nails" is no longer shared with you. "My screws" is no longer shared with you.');
    });

    test('a delete that finds the list gone, when it was in fact deleted, keeps the user\'s tasks and their open rows after the refresh returns them, and they still work (hidden-delete-question AC-8)', async () => {
      signedIn([task(3, 'Their hammer', 13, { createdById: 2 }), task(4, 'My nails', 13), task(6, 'My screws', 13)]);
      withLists(errands, work);
      render(<App />);
      await ready();
      await waitFor(() => expect(tabNames()).toContain('Work (shared)'));
      await userEvent.click(button('Delete "My nails"'));
      await userEvent.click(button('Edit "My screws"'));
      await userEvent.type(editField('My screws')!, ' draft');
      await openManage();

      // Household Two deleted Work: the user's tasks are in their Inbox.
      reply('DELETE /api/lists/13', json({ error: 'list_not_found', message: 'That list could not be found.' }, 404));
      refreshReplies([task(4, 'My nails', null), task(6, 'My screws', null)], [errands]);
      await userEvent.click(button('Delete list "Work"'));
      await userEvent.click(button('Confirm deleting list "Work"'));
      await waitFor(() => expect(tabNames()).not.toContain('Work (shared)'));
      await waitFor(() => expect(callsTo('GET /api/members')).toHaveLength(2));
      await act(async () => {});
      expect(question('My nails')).toBeTruthy();
      expect((editField('My screws') as HTMLInputElement).value).toBe('My screws draft');
      expect(status()).toBe('"Work" no longer exists, so it was removed.');

      // A later refresh keeps them as ordinary Inbox tasks.
      refreshReplies([task(4, 'My nails', null), task(6, 'My screws', null)], [errands]);
      await refreshOnFocus();
      await waitFor(() => expect(callsTo('GET /api/members')).toHaveLength(3));
      await act(async () => {});
      expect(question('My nails')).toBeTruthy();
      expect((editField('My screws') as HTMLInputElement).value).toBe('My screws draft');
      expect(status()).toBe('"Work" no longer exists, so it was removed.');

      reply('DELETE /api/tasks/4', noContent());
      await userEvent.click(button('Confirm deleting "My nails"'));
      await waitFor(() => expect(shown('My nails')).toBe(false));
      expect(callsTo('DELETE /api/tasks/4')).toHaveLength(1);
      reply('PATCH /api/tasks/6', json({ task: task(6, 'My screws draft', null) }));
      await userEvent.click(button('Save'));
      await waitFor(() => expect(shown('My screws draft')).toBe(true));
      expect(editField('My screws')).toBeNull();
      expect(callsTo('PATCH /api/tasks/6')[0].body).toEqual({ title: 'My screws draft' });
    });

    test('a task dropList kept stays provisional through a refresh that fails or overlaps a change, and the next one that applies settles it (hidden-delete-question AC-8)', async () => {
      signedIn([task(4, 'My nails', 13), task(5, 'Inbox task', null)]);
      withLists(errands, work);
      render(<App />);
      await ready();
      await waitFor(() => expect(tabNames()).toContain('Work (shared)'));
      await userEvent.click(button('Delete "My nails"'));
      await openManage();

      // The refresh the drop starts fails.
      reply('DELETE /api/lists/13', json({ error: 'list_not_found', message: 'That list could not be found.' }, 404));
      reply('GET /api/tasks', json({ error: 'oops' }, 500));
      await userEvent.click(button('Delete list "Work"'));
      await userEvent.click(button('Confirm deleting list "Work"'));
      await waitFor(() => expect(tabNames()).not.toContain('Work (shared)'));
      await waitFor(() => expect(callsTo('GET /api/tasks')).toHaveLength(2));
      await act(async () => {});
      expect(question('My nails')).toBeTruthy();

      // The next one overlaps a completion, so its answer is dropped.
      let finish!: (response: Response) => void;
      reply('PATCH /api/tasks/5', new Promise<Response>((resolve) => (finish = resolve)));
      await userEvent.click(screen.getByRole('checkbox', { name: 'Inbox task' }));
      refreshReplies([], [errands]);
      await refreshOnFocus();
      finish(json({ task: task(5, 'Inbox task', null, { completed: true, completedById: 1 }) }));
      await waitFor(() => expect(callsTo('PATCH /api/tasks/5')).toHaveLength(1));
      await act(async () => {});
      expect(shown('My nails')).toBe(true);
      expect(question('My nails')).toBeTruthy();

      // The next one applies: the task is not the user's.
      refreshReplies([task(5, 'Inbox task', null, { completed: true, completedById: 1 })], [errands]);
      await refreshOnFocus();
      await waitFor(() => expect(shown('My nails')).toBe(false));
      expect(question('My nails')).toBeNull();
      expect(status()).toBe('"My nails" is no longer shared with you.');
    });

    test('a task a gone list kept in Inbox becomes an ordinary task once a refresh returns it (tasks-hidden-delete-question R2-F1)', async () => {
      signedIn([task(4, 'My nails', 13), task(6, 'My screws', 13)]);
      withLists(errands, work);
      render(<App />);
      await ready();
      await waitFor(() => expect(tabNames()).toContain('Work (shared)'));
      await openManage();
      reply('DELETE /api/lists/13', json({ error: 'list_not_found', message: 'That list could not be found.' }, 404));
      refreshReplies([task(4, 'My nails', null), task(6, 'My screws', null)], [errands]);
      await userEvent.click(button('Delete list "Work"'));
      await userEvent.click(button('Confirm deleting list "Work"'));
      await waitFor(() => expect(tabNames()).not.toContain('Work (shared)'));
      await waitFor(() => expect(callsTo('GET /api/members')).toHaveLength(2));
      await act(async () => {});
      await userEvent.click(button('Edit "My screws"'));
      await userEvent.type(editField('My screws')!, ' draft');
      // "My screws" is deleted in another tab.
      refreshReplies([task(4, 'My nails', null)], [errands]);
      await refreshOnFocus();
      await waitFor(() => expect(callsTo('GET /api/members')).toHaveLength(3));
      await act(async () => {});
      expect((editField('My screws') as HTMLInputElement).value).toBe('My screws draft');
      expect(status()).toBe('"Work" no longer exists, so it was removed.');
    });
  });
});

// The "Assigned to me" view. The criteria named below are those of the
// assigned-to-me task. The signed-in user is Household One (id 1).
describe('assigned to me', () => {
  const list = (id: number, name: string, { shared = false, ownerId = 1 } = {}) => ({
    id,
    name,
    shared,
    ownerId,
    createdAt: '2026-11-20T12:00:00.000Z',
    updatedAt: '2026-11-20T12:00:00.000Z',
  });
  const errands = list(10, 'Errands');
  const home = list(11, 'Home', { shared: true });
  const groceries = list(12, 'Groceries', { shared: true, ownerId: 2 });
  const work = list(13, 'Work', { shared: true, ownerId: 2 });
  const task = (id: number, title: string, listId: number | null, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    listId,
    notes: null,
    completed: false,
    dueDate: null,
    repeat: null,
    createdById: 1,
    completedById: null,
    assigneeId: null,
    ...extra,
  });
  const mine = { assigneeId: 1 };
  const withLists = (...lists: unknown[]) => reply('GET /api/lists', json({ lists }));
  const rowOf = (title: string) => screen.getByRole('checkbox', { name: title }).closest('li')!;
  const rowLabel = (title: string) => rowOf(title).querySelector('[data-list-label]')?.textContent ?? null;
  const shareLabels = (title: string) => rowOf(title).querySelector('[data-share-labels]')?.textContent ?? null;
  const assigneeField = (title: string) =>
    screen.getByRole('combobox', { name: `Assigned to, for "${title}"` }) as HTMLSelectElement;
  const listField = (title: string) => screen.getByRole('combobox', { name: `List for "${title}"` }) as HTMLSelectElement;
  const status = () => screen.queryByRole('status')?.textContent ?? null;
  const headings = () => screen.getAllByRole('heading', { level: 2 }).map((item) => item.textContent!.replace('▸', ''));
  const EMPTY = 'No tasks are assigned to you yet: tasks assigned to you in shared lists show here.';
  async function openAssigned(tasks: unknown[], lists: unknown[] = [errands, home, groceries, work]) {
    history.replaceState(null, '', '/?list=assigned');
    signedIn(tasks);
    withLists(...lists);
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toContain('Home (shared)'));
    expect(selectedTab()).toEqual(['Assigned to me']);
  }
  async function refreshOnFocus() {
    const before = callsTo('GET /api/members').length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(callsTo('GET /api/members')).toHaveLength(before + 1));
  }
  function refreshReplies(tasks: unknown[], lists: unknown[]) {
    reply('GET /api/tasks', json({ tasks }));
    reply('GET /api/lists', json({ lists }));
    reply('GET /api/members', json({ members: fixtureMembers }));
  }

  test('the view follows Inbox in the picker, with or without shared lists, and is kept in the URL (AC-1, D-4)', async () => {
    signedIn([]);
    render(<App />);
    await ready();
    expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me']);
    await pick('Assigned to me');
    expect(location.search).toBe('?list=assigned');
    expect(selectedTab()).toEqual(['Assigned to me']);
    expect(viewTitle().textContent).toBe('Assigned to me');
    expect(screen.getByText('From shared lists')).toBeTruthy();
    // The view needs no request of its own.
    expect(calls.map((call) => `${call.method} ${call.path}`).filter((route) => !route.startsWith('GET /api/'))).toEqual([]);
    cleanup();

    // With shared lists the lists follow it, in creation order.
    history.replaceState(null, '', '/?list=assigned');
    signedIn([]);
    withLists(errands, home, groceries);
    render(<App />);
    await ready();
    await waitFor(() =>
      expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Errands', 'Home (shared)', 'Groceries (shared)']),
    );
    expect(selectedTab()).toEqual(['Assigned to me']);
  });

  test('shows exactly the tasks assigned to the user in every shared list, grouped, with list names (AC-2, D-2)', async () => {
    await openAssigned([
      task(1, 'Mine in Home', 11, { ...mine, dueDate: '2020-01-01' }),
      task(2, 'Theirs for me', 12, { ...mine, createdById: 2 }),
      task(3, 'For two', 12, { assigneeId: 2 }),
      task(4, 'Nobody', 11),
      task(5, 'Inbox task', null),
      task(6, 'Errand', 10),
      task(7, 'Done for me', 13, { ...mine, completed: true, completedById: 2 }),
      task(8, 'Done for two', 13, { assigneeId: 2, completed: true, completedById: 2 }),
      // Only a task in a shared list has an assignee. One that says otherwise
      // (an older or inconsistent answer) is not the user's assignment.
      task(9, 'Stale in Inbox', null, mine),
      task(10, 'Stale unshared', 10, mine),
    ]);
    expect(taskTitles()).toEqual(['Mine in Home', 'Theirs for me']);
    expect(headings()).toEqual(['Overdue', 'No date']);
    expect(button('Show 1 done').getAttribute('aria-expanded')).toBe('false');
    // Each row names its list, and the share labels are those of "All tasks".
    expect(rowLabel('Mine in Home')).toBe('List: Home');
    expect(rowLabel('Theirs for me')).toBe('List: Groceries');
    expect(shareLabels('Mine in Home')).toBe('Assigned to you');
    expect(shareLabels('Theirs for me')).toBe('Added by Household Two · Assigned to you');
    await expandCompleted();
    expect(taskTitles()).toEqual(['Mine in Home', 'Theirs for me', 'Done for me']);
    expect(rowLabel('Done for me')).toBe('List: Work');
    expect(shareLabels('Done for me')).toBe('Done by Household Two · Assigned to you');
  });

  test('with no task assigned to the user the view says so in one sentence (AC-3)', async () => {
    await openAssigned([task(1, 'For two', 12, { assigneeId: 2 }), task(2, 'Inbox task', null)]);
    expect(screen.getByText(EMPTY)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    // The + button stays, and adds to Inbox.
    expect(await addDestination()).toBe('Inbox');
  });

  test('a task added from the view goes to Inbox with a notice and does not show (AC-5, D-5)', async () => {
    await openAssigned([task(1, 'Mine', 12, mine)]);
    reply('POST /api/tasks', json({ task: task(20, 'Call the plumber', null) }, 201));
    expect(await addDestination()).toBe('Inbox');
    await userEvent.type(await openAddSheet(), 'Call the plumber{Enter}');
    await waitFor(() => expect(status()).toBe('Added "Call the plumber" to Inbox.'));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Call the plumber' });
    expect(taskTitles()).toEqual(['Mine']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button('Add a task'));
    expect((await openAddSheet()).value).toBe('');
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Cancel' }));
    // It is in Inbox.
    await pick('Inbox');
    expect(taskTitles()).toEqual(['Call the plumber']);
  });

  test('a save that reassigns, unassigns or moves a task out removes it with a notice; focus moves on (AC-4)', async () => {
    await openAssigned([
      task(1, 'Alpha', 12, mine),
      task(2, 'Bravo', 12, mine),
      task(3, 'Charlie', 12, mine),
      task(4, 'Delta', 12, mine),
    ]);
    expect(taskTitles()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);

    // Moved to another shared list, still assigned to the user: it stays.
    reply('PATCH /api/tasks/4', json({ task: task(4, 'Delta', 11, mine) }));
    await startEditing('Delta');
    await userEvent.selectOptions(listField('Delta'), 'Home (shared)');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(rowLabel('Delta')).toBe('List: Home'));
    expect(callsTo('PATCH /api/tasks/4')[0].body).toEqual({ listId: 11 });
    expect(status()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Delta"')));

    // Reassigned: the next row takes focus.
    reply('PATCH /api/tasks/2', json({ task: task(2, 'Bravo', 12, { assigneeId: 2 }) }));
    await startEditing('Bravo');
    await userEvent.selectOptions(assigneeField('Bravo'), 'Household Two');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(taskTitles()).toEqual(['Alpha', 'Charlie', 'Delta']));
    expect(callsTo('PATCH /api/tasks/2')[0].body).toEqual({ assigneeId: 2 });
    expect(status()).toBe('"Bravo" is now assigned to Household Two.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Charlie' })));

    // Unassigned, the last row: the previous row takes focus.
    reply('PATCH /api/tasks/4', json({ task: task(4, 'Delta', 11) }));
    await startEditing('Delta');
    await userEvent.selectOptions(assigneeField('Delta'), 'Nobody');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(taskTitles()).toEqual(['Alpha', 'Charlie']));
    expect(callsTo('PATCH /api/tasks/4')[1].body).toEqual({ assigneeId: null });
    expect(status()).toBe('"Delta" is no longer assigned to you.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Charlie' })));

    // Moved out of the shared list, which clears the assignee.
    reply('PATCH /api/tasks/3', json({ task: task(3, 'Charlie', 10) }));
    await startEditing('Charlie');
    await userEvent.selectOptions(listField('Charlie'), 'Errands');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(taskTitles()).toEqual(['Alpha']));
    expect(callsTo('PATCH /api/tasks/3')[0].body).toEqual({ listId: 10 });
    expect(status()).toBe('Moved "Charlie" to Errands, so it is no longer assigned to you.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Alpha' })));

    // The last one, to Inbox: focus goes to the + button.
    reply('PATCH /api/tasks/1', json({ task: task(1, 'Alpha', null) }));
    await startEditing('Alpha');
    await userEvent.selectOptions(listField('Alpha'), 'Inbox');
    await userEvent.click(button('Save'));
    await waitFor(() => expect(screen.getByText(EMPTY)).toBeTruthy());
    expect(status()).toBe('Moved "Alpha" to Inbox, so it is no longer assigned to you.');
    await waitFor(() => expect(document.activeElement).toBe(button('Add a task')));
    expect(selectedTab()).toEqual(['Assigned to me']);
  });

  test('an edit that keeps the assignee, and a rename, stay in the view without a notice (AC-4)', async () => {
    await openAssigned([task(1, 'Alpha', 12, mine)]);
    reply('PATCH /api/tasks/1', json({ task: task(1, 'Alpha two', 12, mine) }));
    const field = await startEditing('Alpha');
    await userEvent.type(field, ' two{Enter}');
    await waitFor(() => expect(taskTitles()).toEqual(['Alpha two']));
    expect(status()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button('Edit "Alpha two"')));
  });

  test('complete, reopen and delete work in the view (AC-4)', async () => {
    await openAssigned([task(1, 'Alpha', 12, mine), task(2, 'Bravo', 12, mine)]);
    reply('PATCH /api/tasks/1', json({ task: task(1, 'Alpha', 12, { ...mine, completed: true, completedById: 1 }) }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
    await waitFor(() => expect(status()).toBe('"Alpha" was moved to Completed.'));
    expect(taskTitles()).toEqual(['Bravo']);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Bravo' })));
    await expandCompleted();
    reply('PATCH /api/tasks/1', json({ task: task(1, 'Alpha', 12, mine) }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Completed/ })).toBeNull());
    expect(callsTo('PATCH /api/tasks/1').map((call) => call.body)).toEqual([
      { completed: true, today: expect.any(String) },
      { completed: false },
    ]);
    expect(taskTitles()).toEqual(['Alpha', 'Bravo']);

    reply('DELETE /api/tasks/1', new Response(null, { status: 204 }));
    await userEvent.click(button('Delete "Alpha"'));
    await userEvent.click(button('Confirm deleting "Alpha"'));
    await waitFor(() => expect(taskTitles()).toEqual(['Bravo']));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Bravo' })));
  });

  test('completing a repeating task shows its next occurrence in the view (AC-4)', async () => {
    const weekly = { every: 1, unit: 'week' };
    await openAssigned([task(1, 'Water the plants', 12, { ...mine, dueDate: '2099-01-01', repeat: weekly })]);
    reply(
      'PATCH /api/tasks/1',
      json({
        task: task(1, 'Water the plants', 12, { ...mine, dueDate: '2099-01-01', repeat: weekly, completed: true, completedById: 1 }),
        nextTask: task(9, 'Water the plants', 12, { ...mine, dueDate: '2099-01-08', repeat: weekly }),
        removedTaskId: null,
      }),
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Water the plants' }));
    await waitFor(() => expect(status()).toMatch(/^"Water the plants" is next due /));
    expect(taskTitles()).toEqual(['Water the plants']);
    expect(headings()).toEqual(['Upcoming']);
    expect(button('Show 1 done')).toBeTruthy();
    expect(rowLabel('Water the plants')).toBe('List: Groceries');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Water the plants' })));
    expect((document.activeElement as HTMLInputElement).checked).toBe(false);
  });

  test('a refresh adds and removes rows as others assign, unassign, move, unshare and delete; focus moves on (AC-6)', async () => {
    await openAssigned([task(1, 'Alpha', 12, mine), task(2, 'Bravo', 12, mine), task(3, 'Charlie', 13, mine)]);
    await userEvent.type(await openAddSheet(), 'Half typed');
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Cancel' }));
    act(() => button('Edit "Alpha"').focus());

    // Another member assigned Delta to the user and unassigned Alpha.
    refreshReplies(
      [task(4, 'Delta', 11, { ...mine, createdById: 2 }), task(1, 'Alpha', 12), task(2, 'Bravo', 12, mine), task(3, 'Charlie', 13, mine)],
      [errands, home, groceries, work],
    );
    await refreshOnFocus();
    await waitFor(() => expect(taskTitles()).toEqual(['Delta', 'Bravo', 'Charlie']));
    // Focus was in Alpha's row: the next row that is still shown takes it.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Bravo' })));
    expect(status()).toBeNull();

    // Bravo moved to an unshared list of the user's (which cleared the
    // assignee), Work stopped being shared with the user (Charlie went with it).
    refreshReplies([task(4, 'Delta', 11, { ...mine, createdById: 2 }), task(2, 'Bravo', 10)], [errands, home, groceries]);
    await refreshOnFocus();
    await waitFor(() => expect(taskTitles()).toEqual(['Delta']));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Delta' })));

    // Delta was deleted and Groceries was deleted: nothing is left. The view
    // stays, since it can never be gone.
    refreshReplies([task(2, 'Bravo', 10)], [errands, home]);
    await refreshOnFocus();
    await waitFor(() => expect(screen.getByText(EMPTY)).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(button('Add a task')));
    expect(selectedTab()).toEqual(['Assigned to me']);
    expect(location.search).toBe('?list=assigned');
    expect(status()).toBeNull();
    // The add sheet's draft survived every refresh.
    expect((await openAddSheet()).value).toBe('Half typed');
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  test('a refresh keeps an open edit row as other views do; its save then removes it with a notice (AC-6)', async () => {
    await openAssigned([task(1, 'Alpha', 12, mine), task(2, 'Bravo', 12, mine)]);
    const field = await startEditing('Alpha');
    await userEvent.type(field, ' draft');
    field.setSelectionRange(1, 3);

    // Another member reassigned Alpha meanwhile: the edit row, its draft and
    // focus stay.
    refreshReplies([task(1, 'Alpha', 12, { assigneeId: 2 }), task(2, 'Bravo', 12, mine)], [errands, home, groceries, work]);
    await refreshOnFocus();
    await waitFor(() => expect(callsTo('GET /api/tasks')).toHaveLength(2));
    await act(async () => {});
    expect(taskTitles()).toEqual(['editing: Alpha draft', 'Bravo']);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([1, 3]);

    // Saving stores the title; the server answer is not the user's any more.
    reply('PATCH /api/tasks/1', json({ task: task(1, 'Alpha draft', 12, { assigneeId: 2 }) }));
    await userEvent.click(button('Save'));
    await waitFor(() => expect(taskTitles()).toEqual(['Bravo']));
    expect(callsTo('PATCH /api/tasks/1')[0].body).toEqual({ title: 'Alpha draft' });
    expect(status()).toBe('"Alpha draft" is now assigned to Household Two.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Bravo' })));
  });

  test('a refresh that deletes or unshares the list of an open row closes it with a notice; focus moves on (AC-6)', async () => {
    await openAssigned([task(1, 'Alpha', 11, mine), task(2, 'Bravo', 12, mine), task(3, 'Charlie', 13, mine)]);
    const field = await startEditing('Alpha');
    await userEvent.type(field, ' draft');

    // Another member deleted Home: Alpha (the user added it) is in the
    // user's Inbox now, unassigned.
    refreshReplies([task(1, 'Alpha', null), task(2, 'Bravo', 12, mine), task(3, 'Charlie', 13, mine)], [errands, groceries, work]);
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /^New title for/ })).toBeNull());
    expect(taskTitles()).toEqual(['Bravo', 'Charlie']);
    expect(status()).toBe('"Alpha" is no longer assigned to you, because its list was deleted or is no longer shared.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Bravo' })));
    expect(selectedTab()).toEqual(['Assigned to me']);

    // A delete question on a task whose list the owner stopped sharing with
    // the user: the task is gone, and the row closes with the usual notice.
    await userEvent.click(button('Delete "Charlie"'));
    refreshReplies([task(1, 'Alpha', null), task(2, 'Bravo', 12, mine)], [errands, groceries]);
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm deleting "Charlie"' })).toBeNull());
    expect(taskTitles()).toEqual(['Bravo']);
    expect(status()).toBe('"Charlie" is no longer shared with you.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Bravo' })));

    // An own list that stopped being shared keeps its tasks, unassigned.
    reply('GET /api/tasks', json({ tasks: [task(1, 'Alpha', null), task(2, 'Bravo', 12, mine), task(5, 'Echo', 11, mine)] }));
    reply('GET /api/lists', json({ lists: [errands, home, groceries] }));
    reply('GET /api/members', json({ members: fixtureMembers }));
    await refreshOnFocus();
    await waitFor(() => expect(taskTitles()).toEqual(['Bravo', 'Echo']));
    await userEvent.click(button('Delete "Echo"'));
    refreshReplies(
      [task(1, 'Alpha', null), task(2, 'Bravo', 12, mine), task(5, 'Echo', 11)],
      [errands, { ...home, shared: false }, groceries],
    );
    await refreshOnFocus();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm deleting "Echo"' })).toBeNull());
    expect(taskTitles()).toEqual(['Bravo']);
    expect(status()).toBe('"Echo" is no longer assigned to you, because its list was deleted or is no longer shared.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Bravo' })));
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  // A change made here in Manage lists, without a save, can take the task of
  // an open edit row or delete question out of the view. The row closes with
  // the notice a refresh shows for the same change, focus stays in Manage
  // lists, and nothing stays open on a row nobody sees: a later refresh takes
  // the server's version of the task instead of keeping it pinned.
  const garden = list(14, 'Garden', { shared: true });
  const unassignedNotice = (title: string) =>
    `"${title}" is no longer assigned to you, because its list was deleted or is no longer shared.`;
  const inManage = () => document.getElementById('manage-lists')?.contains(document.activeElement) ?? false;
  const shown = (title: string) => screen.queryByRole('checkbox', { name: title }) !== null;

  test('stopping sharing an own list closes an open edit row or delete question of its task with a notice (tasks-assigned-to-me R1-F1)', async () => {
    await openAssigned(
      [task(1, 'Alpha', 11, mine), task(2, 'Bravo', 12, mine), task(4, 'Delta', 14, { ...mine, createdById: 2 })],
      [errands, home, groceries, work, garden],
    );
    const field = await startEditing('Alpha');
    await userEvent.type(field, ' draft');
    await openManage();
    reply('PATCH /api/lists/11', json({ list: { ...home, shared: false } }));
    await userEvent.click(button('Stop sharing "Home"'));
    await waitFor(() => expect(tabNames()).toContain('Home'));
    expect(screen.queryByRole('textbox', { name: /^New title for/ })).toBeNull();
    expect(shown('Alpha')).toBe(false);
    expect(shown('Bravo')).toBe(true);
    expect(status()).toBe(unassignedNotice('Alpha'));
    expect(document.activeElement).toBe(button('Share "Home" with household'));

    // The same for a delete question, on a task another member added.
    await userEvent.click(button('Delete "Delta"'));
    reply('PATCH /api/lists/14', json({ list: { ...garden, shared: false } }));
    await userEvent.click(button('Stop sharing "Garden"'));
    await waitFor(() => expect(tabNames()).toContain('Garden'));
    expect(screen.queryByRole('button', { name: 'Confirm deleting "Delta"' })).toBeNull();
    expect(shown('Delta')).toBe(false);
    expect(status()).toBe(unassignedNotice('Delta'));
    expect(document.activeElement).toBe(button('Share "Garden" with household'));

    refreshReplies(
      [task(1, 'Alpha renamed', 11), task(2, 'Bravo', 12, mine), task(4, 'Delta renamed', 14, { createdById: 2 })],
      [errands, { ...home, shared: false }, groceries, work, { ...garden, shared: false }],
    );
    await refreshOnFocus();
    await pick('Home');
    await waitFor(() => expect(shown('Alpha renamed')).toBe(true));
    await pick('Garden');
    expect(shown('Delta renamed')).toBe(true);
  });

  test('deleting an own shared list closes an open edit row or delete question of its task with a notice (tasks-assigned-to-me R1-F1)', async () => {
    await openAssigned(
      [task(1, 'Alpha', 11, mine), task(2, 'Bravo', 12, mine), task(4, 'Delta', 14, { ...mine, createdById: 2 })],
      [errands, home, groceries, work, garden],
    );
    const field = await startEditing('Alpha');
    await userEvent.type(field, ' draft');
    await openManage();
    // Alpha, added by the user, moves to the user's Inbox.
    reply('DELETE /api/lists/11', json({ movedTaskIds: [1] }));
    await userEvent.click(button('Delete list "Home"'));
    await userEvent.click(button('Confirm deleting list "Home"'));
    await waitFor(() => expect(tabNames()).not.toContain('Home (shared)'));
    expect(screen.queryByRole('textbox', { name: /^New title for/ })).toBeNull();
    expect(shown('Alpha')).toBe(false);
    expect(status()).toBe(unassignedNotice('Alpha'));
    expect(inManage()).toBe(true);

    // Delta, added by another member, goes to that member's Inbox.
    await userEvent.click(button('Delete "Delta"'));
    reply('DELETE /api/lists/14', json({ movedTaskIds: [4] }));
    await userEvent.click(button('Delete list "Garden"'));
    await userEvent.click(button('Confirm deleting list "Garden"'));
    await waitFor(() => expect(tabNames()).not.toContain('Garden (shared)'));
    expect(screen.queryByRole('button', { name: 'Confirm deleting "Delta"' })).toBeNull();
    expect(shown('Delta')).toBe(false);
    expect(shown('Bravo')).toBe(true);
    expect(status()).toBe(unassignedNotice('Delta'));
    expect(inManage()).toBe(true);

    refreshReplies([task(1, 'Alpha renamed', null), task(2, 'Bravo', 12, mine)], [errands, groceries, work]);
    await refreshOnFocus();
    await pick('Inbox');
    await waitFor(() => expect(shown('Alpha renamed')).toBe(true));
  });

  test('stopping sharing someone else\'s list closes an open edit row or delete question of its task with a notice (tasks-assigned-to-me R1-F1)', async () => {
    await openAssigned([task(1, 'Alpha', 11, mine), task(2, 'Bravo', 12, mine), task(3, 'Charlie', 13, mine)]);
    const field = await startEditing('Bravo');
    await userEvent.type(field, ' draft');
    await openManage();
    reply('PATCH /api/lists/12', json({ list: { ...groceries, shared: false } }));
    await userEvent.click(button('Stop sharing "Groceries"'));
    await userEvent.click(button('Confirm stopping sharing "Groceries"'));
    await waitFor(() => expect(tabNames()).not.toContain('Groceries (shared)'));
    expect(screen.queryByRole('textbox', { name: /^New title for/ })).toBeNull();
    expect(shown('Bravo')).toBe(false);
    expect(status()).toBe('"Groceries" is no longer shared with you, so it was removed. "Bravo" is no longer shared with you.');
    expect(inManage()).toBe(true);

    await userEvent.click(button('Delete "Charlie"'));
    reply('PATCH /api/lists/13', json({ list: { ...work, shared: false } }));
    await userEvent.click(button('Stop sharing "Work"'));
    await userEvent.click(button('Confirm stopping sharing "Work"'));
    await waitFor(() => expect(tabNames()).not.toContain('Work (shared)'));
    expect(screen.queryByRole('button', { name: 'Confirm deleting "Charlie"' })).toBeNull();
    expect(shown('Charlie')).toBe(false);
    expect(shown('Alpha')).toBe(true);
    expect(status()).toBe('"Work" is no longer shared with you, so it was removed. "Charlie" is no longer shared with you.');
    expect(inManage()).toBe(true);

    // The lists are shared with the user again and the tasks come back by
    // refresh. A question left hidden on Charlie would show again.
    refreshReplies(
      [task(1, 'Alpha', 11, mine), task(2, 'Bravo', 12, mine), task(3, 'Charlie', 13, mine)],
      [errands, home, groceries, work],
    );
    await refreshOnFocus();
    await waitFor(() => expect(shown('Charlie')).toBe(true));
    expect(screen.queryByRole('button', { name: 'Confirm deleting "Charlie"' })).toBeNull();
  });

  test('a Manage lists change that finds an own shared list gone closes an open edit row or delete question of its task with a notice (tasks-assigned-to-me R1-F1)', async () => {
    await openAssigned(
      [task(1, 'Alpha', 11, mine), task(2, 'Bravo', 12, mine), task(4, 'Delta', 14, mine)],
      [errands, home, groceries, work, garden],
    );
    const field = await startEditing('Alpha');
    await userEvent.type(field, ' draft');
    await openManage();
    // The list was deleted in another tab: it goes as if deleted, and a
    // refresh then shows where its tasks went.
    reply('PATCH /api/lists/11', json({ error: 'list_not_found', message: 'That list could not be found.' }, 404));
    refreshReplies(
      [task(1, 'Alpha renamed', null), task(2, 'Bravo', 12, mine), task(4, 'Delta', 14, mine)],
      [errands, groceries, work, garden],
    );
    await userEvent.click(button('Stop sharing "Home"'));
    await waitFor(() => expect(tabNames()).not.toContain('Home (shared)'));
    expect(screen.queryByRole('textbox', { name: /^New title for/ })).toBeNull();
    expect(shown('Alpha')).toBe(false);
    expect(status()).toBe(`"Home" no longer exists, so it was removed. ${unassignedNotice('Alpha')}`);
    expect(inManage()).toBe(true);
    await waitFor(() => expect(callsTo('GET /api/tasks')).toHaveLength(2));

    await userEvent.click(button('Delete "Delta"'));
    reply('DELETE /api/lists/14', json({ error: 'list_not_found', message: 'That list could not be found.' }, 404));
    refreshReplies(
      [task(1, 'Alpha renamed', null), task(2, 'Bravo', 12, mine), task(4, 'Delta renamed', null)],
      [errands, groceries, work],
    );
    await userEvent.click(button('Delete list "Garden"'));
    await userEvent.click(button('Confirm deleting list "Garden"'));
    await waitFor(() => expect(tabNames()).not.toContain('Garden (shared)'));
    expect(screen.queryByRole('button', { name: 'Confirm deleting "Delta"' })).toBeNull();
    expect(shown('Delta')).toBe(false);
    expect(status()).toBe(`"Garden" no longer exists, so it was removed. ${unassignedNotice('Delta')}`);
    expect(inManage()).toBe(true);
    await waitFor(() => expect(callsTo('GET /api/tasks')).toHaveLength(3));

    // Neither task stayed pinned by a hidden row: Inbox shows the server's versions.
    await pick('Inbox');
    await waitFor(() => expect(shown('Alpha renamed')).toBe(true));
    expect(shown('Delta renamed')).toBe(true);
  });

  test('"Assigned to me" is a reserved list name; a list stored with it still shows and can be renamed away (AC-7)', async () => {
    signedIn([]);
    withLists(list(14, 'Assigned to me'), list(15, 'Spare'));
    reply('PATCH /api/lists/14', json({ list: list(14, 'Mine') }));
    render(<App />);
    await ready();
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Assigned to me', 'Spare']));
    // The built-in view comes first; the list's item shows the list.
    const menu = await openPicker();
    const [builtIn, stored] = within(menu).getAllByRole('menuitemradio', { name: 'Assigned to me' });
    expect(builtIn.id).toBe('view-item-assigned');
    await userEvent.click(stored);
    expect(location.search).toBe('?list=14');

    await openManage();
    const nameField = (name: string) => screen.getByRole('textbox', { name: `New name for "${name}"` }) as HTMLInputElement;
    // Another list cannot take the name, in any form with the same fold.
    await userEvent.click(button('Rename "Spare"'));
    for (const typed of ['assigned to me', 'Assigned to​ ME', 'Ａssigned to me']) {
      fireEvent.change(nameField('Spare'), { target: { value: typed } });
      await userEvent.type(nameField('Spare'), '{Enter}');
      expect(screen.getByRole('alert').textContent).toBe(
        '"Inbox", "All tasks" and "Assigned to me" are built in. Choose another name.',
      );
    }
    // Names that only contain it are fine (checked before any request).
    fireEvent.change(nameField('Spare'), { target: { value: 'Assigned to me later' } });
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(button('Cancel renaming "Spare"'));
    // The stored list keeps its name without a request, and can be renamed away.
    await userEvent.click(button('Rename "Assigned to me"'));
    await userEvent.type(nameField('Assigned to me'), '{Enter}');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    await userEvent.click(button('Rename "Assigned to me"'));
    fireEvent.change(nameField('Assigned to me'), { target: { value: 'Mine' } });
    await userEvent.type(nameField('Assigned to me'), '{Enter}');
    await waitFor(() => expect(tabNames()).toEqual(['All tasks', 'Inbox', 'Assigned to me', 'Mine', 'Spare']));
    expect(callsTo('PATCH /api/lists/14')[0].body).toEqual({ name: 'Mine' });
  });
});

describe('calm layout', () => {
  const list = (id: number, name: string, { shared = false, ownerId = 1 } = {}) => ({
    id,
    name,
    shared,
    ownerId,
    createdAt: '2026-11-20T12:00:00.000Z',
    updatedAt: '2026-11-20T12:00:00.000Z',
  });
  const errands = list(10, 'Errands');
  const home = list(11, 'Home', { shared: true });
  const groceries = list(12, 'Groceries', { shared: true, ownerId: 2 });
  const task = (id: number, title: string, listId: number | null, extra: Record<string, unknown> = {}) => ({
    id,
    title,
    listId,
    notes: null,
    completed: false,
    dueDate: null,
    repeat: null,
    createdById: 1,
    completedById: null,
    assigneeId: null,
    ...extra,
  });
  const withLists = (...lists: unknown[]) => reply('GET /api/lists', json({ lists }));
  const addButtonEl = () => screen.getByRole('button', { name: 'Add a task' });
  const status = () => screen.queryByRole('status')?.textContent ?? null;
  async function refreshOnFocus() {
    const before = callsTo('GET /api/members').length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(callsTo('GET /api/members')).toHaveLength(before + 1));
  }
  function refreshReplies(tasks: unknown[], lists: unknown[]) {
    reply('GET /api/tasks', json({ tasks }));
    reply('GET /api/lists', json({ lists }));
    reply('GET /api/members', json({ members: fixtureMembers }));
  }
  // The browser's date is fixed (the time keeps running), so "Today" is known.
  function fixToday() {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 20, 12, 0, 0));
    onTestFinished(() => {
      vi.useRealTimers();
    });
  }

  test('the page is one column: the view title, the kicker and open count, the account, the tasks and the + button (AC-1)', async () => {
    signedIn([task(1, 'Mow', 11), task(2, 'Done', null, { completed: true })]);
    withLists(errands, home);
    render(<App />);
    await ready();
    // No rail of tabs and no add form on the page.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'New task' })).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('All tasks');
    expect(screen.getByText('Every list')).toBeTruthy();
    expect(screen.getByText(/1 open/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Household One, account' })).toBeTruthy();
    expect(addButtonEl().getAttribute('aria-haspopup')).toBe('dialog');
    expect(addButtonEl().getAttribute('aria-expanded')).toBe('false');
    expect(button('Show 1 done')).toBeTruthy();
    // The skip link leads to the task column.
    const skip = screen.getByRole('link', { name: 'Skip to tasks' });
    expect(document.querySelector(skip.getAttribute('href')!)).toBe(screen.getByRole('main'));
    // The Tasks wordmark is gone from the signed-in screen (D-7).
    expect(screen.queryByText('Tasks', { selector: 'span' })).toBeNull();
  });

  test('the + button opens the "New task" dialog with focus in its title; Tab stays inside; Escape, Cancel and the backdrop close it and keep the draft (AC-4, D-3)', async () => {
    signedIn([task(1, 'Mow', null)]);
    render(<App />);
    await ready();
    const title = await openAddSheet();
    const sheet = addSheet();
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(title);
    expect(within(sheet).getByLabelText('New task')).toBe(title);
    expect(addButtonEl().getAttribute('aria-expanded')).toBe('true');
    // The page behind the sheet is inert.
    expect(screen.getByRole('main').closest('[inert]')).toBeTruthy();
    expect(addButtonEl().hasAttribute('inert')).toBe(true);

    // Tab and Shift+Tab wrap around inside the sheet.
    const addTask = within(sheet).getByRole('button', { name: 'Add task' });
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(addTask);
    await userEvent.tab();
    expect(document.activeElement).toBe(title);
    for (let presses = 0; presses < 8; presses++) {
      await userEvent.tab();
      expect(sheet.contains(document.activeElement)).toBe(true);
    }

    // A draft with a title and a date; Escape closes, focus returns to +.
    await userEvent.type(title, 'Draft title');
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-11-24' } });
    act(() => title.focus());
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(addButtonEl());
    expect(screen.getByRole('main').closest('[inert]')).toBeNull();
    // Reopened: the draft is still there. Cancel closes too.
    expect((await openAddSheet()).value).toBe('Draft title');
    expect(chip('Due date').getAttribute('aria-label')).not.toBe('Due date: none');
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(addButtonEl());
    // So does a click on the backdrop.
    await openAddSheet();
    await userEvent.click(document.querySelector<HTMLElement>('.tk-scrim')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(addButtonEl());
    expect(callsTo('POST /api/tasks')).toHaveLength(0);
  });

  test('chips name their values; Date offers Today, Tomorrow and Next week; List offers Inbox and every list; clears are named (AC-6)', async () => {
    fixToday();
    history.replaceState(null, '', '/?list=10');
    signedIn([task(1, 'Mow', 10)]);
    withLists(errands, home, groceries);
    reply('POST /api/tasks', json({ task: task(7, 'Rake leaves', 11, { dueDate: '2026-11-27' }) }, 201));
    render(<App />);
    await ready();
    await waitFor(() => expect(selectedTab()).toEqual(['Errands']));
    const title = await openAddSheet();
    // Each chip is a button whose name states its value; only set ones can be cleared.
    expect(
      within(addSheet())
        .getAllByRole('button', { name: /: / })
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['Due date: none', 'List: Errands', 'Notes: none']);
    expect(within(addSheet()).queryByRole('button', { name: /^Clear/ })).toBeNull();

    await openChip('Due date');
    const options = document.getElementById(chip('Due date').getAttribute('aria-controls')!)!;
    const date = within(options).getByLabelText('Due date') as HTMLInputElement;
    expect(date.type).toBe('date');
    await userEvent.click(within(options).getByRole('button', { name: 'Today' }));
    expect(date.value).toBe('2026-11-20');
    expect(chip('Due date').getAttribute('aria-label')).toBe('Due date: Today');
    expect(within(options).getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(within(options).getByRole('button', { name: 'Tomorrow' }));
    expect(date.value).toBe('2026-11-21');
    expect(chip('Due date').getAttribute('aria-label')).toBe('Due date: Tomorrow');
    await userEvent.click(within(options).getByRole('button', { name: 'Next week' }));
    expect(date.value).toBe('2026-11-27');
    expect(chip('Due date').getAttribute('aria-label')).toMatch(/^Due date: \S+, \S+ 27$/);
    // The Repeat chip comes with the date; the date's clear control takes both away.
    await openChip('Repeat');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Repeats' }), 'monthly');
    expect(chip('Repeat').getAttribute('aria-label')).toBe('Repeat: Monthly');
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Clear repeat' }));
    expect(chip('Repeat').getAttribute('aria-label')).toBe('Repeat: none');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Repeats' }), 'yearly');
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Clear due date' }));
    expect(chip('Due date').getAttribute('aria-label')).toBe('Due date: none');
    expect(within(addSheet()).queryByRole('button', { name: /^Repeat: / })).toBeNull();
    // One chip's options show at a time.
    expect(options.hidden).toBe(true);
    await openChip('Due date');
    await userEvent.click(within(options).getByRole('button', { name: 'Next week' }));
    expect(chip('Repeat').getAttribute('aria-label')).toBe('Repeat: none');

    // List: Inbox and every list the user can see, the shown one chosen.
    await openChip('List');
    const lists = within(addSheet()).getByRole('group', { name: 'List' });
    expect(within(lists).getAllByRole('button').map((item) => item.textContent)).toEqual([
      'Inbox',
      'Errands',
      'Home(shared)',
      'Groceries(shared)',
    ]);
    expect(within(lists).getByRole('button', { name: 'Errands' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(within(lists).getByRole('button', { name: 'Home (shared)' }));
    expect(chip('List').getAttribute('aria-label')).toBe('List: Home');

    // The task goes there with exactly the chosen fields, and a notice says
    // where, since it is not in the view shown.
    await userEvent.type(title, 'Rake leaves{Enter}');
    await waitFor(() => expect(status()).toBe('Added "Rake leaves" to Home.'));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Rake leaves', dueDate: '2026-11-27', listId: 11 });
    expect(taskTitles()).toEqual(['Mow']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(addButtonEl());
    // The next draft follows the view again.
    await openAddSheet();
    expect(chip('List').getAttribute('aria-label')).toBe('List: Errands');
  });

  test('a chosen list follows no view change, and one that goes away gives way to the view\'s list (AC-5, D-5)', async () => {
    signedIn([]);
    withLists(errands, home);
    render(<App />);
    await ready();
    await openAddSheet();
    expect(chip('List').getAttribute('aria-label')).toBe('List: Inbox');
    await openChip('List');
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Errands' }));
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Cancel' }));
    await pick('Home (shared)');
    await openAddSheet();
    // Kept as chosen, not the view's list.
    expect(chip('List').getAttribute('aria-label')).toBe('List: Errands');
    // Errands is deleted elsewhere: the draft adds to the view's list again.
    refreshReplies([], [home]);
    await refreshOnFocus();
    await waitFor(() => expect(chip('List').getAttribute('aria-label')).toBe('List: Home'));
  });

  test('controls of the sheet lock while the add is pending, and a failed add keeps the sheet and its draft (AC-5)', async () => {
    signedIn([]);
    const create = pending();
    reply('POST /api/tasks', create.response);
    render(<App />);
    await ready();
    const title = await openAddSheet();
    await userEvent.type(title, 'Slow');
    await openChip('Notes');
    const notes = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    await userEvent.type(notes, 'Kept');
    await userEvent.click(within(addSheet()).getByRole('button', { name: 'Add task' }));
    const sheet = addSheet();
    // Locked with readOnly and aria-disabled, never disabled.
    expect(title.readOnly).toBe(true);
    expect(notes.readOnly).toBe(true);
    expect(within(sheet).getByRole('button', { name: 'Adding...' }).getAttribute('aria-disabled')).toBe('true');
    expect(within(sheet).getByRole('button', { name: 'Cancel' }).getAttribute('aria-disabled')).toBe('true');
    expect(within(sheet).getByRole('button', { name: 'Clear notes' }).getAttribute('aria-disabled')).toBe('true');
    expect([...sheet.querySelectorAll('button, input, textarea')].some((control) => (control as HTMLButtonElement).disabled)).toBe(false);
    // A second submit, a clear, Cancel and the backdrop change nothing.
    fireEvent.submit(sheet);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Clear notes' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(document.querySelector<HTMLElement>('.tk-scrim')!);
    expect(notes.value).toBe('Kept');
    expect(screen.getByRole('dialog', { name: 'New task' })).toBe(sheet);
    expect(callsTo('POST /api/tasks')).toHaveLength(1);
    create.finish(json({ error: 'internal_error' }, 500));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('The task could not be saved. Please try again.');
    expect(title.value).toBe('Slow');
    expect(notes.value).toBe('Kept');
    await waitFor(() => expect(title.readOnly).toBe(false));
  });

  describe('focus targets that leave the page (AC-8)', () => {
    test('the last row deleted by a user, or by a refresh, sends focus to the + button; a refresh with the sheet open leaves focus in it', async () => {
      signedIn([task(1, 'Only', 12, { createdById: 2 })]);
      withLists(groceries);
      reply('DELETE /api/tasks/1', noContent());
      render(<App />);
      await ready();
      // By a user (the view keeps the + button as the last resort).
      await userEvent.click(button('Delete "Only"'));
      await userEvent.click(button('Confirm deleting "Only"'));
      await waitFor(() => expect(document.activeElement).toBe(addButtonEl()));

      // By a refresh: another member deleted it while focus was on its row.
      refreshReplies([task(2, 'Second', 12, { createdById: 2 })], [groceries]);
      await refreshOnFocus();
      await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Second' })).toBeTruthy());
      act(() => screen.getByRole('checkbox', { name: 'Second' }).focus());
      refreshReplies([], [groceries]);
      await refreshOnFocus();
      await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Second' })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(addButtonEl()));

      // With the sheet open: focus stays in it, and it stays open with its draft.
      refreshReplies([task(3, 'Third', 12, { createdById: 2 })], [groceries]);
      await refreshOnFocus();
      await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Third' })).toBeTruthy());
      const title = await openAddSheet();
      await userEvent.type(title, 'Typing');
      refreshReplies([], [groceries]);
      await refreshOnFocus();
      await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Third' })).toBeNull());
      expect(document.activeElement).toBe(title);
      expect(title.value).toBe('Typing');
      expect(addSheet()).toBeTruthy();
    });

    test('a refresh that takes away the List option with focus moves it to the List chip, inside the open sheet', async () => {
      history.replaceState(null, '', '/?list=12');
      signedIn([]);
      withLists(errands, groceries);
      render(<App />);
      await ready();
      await openAddSheet();
      await openChip('List');
      const option = within(addSheet()).getByRole('button', { name: 'Groceries (shared)' });
      act(() => option.focus());
      refreshReplies([], [errands]);
      await refreshOnFocus();
      await waitFor(() => expect(option.isConnected).toBe(false));
      await waitFor(() => expect(document.activeElement).toBe(chip('List')));
      expect(chip('List').getAttribute('aria-label')).toBe('List: Inbox');
      expect(addSheet()).toBeTruthy();
      expect(selectedTab()).toEqual(['Inbox']);
    });

    test('a refresh that takes away the shown list leaves focus on the view title, open picker or closed', async () => {
      history.replaceState(null, '', '/?list=12');
      signedIn([]);
      withLists(groceries, home);
      render(<App />);
      await ready();
      await waitFor(() => expect(selectedTab()).toEqual(['Groceries (shared)']));
      // Picker closed, focus on the title: the title stays and keeps focus.
      act(() => viewTitle().focus());
      refreshReplies([], [home]);
      await refreshOnFocus();
      await waitFor(() => expect(selectedTab()).toEqual(['Inbox']));
      expect(document.activeElement).toBe(viewTitle());
      expect(viewTitle().textContent).toBe('Inbox');
    });

    test('Manage lists going away while the picker is open moves focus from its item to the view title; Escape closes the menu', async () => {
      signedIn([]);
      withLists(groceries);
      render(<App />);
      await ready();
      await waitFor(() => expect(manageItem()).toBeTruthy());
      await userEvent.click(viewTitle());
      await userEvent.keyboard('{End}');
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Manage lists' }));
      refreshReplies([], []);
      await refreshOnFocus();
      await waitFor(() => expect(manageItem()).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(viewTitle()));
      expect(viewTitle().getAttribute('aria-expanded')).toBe('true');
      await userEvent.keyboard('{Escape}');
      expect(viewTitle().getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(viewTitle());
    });

    test('a refresh while the add sheet is open never moves focus out of it, even from the sheet itself', async () => {
      signedIn([task(1, 'Alpha', 12, { createdById: 2 }), task(2, 'Bravo', null)]);
      withLists(groceries);
      render(<App />);
      await ready();
      act(() => screen.getByRole('checkbox', { name: 'Alpha' }).focus());
      await openAddSheet();
      // A click on the sheet's surface keeps focus on the sheet, not the page.
      await userEvent.click(addSheet());
      expect(document.activeElement).toBe(addSheet());
      refreshReplies([task(2, 'Bravo', null)], []);
      await refreshOnFocus();
      await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Alpha' })).toBeNull());
      expect(document.activeElement).toBe(addSheet());
      expect(screen.getByRole('dialog', { name: 'New task' })).toBeTruthy();
    });

    test('at midnight, focus in the open sheet stays there', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(new Date(2026, 10, 20, 23, 59, 58));
      onTestFinished(() => {
        vi.useRealTimers();
      });
      signedIn([task(1, 'Due tomorrow', null, { dueDate: '2026-11-21' })]);
      render(<App />);
      await ready();
      await screen.findByRole('list', { name: 'Upcoming' });
      const title = await openAddSheet();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await waitFor(() => expect(screen.getByRole('list', { name: 'Today' })).toBeTruthy());
      expect(document.activeElement).toBe(title);
      expect(addSheet()).toBeTruthy();
    });
  });
});
