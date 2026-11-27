import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Pencil, Trash2, Users, X } from 'lucide-react';
import { cn } from './cn';
import { jsonHeaders, serverError } from './http';
import { type List, type Member, listFromServer, listNameProblem } from './lists';
import { FieldError, buttonClass, iconButtonClass, labelClass, sheetClass, smallControlClass } from './ui';
import { VIEW_TITLE_ID } from './ViewPicker';

export const MANAGE_LISTS_ID = 'manage-lists';

type Props = {
  lists: List[];
  // The user's id, and every member, to tell whose a shared list is.
  me: number;
  members: Member[];
  // The lists could not be loaded: the built-in views still work.
  failed: boolean;
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

// The view title, which takes focus where a control that is gone had it (the
// view picker's New list and Manage lists live in a closed menu).
const viewTitle = () => document.getElementById(VIEW_TITLE_ID);

// Escape anywhere in a form or question cancels it.
const escapeTo = (cancel: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  }
};

// The user's lists beyond choosing one (which the view picker does): the New
// list form, the Manage lists panel, and the message when the lists failed to
// load. Pending controls are locked with readOnly and aria-disabled instead
// of disabled, which would drop focus.
//
// It returns `panels`, for the page to place in the column under its header,
// and `openNewList` and `openManage`, for the view picker's menu items.
export function useListBar({
  lists,
  me,
  members,
  failed,
  onRetry,
  onCreated,
  onUpdated,
  onLeft,
  onDeleted,
  onGone,
  onSignedOut,
  taskCount,
  track,
}: Props): { panels: ReactNode; openNewList: () => void; openManage: () => void } {
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

  const ownLists = lists.filter((list) => list.ownerId === me);
  const ownerName = (list: List) => members.find((member) => member.id === list.ownerId)?.name;
  const manageControl = (id: number, action: string) =>
    manageRef.current?.querySelector<HTMLElement>(`[data-list-id="${id}"] [data-action="${action}"]`);
  // After a list leaves the manage panel: the next list's Rename, else the
  // previous one's, else the view title (Manage lists goes away with the last list).
  const focusAfterLeaving = (id: number) => {
    const index = lists.findIndex((list) => list.id === id);
    const neighbour = lists[index + 1] ?? lists[index - 1];
    focusAfterRender.current = () => (neighbour ? manageControl(neighbour.id, 'rename-list') : viewTitle());
    if (!neighbour) setManageOpen(false);
  };

  // From the view picker: the form opens (or stays open) with focus in its field.
  function openNewList() {
    if (!creating) setCreating({ name: '', error: '', saving: false });
    focusAfterRender.current = () => document.getElementById('new-list-name');
  }

  // From the view picker: the panel opens with focus on it, so Tab goes on
  // to its Close button and lists.
  function openManage() {
    setManageOpen(true);
    focusAfterRender.current = () => manageRef.current;
  }

  function closeManage() {
    setManageOpen(false);
    focusAfterRender.current = viewTitle;
  }

  function closeCreate() {
    if (pendingRef.current) return;
    setCreating(null);
    focusAfterRender.current = viewTitle;
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
      // The new list is shown; keyboard users carry on from its title.
      focusAfterRender.current = viewTitle;
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
  const newListForm = creating && (
    <form
      id="new-list-form"
      onSubmit={(event) => void create(event)}
      onKeyDown={escapeTo(closeCreate)}
      noValidate
      className={cn(sheetClass, 'tk-rise flex flex-col gap-2 p-4')}
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
  );
  const failure = failed && (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-[var(--tk-danger-surface)] px-4 py-3">
      <p role="alert" className="m-0 text-[13px] font-medium text-[var(--tk-danger-ink-strong)]">
        Your lists could not be loaded.
      </p>
      <button type="button" onClick={onRetry} className={buttonClass('ghost', 'small')}>
        Load lists again
      </button>
    </div>
  );
  const manage = showManage && (
    <section
      id={MANAGE_LISTS_ID}
      ref={manageRef}
      tabIndex={-1}
      aria-labelledby="manage-lists-heading"
      className={cn(sheetClass, 'tk-rise focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45')}
    >
      <div className="flex items-start justify-between gap-3 border-b border-[var(--tk-soft-divider)] py-3 pr-3 pl-5">
        <div className="min-w-0 pt-1">
          <h2 id="manage-lists-heading" className="m-0 font-serif text-[20px] leading-tight font-normal tracking-[-0.01em]">
            Manage lists
          </h2>
          <p className="m-0 text-[13px] text-ink-3">Rename, share with the household, or delete.</p>
        </div>
        <button
          type="button"
          aria-label="Close Manage lists"
          onClick={closeManage}
          className={iconButtonClass()}
        >
          <X aria-hidden="true" className="size-4" strokeWidth={2.1} />
        </button>
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
  const panels = (failure || newListForm || manage) && (
    <>
      {failure}
      {newListForm}
      {manage}
    </>
  );
  return { panels: panels || null, openNewList, openManage };
}
