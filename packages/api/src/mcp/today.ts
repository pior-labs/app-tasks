// The household's calendar day. The web app takes "today" from the browser;
// an agent has no trustworthy clock of its own, so the MCP tools use the date
// in the household's timezone (TASKS_TIMEZONE), report it in every result, and
// send it as `today` when completing a repeating task.

export type HouseholdDay = { today: string; weekday: string; timezone: string };

export function householdDay(moment: Date, timeZone: string): HouseholdDay {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(moment);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return { today: `${part('year')}-${part('month')}-${part('day')}`, weekday: part('weekday'), timezone: timeZone };
}
