export interface LockSyncOptions {
  /** How many retries after the initial attempt (default = 3) */
  retries?: number;
  /** Milliseconds to sleep between attempts (default = 50 ms) */
  retryDelayMs?: number;
  /**
   * Age in milliseconds from which a lock file is taken over as left behind by a run that was killed while holding it
   * (default = 30 s). Taking a lock over does not count as a failed attempt.
   */
  staleMs?: number;
}
export type LockSync = (targetPath: string, options?: LockSyncOptions) => () => void;

export type Fs = { lockSync: LockSync };
