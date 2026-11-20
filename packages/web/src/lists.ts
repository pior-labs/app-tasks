import { VISIBLE_CHARACTER, characterCount } from './text';

// A list the user named. Inbox is not a list: a task with listId null is in Inbox.
export type List = { id: number; name: string };

// What the task area shows: every task, Inbox, or one list (by id).
export type View = 'all' | 'inbox' | number;

export const MAX_LIST_NAME_LENGTH = 50;
// The built-in views' names, compared as a person would see them, like the
// server (packages/api/src/lists.ts): letter case is ignored, invisible code
// points (default ignorables such as a zero width space, joiners, direction
// marks and the soft hyphen, and control characters) are dropped, and any run
// of white space counts as one space. "Inbox zero" is a normal name.
const RESERVED_LIST_NAMES = ['inbox', 'all tasks'];
const isReservedListName = (name: string) =>
  RESERVED_LIST_NAMES.includes(
    name
      .replace(/\p{White_Space}+/gu, ' ')
      .replace(/[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, '')
      .replace(/ +/g, ' ')
      .trim()
      .toLowerCase(),
  );

// The client-side list name check for a new list and a rename, on the trimmed
// name. It mirrors the server (packages/api/src/lists.ts): at least one visible
// character, no U+0000, at most 50 code points, not a built-in view's name
// (isReservedListName), and not the name of another of the user's lists in
// any letter case (`exceptId` is the list being renamed). Returns the message
// to show, or an empty string.
export function listNameProblem(trimmed: string, lists: List[], exceptId?: number) {
  if (!VISIBLE_CHARACTER.test(trimmed)) return 'Enter a list name.';
  if (trimmed.includes('\u0000')) return 'List names cannot contain a null character.';
  if (characterCount(trimmed) > MAX_LIST_NAME_LENGTH) {
    return `List names can be at most ${MAX_LIST_NAME_LENGTH} characters.`;
  }
  if (isReservedListName(trimmed)) return '"Inbox" and "All tasks" are built in. Choose another name.';
  const folded = trimmed.toLowerCase();
  if (lists.some((list) => list.id !== exceptId && list.name.toLowerCase() === folded)) {
    return 'You already have a list with that name.';
  }
  return '';
}

// The view is kept in the URL as ?list=all, ?list=inbox or ?list=<id>, so a
// reload keeps it. Anything else is "All tasks" (as is an id that is not one
// of the user's lists, which the caller checks once the lists are known).
export function viewFromSearch(search: string): View {
  const value = new URLSearchParams(search).get('list');
  if (value === 'inbox') return 'inbox';
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
  return lists.find((list) => list.id === view)?.name ?? 'Inbox';
}
export const tabId = (view: View) => `list-tab-${view}`;
