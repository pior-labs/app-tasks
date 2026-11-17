import type { FormEvent, KeyboardEvent, Ref } from 'react';
import { MAX_DUE_DATE, MIN_DUE_DATE, dueLabel, dueStatus } from './dueDate';

// dueDate is a calendar day, "YYYY-MM-DD", or null for no due date.
export type Task = { id: number; title: string; completed: boolean; dueDate: string | null };

// What a row is doing besides showing its task. Only one row edits at a time
// and only one asks for a delete confirmation at a time; Tasks owns that state.
export type RowMode =
  | { kind: 'view' }
  // dueDate is the date field's value: "YYYY-MM-DD", or empty for none. The
  // error belongs to the field named by errorField.
  | {
      kind: 'edit';
      text: string;
      dueDate: string;
      error: string;
      errorField: 'title' | 'dueDate';
      saving: boolean;
    }
  | { kind: 'confirm-delete'; deleting: boolean };

type Props = {
  task: Task;
  mode: RowMode;
  // The browser's local date, "YYYY-MM-DD", for the due date label.
  today: string;
  // A completion change for this task is waiting for the server.
  updating: boolean;
  // Edit or Delete would be ignored now: another row is saving or deleting, or
  // a completion change for this task is pending.
  editLocked: boolean;
  deleteLocked: boolean;
  rowRef: Ref<HTMLLIElement>;
  onToggle: (completed: boolean) => void;
  onStartEdit: () => void;
  onEditText: (text: string) => void;
  onEditDueDate: (dueDate: string) => void;
  onRemoveDueDate: () => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onStartDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
};

// Escape anywhere in the edit form or the delete question cancels it. Tasks
// ignores the cancel while that row's request is pending, as for Cancel.
const escapeTo = (cancel: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  }
};

const rowButton =
  'shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium aria-disabled:opacity-50';

// Pending controls are locked with readOnly and aria-disabled instead of
// disabled, because a disabled control loses keyboard focus. Tasks ignores the
// repeat input. The data-action attributes let Tasks move focus between the
// controls of a row.
export function TaskRow({
  task,
  mode,
  today,
  updating,
  editLocked,
  deleteLocked,
  rowRef,
  onToggle,
  onStartEdit,
  onEditText,
  onEditDueDate,
  onRemoveDueDate,
  onSave,
  onCancelEdit,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
}: Props) {
  if (mode.kind === 'edit') {
    const errorId = `task-${task.id}-edit-error`;
    const titleError = mode.error !== '' && mode.errorField === 'title';
    const dueDateError = mode.error !== '' && mode.errorField === 'dueDate';
    const submit = (event: FormEvent) => {
      event.preventDefault();
      onSave();
    };
    return (
      <li ref={rowRef} className="px-5 py-3">
        <form
          onSubmit={submit}
          onKeyDown={escapeTo(onCancelEdit)}
          noValidate
          className="flex flex-wrap items-center justify-end gap-2"
        >
          <input
            data-action="edit-title"
            aria-label={`New title for "${task.title}"`}
            value={mode.text}
            onChange={(event) => onEditText(event.target.value)}
            readOnly={mode.saving}
            autoComplete="off"
            aria-invalid={titleError || undefined}
            aria-describedby={titleError ? errorId : undefined}
            className="min-w-48 flex-1 rounded-md border border-border bg-card px-3 py-1.5 text-card-foreground read-only:opacity-60"
          />
          <input
            type="date"
            data-action="edit-due-date"
            aria-label={`Due date for "${task.title}"`}
            value={mode.dueDate}
            min={MIN_DUE_DATE}
            max={MAX_DUE_DATE}
            onChange={(event) => onEditDueDate(event.target.value)}
            readOnly={mode.saving}
            aria-invalid={dueDateError || undefined}
            aria-describedby={dueDateError ? errorId : undefined}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-card-foreground read-only:opacity-60"
          />
          {mode.dueDate !== '' && (
            <button
              type="button"
              data-action="remove-due-date"
              aria-label={`Remove due date for "${task.title}"`}
              aria-disabled={mode.saving || undefined}
              onClick={onRemoveDueDate}
              className={rowButton}
            >
              Remove due date
            </button>
          )}
          <button
            type="submit"
            aria-disabled={mode.saving || undefined}
            className={`${rowButton} border-primary bg-primary text-primary-foreground`}
          >
            {mode.saving ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            onClick={onCancelEdit}
            aria-disabled={mode.saving || undefined}
            className={rowButton}
          >
            Cancel
          </button>
          {mode.error && (
            <p id={errorId} role="alert" className="basis-full text-sm text-destructive">
              {mode.error}
            </p>
          )}
        </form>
      </li>
    );
  }

  const deleting = mode.kind === 'confirm-delete' && mode.deleting;
  const dueId = `task-${task.id}-due`;
  // A completed task shows its due date but is never marked overdue.
  const overdue = task.dueDate !== null && !task.completed && dueStatus(task.dueDate, today) === 'overdue';
  return (
    <li ref={rowRef} className="flex flex-wrap items-center justify-end gap-x-2 gap-y-2 px-5 py-3">
      <div className="flex min-w-48 flex-1 flex-col gap-0.5">
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            data-action="toggle"
            checked={task.completed}
            aria-disabled={updating || deleting || undefined}
            aria-describedby={task.dueDate === null ? undefined : dueId}
            onChange={(event) => onToggle(event.target.checked)}
            className="size-5 shrink-0 accent-primary aria-disabled:opacity-50"
          />
          <span
            className={`min-w-0 break-words ${task.completed ? 'text-muted-foreground line-through' : ''}`}
          >
            {task.title}
          </span>
        </label>
        {task.dueDate !== null && (
          // Indented to line up with the title: the checkbox (1.25rem) plus the gap (0.75rem).
          <p
            id={dueId}
            className={`pl-8 text-sm ${overdue ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {/* Overdue is said in words, not only by the colour. */}
            {overdue && (
              <>
                <span className="font-semibold">Overdue</span>
                {' \u00B7 '}
              </>
            )}
            <span>{dueLabel(task.dueDate, today)}</span>
          </p>
        )}
      </div>
      {mode.kind === 'confirm-delete' ? (
        <div
          role="group"
          aria-label={`Delete "${task.title}"?`}
          onKeyDown={escapeTo(onCancelDelete)}
          className="flex items-center gap-2"
        >
          <span className="text-sm">Delete this task?</span>
          <button
            type="button"
            data-action="confirm-delete"
            aria-label={`Confirm deleting "${task.title}"`}
            aria-disabled={deleting || updating || undefined}
            onClick={onConfirmDelete}
            className={`${rowButton} border-destructive text-destructive`}
          >
            {deleting ? 'Deleting...' : 'Confirm'}
          </button>
          <button
            type="button"
            data-action="cancel-delete"
            aria-label={`Cancel deleting "${task.title}"`}
            aria-disabled={deleting || undefined}
            onClick={onCancelDelete}
            className={rowButton}
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            data-action="edit"
            aria-label={`Edit "${task.title}"`}
            aria-disabled={editLocked || undefined}
            onClick={onStartEdit}
            className={rowButton}
          >
            Edit
          </button>
          <button
            type="button"
            data-action="delete"
            aria-label={`Delete "${task.title}"`}
            aria-disabled={deleteLocked || undefined}
            onClick={onStartDelete}
            className={rowButton}
          >
            Delete
          </button>
        </>
      )}
    </li>
  );
}
