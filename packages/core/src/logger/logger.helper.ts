import { toError } from '@gekko/shared/errors/error.helper';
import { waitSync } from '@gekko/shared/utils/process/process.utils';
import { writeSync } from 'node:fs';
import { Writable } from 'node:stream';

/**
 * The errors of a write that took nothing yet but can later. EAGAIN: the descriptor is non-blocking and full, a pipe whose reader
 * lags; Bun makes fd 1 non-blocking as soon as anything reads process.stdout, which loading winston does. EINTR: a signal interrupted
 * the write before it wrote anything.
 */
const RETRIED_WRITE_ERRORS = ['EAGAIN', 'EINTR'];

/**
 * The wait before a write that took nothing is tried again, doubled after each such write in a row, up to the longest: a reader that
 * lags a moment empties the pipe within the first waits, and one that stalls (a pager left open) costs a wake-up every 100 ms. Polled
 * every millisecond, a stall took 4 % of a core.
 */
const FIRST_RETRY_DELAY_MS = 1;
const LONGEST_RETRY_DELAY_MS = 100;

/**
 * Writes every byte of `bytes` to the descriptor `fd` before it returns: in several writes when the descriptor takes them in parts (a
 * non-blocking pipe takes what fits), waiting as long as it takes none, as a write to a blocking pipe waits for its reader. Throws the
 * error of a write that failed otherwise (EPIPE once the reader is gone, EBADF for a closed descriptor).
 */
export const writeAll = (fd: number, bytes: Uint8Array) => {
  let written = 0;
  let delay = FIRST_RETRY_DELAY_MS;
  while (written < bytes.length) {
    try {
      written += writeSync(fd, bytes, written, bytes.length - written);
      delay = FIRST_RETRY_DELAY_MS;
    } catch (err) {
      if (!RETRIED_WRITE_ERRORS.includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      waitSync(delay);
      delay = Math.min(2 * delay, LONGEST_RETRY_DELAY_MS);
    }
  }
};

/**
 * A stream that writes each chunk to the descriptor `fd` before its write returns (writeAll), for winston's Stream transport: a line
 * logged right before a process.exit() is out of the process by then. process.stdout queues what a pipe does not take at once under
 * Bun, and the exit dropped it. A write that fails fails the stream, which emits its error, an uncaught exception unless a listener
 * takes it, as process.stdout emitted EPIPE, and drops whatever it is given from then on.
 */
export const createSyncWriteStream = (fd: number) =>
  new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      let failure: Error | undefined;
      try {
        writeAll(fd, chunk);
      } catch (err) {
        failure = toError(err);
      }
      callback(failure);
    },
  });
