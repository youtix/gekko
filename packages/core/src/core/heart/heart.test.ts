import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { debug } from '../../logger/logger';
import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { Heart } from './heart';

vi.mock('../../logger/logger', () => ({ debug: vi.fn() }));

describe('Heart', () => {
  const tickRate = 1000;
  // 400 ms after a multiple of the tick rate
  const boundary = Date.UTC(2024, 0, 1);
  const start = boundary + 400;
  let heart: Heart;
  let ticks: number[];
  let onError: Mock;

  /** Builds a heart that records the time of each tick and each error */
  const createHeart = (gracePeriod?: number) => {
    const created = new Heart(tickRate, gracePeriod === undefined ? undefined : { gracePeriod });
    created.on('tick', () => ticks.push(Date.now()));
    created.on('error', onError);
    return created;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    ticks = [];
    onError = vi.fn();
    heart = createHeart();
  });

  afterEach(() => {
    heart.stop();
    vi.useRealTimers();
  });

  describe('pump', () => {
    it('should log the start of the heartbeat', () => {
      heart.pump();
      expect(debug).toHaveBeenCalledWith('core', 'Starting heartbeat ticks');
    });

    it('should not tick synchronously', () => {
      heart.pump();
      expect(ticks).toEqual([]);
    });

    it('should defer the first tick to the next turn of the event loop', () => {
      heart.pump();
      vi.advanceTimersByTime(0);
      expect(ticks).toEqual([start]);
    });

    it.each`
      gracePeriod  | expected
      ${undefined} | ${[start, boundary + 1000, boundary + 2000, boundary + 3000]}
      ${0}         | ${[start, boundary + 1000, boundary + 2000, boundary + 3000]}
      ${250}       | ${[start, boundary + 1250, boundary + 2250, boundary + 3250]}
      ${600}       | ${[start, boundary + 600, boundary + 1600, boundary + 2600]}
    `('should tick on each boundary plus a grace period of $gracePeriod ms after the first tick', ({ gracePeriod, expected }) => {
      heart = createHeart(gracePeriod);
      heart.pump();
      vi.advanceTimersByTime(3000);
      expect(ticks).toEqual(expected);
    });

    it('should do nothing when the heart is already beating', () => {
      heart.pump();
      heart.pump();
      vi.advanceTimersByTime(2000);
      expect(ticks).toEqual([start, boundary + 1000, boundary + 2000]);
    });

    it('should log the start of the heartbeat once when pumped twice', () => {
      heart.pump();
      heart.pump();
      expect(vi.mocked(debug).mock.calls).toEqual([['core', 'Starting heartbeat ticks']]);
    });
  });

  describe('timing', () => {
    beforeEach(() => {
      heart.pump();
      vi.advanceTimersByTime(0); // First tick
    });

    // A slow callback holding the event loop past the boundary: an interval would shift every later tick by the same delay
    it('should tick on the next boundary after a timer that fired late', () => {
      vi.advanceTimersByTime(500);
      vi.setSystemTime(Date.now() + 300); // The pending timer keeps its remaining 100 ms, so fires 300 ms after the boundary
      vi.advanceTimersByTime(1500);
      expect(ticks).toEqual([start, boundary + 1300, boundary + 2000]);
    });

    it('should wait for the boundary when a timer fires early', () => {
      vi.advanceTimersByTime(500);
      vi.setSystemTime(Date.now() - 5); // The pending timer fires 5 ms before the boundary
      vi.advanceTimersByTime(500);
      expect(ticks).toEqual([start, boundary + 1000]);
    });

    it('should keep the drift of a long run at zero', () => {
      vi.advanceTimersByTime(1000 * 1000);
      expect(ticks.slice(1).every((tick, index) => tick === boundary + (index + 1) * 1000)).toBe(true);
    });
  });

  describe('tick', () => {
    beforeEach(() => {
      heart.tick();
    });

    it.each`
      delay                | event
      ${tickRate}          | ${'tick'}
      ${tickRate * 3}      | ${'tick'}
      ${tickRate * 3 + 1}  | ${'error'}
      ${tickRate * 10_000} | ${'error'}
    `('should emit $event when it comes $delay ms after the previous tick', ({ delay, event }) => {
      vi.setSystemTime(start + delay);
      const emit = vi.spyOn(heart, 'emit');
      heart.tick();
      expect(emit.mock.calls[0][0]).toBe(event);
    });

    it('should emit a GekkoError when it comes too late', () => {
      vi.setSystemTime(start + tickRate * 3 + 1);
      heart.tick();
      expect(onError).toHaveBeenCalledExactlyOnceWith(new GekkoError('core', 'Failed to tick in time'));
    });

    it('should not emit a tick when it comes too late', () => {
      vi.setSystemTime(start + tickRate * 3 + 1);
      heart.tick();
      expect(ticks).toEqual([start]);
    });

    it('should measure the next tick from the late one', () => {
      vi.setSystemTime(start + tickRate * 3 + 1);
      heart.tick();
      vi.setSystemTime(start + tickRate * 4 + 1);
      heart.tick();
      expect(ticks).toEqual([start, start + tickRate * 4 + 1]);
    });

    it('should throw the GekkoError when nothing listens to errors', () => {
      heart.off('error', onError);
      vi.setSystemTime(start + tickRate * 3 + 1);
      expect(() => heart.tick()).toThrowError(new GekkoError('core', 'Failed to tick in time'));
    });

    it('should emit a tick on the first tick, however late', () => {
      const fresh = createHeart();
      vi.setSystemTime(start + tickRate * 10_000);
      fresh.tick();
      expect(ticks).toEqual([start, start + tickRate * 10_000]);
    });
  });

  describe('when the machine sleeps between two ticks', () => {
    beforeEach(() => {
      heart.pump();
      vi.advanceTimersByTime(0); // First tick
      vi.setSystemTime(Date.now() + tickRate * 5); // The pending timer fires 5 tick rates late
      vi.advanceTimersByTime(1000);
    });

    it('should emit an error', () => {
      expect(onError).toHaveBeenCalledOnce();
    });

    it('should keep beating, on the boundaries', () => {
      vi.advanceTimersByTime(2000);
      expect(ticks).toEqual([start, boundary + 7000, boundary + 8000]);
    });
  });

  describe('stop', () => {
    it('should log the stop of the heartbeat', () => {
      heart.stop();
      expect(debug).toHaveBeenCalledWith('core', 'Stopping heartbeat ticks');
    });

    it('should cancel the deferred first tick', () => {
      heart.pump();
      heart.stop();
      vi.advanceTimersByTime(5000);
      expect(ticks).toEqual([]);
    });

    it('should cancel the next tick', () => {
      heart.pump();
      vi.advanceTimersByTime(0);
      heart.stop();
      vi.advanceTimersByTime(5000);
      expect(ticks).toEqual([start]);
    });

    it('should cancel the next tick when a tick listener stops the heart', () => {
      heart.once('tick', () => heart.stop());
      heart.pump();
      vi.advanceTimersByTime(5000);
      expect(ticks).toEqual([start]);
    });

    it('should let the heart be pumped again', () => {
      heart.pump();
      heart.stop();
      heart.pump();
      vi.advanceTimersByTime(0);
      expect(ticks).toEqual([start]);
    });

    it('should defer the first tick again when pumped after ticking', () => {
      heart.pump();
      vi.advanceTimersByTime(0);
      heart.stop();
      vi.advanceTimersByTime(100);
      heart.pump();
      vi.advanceTimersByTime(0);
      expect(ticks).toEqual([start, start + 100]);
    });
  });

  describe('isHeartBeating', () => {
    it.each`
      scenario                          | actions                          | expected
      ${'not started'}                  | ${[]}                            | ${false}
      ${'pumped'}                       | ${['pump']}                      | ${true}
      ${'beating after its first tick'} | ${['pump', 'firstTick']}         | ${true}
      ${'stopped'}                      | ${['pump', 'stop']}              | ${false}
      ${'stopped after its first tick'} | ${['pump', 'firstTick', 'stop']} | ${false}
    `('should return $expected when $scenario', ({ actions, expected }) => {
      const run = { pump: () => heart.pump(), firstTick: () => vi.advanceTimersByTime(0), stop: () => heart.stop() };
      for (const action of actions as (keyof typeof run)[]) run[action]();
      expect(heart.isHeartBeating()).toBe(expected);
    });
  });
});
