/**
 * Runs async functions one at a time: the callers of runExclusive that find the lock taken wait their turn, in the order they called.
 *
 * The lock is not reentrant: a runExclusive called while it is held waits for it, even when called by the function holding it.
 * DummyCentralizedExchange relies on it: the onSettled callbacks run inside the section of processOneMinuteBucket, and the exchange calls
 * they start (the Trader reading the trades of an order that filled) run once the whole bucket is processed, not in the middle of it.
 * So a function must never await a runExclusive of its own mutex: it would wait for itself forever.
 */
export class AsyncMutex {
  /** The callers waiting for the lock, in the order they called, each resumed with its release when the lock is handed to it */
  private readonly waiters: ((release: () => void) => void)[] = [];
  private locked = false;

  /**
   * Runs `fn` holding the lock, released once `fn` has returned or thrown, or the promise it returned has settled. A free lock is taken
   * at once and `fn` starts in the caller's tick, before runExclusive returns: the simulator takes the lock for every bucket and every
   * exchange call, nearly always free, and a promise awaited for it each time took some 2 % of the CPU time of a backtest.
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = this.locked ? await new Promise<() => void>(resolve => this.waiters.push(resolve)) : this.grant();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Gives the lock to a holder, the caller finding it free or the next waiter, and returns the holder's release. A release works once:
   * called again, it does nothing, the lock left to whoever holds it. One release shared by every holder, called twice, handed the lock
   * to a second waiter while the first still ran, or freed it under its next holder. Released, the lock goes straight to the next
   * waiter, never free in between, so that a caller arriving before that waiter resumes waits behind it instead of taking it first.
   */
  private grant(): () => void {
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(this.grant());
      else this.locked = false;
    };
  }
}
