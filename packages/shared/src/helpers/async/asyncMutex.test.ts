import { noop } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { AsyncMutex } from './asyncMutex';

/** A promise the test resolves itself: a function returning it holds the lock until then */
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(res => (resolve = res));
  return { promise, resolve };
};

/**
 * Lets the microtask queue turn `turns` times, many more than a hand-over of the lock takes: a function the mutex let run by then has
 * started. Timers are not needed, nor wanted: the order of the microtasks is deterministic, a timer only waits longer.
 */
const yieldMicrotasks = async (turns = 10) => {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
};

/**
 * Takes the free lock as runExclusive does, for a holder whose end the test decides: it returns the holder's release, which runExclusive
 * calls once its function is done
 */
const holdLock = (mutex: AsyncMutex) => mutex['grant']();

const throwSync = () => {
  throw new Error('sync-error');
};

const throwAsync = async () => {
  await Promise.resolve();
  throw new Error('async-error');
};

describe('AsyncMutex', () => {
  describe('runExclusive', () => {
    it.each`
      kind       | fn                            | expected
      ${'sync'}  | ${() => 42}                   | ${42}
      ${'async'} | ${async () => 'async-result'} | ${'async-result'}
    `('should resolve to $expected, what the $kind function returns', async ({ fn, expected }) => {
      await expect(new AsyncMutex().runExclusive(fn)).resolves.toBe(expected);
    });

    it.each`
      kind       | fn            | message
      ${'sync'}  | ${throwSync}  | ${'sync-error'}
      ${'async'} | ${throwAsync} | ${'async-error'}
    `('should reject with $message, the error the $kind function throws', async ({ fn, message }) => {
      await expect(new AsyncMutex().runExclusive(fn)).rejects.toThrow(message);
    });

    it('should start the function before returning when the lock is free: fn, then the caller', async () => {
      const mutex = new AsyncMutex();
      const events: string[] = [];

      const done = mutex.runExclusive(() => {
        events.push('fn');
      });
      events.push('caller');
      await done;

      expect(events).toEqual(['fn', 'caller']);
    });

    it('should keep a caller waiting while the lock is held: nothing started after 10 turns of the microtask queue', async () => {
      const mutex = new AsyncMutex();
      const holder = deferred();
      const started: string[] = [];
      void mutex.runExclusive(() => holder.promise);

      void mutex.runExclusive(() => {
        started.push('waiter');
      });
      await yieldMicrotasks();

      expect(started).toEqual([]);
    });

    it('should run the functions waiting for the lock one after the other, in the order they called: A, B, then C', async () => {
      const mutex = new AsyncMutex();
      const holder = deferred();
      const events: string[] = [];
      // The first to call runs the longest, so that functions running at once would end in the reverse order
      const task = (name: string, turns: number) =>
        mutex.runExclusive(async () => {
          events.push(`start-${name}`);
          await yieldMicrotasks(turns);
          events.push(`end-${name}`);
        });
      const held = mutex.runExclusive(() => holder.promise);
      const tasks = [task('A', 3), task('B', 2), task('C', 1)];

      holder.resolve();
      await Promise.all([held, ...tasks]);

      expect(events).toEqual(['start-A', 'end-A', 'start-B', 'end-B', 'start-C', 'end-C']);
    });

    it('should count 3 after three concurrent increments that read the counter, await, then write it', async () => {
      const mutex = new AsyncMutex();
      let counter = 0;
      const increment = () =>
        mutex.runExclusive(async () => {
          const current = counter;
          await Promise.resolve();
          counter = current + 1;
        });

      await Promise.all([increment(), increment(), increment()]);

      expect(counter).toBe(3);
    });

    it('should hand the lock to the waiter before a caller arriving once it is released: the waiter, then the late caller', async () => {
      const mutex = new AsyncMutex();
      const order: string[] = [];
      const release = holdLock(mutex);
      const waiter = mutex.runExclusive(() => {
        order.push('waiter');
      });

      release();
      const late = mutex.runExclusive(() => {
        order.push('late');
      });
      await Promise.all([waiter, late]);

      expect(order).toEqual(['waiter', 'late']);
    });

    // What the simulator relies on: the exchange calls an onSettled callback starts wait for the bucket being processed
    it('should make a runExclusive called by the function holding the lock wait for it to end: end, then nested', async () => {
      const mutex = new AsyncMutex();
      const events: string[] = [];
      let nested: Promise<void> | undefined;

      await mutex.runExclusive(() => {
        nested = mutex.runExclusive(() => {
          events.push('nested');
        });
        events.push('end');
      });
      await nested;

      expect(events).toEqual(['end', 'nested']);
    });

    it.each`
      outcome       | fn
      ${'returned'} | ${() => 42}
      ${'resolved'} | ${async () => 42}
      ${'thrown'}   | ${throwSync}
      ${'rejected'} | ${throwAsync}
    `('should free the lock once the function has $outcome: the next function starts at once', async ({ fn }) => {
      const mutex = new AsyncMutex();
      await mutex.runExclusive(fn).catch(noop);
      let started = false;

      void mutex.runExclusive(() => {
        started = true;
      });

      expect(started).toBe(true);
    });
  });

  describe('a release', () => {
    it('should hand the lock to one waiter only when called twice: A started, B still waiting', async () => {
      const mutex = new AsyncMutex();
      const holderA = deferred();
      const started: string[] = [];
      const release = holdLock(mutex);
      void mutex.runExclusive(() => {
        started.push('A');
        return holderA.promise;
      });
      void mutex.runExclusive(() => {
        started.push('B');
      });

      release();
      release();
      await yieldMicrotasks();

      expect(started).toEqual(['A']);
    });

    it('should leave the lock to its next holder when called again: A started, C still waiting', async () => {
      const mutex = new AsyncMutex();
      const holderA = deferred();
      const started: string[] = [];
      const release = holdLock(mutex);
      void mutex.runExclusive(() => {
        started.push('A');
        return holderA.promise;
      });
      release();
      await yieldMicrotasks();

      release();
      void mutex.runExclusive(() => {
        started.push('C');
      });
      await yieldMicrotasks();

      expect(started).toEqual(['A']);
    });
  });
});
