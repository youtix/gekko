import { describe, expect, it } from 'bun:test';
import { minuteOf } from './clock.helper';

describe('minuteOf', () => {
  const minute = Date.parse('2024-01-01T00:01:00Z');

  // This file keeps real minutes: ONE_MINUTE is not mocked here
  it.each([
    ['the start of a minute', minute, minute],
    ['an instant inside a minute', minute + 30_000, minute],
    ['the last millisecond of a minute', minute + 59_999, minute],
  ])('should give the start of the minute holding %s', (_instant, timestamp, start) => {
    expect(minuteOf(timestamp)).toBe(start);
  });
});
