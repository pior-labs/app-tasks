import {
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  type SyntheticEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { MAX_DUE_DATE, MIN_DUE_DATE, dueLabel, dueStatus, holdsNoDate } from './dueDate';
import { RepeatControl, RepeatHint } from './RepeatControl';
import type { List } from './lists';
import { type Repeat, type RepeatForm, repeatLabel } from './repeat';

// dueDate is a calendar day, "YYYY-MM-DD", or null for no due date. repeat is
// null for a task that does not repeat; only a task with a due date repeats.
// notes is plain text, or null for none. listId is the task's list, or null
// for Inbox.
export type Task = {
  id: number;
  title: string;
  listId: number | null;
  notes: string | null;
  completed: boolean;
  dueDate: string | null;
  repeat: Repeat | null;
};

// What a row is doing besides showing its task. Only one row edits at a time
// and only one asks for a delete confirmation at a time; Tasks owns that state.
export type RowMode =
  | { kind: 'view' }
  // dueDate is the date field's value: "YYYY-MM-DD", or empty for none. notes
  // is the notes field's value, empty for none. listId is the List select's
  // value, null for Inbox. The error belongs to the field named by errorField.
  | {
      kind: 'edit';
      text: string;
      dueDate: string;
      repeat: RepeatForm;
      notes: string;
      listId: number | null;
      error: string;
      errorField: 'title' | 'dueDate' | 'repeat' | 'notes' | 'list';
      saving: boolean;
    }
  | { kind: 'confirm-delete'; deleting: boolean };

type Props = {
  task: Task;
  mode: RowMode;
  // The browser's local date, "YYYY-MM-DD", for the due date label.
  today: string;
  // The user's lists, for the List select in edit mode.
  lists: List[];
  // The name of the task's list to show in the row, or null for none.
  listName: string | null;
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
  // badInput: the field holds a partly typed date, which is not "no date".
  onEditDueDate: (dueDate: string, badInput: boolean) => void;
  // The date field holds no date, found on keyup or blur: emptying its last
  // part fires no change event.
  onDueDateEmptied: () => void;
  onRemoveDueDate: () => void;
  onEditRepeat: (repeat: RepeatForm) => void;
  onEditNotes: (notes: string) => void;
  onEditList: (listId: number | null) => void;
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

// In a notes field Enter is a new line, so Ctrl+Enter (Cmd+Enter on a Mac)
// submits the form instead, as Enter does in the one-line fields.
export const submitOnModEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
};

// A task's notes in its row: plain text with its line breaks, never parsed as
// Markdown or HTML. Long notes are capped at a fixed height (max-h-40) and
// scroll. Only notes that actually overflow the cap become a focusable, named
// region, so keyboard users can scroll them; short notes add no Tab stop. The
// overflow is measured after each render and whenever the box is resized.
// While the notes overflow and are not scrolled to the end, data-notes-more
// fades out their bottom edge (see index.css), a cue that works with overlay
// scroll bars that are not drawn until the box is scrolled.
function TaskNotes({ title, notes, completed }: { title: string; notes: string; completed: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const overflows = element.scrollHeight > element.clientHeight;
      setOverflowing(overflows);
      // Within 2px of the bottom counts as the end (scrollTop can be fractional).
      setMore(overflows && element.scrollHeight - element.clientHeight - element.scrollTop > 2);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [notes]);
  return (
    <div
      ref={box}
      data-notes
      onScroll={() => {
        const element = box.current;
        if (element) setMore(element.scrollHeight - element.clientHeight - element.scrollTop > 2);
      }}
      {...(more ? { 'data-notes-more': '' } : {})}
      {...(overflowing ? { tabIndex: 0, role: 'region', 'aria-label': `Notes for "${title}"` } : {})}
      // Indented like the due date line, to line up with the title.
      className={`ml-8 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-sm text-sm ${
        completed ? 'text-muted-foreground' : ''
      }`}
    >
      {notes}
    </div>
  );
}

const rowButton =
  'shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium aria-disabled:opacity-50';

// Pending controls are locked with readOnly and aria-disabled instead of
// disabled, because a disabled control loses keyboard focus. (Without a due
// date the Repeats controls are disabled outright; see RepeatControl.) Tasks ignores the
// repeat input. The data-action attributes let Tasks move focus between the
// controls of a row.
export function TaskRow({
  task,
  mode,
  today,
  lists,
  listName,
  updating,
  editLocked,
  deleteLocked,
  rowRef,
  onToggle,
  onStartEdit,
  onEditText,
  onEditDueDate,
  onDueDateEmptied,
  onRemoveDueDate,
  onEditRepeat,
  onEditNotes,
  onEditList,
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
    const repeatError = mode.error !== '' && mode.errorField === 'repeat';
    const notesError = mode.error !== '' && mode.errorField === 'notes';
    const listError = mode.error !== '' && mode.errorField === 'list';
    const fieldClass =
      'rounded-md border border-border bg-card px-3 py-1.5 text-card-foreground';
    const checkEmptied = (event: SyntheticEvent<HTMLInputElement>) => {
      if (holdsNoDate(event.currentTarget)) onDueDateEmptied();
    };
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
            onChange={(event) => onEditDueDate(event.target.value, event.target.validity?.badInput ?? false)}
            onKeyUp={checkEmptied}
            onBlur={checkEmptied}
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
          <RepeatControl
            idBase={`task-${task.id}`}
            names={{
              choice: `Repeats for "${task.title}"`,
              every: `Repeat interval for "${task.title}"`,
              unit: `Repeat unit for "${task.title}"`,
            }}
            form={mode.repeat}
            seed={task.repeat}
            available={mode.dueDate !== ''}
            locked={mode.saving}
            invalid={repeatError}
            errorId={errorId}
            className={fieldClass}
            onChange={onEditRepeat}
          />
          {mode.dueDate === '' && <RepeatHint idBase={`task-${task.id}`} className="basis-full text-right" />}
          {/* After the date and repeat and before the notes, so title to date stays one Tab (D-7). */}
          <select
            data-action="edit-list"
            aria-label={`List for "${task.title}"`}
            value={mode.listId === null ? '' : String(mode.listId)}
            onChange={(event) => {
              // A pending save keeps the choice, like readOnly on the text fields.
              if (mode.saving) return;
              onEditList(event.target.value === '' ? null : Number(event.target.value));
            }}
            aria-disabled={mode.saving || undefined}
            aria-invalid={listError || undefined}
            aria-describedby={listError ? errorId : undefined}
            className={`${fieldClass} aria-disabled:opacity-60`}
          >
            <option value="">Inbox</option>
            {lists.map((list) => (
              <option key={list.id} value={String(list.id)}>
                {list.name}
              </option>
            ))}
          </select>
          {/* Full width, after the date and repeat and before Save in Tab order. */}
          <textarea
            data-action="edit-notes"
            aria-label={`Notes for "${task.title}"`}
            placeholder="Notes"
            value={mode.notes}
            onChange={(event) => onEditNotes(event.target.value)}
            onKeyDown={submitOnModEnter}
            readOnly={mode.saving}
            rows={3}
            aria-invalid={notesError || undefined}
            aria-describedby={notesError ? errorId : undefined}
            className={`${fieldClass} basis-full read-only:opacity-60`}
          />
          <button
            type="submit"
            data-action="save"
            aria-disabled={mode.saving || undefined}
            className={`${rowButton} border-primary bg-primary text-primary-foreground`}
          >
            {mode.saving ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            data-action="cancel-edit"
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
            {task.repeat && (
              <>
                {' \u00B7 '}
                <span className="whitespace-nowrap">{repeatLabel(task.repeat)}</span>
              </>
            )}
          </p>
        )}
        {listName !== null && (
          // A muted label after the due date line, outside the checkbox's description.
          <p data-list-label className="break-words pl-8 text-sm text-muted-foreground">
            <span className="sr-only">List: </span>
            {listName}
          </p>
        )}
        {task.notes !== null && (
          <TaskNotes title={task.title} notes={task.notes} completed={task.completed} />
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
