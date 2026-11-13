import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';

export type Task = { id: number; title: string; completed: boolean };

const MAX_TITLE_LENGTH = 200;
const jsonHeaders = { 'Content-Type': 'application/json' };

// These two rules mirror the server (packages/api/src/tasks.ts) so the form
// and the API agree. A title made only of whitespace, control characters and
// invisible "default ignorable" code points (such as a zero width space) is
// treated as empty; visible titles are sent unchanged apart from trimming.
const VISIBLE_CHARACTER = /[^\p{White_Space}\p{Cc}\p{Default_Ignorable_Code_Point}]/u;
// Length is counted in Unicode code points, so an emoji is one character.
function characterCount(text: string) {
  let count = 0;
  for (const _character of text) count++;
  return count;
}

// Prefer the server's human-readable message for a rejected request.
async function serverMessage(response: Response, fallback: string) {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
      return body.message;
    }
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return fallback;
}

export function Tasks({ onSignedOut }: { onSignedOut: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [updatingIds, setUpdatingIds] = useState<number[]>([]);
  const [updateError, setUpdateError] = useState('');
  const titleInput = useRef<HTMLInputElement>(null);
  // Pending requests are tracked in refs as well as state so a repeat submit
  // in the same tick is ignored. The controls are locked with readOnly and
  // aria-disabled instead of disabled, because a disabled control loses focus.
  const creatingRef = useRef(false);
  const updatingRef = useRef(new Set<number>());
  // After this component is gone (the user signed out), a late answer to a
  // request that was still in flight must not report an ended session.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      setListState('loading');
      try {
        const response = await fetch('/api/tasks');
        if (!isCurrent()) return;
        if (response.status === 401) return onSignedOut();
        if (!response.ok) throw new Error();
        const body: { tasks: Task[] } = await response.json();
        if (!isCurrent()) return;
        setTasks(body.tasks);
        setListState('ready');
      } catch {
        if (isCurrent()) setListState('failed');
      }
    },
    [onSignedOut],
  );
  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (creatingRef.current) return;
    const trimmed = title.trim();
    if (!VISIBLE_CHARACTER.test(trimmed)) return setCreateError('Enter a task title.');
    if (characterCount(trimmed) > MAX_TITLE_LENGTH) {
      return setCreateError(`Task titles can be at most ${MAX_TITLE_LENGTH} characters.`);
    }
    creatingRef.current = true;
    setCreating(true);
    setCreateError('');
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ title: trimmed }),
      });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      if (response.status === 400) {
        return setCreateError(await serverMessage(response, 'That title was not accepted.'));
      }
      if (!response.ok) throw new Error();
      const body: { task: Task } = await response.json();
      // Only a task the server confirmed is added to the list.
      setTasks((current) => [body.task, ...current]);
      setTitle('');
      // Ready for the next task, also when the add button was clicked.
      titleInput.current?.focus();
    } catch {
      setCreateError('The task could not be saved. Please try again.');
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  async function setCompleted(task: Task, completed: boolean) {
    if (updatingRef.current.has(task.id)) return;
    updatingRef.current.add(task.id);
    setUpdatingIds((ids) => [...ids, task.id]);
    setUpdateError('');
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ completed }),
      });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      if (!response.ok) throw new Error();
      const body: { task: Task } = await response.json();
      // The checkbox changes only once the server has stored the new state.
      setTasks((current) => current.map((item) => (item.id === body.task.id ? body.task : item)));
    } catch {
      setUpdateError(`"${task.title}" could not be updated. Please try again.`);
    } finally {
      updatingRef.current.delete(task.id);
      setUpdatingIds((ids) => ids.filter((id) => id !== task.id));
    }
  }

  if (listState === 'loading') return <p role="status">Loading your tasks...</p>;
  if (listState === 'failed') {
    return (
      <div className="space-y-3 rounded-lg border border-border p-5">
        <p role="alert">Your tasks could not be loaded.</p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-border px-4 py-2 font-medium"
        >
          Try again
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <form onSubmit={(event) => void create(event)} noValidate className="space-y-2">
        <label htmlFor="new-task-title" className="block text-sm font-medium">
          New task
        </label>
        <div className="flex gap-3">
          <input
            id="new-task-title"
            ref={titleInput}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setCreateError('');
            }}
            readOnly={creating}
            placeholder="What needs doing?"
            autoComplete="off"
            aria-invalid={createError ? true : undefined}
            aria-describedby={createError ? 'new-task-error' : undefined}
            className="min-w-0 flex-1 rounded-md border border-border bg-card px-4 py-3 text-card-foreground read-only:opacity-60"
          />
          <button
            type="submit"
            aria-disabled={creating || undefined}
            className="rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground aria-disabled:opacity-50"
          >
            {creating ? 'Adding...' : 'Add task'}
          </button>
        </div>
        {createError && (
          <p id="new-task-error" role="alert" className="text-sm text-destructive">
            {createError}
          </p>
        )}
      </form>
      {updateError && (
        <p role="alert" className="text-sm text-destructive">
          {updateError}
        </p>
      )}
      {tasks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-5 text-muted-foreground">
          No tasks yet. Add your first one above.
        </p>
      ) : (
        <ul aria-label="Your tasks" className="divide-y divide-border rounded-lg border border-border">
          {tasks.map((task) => (
            <li key={task.id}>
              <label className="flex cursor-pointer items-center gap-3 px-5 py-3">
                <input
                  type="checkbox"
                  checked={task.completed}
                  aria-disabled={updatingIds.includes(task.id) || undefined}
                  onChange={(event) => void setCompleted(task, event.target.checked)}
                  className="size-5 shrink-0 accent-primary aria-disabled:opacity-50"
                />
                <span
                  className={`min-w-0 break-words ${task.completed ? 'text-muted-foreground line-through' : ''}`}
                >
                  {task.title}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
