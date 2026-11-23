import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { jsonHeaders, serverError } from './http';
import { type List, type Member, type View, listFromServer, listNameProblem, tabId, viewName } from './lists';

export const TASKS_PANEL_ID = 'tasks-panel';

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

// The visible mark of a shared list: two people. The text next to it says
// "shared" to screen readers.
function SharedIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="inline-block size-4 shrink-0 align-[-0.2em]"
    >
      <circle cx="7" cy="6" r="3" />
      <circle cx="14" cy="7" r="2.5" />
      <path d="M1.5 16.5c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5z" />
      <path d="M13.5 16.5c0-1.9-.6-3.6-1.7-4.9.6-.3 1.4-.5 2.2-.5 2.6 0 4.5 2 4.5 4.6v.8z" />
    </svg>
  );
}

const smallButton =
  'shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium aria-disabled:opacity-50';
const fieldClass =
  'min-w-0 flex-1 rounded-md border border-border bg-card px-3 py-1.5 text-card-foreground read-only:opacity-60';

// Escape anywhere in a form or question cancels it.
const escapeTo = (cancel: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  }
};

// The tab row above the task area: "All tasks", "Inbox" and the user's lists
// in creation order, as an ARIA tablist with automatic activation (arrow keys,
// Home and End select a tab; only the selected tab is in the Tab order). "New
// list" and "Manage lists" are ordinary buttons after it. The row scrolls
// sideways inside itself when the tabs do not fit. Pending controls are locked
// with readOnly and aria-disabled instead of disabled, which would drop focus.
export function ListBar({
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
}: Props) {
  const [creating, setCreating] = useState<{ name: string; error: string; saving: boolean } | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
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

  const views: View[] = ['all', 'inbox', ...lists.map((list) => list.id)];
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
    const next =
      event.key === 'ArrowRight'
        ? index === last ? 0 : index + 1
        : event.key === 'ArrowLeft'
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
  const tabClass =
    'shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium aria-selected:bg-primary aria-selected:text-primary-foreground';
  const showManage = manageOpen && lists.length > 0;
  return (
    <div className="space-y-3">
      {/* On a phone the tabs get the full width and the buttons wrap below them. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Lists"
          onKeyDown={onTabKeyDown}
          className="flex w-full min-w-0 gap-1 overflow-x-auto py-1 sm:w-auto sm:flex-1"
        >
          {views.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              id={tabId(item)}
              aria-selected={item === view}
              aria-controls={TASKS_PANEL_ID}
              tabIndex={item === view ? 0 : -1}
              onClick={() => onSelect(item)}
              className={tabClass}
            >
              {viewName(item, lists)}
              {typeof item === 'number' && lists.find((list) => list.id === item)?.shared && (
                <>
                  {' '}
                  <SharedIcon />
                  <span className="sr-only">(shared)</span>
                </>
              )}
            </button>
          ))}
        </div>
        {!failed && (
          <button
            type="button"
            ref={newListButton}
            aria-expanded={creating !== null}
            aria-controls={creating ? 'new-list-form' : undefined}
            onClick={() => {
              if (creating) return closeCreate();
              setCreating({ name: '', error: '', saving: false });
              focusAfterRender.current = () => document.getElementById('new-list-name');
            }}
            className={smallButton}
          >
            New list
          </button>
        )}
        {!failed && lists.length > 0 && (
          <button
            type="button"
            aria-expanded={showManage}
            aria-controls={showManage ? 'manage-lists' : undefined}
            onClick={() => setManageOpen((open) => !open)}
            className={smallButton}
          >
            Manage lists
          </button>
        )}
      </div>
      {failed && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            Your lists could not be loaded.
          </p>
          <button type="button" onClick={onRetry} className={smallButton}>
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
          className="flex flex-wrap items-center gap-2"
        >
          <label htmlFor="new-list-name" className="text-sm font-medium">
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
            className={fieldClass}
          />
          <button
            type="submit"
            aria-disabled={creating.saving || undefined}
            className={`${smallButton} border-primary bg-primary text-primary-foreground`}
          >
            {creating.saving ? 'Creating...' : 'Create list'}
          </button>
          <button
            type="button"
            aria-label="Cancel new list"
            aria-disabled={creating.saving || undefined}
            onClick={closeCreate}
            className={smallButton}
          >
            Cancel
          </button>
          {creating.error && (
            <p id="new-list-error" role="alert" className="basis-full text-sm text-destructive">
              {creating.error}
            </p>
          )}
        </form>
      )}
      {showManage && (
        <div id="manage-lists" ref={manageRef} className="rounded-lg border border-border">
          {manageError && (
            <p role="alert" className="px-4 pt-3 text-sm text-destructive">
              {manageError}
            </p>
          )}
          <ul aria-label="Your lists" className="divide-y divide-border">
            {lists.map((list) => {
              const errorId = `list-${list.id}-rename-error`;
              if (renaming?.id === list.id) {
                return (
                  <li key={list.id} data-list-id={list.id} className="px-4 py-2">
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
                        className={fieldClass}
                      />
                      <button
                        type="submit"
                        aria-label={`Save the new name for "${list.name}"`}
                        aria-disabled={renaming.saving || undefined}
                        className={`${smallButton} border-primary bg-primary text-primary-foreground`}
                      >
                        {renaming.saving ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        type="button"
                        aria-label={`Cancel renaming "${list.name}"`}
                        aria-disabled={renaming.saving || undefined}
                        onClick={() => cancelRename(list)}
                        className={smallButton}
                      >
                        Cancel
                      </button>
                      {renaming.error && (
                        <p id={errorId} role="alert" className="basis-full text-sm text-destructive">
                          {renaming.error}
                        </p>
                      )}
                    </form>
                  </li>
                );
              }
              const deleting = confirming?.id === list.id && confirming.deleting;
              const shareState = sharing?.id === list.id ? sharing : null;
              const owner = list.ownerId === me ? null : (ownerName(list) ?? 'another member');
              return (
                <li key={list.id} data-list-id={list.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
                  <span className="min-w-0 flex-1 break-words">
                    <span data-list-name>{list.name}</span>
                    {list.shared && (
                      <span data-list-sharing className="block text-sm text-muted-foreground">
                        <SharedIcon /> {owner === null ? 'Shared with household' : `Shared by ${owner}`}
                      </span>
                    )}
                  </span>
                  {shareState?.confirm ? (
                    <div
                      role="group"
                      aria-label={`Stop sharing "${list.name}"?`}
                      onKeyDown={escapeTo(() => cancelUnshare(list))}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <span className="text-sm">
                        Stop sharing {list.name}? It goes back to {owner} with all its tasks, and you will lose access
                        to it.
                      </span>
                      <button
                        type="button"
                        data-action="confirm-unshare-list"
                        aria-label={`Confirm stopping sharing "${list.name}"`}
                        aria-disabled={shareState.saving || undefined}
                        onClick={() => void saveShared(list, false)}
                        className={`${smallButton} border-destructive text-destructive`}
                      >
                        {shareState.saving ? 'Stopping...' : 'Stop sharing'}
                      </button>
                      <button
                        type="button"
                        data-action="cancel-unshare-list"
                        aria-label={`Cancel stopping sharing "${list.name}"`}
                        aria-disabled={shareState.saving || undefined}
                        onClick={() => cancelUnshare(list)}
                        className={smallButton}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : confirming?.id === list.id ? (
                    <div
                      role="group"
                      aria-label={`Delete list "${list.name}"?`}
                      onKeyDown={escapeTo(() => cancelDelete(list))}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <span className="text-sm">{deleteQuestion(list, taskCount(list.id))}</span>
                      <button
                        type="button"
                        data-action="confirm-delete-list"
                        aria-label={`Confirm deleting list "${list.name}"`}
                        aria-disabled={deleting || undefined}
                        onClick={() => void confirmDelete(list)}
                        className={`${smallButton} border-destructive text-destructive`}
                      >
                        {deleting ? 'Deleting...' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        data-action="cancel-delete-list"
                        aria-label={`Cancel deleting list "${list.name}"`}
                        aria-disabled={deleting || undefined}
                        onClick={() => cancelDelete(list)}
                        className={smallButton}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        data-action="rename-list"
                        aria-label={`Rename "${list.name}"`}
                        onClick={() => startRename(list)}
                        className={smallButton}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        data-action="share-list"
                        aria-label={
                          list.shared ? `Stop sharing "${list.name}"` : `Share "${list.name}" with household`
                        }
                        aria-disabled={shareState?.saving || undefined}
                        onClick={() => startShareChange(list)}
                        className={smallButton}
                      >
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
                        className={smallButton}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
