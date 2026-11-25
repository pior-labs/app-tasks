import { type List, foldListName } from '../services/lists.js';
import type { Member } from '../services/members.js';
import type { ActingUser } from './caller.js';

// Agents name lists and members the way people do. These turn a name (or an
// id) into the id the services take, with the same fold the web app uses for
// list names (foldListName). A name that fits more than one is an error that
// names the candidates, never a guess (D-5).

export type Resolved<T> = { ok: true; value: T } | { ok: false; message: string };

const isDigits = (value: string) => /^[1-9]\d{0,15}$/.test(value.trim());

export function listLabel(list: List, user: ActingUser, members: Map<number, string>) {
  const whose = list.ownerId === user.id ? 'yours' : `${members.get(list.ownerId) ?? 'another member'}'s`;
  return `"${list.name}" (id ${list.id}, ${whose}${list.shared ? ', shared' : ''})`;
}

// A list reference: an id, a name, "Inbox" or null (both meaning no list).
// A string of digits is both: the list with that id and the lists with that
// name all count, and two different lists are an error, never a guess.
export function resolveList(
  reference: string | number | null,
  lists: List[],
  user: ActingUser,
  members: Map<number, string>,
): Resolved<number | null> {
  if (reference === null) return { ok: true, value: null };
  const byId = (id: number): Resolved<number | null> =>
    lists.some((list) => list.id === id)
      ? { ok: true, value: id }
      : { ok: false, message: `No list with id ${id} is one of your lists or a shared list. Use list_lists to see them.` };
  if (typeof reference === 'number') return byId(reference);
  const folded = foldListName(reference);
  if (folded === 'inbox') return { ok: true, value: null };
  const matches = lists.filter((list) => foldListName(list.name) === folded);
  if (isDigits(reference)) {
    const id = Number(reference);
    const withId = lists.find((list) => list.id === id);
    if (withId && !matches.includes(withId)) matches.push(withId);
    if (matches.length === 0) return byId(id);
  }
  if (matches.length === 1) return { ok: true, value: matches[0].id };
  if (matches.length > 1) {
    return {
      ok: false,
      message: `More than one list ${isDigits(reference) ? 'fits' : 'is named'} "${reference.trim()}": ${matches
        .map((list) => listLabel(list, user, members))
        .join(', ')}. Give the list's id as a number instead.`,
    };
  }
  const names = lists.map((list) => `"${list.name}"`);
  return {
    ok: false,
    message: `No list is named "${reference.trim()}". ${
      names.length ? `The lists are Inbox, ${names.join(', ')}.` : 'There are no lists yet, only Inbox.'
    } Lists cannot be created here.`,
  };
}

// An assignee reference: "me", a member's display name or id, or null for
// nobody. A string of digits is both: the member with that id and the members
// with that name all count, and two different members are an error.
export function resolveMember(
  reference: string | number | null,
  members: Member[],
  user: ActingUser,
): Resolved<number | null> {
  if (reference === null) return { ok: true, value: null };
  const byId = (id: number): Resolved<number | null> =>
    members.some((member) => member.id === id)
      ? { ok: true, value: id }
      : { ok: false, message: `No household member has id ${id}.` };
  if (typeof reference === 'number') return byId(reference);
  const folded = foldListName(reference);
  if (folded === 'me') return { ok: true, value: user.id };
  const matches = members.filter((member) => foldListName(member.name) === folded);
  if (isDigits(reference)) {
    const id = Number(reference);
    const withId = members.find((member) => member.id === id);
    if (withId && !matches.includes(withId)) matches.push(withId);
    if (matches.length === 0) return byId(id);
  }
  if (matches.length === 1) return { ok: true, value: matches[0].id };
  if (matches.length > 1) {
    return {
      ok: false,
      message: `More than one household member ${isDigits(reference) ? 'fits' : 'is named'} "${reference.trim()}": ${matches
        .map((member) => `${member.name} (id ${member.id})`)
        .join(', ')}. Give the member's id as a number instead.`,
    };
  }
  return {
    ok: false,
    message: `No household member is named "${reference.trim()}". The members are ${members
      .map((member) => `${member.name} (id ${member.id})`)
      .join(', ')}.`,
  };
}
