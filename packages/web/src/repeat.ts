// Repeats: a task with a due date can repeat every N days, weeks, months or
// years (N from 1 to 99), the same rules as the API (packages/api/src/repeat.ts).
// The schedule itself is computed by the server when a task is completed.

export const REPEAT_UNITS = ['day', 'week', 'month', 'year'] as const;
export type RepeatUnit = (typeof REPEAT_UNITS)[number];
export type Repeat = { every: number; unit: RepeatUnit };
export const MIN_REPEAT_EVERY = 1;
export const MAX_REPEAT_EVERY = 99;
export const REPEAT_EVERY_MESSAGE = `Enter a whole number from ${MIN_REPEAT_EVERY} to ${MAX_REPEAT_EVERY} for how often it repeats.`;
export const REPEAT_NEEDS_DUE_DATE_HINT = 'Set a due date to repeat';

// What the "Repeats" select offers. The presets are every 1 of a unit.
export type RepeatChoice = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
export const REPEAT_CHOICES: { value: RepeatChoice; label: string }[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'custom', label: 'Custom' },
];
const PRESET_UNITS: Partial<Record<RepeatChoice, RepeatUnit>> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
};
export const UNIT_LABELS: Record<RepeatUnit, string> = {
  day: 'days',
  week: 'weeks',
  month: 'months',
  year: 'years',
};

// The values of a form's repeat controls. `every` is the number field's text,
// kept as typed so a half-typed number is not lost.
export type RepeatForm = { choice: RepeatChoice; every: string; unit: RepeatUnit };
export const NO_REPEAT: RepeatForm = { choice: 'none', every: '1', unit: 'week' };

// The controls showing a stored repeat. Every 1 of a unit is its preset.
export function repeatForm(repeat: Repeat | null | undefined): RepeatForm {
  if (!repeat) return NO_REPEAT;
  if (repeat.every === 1) {
    const preset = (Object.keys(PRESET_UNITS) as RepeatChoice[]).find((choice) => PRESET_UNITS[choice] === repeat.unit);
    if (preset) return { choice: preset, every: '1', unit: repeat.unit };
  }
  return { choice: 'custom', every: String(repeat.every), unit: repeat.unit };
}

// A new choice in the select. Custom starts from `seed`, the repeat the task
// had before this edit (null in the add form), not from the presets passed on
// the way: arrowing down from Weekly passes Monthly and Yearly, and each step
// is a change. Without a seed Custom starts at every 1 week.
export function chooseRepeat(form: RepeatForm, choice: RepeatChoice, seed: Repeat | null): RepeatForm {
  const unit = PRESET_UNITS[choice];
  if (unit) return { choice, every: '1', unit };
  if (choice === 'custom') {
    if (form.choice === 'custom') return form;
    return seed
      ? { choice, every: String(seed.every), unit: seed.unit }
      : { choice, every: NO_REPEAT.every, unit: NO_REPEAT.unit };
  }
  return { ...NO_REPEAT };
}

// The repeat a form describes, or a problem with the number field.
export function repeatFromForm(form: RepeatForm): { repeat: Repeat | null } | { problem: string } {
  if (form.choice === 'none') return { repeat: null };
  const unit = PRESET_UNITS[form.choice];
  if (unit) return { repeat: { every: 1, unit } };
  const every = /^\d{1,2}$/.test(form.every.trim()) ? Number(form.every.trim()) : NaN;
  if (!Number.isInteger(every) || every < MIN_REPEAT_EVERY || every > MAX_REPEAT_EVERY) {
    return { problem: REPEAT_EVERY_MESSAGE };
  }
  return { repeat: { every, unit: form.unit } };
}

// Whether the next occurrence of a task due on `dueDate`, completed on
// `today`, would fall after `limit` ("YYYY-MM-DD"), the last supported due
// date. The server counts from its stored anchor, which can move a month-end
// day later in the same month (an anchor on the 31st gives March 31 after
// February 28) but never into another month, so months and years are compared
// by month. This is exact unless "today" is itself in the limit's month, which
// the server's one-day window rules out before December 2100.
export function nextIsBeyond(dueDate: string, today: string, repeat: Repeat, limit: string): boolean {
  const parse = (text: string) => {
    const [year, month, date] = text.split('-').map(Number);
    return { year, month, date, day: Date.UTC(year, month - 1, date) / 86_400_000 };
  };
  const due = parse(dueDate);
  const end = parse(limit);
  // The next occurrence is the first one after the due date and after yesterday.
  const after = Math.max(due.day, parse(today).day - 1);
  if (repeat.unit === 'day' || repeat.unit === 'week') {
    const step = repeat.every * (repeat.unit === 'week' ? 7 : 1);
    return due.day + (Math.floor((after - due.day) / step) + 1) * step > end.day;
  }
  const step = repeat.every * (repeat.unit === 'year' ? 12 : 1);
  const dueMonth = due.year * 12 + due.month - 1;
  for (let month = dueMonth + step; ; month += step) {
    const year = Math.floor(month / 12);
    const lastDay = new Date(Date.UTC(year, (month % 12) + 1, 0)).getUTCDate();
    if (Date.UTC(year, month % 12, Math.min(due.date, lastDay)) / 86_400_000 > after) {
      return month > end.year * 12 + end.month - 1;
    }
  }
}

export function sameRepeat(a: Repeat | null | undefined, b: Repeat | null | undefined) {
  return (a ?? null) === (b ?? null) || (!!a && !!b && a.every === b.every && a.unit === b.unit);
}

// "Repeats weekly", "Repeats every 3 days", and so on.
export function repeatLabel(repeat: Repeat): string {
  if (repeat.every === 1) {
    const adverb = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[repeat.unit];
    return `Repeats ${adverb}`;
  }
  return `Repeats every ${repeat.every} ${UNIT_LABELS[repeat.unit]}`;
}
