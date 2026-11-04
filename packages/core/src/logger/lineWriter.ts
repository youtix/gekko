import { toError } from '@gekko/shared/errors/error.helper';
import { Writable } from 'node:stream';
import { threadId } from 'node:worker_threads';
import { FIRST_RETRY_DELAY_MS, LONGEST_RETRY_DELAY_MS, MAX_QUEUED_BYTES, WRITE_LOCK_HOLDERS } from './logger.const';
import { writeAll, writeAllUnderLock, writeAvailable } from './logger.helper';
import { WriteLock } from './logger.types';

/**
 * The stream winston's Stream transport hands the lines of a thread to, each written whole to the descriptor `fd` (stdout), in order.
 *
 * A thread alone on the descriptor (the bot) writes what the descriptor takes at once and queues the rest, which it writes as the
 * reader makes room: at its next line, and on a timer of its own, 1 ms later, then twice as late each time the descriptor takes
 * nothing, up to 100 ms. Its event loop runs meanwhile: waiting for a reader that stalled (a pager left open, a log driver whose backend
 * is down) held the Heart, the order polls and the signal handlers, and failed a live run once the reader resumed more than 3 minutes
 * later. What is queued as the process exits is written then (its 'exit' event), waiting for the reader as long as it takes, so that a
 * process.exit() loses no line; and once MAX_QUEUED_BYTES are queued, the thread waits for the reader to take them all.
 *
 * Threads sharing the descriptor (Fox's main thread and its workers) write under a lock they share (shareLock, useLock), each line
 * whole before the call that logs it returns, waiting for the reader as long as it takes: a line a pipe takes in several writes (above
 * 4096 bytes) is not cut by another thread's, and a worker keeps nothing queued, which its backtest would leave no turn to a timer to
 * write, and which Fox would lose as it terminates the worker once its outcome is in.
 *
 * A write that fails otherwise (EPIPE once the reader is gone) fails the stream, which emits its error, an uncaught exception unless a
 * listener takes it, as process.stdout emitted EPIPE, and drops whatever it is given from then on.
 */
export class LineWriter extends Writable {
  private readonly fd: number;
  /** The lines the descriptor has not taken yet, oldest first, the first possibly in part */
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  /** The next attempt at the queue, while lines are queued */
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** Whether the queue is written as the process exits, as it is while lines are queued */
  private isWrittenOnExit = false;
  /** The lock of the threads sharing the descriptor, once this thread writes under it */
  private lock?: WriteLock;
  /** This thread, as the lock tells it from the others: never 0, the value of a free lock */
  private readonly holder = BigInt((threadId % WRITE_LOCK_HOLDERS) + 1);

  constructor(fd: number) {
    super();
    this.fd = fd;
  }

  public _write(chunk: Uint8Array, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    let failure: Error | undefined;
    try {
      if (this.lock) writeAllUnderLock(this.fd, chunk, this.lock, this.holder);
      else this.enqueue(chunk);
    } catch (err) {
      failure = toError(err);
    }
    callback(failure);
  }

  public _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.stopRetrying();
    this.queue.length = 0;
    this.queuedBytes = 0;
    callback(error);
  }

  /**
   * The lock under which this thread writes from now on, created at the first call, for the threads it starts that write to the same
   * descriptor (useLock): Fox's main thread hands it to each worker.
   */
  public shareLock(): SharedArrayBuffer {
    const lock = this.lock?.buffer ?? new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
    if (!this.lock) this.useLock(lock);
    return lock;
  }

  /** Writes under the lock another thread shares from now on (a worker of Fox under its main thread's), what it queued first */
  public useLock(lock: SharedArrayBuffer): void {
    this.lock = new BigInt64Array(lock);
    try {
      this.writeQueue();
    } catch (err) {
      this.destroy(toError(err));
    }
  }

  /** Queues the line behind those the descriptor has not taken yet, then writes what the descriptor takes */
  private enqueue(line: Uint8Array) {
    this.queue.push(line);
    this.queuedBytes += line.length;
    this.writeQueueWithoutWaiting();
    if (this.queuedBytes > MAX_QUEUED_BYTES) this.writeQueue();
    else if (this.queue.length) this.retryLater(FIRST_RETRY_DELAY_MS);
  }

  /** Writes what the descriptor takes of the queue without waiting, oldest first, and says whether it took anything */
  private writeQueueWithoutWaiting(): boolean {
    const queuedBefore = this.queuedBytes;
    while (this.queue.length) {
      const [line] = this.queue;
      const taken = writeAvailable(this.fd, line);
      this.queuedBytes -= taken;
      if (taken < line.length) {
        this.queue[0] = line.subarray(taken);
        break;
      }
      this.queue.shift();
    }
    if (!this.queue.length) this.stopRetrying();
    return this.queuedBytes < queuedBefore;
  }

  /** Writes the whole queue before it returns, waiting for the reader as long as it takes, under the lock once this thread has one */
  private writeQueue() {
    while (this.queue.length) {
      const [line] = this.queue;
      if (this.lock) writeAllUnderLock(this.fd, line, this.lock, this.holder);
      else writeAll(this.fd, line);
      this.queue.shift();
      this.queuedBytes -= line.length;
    }
    this.stopRetrying();
  }

  /** Tries the queue again in `delayMs`, unless an attempt is due already, and writes it as the process exits meanwhile */
  private retryLater(delayMs: number) {
    if (!this.isWrittenOnExit) {
      process.on('exit', this.writeQueueOnExit);
      this.isWrittenOnExit = true;
    }
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => this.retry(delayMs), delayMs);
    // The process exits without waiting for it, writing the queue as it exits instead
    this.retryTimer.unref();
  }

  private retry(delayMs: number) {
    this.retryTimer = undefined;
    let tookAny: boolean;
    try {
      tookAny = this.writeQueueWithoutWaiting();
    } catch (err) {
      this.destroy(toError(err));
      return;
    }
    if (this.queue.length) this.retryLater(tookAny ? FIRST_RETRY_DELAY_MS : Math.min(2 * delayMs, LONGEST_RETRY_DELAY_MS));
  }

  private stopRetrying() {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (!this.isWrittenOnExit) return;
    process.off('exit', this.writeQueueOnExit);
    this.isWrittenOnExit = false;
  }

  /** A property, so that the listener added and the one removed are the same function */
  private readonly writeQueueOnExit = () => {
    try {
      this.writeQueue();
    } catch {
      // The process is exiting, its reader gone (EPIPE): nothing is left to write to, nor anyone to tell
    }
  };
}
