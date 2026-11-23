import { describe, expect, test } from 'vitest';
import {
  DUE_DATE_RANGE_MESSAGE,
  addDays,
  dueDateProblem,
  dueLabel,
  dueStatus,
  localDate,
  msUntilNextLocalMidnight,
} from './dueDate';
import type { Task } from './TaskRow';
import { groupTasks, visibleTasks } from './taskGroups';

describe('due date helpers', () => {
  test('localDate is the local calendar date, also just before and after midnight', () => {
    expect(localDate(new Date(2026, 10, 20, 0, 0, 0))).toBe('2026-11-20');
    expect(localDate(new Date(2026, 10, 20, 23, 59, 59, 999))).toBe('2026-11-20');
    expect(localDate(new Date(2026, 0, 5, 12))).toBe('2026-01-05');
    expect(localDate(new Date(2100, 11, 31, 12))).toBe('2100-12-31');
  });

  test('addDays crosses months, years and leap days', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
  });

  test('msUntilNextLocalMidnight counts to the next local day', () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 10, 20, 23, 59, 0))).toBe(60_000);
    const noon = new Date(2026, 10, 20, 12);
    expect(localDate(new Date(noon.getTime() + msUntilNextLocalMidnight(noon)))).toBe('2026-11-21');
  });

  test('dueDateProblem applies the API range and calendar rules', () => {
    for (const valid of ['', '2025-01-01', '2100-12-31', '2028-02-29', '2026-11-20']) {
      expect(dueDateProblem(valid)).toBe('');
    }
    for (const invalid of [
      '2026-1-5',
      '20261105',
      '2026-11-05T00:00:00Z',
      '2026-02-30',
      '2025-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-11-00',
      '2024-12-31',
      '2101-01-01',
      '0000-01-01',
    ]) {
      expect(dueDateProblem(invalid)).toBe(DUE_DATE_RANGE_MESSAGE);
    }
  });

  test('dueStatus compares with today', () => {
    expect(dueStatus('2026-11-19', '2026-11-20')).toBe('overdue');
    expect(dueStatus('2025-01-01', '2026-11-20')).toBe('overdue');
    expect(dueStatus('2026-11-20', '2026-11-20')).toBe('today');
    expect(dueStatus('2026-11-21', '2026-11-20')).toBe('upcoming');
  });

  test('dueLabel uses words near today, a locale date otherwise, and the year only outside this year', () => {
    const today = '2026-11-20';
    expect(dueLabel('2026-11-20', today, 'en-US')).toBe('Due today');
    expect(dueLabel('2026-11-21', today, 'en-US')).toBe('Due tomorrow');
    expect(dueLabel('2026-11-19', today, 'en-US')).toBe('Due yesterday');
    expect(dueLabel('2026-11-27', today, 'en-US')).toBe('Due Fri, Nov 27');
    expect(dueLabel('2026-11-10', today, 'en-US')).toBe('Due Tue, Nov 10');
    expect(dueLabel('2027-01-05', today, 'en-US')).toBe('Due Tue, Jan 5, 2027');
    expect(dueLabel('2025-12-31', today, 'en-US')).toBe('Due Wed, Dec 31, 2025');
    // Words also across a year boundary.
    expect(dueLabel('2027-01-01', '2026-12-31', 'en-US')).toBe('Due tomorrow');
    expect(dueLabel('2026-12-31', '2027-01-01', 'en-US')).toBe('Due yesterday');
    // Another locale formats the date its own way.
    expect(dueLabel('2026-11-27', today, 'de-DE')).toBe('Due Fr., 27. Nov.');
  });
});

describe('grouping', () => {
  const task = (id: number, dueDate: string | null, completed = false): Task => ({
    id,
    title: `Task ${id}`,
    listId: null,
    notes: null,
    completed,
    dueDate,
    repeat: null,
    createdById: null,
    completedById: null,
    assigneeId: null,
  });

  test('open tasks go to Overdue, Today, Upcoming and No date; completed tasks to Completed', () => {
    // Server order: newest created first.
    const tasks = [
      task(12, '2026-11-18'),
      task(11, null, true),
      task(10, '2026-11-25'),
      task(9, '2026-11-20'),
      task(8, null),
      task(7, '2026-11-10'),
      task(6, '2026-11-21'),
      task(5, '2026-11-18'),
      task(4, '2026-11-01', true),
      task(3, '2026-11-20'),
      task(2, null),
      task(1, '2026-11-21'),
    ];
    const groups = groupTasks(tasks, '2026-11-20');
    const ids = (list: Task[]) => list.map((item) => item.id);
    expect(groups.open.map((group) => [group.heading, ids(group.tasks)])).toEqual([
      // By due date, earliest first; same day: newest created first.
      ['Overdue', [7, 12, 5]],
      // Newest created first.
      ['Today', [9, 3]],
      ['Upcoming', [6, 1, 10]],
      ['No date', [8, 2]],
    ]);
    expect(ids(groups.completed)).toEqual([11, 4]);
    expect(ids(visibleTasks(groups, false))).toEqual([7, 12, 5, 9, 3, 6, 1, 10, 8, 2]);
    expect(ids(visibleTasks(groups, true))).toEqual([7, 12, 5, 9, 3, 6, 1, 10, 8, 2, 11, 4]);
  });

  test('empty groups are left out', () => {
    const groups = groupTasks([task(2, null), task(1, '2026-11-21')], '2026-11-20');
    expect(groups.open.map((group) => group.heading)).toEqual(['Upcoming', 'No date']);
    expect(groups.completed).toEqual([]);
    expect(groupTasks([], '2026-11-20')).toEqual({ open: [], completed: [] });
  });
});
