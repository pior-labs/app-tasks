import { describe, expect, test } from 'vitest';
import { NO_REPEAT, chooseRepeat, nextIsBeyond, repeatForm, repeatFromForm, repeatLabel, sameRepeat } from './repeat';

describe('repeat labels and controls', () => {
  test('labels name presets by their adverb and other intervals in words', () => {
    expect(repeatLabel({ every: 1, unit: 'day' })).toBe('Repeats daily');
    expect(repeatLabel({ every: 1, unit: 'week' })).toBe('Repeats weekly');
    expect(repeatLabel({ every: 1, unit: 'month' })).toBe('Repeats monthly');
    expect(repeatLabel({ every: 1, unit: 'year' })).toBe('Repeats yearly');
    expect(repeatLabel({ every: 3, unit: 'day' })).toBe('Repeats every 3 days');
    expect(repeatLabel({ every: 2, unit: 'week' })).toBe('Repeats every 2 weeks');
    expect(repeatLabel({ every: 99, unit: 'year' })).toBe('Repeats every 99 years');
  });

  test('a stored repeat shows as its preset, else as Custom, and round-trips', () => {
    expect(repeatForm(null)).toEqual(NO_REPEAT);
    expect(repeatForm({ every: 1, unit: 'month' }).choice).toBe('monthly');
    expect(repeatForm({ every: 6, unit: 'month' })).toEqual({ choice: 'custom', every: '6', unit: 'month' });
    for (const repeat of [null, { every: 1, unit: 'day' }, { every: 12, unit: 'week' }] as const) {
      expect(repeatFromForm(repeatForm(repeat))).toEqual({ repeat });
    }
    // A preset or none replaces the values.
    expect(chooseRepeat({ choice: 'custom', every: '5', unit: 'day' }, 'weekly', null)).toEqual({ choice: 'weekly', every: '1', unit: 'week' });
    expect(chooseRepeat({ choice: 'custom', every: '5', unit: 'day' }, 'none', null)).toEqual(NO_REPEAT);
  });

  test('Custom starts from the repeat before the edit, not from the preset passed on the way (R1-F2)', () => {
    const yearly = repeatForm({ every: 1, unit: 'year' });
    expect(chooseRepeat(yearly, 'custom', { every: 1, unit: 'week' })).toEqual({ choice: 'custom', every: '1', unit: 'week' });
    expect(chooseRepeat(yearly, 'custom', { every: 6, unit: 'month' })).toEqual({ choice: 'custom', every: '6', unit: 'month' });
    expect(chooseRepeat(yearly, 'custom', null)).toEqual({ choice: 'custom', every: '1', unit: 'week' });
    // Already Custom: the typed values stay.
    const typed = { choice: 'custom', every: '4', unit: 'day' } as const;
    expect(chooseRepeat(typed, 'custom', { every: 1, unit: 'week' })).toBe(typed);
  });

  test('nextIsBeyond tells the 2100-12-31 limit apart (R1-F1)', () => {
    const limit = '2100-12-31';
    const beyond = (dueDate: string, today: string, every: number, unit: 'day' | 'week' | 'month' | 'year') =>
      nextIsBeyond(dueDate, today, { every, unit }, limit);
    expect(beyond('2100-12-31', '2026-11-20', 1, 'day')).toBe(true);
    expect(beyond('2100-12-30', '2026-11-20', 1, 'day')).toBe(false);
    expect(beyond('2100-12-24', '2026-11-20', 1, 'week')).toBe(false);
    expect(beyond('2100-12-25', '2026-11-20', 1, 'week')).toBe(true);
    expect(beyond('2100-12-23', '2026-11-20', 2, 'week')).toBe(true);
    expect(beyond('2100-12-17', '2026-11-20', 2, 'week')).toBe(false);
    expect(beyond('2100-11-30', '2026-11-20', 1, 'month')).toBe(false);
    expect(beyond('2100-12-01', '2026-11-20', 1, 'month')).toBe(true);
    expect(beyond('2100-06-01', '2026-11-20', 1, 'year')).toBe(true);
    expect(beyond('2099-12-31', '2026-11-20', 1, 'year')).toBe(false);
    expect(beyond('2026-11-20', '2026-11-20', 99, 'year')).toBe(true);
    expect(beyond('2026-11-20', '2026-11-20', 1, 'week')).toBe(false);
    // Late: counted from today, not from the old due date.
    expect(beyond('2026-11-01', '2026-11-20', 1, 'day')).toBe(false);
  });

  test('Custom accepts whole numbers from 1 to 99 only', () => {
    for (const every of ['1', '99', ' 7 ', '07']) {
      expect(repeatFromForm({ choice: 'custom', every, unit: 'day' })).toHaveProperty('repeat');
    }
    for (const every of ['0', '100', '', '1.5', '-1', '1e1', 'two']) {
      expect(repeatFromForm({ choice: 'custom', every, unit: 'day' })).toHaveProperty('problem');
    }
  });

  test('sameRepeat compares values, treating a missing repeat as none', () => {
    expect(sameRepeat(null, undefined)).toBe(true);
    expect(sameRepeat({ every: 2, unit: 'week' }, { every: 2, unit: 'week' })).toBe(true);
    expect(sameRepeat({ every: 2, unit: 'week' }, { every: 2, unit: 'day' })).toBe(false);
    expect(sameRepeat({ every: 1, unit: 'week' }, null)).toBe(false);
  });
});
