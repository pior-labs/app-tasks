import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { App } from './App';
import { dueLabel } from './dueDate';

type Reply = Response | Promise<Response> | (() => Response | Promise<Response>);
type Call = { method: string; path: string; body: unknown };

const signedInUser = { id: '1', name: 'Household One', email: 'one@example.test' };
const milk = { id: 1, title: 'Buy oat milk', completed: false, dueDate: null, repeat: null };
const plants = { id: 2, title: 'Water the plants', completed: true, dueDate: null, repeat: null };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Stub fetch with queued replies per "METHOD path"; an unexpected request fails the test.
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
// The Completed section starts collapsed; this opens it.
async function expandCompleted() {
  const toggle = await screen.findByRole('button', { name: /^Completed \(\d+\)$/ });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  await userEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
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
      if (!next) throw new Error(`Unexpected request: ${call.method} ${call.path}`);
      return typeof next === 'function' ? next() : next;
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
    expect(screen.getByText('Signed in as Household One')).toBeTruthy();
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
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  test('shows an empty state when there are no tasks', async () => {
    signedIn([]);
    render(<App />);
    expect(await screen.findByText('No tasks yet. Add your first one above.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('New task')).toBeTruthy();
  });

  test('shows a load failure with a retry action that recovers', async () => {
    signedIn(json({ error: 'internal_error' }, 500));
    reply('GET /api/tasks', () => Promise.reject(new TypeError('network down')), json({ tasks: [milk] }));
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toBe('Your tasks could not be loaded.');
    expect(screen.queryByText('No tasks yet. Add your first one above.')).toBeNull();
    expect(screen.queryByLabelText('New task')).toBeNull();

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
    const input = (await screen.findByLabelText('New task')) as HTMLInputElement;
    await userEvent.type(input, '  Call the plumber  ');
    await userEvent.click(screen.getByRole('button', { name: 'Add task' }));

    await waitFor(() => expect(taskTitles()).toEqual(['Call the plumber', 'Buy oat milk']));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Call the plumber' });
    expect((screen.getByRole('checkbox', { name: 'Call the plumber' }) as HTMLInputElement).checked).toBe(false);
    expect(input.value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('rejects empty and whitespace-only titles inline without a request', async () => {
    signedIn([milk]);
    render(<App />);
    const input = await screen.findByLabelText('New task');
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
    const input = await screen.findByLabelText('New task');
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
    const input = (await screen.findByLabelText('New task')) as HTMLInputElement;

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

  test('keeps focus in the title field and ignores repeat submits while saving', async () => {
    signedIn([milk]);
    let finish!: (response: Response) => void;
    reply(
      'POST /api/tasks',
      new Promise<Response>((resolve) => (finish = resolve)),
      json({ task: { id: 9, title: 'Second', completed: false, dueDate: null } }, 201),
    );
    render(<App />);
    const input = (await screen.findByLabelText('New task')) as HTMLInputElement;
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

    finish(json({ task: { id: 7, title: 'First', completed: false, dueDate: null } }, 201));
    await waitFor(() => expect(taskTitles()).toEqual(['First', 'Buy oat milk']));
    // The submit click moved focus to the button; a successful add returns it to the field.
    expect(document.activeElement).toBe(input);
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe('');

    await userEvent.keyboard('Second{Enter}');
    await waitFor(() => expect(taskTitles()).toEqual(['Second', 'First', 'Buy oat milk']));
    expect(callsTo('POST /api/tasks')).toHaveLength(2);
    expect(document.activeElement).toBe(input);
  });

  test('shows the server message when the server rejects the title', async () => {
    signedIn([milk]);
    reply('POST /api/tasks', json({ error: 'invalid_title', message: 'Enter a task title.' }, 400));
    render(<App />);
    const input = (await screen.findByLabelText('New task')) as HTMLInputElement;
    await userEvent.type(input, 'Rejected by server{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('Enter a task title.');
    expect(taskTitles()).toEqual(['Buy oat milk']);
    expect(input.value).toBe('Rejected by server');
  });

  test('shows a create failure and does not show the unsaved task as saved', async () => {
    signedIn([milk]);
    reply('POST /api/tasks', json({ error: 'internal_error' }, 500), () =>
      Promise.reject(new TypeError('network down')),
    );
    render(<App />);
    const input = (await screen.findByLabelText('New task')) as HTMLInputElement;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 1) await userEvent.type(input, 'Never saved');
      await userEvent.click(screen.getByRole('button', { name: 'Add task' }));
      expect((await screen.findByRole('alert')).textContent).toBe(
        'The task could not be saved. Please try again.',
      );
      await waitFor(() => expect(callsTo('POST /api/tasks')).toHaveLength(attempt));
      expect(taskTitles()).toEqual(['Buy oat milk']);
      // The typed title is kept so the user can retry.
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
    await waitFor(() => expect(document.activeElement).toBe(button('Completed (1)')));
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
    expect(screen.queryByRole('button', { name: /^Completed/ })).toBeNull();
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
const tea = { id: 3, title: 'Order tea', completed: false, dueDate: null, repeat: null };

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

  test('Confirm removes the row only after the server confirmed, then focuses the next row', async () => {
    signedIn([plants, milk, tea]);
    const removal = pending();
    reply('DELETE /api/tasks/1', removal.response);
    render(<App />);
    await expandCompleted();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete "Buy oat milk"' }));
    const confirm = button('Confirm deleting "Buy oat milk"');
    await userEvent.click(confirm);

    // Pending: the row is still there and its controls are locked but focusable.
    expect(taskTitles()).toEqual(['Buy oat milk', 'Order tea', 'Water the plants']);
    expect(confirm.textContent).toBe('Deleting...');
    expect(confirm.disabled).toBe(false);
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect(button('Cancel deleting "Buy oat milk"').getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(confirm);
    const checkbox = screen.getByRole('checkbox', { name: 'Buy oat milk' }) as HTMLInputElement;
    expect(checkbox.getAttribute('aria-disabled')).toBe('true');

    // Repeat input while pending: no second request, no cancel, no completion change.
    await userEvent.click(confirm);
    await userEvent.keyboard('{Enter}');
    await userEvent.click(button('Cancel deleting "Buy oat milk"'));
    await userEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(screen.getByText('Delete this task?')).toBeTruthy();
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([
      { method: 'DELETE', path: '/api/tasks/1', body: undefined },
    ]);

    removal.finish(noContent());
    await waitFor(() => expect(taskTitles()).toEqual(['Order tea', 'Water the plants']));
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Order tea' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('Delete this task?')).toBeNull();
  });

  test('after deleting the bottom row focus moves up; after the last task, to the new-task field', async () => {
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
    expect(await screen.findByText('No tasks yet. Add your first one above.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('New task'));
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
    expect(screen.queryByLabelText('New task')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText('Signed in as Household One')).toBeNull();
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
    await userEvent.type(await screen.findByLabelText('New task'), 'Too late{Enter}');
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
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
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
    await userEvent.type(screen.getByLabelText('New task'), 'In flight{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
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
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
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
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
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

    await userEvent.type(screen.getByLabelText('New task'), 'Call the plumber{Enter}');
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
      'Completed (2)',
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

    // Completed: collapsed by default, a button with aria-expanded and aria-controls.
    const toggle = button('Completed (2)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const controlled = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(controlled.tagName).toBe('UL');
    expect(controlled.hidden).toBe(true);
    expect(screen.queryByRole('checkbox', { name: 'Done and late' })).toBeNull();
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(controlled.hidden).toBe(false);
    expect(rowTitles(group(/^Completed/))).toEqual(['Done without date', 'Done and late']);
    expect(within(group(/^Completed/)).getAllByRole('checkbox').every((box) => (box as HTMLInputElement).checked)).toBe(true);
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
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
    expect(screen.queryByRole('button', { name: /^Completed/ })).toBeNull();
  });

  test('with only completed tasks there is no empty state, only the Completed section', async () => {
    signedIn([due(1, 'All done', '2026-11-19', true)]);
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Completed (1)' })).toBeTruthy();
    expect(screen.queryByText('No tasks yet. Add your first one above.')).toBeNull();
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
    const title = (await screen.findByLabelText('New task')) as HTMLInputElement;
    const date = screen.getByLabelText('Due date') as HTMLInputElement;
    expect(date.type).toBe('date');
    expect(date.min).toBe('2025-01-01');
    expect(date.max).toBe('2100-12-31');

    await userEvent.type(title, 'Call the plumber');
    fireEvent.change(date, { target: { value: '2026-11-21' } });
    await userEvent.click(button('Add task'));
    await waitFor(() => expect(rowTitles(group('Upcoming'))).toEqual(['Call the plumber']));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Call the plumber', dueDate: '2026-11-21' });
    expect(title.value).toBe('');
    expect(date.value).toBe('');
    await waitFor(() => expect(document.activeElement).toBe(title));

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
    const title = (await screen.findByLabelText('New task')) as HTMLInputElement;
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
    expect(button('Completed (1)').getAttribute('aria-expanded')).toBe('false');

    // The last visible row: focus moves up, across groups.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Third' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Third' })).toBeNull());
    expect(screen.getByRole('status').textContent).toBe('"Third" was moved to Completed.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'First' })));

    // No row left in view: focus moves to the Completed toggle. The overdue
    // task is now completed, so it is no longer marked overdue.
    await userEvent.click(screen.getByRole('checkbox', { name: 'First' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'First' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button('Completed (3)')));
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
    expect(callsTo('GET /api/tasks')).toHaveLength(1);
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
    expect(callsTo('GET /api/tasks')).toHaveLength(1);
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

  test('the add form sets a repeat only with a due date, with presets and Custom', async () => {
    signedIn([]);
    reply('POST /api/tasks', json({ task: task(1, 'Bins out', '2026-11-24', weekly) }, 201));
    reply('POST /api/tasks', json({ task: task(2, 'Gutters', '2026-11-30', { every: 2, unit: 'week' }) }, 201));
    reply('POST /api/tasks', json({ task: task(3, 'No repeat', '2026-11-30') }, 201));
    render(<App />);
    const title = (await screen.findByLabelText('New task')) as HTMLInputElement;
    const date = screen.getByLabelText('Due date') as HTMLInputElement;
    const repeats = select('Repeats');
    // No date yet: the control is marked unavailable, says why, and ignores changes.
    expect(repeats.value).toBe('none');
    expect(repeats.getAttribute('aria-disabled')).toBe('true');
    expect(repeats.disabled).toBe(false);
    const hint = screen.getByText('Set a due date to repeat');
    expect(repeats.getAttribute('aria-describedby')).toBe(hint.id);
    await userEvent.selectOptions(repeats, 'weekly');
    expect(repeats.value).toBe('none');
    expect([...repeats.options].map((option) => option.textContent)).toEqual([
      'Does not repeat',
      'Daily',
      'Weekly',
      'Monthly',
      'Yearly',
      'Custom',
    ]);

    // With a date it is available.
    await userEvent.type(title, 'Bins out');
    fireEvent.change(date, { target: { value: '2026-11-24' } });
    expect(repeats.getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByText('Set a due date to repeat')).toBeNull();
    await userEvent.selectOptions(repeats, 'weekly');
    expect(repeats.value).toBe('weekly');
    await userEvent.click(button('Add task'));
    await waitFor(() => expect(callsTo('POST /api/tasks')).toHaveLength(1));
    expect(callsTo('POST /api/tasks')[0].body).toEqual({ title: 'Bins out', dueDate: '2026-11-24', repeat: weekly });
    // Stored: the row shows it, and the form is reset, repeat included.
    await waitFor(() => expect(description('Bins out')).toMatch(/Repeats weekly$/));
    expect(select('Repeats').value).toBe('none');
    expect(select('Repeats').getAttribute('aria-disabled')).toBe('true');

    // Custom reveals the number and the unit.
    await userEvent.type(title, 'Gutters');
    fireEvent.change(date, { target: { value: '2026-11-30' } });
    expect(screen.queryByRole('spinbutton', { name: 'Every' })).toBeNull();
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
    await userEvent.type(title, 'No repeat');
    fireEvent.change(date, { target: { value: '2026-11-30' } });
    await userEvent.selectOptions(select('Repeats'), 'monthly');
    fireEvent.change(date, { target: { value: '' } });
    expect(select('Repeats').value).toBe('none');
    expect(select('Repeats').getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(date, { target: { value: '2026-11-30' } });
    expect(select('Repeats').value).toBe('none');
    await userEvent.click(button('Add task'));
    await waitFor(() => expect(callsTo('POST /api/tasks')).toHaveLength(3));
    expect(callsTo('POST /api/tasks')[2].body).toEqual({ title: 'No repeat', dueDate: '2026-11-30' });
  });

  test('the add form shows a server repeat error on the repeat control', async () => {
    signedIn([]);
    reply('POST /api/tasks', json({ error: 'invalid_repeat', message: 'A repeat must be null or an object.' }, 400));
    render(<App />);
    const title = (await screen.findByLabelText('New task')) as HTMLInputElement;
    await userEvent.type(title, 'Rejected');
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-11-24' } });
    await userEvent.selectOptions(select('Repeats'), 'daily');
    await userEvent.click(button('Add task'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('A repeat must be null or an object.');
    expect(select('Repeats').getAttribute('aria-invalid')).toBe('true');
    expect(select('Repeats').getAttribute('aria-describedby')).toBe(alert.id);
    expect(title.getAttribute('aria-invalid')).toBeNull();
    expect(select('Repeats').value).toBe('daily');
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

    // Remove due date resets the repeat: the control is unavailable with the
    // hint, and both are sent.
    await userEvent.click(button('Edit "Bins out"'));
    await userEvent.click(button('Remove due date for "Bins out"'));
    expect(repeats().value).toBe('none');
    expect(repeats().getAttribute('aria-disabled')).toBe('true');
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
    // A task without a date: the control is unavailable with the hint.
    await startEditing('Undated');
    const repeats = select('Repeats for "Undated"');
    expect(repeats.getAttribute('aria-disabled')).toBe('true');
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
    expect(button('Completed (1)').getAttribute('aria-expanded')).toBe('false');
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
    expect(status()).toBe('"Last one" was moved to Completed. No further occurrence was created.');
    // The usual focus rule: the next row in page order.
    await waitFor(() => expect(document.activeElement).toBe(checkbox('Other')));
    await userEvent.click(checkbox('Plain'));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Plain' })).toBeNull());
    expect(status()).toBe('"Plain" was moved to Completed.');
    expect(callsTo('PATCH /api/tasks/2')[0].body).toEqual({ completed: true, today: '2026-11-20' });
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
