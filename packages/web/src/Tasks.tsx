import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  INCOMPLETE_DUE_DATE_MESSAGE,
  MAX_DUE_DATE,
  MIN_DUE_DATE,
  dueDateProblem,
  dueLabel,
  holdsNoDate,
  localDate,
  msUntilNextLocalMidnight,
} from './dueDate';
import { jsonHeaders, serverError } from './http';
import { ListBar, MANAGE_LISTS_BUTTON_ID, NEW_LIST_BUTTON_ID, TASKS_PANEL_ID, goneListMessage } from './ListBar';
import {
  type List,
  type Member,
  type View,
  listFromServer,
  tabId,
  viewFromSearch,
  viewName,
  writeViewToUrl,
} from './lists';
import { RepeatControl, RepeatHint } from './RepeatControl';
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
import { type RowMode, type ShareLabels, type Task, TaskRow, submitOnModEnter } from './TaskRow';
import { groupTasks, visibleTasks } from './taskGroups';
import { VISIBLE_CHARACTER, characterCount } from './text';

export type { Task };

const MAX_TITLE_LENGTH = 200;
const MAX_NOTES_LENGTH = 5000;

// The client-side title check shared by the add form and the inline edit
// field. Returns the message to show, or an empty string for a valid title.
function titleProblem(trimmed: string) {
  if (!VISIBLE_CHARACTER.test(trimmed)) return 'Enter a task title.';
  if (characterCount(trimmed) > MAX_TITLE_LENGTH) {
    return `Task titles can be at most ${MAX_TITLE_LENGTH} characters.`;
  }
  return '';
}

// The client-side notes check shared by the add form and the edit row, on
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

type Field = 'title' | 'dueDate' | 'repeat' | 'notes' | 'list' | 'assignee';
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

// `me` is the signed-in user's id.
export function Tasks({ me, onSignedOut }: { me: number; onSignedOut: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [listState, setListState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // The user's lists (for the tab row), loaded next to the tasks. When they
  // fail to load, the built-in views still work.
  const [lists, setLists] = useState<List[]>([]);
  const [listsState, setListsState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // Every Tasks user, to name who added, completed or is assigned a task in a
  // shared list. Without them (they failed to load) rows name nobody.
  const [members, setMembers] = useState<Member[]>([]);
  // The view asked for (by the URL or a tab). A list id that is not one of
  // the user's lists shows "All tasks" (D-5), so no task is hidden by default.
  const [requestedView, setRequestedView] = useState<View>(() => viewFromSearch(location.search));
  const view: View =
    typeof requestedView === 'number' && !lists.some((list) => list.id === requestedView) ? 'all' : requestedView;
  const shownTasks = view === 'all' ? tasks : tasks.filter((task) => inView(task, view, me, lists));
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [repeat, setRepeat] = useState<RepeatForm>(NO_REPEAT);
  // The add form's notes field shows behind the "Add notes" toggle. Hiding it
  // keeps the text for when it is shown again, also across an add, but hidden
  // notes are not sent.
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState('');
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
  // a tab or a Manage lists entry that went away); focus then goes to the
  // same control in the row's new place, else the nearest row after it that
  // is still shown (or before it), else the new-task field; a tab's focus to
  // the selected tab; and a Manage lists entry's to the nearest list left
  // there, else New list. Focus that is still on the page is never moved.
  const focusAfterRefresh = useRef<{
    element: Element;
    rowId?: number;
    action?: string;
    caret: { start: number; end: number } | null;
    // The rows shown, and the lists, in page order when the refresh applied.
    rowOrder?: number[];
    listId?: number;
    listOrder?: number[];
    tab: boolean;
  } | null>(null);
  useEffect(() => {
    const target = focusAfterRender.current?.();
    focusAfterRender.current = null;
    target?.focus();
    if (focusOnDay.current?.day === today) {
      const moved = focusOnDay.current.target();
      focusOnDay.current = null;
      moved?.focus();
    }
    const refreshed = focusAfterRefresh.current;
    focusAfterRefresh.current = null;
    const active = document.activeElement;
    if (refreshed && !refreshed.element.isConnected && (!active || active === document.body)) {
      // A control in a collapsed (hidden) section cannot take focus.
      const shown = (element: HTMLElement | null | undefined) =>
        element && !element.closest('[hidden]') ? element : undefined;
      let next: HTMLElement | undefined;
      if (refreshed.rowId !== undefined) {
        const same = refreshed.action ? shown(control(refreshed.rowId, refreshed.action)) : undefined;
        // Neighbours lost in the same refresh are skipped.
        next =
          same ??
          nearest(refreshed.rowOrder ?? [], refreshed.rowId, (id) => shown(firstControl(id))) ??
          shown(titleInput.current);
        next?.focus();
        // The caret belongs to the control it was saved from, not to the
        // neighbour's checkbox or the new-task field that takes focus instead.
        if (next === same) restoreCaret(next, refreshed.caret);
      } else if (refreshed.tab) {
        next = shown(document.getElementById(tabId(view)));
        next?.focus();
      } else if (refreshed.listId !== undefined || refreshed.element.id === MANAGE_LISTS_BUTTON_ID) {
        // As after a list leaves the panel here: the next list's Rename (or
        // the Cancel of the question it asks, never its Confirm, else its
        // rename field), else the previous one's, else New list (Manage
        // lists goes away with the last list).
        const entry = (id: number) => {
          const item = document.querySelector(`#manage-lists [data-list-id="${id}"]`);
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
          shown(document.getElementById(NEW_LIST_BUTTON_ID));
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
  // notice). Drafts in the edit row and the add form live outside the task
  // data, so they are kept as typed.
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshing.current || !mounted.current || latest.current.listState !== 'ready') return;
    refreshing.current = true;
    const finished = activity.current.finished;
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
      // with a notice, since there is no list it could be shown under.
      const openIds = [...new Set([before.editingId, before.confirmingId])].filter((id): id is number => id !== null);
      const lostTasks = before.tasks.filter(
        (task) =>
          openIds.includes(task.id) &&
          !serverIds.has(task.id) &&
          task.listId !== null &&
          !nextLists.some((list) => list.id === task.listId),
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
        const entry = active.closest<HTMLElement>('#manage-lists [data-list-id]');
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
          tab: active.getAttribute('role') === 'tab',
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
  // else's list) or move to Inbox (it was deleted). Returns the tasks whose
  // open rows closed in "Assigned to me" (see closeRowsLeavingAssigned).
  function removeList(list: List, deleted: boolean, movedTaskIds: number[] = []) {
    const left = closeRowsLeavingAssigned(list, movedTaskIds);
    const moved = new Set(movedTaskIds);
    setTasks((current) =>
      current.flatMap((task) => {
        if (task.listId !== list.id && !moved.has(task.id)) return [task];
        if (!deleted || !keptAfterDelete(task, list)) return [];
        return [{ ...task, listId: null, assigneeId: null }];
      }),
    );
    applyLists(lists.filter((item) => item.id !== list.id));
    setEditing((current) => {
      const task = current && tasks.find((item) => item.id === current.id);
      return task && task.listId === list.id && (!deleted || !keptAfterDelete(task, list)) ? null : current;
    });
    if (requestedView === list.id) selectView('inbox');
    return left;
  }

  // A list the server no longer has for the user (deleted in another tab, or
  // unshared or deleted by another member): it goes as if deleted, with a
  // notice, and a refresh then shows where its tasks really went.
  function dropList(list: List, message: string) {
    const left = removeList(list, true);
    setNotice([message, ...left.map(unassignedByListMessage)].join(' '));
    if (list.shared) setTimeout(() => void refresh(), 0);
  }

  const isSharedList = (listId: number | null) =>
    listId !== null && (lists.find((list) => list.id === listId)?.shared ?? false);

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
    // Notes are sent, and cleared after the add, only when the area is shown.
    const notesSent = notesOpen;
    const newNotes = notesSent ? storedNotes(notes) : null;
    const notesError = notesOpen ? notesProblem(notes.trim()) : '';
    if (notesError) return setCreateError({ message: notesError, field: 'notes' });
    // A task added in a named list goes there; in "All tasks", Inbox and
    // "Assigned to me" it goes to Inbox, which is no field at all.
    const list = typeof view === 'number' ? lists.find((item) => item.id === view) : undefined;
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
          ...(dueDate === '' ? {} : { dueDate }),
          ...(repeatChoice.repeat === null ? {} : { repeat: repeatChoice.repeat }),
          ...(list ? { listId: list.id } : {}),
        }),
      });
      if (!mounted.current) return;
      if (response.status === 401) return onSignedOut();
      if (response.status === 400) {
        const { message, code } = await serverError(response, 'That task was not accepted.');
        // The list was deleted meanwhile. The typed task is kept for Inbox.
        if (code === 'invalid_list' && list) {
          return dropList(list, `${goneListMessage(list)} The task was not added.`);
        }
        return setCreateError({ message, field: fieldOf(code) });
      }
      if (!response.ok) throw new Error();
      const body: { task: Task } = await response.json();
      // Only a task the server confirmed is added to the list.
      const created = fromServer(body.task);
      setTasks((current) =>
        current.some((item) => item.id === created.id) ? current : [created, ...current],
      );
      // From "Assigned to me" the task goes to Inbox, which this view does not
      // show, so a notice says where it went.
      if (!inView(created, view, me, lists)) {
        setNotice(`Added "${created.title}" to ${viewName(created.listId ?? 'inbox', lists)}.`);
      }
      setTitle('');
      setDueDate('');
      setRepeat(NO_REPEAT);
      // Hidden notes were not sent, so their text stays for when the area is shown.
      if (notesSent) {
        setNotes('');
        setNotesOpen(false);
      }
      // Ready for the next task, also when the add button was clicked.
      titleInput.current?.focus();
    } catch {
      setCreateError({ message: 'The task could not be saved. Please try again.', field: 'title' });
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
      // new-task field, and a notice says where the task went or who has it.
      const leavesView = !inView(updated, view, me, lists);
      const neighbour = leavesView ? visibleNeighbour(task.id) : undefined;
      // The row shows the new title, date and repeat, and moves to its new
      // group, only once the server has stored them. Focus follows it to Edit.
      setTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      leaveEdit(task);
      if (leavesView) {
        if (hasFocus(task.id)) {
          focusAfterRender.current = () => (neighbour ? firstControl(neighbour.id) : titleInput.current);
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

  // The tasks and the lists load together; lists that fail do not hold up the tasks.
  if (listState === 'loading' || (listState === 'ready' && listsState === 'loading')) {
    return <p role="status">Loading your tasks...</p>;
  }
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
  const listClass = 'divide-y divide-border rounded-lg border border-border';
  const headingClass = 'text-sm font-semibold uppercase tracking-wide';
  // Where an added task goes: the selected list, else Inbox.
  const destination = typeof view === 'number' ? viewName(view, lists) : 'Inbox';
  const emptyMessage =
    view === 'all'
      ? 'No tasks yet. Add your first one above.'
      : view === 'assigned'
        ? 'No tasks are assigned to you yet: tasks assigned to you in shared lists show here.'
        : `No tasks in ${viewName(view, lists)} yet.`;
  return (
    <div className="space-y-4">
      <ListBar
        lists={lists}
        me={me}
        members={members}
        failed={listsState === 'failed'}
        view={view}
        onSelect={selectView}
        onRetry={() => void loadLists()}
        onCreated={(list) => {
          setLists((current) => [...current, list]);
          selectView(list.id);
        }}
        onUpdated={(list) => {
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
        }}
        onLeft={(list) => {
          const left = removeList(list, false);
          setNotice([leftListMessage(list), ...left.map(lostTaskMessage)].join(' '));
        }}
        onDeleted={(list, movedTaskIds) => {
          const left = removeList(list, true, movedTaskIds);
          if (left.length > 0) setNotice(left.map(unassignedByListMessage).join(' '));
          setEditing((current) => (current?.listId === list.id ? { ...current, listId: null, assigneeId: null } : current));
        }}
        onGone={dropList}
        onSignedOut={onSignedOut}
        taskCount={(id) => tasks.filter((task) => task.listId === id).length}
        track={track}
      />
      <div role="tabpanel" id={TASKS_PANEL_ID} aria-labelledby={tabId(view)} className="space-y-4">
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
                placeholder={`Add to ${destination}`}
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
                  if (holdsNoDate(event.target)) setRepeat(NO_REPEAT);
                  setCreateError(null);
                }}
                // Emptying the last part of a date fires no change event, so the
                // key that did it, or leaving the field, resets the repeat.
                onKeyUp={(event) => {
                  if (holdsNoDate(event.currentTarget)) setRepeat(withoutRepeat);
                }}
                onBlur={(event) => {
                  if (holdsNoDate(event.currentTarget)) setRepeat(withoutRepeat);
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
          {/* After Add task in Tab order, so title, date, repeat, Add task stay as they were. */}
          <button
            type="button"
            aria-expanded={notesOpen}
            aria-controls="new-task-notes-area"
            onClick={() => {
              setNotesOpen((open) => !open);
              setCreateError((current) => (current?.field === 'notes' ? null : current));
            }}
            className="flex items-center gap-2 rounded-md py-1 text-sm font-medium"
          >
            <span aria-hidden="true" className={`inline-block transition-transform ${notesOpen ? 'rotate-90' : ''}`}>
              &#9656;
            </span>
            Add notes
          </button>
          <div id="new-task-notes-area" hidden={!notesOpen} className="flex flex-col gap-2">
            <label htmlFor="new-task-notes" className="block text-sm font-medium">
              Notes
            </label>
            {/* Enter is a new line here; Ctrl+Enter or Cmd+Enter adds the task. */}
            <textarea
              id="new-task-notes"
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value);
                setCreateError(null);
              }}
              onKeyDown={submitOnModEnter}
              readOnly={creating}
              rows={3}
              aria-invalid={createError?.field === 'notes' || undefined}
              aria-describedby={createError?.field === 'notes' ? 'new-task-error' : undefined}
              className="min-w-0 rounded-md border border-border bg-card px-4 py-3 text-card-foreground read-only:opacity-60"
            />
          </div>
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
        {shownTasks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-5 text-muted-foreground">{emptyMessage}</p>
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
    </div>
  );
}
