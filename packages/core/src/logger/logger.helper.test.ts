import { waitSync } from '@gekko/shared/utils/process/process.utils';
import { writeSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncWriteStream, writeAll } from './logger.helper';

vi.mock('node:fs', async importOriginal => ({ ...(await importOriginal<typeof import('node:fs')>()), writeSync: vi.fn() }));
vi.mock('@gekko/shared/utils/process/process.utils', () => ({ waitSync: vi.fn() }));

/** writeSync as writeAll calls it: `length` bytes of `bytes` from `offset` */
type WriteSync = (fd: number, bytes: Uint8Array, offset: number, length: number) => number;

const errnoError = (code: string) => Object.assign(new Error(code), { code });
const EAGAIN = errnoError('EAGAIN');
const EINTR = errnoError('EINTR');
const EPIPE = errnoError('EPIPE');

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

  describe('writeAll', () => {
    const write = () => writeAll(1, Buffer.from('abc'));

    it.each`
      scenario                                               | given                          | expected
      ${'at once'}                                           | ${[]}                          | ${['write abc to 1']}
      ${'in the parts the descriptor takes'}                 | ${[1, 1]}                      | ${['write abc to 1', 'write bc to 1', 'write c to 1']}
      ${'once the descriptor is no longer full (EAGAIN)'}    | ${[EAGAIN]}                    | ${['write abc to 1', 'wait 1 ms', 'write abc to 1']}
      ${'after a signal interrupted a write (EINTR)'}        | ${[EINTR]}                     | ${['write abc to 1', 'wait 1 ms', 'write abc to 1']}
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

    it.each`
      failure                        | description
      ${EPIPE}                       | ${'EPIPE'}
      ${errnoError('EBADF')}         | ${'EBADF'}
      ${new Error('without a code')} | ${'an error without a code'}
    `('throws the error of a write that fails otherwise: $description', ({ failure }) => {
      outcomes = [failure];
      expect(write).toThrow(failure);
    });

    it('does not write again after a write that fails otherwise', () => {
      outcomes = [EPIPE];
      try {
        write();
      } catch {
        // Thrown, as the rows above expect
      }
      expect(events).toEqual(['write abc to 1']);
    });
  });

  describe('createSyncWriteStream', () => {
    it('writes each chunk to its descriptor before its write returns', () => {
      const stream = createSyncWriteStream(7);
      stream.write('line 1');
      stream.write('line 2');
      expect(events).toEqual(['write line 1 to 7', 'write line 2 to 7']);
    });

    it('writes a chunk as writeAll does, in the parts its descriptor takes and once it is no longer full', () => {
      outcomes = [EAGAIN, 2];
      createSyncWriteStream(7).write('line 1');
      expect(events).toEqual(['write line 1 to 7', 'wait 1 ms', 'write line 1 to 7', 'write ne 1 to 7']);
    });

    it('emits the error of a write that fails', async () => {
      outcomes = [EPIPE];
      const stream = createSyncWriteStream(7);
      const emitted = new Promise(resolve => stream.once('error', resolve));
      stream.write('line 1');
      expect(await emitted).toBe(EPIPE);
    });

    it('drops what it is given once a write failed', async () => {
      outcomes = [EPIPE];
      const stream = createSyncWriteStream(7);
      const emitted = new Promise(resolve => stream.once('error', resolve));
      stream.write('line 1');
      await emitted;
      stream.write('line 2');
      expect(events).toEqual(['write line 1 to 7']);
    });
  });
});
