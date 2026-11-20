// Due dates are calendar days written as "YYYY-MM-DD", with no time and no
// timezone. "Today" is the browser's local calendar date. Days are compared as
// text (fixed-width ISO dates sort in calendar order) and shifted with UTC
// arithmetic, which has no daylight saving gaps, so no local time conversion
// can move a due date to another day.

// The supported range, the same as the API's (packages/api/src/tasks.ts).
export const MIN_DUE_DATE = '2025-01-01';
export const MAX_DUE_DATE = '2100-12-31';
export const DUE_DATE_RANGE_MESSAGE = 'Choose a due date from January 1, 2025 to December 31, 2100.';
export const INCOMPLETE_DUE_DATE_MESSAGE = 'Enter a complete due date, or leave the field empty.';

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

// The local calendar date of a moment, as "YYYY-MM-DD".
export function localDate(moment: Date): string {
  return `${pad(moment.getFullYear(), 4)}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

function parts(day: string) {
  const [year, month, date] = day.split('-').map(Number);
  return { year, month, date };
}

// The day `days` after (or before) a "YYYY-MM-DD" day.
export function addDays(day: string, days: number): string {
  const { year, month, date } = parts(day);
  const shifted = new Date(Date.UTC(year, month - 1, date + days));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

// Milliseconds from a moment until the next local midnight. Constructing the
// date from local parts follows daylight saving changes.
export function msUntilNextLocalMidnight(moment: Date): number {
  const next = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate() + 1);
  return Math.max(0, next.getTime() - moment.getTime());
}

// Whether a date field holds no date at all, not even a partly typed one.
// Chromium reports a partly typed date as value '' with badInput. When the
// last part is emptied with the keyboard, badInput turns off without an
// input or change event, so the forms also check on keyup and on blur.
export function holdsNoDate(field: HTMLInputElement): boolean {
  return field.value === '' && !field.validity?.badInput;
}

// The client-side due date check shared by the add form and the edit row.
// An empty value means "no due date" and is valid. Returns the message to
// show, or an empty string.
export function dueDateProblem(value: string): string {
  if (value === '') return '';
  // A day that does not exist (such as February 30) does not survive the
  // round trip through UTC arithmetic.
  const exists = /^\d{4}-\d{2}-\d{2}$/.test(value) && addDays(value, 0) === value;
  if (!exists || value < MIN_DUE_DATE || value > MAX_DUE_DATE) return DUE_DATE_RANGE_MESSAGE;
  return '';
}

export type DueStatus = 'overdue' | 'today' | 'upcoming';

export function dueStatus(dueDate: string, today: string): DueStatus {
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'today';
  return 'upcoming';
}

// "Due today", "Due tomorrow", "Due yesterday", or the date with a short
// weekday, day and month in the browser's locale (for example "Due Fri, Nov
// 20"), with the year only when it is not the current year. The day is
// formatted in UTC from its own parts, so the local timezone cannot shift it.
export function dueLabel(dueDate: string, today: string, locale?: string): string {
  if (dueDate === today) return 'Due today';
  if (dueDate === addDays(today, 1)) return 'Due tomorrow';
  if (dueDate === addDays(today, -1)) return 'Due yesterday';
  const { year, month, date } = parts(dueDate);
  const sameYear = year === parts(today).year;
  const text = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, date)));
  return `Due ${text}`;
}
