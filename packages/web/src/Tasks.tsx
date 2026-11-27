import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Plus, RotateCw } from 'lucide-react';
import { type AddDetail, type AddDraft, type AddField, AddSheet, detailOf } from './AddSheet';
import { type Account, AppShell, PAGE_ID } from './AppShell';
import { BrandMark } from './BrandMark';
import { cn } from './cn';
import {
  INCOMPLETE_DUE_DATE_MESSAGE,
  MAX_DUE_DATE,
  dueDateProblem,
  dueLabel,
  localDate,
  msUntilNextLocalMidnight,
} from './dueDate';
import { jsonHeaders, serverError } from './http';
import { MANAGE_LISTS_ID, goneListMessage, useListBar } from './ListBar';
import { type List, type Member, type View, listFromServer, viewFromSearch, viewName, writeViewToUrl } from './lists';
import {
  NO_REPEAT,
  type Repeat,
  type RepeatForm,
  nextIsBeyond,
  repeatForm,
  repeatFromForm,
  sameRepeat,
  withoutRepeat,
} from './repeat';
import { type RowMode, type ShareLabels, type Task, TaskRow } from './TaskRow';
import { groupTasks, visibleTasks } from './taskGroups';
import { buttonClass, focusRing, panelClass, sheetClass } from './ui';
import { VISIBLE_CHARACTER, characterCount } from './text';
import { VIEW_TITLE_ID, ViewPicker } from './ViewPicker';

export type { Task };

const MAX_TITLE_LENGTH = 200;
const MAX_NOTES_LENGTH = 5000;

// The client-side title check shared by the add sheet and the inline edit
// field. Returns the message to show, or an empty string for a valid title.
function titleProblem(trimmed: string) {
  if (!VISIBLE_CHARACTER.test(trimmed)) return 'Enter a task title.';
  if (characterCount(trimmed) > MAX_TITLE_LENGTH) {
    return `Task titles can be at most ${MAX_TITLE_LENGTH} characters.`;
  }
  return '';
}

// The client-side notes check shared by the add sheet and the edit row, on
// trimmed notes, like the server's. Returns the message to show, or an empty
// string for valid notes (including none).
function notesProblem(trimmed: string) {
  if (trimmed.includes('\u0000')) return 'Notes cannot contain a null character.';
  if (characterCount(trimmed) > MAX_NOTES_LENGTH) {
    return `Notes can be at most ${MAX_NOTES_LENGTH} characters.`;
  }
  return '';
}
// The notes to store: trimmed at the ends only, or null when nothing visible is
// left, which is what the server would store for them.
function storedNotes(text: string) {
  const trimmed = text.trim();
  return VISIBLE_CHARACTER.test(trimmed) ? trimmed : null;
}

function goneMessage(task: Task) {
  return `"${task.title}" no longer exists, so it was removed from the list.`;
}

type Field = AddField | 'assignee';
const fieldOf = (code: string): Field =>
  code === 'invalid_due_date'
    ? 'dueDate'
    : code === 'invalid_repeat'
      ? 'repeat'
      : code === 'invalid_notes'
        ? 'notes'
        : code === 'invalid_list'
          ? 'list'
          : code === 'invalid_assignee'
            ? 'assignee'
            : 'title';

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
// repeat, notes, list, attribution and assignee fields; missing means none
// (for the list, Inbox).
type UpdateReply = { task: Task; nextTask?: Task | null; removedTaskId?: number | null };
const fromServer = (task: Task): Task => ({
  ...task,
  listId: task.listId ?? null,
  notes: task.notes ?? null,
  repeat: task.repeat ?? null,
  createdById: task.createdById ?? null,
  completedById: task.completedById ?? null,
  assigneeId: task.assigneeId ?? null,
});

// Live refresh (D-8): lists, tasks and members are fetched again when the
// window gains focus or the page becomes visible, and this often while it is
// visible. There are no websockets or server-sent events.
export const REFRESH_INTERVAL_MS = 30_000;
export const REFRESH_TIMEOUT_MS = 20_000;

// The labels of a row in a shared list (D-5): who added it and who completed
// it, only when that is someone else, and who it is assigned to. A member
// who is not in the members list (deleted, or the list did not load) is not
// named. Rows elsewhere have none.
function sharedLabels(task: Task, me: number, members: Member[]): ShareLabels {
  const name = (id: number | null) => (id === null ? undefined : members.find((member) => member.id === id)?.name);
  const addedBy = task.createdById !== me ? name(task.createdById) : undefined;
  const doneBy = task.completed && task.completedById !== me ? name(task.completedById) : undefined;
  const assignee = task.assigneeId === me ? 'you' : name(task.assigneeId);
  return {
    addedBy: addedBy ? `Added by ${addedBy}` : null,
    doneBy: doneBy ? `Done by ${doneBy}` : null,
    assigned: assignee ? `Assigned to ${assignee}` : null,
  };
}

// Whether a task shows in a view: every task in "All tasks", tasks without a
// list in Inbox, a list's own tasks in that list, and in "Assigned to me" the
// tasks assigned to the user (`me`) in any list they can see. Only a task in a
// shared list has an assignee (the server clears it when a task leaves one or
// the list stops being shared), so a task in Inbox or in a list that `lists`
// says is not shared is never the user's assignment, whatever an older answer
// says. A list that is not loaded (the lists failed to load) is trusted.
const inView = (task: Task, view: View, me: number, lists: List[]) => {
  if (view === 'all') return true;
  if (view === 'assigned') {
    return (
      task.assigneeId === me &&
      task.listId !== null &&
      lists.find((list) => list.id === task.listId)?.shared !== false
    );
  }
  return task.listId === (view === 'inbox' ? null : view);
};
// Why a task the user saved left "Assigned to me" (`before` is the task as it
// was): it went to someone else, to nobody, or out of the shared list (which
// clears the assignee).
function leftAssignedMessage(task: Task, before: Task, me: number, lists: List[], members: Member[]) {
  const assignee =
    task.assigneeId === null || task.assigneeId === me
      ? undefined
      : (members.find((member) => member.id === task.assigneeId)?.name ?? 'someone else');
  if (task.listId !== before.listId) {
    const to = viewName(task.listId ?? 'inbox', lists);
    return assignee
      ? `Moved "${task.title}" to ${to}; it is now assigned to ${assignee}.`
      : `Moved "${task.title}" to ${to}, so it is no longer assigned to you.`;
  }
  return assignee ? `"${task.title}" is now assigned to ${assignee}.` : `"${task.title}" is no longer assigned to you.`;
}
const unassignedByListMessage = (task: Task) =>
  `"${task.title}" is no longer assigned to you, because its list was deleted or is no longer shared.`;
// Puts a saved caret back, on a control that has one: only text fields do,
// and setSelectionRange throws on others, such as a checkbox or date input.
const restoreCaret = (element: Element | null | undefined, caret: { start: number; end: number } | null) => {
  if (!caret) return;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
  if (element.selectionStart === null) return;
  element.setSelectionRange(caret.start, caret.end);
};
const LIST_GONE_MESSAGE = 'That list no longer exists. Choose another list.';
const leftListMessage = (list: List) => `"${list.name}" is no longer shared with you, so it was removed.`;
const lostTaskMessage = (task: Task) => `"${task.title}" is no longer shared with you.`;
const vanishedListMessage = (list: List) =>
  `"${list.name}" was deleted or is no longer shared with you, so Inbox is shown.`;

// The add sheet's draft. Its list is the one the user chose, or "default" to
// follow the view: a named list's view adds there, the others to Inbox.
type Draft = Omit<AddDraft, 'listId'> & { listId: number | null | 'default' };
const EMPTY_DRAFT: Draft = { title: '', dueDate: '', repeat: NO_REPEAT, notes: '', listId: 'default' };
const ADD_SHEET_ID = 'new-task-sheet';
const viewTitle = () => document.getElementById(VIEW_TITLE_ID);

// `me` is the signed-in user's id. `account` is who is signed in, for the
// shell's account menu, whose Sign out calls `onSignOut`; `onSignedOut` is
// for a session that ended (a 401). `accountError` is a failed sign-out.
export function Tasks({
  me,
  account,
  signingOut,
  accountError,
  onSignOut,
  onSignedOut,
}: {
  me: number;
  account: Account;
  signingOut: boolean;
  accountError: string;
  onSignOut: () => void;
  onSignedOut: () => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // The user's lists (for the tab row), loaded next to the tasks. When they
  // fail to load, the built-in views still work.
  const [lists, setLists] = useState<List[]>([]);
  const [listsState, setListsState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // Every Tasks user, to name who added, completed or is assigned a task in a
  // shared list. Without them (they failed to load) rows name nobody.
  const [members, setMembers] = useState<Member[]>([]);
  // The view asked for (by the URL or the view picker). A list id that is not one of
  // the user's lists shows "All tasks" (D-5), so no task is hidden by default.
  const [requestedView, setRequestedView] = useState<View>(() => viewFromSearch(location.search));
  const view: View =
    typeof requestedView === 'number' && !lists.some((list) => list.id === requestedView) ? 'all' : requestedView;
  const shownTasks = view === 'all' ? tasks : tasks.filter((task) => inView(task, view, me, lists));
  // The add sheet: open or not, which chip's options show, and the draft,
  // which outlives closing the sheet without adding (D-3).
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetOpenRef = useRef(sheetOpen);
  sheetOpenRef.current = sheetOpen;
  const [addDetail, setAddDetail] = useState<AddDetail | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<{ message: string; field: AddField } | null>(null);
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
    notes: string;
    // The List select: a list id, or null for Inbox.
    listId: number | null;
    // The "Assigned to" select: a member id, or null for Nobody.
    assigneeId: number | null;
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
  const addButton = useRef<HTMLButtonElement>(null);
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
  const groups = groupTasks(shownTasks, today);
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
  // Where focus was when a background refresh was applied. A refresh can
  // replace the focused element (a row moved to another group, or removed,
  // a view picker item, a Manage lists entry or an add sheet List option
  // that went away); focus then goes to the same control in the row's new
  // place, else the nearest row after it that is still shown (or before it),
  // else the + button; a picker item's focus to the view title; a Manage
  // lists entry's to the nearest list left there, else the view title; and
  // a List option's to the List chip. Focus that is still on the page is
  // never moved.
  const focusAfterRefresh = useRef<{
    element: Element;
    rowId?: number;
    action?: string;
    caret: { start: number; end: number } | null;
    // The rows shown, and the lists, in page order when the refresh applied.
    rowOrder?: number[];
    listId?: number;
    listOrder?: number[];
    // The focused element was in the view picker's menu, the Manage lists
    // panel, or the add sheet.
    place?: 'menu' | 'manage' | 'sheet';
  } | null>(null);
  useEffect(() => {
    // While the add sheet is open, focus is never moved out of it (the page
    // behind is inert): a change that would move it elsewhere leaves it.
    const reachable = (element: HTMLElement | null | undefined) =>
      element && (!sheetOpenRef.current || element.closest(`#${ADD_SHEET_ID}`)) ? element : undefined;
    const target = reachable(focusAfterRender.current?.());
    focusAfterRender.current = null;
    target?.focus();
    if (focusOnDay.current?.day === today) {
      const moved = reachable(focusOnDay.current.target());
      focusOnDay.current = null;
      moved?.focus();
    }
    const refreshed = focusAfterRefresh.current;
    focusAfterRefresh.current = null;
    const active = document.activeElement;
    if (refreshed && !refreshed.element.isConnected && (!active || active === document.body)) {
      // A control in a collapsed (hidden) section cannot take focus.
      const shown = (element: HTMLElement | null | undefined) =>
        reachable(element) && !element!.closest('[hidden]') ? element! : undefined;
      let next: HTMLElement | undefined;
      if (refreshed.rowId !== undefined) {
        const same = refreshed.action ? shown(control(refreshed.rowId, refreshed.action)) : undefined;
        // Neighbours lost in the same refresh are skipped.
        next =
          same ??
          nearest(refreshed.rowOrder ?? [], refreshed.rowId, (id) => shown(firstControl(id))) ??
          shown(addButton.current);
        next?.focus();
        // The caret belongs to the control it was saved from, not to the
        // neighbour's checkbox or the + button that takes focus instead.
        if (next === same) restoreCaret(next, refreshed.caret);
      } else if (refreshed.place === 'sheet') {
        // A List option whose list went away: the List chip, else the title.
        next =
          shown(document.querySelector<HTMLElement>('[aria-controls="new-task-list-options"]')) ??
          shown(titleInput.current);
        next?.focus();
      } else if (refreshed.place === 'menu') {
        next = shown(viewTitle());
        next?.focus();
      } else if (refreshed.listId !== undefined || refreshed.place === 'manage') {
        // As after a list leaves the panel here: the next list's Rename (or
        // the Cancel of the question it asks, never its Confirm, else its
        // rename field), else the previous one's, else the view title
        // (Manage lists goes away with the last list).
        const entry = (id: number) => {
          const item = document.querySelector(`#${MANAGE_LISTS_ID} [data-list-id="${id}"]`);
          return shown(
            item?.querySelector<HTMLElement>(
              '[data-action="rename-list"], [data-action="cancel-delete-list"], [data-action="cancel-unshare-list"]',
            ) ?? item?.querySelector<HTMLElement>('input'),
          );
        };
        next =
          (refreshed.listId === undefined
            ? undefined
            : (entry(refreshed.listId) ?? nearest(refreshed.listOrder ?? [], refreshed.listId, entry))) ??
          shown(viewTitle());
        next?.focus();
      }
    }
  });
  const control = (id: number, action: string) =>
    rows.current.get(id)?.querySelector<HTMLElement>(`[data-action="${action}"]`);
  const firstControl = (id: number) => rows.current.get(id)?.querySelector<HTMLElement>('input, button');
  // The first item after `from` in `order` that `pick` finds, else the
  // nearest one before it.
  const nearest = <T,>(order: T[], from: T, pick: (item: T) => HTMLElement | undefined) => {
    const index = order.indexOf(from);
    if (index === -1) return undefined;
    for (let i = index + 1; i < order.length; i++) {
      const found = pick(order[i]);
      if (found) return found;
    }
    for (let i = index - 1; i >= 0; i--) {
      const found = pick(order[i]);
      if (found) return found;
    }
    return undefined;
  };
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

  // Requests that change tasks or lists, in progress and finished. A
  // background refresh that overlaps one of them is dropped, because its
  // answer may predate the change; the next trigger tries again. So a refresh
  // never undoes a pending change or one just stored.
  const activity = useRef({ pending: 0, finished: 0 });
  const track = useCallback(() => {
    activity.current.pending++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      activity.current.pending--;
      activity.current.finished++;
    };
  }, []);
  // The state a refresh compares against, read when its answer arrives.
  const latest = useRef({ tasks, lists, requestedView, editingId: null as number | null, confirmingId, listState });
  latest.current = { tasks, lists, requestedView, editingId: editing?.id ?? null, confirmingId, listState };

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
        const field =
          active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
        // Only text fields have a caret; a date or checkbox input reports null.
        const caret =
          field && field.selectionStart !== null
            ? { start: field.selectionStart, end: field.selectionEnd ?? field.selectionStart }
            : null;
        focusOnDay.current = {
          day: next,
          target: () => {
            const target = control(id, action);
            restoreCaret(target, caret);
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
        setTasks(body.tasks.map(fromServer));
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

  // Replace the lists with the server's. Tasks in a list that is gone now
  // were moved to Inbox by the server, so they are shown there too, and an
  // open edit row never keeps a List choice that no longer exists.
  const applyLists = useCallback((next: List[]) => {
    const ids = new Set(next.map((list) => list.id));
    const stillThere = (listId: number | null) => (listId === null || ids.has(listId) ? listId : null);
    setLists(next);
    setTasks((current) =>
      current.some((task) => stillThere(task.listId) !== task.listId)
        ? current.map((task) => ({ ...task, listId: stillThere(task.listId) }))
        : current,
    );
    setEditing((current) =>
      current && stillThere(current.listId) !== current.listId ? { ...current, listId: null } : current,
    );
    // A list chosen in the add sheet that is gone: the draft follows the view again.
    setDraft((current) =>
      typeof current.listId === 'number' && !ids.has(current.listId) ? { ...current, listId: 'default' } : current,
    );
  }, []);
  const loadLists = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      try {
        const response = await fetch('/api/lists');
        if (!isCurrent()) return;
        if (response.status === 401) return onSignedOut();
        if (!response.ok) throw new Error();
        const body: { lists: List[] } = await response.json();
        if (!isCurrent()) return;
        applyLists(body.lists.map((list) => listFromServer(list, me)));
        setListsState('ready');
      } catch {
        if (isCurrent()) setListsState('failed');
      }
    },
    [onSignedOut, applyLists, me],
  );
  useEffect(() => {
    let current = true;
    void loadLists(() => current);
    return () => {
      current = false;
    };
  }, [loadLists]);

  // Members only add names to rows: when they fail to load, nothing says so
  // and the next refresh tries again.
  const loadMembers = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      try {
        const response = await fetch('/api/members');
        if (!isCurrent()) return;
        if (response.status === 401) return onSignedOut();
        if (!response.ok) return;
        const body: { members: Member[] } = await response.json();
        if (isCurrent()) setMembers(body.members);
      } catch {
        // Silent, see above.
      }
    },
    [onSignedOut],
  );
  useEffect(() => {
    let current = true;
    void loadMembers(() => current);
    return () => {
      current = false;
    };
  }, [loadMembers]);

  // A background refresh: the lists, tasks and members the server has now,
  // with what other members changed. It runs only once the tasks have loaded,
  // one at a time, and is silent: a failure shows nothing and the next
  // trigger tries again; only an ended session (401) is acted on. Its answer
  // replaces the loaded data, except for the row being edited and the row
  // asking to confirm a delete, which keep what the user sees (saving an edit
  // of a task deleted meanwhile then shows the usual "no longer exists"
  // notice). Drafts in the edit row and the add sheet live outside the task
  // data, so they are kept as typed.
  const refreshing = useRef(false);
  // Tasks dropList kept in Inbox without knowing whether their list was
  // deleted (they are the user's now) or stopped being shared by its owner
  // (they are not). The next refresh that applies its answer settles them:
  // one the server returns is an ordinary Inbox task again, one it does not
  // return is lost, as a task of a vanished list.
  const provisional = useRef(new Set<number>());
  const refresh = useCallback(async () => {
    if (refreshing.current || !mounted.current || latest.current.listState !== 'ready') return;
    refreshing.current = true;
    const finished = activity.current.finished;
    // Kept before this refresh's requests went out, so its answer can settle them.
    const settling = new Set(provisional.current);
    // A request that never answers must not stop live refresh for good: it is
    // aborted after a while and counts as any other failed refresh.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    try {
      const responses = await Promise.all(
        ['/api/tasks', '/api/lists', '/api/members'].map((path) => fetch(path, { signal: controller.signal })),
      );
      if (!mounted.current) return;
      if (responses.some((response) => response.status === 401)) return onSignedOut();
      if (!responses.every((response) => response.ok)) return;
      const [tasksBody, listsBody, membersBody]: [{ tasks: Task[] }, { lists: List[] }, { members: Member[] }] =
        await Promise.all(responses.map((response) => response.json())) as never;
      if (!mounted.current) return;
      // Overlapped a change made here: dropped (see track).
      if (activity.current.pending > 0 || activity.current.finished !== finished) return;
      const before = latest.current;
      const nextLists = listsBody.lists.map((list) => listFromServer(list, me));
      const server = tasksBody.tasks.map(fromServer);
      const serverIds = new Set(server.map((task) => task.id));
      // The task behind the edit row or the confirm-delete row is gone from
      // the answer while its list is too: it was unshared or deleted by
      // someone else, and the task is not the viewer's to keep. Its row closes
      // with a notice, since there is no list it could be shown under. A task
      // dropList kept provisionally counts as one of its vanished list's.
      const openIds = [...new Set([before.editingId, before.confirmingId])].filter((id): id is number => id !== null);
      const lostTasks = before.tasks.filter(
        (task) =>
          openIds.includes(task.id) &&
          !serverIds.has(task.id) &&
          (settling.has(task.id) || (task.listId !== null && !nextLists.some((list) => list.id === task.listId))),
      );
      const lostIds = new Set(lostTasks.map((task) => task.id));
      // In "Assigned to me" the task of an open row can also leave the view
      // while it is kept as the user sees it: its list was deleted (the task
      // is in Inbox now, see applyLists) or stopped being shared, which
      // clears every assignee in it. Nothing would show the row, so it closes
      // with a notice too, and the task takes the server's version.
      const placed = (task: Task) =>
        task.listId === null || nextLists.some((list) => list.id === task.listId) ? task : { ...task, listId: null };
      const leftTasks =
        before.requestedView === 'assigned'
          ? before.tasks.filter(
              (task) =>
                openIds.includes(task.id) &&
                !lostIds.has(task.id) &&
                inView(task, 'assigned', me, before.lists) &&
                !inView(placed(task), 'assigned', me, nextLists),
            )
          : [];
      const closedIds = new Set([...lostIds, ...leftTasks.map((task) => task.id)]);
      const pinned = new Set(openIds.filter((id) => !closedIds.has(id)));
      // Remember focus, in case its element is replaced (see focusAfterRefresh).
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) {
        const owner = [...rows.current].find(([, row]) => row.contains(active));
        const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
        const entry = active.closest<HTMLElement>(`#${MANAGE_LISTS_ID} [data-list-id]`);
        focusAfterRefresh.current = {
          element: active,
          rowId: owner?.[0],
          action: active.dataset.action,
          caret:
            field && field.selectionStart !== null
              ? { start: field.selectionStart, end: field.selectionEnd ?? field.selectionStart }
              : null,
          rowOrder: owner ? visibleRef.current.map((task) => task.id) : undefined,
          listId: entry ? Number(entry.dataset.listId) : undefined,
          listOrder: entry ? before.lists.map((list) => list.id) : undefined,
          place: active.closest('#view-menu')
            ? 'menu'
            : active.closest(`#${MANAGE_LISTS_ID}`)
              ? 'manage'
              : active.closest(`#${ADD_SHEET_ID}`)
                ? 'sheet'
                : undefined,
        };
      }
      setTasks((current) => {
        const byId = new Map(current.map((task) => [task.id, task]));
        const merged = server.map((task) => (pinned.has(task.id) ? (byId.get(task.id) ?? task) : task));
        current.forEach((task, index) => {
          if (pinned.has(task.id) && !serverIds.has(task.id)) merged.splice(Math.min(index, merged.length), 0, task);
        });
        return merged;
      });
      applyLists(nextLists);
      setListsState('ready');
      setMembers(membersBody.members);
      settling.forEach((id) => provisional.current.delete(id));
      if (closedIds.size > 0) {
        setEditing((current) => (current && closedIds.has(current.id) ? null : current));
        setConfirmingId((current) => (current !== null && closedIds.has(current) ? null : current));
      }
      // The selected list was deleted or unshared by someone else.
      const selected = before.requestedView;
      const known = typeof selected === 'number' ? before.lists.find((list) => list.id === selected) : undefined;
      const gone = known && !nextLists.some((list) => list.id === known.id) ? known : undefined;
      if (gone) {
        // Not selectView: an open edit row of a task that is still the
        // viewer's stays open (the task is in Inbox now); one whose task is
        // lost is closed above.
        setRequestedView('inbox');
        writeViewToUrl('inbox');
      }
      // One notice for this refresh: it replaces any older one, and a lost
      // task is named after the vanished list.
      const messages = [
        ...(gone ? [vanishedListMessage(gone)] : []),
        ...lostTasks.map(lostTaskMessage),
        ...leftTasks.map(unassignedByListMessage),
      ];
      if (messages.length > 0) setNotice(messages.join(' '));
    } catch {
      // Silent, see above (an aborted request ends up here).
    } finally {
      clearTimeout(timeout);
      refreshing.current = false;
    }
  }, [onSignedOut, applyLists, me]);
  useEffect(() => {
    const trigger = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', trigger);
    document.addEventListener('visibilitychange', trigger);
    const timer = setInterval(trigger, REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener('focus', trigger);
      document.removeEventListener('visibilitychange', trigger);
      clearInterval(timer);
    };
  }, [refresh]);

  function selectView(next: View) {
    const changed = next !== view;
    setRequestedView(next);
    writeViewToUrl(next);
    // An edit row or delete question cannot stay open on a row nobody can see.
    if (changed && !savingRef.current) setEditing(null);
    if (changed && !deletingRef.current) setConfirmingId(null);
  }

  // Whether a task stays visible to the user once its list is deleted: the
  // server moves a shared list's tasks to the Inbox of whoever added each one
  // (the owner when unknown), and an unshared list's to the owner's Inbox.
  const keptAfterDelete = (task: Task, list: List) =>
    (list.shared ? (task.createdById ?? list.ownerId) : list.ownerId) === me;

  // In "Assigned to me", a change made in Manage lists takes every task of
  // the list (and `movedTaskIds`) out of the view without a save: stopping
  // sharing a list clears its assignees, deleting it moves its tasks to an
  // Inbox, and stopping sharing someone else's list takes them away. An open
  // edit row or delete question on such a task would be left on a row
  // nothing shows, so it closes, as a refresh closes it for the same change
  // made by someone else. Returns the tasks whose rows closed, for the
  // caller's notice. Other views are unchanged. It reads the latest state,
  // since Manage lists calls back after its request.
  function closeRowsLeavingAssigned(list: List, movedTaskIds: number[] = []) {
    const { tasks: current, lists: known, requestedView: shownView, editingId, confirmingId: questionId } = latest.current;
    if (shownView !== 'assigned') return [];
    const left = current.filter(
      (task) =>
        (task.id === editingId || task.id === questionId) &&
        (task.listId === list.id || movedTaskIds.includes(task.id)) &&
        inView(task, 'assigned', me, known),
    );
    if (left.length === 0) return [];
    const ids = new Set(left.map((task) => task.id));
    setEditing((open) => (open && ids.has(open.id) ? null : open));
    setConfirmingId((open) => (open !== null && ids.has(open) ? null : open));
    return left;
  }

  // A list the user can no longer see: its tab goes, a view of it switches
  // to Inbox, and its tasks leave with it (the user stopped sharing someone
  // else's list) or move to Inbox (it was deleted). An open edit row or
  // delete question on a task that leaves closes, in every view: left open,
  // it would be hidden and show again if the task came back by a refresh.
  // One on a task that moves to the user's Inbox stays. Returns the tasks
  // whose open rows closed: `left` in "Assigned to me" (see
  // closeRowsLeavingAssigned), `lost` in other views, for the caller's
  // notice. It reads the latest state, since Manage lists calls back after
  // its request.
  function removeList(list: List, deleted: boolean, movedTaskIds: number[] = []) {
    const left = closeRowsLeavingAssigned(list, movedTaskIds);
    const moved = new Set(movedTaskIds);
    const leaves = (task: Task) =>
      (task.listId === list.id || moved.has(task.id)) && (!deleted || !keptAfterDelete(task, list));
    const { tasks: current, requestedView: shownView, editingId, confirmingId: questionId } = latest.current;
    const closing = current.filter((task) => (task.id === editingId || task.id === questionId) && leaves(task));
    setTasks((all) =>
      all.flatMap((task) => {
        if (task.listId !== list.id && !moved.has(task.id)) return [task];
        return leaves(task) ? [] : [{ ...task, listId: null, assigneeId: null }];
      }),
    );
    applyLists(lists.filter((item) => item.id !== list.id));
    if (closing.length > 0) {
      const ids = new Set(closing.map((task) => task.id));
      setEditing((open) => (open && ids.has(open.id) ? null : open));
      setConfirmingId((open) => (open !== null && ids.has(open) ? null : open));
    }
    if (requestedView === list.id) selectView('inbox');
    return { left, lost: shownView === 'assigned' ? [] : closing };
  }

  // A list the server no longer has for the user (deleted in another tab, or
  // unshared or deleted by another member): it goes as if deleted, with a
  // notice, and a refresh then shows where its tasks really went. The tasks
  // it keeps in Inbox are provisional until then (see `provisional`).
  function dropList(list: List, message: string) {
    latest.current.tasks.forEach((task) => {
      if (task.listId === list.id && keptAfterDelete(task, list)) provisional.current.add(task.id);
    });
    const { left, lost } = removeList(list, true);
    setNotice([message, ...left.map(unassignedByListMessage), ...lost.map(lostTaskMessage)].join(' '));
    if (list.shared) setTimeout(() => void refresh(), 0);
  }

  const isSharedList = (listId: number | null) =>
    listId !== null && (lists.find((list) => list.id === listId)?.shared ?? false);

  // Where the add sheet adds now: the list the user chose (still there), else
  // the view's list, else Inbox (null).
  const addListId =
    typeof draft.listId === 'number' && lists.some((list) => list.id === draft.listId)
      ? draft.listId
      : draft.listId === null
        ? null
        : typeof view === 'number'
          ? view
          : null;

  function openSheet() {
    setSheetOpen(true);
  }

  // Closing without adding keeps the draft (D-3). Not while the add is pending.
  function closeSheet() {
    if (creatingRef.current) return;
    setSheetOpen(false);
    setAddDetail(null);
    setCreateError(null);
    focusAfterRender.current = () => addButton.current;
  }

  // A message about a field of the add sheet opens that field's chip.
  function addProblem(message: string, field: Field) {
    const addField: AddField = field === 'assignee' ? 'title' : field;
    setCreateError({ message, field: addField });
    const detail = detailOf(addField);
    if (detail) setAddDetail(detail);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (creatingRef.current) return;
    const trimmed = draft.title.trim();
    const problem = titleProblem(trimmed);
    if (problem) return addProblem(problem, 'title');
    const dateProblem = dateFieldProblem(dueDateInput.current, draft.dueDate);
    if (dateProblem) return addProblem(dateProblem, 'dueDate');
    // A repeat needs a due date; without one the Repeat chip is not offered.
    const repeatChoice = draft.dueDate === '' ? { repeat: null } : repeatFromForm(draft.repeat);
    if ('problem' in repeatChoice) return addProblem(repeatChoice.problem, 'repeat');
    // Notes with text are sent whether or not their field is open (D-4).
    const newNotes = storedNotes(draft.notes);
    const notesError = notesProblem(draft.notes.trim());
    if (notesError) return addProblem(notesError, 'notes');
    // Inbox is no field at all.
    const list = addListId === null ? undefined : lists.find((item) => item.id === addListId);
    creatingRef.current = true;
    const end = track();
    setCreating(true);
    setCreateError(null);
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: jsonHeaders,
        // No due date, no repeat, or no notes, is sent as no field at all.
        body: JSON.stringify({
          title: trimmed,
          ...(newNotes === null ? {} : { notes: newNotes }),
          ...(draft.dueDate === '' ? {} : { dueDate: draft.dueDate }),
          ...(repeatChoice.repeat === null ? {} : { repeat: repeatChoice.repeat }),
          ...(list ? { listId: list.id } : {}),
        }),
      });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      if (response.status === 400) {
        const { message, code } = await serverError(response, 'That task was not accepted.');
        // The list was deleted meanwhile. The sheet stays open with the
        // typed task, now for the view's list or Inbox, and says why.
        if (code === 'invalid_list' && list) {
          addProblem(LIST_GONE_MESSAGE, 'list');
          return dropList(list, `${goneListMessage(list)} The task was not added.`);
        }
        return addProblem(message, fieldOf(code));
      }
      if (!response.ok) throw new Error();
      const body: { task: Task } = await response.json();
      // Only a task the server confirmed is added to the list.
      const created = fromServer(body.task);
      setTasks((current) =>
        current.some((item) => item.id === created.id) ? current : [created, ...current],
      );
      // A task that went to another list, or to Inbox from "Assigned to me",
      // is not in this view, so a notice says where it went.
      if (!inView(created, view, me, lists)) {
        setNotice(`Added "${created.title}" to ${viewName(created.listId ?? 'inbox', lists)}.`);
      }
      // Done: the sheet closes with a fresh draft, and focus returns to the
      // + button (D-2), also when Add task was clicked.
      setDraft(EMPTY_DRAFT);
      setAddDetail(null);
      setSheetOpen(false);
      sheetOpenRef.current = false;
      focusAfterRender.current = () => addButton.current;
    } catch {
      addProblem('The task could not be saved. Please try again.', 'title');
    } finally {
      creatingRef.current = false;
      setCreating(false);
      end();
    }
  }

  async function setCompleted(task: Task, completed: boolean) {
    if (updatingRef.current.has(task.id)) return;
    // A task that is being deleted is not updated as well.
    if (deletingRef.current && confirmingId === task.id) return;
    updatingRef.current.add(task.id);
    const end = track();
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
      const updated = fromServer(body.task);
      const nextTask = body.nextTask ? fromServer(body.nextTask) : null;
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
      end();
    }
  }

  // Remove a row the server no longer has. If keyboard focus was inside it,
  // move focus to the next row's first control, else the previous row's, else
  // the + button, so focus is never dropped onto the page.
  // Neighbours are taken in page order, across groups.
  function removeRow(id: number) {
    const neighbour = visibleNeighbour(id);
    if (hasFocus(id)) {
      focusAfterRender.current = () => (neighbour ? firstControl(neighbour.id) : addButton.current);
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
      notes: task.notes ?? '',
      listId: task.listId,
      assigneeId: task.assigneeId,
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
    const notesError = notesProblem(editing.notes.trim());
    if (notesError) return setEditing({ ...editing, error: notesError, errorField: 'notes' });
    // Only the fields that changed are sent. Notes compare as they would be
    // stored, so changing only spacing at the ends is no change; emptied notes
    // are sent as null.
    const changes: {
      title?: string;
      notes?: string | null;
      dueDate?: string | null;
      repeat?: Repeat | null;
      listId?: number | null;
      assigneeId?: number | null;
    } = {};
    if (trimmed !== task.title) changes.title = trimmed;
    const newDueDate = editing.dueDate === '' ? null : editing.dueDate;
    if (newDueDate !== task.dueDate) changes.dueDate = newDueDate;
    if (!sameRepeat(repeatChoice.repeat, task.repeat)) changes.repeat = repeatChoice.repeat;
    const newNotes = storedNotes(editing.notes);
    if (newNotes !== task.notes) changes.notes = newNotes;
    if (editing.listId !== task.listId) changes.listId = editing.listId;
    // Only a task that ends up in a shared list has an assignee; one that
    // leaves a shared list loses it on the server without being asked (D-6).
    if (isSharedList(editing.listId) && editing.assigneeId !== task.assigneeId) {
      changes.assigneeId = editing.assigneeId;
    }
    // Nothing to store: leave edit mode without a request.
    if (
      changes.title === undefined &&
      changes.dueDate === undefined &&
      changes.repeat === undefined &&
      changes.notes === undefined &&
      changes.listId === undefined &&
      changes.assigneeId === undefined
    ) {
      return leaveEdit(task);
    }
    savingRef.current = true;
    const end = track();
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
        // The chosen list was deleted meanwhile: say so on the List select,
        // and reload the lists so it no longer offers the missing one.
        if (code === 'invalid_list') {
          fail(LIST_GONE_MESSAGE, 'list');
          return void loadLists();
        }
        return fail(message, fieldOf(code));
      }
      if (!response.ok) throw new Error();
      const body: UpdateReply = await response.json();
      const updated = fromServer(body.task);
      // A task moved out of the selected list (or Inbox), or in "Assigned to
      // me" no longer assigned to the user, leaves the view: like after a
      // delete, focus moves to the next row, else the previous one, else the
      // + button, and a notice says where the task went or who has it.
      const leavesView = !inView(updated, view, me, lists);
      const neighbour = leavesView ? visibleNeighbour(task.id) : undefined;
      // The row shows the new title, date and repeat, and moves to its new
      // group, only once the server has stored them. Focus follows it to Edit.
      setTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      leaveEdit(task);
      if (leavesView) {
        if (hasFocus(task.id)) {
          focusAfterRender.current = () => (neighbour ? firstControl(neighbour.id) : addButton.current);
        }
        setConfirmingId((current) => (current === task.id ? null : current));
        setNotice(
          view === 'assigned'
            ? leftAssignedMessage(updated, task, me, lists, members)
            : `Moved "${updated.title}" to ${viewName(updated.listId ?? 'inbox', lists)}.`,
        );
      }
    } catch {
      // Edit mode and the typed values are kept so the user can retry.
      const changed = (['title', 'dueDate', 'repeat', 'notes', 'listId', 'assigneeId'] as const).filter(
        (field) => changes[field] !== undefined,
      );
      const what =
        changed.length > 1
          ? 'The changes'
          : {
              title: 'The new title',
              dueDate: 'The new due date',
              repeat: 'The new repeat',
              notes: 'The new notes',
              listId: 'The new list',
              assigneeId: 'The new assignee',
            }[changed[0]];
      const field = changed[0] === 'listId' ? 'list' : changed[0] === 'assigneeId' ? 'assignee' : changed[0];
      fail(`${what} could not be saved. Please try again.`, field);
    } finally {
      savingRef.current = false;
      setSaving(false);
      end();
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
    const end = track();
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
      end();
    }
  }

  function rowMode(task: Task): RowMode {
    if (editing?.id === task.id) {
      return {
        kind: 'edit',
        text: editing.text,
        dueDate: editing.dueDate,
        repeat: editing.repeat,
        notes: editing.notes,
        listId: editing.listId,
        assigneeId: editing.assigneeId,
        error: editing.error,
        errorField: editing.errorField,
        saving,
      };
    }
    if (confirmingId === task.id) return { kind: 'confirm-delete', deleting };
    return { kind: 'view' };
  }

  const { panels, openNewList, openManage } = useListBar({
    lists,
    me,
    members,
    failed: listsState === 'failed',
    onRetry: () => void loadLists(),
    onCreated: (list) => {
      setLists((current) => [...current, list]);
      selectView(list.id);
    },
    onUpdated: (list) => {
      setLists((current) => current.map((item) => (item.id === list.id ? list : item)));
      // Unsharing cleared the assignees of the list's tasks on the server.
      if (!list.shared) {
        const left = closeRowsLeavingAssigned(list);
        if (left.length > 0) setNotice(left.map(unassignedByListMessage).join(' '));
        setTasks((current) =>
          current.some((task) => task.listId === list.id && task.assigneeId !== null)
            ? current.map((task) => (task.listId === list.id ? { ...task, assigneeId: null } : task))
            : current,
        );
        setEditing((current) => (current?.listId === list.id ? { ...current, assigneeId: null } : current));
      }
    },
    onLeft: (list) => {
      const { left, lost } = removeList(list, false);
      setNotice([leftListMessage(list), ...[...left, ...lost].map(lostTaskMessage)].join(' '));
    },
    onDeleted: (list, movedTaskIds) => {
      const { left, lost } = removeList(list, true, movedTaskIds);
      if (left.length > 0) setNotice(left.map(unassignedByListMessage).join(' '));
      else if (lost.length > 0) setNotice(lost.map(lostTaskMessage).join(' '));
      setEditing((current) => (current?.listId === list.id ? { ...current, listId: null, assigneeId: null } : current));
    },
    onGone: dropList,
    onSignedOut,
    taskCount: (id) => tasks.filter((task) => task.listId === id).length,
    track,
  });
  // Every state of the page sits in the same frame; only the column changes.
  const shell = (main: ReactNode, header: ReactNode = null, overlay: ReactNode = null) => (
    <AppShell
      account={account}
      signingOut={signingOut}
      onSignOut={onSignOut}
      title={header}
      inert={sheetOpen}
      overlay={overlay}
    >
      {accountError && (
        <p
          role="alert"
          className="m-0 rounded-2xl border border-[var(--tk-danger-border)] bg-[var(--tk-danger-surface)] px-4 py-3 text-[14px] text-[var(--tk-danger-ink-strong)]"
        >
          {accountError}
        </p>
      )}
      {main}
    </AppShell>
  );

  // The tasks and the lists load together; lists that fail do not hold up the tasks.
  if (listState === 'loading' || (listState === 'ready' && listsState === 'loading')) {
    return shell(
      <div className={cn(panelClass, 'flex items-center gap-3 text-ink-2')}>
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
        <p role="status" className="m-0">
          Loading your tasks...
        </p>
      </div>,
    );
  }
  if (listState === 'failed') {
    return shell(
      <div className={cn(panelClass, 'flex flex-col items-start gap-3')}>
        <p role="alert" className="m-0 font-medium text-[var(--tk-danger-ink-strong)]">
          Your tasks could not be loaded.
        </p>
        <button type="button" onClick={() => void load()} className={buttonClass('ghost')}>
          <RotateCw aria-hidden="true" className="size-4" strokeWidth={2.1} />
          Try again
        </button>
      </div>,
    );
  }
  const mixesLists = view === 'all' || view === 'assigned';
  const renderRow = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      mode={rowMode(task)}
      today={today}
      lists={lists}
      // Only "All tasks" and "Assigned to me" mix lists, so only there a row
      // names its list (D-6). A list that is not loaded (the lists failed to
      // load) has no label.
      listName={mixesLists ? (lists.find((list) => list.id === task.listId)?.name ?? null) : null}
      // In shared lists only, in the list's view and in "All tasks" alike.
      shareLabels={isSharedList(task.listId) ? sharedLabels(task, me, members) : null}
      // The select follows the List choice in the edit row (D-6).
      assignees={
        editing?.id === task.id && isSharedList(editing.listId) && members.length > 0 ? members : null
      }
      me={me}
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
      onDueDateEmptied={() =>
        setEditing((current) => {
          if (current?.id !== task.id || savingRef.current || current.dueDate !== '') return current;
          const repeat = withoutRepeat(current.repeat);
          return repeat === current.repeat ? current : { ...current, repeat };
        })
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
      onEditNotes={(value) =>
        setEditing((current) =>
          current?.id === task.id && !savingRef.current ? { ...current, notes: value, error: '' } : current,
        )
      }
      onEditList={(listId) =>
        setEditing((current) =>
          current?.id === task.id && !savingRef.current
            ? {
                ...current,
                listId,
                // Moving out of a shared list clears the assignee, as the server does.
                assigneeId: isSharedList(listId) ? current.assigneeId : null,
                error: '',
              }
            : current,
        )
      }
      onEditAssignee={(assigneeId) =>
        setEditing((current) =>
          current?.id === task.id && !savingRef.current ? { ...current, assigneeId, error: '' } : current,
        )
      }
      onSave={() => void saveEdit(task)}
      onCancelEdit={() => cancelEdit(task)}
      onStartDelete={() => startDelete(task)}
      onConfirmDelete={() => void confirmDelete(task)}
      onCancelDelete={() => cancelDelete(task)}
    />
  );
  const emptyMessage =
    view === 'all'
      ? 'No tasks yet. Add your first one with the + button.'
      : view === 'assigned'
        ? 'No tasks are assigned to you yet: tasks assigned to you in shared lists show here.'
        : `No tasks in ${viewName(view, lists)} yet.`;
  const selectedList = typeof view === 'number' ? lists.find((list) => list.id === view) : undefined;
  const openCount = shownTasks.filter((task) => !task.completed).length;
  const kicker =
    view === 'all'
      ? 'Every list'
      : view === 'inbox'
        ? 'Tasks in no list'
        : view === 'assigned'
          ? 'From shared lists'
          : selectedList?.shared
            ? selectedList.ownerId === me
              ? 'Shared with household'
              : `Shared by ${members.find((member) => member.id === selectedList.ownerId)?.name ?? 'another member'}`
            : 'List';
  const header = (
    <>
      <ViewPicker
        lists={lists}
        view={view}
        listActions={listsState !== 'failed'}
        onSelect={selectView}
        onNewList={openNewList}
        onManageLists={openManage}
      />
      <p className="m-0 mt-1.5 text-[14px] text-ink-2">
        {kicker}
        <span aria-hidden="true">
          {' \u00B7 '}
          {openCount === 0 ? 'Nothing open' : `${openCount} open`}
        </span>
      </p>
    </>
  );
  const overlay = (
    <>
      {/* Fixed bottom right; on a wide screen, at the column's right edge. */}
      <button
        ref={addButton}
        type="button"
        aria-label="Add a task"
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        inert={sheetOpen}
        onClick={openSheet}
        className={cn(
          'fixed right-5 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-30 grid size-16 cursor-pointer place-items-center rounded-full border-0 bg-ink text-cream shadow-[var(--tk-action-shadow)] transition-[transform,background-color] duration-200 hover:scale-105 hover:bg-[var(--tk-action-hover-bg)] motion-reduce:transition-none motion-reduce:hover:scale-100 sm:right-[max(1.25rem,calc(50vw-16.75rem))] sm:bottom-8',
          focusRing,
        )}
      >
        <Plus aria-hidden="true" className="size-7" strokeWidth={2.2} />
      </button>
      {sheetOpen && (
        <AddSheet
          id={ADD_SHEET_ID}
          pageId={PAGE_ID}
          draft={{ ...draft, listId: addListId }}
          lists={lists}
          today={today}
          detail={addDetail}
          error={createError}
          creating={creating}
          titleRef={titleInput}
          dueDateRef={dueDateInput}
          onChange={(change) => {
            setDraft((current) => ({ ...current, ...change }));
            setCreateError(null);
          }}
          onDetail={setAddDetail}
          onSubmit={(event) => void create(event)}
          onClose={closeSheet}
        />
      )}
    </>
  );
  const sectionHeading = 'm-0 px-5 pt-4 pb-1 text-[13px] font-medium';
  return shell(
    <>
      {panels}
      {updateError && (
        <p
          role="alert"
          className="m-0 rounded-2xl border border-[var(--tk-danger-border)] bg-[var(--tk-danger-surface)] px-4 py-3 text-[14px] text-[var(--tk-danger-ink-strong)]"
        >
          {updateError}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="m-0 rounded-2xl bg-[rgba(var(--surface-rgb),0.75)] px-4 py-3 text-[14px] text-muted-foreground shadow-[inset_0_0_0_1px_rgba(var(--frost-rgb),0.6)] backdrop-blur-md"
        >
          {notice}
        </p>
      )}
      {shownTasks.length === 0 ? (
        <div className="tk-rise flex flex-col items-center gap-3 rounded-[26px] bg-[var(--tk-sheet-bg)] px-6 py-10 text-center shadow-[var(--tk-sheet-shadow)] backdrop-blur-md">
          <BrandMark size={40} className="opacity-60" />
          <p className="m-0 max-w-sm text-balance text-ink-2">{emptyMessage}</p>
        </div>
      ) : (
        <>
          {groups.open.length > 0 && (
            // One sheet for every open group; each group is a list named by
            // its heading: "Overdue, list, 2 items".
            <div className={cn(sheetClass, 'tk-rise rounded-[26px] pb-1')}>
              {groups.open.map((group, index) => (
                <section
                  key={group.key}
                  aria-labelledby={`group-${group.key}`}
                  className={cn(index > 0 && 'border-t border-[var(--tk-soft-divider)]')}
                >
                  <h2
                    id={`group-${group.key}`}
                    className={cn(sectionHeading, group.key === 'overdue' ? 'text-destructive' : 'text-ink-3')}
                  >
                    {group.heading}
                  </h2>
                  <ul aria-labelledby={`group-${group.key}`} className="m-0 list-none p-0">
                    {group.tasks.map(renderRow)}
                  </ul>
                </section>
              ))}
            </div>
          )}
          {groups.completed.length > 0 && (
            // Collapsed under the open tasks on every load (AC-7).
            <div className="flex flex-col gap-2">
              <button
                type="button"
                ref={completedToggle}
                aria-expanded={completedOpen}
                aria-controls="completed-tasks"
                onClick={() => setCompletedOpen((open) => !open)}
                className={cn(
                  'min-h-9 cursor-pointer self-start rounded-full border-0 bg-transparent px-2 py-1 text-[14px] text-ink-2 transition-colors hover:text-ink pointer-coarse:min-h-11',
                  focusRing,
                )}
              >
                {completedOpen ? 'Hide done' : `Show ${groups.completed.length} done`}
              </button>
              <ul
                id="completed-tasks"
                aria-label="Completed"
                hidden={!completedOpen}
                className={cn(sheetClass, 'm-0 list-none rounded-[26px] p-0 py-1')}
              >
                {groups.completed.map(renderRow)}
              </ul>
            </div>
          )}
        </>
      )}
    </>,
    header,
    overlay,
  );
}
