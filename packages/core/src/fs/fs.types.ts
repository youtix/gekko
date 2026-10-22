export type LockOptions = {
  /** How many attempts after the first one (default = 3) */
  retries?: number;
  /** Milliseconds awaited between two attempts (default = 50 ms) */
  retryDelayMs?: number;
  /**
   * Age in milliseconds from which a lock file is taken over as left behind by a run that was killed while holding it
   * (default = 30 s). Taking a lock over does not count as a failed attempt.
   */
  staleMs?: number;
};

/** Takes the lock of a file, and resolves with the function that releases it */
export type Lock = (targetPath: string, options?: LockOptions) => Promise<() => void>;

/** The file system services a plugin uses, which a test replaces */
export type Fs = { lock: Lock };
