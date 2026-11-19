import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  INCOMPLETE_DUE_DATE_MESSAGE,
  MAX_DUE_DATE,
  MIN_DUE_DATE,
  dueDateProblem,
  dueLabel,
  localDate,
  msUntilNextLocalMidnight,
} from './dueDate';
import { RepeatControl, RepeatHint } from './RepeatControl';
import {
  NO_REPEAT,
  type Repeat,
  type RepeatForm,
  nextIsBeyond,
  repeatForm,
  repeatFromForm,
  sameRepeat,
} from './repeat';
import { type RowMode, type Task, TaskRow } from './TaskRow';
import { groupTasks, visibleTasks } from './taskGroups';

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

// Prefer the server's human-readable message for a rejected request. The code
// tells which field the message is about.
async function serverError(response: Response, fallback: string) {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
      const code = 'error' in body && typeof body.error === 'string' ? body.error : '';
      return { message: body.message, code };
    }
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return { message: fallback, code: '' };
}

type Field = 'title' | 'dueDate' | 'repeat';
const fieldOf = (code: string): Field =>
  code === 'invalid_due_date' ? 'dueDate' : code === 'invalid_repeat' ? 'repeat' : 'title';

// A date input that holds a partly typed date reports an empty value and
// badInput. That is not "no due date", so it is refused instead of sent.
function dateFieldProblem(field: HTMLInputElement | null | undefined, value: string) {
  return field?.validity?.badInput ? INCOMPLETE_DUE_DATE_MESSAGE : dueDateProblem(value);
}

function movedMessage(task: Task) {
  return `"${task.title}" was moved to Completed.`;
}

// After ticking a repeating task: when the next occurrence is due, in the
// words of the row labels ("today", "tomorrow", "Wed, Nov 26").
function nextDueMessage(next: Task, today: string) {
  const when = next.dueDate === null ? '' : dueLabel(next.dueDate, today).replace(/^Due /, '');
  return `"${next.title}" is next due ${when}.`;
}
// The server creates no next occurrence for a repeating task only when its
// date would be after the last supported due date, or when the occurrence
// created from this task already exists (it was kept when the task was
// un-ticked, or another tab completed the task first).
function noNextMessage(task: Task, today: string) {
  const beyond =
    task.dueDate !== null && task.repeat !== null && nextIsBeyond(task.dueDate, today, task.repeat, MAX_DUE_DATE);
  return beyond
    ? `"${task.title}" was moved to Completed. No further occurrence was created, because it would be after December 31, 2100.`
    : `"${task.title}" was moved to Completed. Its next occurrence already exists.`;
}
function removedNextMessage(task: Task) {
  return `"${task.title}" is open again, and its next occurrence was removed.`;
}

// The answer to a task update. Older stubs and servers may leave out the
// repeat fields; missing means none.
type UpdateReply = { task: Task; nextTask?: Task | null; removedTaskId?: number | null };
const withRepeat = (task: Task): Task => ({ ...task, repeat: task.repeat ?? null });

export function Tasks({ onSignedOut }: { onSignedOut: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [repeat, setRepeat] = useState<RepeatForm>(NO_REPEAT);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<{ message: string; field: Field } | null>(null);
  const [updatingIds, setUpdatingIds] = useState<number[]>([]);
  const [updateError, setUpdateError] = useState('');
  // A neutral message, shown when a task turned out to be gone already.
  const [notice, setNotice] = useState('');
  // At most one row is in edit mode, and at most one asks to confirm a delete.
  const [editing, setEditing] = useState<{
    id: number;
    text: string;
    dueDate: string;
    repeat: RepeatForm;
    error: string;
    errorField: Field;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  // "Today" is the browser's local date. It is recomputed at local midnight and
  // when the page becomes visible again, so rows move between groups without a reload.
  const [today, setToday] = useState(() => localDate(new Date()));
  const todayRef = useRef(today);
  todayRef.current = today;
  // Collapsed on every page load; the choice is not remembered.
  const [completedOpen, setCompletedOpen] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const dueDateInput = useRef<HTMLInputElement>(null);
  const completedToggle = useRef<HTMLButtonElement>(null);
  // Pending requests are tracked in refs as well as state so a repeat submit
  // in the same tick is ignored. The controls are locked with readOnly and
  // aria-disabled instead of disabled, because a disabled control loses focus.
  const creatingRef = useRef(false);
  const updatingRef = useRef(new Set<number>());
  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  // Tasks this page removed from the list, so a late answer about one of them
  // is not reported as a failure.
  const removedRef = useRef(new Set<number>());
  // Row elements by task id, and the rows the user can see in page order, for
  // moving keyboard focus. A row moved to another group is a new element.
  const rows = useRef(new Map<number, HTMLLIElement>());
  const groups = groupTasks(tasks, today);
  const visibleRef = useRef<Task[]>([]);
  visibleRef.current = visibleTasks(groups, completedOpen);
  const completedOpenRef = useRef(completedOpen);
  completedOpenRef.current = completedOpen;
  // Edit and delete replace the control that had focus, so focus is moved on
  // purpose: the target is looked up after the next render has updated the page.
  const focusAfterRender = useRef<(() => HTMLElement | null | undefined) | null>(null);
  // Focus to restore once the page shows a new day. React may first run the
  // effects of an earlier render, so this waits for the render with that day.
  const focusOnDay = useRef<{ day: string; target: () => HTMLElement | null | undefined } | null>(null);
  useEffect(() => {
    const target = focusAfterRender.current?.();
    focusAfterRender.current = null;
    target?.focus();
    if (focusOnDay.current?.day === today) {
      const moved = focusOnDay.current.target();
      focusOnDay.current = null;
      moved?.focus();
    }
  });
  const control = (id: number, action: string) =>
    rows.current.get(id)?.querySelector<HTMLElement>(`[data-action="${action}"]`);
  const firstControl = (id: number) => rows.current.get(id)?.querySelector<HTMLElement>('input, button');
  // The row after the given one in page order, else the one before it.
  const visibleNeighbour = (id: number) => {
    const list = visibleRef.current;
    const index = list.findIndex((item) => item.id === id);
    return index === -1 ? undefined : (list[index + 1] ?? list[index - 1]);
  };
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

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      const next = localDate(new Date());
      if (next === todayRef.current) return;
      // A new day can move rows to another group, and a moved row is a new
      // element. If focus was on a row's control (or in its edit fields),
      // put it back on the same control, with the same caret, after the render.
      const active = document.activeElement;
      const action = active instanceof HTMLElement ? active.dataset.action : undefined;
      const owner = action ? [...rows.current].find(([, row]) => row.contains(active)) : undefined;
      if (owner && action) {
        const [id] = owner;
        const field = active instanceof HTMLInputElement ? active : null;
        // Only text fields have a caret; a date or checkbox input reports null.
        const caret =
          field && field.selectionStart !== null
            ? { start: field.selectionStart, end: field.selectionEnd ?? field.selectionStart }
            : null;
        focusOnDay.current = {
          day: next,
          target: () => {
            const target = control(id, action);
            if (target && caret && target instanceof HTMLInputElement) {
              target.setSelectionRange(caret.start, caret.end);
            }
            return target;
          },
        };
      }
      setToday(next);
    };
    // A timer that fires a little early finds the same day and waits again.
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refresh();
        schedule();
      }, msUntilNextLocalMidnight(new Date()));
    };
    // Timers can be held back while a page is hidden or the computer sleeps.
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      refresh();
      schedule();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
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
        setTasks(body.tasks.map(withRepeat));
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
    if (problem) return setCreateError({ message: problem, field: 'title' });
    const dateProblem = dateFieldProblem(dueDateInput.current, dueDate);
    if (dateProblem) return setCreateError({ message: dateProblem, field: 'dueDate' });
    // A repeat needs a due date; without one the control is unavailable.
    const repeatChoice = dueDate === '' ? { repeat: null } : repeatFromForm(repeat);
    if ('problem' in repeatChoice) return setCreateError({ message: repeatChoice.problem, field: 'repeat' });
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: jsonHeaders,
        // No due date, or no repeat, is sent as no field at all.
        body: JSON.stringify({
          title: trimmed,
          ...(dueDate === '' ? {} : { dueDate }),
          ...(repeatChoice.repeat === null ? {} : { repeat: repeatChoice.repeat }),
        }),
      });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      if (response.status === 400) {
        const { message, code } = await serverError(response, 'That task was not accepted.');
        return setCreateError({ message, field: fieldOf(code) });
      }
      if (!response.ok) throw new Error();
      const body: { task: Task } = await response.json();
      // Only a task the server confirmed is added to the list.
      setTasks((current) => [withRepeat(body.task), ...current]);
      setTitle('');
      setDueDate('');
      setRepeat(NO_REPEAT);
      // Ready for the next task, also when the add button was clicked.
      titleInput.current?.focus();
    } catch {
      setCreateError({ message: 'The task could not be saved. Please try again.', field: 'title' });
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
    const sentToday = localDate(new Date());
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        // Completing sends the browser's local date, which decides where a
        // repeating task's schedule goes next.
        body: JSON.stringify(completed ? { completed, today: sentToday } : { completed }),
      });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      // The task was deleted and has already left the list: nothing to report.
      if (response.status === 404 && removedRef.current.has(task.id)) return;
      if (!response.ok) throw new Error();
      const body: UpdateReply = await response.json();
      const updated = withRepeat(body.task);
      const nextTask = body.nextTask ? withRepeat(body.nextTask) : null;
      const removedTaskId = body.removedTaskId ?? null;
      // A task completed while the Completed section is collapsed leaves view.
      const leavesView = updated.completed && !completedOpenRef.current;
      // Un-ticking took back the next occurrence: that row goes away too. This
      // comes first so the focus rules below win.
      if (removedTaskId !== null) removeRow(removedTaskId);
      if (hasFocus(task.id)) {
        if (nextTask) {
          // The new occurrence is where the user carries on, wherever the
          // completed one went.
          focusAfterRender.current = () => control(nextTask.id, 'toggle');
        } else if (leavesView) {
          // Like after a delete: the next row, else the previous one, else the
          // Completed toggle, which now exists.
          const neighbour = visibleNeighbour(task.id);
          focusAfterRender.current = () =>
            neighbour ? firstControl(neighbour.id) : completedToggle.current;
        } else {
          // The row moved to another group: focus follows its checkbox.
          focusAfterRender.current = () => control(updated.id, 'toggle');
        }
      }
      if (nextTask) setNotice(nextDueMessage(nextTask, todayRef.current));
      else if (updated.completed && updated.repeat) setNotice(noNextMessage(updated, sentToday));
      else if (removedTaskId !== null) setNotice(removedNextMessage(updated));
      else if (leavesView) setNotice(movedMessage(updated));
      // A delete question cannot stay open on a row nobody can see.
      if (leavesView) setConfirmingId((current) => (current === task.id ? null : current));
      // The checkbox changes, and the row moves, only once the server has
      // stored the new state. The next occurrence is the newest task.
      setTasks((current) => [
        ...(nextTask && !current.some((item) => item.id === nextTask.id) ? [nextTask] : []),
        ...current.map((item) => (item.id === updated.id ? updated : item)),
      ]);
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
  // Neighbours are taken in page order, across groups.
  function removeRow(id: number) {
    const neighbour = visibleNeighbour(id);
    if (hasFocus(id)) {
      focusAfterRender.current = () => (neighbour ? firstControl(neighbour.id) : titleInput.current);
    }
    removedRef.current.add(id);
    setTasks((current) => current.filter((item) => item.id !== id));
    setEditing((current) => (current?.id === id ? null : current));
    setConfirmingId((current) => (current === id ? null : current));
  }

  function startEdit(task: Task) {
    // One request per task at a time: wait for a pending save or completion change.
    if (savingRef.current || updatingRef.current.has(task.id)) return;
    setEditing({
      id: task.id,
      text: task.title,
      dueDate: task.dueDate ?? '',
      repeat: repeatForm(task.repeat),
      error: '',
      errorField: 'title',
    });
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
    if (problem) return setEditing({ ...editing, error: problem, errorField: 'title' });
    const dateProblem = dateFieldProblem(
      control(task.id, 'edit-due-date') as HTMLInputElement | null | undefined,
      editing.dueDate,
    );
    if (dateProblem) return setEditing({ ...editing, error: dateProblem, errorField: 'dueDate' });
    // Without a due date nothing repeats (the control was reset with the date).
    const repeatChoice = editing.dueDate === '' ? { repeat: null } : repeatFromForm(editing.repeat);
    if ('problem' in repeatChoice) {
      return setEditing({ ...editing, error: repeatChoice.problem, errorField: 'repeat' });
    }
    // Only the fields that changed are sent.
    const changes: { title?: string; dueDate?: string | null; repeat?: Repeat | null } = {};
    if (trimmed !== task.title) changes.title = trimmed;
    const newDueDate = editing.dueDate === '' ? null : editing.dueDate;
    if (newDueDate !== task.dueDate) changes.dueDate = newDueDate;
    if (!sameRepeat(repeatChoice.repeat, task.repeat)) changes.repeat = repeatChoice.repeat;
    // Nothing to store: leave edit mode without a request.
    if (changes.title === undefined && changes.dueDate === undefined && changes.repeat === undefined) {
      return leaveEdit(task);
    }
    savingRef.current = true;
    setSaving(true);
    setUpdateError('');
    setNotice('');
    const fail = (error: string, errorField: Field = 'title') =>
      setEditing((current) => (current?.id === task.id ? { ...current, error, errorField } : current));
    fail('');
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify(changes),
      });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      if (response.status === 404) {
        removeRow(task.id);
        return setNotice(goneMessage(task));
      }
      if (response.status === 400) {
        const { message, code } = await serverError(response, 'That change was not accepted.');
        return fail(message, fieldOf(code));
      }
      if (!response.ok) throw new Error();
      const body: UpdateReply = await response.json();
      const updated = withRepeat(body.task);
      // The row shows the new title, date and repeat, and moves to its new
      // group, only once the server has stored them. Focus follows it to Edit.
      setTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      leaveEdit(task);
    } catch {
      // Edit mode and the typed values are kept so the user can retry.
      const changed = (['title', 'dueDate', 'repeat'] as const).filter((field) => changes[field] !== undefined);
      const what =
        changed.length > 1
          ? 'The changes'
          : { title: 'The new title', dueDate: 'The new due date', repeat: 'The new repeat' }[changed[0]];
      fail(`${what} could not be saved. Please try again.`, changed[0]);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function startDelete(task: Task) {
    // One request per task at a time: wait for a pending completion change.
    if (deletingRef.current || updatingRef.current.has(task.id)) return;
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
    if (deletingRef.current || confirmingId !== task.id || updatingRef.current.has(task.id)) return;
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
      return {
        kind: 'edit',
        text: editing.text,
        dueDate: editing.dueDate,
        repeat: editing.repeat,
        error: editing.error,
        errorField: editing.errorField,
        saving,
      };
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
  const renderRow = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      mode={rowMode(task)}
      today={today}
      updating={updatingIds.includes(task.id)}
      // Controls whose action is ignored right now are marked as locked.
      editLocked={saving || updatingIds.includes(task.id)}
      deleteLocked={deleting || updatingIds.includes(task.id)}
      rowRef={(element) => {
        if (!element) return;
        rows.current.set(task.id, element);
        // A row that moves to another group is a new element, which may be
        // registered before the old one is cleaned up: only forget this one.
        return () => {
          if (rows.current.get(task.id) === element) rows.current.delete(task.id);
        };
      }}
      onToggle={(completed) => void setCompleted(task, completed)}
      onStartEdit={() => startEdit(task)}
      onEditText={(text) =>
        setEditing((current) =>
          current?.id === task.id && !savingRef.current ? { ...current, text, error: '' } : current,
        )
      }
      onEditDueDate={(value, badInput) =>
        setEditing((current) =>
          current?.id === task.id && !savingRef.current
            ? {
                ...current,
                dueDate: value,
                // Removing the date stops the repeat. A partly typed date is
                // not a removal, so the repeat is kept while typing.
                repeat: value === '' && !badInput ? NO_REPEAT : current.repeat,
                error: '',
              }
            : current,
        )
      }
      onEditRepeat={(value) =>
        setEditing((current) =>
          current?.id === task.id && !savingRef.current ? { ...current, repeat: value, error: '' } : current,
        )
      }
      onRemoveDueDate={() => {
        if (savingRef.current) return;
        setEditing((current) =>
          current?.id === task.id ? { ...current, dueDate: '', repeat: NO_REPEAT, error: '' } : current,
        );
        // The Remove control goes away with the date, so focus moves to the date field.
        focusAfterRender.current = () => control(task.id, 'edit-due-date');
      }}
      onSave={() => void saveEdit(task)}
      onCancelEdit={() => cancelEdit(task)}
      onStartDelete={() => startDelete(task)}
      onConfirmDelete={() => void confirmDelete(task)}
      onCancelDelete={() => cancelDelete(task)}
    />
  );
  const listClass = 'divide-y divide-border rounded-lg border border-border';
  const headingClass = 'text-sm font-semibold uppercase tracking-wide';
  return (
    <div className="space-y-4">
      <form onSubmit={(event) => void create(event)} noValidate className="space-y-2">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-48 flex-1 flex-col gap-2">
            <label htmlFor="new-task-title" className="block text-sm font-medium">
              New task
            </label>
            <input
              id="new-task-title"
              ref={titleInput}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setCreateError(null);
              }}
              readOnly={creating}
              placeholder="What needs doing?"
              autoComplete="off"
              aria-invalid={createError?.field === 'title' || undefined}
              aria-describedby={createError?.field === 'title' ? 'new-task-error' : undefined}
              className="min-w-0 rounded-md border border-border bg-card px-4 py-3 text-card-foreground read-only:opacity-60"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="new-task-due-date" className="block text-sm font-medium">
              Due date
            </label>
            <input
              id="new-task-due-date"
              ref={dueDateInput}
              type="date"
              value={dueDate}
              min={MIN_DUE_DATE}
              max={MAX_DUE_DATE}
              onChange={(event) => {
                setDueDate(event.target.value);
                // Removing the date resets the repeat; a partly typed date does not.
                if (event.target.value === '' && !event.target.validity?.badInput) setRepeat(NO_REPEAT);
                setCreateError(null);
              }}
              readOnly={creating}
              aria-invalid={createError?.field === 'dueDate' || undefined}
              aria-describedby={createError?.field === 'dueDate' ? 'new-task-error' : undefined}
              className="rounded-md border border-border bg-card px-4 py-3 text-card-foreground read-only:opacity-60"
            />
          </div>
          <RepeatControl
            idBase="new-task"
            visibleLabels
            names={{ choice: 'Repeats', every: 'Every', unit: 'Repeat unit' }}
            form={repeat}
            seed={null}
            available={dueDate !== ''}
            locked={creating}
            invalid={createError?.field === 'repeat'}
            errorId="new-task-error"
            className="rounded-md border border-border bg-card px-4 py-3 text-card-foreground"
            onChange={(value) => {
              setRepeat(value);
              setCreateError(null);
            }}
          />
          <button
            type="submit"
            aria-disabled={creating || undefined}
            className="rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground aria-disabled:opacity-50"
          >
            {creating ? 'Adding...' : 'Add task'}
          </button>
        </div>
        {dueDate === '' && <RepeatHint idBase="new-task" />}
        {createError && (
          <p id="new-task-error" role="alert" className="text-sm text-destructive">
            {createError.message}
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
        <div className="space-y-6">
          {/* Each group is a list named by its heading: "Overdue, list, 2 items". */}
          {groups.open.map((group) => (
            <section key={group.key} aria-labelledby={`group-${group.key}`} className="space-y-2">
              <h2
                id={`group-${group.key}`}
                className={`${headingClass} ${group.key === 'overdue' ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {group.heading}
              </h2>
              <ul aria-labelledby={`group-${group.key}`} className={listClass}>
                {group.tasks.map(renderRow)}
              </ul>
            </section>
          ))}
          {groups.completed.length > 0 && (
            <section aria-labelledby="group-completed" className="space-y-2">
              <h2 id="group-completed" className={`${headingClass} text-muted-foreground`}>
                <button
                  type="button"
                  ref={completedToggle}
                  aria-expanded={completedOpen}
                  aria-controls="completed-tasks"
                  onClick={() => setCompletedOpen((open) => !open)}
                  className="flex items-center gap-2 rounded-md py-1 uppercase tracking-wide"
                >
                  <span aria-hidden="true" className={`inline-block transition-transform ${completedOpen ? 'rotate-90' : ''}`}>
                    &#9656;
                  </span>
                  Completed ({groups.completed.length})
                </button>
              </h2>
              <ul id="completed-tasks" aria-labelledby="group-completed" hidden={!completedOpen} className={listClass}>
                {groups.completed.map(renderRow)}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
