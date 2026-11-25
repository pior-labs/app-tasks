import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Inbox, Layers, ListTodo, Pencil, Plus, Settings2, Trash2, UserCheck, Users } from 'lucide-react';
import { cn } from './cn';
import { jsonHeaders, serverError } from './http';
import {
  BUILT_IN_VIEWS,
  type List,
  type Member,
  type View,
  listFromServer,
  listNameProblem,
  tabId,
  viewName,
} from './lists';
import { FieldError, buttonClass, focusRing, labelClass, sheetClass, smallControlClass } from './ui';

export const TASKS_PANEL_ID = 'tasks-panel';
// For moving focus after a background refresh (see Tasks.tsx).
export const NEW_LIST_BUTTON_ID = 'new-list-button';
export const MANAGE_LISTS_BUTTON_ID = 'manage-lists-button';

type Props = {
  lists: List[];
  // The user's id, and every member, to tell whose a shared list is.
  me: number;
  members: Member[];
  // The lists could not be loaded: the built-in views still work.
  failed: boolean;
  // The view shown now (a missing list is already resolved to "All tasks").
  view: View;
  onSelect: (view: View) => void;
  onRetry: () => void;
  onCreated: (list: List) => void;
  // The server stored a rename, share or unshare of the list, which is still
  // the user's to see.
  onUpdated: (list: List) => void;
  // The user stopped sharing another member's list and can no longer see it.
  onLeft: (list: List) => void;
  // The server deleted the list and moved these tasks to Inbox (for a shared
  // list, each to the Inbox of whoever added it).
  onDeleted: (list: List, movedTaskIds: number[]) => void;
  // The list was already gone (deleted in another tab): drop it with a notice.
  onGone: (list: List, notice: string) => void;
  onSignedOut: () => void;
  // How many of the loaded tasks, open and completed, are in a list.
  taskCount: (id: number) => number;
  // Marks a list request as pending until the returned function is called, so
  // a background refresh does not overwrite its result (see Tasks.tsx).
  track: () => () => void;
};

export const goneListMessage = (list: List) => `"${list.name}" no longer exists, so it was removed.`;

function deleteQuestion(list: List, count: number) {
  if (count === 0) return `Delete ${list.name}? It has no tasks.`;
  const tasks = `${count} ${count === 1 ? 'task' : 'tasks'}`;
  // A shared list's tasks go back to whoever added each one (D-4).
  if (list.shared) return `Delete ${list.name}? Its ${tasks} will return to the Inbox of whoever added them.`;
  return `Delete ${list.name}? Its ${tasks} will move to Inbox.`;
}

// The rail's own buttons: quiet, full width on a wide screen.
const railButton = buttonClass('quiet', 'small', 'gap-2 md:w-full md:justify-start md:bg-transparent md:px-3');

// Escape anywhere in a form or question cancels it.
const escapeTo = (cancel: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  }
};

// The views and lists: "All tasks", "Inbox", "Assigned to me" and the user's
// lists in creation order, as an ARIA tablist with automatic activation (arrow
// keys, Home and End select a tab; only the selected tab is in the Tab order).
// "New list" and "Manage lists" are ordinary buttons after it. On a phone the
// tabs are a row that scrolls sideways inside itself; on a wide screen, a
// column in the rail. Pending controls are locked with readOnly and
// aria-disabled instead of disabled, which would drop focus.
//
// It returns two parts for the page to place: `nav` (the tabs, the list
// buttons and the new-list form) for the rail, and `panels` (Manage lists,
// which needs the width) for the main column.
export function useListBar({
  lists,
  me,
  members,
  failed,
  view,
  onSelect,
  onRetry,
  onCreated,
  onUpdated,
  onLeft,
  onDeleted,
  onGone,
  onSignedOut,
  taskCount,
  track,
}: Props): { nav: ReactNode; panels: ReactNode } {
  const [creating, setCreating] = useState<{ name: string; error: string; saving: boolean } | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  // A refresh can remove the last list too: Manage lists closes then, as when
  // the last list is deleted here, so it does not reopen with the next list.
  useEffect(() => {
    if (lists.length === 0) setManageOpen(false);
  }, [lists.length]);
  const [renaming, setRenaming] = useState<{ id: number; text: string; error: string; saving: boolean } | null>(null);
  const [confirming, setConfirming] = useState<{ id: number; deleting: boolean } | null>(null);
  // Sharing or unsharing a list: the request in progress, or the question
  // before a member stops sharing someone else's list (they lose access).
  const [sharing, setSharing] = useState<{ id: number; confirm: boolean; saving: boolean } | null>(null);
  // A failed delete, share or unshare.
  const [manageError, setManageError] = useState('');
  const pendingRef = useRef(false);
  const newListButton = useRef<HTMLButtonElement>(null);
  const manageRef = useRef<HTMLDivElement>(null);
  // Forms replace the control that had focus, so focus is moved on purpose,
  // to a target looked up after the next render has updated the page.
  const focusAfterRender = useRef<(() => HTMLElement | null | undefined) | null>(null);
  useEffect(() => {
    const target = focusAfterRender.current?.();
    focusAfterRender.current = null;
    target?.focus();
  });
  // A late answer after sign-out must not report anything.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const views: View[] = [...BUILT_IN_VIEWS, ...lists.map((list) => list.id)];
  const ownLists = lists.filter((list) => list.ownerId === me);
  const ownerName = (list: List) => members.find((member) => member.id === list.ownerId)?.name;
  const manageControl = (id: number, action: string) =>
    manageRef.current?.querySelector<HTMLElement>(`[data-list-id="${id}"] [data-action="${action}"]`);
  // After a list leaves the manage panel: the next list's Rename, else the
  // previous one's, else New list (Manage lists goes away with the last list).
  const focusAfterLeaving = (id: number) => {
    const index = lists.findIndex((list) => list.id === id);
    const neighbour = lists[index + 1] ?? lists[index - 1];
    focusAfterRender.current = () =>
      neighbour ? manageControl(neighbour.id, 'rename-list') : newListButton.current;
    if (!neighbour) setManageOpen(false);
  };

  function onTabKeyDown(event: KeyboardEvent) {
    const index = views.indexOf(view);
    const last = views.length - 1;
    // The tabs are a row on a phone and a column on a wide screen, so both
    // arrow pairs move along them.
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? index === last ? 0 : index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index === 0 ? last : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    onSelect(views[next]);
    document.getElementById(tabId(views[next]))?.focus();
  }

  function closeCreate() {
    if (pendingRef.current) return;
    setCreating(null);
    focusAfterRender.current = () => newListButton.current;
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!creating || pendingRef.current) return;
    const trimmed = creating.name.trim();
    // Names are unique among the user's own lists; another member's shared
    // list may have the same name.
    const problem = listNameProblem(trimmed, ownLists);
    if (problem) return setCreating({ ...creating, error: problem });
    pendingRef.current = true;
    const end = track();
    setCreating({ ...creating, error: '', saving: true });
    const fail = (error: string) => setCreating((current) => current && { ...current, error, saving: false });
    try {
      const response = await fetch('/api/lists', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name: trimmed }),
      });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      if (response.status === 400 || response.status === 409) {
        return fail((await serverError(response, 'That list name was not accepted.')).message);
      }
      if (!response.ok) throw new Error();
      const { list: created }: { list: List } = await response.json();
      const list = listFromServer(created, me);
      setCreating(null);
      onCreated(list);
      // The new tab is selected; keyboard users carry on from it.
      focusAfterRender.current = () => document.getElementById(tabId(list.id));
    } catch {
      fail('The list could not be saved. Please try again.');
    } finally {
      pendingRef.current = false;
      end();
    }
  }

  function startRename(list: List) {
    if (pendingRef.current) return;
    setConfirming(null);
    setSharing(null);
    setRenaming({ id: list.id, text: list.name, error: '', saving: false });
    focusAfterRender.current = () => {
      const field = manageControl(list.id, 'rename-field') as HTMLInputElement | null | undefined;
      field?.setSelectionRange(field.value.length, field.value.length);
      return field;
    };
  }

  function cancelRename(list: List) {
    if (pendingRef.current) return;
    setRenaming(null);
    focusAfterRender.current = () => manageControl(list.id, 'rename-list');
  }

  async function saveRename(event: FormEvent, list: List) {
    event.preventDefault();
    if (!renaming || renaming.id !== list.id || pendingRef.current) return;
    const trimmed = renaming.text.trim();
    // Nothing to store: leave rename mode without a request. Before the checks,
    // so a list stored before them keeps its name even where they would refuse
    // it now (a fullwidth "Inbox", say).
    if (trimmed === list.name) return cancelRename(list);
    // Checked against the owner's lists (D-3), as far as the user sees them.
    const problem = listNameProblem(
      trimmed,
      lists.filter((item) => item.ownerId === list.ownerId),
      list.id,
    );
    if (problem) return setRenaming({ ...renaming, error: problem });
    pendingRef.current = true;
    const end = track();
    setRenaming({ ...renaming, error: '', saving: true });
    const fail = (error: string) =>
      setRenaming((current) => (current?.id === list.id ? { ...current, error, saving: false } : current));
    try {
      const response = await fetch(`/api/lists/${list.id}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ name: trimmed }),
      });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      if (response.status === 404) {
        setRenaming(null);
        focusAfterLeaving(list.id);
        return onGone(list, goneListMessage(list));
      }
      if (response.status === 400 || response.status === 409) {
        return fail((await serverError(response, 'That list name was not accepted.')).message);
      }
      if (!response.ok) throw new Error();
      const body: { list: List } = await response.json();
      setRenaming(null);
      onUpdated(listFromServer(body.list, me));
      focusAfterRender.current = () => manageControl(list.id, 'rename-list');
    } catch {
      fail('The new name could not be saved. Please try again.');
    } finally {
      pendingRef.current = false;
      end();
    }
  }

  // Share with household, or stop sharing. Stopping sharing someone else's
  // list first asks, because the user then loses access to it (D-2).
  function startShareChange(list: List) {
    if (pendingRef.current) return;
    setRenaming(null);
    setConfirming(null);
    if (list.shared && list.ownerId !== me) {
      setSharing({ id: list.id, confirm: true, saving: false });
      // Focus lands on Cancel, so a repeated key press or click does not unshare.
      focusAfterRender.current = () => manageControl(list.id, 'cancel-unshare-list');
      return;
    }
    void saveShared(list, !list.shared);
  }

  function cancelUnshare(list: List) {
    if (pendingRef.current) return;
    setSharing(null);
    focusAfterRender.current = () => manageControl(list.id, 'share-list');
  }

  async function saveShared(list: List, shared: boolean) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    const end = track();
    const leaving = !shared && list.ownerId !== me;
    setSharing({ id: list.id, confirm: leaving, saving: true });
    setManageError('');
    try {
      const response = await fetch(`/api/lists/${list.id}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ shared }),
      });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      if (response.status === 404) {
        setSharing(null);
        focusAfterLeaving(list.id);
        return onGone(list, goneListMessage(list));
      }
      if (!response.ok) throw new Error();
      const body: { list: List } = await response.json();
      setSharing(null);
      if (leaving) {
        focusAfterLeaving(list.id);
        return onLeft(list);
      }
      onUpdated(listFromServer(body.list, me));
      // The button stays where it was, with its new label.
      focusAfterRender.current = () => manageControl(list.id, 'share-list');
    } catch {
      setSharing(leaving ? { id: list.id, confirm: true, saving: false } : null);
      setManageError(
        shared
          ? `"${list.name}" could not be shared. Please try again.`
          : `Sharing "${list.name}" could not be stopped. Please try again.`,
      );
    } finally {
      pendingRef.current = false;
      end();
    }
  }

  function startDelete(list: List) {
    if (pendingRef.current) return;
    setRenaming(null);
    setSharing(null);
    setConfirming({ id: list.id, deleting: false });
    // Focus lands on Cancel, so a repeated key press or click does not delete.
    focusAfterRender.current = () => manageControl(list.id, 'cancel-delete-list');
  }

  function cancelDelete(list: List) {
    if (pendingRef.current) return;
    setConfirming(null);
    focusAfterRender.current = () => manageControl(list.id, 'delete-list');
  }

  async function confirmDelete(list: List) {
    if (confirming?.id !== list.id || pendingRef.current) return;
    pendingRef.current = true;
    const end = track();
    setConfirming({ id: list.id, deleting: true });
    setManageError('');
    try {
      const response = await fetch(`/api/lists/${list.id}`, { method: 'DELETE' });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      if (response.status === 404) {
        setConfirming(null);
        focusAfterLeaving(list.id);
        return onGone(list, goneListMessage(list));
      }
      if (!response.ok) throw new Error();
      const body: { movedTaskIds: number[] } = await response.json();
      setConfirming(null);
      focusAfterLeaving(list.id);
      onDeleted(list, body.movedTaskIds);
    } catch {
      // The question stays, so the user can retry or cancel.
      setConfirming({ id: list.id, deleting: false });
      setManageError(`"${list.name}" could not be deleted. Please try again.`);
    } finally {
      pendingRef.current = false;
      end();
    }
  }
  const showManage = manageOpen && lists.length > 0;
  const firstListIndex = BUILT_IN_VIEWS.length;
  const nav = (
    <>
      {/* On a phone the tabs are one sideways row the width of the rail; on a
          wide screen they are a column. The keyboard takes either arrow pair. */}
      <div
        role="tablist"
        aria-label="Lists"
        onKeyDown={onTabKeyDown}
        className="tk-scroll-x -mx-1 flex min-w-0 basis-full gap-1 overflow-x-auto px-1 py-1 md:mx-0 md:basis-auto md:flex-col md:gap-0.5 md:overflow-visible md:px-0"
      >
        {views.map((item, index) => {
          const list = typeof item === 'number' ? lists.find((entry) => entry.id === item) : undefined;
          const Icon = item === 'all' ? Layers : item === 'inbox' ? Inbox : item === 'assigned' ? UserCheck : list?.shared ? Users : ListTodo;
          const selected = item === view;
          return (
            <button
              key={item}
              type="button"
              role="tab"
              id={tabId(item)}
              aria-selected={selected}
              aria-controls={TASKS_PANEL_ID}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(item)}
              // relative: the screen-reader-only "(shared)" text is absolutely
              // positioned, and must stay inside its tab, which the row clips,
              // instead of widening the page on a phone.
              className={cn(
                'relative flex min-h-10 shrink-0 cursor-pointer items-center gap-2.5 rounded-full border-0 py-1.5 pr-4 pl-1.5 text-left text-sm font-medium whitespace-nowrap transition-colors',
                'md:w-full md:pr-3',
                selected
                  ? 'bg-ink text-cream shadow-[0_6px_18px_-6px_color-mix(in_srgb,var(--ink)_45%,transparent)]'
                  : 'bg-transparent text-ink-2 hover:bg-frost/60 hover:text-ink',
                index === firstListIndex &&
                  "md:mt-4 md:before:pointer-events-none md:before:absolute md:before:inset-x-3 md:before:-top-2 md:before:border-t md:before:border-dashed md:before:border-ink/10 md:before:content-['']",
                focusRing,
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'inline-grid size-7 shrink-0 place-items-center rounded-full',
                  selected ? 'bg-cream/15 text-cream' : 'bg-frost/70 text-ink-2 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ink)_7%,transparent)]',
                )}
              >
                <Icon className="size-3.5" strokeWidth={2.1} />
              </span>
              <span className="min-w-0 md:truncate">{viewName(item, lists)}</span>
              {list?.shared && (
                <>
                  {' '}
                  <span className="sr-only">(shared)</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      {!failed && (
        <div className="flex min-w-0 flex-auto flex-wrap items-center gap-1.5 md:mt-1 md:flex-none md:flex-col md:items-stretch md:gap-0.5">
          <button
            type="button"
            id={NEW_LIST_BUTTON_ID}
            ref={newListButton}
            aria-expanded={creating !== null}
            aria-controls={creating ? 'new-list-form' : undefined}
            onClick={() => {
              if (creating) return closeCreate();
              setCreating({ name: '', error: '', saving: false });
              focusAfterRender.current = () => document.getElementById('new-list-name');
            }}
            className={railButton}
          >
            <Plus aria-hidden="true" className="size-4" strokeWidth={2.2} />
            New list
          </button>
          {lists.length > 0 && (
            <button
              type="button"
              id={MANAGE_LISTS_BUTTON_ID}
              aria-expanded={showManage}
              aria-controls={showManage ? 'manage-lists' : undefined}
              onClick={() => setManageOpen((open) => !open)}
              className={cn(railButton, showManage && 'bg-ink/[0.06] text-ink')}
            >
              <Settings2 aria-hidden="true" className="size-4" strokeWidth={2.1} />
              Manage lists
            </button>
          )}
        </div>
      )}
      {failed && (
        <div className="flex basis-full flex-col items-start gap-2 rounded-2xl bg-[var(--tk-danger-surface)] px-3.5 py-3">
          <p role="alert" className="m-0 text-[13px] font-medium text-[var(--tk-danger-ink-strong)]">
            Your lists could not be loaded.
          </p>
          <button type="button" onClick={onRetry} className={buttonClass('ghost', 'small')}>
            Load lists again
          </button>
        </div>
      )}
      {creating && (
        <form
          id="new-list-form"
          onSubmit={(event) => void create(event)}
          onKeyDown={escapeTo(closeCreate)}
          noValidate
          className="flex basis-full flex-col gap-2 rounded-[20px] bg-[rgba(var(--surface-rgb),0.7)] p-3 shadow-[inset_0_0_0_1px_rgba(var(--frost-rgb),0.6)]"
        >
          <label htmlFor="new-list-name" className={labelClass}>
            List name
          </label>
          <input
            id="new-list-name"
            value={creating.name}
            onChange={(event) => {
              const name = event.target.value;
              setCreating((current) => (current && !current.saving ? { ...current, name, error: '' } : current));
            }}
            readOnly={creating.saving}
            autoComplete="off"
            aria-invalid={creating.error !== '' || undefined}
            aria-describedby={creating.error ? 'new-list-error' : undefined}
            className={cn(smallControlClass, 'w-full min-w-0')}
          />
          {creating.error && <FieldError id="new-list-error">{creating.error}</FieldError>}
          <div className="flex flex-wrap gap-1.5">
            <button
              type="submit"
              aria-disabled={creating.saving || undefined}
              className={buttonClass('primary', 'small', 'flex-1')}
            >
              {creating.saving ? 'Creating...' : 'Create list'}
            </button>
            <button
              type="button"
              aria-label="Cancel new list"
              aria-disabled={creating.saving || undefined}
              onClick={closeCreate}
              className={buttonClass('quiet', 'small')}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </>
  );
  const panels = showManage && (
    <section id="manage-lists" ref={manageRef} aria-labelledby="manage-lists-heading" className={cn(sheetClass, 'tk-rise')}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-[var(--tk-soft-divider)] px-5 pt-4 pb-3">
        <h2 id="manage-lists-heading" className="m-0 font-serif text-[20px] leading-tight font-normal tracking-[-0.01em]">
          Manage lists
        </h2>
        <p className="m-0 text-[13px] text-ink-3">Rename, share with the household, or delete.</p>
      </div>
      {manageError && <FieldError className="px-5 pt-3">{manageError}</FieldError>}
      <ul aria-label="Your lists" className="m-0 list-none divide-y divide-[var(--tk-soft-divider)] p-0">
        {lists.map((list) => {
          const errorId = `list-${list.id}-rename-error`;
          if (renaming?.id === list.id) {
            return (
              <li key={list.id} data-list-id={list.id} className="bg-[var(--tk-editing-bg)] px-5 py-3">
                <form
                  onSubmit={(event) => void saveRename(event, list)}
                  onKeyDown={escapeTo(() => cancelRename(list))}
                  noValidate
                  className="flex flex-wrap items-center gap-2"
                >
                  <input
                    data-action="rename-field"
                    aria-label={`New name for "${list.name}"`}
                    value={renaming.text}
                    onChange={(event) => {
                      const text = event.target.value;
                      setRenaming((current) =>
                        current?.id === list.id && !current.saving ? { ...current, text, error: '' } : current,
                      );
                    }}
                    readOnly={renaming.saving}
                    autoComplete="off"
                    aria-invalid={renaming.error !== '' || undefined}
                    aria-describedby={renaming.error ? errorId : undefined}
                    className={cn(smallControlClass, 'min-w-40 flex-1')}
                  />
                  <button
                    type="submit"
                    aria-label={`Save the new name for "${list.name}"`}
                    aria-disabled={renaming.saving || undefined}
                    className={buttonClass('primary', 'small')}
                  >
                    {renaming.saving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    type="button"
                    aria-label={`Cancel renaming "${list.name}"`}
                    aria-disabled={renaming.saving || undefined}
                    onClick={() => cancelRename(list)}
                    className={buttonClass('quiet', 'small')}
                  >
                    Cancel
                  </button>
                  {renaming.error && (
                    <FieldError id={errorId} className="basis-full">
                      {renaming.error}
                    </FieldError>
                  )}
                </form>
              </li>
            );
          }
          const deleting = confirming?.id === list.id && confirming.deleting;
          const shareState = sharing?.id === list.id ? sharing : null;
          const owner = list.ownerId === me ? null : (ownerName(list) ?? 'another member');
          const asking = shareState?.confirm || confirming?.id === list.id;
          return (
            <li
              key={list.id}
              data-list-id={list.id}
              className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3', asking && 'bg-[var(--tk-danger-surface)]')}
            >
              {/* At least 10rem wide, so on a phone the buttons wrap below the name. */}
              <span className="min-w-40 flex-1 break-words">
                <span data-list-name className="font-medium">
                  {list.name}
                </span>
                {list.shared && (
                  <span data-list-sharing className="flex items-center gap-1.5 text-[13px] text-ink-2">
                    <Users aria-hidden="true" className="size-3.5" strokeWidth={2.1} />
                    {owner === null ? 'Shared with household' : `Shared by ${owner}`}
                  </span>
                )}
              </span>
              {shareState?.confirm ? (
                <div
                  role="group"
                  aria-label={`Stop sharing "${list.name}"?`}
                  onKeyDown={escapeTo(() => cancelUnshare(list))}
                  className="flex basis-full flex-wrap items-center gap-2"
                >
                  <span className="min-w-0 flex-1 basis-60 text-[13px] text-[var(--tk-danger-ink-strong)]">
                    Stop sharing {list.name}? It goes back to {owner} with all its tasks, and you will lose access to it.
                  </span>
                  <button
                    type="button"
                    data-action="confirm-unshare-list"
                    aria-label={`Confirm stopping sharing "${list.name}"`}
                    aria-disabled={shareState.saving || undefined}
                    onClick={() => void saveShared(list, false)}
                    className={buttonClass('danger', 'small')}
                  >
                    {shareState.saving ? 'Stopping...' : 'Stop sharing'}
                  </button>
                  <button
                    type="button"
                    data-action="cancel-unshare-list"
                    aria-label={`Cancel stopping sharing "${list.name}"`}
                    aria-disabled={shareState.saving || undefined}
                    onClick={() => cancelUnshare(list)}
                    className={buttonClass('ghost', 'small')}
                  >
                    Cancel
                  </button>
                </div>
              ) : confirming?.id === list.id ? (
                <div
                  role="group"
                  aria-label={`Delete list "${list.name}"?`}
                  onKeyDown={escapeTo(() => cancelDelete(list))}
                  className="flex basis-full flex-wrap items-center gap-2"
                >
                  <span className="min-w-0 flex-1 basis-60 text-[13px] text-[var(--tk-danger-ink-strong)]">
                    {deleteQuestion(list, taskCount(list.id))}
                  </span>
                  <button
                    type="button"
                    data-action="confirm-delete-list"
                    aria-label={`Confirm deleting list "${list.name}"`}
                    aria-disabled={deleting || undefined}
                    onClick={() => void confirmDelete(list)}
                    className={buttonClass('danger', 'small')}
                  >
                    {deleting ? 'Deleting...' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    data-action="cancel-delete-list"
                    aria-label={`Cancel deleting list "${list.name}"`}
                    aria-disabled={deleting || undefined}
                    onClick={() => cancelDelete(list)}
                    className={buttonClass('ghost', 'small')}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-action="rename-list"
                    aria-label={`Rename "${list.name}"`}
                    onClick={() => startRename(list)}
                    className={buttonClass('quiet', 'small')}
                  >
                    <Pencil aria-hidden="true" className="size-3.5" strokeWidth={2.1} />
                    Rename
                  </button>
                  <button
                    type="button"
                    data-action="share-list"
                    aria-label={list.shared ? `Stop sharing "${list.name}"` : `Share "${list.name}" with household`}
                    aria-disabled={shareState?.saving || undefined}
                    onClick={() => startShareChange(list)}
                    className={buttonClass('quiet', 'small')}
                  >
                    <Users aria-hidden="true" className="size-3.5" strokeWidth={2.1} />
                    {shareState?.saving
                      ? list.shared
                        ? 'Stopping...'
                        : 'Sharing...'
                      : list.shared
                        ? 'Stop sharing'
                        : 'Share with household'}
                  </button>
                  <button
                    type="button"
                    data-action="delete-list"
                    aria-label={`Delete list "${list.name}"`}
                    onClick={() => startDelete(list)}
                    className={buttonClass('quiet', 'small', 'hover:bg-destructive/10 hover:text-destructive')}
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" strokeWidth={2.1} />
                    Delete
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
  return { nav, panels };
}
