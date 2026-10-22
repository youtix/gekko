import { waitSync } from '@gekko/shared/utils/process/process.utils';
import { clamp } from 'lodash-es';
import { writeSync } from 'node:fs';
import {
  FIRST_RETRY_DELAY_MS,
  LONGEST_RETRY_DELAY_MS,
  RETRIED_WRITE_ERRORS,
  WRITE_LOCK_HOLDER_BITS,
  WRITE_LOCK_STALE_MS,
} from './logger.const';
import { WriteLock } from './logger.types';

/**
 * Writes to the descriptor `fd` what it takes of `bytes` without waiting, and returns how many bytes it took: all of them, unless the
 * descriptor is non-blocking and full (EAGAIN, a pipe whose reader lags) or a signal interrupted a write (EINTR), when it took part of
 * them or none. Throws the error of a write that failed otherwise (EPIPE once the reader is gone, EBADF for a closed descriptor).
 */
export const writeAvailable = (fd: number, bytes: Uint8Array): number => {
  let written = 0;
  while (written < bytes.length) {
    let taken: number;
    try {
      taken = writeSync(fd, bytes, written, bytes.length - written);
    } catch (err) {
      if (!RETRIED_WRITE_ERRORS.includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      break;
    }
    // A write that takes nothing without failing is tried again later, not at once, which would never end
    if (!(taken > 0)) break;
    written += taken;
  }
  return written;
};

/**
 * Writes every byte of `bytes` to the descriptor `fd` before it returns, in several writes when the descriptor takes them in parts (a
 * non-blocking pipe takes what fits), waiting as long as it takes none, as a write to a blocking pipe waits for its reader, and calling
 * `onWait` before each wait (the holder of a write lock renews it there). Throws the error of a write that failed otherwise.
 */
export const writeAll = (fd: number, bytes: Uint8Array, onWait?: () => void) => {
  let written = 0;
  let delay = FIRST_RETRY_DELAY_MS;
  for (;;) {
    const taken = writeAvailable(fd, bytes.subarray(written));
    written += taken;
    if (written >= bytes.length) return;
    if (taken > 0) delay = FIRST_RETRY_DELAY_MS;
    onWait?.();
    waitSync(delay);
    delay = Math.min(2 * delay, LONGEST_RETRY_DELAY_MS);
  }
};

/** The value a holder keeps in a write lock: when it took or renewed it, above the bits of its thread, never 0 (see WRITE_LOCK_HOLDERS) */
const leaseOf = (holder: bigint) => (BigInt(Date.now()) << WRITE_LOCK_HOLDER_BITS) | holder;

/** How long ago the lease was taken or renewed: below 0 once the clock was set back */
const ageOf = (lease: bigint) => Date.now() - Number(lease >> WRITE_LOCK_HOLDER_BITS);

/**
 * Takes the write lock for the thread `holder`, waiting while another thread holds it, and returns the lease it holds it by. A lease its
 * holder has not renewed for WRITE_LOCK_STALE_MS is taken over: its holder was terminated while it wrote.
 */
export const acquireWriteLock = (lock: WriteLock, holder: bigint): bigint => {
  for (;;) {
    const lease = leaseOf(holder);
    const held = Atomics.compareExchange(lock, 0, 0n, lease);
    if (held === 0n) return lease;
    const age = ageOf(held);
    if (age > WRITE_LOCK_STALE_MS) {
      if (Atomics.compareExchange(lock, 0, held, lease) === held) return lease;
    } else {
      // Woken by the release of the lock, else once the lease would be stale: renewed meanwhile, it is waited for again
      Atomics.wait(lock, 0, held, clamp(WRITE_LOCK_STALE_MS - age + 1, 1, WRITE_LOCK_STALE_MS + 1));
    }
  }
};

/**
 * Renews the lease of a holder waiting for the descriptor, so that no other thread takes the lock over meanwhile, and returns the
 * new lease. A holder whose lock was taken over all the same (its thread was suspended longer than WRITE_LOCK_STALE_MS) waits for it
 * again before it writes the rest of its line.
 */
export const renewWriteLock = (lock: WriteLock, lease: bigint, holder: bigint): bigint => {
  const renewed = leaseOf(holder);
  return Atomics.compareExchange(lock, 0, lease, renewed) === lease ? renewed : acquireWriteLock(lock, holder);
};

/** Frees the write lock held by `lease`, and wakes the threads waiting for it; a lock taken over meanwhile is left to its new holder */
export const releaseWriteLock = (lock: WriteLock, lease: bigint) => {
  if (Atomics.compareExchange(lock, 0, lease, 0n) === lease) Atomics.notify(lock, 0);
};

/**
 * Writes every byte of `bytes` to the descriptor `fd` as writeAll does, under the write lock the threads writing to it share, held
 * from the first write to the last and renewed at each wait: a line the descriptor takes in several writes (a pipe takes 4096 bytes
 * at once at most) is not cut by the line of another thread.
 */
export const writeAllUnderLock = (fd: number, bytes: Uint8Array, lock: WriteLock, holder: bigint) => {
  let lease = acquireWriteLock(lock, holder);
  try {
    writeAll(fd, bytes, () => {
      lease = renewWriteLock(lock, lease, holder);
    });
  } finally {
    releaseWriteLock(lock, lease);
  }
};
