// Report formatting tests, focused on `formatFixed` (banker's rounding) since
// that's one of the three documented divergences from Python and the markdown
// table is the main user-facing artifact.

import { describe, expect, it } from 'vitest';
import { formatFixed } from '../report-swe.js';

describe('report-swe: formatFixed (banker\'s rounding, matches Python format(x, ".Nf"))', () => {
  it('rounds half-to-even (banker\'s rounding)', () => {
    // The classic banker's-rounding cases that diverge from JS toFixed:
    expect(formatFixed(0.5, 0)).toBe('0'); // Python: '0', JS toFixed: '1'
    expect(formatFixed(1.5, 0)).toBe('2'); // both: '2'
    expect(formatFixed(2.5, 0)).toBe('2'); // Python: '2', JS toFixed: '3'
    expect(formatFixed(3.5, 0)).toBe('4'); // both: '4'
    expect(formatFixed(4.5, 0)).toBe('4'); // Python: '4', JS toFixed: '5'
  });

  it('formats with 4 decimal places (cost format)', () => {
    expect(formatFixed(1.2345, 4)).toBe('1.2345');
    expect(formatFixed(0.5, 4)).toBe('0.5000');
    expect(formatFixed(0, 4)).toBe('0.0000');
  });

  it('formats with 2 decimal places (ratio format)', () => {
    expect(formatFixed(1.23, 2)).toBe('1.23');
    expect(formatFixed(0.79, 2)).toBe('0.79');
    expect(formatFixed(1.0, 2)).toBe('1.00');
  });

  it('handles negative numbers (sign preserved like Python format)', () => {
    expect(formatFixed(-1.234, 2)).toBe('-1.23');
    // Python format(-0.5, '.0f') returns '-0' — sign is preserved even
    // though magnitude rounds to zero. We match exactly.
    expect(formatFixed(-0.5, 0)).toBe('-0');
  });

  it('handles non-finite values gracefully', () => {
    expect(formatFixed(Number.NaN, 4)).toBe('NaN');
    expect(formatFixed(Number.POSITIVE_INFINITY, 4)).toBe('Infinity');
    expect(formatFixed(Number.NEGATIVE_INFINITY, 4)).toBe('-Infinity');
  });

  it('rounds non-half values correctly', () => {
    expect(formatFixed(1.234, 2)).toBe('1.23');
    expect(formatFixed(1.236, 2)).toBe('1.24');
    // Note: 1.235 in IEEE-754 is actually slightly less than 1.235 (float
    // imprecision), so it rounds down to 1.23. Python format(1.235, '.2f')
    // returns '1.24' though (Python uses the repr-rounded value). Actually:
    expect(formatFixed(1.235, 2)).toBe('1.24'); // matches Python format(1.235, '.2f')
    // 1.245 in IEEE-754 is slightly MORE than 1.245, so it rounds up to 1.25.
    // Python format(1.245, '.2f') also returns '1.25' — float imprecision
    // dominates banker's rounding here. We match Python's behavior.
    expect(formatFixed(1.245, 2)).toBe('1.25');
  });
});
