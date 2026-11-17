import { dueStatus } from './dueDate';
import type { Task } from './TaskRow';

export type OpenGroupKey = 'overdue' | 'today' | 'upcoming' | 'no-date';

export type TaskGroups = {
  // The open groups in display order, each only when it has tasks.
  open: { key: OpenGroupKey; heading: string; tasks: Task[] }[];
  completed: Task[];
};

const headings: Record<OpenGroupKey, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  'no-date': 'No date',
};

// Earliest due date first. Array sort is stable, so tasks due on the same day
// keep the order they arrived in.
const byDueDate = (a: Task, b: Task) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : 0);

// Groups tasks for display relative to `today` (the browser's local date,
// "YYYY-MM-DD"). `tasks` is in the server's order, newest created first, and
// that order is kept wherever a group is not sorted by due date: Today, No date
// and Completed. Overdue and Upcoming are sorted by due date, earliest first.
export function groupTasks(tasks: Task[], today: string): TaskGroups {
  const buckets: Record<OpenGroupKey, Task[]> = { overdue: [], today: [], upcoming: [], 'no-date': [] };
  const completed: Task[] = [];
  for (const task of tasks) {
    if (task.completed) completed.push(task);
    else if (task.dueDate === null) buckets['no-date'].push(task);
    else buckets[dueStatus(task.dueDate, today)].push(task);
  }
  buckets.overdue.sort(byDueDate);
  buckets.upcoming.sort(byDueDate);
  const order: OpenGroupKey[] = ['overdue', 'today', 'upcoming', 'no-date'];
  return {
    open: order
      .filter((key) => buckets[key].length > 0)
      .map((key) => ({ key, heading: headings[key], tasks: buckets[key] })),
    completed,
  };
}

// The rows a user can see, top to bottom.
export function visibleTasks(groups: TaskGroups, completedOpen: boolean): Task[] {
  return [...groups.open.flatMap((group) => group.tasks), ...(completedOpen ? groups.completed : [])];
}
