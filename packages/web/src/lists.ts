import { VISIBLE_CHARACTER, characterCount } from './text';

// A list the user named. Inbox is not a list: a task with listId null is in Inbox.
export type List = { id: number; name: string };

// What the task area shows: every task, Inbox, or one list (by id).
export type View = 'all' | 'inbox' | number;

export const MAX_LIST_NAME_LENGTH = 50;
// When two list names count as the same, and whether a name is a built-in
// view's. The same fold as the server (foldListName in
// packages/api/src/lists.ts): Unicode NFKC (fullwidth and other compatibility
// forms become their plain letters), any run of white space counts as one
// space, invisible code points (default ignorables such as a zero width space,
// joiners, direction marks and the soft hyphen, and control characters) are
// dropped, then trimmed and lowercased. Letters from other scripts that only
// look Latin are not folded, and "Inbox zero" is a normal name.
const foldListName = (name: string) =>
  name
    .normalize('NFKC')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/[\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, '')
    .replace(/ +/g, ' ')
    .trim()
    .toLowerCase();
const RESERVED_LIST_NAMES = ['inbox', 'all tasks'];

// The client-side list name check for a new list and a rename, on the trimmed
// name. It mirrors the server (packages/api/src/lists.ts): at least one visible
// character, no U+0000, at most 50 code points, not a built-in view's name,
// and not another of the user's lists by fold (`exceptId` is the list being
// renamed, which may keep its own fold). Returns the message to show, or an
// empty string. Where the server's database still refuses a name (its lower()
// differs from the fold for a few letters), the form shows the server's 409.
export function listNameProblem(trimmed: string, lists: List[], exceptId?: number) {
  if (!VISIBLE_CHARACTER.test(trimmed)) return 'Enter a list name.';
  if (trimmed.includes('\u0000')) return 'List names cannot contain a null character.';
  if (characterCount(trimmed) > MAX_LIST_NAME_LENGTH) {
    return `List names can be at most ${MAX_LIST_NAME_LENGTH} characters.`;
  }
  const folded = foldListName(trimmed);
  if (RESERVED_LIST_NAMES.includes(folded)) return '"Inbox" and "All tasks" are built in. Choose another name.';
  const current = lists.find((list) => list.id === exceptId);
  if (current && foldListName(current.name) === folded) return '';
  if (lists.some((list) => list.id !== exceptId && foldListName(list.name) === folded)) {
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
