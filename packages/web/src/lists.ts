import { VISIBLE_CHARACTER, characterCount } from './text';

// A list the user can see: one of their own, or one another member shared
// (ownerId tells whose). Inbox is not a list: a task with listId null is in
// Inbox. A shared list is shared with the household: every Tasks user sees it
// and can do everything with it that the owner can.
export type List = { id: number; name: string; shared: boolean; ownerId: number };

// A Tasks user: everyone who has signed in to Tasks (packages/api/src/members.ts).
export type Member = { id: number; name: string };

// The answer of an older server or stub may leave out shared and ownerId:
// such a list is the user's own and not shared.
export const listFromServer = (list: Partial<List> & { id: number; name: string }, me: number): List => ({
  id: list.id,
  name: list.name,
  shared: list.shared ?? false,
  ownerId: list.ownerId ?? me,
});

// What the task area shows: every task, Inbox, the tasks assigned to the
// signed-in user in any shared list ("Assigned to me"), or one list (by id).
export type View = 'all' | 'inbox' | 'assigned' | number;
// The built-in views, in tab order before the lists.
export const BUILT_IN_VIEWS: View[] = ['all', 'inbox', 'assigned'];

export const MAX_LIST_NAME_LENGTH = 50;
// When two list names count as the same, and whether a name is a built-in
// view's. The same fold as the server (foldListName in
// packages/api/src/lists.ts): Unicode NFKC (fullwidth and other compatibility
// forms become their plain letters), any run of white space counts as one
// space, invisible code points (default ignorables such as a zero width space,
// joiners, direction marks and the soft hyphen, and control characters) are
// dropped, NFKC is applied again (so an invisible one between a letter and its
// combining mark does not keep them apart), then trimmed and lowercased.
// Letters from other scripts that only look Latin are not folded, and "Inbox
// zero" or "Assigned to me later" is a normal name.
const foldListName = (name: string) =>
  name
    .normalize('NFKC')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, '')
    .normalize('NFKC')
    .replace(/ +/g, ' ')
    .trim()
    .toLowerCase();
const RESERVED_LIST_NAMES = ['inbox', 'all tasks', 'assigned to me'];

// The client-side list name check for a new list and a rename, on the trimmed
// name. It mirrors the server (packages/api/src/lists.ts): at least one visible
// character, no U+0000, at most 50 code points, not a built-in view's name,
// and not another of the owner's lists by fold (`exceptId` is the list being
// renamed, which may keep its own fold). `lists` are the lists of the owner
// (the user for a new list; the renamed list's owner, as far as the user can
// see them). Returns the message to show, or an empty string. Where the
// server still refuses a name (its lower() differs from the fold for a few
// letters, or the owner has an unshared list the user cannot see), the form
// shows the server's 409.
export function listNameProblem(trimmed: string, lists: List[], exceptId?: number) {
  if (!VISIBLE_CHARACTER.test(trimmed)) return 'Enter a list name.';
  if (trimmed.includes('\u0000')) return 'List names cannot contain a null character.';
  if (characterCount(trimmed) > MAX_LIST_NAME_LENGTH) {
    return `List names can be at most ${MAX_LIST_NAME_LENGTH} characters.`;
  }
  const folded = foldListName(trimmed);
  if (RESERVED_LIST_NAMES.includes(folded)) {
    return '"Inbox", "All tasks" and "Assigned to me" are built in. Choose another name.';
  }
  const current = lists.find((list) => list.id === exceptId);
  if (current && foldListName(current.name) === folded) return '';
  if (lists.some((list) => list.id !== exceptId && foldListName(list.name) === folded)) {
    return 'You already have a list with that name.';
  }
  return '';
}

// The view is kept in the URL as ?list=all, ?list=inbox, ?list=assigned or
// ?list=<id>, so a
// reload keeps it. Anything else is "All tasks" (as is an id that is not one
// of the user's lists, which the caller checks once the lists are known).
export function viewFromSearch(search: string): View {
  const value = new URLSearchParams(search).get('list');
  if (value === 'inbox' || value === 'assigned') return value;
  if (value !== null && /^[1-9]\d{0,9}$/.test(value)) return Number(value);
  return 'all';
}
export function writeViewToUrl(view: View) {
  const url = new URL(location.href);
  url.searchParams.set('list', String(view));
  history.replaceState(history.state, '', url);
}

export function viewName(view: View, lists: List[]) {
  if (view === 'all') return 'All tasks';
  if (view === 'inbox') return 'Inbox';
  if (view === 'assigned') return 'Assigned to me';
  return lists.find((list) => list.id === view)?.name ?? 'Inbox';
}
export const tabId = (view: View) => `list-tab-${view}`;
