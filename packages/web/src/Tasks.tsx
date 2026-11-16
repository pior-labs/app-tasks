import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { type RowMode, type Task, TaskRow } from './TaskRow';

export type { Task };

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

// The client-side title check shared by the add form and the inline edit
// field. Returns the message to show, or an empty string for a valid title.
function titleProblem(trimmed: string) {
  if (!VISIBLE_CHARACTER.test(trimmed)) return 'Enter a task title.';
  if (characterCount(trimmed) > MAX_TITLE_LENGTH) {
    return `Task titles can be at most ${MAX_TITLE_LENGTH} characters.`;
  }
  return '';
}

function goneMessage(task: Task) {
  return `"${task.title}" no longer exists, so it was removed from the list.`;
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
  // A neutral message, shown when a task turned out to be gone already.
  const [notice, setNotice] = useState('');
  // At most one row is in edit mode, and at most one asks to confirm a delete.
  const [editing, setEditing] = useState<{ id: number; text: string; error: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  // Pending requests are tracked in refs as well as state so a repeat submit
  // in the same tick is ignored. The controls are locked with readOnly and
  // aria-disabled instead of disabled, because a disabled control loses focus.
  const creatingRef = useRef(false);
  const updatingRef = useRef(new Set<number>());
  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  // Row elements by task id, and the latest list, for moving keyboard focus.
  const rows = useRef(new Map<number, HTMLLIElement>());
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  // Edit and delete replace the control that had focus, so focus is moved on
  // purpose: the target is looked up after the next render has updated the page.
  const focusAfterRender = useRef<(() => HTMLElement | null | undefined) | null>(null);
  useEffect(() => {
    const target = focusAfterRender.current?.();
    focusAfterRender.current = null;
    target?.focus();
  });
  const control = (id: number, action: string) =>
    rows.current.get(id)?.querySelector<HTMLElement>(`[data-action="${action}"]`);
  // Focus is only moved for a row the user is still in. Some browsers do not
  // focus a clicked button, which leaves focus on the page body: that counts too.
  const hasFocus = (id: number) => {
    const active = document.activeElement;
    return !active || active === document.body || (rows.current.get(id)?.contains(active) ?? false);
  };
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
    const problem = titleProblem(trimmed);
    if (problem) return setCreateError(problem);
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
    // A task that is being deleted is not updated as well.
    if (deletingRef.current && confirmingId === task.id) return;
    updatingRef.current.add(task.id);
    setUpdatingIds((ids) => [...ids, task.id]);
    setUpdateError('');
    setNotice('');
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

  // Remove a row the server no longer has. If keyboard focus was inside it,
  // move focus to the next row's first control, else the previous row's, else
  // the new-task field, so focus is never dropped onto the page.
  function removeRow(id: number) {
    const list = tasksRef.current;
    const index = list.findIndex((item) => item.id === id);
    const neighbour = index === -1 ? undefined : (list[index + 1] ?? list[index - 1]);
    if (hasFocus(id)) {
      focusAfterRender.current = () =>
        neighbour
          ? rows.current.get(neighbour.id)?.querySelector<HTMLElement>('input, button')
          : titleInput.current;
    }
    setTasks((current) => current.filter((item) => item.id !== id));
    setEditing((current) => (current?.id === id ? null : current));
    setConfirmingId((current) => (current === id ? null : current));
  }

  function startEdit(task: Task) {
    // One request per task at a time: wait for a pending save or completion change.
    if (savingRef.current || updatingRef.current.has(task.id)) return;
    setEditing({ id: task.id, text: task.title, error: '' });
    focusAfterRender.current = () => {
      const field = control(task.id, 'edit-title') as HTMLInputElement | null | undefined;
      field?.setSelectionRange(field.value.length, field.value.length);
      return field;
    };
  }

  function leaveEdit(task: Task) {
    if (hasFocus(task.id)) focusAfterRender.current = () => control(task.id, 'edit');
    setEditing(null);
  }

  function cancelEdit(task: Task) {
    if (savingRef.current) return;
    leaveEdit(task);
  }

  async function saveEdit(task: Task) {
    if (savingRef.current || editing?.id !== task.id) return;
    const trimmed = editing.text.trim();
    const problem = titleProblem(trimmed);
    if (problem) return setEditing({ ...editing, error: problem });
    // Nothing to store: leave edit mode without a request.
    if (trimmed === task.title) return leaveEdit(task);
    savingRef.current = true;
    setSaving(true);
    setUpdateError('');
    setNotice('');
    const fail = (error: string) =>
      setEditing((current) => (current?.id === task.id ? { ...current, error } : current));
    fail('');
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ title: trimmed }),
      });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      if (response.status === 404) {
        removeRow(task.id);
        return setNotice(goneMessage(task));
      }
      if (response.status === 400) {
        return fail(await serverMessage(response, 'That title was not accepted.'));
      }
      if (!response.ok) throw new Error();
      const body: { task: Task } = await response.json();
      // The row shows the new title only once the server has stored it.
      setTasks((current) => current.map((item) => (item.id === body.task.id ? body.task : item)));
      leaveEdit(task);
    } catch {
      // Edit mode and the typed text are kept so the user can retry.
      fail('The new title could not be saved. Please try again.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function startDelete(task: Task) {
    if (deletingRef.current) return;
    setConfirmingId(task.id);
    // Focus lands on Cancel, so a repeated key press or click does not delete.
    focusAfterRender.current = () => control(task.id, 'cancel-delete');
  }

  function cancelDelete(task: Task) {
    if (deletingRef.current) return;
    if (hasFocus(task.id)) focusAfterRender.current = () => control(task.id, 'delete');
    setConfirmingId(null);
  }

  async function confirmDelete(task: Task) {
    if (deletingRef.current || confirmingId !== task.id) return;
    deletingRef.current = true;
    setDeleting(true);
    setUpdateError('');
    setNotice('');
    try {
      const response = await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      if (response.status === 404) {
        removeRow(task.id);
        return setNotice(goneMessage(task));
      }
      if (!response.ok) throw new Error();
      // The row disappears only once the server has deleted the task.
      removeRow(task.id);
    } catch {
      // The row and its confirmation stay, so the user can retry or cancel.
      setUpdateError(`"${task.title}" could not be deleted. Please try again.`);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  function rowMode(task: Task): RowMode {
    if (editing?.id === task.id) {
      return { kind: 'edit', text: editing.text, error: editing.error, saving };
    }
    if (confirmingId === task.id) return { kind: 'confirm-delete', deleting };
    return { kind: 'view' };
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
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {tasks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-5 text-muted-foreground">
          No tasks yet. Add your first one above.
        </p>
      ) : (
        <ul aria-label="Your tasks" className="divide-y divide-border rounded-lg border border-border">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              mode={rowMode(task)}
              updating={updatingIds.includes(task.id)}
              rowRef={(element) => {
                if (element) rows.current.set(task.id, element);
                else rows.current.delete(task.id);
              }}
              onToggle={(completed) => void setCompleted(task, completed)}
              onStartEdit={() => startEdit(task)}
              onEditText={(text) =>
                setEditing((current) =>
                  current?.id === task.id && !savingRef.current
                    ? { ...current, text, error: '' }
                    : current,
                )
              }
              onSave={() => void saveEdit(task)}
              onCancelEdit={() => cancelEdit(task)}
              onStartDelete={() => startDelete(task)}
              onConfirmDelete={() => void confirmDelete(task)}
              onCancelDelete={() => cancelDelete(task)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
