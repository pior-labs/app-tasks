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
function taskTitles() {
  return within(taskList())
    .getAllByRole('listitem')
    .map((item) => item.textContent);
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
