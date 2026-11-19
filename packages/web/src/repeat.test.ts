import { describe, expect, test } from 'vitest';
import { NO_REPEAT, chooseRepeat, repeatForm, repeatFromForm, repeatLabel, sameRepeat } from './repeat';

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
    // Custom starts from the current values; a preset or none replaces them.
    expect(chooseRepeat(repeatForm({ every: 1, unit: 'year' }), 'custom')).toEqual({ choice: 'custom', every: '1', unit: 'year' });
    expect(chooseRepeat({ choice: 'custom', every: '5', unit: 'day' }, 'weekly')).toEqual({ choice: 'weekly', every: '1', unit: 'week' });
    expect(chooseRepeat({ choice: 'custom', every: '5', unit: 'day' }, 'none')).toEqual(NO_REPEAT);
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
