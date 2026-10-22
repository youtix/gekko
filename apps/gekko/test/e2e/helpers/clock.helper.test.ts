import { ONE_SECOND } from '@gekko/shared/constants/time.const';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  advanceClock,
  fakeTimerCount,
  guardFakeClockStart,
  isFakeClock,
  minuteOf,
  REALTIME_START,
  startFakeClock,
  stopFakeClock,
} from './clock.helper';

/** Waits `ms` on the real clock, once the fake clock is stopped */
const realWait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The message of what startFakeClock threw, undefined when it started the clock */
const startFailureOf = (now?: number) => {
  try {
    startFakeClock(now);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

/** A guard that refuses every start of the fake clock */
const refuseEveryStart = () => {
  throw new Error('A run goes on this clock');
};

describe('clock.helper', () => {
  afterEach(() => stopFakeClock());

  describe('advanceClock', () => {
    // advanceClock advances every second at once, then lets the event loop run: a callback the timer queued runs once that second is
    // over, 1 s in, and the timer it arms is due 1.5 s in, in the next second
    it('should run what a timer started through process.nextTick once the second it fired in is over', async () => {
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

    it('should stop with an error once the fake clock it moves is stopped, and move no clock started since', async () => {
      startFakeClock();
      const advancing = advanceClock(10 * ONE_SECOND).then(
        () => undefined,
        (error: Error) => error.message,
      );
      await new Promise(resolve => setImmediate(resolve));
      startFakeClock();
      expect({ failure: await advancing, at: Date.now() - REALTIME_START }).toEqual({
        failure: 'advanceClock moved a fake clock that was stopped meanwhile',
        at: 0,
      });
    });

    it('should end with the error of a timer whose callback throws, the clock at its instant', async () => {
      startFakeClock();
      setTimeout(() => {
        throw new Error('boom');
      }, 1_500);
      const failure = await advanceClock(3 * ONE_SECOND).then(
        () => undefined,
        (error: Error) => error.message,
      );
      expect({ failure, at: Date.now() - REALTIME_START }).toEqual({ failure: 'boom', at: 1_500 });
    });

    it('should fire nothing more once a callback stops the fake clock, Date left real', async () => {
      startFakeClock();
      const fired: string[] = [];
      setTimeout(() => {
        fired.push('the one that stops the clock');
        stopFakeClock();
      }, 200);
      setTimeout(() => fired.push('a later one'), 300);
      const failure = await advanceClock(ONE_SECOND).then(
        () => undefined,
        (error: Error) => error.message,
      );
      expect({ fired, failure, isDateReal: Date.now() > Date.parse('2026-01-01T00:00:00Z') }).toEqual({
        fired: ['the one that stops the clock'],
        failure: 'advanceClock moved a fake clock that was stopped meanwhile',
        isDateReal: true,
      });
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
      expect({ now: Date.now(), date: new Date().getTime() }).toEqual({ now: expected, date: expected });
    });

    it('should start afresh when the fake clock runs already, its timers dropped', async () => {
      startFakeClock();
      let fired = false;
      setTimeout(() => (fired = true), ONE_SECOND);
      startFakeClock(REALTIME_START + 60_000);
      await advanceClock(2 * ONE_SECOND);
      expect({ fired, at: Date.now() - REALTIME_START }).toEqual({ fired: false, at: 62_000 });
    });
  });

  describe('guardFakeClockStart', () => {
    afterEach(() => guardFakeClockStart(undefined));

    it('should refuse to start the fake clock with the error of the guard, the clock that runs kept with its timers', async () => {
      startFakeClock();
      let fired = false;
      setTimeout(() => (fired = true), ONE_SECOND);
      guardFakeClockStart(refuseEveryStart);
      const failure = startFailureOf(REALTIME_START + 60_000);
      await advanceClock(2 * ONE_SECOND);
      expect({ failure, fired, at: Date.now() - REALTIME_START }).toEqual({ failure: 'A run goes on this clock', fired: true, at: 2_000 });
    });

    it('should refuse to start the fake clock with the error of the guard when none runs, Date left real', () => {
      guardFakeClockStart(refuseEveryStart);
      const failure = startFailureOf();
      expect({ failure, isFakeClock: isFakeClock(), isDateReal: Date.now() > Date.parse('2026-01-01T00:00:00Z') }).toEqual({
        failure: 'A run goes on this clock',
        isFakeClock: false,
        isDateReal: true,
      });
    });

    it.each<[string, (() => void) | undefined]>([
      ['a guard that returns', () => undefined],
      ['no guard, the one set removed', undefined],
    ])('should start the fake clock afresh under %s, its timers dropped', async (_guard, guard) => {
      guardFakeClockStart(refuseEveryStart);
      guardFakeClockStart(guard);
      startFakeClock();
      let fired = false;
      setTimeout(() => (fired = true), ONE_SECOND);
      startFakeClock(REALTIME_START + 60_000);
      await advanceClock(2 * ONE_SECOND);
      expect({ fired, at: Date.now() - REALTIME_START }).toEqual({ fired: false, at: 62_000 });
    });
  });

  describe('the fake timers', () => {
    it('should fire a timeout once, at its instant, with its arguments', async () => {
      startFakeClock();
      const calls: unknown[][] = [];
      setTimeout((...args: unknown[]) => calls.push([Date.now() - REALTIME_START, ...args]), 1_500, 'a', 2);
      await advanceClock(5 * ONE_SECOND);
      expect(calls).toEqual([[1_500, 'a', 2]]);
    });

    it('should call a callback with its handle as this, as Bun does', async () => {
      startFakeClock();
      const calledOn: unknown[] = [];
      const handle = setTimeout(function (this: unknown) {
        calledOn.push(this);
      }, 100);
      await advanceClock(ONE_SECOND);
      expect(calledOn).toEqual([handle]);
    });

    it('should fire an interval every period, until it is cleared', async () => {
      startFakeClock();
      const firedAt: number[] = [];
      const interval = setInterval(() => {
        firedAt.push(Date.now() - REALTIME_START);
        if (firedAt.length === 3) clearInterval(interval);
      }, 700);
      await advanceClock(5 * ONE_SECOND);
      expect(firedAt).toEqual([700, 1_400, 2_100]);
    });

    it.each([
      ['0 as 1 ms', 0, 1],
      ['a negative delay as 1 ms', -5, 1],
      ['no number as 1 ms', 'soon', 1],
      ['a delay above 2^31 - 1 ms as 1 ms', 2 ** 31, 1],
      ['a fraction of a millisecond down', 2.7, 2],
    ])('should take %s, as Bun does', async (_delay, delay, firedAfter) => {
      startFakeClock();
      let firedAt: number | undefined;
      setTimeout(() => (firedAt = Date.now() - REALTIME_START), delay as number);
      await advanceClock(ONE_SECOND);
      expect(firedAt).toBe(firedAfter);
    });

    it('should fire the timers due at one instant in the order they were armed, an interval armed again after them', async () => {
      startFakeClock();
      const fired: string[] = [];
      setInterval(() => fired.push('interval'), 500);
      setTimeout(() => fired.push('first'), 1_000);
      setTimeout(() => fired.push('second'), 1_000);
      await advanceClock(ONE_SECOND);
      expect(fired).toEqual(['interval', 'first', 'second', 'interval']);
    });

    it('should arm an interval again once its callback has returned, after a timer it armed for its next run, as Bun does', async () => {
      startFakeClock();
      const fired: string[] = [];
      const interval = setInterval(() => {
        fired.push(`interval at ${Date.now() - REALTIME_START}`);
        if (fired.length === 1) setTimeout(() => fired.push(`timeout at ${Date.now() - REALTIME_START}`), 100);
      }, 100);
      await advanceClock(250);
      clearInterval(interval);
      expect(fired).toEqual(['interval at 100', 'timeout at 200', 'interval at 200']);
    });

    it('should fire within the same second a timer a callback arms, when it falls due in it', async () => {
      startFakeClock();
      let firedAt: number | undefined;
      setTimeout(() => setTimeout(() => (firedAt = Date.now() - REALTIME_START), 100), 200);
      await advanceClock(ONE_SECOND);
      expect(firedAt).toBe(300);
    });

    it.each([
      ['its handle', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle)],
      ['its number', (handle: ReturnType<typeof setTimeout>) => clearTimeout(Number(handle))],
      ['clearInterval', (handle: ReturnType<typeof setTimeout>) => clearInterval(handle)],
      ['its close()', (handle: ReturnType<typeof setTimeout>) => (handle as unknown as { close: () => void }).close()],
    ])('should not fire a timeout cleared by %s', async (_how, clear) => {
      startFakeClock();
      let fired = false;
      clear(setTimeout(() => (fired = true), 500));
      await advanceClock(ONE_SECOND);
      expect({ fired, timers: fakeTimerCount() }).toEqual({ fired: false, timers: 0 });
    });

    it.each<[string, (handle: ReturnType<typeof setTimeout>) => void, number, number[]]>([
      ['a timeout not fired yet again from the fake now', () => undefined, 600, [1_600]],
      ['a timeout that fired again', () => undefined, 1_500, [1_000, 2_500]],
      ['no cleared timeout', handle => clearTimeout(handle), 600, []],
    ])('should arm %s when its handle is refreshed, as Bun does', async (_timeout, before, refreshAt, firedAt) => {
      startFakeClock();
      const fired: number[] = [];
      const handle = setTimeout(() => fired.push(Date.now() - REALTIME_START), ONE_SECOND);
      before(handle);
      await advanceClock(refreshAt);
      const refreshed = handle.refresh();
      await advanceClock(3 * ONE_SECOND);
      expect({ fired, refreshed: refreshed === handle }).toEqual({ fired: firedAt, refreshed: true });
    });

    it('should give the handle back from ref and unref, and tell by hasRef which of them was called last, as Bun does', () => {
      startFakeClock();
      const handle = setTimeout(() => undefined, ONE_SECOND);
      const unref = handle.unref();
      const afterUnref = handle.hasRef();
      const ref = handle.ref();
      expect({ unref: unref === handle, afterUnref, ref: ref === handle, afterRef: handle.hasRef() }).toEqual({
        unref: true,
        afterUnref: false,
        ref: true,
        afterRef: true,
      });
    });

    it('should not clear a timer of a later fake clock through the handle of a timer of an earlier one', async () => {
      startFakeClock();
      const earlier = setTimeout(() => undefined, 500);
      startFakeClock();
      let fired = false;
      setTimeout(() => (fired = true), 500);
      clearTimeout(earlier);
      clearTimeout(Number(earlier));
      await advanceClock(ONE_SECOND);
      expect(fired).toBe(true);
    });

    it('should refuse a callback that is not a function, as Bun does', () => {
      startFakeClock();
      expect(() => setTimeout('fired = true' as unknown as () => void, 10)).toThrow(TypeError);
    });

    it.each<[string, (fire: () => void) => ReturnType<typeof setTimeout>, (real: ReturnType<typeof setTimeout>) => void]>([
      ['timeout by clearTimeout', fire => setTimeout(fire, 20), real => clearTimeout(real)],
      ['interval by clearInterval', fire => setInterval(fire, 20), real => clearInterval(real)],
    ])('should clear a real %s, armed before the fake clock started', async (_timer, armReal, clear) => {
      let fired = false;
      const real = armReal(() => (fired = true));
      startFakeClock();
      clear(real);
      stopFakeClock();
      await realWait(40);
      expect(fired).toBe(false);
    });
  });

  describe('stopFakeClock', () => {
    it('should put the real timers and Date back, the fake timers left dropped', async () => {
      const real = { setTimeout, clearTimeout, setInterval, clearInterval };
      startFakeClock();
      let fired = false;
      setTimeout(() => (fired = true), 10);
      stopFakeClock();
      await realWait(30);
      expect({
        timers: { setTimeout, clearTimeout, setInterval, clearInterval },
        isFakeClock: isFakeClock(),
        fakeTimers: fakeTimerCount(),
        isDateReal: Date.now() > Date.parse('2026-01-01T00:00:00Z'),
        fired,
      }).toEqual({ timers: real, isFakeClock: false, fakeTimers: 0, isDateReal: true, fired: false });
    });

    it('should leave a reference to a fake timer function kept from a session that is over to the real timers', async () => {
      startFakeClock();
      const keptSetTimeout = setTimeout;
      stopFakeClock();
      const fired = await new Promise(resolve => keptSetTimeout(() => resolve(true), 10));
      expect(fired).toBe(true);
    });

    it('should do nothing when the fake clock does not run', () => {
      stopFakeClock();
      expect(isFakeClock()).toBe(false);
    });
  });

  describe('fakeTimerCount', () => {
    it('should count the timers armed on the fake clock and not fired nor cleared yet', async () => {
      startFakeClock();
      setTimeout(() => undefined, 500);
      setTimeout(() => undefined, 5_000);
      setInterval(() => undefined, 200);
      clearTimeout(setTimeout(() => undefined, 100));
      await advanceClock(ONE_SECOND);
      expect(fakeTimerCount()).toBe(2);
    });
  });
});
