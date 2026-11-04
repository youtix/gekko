import { ONE_SECOND } from '@gekko/shared/constants/time.const';

/**
 * The errors of a write that took nothing yet but can later. EAGAIN: the descriptor is non-blocking and full, a pipe whose reader
 * lags; Bun makes fd 1 non-blocking as soon as anything reads process.stdout, which loading winston does. EINTR: a signal interrupted
 * the write before it wrote anything.
 */
export const RETRIED_WRITE_ERRORS = ['EAGAIN', 'EINTR'];

/**
 * The wait before a write that took nothing is tried again, doubled after each such write in a row, up to the longest: a reader that
 * lags a moment empties the pipe within the first waits, and one that stalls (a pager left open) costs a wake-up every 100 ms. Polled
 * every millisecond, a stall took 4 % of a core.
 */
export const FIRST_RETRY_DELAY_MS = 1;
export const LONGEST_RETRY_DELAY_MS = 100;

/**
 * The most bytes a thread alone on its descriptor queues while the reader does not take them: beyond, it waits for the reader to take
 * them all, as a write to a full pipe waits, so that a run logging at debug level into a stalled pipe (a backtest piped to a pager left
 * open) does not hold its whole log in memory. A live bot logging at info level queues a few kilobytes an hour.
 */
export const MAX_QUEUED_BYTES = 16 * 1024 * 1024;

/**
 * How long a write lock can go without its holder renewing it before another thread takes it over: a holder renews it at every wait
 * for the descriptor, 100 ms apart at most, so one this old belongs to a thread terminated while it wrote (Fox terminates a worker
 * that failed), which would hold the others forever.
 */
export const WRITE_LOCK_STALE_MS = ONE_SECOND;

/** The low bits of a write lock's value, which hold its holder's thread; the bits above hold when the holder took or renewed it */
export const WRITE_LOCK_HOLDER_BITS = 16n;

/**
 * How many threads a write lock tells apart, each by its id modulo this count, plus 1, so that a lease is never 0, the value of a free
 * lock: Fox starts 10000 workers at most.
 */
export const WRITE_LOCK_HOLDERS = 0xffff;
