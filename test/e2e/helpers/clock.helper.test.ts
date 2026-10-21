import { ONE_SECOND } from '@constants/time.const';
import { afterEach, describe, expect, it, jest } from 'bun:test';
import { advanceClock, minuteOf, REALTIME_START, startFakeClock } from './clock.helper';

describe('clock.helper', () => {
  afterEach(() => jest.useRealTimers());

  // First in the file, so that in the order the tests are defined its first test starts outside Bun's event loop (the runner enters it
  // once a test of the file has waited on it), where an advance runs a timer's process.nextTick callbacks at the timer's instant
  describe('advanceClock', () => {
    // advanceClock advances every second from inside the event loop, where the callback runs once that second is over, 1 s in: the
    // timer it arms is due 1.5 s in and fires in the next second. A first second advanced from outside ran it at 0.5 s, the timer at 1 s
    it('should run what a timer started through process.nextTick once the second it fired in is over, whatever ran before', async () => {
      startFakeClock();
      let firedAt: number | undefined;
      setTimeout(() => process.nextTick(() => setTimeout(() => (firedAt = Date.now()), 500)), 500);
      await advanceClock(2 * ONE_SECOND);
      expect(firedAt! - REALTIME_START).toBe(1_500);
    });

    it('should move the fake clock by the time asked, the last step shorter', async () => {
      startFakeClock();
      await advanceClock(90_500);
      expect(Date.now() - REALTIME_START).toBe(90_500);
    });

    it('should stop at the end of the second in which `until` came to hold', async () => {
      startFakeClock();
      await advanceClock(10 * ONE_SECOND, { until: () => Date.now() >= REALTIME_START + 2_500 });
      expect(Date.now() - REALTIME_START).toBe(3 * ONE_SECOND);
    });

    it('should refuse to move the real clock', async () => {
      const failure = await advanceClock(ONE_SECOND).then(
        () => undefined,
        (error: Error) => error.message,
      );
      expect(failure).toBe('advanceClock moves the fake clock: call startFakeClock() first');
    });
  });

  describe('minuteOf', () => {
    const minute = Date.parse('2024-01-01T00:01:00Z');

    it.each([
      ['the start of a minute', minute, minute],
      ['an instant inside a minute', minute + 30_000, minute],
      ['the last millisecond of a minute', minute + 59_999, minute],
    ])('should give the start of the minute holding %s', (_instant, timestamp, start) => {
      expect(minuteOf(timestamp)).toBe(start);
    });
  });

  describe('startFakeClock', () => {
    it.each([
      ['REALTIME_START, 30 s into a minute, by default', undefined, Date.parse('2024-01-01T12:00:30Z')],
      ['the instant given', Date.parse('2025-06-30T23:59:59Z'), Date.parse('2025-06-30T23:59:59Z')],
    ])('should set Date to %s', (_instant, now, expected) => {
      startFakeClock(now);
      expect(Date.now()).toBe(expected);
    });

    it('should fake the timers too: one fires once the fake clock reaches it', () => {
      startFakeClock();
      let fired = false;
      setTimeout(() => (fired = true), ONE_SECOND);
      jest.advanceTimersByTime(ONE_SECOND);
      expect(fired).toBe(true);
    });
  });
});
