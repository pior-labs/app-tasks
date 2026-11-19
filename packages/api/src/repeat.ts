// Calendar arithmetic for repeating tasks. Days are "YYYY-MM-DD" text, as
// stored in PostgreSQL date columns. All arithmetic uses UTC dates built from
// the day's own parts, so neither the process timezone nor daylight saving can
// move a day.

export const REPEAT_UNITS = ['day', 'week', 'month', 'year'] as const;
export type RepeatUnit = (typeof REPEAT_UNITS)[number];
export const MIN_REPEAT_EVERY = 1;
export const MAX_REPEAT_EVERY = 99;

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (value: number, width = 2) => String(value).padStart(width, '0');

function parts(day: string) {
  const [year, month, date] = day.split('-').map(Number);
  return { year, month, date };
}

// Whole days since 1970-01-01.
function dayNumber(day: string) {
  const { year, month, date } = parts(day);
  return Date.UTC(year, month - 1, date) / DAY_MS;
}

function fromDayNumber(days: number) {
  const moment = new Date(days * DAY_MS);
  return `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}`;
}

export function addDays(day: string, days: number) {
  return fromDayNumber(dayNumber(day) + days);
}

// The UTC calendar date of a moment.
export function utcDate(moment: Date) {
  return fromDayNumber(Math.floor(moment.getTime() / DAY_MS));
}

// True for "YYYY-MM-DD" text naming a day that exists (no February 30).
export function isCalendarDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && addDays(value, 0) === value;
}

// The day `count` months after the anchor, on the anchor's day of month, or
// the last day of that month when it is shorter (Jan 31 + 1 month = Feb 28 or 29).
function addMonthsClamped(anchor: string, count: number) {
  const { year, month, date } = parts(anchor);
  const monthIndex = year * 12 + (month - 1) + count;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = monthIndex - targetYear * 12; // 0 to 11
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${pad(targetYear, 4)}-${pad(targetMonth + 1)}-${pad(Math.min(date, lastDay))}`;
}

// Occurrence number `k` of the schedule: the anchor plus k intervals.
function occurrence(anchor: string, every: number, unit: RepeatUnit, k: number) {
  switch (unit) {
    case 'day':
      return addDays(anchor, k * every);
    case 'week':
      return addDays(anchor, k * every * 7);
    case 'month':
      return addMonthsClamped(anchor, k * every);
    case 'year':
      return addMonthsClamped(anchor, k * every * 12);
  }
}

// The next due date of a repeating task on a fixed schedule: the earliest
// occurrence (anchor plus whole intervals) that is after the current due date
// and not before today. Done early, that is the occurrence after the due date;
// done late, overdue occurrences are skipped instead of piling up.
export function nextDueDate({
  anchor,
  dueDate,
  today,
  every,
  unit,
}: {
  anchor: string;
  dueDate: string;
  today: string;
  every: number;
  unit: RepeatUnit;
}) {
  // The answer is the first occurrence strictly after `after`.
  const yesterday = addDays(today, -1);
  const after = dueDate > yesterday ? dueDate : yesterday;
  // Occurrences grow with k, so estimate k from the distance and then step to
  // the exact first one. The estimate is at most one or two steps off.
  let k: number;
  if (unit === 'day' || unit === 'week') {
    const step = every * (unit === 'week' ? 7 : 1);
    k = Math.floor((dayNumber(after) - dayNumber(anchor)) / step);
  } else {
    const step = every * (unit === 'year' ? 12 : 1);
    const a = parts(anchor);
    const b = parts(after);
    k = Math.floor((b.year * 12 + b.month - (a.year * 12 + a.month)) / step);
  }
  while (occurrence(anchor, every, unit, k) > after) k--;
  while (occurrence(anchor, every, unit, k) <= after) k++;
  return occurrence(anchor, every, unit, k);
}
