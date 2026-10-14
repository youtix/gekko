import { ONE_SECOND } from '@constants/time.const';
import { waitSync } from '@utils/process/process.utils';
import { closeSync, constants, openSync, statSync, unlinkSync } from 'fs';
import { LockSync } from './fs.types';

/**
 * The critical sections last milliseconds and the retries a few hundred more: a lock older than this belongs to a run that is
 * gone. Only a run whose machine slept (or whose clock jumped) for longer inside its critical section is taken for one, and
 * what the lock protects, an append, is small.
 */
const DEFAULT_STALE_MS = 30 * ONE_SECOND;

const getLockFileName = (targetPath: string): string => `${targetPath}.lock`;

const tryAcquire = (lockFile: string) => {
  try {
    const fd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
};

/**
 * Removes the lock file if it is older than `staleMs`, and says whether it did: such a lock was left behind by a run killed
 * inside its critical section (kill -9, Ctrl-C at that instant, a crash), and nothing else would ever remove it.
 *
 * Several runs can find the same stale lock. Were each to remove it, one could remove it and lock again before another removed
 * that new lock, taking it for the stale one: both runs would then hold the lock. Renaming the stale lock away before deleting
 * it does not help, as the rename can move the new lock just as well. So a stale lock is only removed by the holder of a
 * second lock, the guard, after checking its age again: from then on only the run that left it, which is gone, or the holder
 * of the guard could remove it, so no new lock can take its place before it is removed. The guard is held for microseconds,
 * so one older than `staleMs` was left by a run killed while holding it, and is simply removed (two runs doing so at the same
 * instant could both take the guard, but that takes such a kill first). ENOENT at any step means that another run got there
 * first, or that the lock was released: the attempt failed, and the next one will tell.
 */
const removeStaleLock = (lockFile: string, staleMs: number) => {
  const isStale = (file: string) => Date.now() - statSync(file).mtimeMs > staleMs;
  const guardFile = `${lockFile}.takeover`;
  try {
    if (!isStale(lockFile)) return false;
    if (!tryAcquire(guardFile)) {
      if (isStale(guardFile)) unlinkSync(guardFile);
      return false;
    }
    try {
      if (!isStale(lockFile)) return false;
      unlinkSync(lockFile);
      return true;
    } finally {
      unlinkSync(guardFile);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
};

export const lockSync: LockSync = (targetPath, { retries = 3, retryDelayMs = 50, staleMs = DEFAULT_STALE_MS } = {}) => {
  const lockFile = getLockFileName(targetPath);
  let failedAttempts = 0;
  while (!tryAcquire(lockFile)) {
    // Taking a stale lock over is not a failed attempt: the next one follows at once.
    if (removeStaleLock(lockFile, staleMs)) continue;
    if (++failedAttempts > retries) {
      throw new Error(
        `Could not acquire the lock of ${targetPath} after ${failedAttempts} attempts: ${lockFile} is held by another run, or was left behind by a run that was killed less than ${staleMs / ONE_SECOND} s ago; delete it if no other run is writing ${targetPath}`,
      );
    }
    waitSync(retryDelayMs);
  }

  return () => {
    try {
      unlinkSync(lockFile);
    } catch {
      /* ignore */
    }
  };
};
