import { waitSync } from '@gekko/shared/utils/process/process.utils';
import { writeSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WRITE_LOCK_STALE_MS } from './logger.const';
import { acquireWriteLock, releaseWriteLock, renewWriteLock, writeAll, writeAllUnderLock, writeAvailable } from './logger.helper';
import { WriteLock } from './logger.types';

vi.mock('node:fs', async importOriginal => ({ ...(await importOriginal<typeof import('node:fs')>()), writeSync: vi.fn() }));
vi.mock('@gekko/shared/utils/process/process.utils', () => ({ waitSync: vi.fn() }));

/** writeSync as writeAvailable calls it: `length` bytes of `bytes` from `offset` */
type WriteSync = (fd: number, bytes: Uint8Array, offset: number, length: number) => number;

const errnoError = (code: string) => Object.assign(new Error(code), { code });
const EAGAIN = errnoError('EAGAIN');
const EINTR = errnoError('EINTR');
const EPIPE = errnoError('EPIPE');

/** The time of the tests, from which the leases are dated */
const NOW = 1_700_000_000_000;

/** The value of a write lock held by `holder` since `time` */
const leaseAt = (time: number, holder: bigint) => (BigInt(time) << 16n) | holder;

/** A free write lock */
const freeLock = (): WriteLock => new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));

describe('logger.helper', () => {
  /** What the next writes do, in turn: take that many bytes, or throw that error. The writes after them take every byte. */
  let outcomes: (number | Error)[];
  /** The writes, each with the text it was given and its descriptor, and the waits, in the order made */
  let events: string[];

  beforeEach(() => {
    outcomes = [];
    events = [];
    vi.mocked(writeSync as WriteSync).mockImplementation((fd, bytes, offset, length) => {
      events.push(`write ${Buffer.from(bytes.subarray(offset, offset + length)).toString()} to ${fd}`);
      const outcome = outcomes.shift() ?? length;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    vi.mocked(waitSync).mockImplementation(ms => {
      events.push(`wait ${ms} ms`);
    });
  });

  describe('writeAvailable', () => {
    const write = () => writeAvailable(1, Buffer.from('abc'));

    it.each`
      scenario                                                | given          | expected
      ${'every byte at once'}                                 | ${[]}          | ${{ taken: 3, events: ['write abc to 1'] }}
      ${'every byte, in the parts the descriptor takes'}      | ${[1, 1]}      | ${{ taken: 3, events: ['write abc to 1', 'write bc to 1', 'write c to 1'] }}
      ${'none while the descriptor is full (EAGAIN)'}         | ${[EAGAIN]}    | ${{ taken: 0, events: ['write abc to 1'] }}
      ${'what the descriptor took before it was full'}        | ${[1, EAGAIN]} | ${{ taken: 1, events: ['write abc to 1', 'write bc to 1'] }}
      ${'none after a signal interrupted a write (EINTR)'}    | ${[EINTR]}     | ${{ taken: 0, events: ['write abc to 1'] }}
      ${'none from a write that takes nothing without error'} | ${[0]}         | ${{ taken: 0, events: ['write abc to 1'] }}
    `('writes $scenario, without waiting', ({ given, expected }) => {
      outcomes = given;
      const taken = write();
      expect({ taken, events }).toEqual(expected);
    });

    it.each`
      failure                        | description
      ${EPIPE}                       | ${'EPIPE'}
      ${errnoError('EBADF')}         | ${'EBADF'}
      ${new Error('without a code')} | ${'an error without a code'}
    `('throws the error of a write that fails otherwise: $description', ({ failure }) => {
      outcomes = [failure];
      expect(write).toThrow(failure);
    });
  });

  describe('writeAll', () => {
    const write = (onWait?: () => void) => writeAll(1, Buffer.from('abc'), onWait);

    it.each`
      scenario                                               | given                          | expected
      ${'at once'}                                           | ${[]}                          | ${['write abc to 1']}
      ${'in the parts the descriptor takes'}                 | ${[1, 1]}                      | ${['write abc to 1', 'write bc to 1', 'write c to 1']}
      ${'once the descriptor is no longer full (EAGAIN)'}    | ${[EAGAIN]}                    | ${['write abc to 1', 'wait 1 ms', 'write abc to 1']}
      ${'after a signal interrupted a write (EINTR)'}        | ${[EINTR]}                     | ${['write abc to 1', 'wait 1 ms', 'write abc to 1']}
      ${'after a write that took nothing without error'}     | ${[0]}                         | ${['write abc to 1', 'wait 1 ms', 'write abc to 1']}
      ${'waiting twice as long each time it is full'}        | ${[EAGAIN, EAGAIN, EAGAIN]}    | ${['write abc to 1', 'wait 1 ms', 'write abc to 1', 'wait 2 ms', 'write abc to 1', 'wait 4 ms', 'write abc to 1']}
      ${'waiting 1 ms again once a write took part of them'} | ${[EAGAIN, EAGAIN, 1, EAGAIN]} | ${['write abc to 1', 'wait 1 ms', 'write abc to 1', 'wait 2 ms', 'write abc to 1', 'write bc to 1', 'wait 1 ms', 'write bc to 1']}
    `('writes every byte $scenario', ({ given, expected }) => {
      outcomes = given;
      write();
      expect(events).toEqual(expected);
    });

    it('waits 100 ms at most between two writes that take nothing', () => {
      outcomes = Array.from({ length: 9 }, () => EAGAIN);
      write();
      expect(vi.mocked(waitSync).mock.calls.map(([ms]) => ms)).toEqual([1, 2, 4, 8, 16, 32, 64, 100, 100]);
    });

    it('calls onWait before each wait', () => {
      outcomes = [EAGAIN, EAGAIN];
      write(() => events.push('on wait'));
      expect(events).toEqual(['write abc to 1', 'on wait', 'wait 1 ms', 'write abc to 1', 'on wait', 'wait 2 ms', 'write abc to 1']);
    });

    it('throws the error of a write that fails otherwise', () => {
      outcomes = [EAGAIN, EPIPE];
      expect(() => write()).toThrow(EPIPE);
    });

    it('does not write again after a write that fails otherwise', () => {
      outcomes = [EPIPE];
      try {
        write();
      } catch {
        // Thrown, as the row above expects
      }
      expect(events).toEqual(['write abc to 1']);
    });
  });

  describe('write lock', () => {
    let lock: WriteLock;
    /** The waits of this thread for the lock: the value waited on and the most milliseconds waited */
    let waits: [bigint, number][];

    beforeEach(() => {
      lock = freeLock();
      waits = [];
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
    });

    /** While this thread waits for the lock, the thread that holds it frees it (or does what `meanwhile` does) */
    const whileWaiting = (meanwhile: () => void = () => Atomics.store(lock, 0, 0n)) =>
      vi.spyOn(Atomics, 'wait').mockImplementation((_lock, _index, value, timeout) => {
        waits.push([value as bigint, timeout as number]);
        meanwhile();
        return 'ok';
      });

    describe('acquireWriteLock', () => {
      it('takes a free lock at once, by a lease of the time and of its thread', () => {
        const lease = acquireWriteLock(lock, 3n);
        expect({ lease, held: Atomics.load(lock, 0) }).toEqual({ lease: leaseAt(NOW, 3n), held: leaseAt(NOW, 3n) });
      });

      // Woken by the release of the lock, else once the lease would be stale
      it.each`
        age                         | timeout
        ${200}                      | ${WRITE_LOCK_STALE_MS - 199}
        ${WRITE_LOCK_STALE_MS}      | ${1}
        ${0}                        | ${WRITE_LOCK_STALE_MS + 1}
        ${-5 * WRITE_LOCK_STALE_MS} | ${WRITE_LOCK_STALE_MS + 1}
      `('waits $timeout ms at most for a lock another thread renewed $age ms ago, then takes it once freed', ({ age, timeout }) => {
        const held = leaseAt(NOW - age, 5n);
        Atomics.store(lock, 0, held);
        whileWaiting();
        const lease = acquireWriteLock(lock, 3n);
        expect({ lease, waits }).toEqual({ lease: leaseAt(NOW, 3n), waits: [[held, timeout]] });
      });

      it('waits again for a lock its holder renewed while this thread waited', () => {
        const held = leaseAt(NOW - 500, 5n);
        const renewed = leaseAt(NOW, 5n);
        Atomics.store(lock, 0, held);
        let wakeUps = 0;
        whileWaiting(() => Atomics.store(lock, 0, ++wakeUps === 1 ? renewed : 0n));
        acquireWriteLock(lock, 3n);
        expect(waits).toEqual([
          [held, WRITE_LOCK_STALE_MS - 499],
          [renewed, WRITE_LOCK_STALE_MS + 1],
        ]);
      });

      // Its holder was terminated while it wrote
      it('takes over at once a lock not renewed for longer than WRITE_LOCK_STALE_MS', () => {
        Atomics.store(lock, 0, leaseAt(NOW - WRITE_LOCK_STALE_MS - 1, 5n));
        const wait = whileWaiting();
        const lease = acquireWriteLock(lock, 3n);
        expect({ lease, held: Atomics.load(lock, 0), waited: wait.mock.calls.length }).toEqual({
          lease: leaseAt(NOW, 3n),
          held: leaseAt(NOW, 3n),
          waited: 0,
        });
      });

      it('waits for a stale lock another thread took over first', () => {
        const stale = leaseAt(NOW - 2 * WRITE_LOCK_STALE_MS, 5n);
        const takenOver = leaseAt(NOW, 7n);
        Atomics.store(lock, 0, stale);
        const compareExchange = Atomics.compareExchange.bind(Atomics);
        // The other thread takes the stale lock over between this thread's reading of it and its own takeover
        vi.spyOn(Atomics, 'compareExchange').mockImplementation((array, index, expected, replacement) => {
          if (expected === stale) Atomics.store(lock, 0, takenOver);
          return compareExchange(array as WriteLock, index, expected as bigint, replacement as bigint);
        });
        whileWaiting();
        acquireWriteLock(lock, 3n);
        expect(waits).toEqual([[takenOver, WRITE_LOCK_STALE_MS + 1]]);
      });
    });

    describe('renewWriteLock', () => {
      it('dates the lease it holds now', () => {
        const lease = leaseAt(NOW - 300, 3n);
        Atomics.store(lock, 0, lease);
        const renewed = renewWriteLock(lock, lease, 3n);
        expect({ renewed, held: Atomics.load(lock, 0) }).toEqual({ renewed: leaseAt(NOW, 3n), held: leaseAt(NOW, 3n) });
      });

      // Its thread was suspended longer than WRITE_LOCK_STALE_MS: the other thread wrote meanwhile, and this one waits for its turn
      it('waits for the lock again when another thread took it over', () => {
        const takenOver = leaseAt(NOW, 7n);
        Atomics.store(lock, 0, takenOver);
        whileWaiting();
        const renewed = renewWriteLock(lock, leaseAt(NOW - 2 * WRITE_LOCK_STALE_MS, 3n), 3n);
        expect({ renewed, waits }).toEqual({ renewed: leaseAt(NOW, 3n), waits: [[takenOver, WRITE_LOCK_STALE_MS + 1]] });
      });
    });

    describe('releaseWriteLock', () => {
      it('frees the lock it holds', () => {
        const lease = acquireWriteLock(lock, 3n);
        releaseWriteLock(lock, lease);
        expect(Atomics.load(lock, 0)).toBe(0n);
      });

      it('wakes the threads waiting for the lock', () => {
        const notify = vi.spyOn(Atomics, 'notify');
        releaseWriteLock(lock, acquireWriteLock(lock, 3n));
        expect(notify).toHaveBeenCalledExactlyOnceWith(lock, 0);
      });

      it('leaves a lock another thread took over to that thread', () => {
        const takenOver = leaseAt(NOW, 7n);
        Atomics.store(lock, 0, takenOver);
        releaseWriteLock(lock, leaseAt(NOW - 2 * WRITE_LOCK_STALE_MS, 3n));
        expect(Atomics.load(lock, 0)).toBe(takenOver);
      });

      it('wakes no thread for a lock another thread took over', () => {
        const notify = vi.spyOn(Atomics, 'notify');
        Atomics.store(lock, 0, leaseAt(NOW, 7n));
        releaseWriteLock(lock, leaseAt(NOW - 2 * WRITE_LOCK_STALE_MS, 3n));
        expect(notify).not.toHaveBeenCalled();
      });
    });

    describe('writeAllUnderLock', () => {
      /** The lease the lock holds at each write */
      let heldAtWrites: bigint[];
      let now: number;

      beforeEach(() => {
        heldAtWrites = [];
        now = NOW;
        // The clock moves 10 ms at each write
        vi.mocked(Date.now).mockImplementation(() => now);
        vi.mocked(writeSync as WriteSync).mockImplementation((_fd, _bytes, _offset, length) => {
          heldAtWrites.push(Atomics.load(lock, 0));
          now += 10;
          const outcome = outcomes.shift() ?? length;
          if (outcome instanceof Error) throw outcome;
          return outcome;
        });
      });

      const write = () => writeAllUnderLock(1, Buffer.from('abc'), lock, 3n);

      it('holds the lock at every write of the line, renewed at each wait for the descriptor', () => {
        outcomes = [EAGAIN, 1, EAGAIN];
        write();
        expect(heldAtWrites).toEqual([leaseAt(NOW, 3n), leaseAt(NOW + 10, 3n), leaseAt(NOW + 10, 3n), leaseAt(NOW + 30, 3n)]);
      });

      it('frees the lock once the line is written', () => {
        write();
        expect(Atomics.load(lock, 0)).toBe(0n);
      });

      it('frees the lock when a write fails', () => {
        outcomes = [EPIPE];
        try {
          write();
        } catch {
          // Thrown, as writeAll throws it
        }
        expect(Atomics.load(lock, 0)).toBe(0n);
      });

      it('throws the error of a write that fails', () => {
        outcomes = [EPIPE];
        expect(write).toThrow(EPIPE);
      });
    });
  });
});
