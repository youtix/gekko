import { waitSync } from '@gekko/shared/utils/process/process.utils';
import { writeSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LineWriter } from './lineWriter';

vi.mock('node:fs', async importOriginal => ({ ...(await importOriginal<typeof import('node:fs')>()), writeSync: vi.fn() }));
vi.mock('@gekko/shared/utils/process/process.utils', () => ({ waitSync: vi.fn() }));
// 16 bytes queued at most here, where a run queues 16 MiB: two lines of the tests fit, a third does not
vi.mock('./logger.const', async importOriginal => ({ ...(await importOriginal<typeof import('./logger.const')>()), MAX_QUEUED_BYTES: 16 }));

/** writeSync as the writer calls it: `length` bytes of `bytes` from `offset` */
type WriteSync = (fd: number, bytes: Uint8Array, offset: number, length: number) => number;

const errnoError = (code: string) => Object.assign(new Error(code), { code });
const EAGAIN = errnoError('EAGAIN');
const EPIPE = errnoError('EPIPE');

describe('LineWriter', () => {
  /** What the next writes do, in turn: take that many bytes, or throw that error. The writes after them take every byte. */
  let outcomes: (number | Error)[];
  /** The writes, each with the text it was given, its descriptor and whether the write lock was held, and the waits, in the order made */
  let events: string[];
  /** When each write was made, in ms of the fake clock */
  let writeTimes: number[];
  /** The write lock the writes are checked against, once a test gives the writer one */
  let lockView: BigInt64Array | undefined;
  let writer: LineWriter;

  /** The listener the writer added to the exit of the process, which the process.on spy captured instead of adding */
  const exitListener = () => vi.mocked(process.on).mock.calls.find(([event]) => event === 'exit')?.[1] as () => void;

  /** The error the writer emits next */
  const nextError = () => new Promise(resolve => writer.once('error', resolve));

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    outcomes = [];
    events = [];
    writeTimes = [];
    lockView = undefined;
    vi.mocked(writeSync as WriteSync).mockImplementation((fd, bytes, offset, length) => {
      const isLocked = lockView !== undefined && Atomics.load(lockView, 0) !== 0n;
      events.push(`write ${Buffer.from(bytes.subarray(offset, offset + length)).toString()} to ${fd}${isLocked ? ' under the lock' : ''}`);
      writeTimes.push(Date.now());
      const outcome = outcomes.shift() ?? length;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    vi.mocked(waitSync).mockImplementation(ms => {
      events.push(`wait ${ms} ms`);
    });
    // The writer adds a listener to the exit of the process while lines are queued: captured, so that none is left on the vitest process
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'off').mockImplementation(() => process);
    writer = new LineWriter(7);
  });

  afterEach(() => {
    writer.destroy();
    vi.useRealTimers();
  });

  describe('alone on its descriptor', () => {
    it.each`
      scenario                                        | given       | expected
      ${'at once'}                                    | ${[]}       | ${['write line 1 to 7']}
      ${'in the parts the descriptor takes'}          | ${[2]}      | ${['write line 1 to 7', 'write ne 1 to 7']}
      ${'not at all while the descriptor takes none'} | ${[EAGAIN]} | ${['write line 1 to 7']}
    `('writes a line $scenario before its write returns, without waiting', ({ given, expected }) => {
      outcomes = given;
      writer.write('line 1');
      expect(events).toEqual(expected);
    });

    it('writes what the descriptor did not take 1 ms later', () => {
      outcomes = [2, EAGAIN];
      writer.write('line 1');
      vi.advanceTimersByTime(1);
      expect(events).toEqual(['write line 1 to 7', 'write ne 1 to 7', 'write ne 1 to 7']);
    });

    it('tries again twice as late each time the descriptor takes nothing, up to 100 ms', () => {
      outcomes = Array.from({ length: 10 }, () => EAGAIN);
      writer.write('line 1');
      vi.advanceTimersByTime(1000);
      expect(writeTimes).toEqual([0, 1, 3, 7, 15, 31, 63, 127, 227, 327, 427]);
    });

    it('tries again 1 ms after an attempt at which the descriptor took part of the queue', () => {
      outcomes = [EAGAIN, EAGAIN, 2, EAGAIN];
      writer.write('line 1');
      vi.advanceTimersByTime(10);
      expect(writeTimes).toEqual([0, 1, 3, 3, 4]);
    });

    it('writes the queue as the next line comes, before that line', () => {
      outcomes = [EAGAIN];
      writer.write('line 1');
      writer.write('line 2');
      expect(events).toEqual(['write line 1 to 7', 'write line 1 to 7', 'write line 2 to 7']);
    });

    it('queues a line behind those the descriptor has not taken', () => {
      outcomes = [EAGAIN, EAGAIN];
      writer.write('line 1');
      writer.write('line 2');
      vi.advanceTimersByTime(1);
      expect(events).toEqual(['write line 1 to 7', 'write line 1 to 7', 'write line 1 to 7', 'write line 2 to 7']);
    });

    it('stops trying once the descriptor took the queue', () => {
      outcomes = [EAGAIN];
      writer.write('line 1');
      vi.advanceTimersByTime(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    // The process exits without waiting for the timer, writing the queue as it exits instead
    it('keeps no process alive for its queue', () => {
      outcomes = [EAGAIN];
      writer.write('line 1');
      expect(writer['retryTimer']?.hasRef()).toBe(false);
    });

    describe('once more than MAX_QUEUED_BYTES are queued', () => {
      beforeEach(() => {
        outcomes = [EAGAIN, EAGAIN, EAGAIN, EAGAIN];
        writer.write('line 1');
        writer.write('line 2');
        writer.write('line 3');
      });

      it('waits for the reader to take every line queued', () => {
        expect(events).toEqual([
          'write line 1 to 7',
          'write line 1 to 7',
          'write line 1 to 7',
          'write line 1 to 7',
          'wait 1 ms',
          'write line 1 to 7',
          'write line 2 to 7',
          'write line 3 to 7',
        ]);
      });

      it('stops trying the queue', () => {
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    describe('when the process exits with lines queued', () => {
      beforeEach(() => {
        outcomes = [EAGAIN, EAGAIN];
        writer.write('line 1');
        writer.write('line 2');
      });

      it('writes them as it exits, waiting for the reader as long as it takes', () => {
        outcomes = [EAGAIN, EAGAIN];
        exitListener()();
        expect(events.slice(2)).toEqual([
          'write line 1 to 7',
          'wait 1 ms',
          'write line 1 to 7',
          'wait 2 ms',
          'write line 1 to 7',
          'write line 2 to 7',
        ]);
      });

      it('listens to the exit of the process once for every line queued', () => {
        expect(vi.mocked(process.on).mock.calls.filter(([event]) => event === 'exit')).toHaveLength(1);
      });

      it('stops listening to it once the descriptor took the queue', () => {
        vi.advanceTimersByTime(1);
        expect(process.off).toHaveBeenCalledExactlyOnceWith('exit', exitListener());
      });

      // Exiting, the reader gone: nothing is left to write to, nor anyone to tell
      it('exits without a word when the reader is gone (EPIPE)', () => {
        outcomes = [EPIPE];
        expect(exitListener()).not.toThrow();
      });
    });

    describe('when a write fails', () => {
      it('emits the error of a write that fails', async () => {
        outcomes = [EPIPE];
        const emitted = nextError();
        writer.write('line 1');
        expect(await emitted).toBe(EPIPE);
      });

      it('drops what it is given once a write failed', async () => {
        outcomes = [EPIPE];
        const emitted = nextError();
        writer.write('line 1');
        await emitted;
        writer.write('line 2');
        expect(events).toEqual(['write line 1 to 7']);
      });

      it('emits the error of a later attempt at the queue that fails', async () => {
        outcomes = [EAGAIN, EPIPE];
        const emitted = nextError();
        writer.write('line 1');
        vi.advanceTimersByTime(1);
        expect(await emitted).toBe(EPIPE);
      });

      it('drops its queue once a later attempt failed', async () => {
        outcomes = [EAGAIN, EAGAIN, EPIPE];
        const emitted = nextError();
        writer.write('line 1');
        writer.write('line 2');
        vi.advanceTimersByTime(1);
        await emitted;
        vi.advanceTimersByTime(1000);
        expect(events).toEqual(['write line 1 to 7', 'write line 1 to 7', 'write line 1 to 7']);
      });

      it('stops trying once a later attempt failed', async () => {
        outcomes = [EAGAIN, EPIPE];
        const emitted = nextError();
        writer.write('line 1');
        vi.advanceTimersByTime(1);
        await emitted;
        expect(vi.getTimerCount()).toBe(0);
      });
    });
  });

  describe('sharing its descriptor with other threads', () => {
    it('shares a lock of one 64-bit value over a SharedArrayBuffer', () => {
      const lock = writer.shareLock();
      expect({ isShared: lock instanceof SharedArrayBuffer, bytes: lock.byteLength }).toEqual({ isShared: true, bytes: 8 });
    });

    it('shares the same lock at every call', () => {
      expect(writer.shareLock()).toBe(writer.shareLock());
    });

    describe('under the lock it shares', () => {
      beforeEach(() => {
        lockView = new BigInt64Array(writer.shareLock());
      });

      it.each`
        scenario                                   | given          | expected
        ${'at once'}                               | ${[]}          | ${['write line 1 to 7 under the lock']}
        ${'waiting for the descriptor to take it'} | ${[2, EAGAIN]} | ${['write line 1 to 7 under the lock', 'write ne 1 to 7 under the lock', 'wait 1 ms', 'write ne 1 to 7 under the lock']}
      `('writes a line whole under the lock, $scenario, before its write returns', ({ given, expected }) => {
        outcomes = given;
        writer.write('line 1');
        expect(events).toEqual(expected);
      });

      it('frees the lock once the line is written', () => {
        writer.write('line 1');
        expect(Atomics.load(lockView!, 0)).toBe(0n);
      });

      it('keeps nothing queued', () => {
        outcomes = [EAGAIN];
        writer.write('line 1');
        expect(vi.getTimerCount()).toBe(0);
      });

      it('emits the error of a write that fails', async () => {
        outcomes = [EPIPE];
        const emitted = nextError();
        writer.write('line 1');
        expect(await emitted).toBe(EPIPE);
      });
    });

    describe('under the lock another thread shares', () => {
      let lock: SharedArrayBuffer;

      beforeEach(() => {
        lock = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
        lockView = new BigInt64Array(lock);
      });

      it('writes each line under that lock', () => {
        writer.useLock(lock);
        writer.write('line 1');
        expect(events).toEqual(['write line 1 to 7 under the lock']);
      });

      it('writes what it queued before under that lock first, waiting for the descriptor', () => {
        outcomes = [EAGAIN, EAGAIN];
        writer.write('line 1');
        writer.useLock(lock);
        expect(events).toEqual(['write line 1 to 7', 'write line 1 to 7 under the lock', 'wait 1 ms', 'write line 1 to 7 under the lock']);
      });

      it('stops trying the queue it wrote under that lock', () => {
        outcomes = [EAGAIN];
        writer.write('line 1');
        writer.useLock(lock);
        expect({ timers: vi.getTimerCount(), stoppedListening: vi.mocked(process.off).mock.calls }).toEqual({
          timers: 0,
          stoppedListening: [['exit', exitListener()]],
        });
      });

      it('fails when what it queued cannot be written', async () => {
        outcomes = [EAGAIN, EPIPE];
        const emitted = nextError();
        writer.write('line 1');
        writer.useLock(lock);
        expect(await emitted).toBe(EPIPE);
      });
    });
  });
});
