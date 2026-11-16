import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App';

type Reply = Response | Promise<Response> | (() => Response | Promise<Response>);
type Call = { method: string; path: string; body: unknown };

const signedInUser = { id: '1', name: 'Household One', email: 'one@example.test' };
const milk = { id: 1, title: 'Buy oat milk', completed: false };
const plants = { id: 2, title: 'Water the plants', completed: true };

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
function taskList() {
  return screen.getByRole('list', { name: 'Your tasks' });
}
// The title of each row, in order: the text of the label around its checkbox.
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
    reply('POST /api/auth/sign-in/oauth2', json({ url: '#fixture-sso' }));
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Pior Labs' }));
    await waitFor(() => expect(location.hash).toBe('#fixture-sso'));
    expect(callsTo('POST /api/auth/sign-in/oauth2')[0].body).toEqual({
      providerId: 'auth-pior',
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
    await waitFor(() => expect(taskTitles()).toEqual(['Water the plants', 'Buy oat milk']));
    expect(screen.queryByRole('status')).toBeNull();
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
    reply('POST /api/tasks', json({ task: { id: 7, title: 'Call the plumber', completed: false } }, 201));
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
    reply('POST /api/tasks', json({ task: { id: 8, title: longest, completed: false } }, 201));
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
      json({ task: { id: 9, title: 'Second', completed: false } }, 201),
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

    finish(json({ task: { id: 7, title: 'First', completed: false } }, 201));
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
    expect(callsTo('PATCH /api/tasks/1')[0].body).toEqual({ completed: true });

    finish(json({ task: { ...milk, completed: true } }));
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(checkbox.getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(checkbox);
    expect(screen.getByText('Buy oat milk').className).toContain('line-through');

    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
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
    expect(taskTitles()).toEqual(['Water the plants', 'Buy oat milk']);

    // A later successful update clears the failure message.
    await waitFor(() => expect(done.getAttribute('aria-disabled')).toBeNull());
    await userEvent.click(open);
    await waitFor(() => expect(open.checked).toBe(true));
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
const tea = { id: 3, title: 'Order tea', completed: false };

describe('renaming a task', () => {
  test('saves with the Save control and shows the new title only after the server stored it', async () => {
    signedIn([plants, milk]);
    const save = pending();
    reply('PATCH /api/tasks/1', save.response);
    render(<App />);
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
    expect(taskTitles()).toEqual(['Water the plants', 'editing:   Buy oat milk and bread  ']);
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
    await waitFor(() => expect(taskTitles()).toEqual(['Water the plants', 'Buy oat milk and bread']));
    // The controls are named after the new title, and focus is back on Edit.
    expect(document.activeElement).toBe(button('Edit "Buy oat milk and bread"'));
    expect(button('Delete "Buy oat milk and bread"')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Buy oat milk and bread' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('saves with Enter, and a completed task stays completed', async () => {
    signedIn([plants, milk]);
    reply('PATCH /api/tasks/2', json({ task: { ...plants, title: 'Water the ferns' } }));
    render(<App />);
    const field = await startEditing('Water the plants');
    await userEvent.clear(field);
    await userEvent.type(field, 'Water the ferns{Enter}');

    await waitFor(() => expect(taskTitles()).toEqual(['Water the ferns', 'Buy oat milk']));
    expect(callsTo('PATCH /api/tasks/2')).toEqual([
      { method: 'PATCH', path: '/api/tasks/2', body: { title: 'Water the ferns' } },
    ]);
    expect((screen.getByRole('checkbox', { name: 'Water the ferns' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Water the ferns').className).toContain('line-through');
    expect(document.activeElement).toBe(button('Edit "Water the ferns"'));
  });

  test('Escape and Cancel restore the original title without a request', async () => {
    signedIn([plants, milk]);
    render(<App />);
    let field = await startEditing('Buy oat milk');
    await userEvent.clear(field);
    await userEvent.type(field, 'Thrown away{Escape}');
    expect(taskTitles()).toEqual(['Water the plants', 'Buy oat milk']);
    expect(document.activeElement).toBe(button('Edit "Buy oat milk"'));

    field = await startEditing('Buy oat milk');
    // A cancelled edit leaves nothing behind: the field starts from the stored title again.
    expect(field.value).toBe('Buy oat milk');
    await userEvent.type(field, ' also thrown away');
    await userEvent.click(button('Cancel'));
    expect(taskTitles()).toEqual(['Water the plants', 'Buy oat milk']);
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
    const first = await startEditing('Buy oat milk');
    await userEvent.type(first, ' unsaved');
    const second = await startEditing('Water the plants');
    expect(document.activeElement).toBe(second);
    expect(second.value).toBe('Water the plants');
    // The first row is back to its stored title; its unsaved text is dropped.
    expect(taskTitles()).toEqual(['editing: Water the plants', 'Buy oat milk']);
    expect(within(taskList()).getAllByRole('textbox')).toHaveLength(1);
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
      expect(taskTitles()).toEqual(['Water the plants', 'editing: Buy soy milk']);
      expect(screen.queryByText('Buy soy milk')).toBeNull();
      await waitFor(() => expect(field.readOnly).toBe(false));
      expect(button('Save').getAttribute('aria-disabled')).toBeNull();
    }

    await userEvent.type(field, '{Enter}');
    await waitFor(() => expect(taskTitles()).toEqual(['Water the plants', 'Buy soy milk']));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(callsTo('PATCH /api/tasks/1')).toHaveLength(4);
  });

  test('a 404 removes the row with a notice and moves focus to the next row', async () => {
    signedIn([plants, milk, tea]);
    reply('PATCH /api/tasks/1', json({ error: 'task_not_found', message: 'That task could not be found.' }, 404));
    render(<App />);
    const field = await startEditing('Buy oat milk');
    await userEvent.type(field, ' today{Enter}');

    await waitFor(() => expect(taskTitles()).toEqual(['Water the plants', 'Order tea']));
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

    update.finish(json({ task: { ...milk, completed: true } }));
    await waitFor(() => expect(checkbox.checked).toBe(true));
    await waitFor(() => expect(edit.getAttribute('aria-disabled')).toBeNull());
    await userEvent.click(edit);
    expect(editField('Buy oat milk').value).toBe('Buy oat milk');
  });

  test('Escape on Save or Cancel also cancels, but not while the save is pending', async () => {
    signedIn([plants, milk]);
    const save = pending();
    reply('PATCH /api/tasks/1', save.response);
    render(<App />);
    for (const control of ['Save', 'Cancel']) {
      const field = await startEditing('Buy oat milk');
      await userEvent.type(field, ' thrown away');
      button(control).focus();
      await userEvent.keyboard('{Escape}');
      expect(taskTitles()).toEqual(['Water the plants', 'Buy oat milk']);
      expect(document.activeElement).toBe(button('Edit "Buy oat milk"'));
    }
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);

    // While the save is pending, Escape on any control of the form changes nothing.
    const field = await startEditing('Buy oat milk');
    await userEvent.type(field, ' and bread{Enter}');
    for (const target of [field, button('Saving...'), button('Cancel')]) {
      target.focus();
      await userEvent.keyboard('{Escape}');
      expect(taskTitles()).toEqual(['Water the plants', 'editing: Buy oat milk and bread']);
      expect(document.activeElement).toBe(target);
    }
    save.finish(json({ task: { ...milk, title: 'Buy oat milk and bread' } }));
    await waitFor(() => expect(taskTitles()).toEqual(['Water the plants', 'Buy oat milk and bread']));
    expect(callsTo('PATCH /api/tasks/1')).toHaveLength(1);
  });

  test('while a save is pending, Edit on other rows is visibly locked and ignored', async () => {
    signedIn([plants, milk]);
    const save = pending();
    reply('PATCH /api/tasks/1', save.response);
    render(<App />);
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
    expect(taskTitles()).toEqual(['Water the plants', 'editing: Buy oat milk and bread']);

    save.finish(json({ task: { ...milk, title: 'Buy oat milk and bread' } }));
    await waitFor(() => expect(taskTitles()).toEqual(['Water the plants', 'Buy oat milk and bread']));
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
    await userEvent.click(await screen.findByRole('button', { name: 'Delete "Buy oat milk"' }));

    const row = within(taskList()).getAllByRole('listitem')[1];
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
    expect(taskTitles()).toEqual(['Water the plants', 'Buy oat milk']);

    await userEvent.click(cancel);
    expect(screen.queryByText('Delete this task?')).toBeNull();
    expect(taskTitles()).toEqual(['Water the plants', 'Buy oat milk']);
    expect(document.activeElement).toBe(button('Delete "Buy oat milk"'));
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test('Confirm removes the row only after the server confirmed, then focuses the next row', async () => {
    signedIn([plants, milk, tea]);
    const removal = pending();
    reply('DELETE /api/tasks/1', removal.response);
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete "Buy oat milk"' }));
    const confirm = button('Confirm deleting "Buy oat milk"');
    await userEvent.click(confirm);

    // Pending: the row is still there and its controls are locked but focusable.
    expect(taskTitles()).toEqual(['Water the plants', 'Buy oat milk', 'Order tea']);
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
    await waitFor(() => expect(taskTitles()).toEqual(['Water the plants', 'Order tea']));
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
    await userEvent.click(await screen.findByRole('button', { name: 'Delete "Buy oat milk"' }));
    await userEvent.click(button('Confirm deleting "Buy oat milk"'));
    await waitFor(() => expect(taskTitles()).toEqual(['Water the plants']));
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Water the plants' }));

    // A completed task is deleted like any other; deleting the last one shows the empty state.
    await userEvent.click(button('Delete "Water the plants"'));
    await userEvent.click(button('Confirm deleting "Water the plants"'));
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
    await userEvent.click(await screen.findByRole('button', { name: 'Delete "Buy oat milk"' }));
    const confirm = button('Confirm deleting "Buy oat milk"');
    for (const attempt of [1, 2]) {
      await userEvent.click(confirm);
      await waitFor(() => expect(callsTo('DELETE /api/tasks/1')).toHaveLength(attempt));
      expect((await screen.findByRole('alert')).textContent).toBe(
        '"Buy oat milk" could not be deleted. Please try again.',
      );
      expect(taskTitles()).toEqual(['Water the plants', 'Buy oat milk']);
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
    const checkbox = (await screen.findByRole('checkbox', { name: 'Buy oat milk' })) as HTMLInputElement;

    // From the plain row: Delete is locked (but focusable) while the change is pending.
    await userEvent.click(checkbox);
    const remove = button('Delete "Buy oat milk"');
    expect(remove.disabled).toBe(false);
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(remove);
    expect(document.activeElement).toBe(remove);
    expect(screen.queryByText('Delete this task?')).toBeNull();
    first.finish(json({ task: { ...milk, completed: true } }));
    await waitFor(() => expect(checkbox.checked).toBe(true));
    await waitFor(() => expect(remove.getAttribute('aria-disabled')).toBeNull());

    // With the question open: Confirm is locked while a change started there is pending.
    await userEvent.click(remove);
    await userEvent.click(checkbox);
    const confirm = button('Confirm deleting "Buy oat milk"');
    expect(confirm.disabled).toBe(false);
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(confirm);
    expect(document.activeElement).toBe(confirm);
    expect(confirm.textContent).toBe('Confirm');
    expect(callsTo('DELETE /api/tasks/1')).toHaveLength(0);

    second.finish(json({ task: { ...milk, completed: false } }));
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
    reply('POST /api/tasks', json({ task: { id: 7, title: 'Call the plumber', completed: false } }, 201));
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
