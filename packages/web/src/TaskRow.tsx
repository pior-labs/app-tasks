import type { FormEvent, KeyboardEvent, Ref } from 'react';

export type Task = { id: number; title: string; completed: boolean };

// What a row is doing besides showing its task. Only one row edits at a time
// and only one asks for a delete confirmation at a time; Tasks owns that state.
export type RowMode =
  | { kind: 'view' }
  | { kind: 'edit'; text: string; error: string; saving: boolean }
  | { kind: 'confirm-delete'; deleting: boolean };

type Props = {
  task: Task;
  mode: RowMode;
  // A completion change for this task is waiting for the server.
  updating: boolean;
  rowRef: Ref<HTMLLIElement>;
  onToggle: (completed: boolean) => void;
  onStartEdit: () => void;
  onEditText: (text: string) => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onStartDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
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
  updating,
  rowRef,
  onToggle,
  onStartEdit,
  onEditText,
  onSave,
  onCancelEdit,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
}: Props) {
  if (mode.kind === 'edit') {
    const errorId = `task-${task.id}-title-error`;
    const submit = (event: FormEvent) => {
      event.preventDefault();
      onSave();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelEdit();
      }
    };
    return (
      <li ref={rowRef} className="px-5 py-3">
        <form onSubmit={submit} noValidate className="flex flex-wrap items-center justify-end gap-2">
          <input
            data-action="edit-title"
            aria-label={`New title for "${task.title}"`}
            value={mode.text}
            onChange={(event) => onEditText(event.target.value)}
            onKeyDown={keyDown}
            readOnly={mode.saving}
            autoComplete="off"
            aria-invalid={mode.error ? true : undefined}
            aria-describedby={mode.error ? errorId : undefined}
            className="min-w-48 flex-1 rounded-md border border-border bg-card px-3 py-1.5 text-card-foreground read-only:opacity-60"
          />
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
  return (
    <li ref={rowRef} className="flex flex-wrap items-center justify-end gap-x-2 gap-y-2 px-5 py-3">
      <label className="flex min-w-48 flex-1 cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={task.completed}
          aria-disabled={updating || deleting || undefined}
          onChange={(event) => onToggle(event.target.checked)}
          className="size-5 shrink-0 accent-primary aria-disabled:opacity-50"
        />
        <span
          className={`min-w-0 break-words ${task.completed ? 'text-muted-foreground line-through' : ''}`}
        >
          {task.title}
        </span>
      </label>
      {mode.kind === 'confirm-delete' ? (
        <div role="group" aria-label={`Delete "${task.title}"?`} className="flex items-center gap-2">
          <span className="text-sm">Delete this task?</span>
          <button
            type="button"
            data-action="confirm-delete"
            aria-label={`Confirm deleting "${task.title}"`}
            aria-disabled={deleting || undefined}
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
            aria-disabled={updating || undefined}
            onClick={onStartEdit}
            className={rowButton}
          >
            Edit
          </button>
          <button
            type="button"
            data-action="delete"
            aria-label={`Delete "${task.title}"`}
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
