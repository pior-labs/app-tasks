import { type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { CalendarDays, List as ListIcon, Repeat as RepeatIcon, StickyNote, X } from 'lucide-react';
import { cn } from './cn';
import { MAX_DUE_DATE, MIN_DUE_DATE, addDays, dueLabel, holdsNoDate } from './dueDate';
import type { List } from './lists';
import { RepeatControl } from './RepeatControl';
import { NO_REPEAT, type RepeatForm, repeatFromForm, repeatLabel, withoutRepeat } from './repeat';
import { submitOnModEnter } from './TaskRow';
import { FieldError, buttonClass, controlClass, focusRing, labelClass, smallControlClass, textareaClass } from './ui';

// The chip whose options show under the chips, if any.
export type AddDetail = 'date' | 'repeat' | 'list' | 'notes';
// The add form's field a message is about.
export type AddField = 'title' | 'dueDate' | 'repeat' | 'notes' | 'list';
export const detailOf = (field: AddField): AddDetail | null =>
  field === 'dueDate' ? 'date' : field === 'title' ? null : field;

// What the user has typed and chosen so far. It lives in Tasks, so closing the
// sheet without adding keeps it for the next time it opens.
export type AddDraft = {
  title: string;
  // "YYYY-MM-DD", or empty for no due date.
  dueDate: string;
  repeat: RepeatForm;
  notes: string;
  // The chosen list, or null for Inbox.
  listId: number | null;
};

type Props = {
  id: string;
  // The id of the page behind the sheet, inert while the sheet is open.
  pageId: string;
  draft: AddDraft;
  lists: List[];
  // The browser's local date, for the date shortcuts and the chip's words.
  today: string;
  detail: AddDetail | null;
  error: { message: string; field: AddField } | null;
  // The add is waiting for the server: every control is locked.
  creating: boolean;
  titleRef: RefObject<HTMLInputElement | null>;
  dueDateRef: RefObject<HTMLInputElement | null>;
  onChange: (change: Partial<AddDraft>) => void;
  onDetail: (detail: AddDetail | null) => void;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
};

const ERROR_ID = 'new-task-error';

// While the sheet is open the page behind it is inert, which takes the page's
// live regions out of the accessibility tree: a notice or an error posted
// there meanwhile (a refresh's "... so Inbox is shown.", a failed save, the
// lists failing to load) would not be announced. This watches the page's
// live regions and returns each message that appears there, to be said again
// in the sheet's own live regions: status-like ones politely, alerts
// assertively. Messages already shown when the sheet opened are not repeated,
// and the sheet's own errors are outside the page, so they are said once.
function usePageMessages(pageId: string) {
  const [messages, setMessages] = useState({ polite: '', assertive: '' });
  useEffect(() => {
    const page = document.getElementById(pageId);
    if (!page) return;
    const regions = () =>
      [...page.querySelectorAll<HTMLElement>('[role="status"], [role="alert"], [aria-live]')].filter(
        (region) => region.getAttribute('aria-live') !== 'off' && !region.closest('[hidden]'),
      );
    const text = (region: HTMLElement) => region.textContent?.trim() ?? '';
    // What each region said last; a region that is new since then counts as changed.
    const said = new WeakMap<HTMLElement, string>();
    for (const region of regions()) said.set(region, text(region));
    const observer = new MutationObserver(() => {
      const polite: string[] = [];
      const assertive: string[] = [];
      for (const region of regions()) {
        const now = text(region);
        if (said.get(region) === now) continue;
        said.set(region, now);
        if (now === '') continue;
        const urgent = region.getAttribute('role') === 'alert' || region.getAttribute('aria-live') === 'assertive';
        (urgent ? assertive : polite).push(now);
      }
      if (polite.length > 0 || assertive.length > 0) {
        setMessages((current) => ({
          polite: polite.length > 0 ? polite.join(' ') : current.polite,
          assertive: assertive.length > 0 ? assertive.join(' ') : current.assertive,
        }));
      }
    });
    observer.observe(page, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [pageId]);
  return messages;
}
const chipValue = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// One detail of the new task as a pill: the button names the detail and its
// value ("Due date: Tomorrow") and shows or hides its options; a set value has
// a clear (x) control beside it.
function Chip({
  icon,
  label,
  name,
  detail,
  open,
  set,
  locked,
  clearLabel,
  onToggle,
  onClear,
}: {
  icon: ReactNode;
  label: string;
  name: string;
  detail: AddDetail;
  open: boolean;
  set: boolean;
  locked: boolean;
  clearLabel?: string;
  onToggle: () => void;
  onClear?: () => void;
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-full text-[13px] transition-colors',
        set ? 'bg-ink text-cream' : 'bg-ink/[0.06] text-ink-2',
        open && !set && 'bg-ink/[0.11] text-ink',
      )}
    >
      <button
        type="button"
        aria-label={name}
        aria-expanded={open}
        aria-controls={`new-task-${detail}-options`}
        onClick={onToggle}
        className={cn(
          'flex min-h-9 min-w-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent py-1.5 pl-3 font-[inherit] text-inherit pointer-coarse:min-h-11',
          onClear ? 'pr-1.5' : 'pr-3',
          focusRing,
        )}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {onClear && (
        <button
          type="button"
          aria-label={clearLabel}
          aria-disabled={locked || undefined}
          onClick={onClear}
          className={cn(
            'mr-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-inherit hover:bg-cream/15 aria-disabled:cursor-progress pointer-coarse:size-11',
            focusRing,
          )}
        >
          <X aria-hidden="true" className="size-3.5" strokeWidth={2.2} />
        </button>
      )}
    </span>
  );
}

// The modal sheet behind the + button: the title first, then the details as
// chips (Date, Repeat once a date is set, List and Notes), each opening its
// options under the chips. Tab stays inside while it is open; Escape, Cancel
// and the backdrop close it, except while the add is pending. Pending
// controls are locked with readOnly and aria-disabled, like the rest of Tasks.
export function AddSheet({
  id,
  pageId,
  draft,
  lists,
  today,
  detail,
  error,
  creating,
  titleRef,
  dueDateRef,
  onChange,
  onDetail,
  onSubmit,
  onClose,
}: Props) {
  const sheet = useRef<HTMLFormElement>(null);
  const pageMessages = usePageMessages(pageId);
  // Focus starts in the title field.
  useEffect(() => {
    titleRef.current?.focus();
  }, [titleRef]);

  // Tab and Shift+Tab wrap around inside the sheet; Escape closes it.
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [
      ...(sheet.current?.querySelectorAll<HTMLElement>('input, button, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []),
    ].filter((element) => !element.closest('[hidden]') && !(element as HTMLButtonElement).disabled);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const fieldError = (field: AddField) => error?.field === field;
  const describedBy = (field: AddField) => (fieldError(field) ? ERROR_ID : undefined);
  const errorText = (field: AddField) =>
    fieldError(field) ? (
      <FieldError id={ERROR_ID} className="px-1">
        {error!.message}
      </FieldError>
    ) : null;
  const toggle = (next: AddDetail) => onDetail(detail === next ? null : next);
  // Changes are ignored while the add is pending, like typing in a readOnly field.
  const change = (next: Partial<AddDraft>) => {
    if (!creating) onChange(next);
  };

  const repeatChoice = draft.dueDate === '' ? { repeat: null } : repeatFromForm(draft.repeat);
  const repeatText =
    draft.repeat.choice === 'none'
      ? null
      : 'repeat' in repeatChoice && repeatChoice.repeat
        ? chipValue(repeatLabel(repeatChoice.repeat).replace(/^Repeats /, ''))
        : 'Custom';
  const dateText = draft.dueDate === '' ? null : chipValue(dueLabel(draft.dueDate, today).replace(/^Due /, ''));
  const list = draft.listId === null ? undefined : lists.find((item) => item.id === draft.listId);
  const listText = list?.name ?? 'Inbox';
  const hasNotes = draft.notes.trim() !== '';
  // Keyed by what it chooses, not its label: two lists can share a name
  // (names are unique per owner only).
  const option = (key: string, label: string, selected: boolean, pick: () => void, extra?: ReactNode) => (
    <button
      key={key}
      type="button"
      aria-pressed={selected}
      aria-disabled={creating || undefined}
      onClick={() => {
        if (!creating) pick();
      }}
      className={buttonClass(selected ? 'primary' : 'quiet', 'small', 'max-w-full')}
    >
      <span className="min-w-0 truncate">{label}</span>
      {extra}
    </button>
  );
  const setDate = (dueDate: string) => change({ dueDate });
  const chipIcon = 'size-3.5 shrink-0';

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:px-6 sm:pb-6">
      <div aria-hidden="true" className="tk-scrim absolute inset-0" onClick={() => onClose()} />
      <form
        ref={sheet}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label="New task"
        // A click on the sheet's own surface keeps focus in it, instead of
        // dropping it onto the page behind.
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onSubmit={onSubmit}
        noValidate
        className="tk-sheet relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-xl flex-col overflow-y-auto rounded-t-[30px] bg-[var(--tk-sheet-solid)] px-5 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-[var(--tk-menu-shadow)] focus:outline-none sm:rounded-[30px] sm:pt-5"
      >
        <div aria-hidden="true" className="mx-auto mb-4 h-1 w-10 shrink-0 rounded-full bg-ink/15 sm:hidden" />
        {/* On the page from the start, empty, so a message put in them is announced. */}
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {pageMessages.polite}
        </div>
        <div aria-live="assertive" aria-atomic="true" className="sr-only">
          {pageMessages.assertive}
        </div>
        <label htmlFor="new-task-title" className="sr-only">
          New task
        </label>
        <input
          id="new-task-title"
          ref={titleRef}
          value={draft.title}
          onChange={(event) => change({ title: event.target.value })}
          readOnly={creating}
          placeholder="What needs doing?"
          autoComplete="off"
          aria-invalid={fieldError('title') || undefined}
          aria-describedby={describedBy('title')}
          className="w-full min-w-0 rounded-xl border-0 bg-transparent px-1 py-1 font-serif text-[24px] text-ink placeholder:text-ink-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 read-only:opacity-60"
        />
        {errorText('title')}
        <div className="mt-4 flex flex-wrap gap-2">
          <Chip
            icon={<CalendarDays aria-hidden="true" className={chipIcon} />}
            label={dateText ?? 'Date'}
            name={`Due date: ${dateText ?? 'none'}`}
            detail="date"
            open={detail === 'date'}
            set={dateText !== null}
            locked={creating}
            clearLabel="Clear due date"
            onToggle={() => toggle('date')}
            // Clearing the date clears the repeat with it.
            onClear={dateText === null ? undefined : () => change({ dueDate: '', repeat: NO_REPEAT })}
          />
          {draft.dueDate !== '' && (
            <Chip
              icon={<RepeatIcon aria-hidden="true" className={chipIcon} />}
              label={repeatText ?? 'Repeat'}
              name={`Repeat: ${repeatText ?? 'none'}`}
              detail="repeat"
              open={detail === 'repeat'}
              set={repeatText !== null}
              locked={creating}
              clearLabel="Clear repeat"
              onToggle={() => toggle('repeat')}
              onClear={repeatText === null ? undefined : () => change({ repeat: NO_REPEAT })}
            />
          )}
          <Chip
            icon={<ListIcon aria-hidden="true" className={chipIcon} />}
            label={listText}
            name={`List: ${listText}`}
            detail="list"
            open={detail === 'list'}
            set={false}
            locked={creating}
            onToggle={() => toggle('list')}
          />
          <Chip
            icon={<StickyNote aria-hidden="true" className={chipIcon} />}
            label="Notes"
            name={`Notes: ${hasNotes ? 'added' : 'none'}`}
            detail="notes"
            open={detail === 'notes'}
            set={hasNotes}
            locked={creating}
            clearLabel="Clear notes"
            onToggle={() => toggle('notes')}
            onClear={hasNotes ? () => change({ notes: '' }) : undefined}
          />
        </div>
        {/* Every chip's options stay on the page while hidden, so a partly
            typed date still counts as one when the Date options are closed. */}
        <div id="new-task-date-options" hidden={detail !== 'date'} className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {option('today', 'Today', draft.dueDate === today, () => setDate(today))}
            {option('tomorrow', 'Tomorrow', draft.dueDate === addDays(today, 1), () => setDate(addDays(today, 1)))}
            {option('next-week', 'Next week', draft.dueDate === addDays(today, 7), () => setDate(addDays(today, 7)))}
            <label htmlFor="new-task-due-date" className="sr-only">
              Due date
            </label>
            <input
              id="new-task-due-date"
              ref={dueDateRef}
              type="date"
              value={draft.dueDate}
              min={MIN_DUE_DATE}
              max={MAX_DUE_DATE}
              onChange={(event) => {
                // Removing the date resets the repeat; a partly typed date does not.
                change({
                  dueDate: event.target.value,
                  ...(holdsNoDate(event.target) ? { repeat: NO_REPEAT } : {}),
                });
              }}
              // Emptying the last part of a date fires no change event, so the
              // key that did it, or leaving the field, resets the repeat.
              onKeyUp={(event) => {
                if (holdsNoDate(event.currentTarget)) change({ repeat: withoutRepeat(draft.repeat) });
              }}
              onBlur={(event) => {
                if (holdsNoDate(event.currentTarget)) change({ repeat: withoutRepeat(draft.repeat) });
              }}
              readOnly={creating}
              aria-invalid={fieldError('dueDate') || undefined}
              aria-describedby={describedBy('dueDate')}
              className={cn(smallControlClass, 'min-h-[34px] pointer-coarse:min-h-11')}
            />
          </div>
          {errorText('dueDate')}
        </div>
        {draft.dueDate !== '' && (
          <div id="new-task-repeat-options" hidden={detail !== 'repeat'} className="mt-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-2.5">
              <RepeatControl
                idBase="new-task"
                visibleLabels
                names={{ choice: 'Repeats', every: 'Every', unit: 'Repeat unit' }}
                form={draft.repeat}
                seed={null}
                available
                locked={creating}
                invalid={fieldError('repeat')}
                errorId={ERROR_ID}
                className={smallControlClass}
                onChange={(repeat) => change({ repeat })}
              />
            </div>
            {errorText('repeat')}
          </div>
        )}
        <div id="new-task-list-options" hidden={detail !== 'list'} className="mt-3 flex flex-col gap-2">
          <div role="group" aria-label="List" className="flex flex-wrap gap-2">
            {option('inbox', 'Inbox', draft.listId === null, () => change({ listId: null }))}
            {lists.map((item) =>
              option(
                `list-${item.id}`,
                item.name,
                draft.listId === item.id,
                () => change({ listId: item.id }),
                item.shared ? <span className="sr-only">(shared)</span> : undefined,
              ),
            )}
          </div>
          {errorText('list')}
        </div>
        <div id="new-task-notes-options" hidden={detail !== 'notes'} className="mt-3 flex flex-col gap-2">
          <label htmlFor="new-task-notes" className={cn(labelClass, 'sr-only')}>
            Notes
          </label>
          {/* Enter is a new line here; Ctrl+Enter or Cmd+Enter adds the task. */}
          <textarea
            id="new-task-notes"
            value={draft.notes}
            onChange={(event) => change({ notes: event.target.value })}
            onKeyDown={submitOnModEnter}
            readOnly={creating}
            rows={3}
            placeholder="Anything to remember"
            aria-invalid={fieldError('notes') || undefined}
            aria-describedby={describedBy('notes')}
            className={cn(controlClass, textareaClass, 'min-w-0')}
          />
          {errorText('notes')}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            aria-disabled={creating || undefined}
            onClick={() => onClose()}
            className={buttonClass('quiet')}
          >
            Cancel
          </button>
          <button type="submit" aria-disabled={creating || undefined} className={buttonClass('primary')}>
            {creating ? 'Adding...' : 'Add task'}
          </button>
        </div>
      </form>
    </div>
  );
}
