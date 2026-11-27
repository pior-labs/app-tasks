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
import type { List, Member } from './lists';
import { type Repeat, type RepeatForm, repeatLabel } from './repeat';
import { Pencil, Repeat as RepeatIcon, Trash2, UserRound, Users } from 'lucide-react';
import { cn } from './cn';
import {
  FieldError,
  buttonClass,
  iconButtonClass,
  selectClass,
  smallControlClass,
  textareaClass,
} from './ui';

// dueDate is a calendar day, "YYYY-MM-DD", or null for no due date. repeat is
// null for a task that does not repeat; only a task with a due date repeats.
// notes is plain text, or null for none. listId is the task's list, or null
// for Inbox. createdById, completedById and assigneeId are member ids, or null
// when unknown or none; only a task in a shared list has an assignee.
export type Task = {
  id: number;
  title: string;
  listId: number | null;
  notes: string | null;
  completed: boolean;
  dueDate: string | null;
  repeat: Repeat | null;
  createdById: number | null;
  completedById: number | null;
  assigneeId: number | null;
};

// Who added, completed and is assigned a task in a shared list, as the row
// says it. Each is null when there is nothing to say (see sharedLabels in
// Tasks.tsx).
export type ShareLabels = { addedBy: string | null; doneBy: string | null; assigned: string | null };

// What a row is doing besides showing its task. Only one row edits at a time
// and only one asks for a delete confirmation at a time; Tasks owns that state.
export type RowMode =
  | { kind: 'view' }
  // dueDate is the date field's value: "YYYY-MM-DD", or empty for none. notes
  // is the notes field's value, empty for none. listId is the List select's
  // value, null for Inbox. assigneeId is the "Assigned to" select's value,
  // null for Nobody. The error belongs to the field named by errorField.
  | {
      kind: 'edit';
      text: string;
      dueDate: string;
      repeat: RepeatForm;
      notes: string;
      listId: number | null;
      assigneeId: number | null;
      error: string;
      errorField: 'title' | 'dueDate' | 'repeat' | 'notes' | 'list' | 'assignee';
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
  // The attribution and assignee labels, for a task in a shared list only.
  shareLabels: ShareLabels | null;
  // The members to offer in the "Assigned to" select, or null for no select
  // (the edit row's List choice is not a shared list). `me` is the user's id.
  assignees: Member[] | null;
  me: number;
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
  onEditAssignee: (assigneeId: number | null) => void;
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
      // Indented like the due date line, to line up with the title: the
      // checkbox (1.375rem) plus the gap (0.75rem).
      className={`ml-[2.125rem] max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-sm text-[14px] leading-relaxed ${
        completed ? 'text-muted-foreground' : 'text-ink-2'
      }`}
    >
      {notes}
    </div>
  );
}


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
  shareLabels,
  assignees,
  me,
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
  onEditAssignee,
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
    const assigneeError = mode.error !== '' && mode.errorField === 'assignee';
    const checkEmptied = (event: SyntheticEvent<HTMLInputElement>) => {
      if (holdsNoDate(event.currentTarget)) onDueDateEmptied();
    };
    const submit = (event: FormEvent) => {
      event.preventDefault();
      onSave();
    };
    // A select is as wide as its longest option, so it is capped at the row's
    // width: a long list name is cut short inside the control instead of
    // pushing it off a phone screen.
    const selectField = cn(smallControlClass, selectClass, 'min-w-0 max-w-full aria-disabled:opacity-60');
    return (
      <li ref={rowRef} className="bg-[var(--tk-editing-bg)] px-5 py-4">
        <form onSubmit={submit} onKeyDown={escapeTo(onCancelEdit)} noValidate className="flex flex-wrap items-center gap-2">
          <input
            data-action="edit-title"
            aria-label={`New title for "${task.title}"`}
            value={mode.text}
            onChange={(event) => onEditText(event.target.value)}
            readOnly={mode.saving}
            autoComplete="off"
            aria-invalid={titleError || undefined}
            aria-describedby={titleError ? errorId : undefined}
            className={cn(smallControlClass, 'min-w-48 basis-full font-medium')}
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
            className={smallControlClass}
          />
          {mode.dueDate !== '' && (
            <button
              type="button"
              data-action="remove-due-date"
              aria-label={`Remove due date for "${task.title}"`}
              aria-disabled={mode.saving || undefined}
              onClick={onRemoveDueDate}
              className={buttonClass('quiet', 'small')}
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
            className={smallControlClass}
            onChange={onEditRepeat}
          />
          {mode.dueDate === '' && <RepeatHint idBase={`task-${task.id}`} className="basis-full px-1" />}
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
            className={selectField}
          >
            <option value="">Inbox</option>
            {lists.map((list) => (
              <option key={list.id} value={String(list.id)}>
                {list.shared ? `${list.name} (shared)` : list.name}
              </option>
            ))}
          </select>
          {/* Only for a task that stays in (or moves to) a shared list, after the List select. */}
          {assignees && (
            <select
              data-action="edit-assignee"
              aria-label={`Assigned to, for "${task.title}"`}
              value={mode.assigneeId === null ? '' : String(mode.assigneeId)}
              onChange={(event) => {
                if (mode.saving) return;
                onEditAssignee(event.target.value === '' ? null : Number(event.target.value));
              }}
              aria-disabled={mode.saving || undefined}
              aria-invalid={assigneeError || undefined}
              aria-describedby={assigneeError ? errorId : undefined}
              className={selectField}
            >
              <option value="">Nobody</option>
              {assignees.map((member) => (
                <option key={member.id} value={String(member.id)}>
                  {member.id === me ? `Me (${member.name})` : member.name}
                </option>
              ))}
            </select>
          )}
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
            className={cn(smallControlClass, textareaClass, 'basis-full')}
          />
          {mode.error && (
            <FieldError id={errorId} className="basis-full px-1">
              {mode.error}
            </FieldError>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="submit"
              data-action="save"
              aria-disabled={mode.saving || undefined}
              className={buttonClass('primary', 'small')}
            >
              {mode.saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              data-action="cancel-edit"
              onClick={onCancelEdit}
              aria-disabled={mode.saving || undefined}
              className={buttonClass('quiet', 'small')}
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  const deleting = mode.kind === 'confirm-delete' && mode.deleting;
  const dueId = `task-${task.id}-due`;
  // A completed task shows its due date but is never marked overdue.
  const overdue = task.dueDate !== null && !task.completed && dueStatus(task.dueDate, today) === 'overdue';
  const shareLine = shareLabels
    ? [shareLabels.addedBy, shareLabels.doneBy, shareLabels.assigned].filter((label): label is string => label !== null)
    : [];
  const hasDetails = task.dueDate !== null || listName !== null || shareLine.length > 0;
  return (
    <li
      ref={rowRef}
      className={cn(
        'group flex flex-wrap items-start gap-x-2 gap-y-2 px-5 py-3 transition-colors',
        mode.kind === 'confirm-delete' ? 'bg-[var(--tk-danger-surface)]' : 'hover:bg-ink/[0.025]',
      )}
    >
      <div className="flex min-w-48 flex-1 flex-col gap-1 py-0.5">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            data-action="toggle"
            checked={task.completed}
            aria-disabled={updating || deleting || undefined}
            aria-describedby={task.dueDate === null ? undefined : dueId}
            onChange={(event) => onToggle(event.target.checked)}
            className="tk-check mt-px aria-disabled:opacity-50"
          />
          <span
            className={`min-w-0 break-words text-[16px] leading-snug ${
              task.completed ? 'text-muted-foreground line-through decoration-ink/30' : 'text-ink'
            }`}
          >
            {task.title}
          </span>
        </label>
        {/* The details, quieter, on one line under the title (D-9): when it is
            due and how it repeats, its list in views that mix lists, and in
            a shared list who added, completed and has it. */}
        {hasDetails && (
          <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 pl-[2.125rem] text-[13px] leading-snug text-muted-foreground">
            {task.dueDate !== null && (
              <span id={dueId} className={cn('inline-flex flex-wrap items-center gap-x-1.5', overdue && 'text-destructive')}>
                {/* Overdue is said in words, not only by the colour. */}
                {overdue && (
                  <>
                    <span className="font-semibold">Overdue</span>
                    {' \u00B7 '}
                  </>
                )}
                <span>{dueLabel(task.dueDate, today)}</span>
                {/* Each separator stays with the words after it, so a wrapped
                    line never starts with a stray dot. */}
                {task.repeat && (
                  <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    {' \u00B7 '}
                    <RepeatIcon aria-hidden="true" className="size-3 shrink-0" strokeWidth={2.2} />
                    {repeatLabel(task.repeat)}
                  </span>
                )}
              </span>
            )}
            {listName !== null && (
              // After the due date, outside the checkbox's description.
              <span data-list-label className="min-w-0 break-words text-muted-foreground">
                <span className="sr-only">List: </span>
                {listName}
              </span>
            )}
            {shareLine.length > 0 && (
              <span data-share-labels className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 break-words">
                {shareLabels?.assigned ? (
                  <UserRound aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} />
                ) : (
                  <Users aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2} />
                )}
                {shareLine.map((label, index) => (
                  <span key={label} className="whitespace-nowrap">
                    {index > 0 && ' \u00B7 '}
                    {label}
                  </span>
                ))}
              </span>
            )}
          </p>
        )}
        {task.notes !== null && <TaskNotes title={task.title} notes={task.notes} completed={task.completed} />}
      </div>
      {mode.kind === 'confirm-delete' ? (
        <div
          role="group"
          aria-label={`Delete "${task.title}"?`}
          onKeyDown={escapeTo(onCancelDelete)}
          className="ml-auto flex flex-wrap items-center gap-2"
        >
          <span className="text-[13px] font-medium text-[var(--tk-danger-ink-strong)]">Delete this task?</span>
          <button
            type="button"
            data-action="confirm-delete"
            aria-label={`Confirm deleting "${task.title}"`}
            aria-disabled={deleting || updating || undefined}
            onClick={onConfirmDelete}
            className={buttonClass('danger', 'small')}
          >
            {deleting ? 'Deleting...' : 'Confirm'}
          </button>
          <button
            type="button"
            data-action="cancel-delete"
            aria-label={`Cancel deleting "${task.title}"`}
            aria-disabled={deleting || undefined}
            onClick={onCancelDelete}
            className={buttonClass('ghost', 'small')}
          >
            Cancel
          </button>
        </div>
      ) : (
        // Quiet until wanted: with a mouse, Edit and Delete show on hover or
        // when a control of the row has focus; on touch they always show.
        <div className="ml-auto flex items-center gap-0.5 transition-opacity duration-150 motion-reduce:transition-none pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100">
          <button
            type="button"
            data-action="edit"
            aria-label={`Edit "${task.title}"`}
            title="Edit"
            aria-disabled={editLocked || undefined}
            onClick={onStartEdit}
            className={iconButtonClass()}
          >
            <Pencil aria-hidden="true" className="size-4" strokeWidth={2} />
          </button>
          <button
            type="button"
            data-action="delete"
            aria-label={`Delete "${task.title}"`}
            title="Delete"
            aria-disabled={deleteLocked || undefined}
            onClick={onStartDelete}
            className={iconButtonClass('danger')}
          >
            <Trash2 aria-hidden="true" className="size-4" strokeWidth={2} />
          </button>
        </div>
      )}
    </li>
  );
}
