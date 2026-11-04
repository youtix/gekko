import { ONE_MINUTE, ONE_SECOND } from '@gekko/shared/constants/time.const';
import { wait } from '@gekko/shared/utils/process/process.utils';
import { existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lock } from './fs.service';
import { LockOptions } from './fs.types';

// The locks are real files in a temporary directory. openSync is a spy that calls the real function, so that a test can make
// one attempt meet what another run did just before it.
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

vi.mock('@gekko/shared/utils/process/process.utils', () => ({
  wait: vi.fn(),
}));

const HOUR = 60 * ONE_MINUTE;

const errnoError = (code: string) => Object.assign(new Error(code), { code });

describe('lock', () => {
  let dir: string;
  let target: string;
  let lockFile: string;
  let guardFile: string;

  /** A file created `ageMs` ago by `owner`, who writes its name in it so that a test can tell it from a file created later. */
  const leaveFile = (file: string, ageMs: number, owner: string) => {
    writeFileSync(file, owner);
    const createdAt = (Date.now() - ageMs) / ONE_SECOND;
    utimesSync(file, createdAt, createdAt);
  };

  const leaveLock = (ageMs: number, owner = 'another run') => leaveFile(lockFile, ageMs, owner);

  /** The outcome of one call, so that a test can expect it whether the call rejects or not. */
  const tryLock = async (options?: LockOptions) => {
    try {
      await lock(target, options);
      return 'acquired';
    } catch {
      return 'refused';
    }
  };

  /** Who holds the lock: lock leaves its lock file empty. */
  const lockOwner = () => readFileSync(lockFile, 'utf8') || 'lock';

  /** Runs `instead` in place of the first attempt to take the guard, which `takeTheGuard` makes, as another run acts in between. */
  const onTakingTheGuard = async (instead: (takeTheGuard: () => number) => number) => {
    const { openSync: realOpenSync } = await vi.importActual<typeof import('fs')>('fs');
    vi.mocked(openSync)
      .mockImplementationOnce(realOpenSync)
      .mockImplementationOnce((file, flags, mode) => instead(() => realOpenSync(file, flags, mode)));
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'gekko-lock-'));
    target = path.join(dir, 'reports.csv');
    lockFile = `${target}.lock`;
    guardFile = `${lockFile}.takeover`;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('when the file is not locked', () => {
    it('should create the lock file', async () => {
      await lock(target);
      expect(existsSync(lockFile)).toBe(true);
    });

    it('should acquire the lock without waiting', async () => {
      await lock(target);
      expect(wait).not.toHaveBeenCalled();
    });

    it('should remove the lock file on release', async () => {
      const release = await lock(target);
      release();
      expect(existsSync(lockFile)).toBe(false);
    });

    it('should ignore a lock file that is already gone on release', async () => {
      const release = await lock(target);
      rmSync(lockFile);
      expect(release).not.toThrow();
    });

    it('should reject with the error met when the lock file cannot be created', async () => {
      await expect(lock(path.join(dir, 'missing', 'reports.csv'))).rejects.toThrow(/ENOENT/);
    });
  });

  describe('when another run holds the lock', () => {
    beforeEach(() => {
      leaveLock(0);
    });

    it('should acquire the lock once the other run has released it', async () => {
      vi.mocked(wait).mockImplementationOnce(async () => rmSync(lockFile));
      expect(await tryLock({ retries: 1 })).toBe('acquired');
    });

    it.each`
      retryDelayMs | delay
      ${undefined} | ${50}
      ${20}        | ${20}
    `('should wait $delay ms between attempts when retryDelayMs is $retryDelayMs', async ({ retryDelayMs, delay }) => {
      await tryLock({ retryDelayMs });
      expect(wait).toHaveBeenCalledWith(delay);
    });

    // Awaited, not waited for with Atomics.wait: the thread runs what falls due meanwhile, the bot's signal handlers among them
    it('should return to its caller while it waits for the next attempt', async () => {
      vi.mocked(wait).mockReturnValueOnce(new Promise(() => {}));
      const outcome = await Promise.race([lock(target).then(() => 'settled'), Promise.resolve('waiting')]);
      expect(outcome).toBe('waiting');
    });

    it.each`
      retries      | attempts
      ${undefined} | ${4}
      ${1}         | ${2}
      ${2}         | ${3}
    `('should give up after $attempts attempt(s) when retries is $retries', async ({ retries, attempts }) => {
      await tryLock({ retries });
      expect(openSync).toHaveBeenCalledTimes(attempts);
    });

    it('should leave the lock of the other run in place', async () => {
      await tryLock();
      expect(lockOwner()).toBe('another run');
    });

    it('should reject with an error naming the lock file once the attempts are exhausted', async () => {
      await expect(lock(target)).rejects.toThrow(
        `Could not acquire the lock of ${target} after 4 attempts: ${lockFile} is held by another run, or was left behind by a run that was killed less than 30 s ago; delete it if no other run is writing ${target}`,
      );
    });

    it('should count a single attempt in the singular', async () => {
      await expect(lock(target, { retries: 0 })).rejects.toThrow(`Could not acquire the lock of ${target} after 1 attempt: ${lockFile}`);
    });

    it('should give the age from which a lock is taken over in the error', async () => {
      await expect(lock(target, { staleMs: 10 * ONE_SECOND })).rejects.toThrow('killed less than 10 s ago');
    });
  });

  describe('when a run that was killed left its lock behind', () => {
    it.each`
      age   | staleMs
      ${31} | ${undefined}
      ${11} | ${10 * ONE_SECOND}
    `('should take over, at the first attempt, a lock $age s old when staleMs is $staleMs', async ({ age, staleMs }) => {
      leaveLock(age * ONE_SECOND);
      expect(await tryLock({ retries: 0, staleMs })).toBe('acquired');
    });

    it.each`
      age   | staleMs
      ${29} | ${undefined}
      ${9}  | ${10 * ONE_SECOND}
    `('should not take over a lock $age s old when staleMs is $staleMs', async ({ age, staleMs }) => {
      leaveLock(age * ONE_SECOND);
      expect(await tryLock({ retries: 0, staleMs })).toBe('refused');
    });

    describe('for longer than staleMs', () => {
      beforeEach(() => {
        leaveLock(HOUR, 'killed run');
      });

      it('should acquire the lock without waiting', async () => {
        await tryLock();
        expect(wait).not.toHaveBeenCalled();
      });

      it('should replace the lock by its own', async () => {
        await tryLock();
        expect(lockOwner()).toBe('lock');
      });

      it('should leave no other file behind', async () => {
        await tryLock();
        expect(readdirSync(dir)).toEqual(['reports.csv.lock']);
      });

      it('should remove its own lock on release', async () => {
        const release = await lock(target);
        release();
        expect(readdirSync(dir)).toEqual([]);
      });

      it('should reject with an error other than ENOENT met while taking the lock over', async () => {
        const denied = errnoError('EACCES');
        await onTakingTheGuard(() => {
          throw denied;
        });
        await expect(lock(target)).rejects.toThrow(denied);
      });
    });
  });

  describe('when another run is taking the same stale lock over', () => {
    beforeEach(() => {
      leaveLock(HOUR, 'killed run');
      leaveFile(guardFile, 0, 'other run');
    });

    it('should leave the guard of the other run in place', async () => {
      await tryLock({ retries: 0 });
      expect(existsSync(guardFile)).toBe(true);
    });

    it('should acquire the lock at the next attempt once the other run is done', async () => {
      vi.mocked(wait).mockImplementationOnce(async () => {
        rmSync(guardFile);
        rmSync(lockFile);
      });
      expect(await tryLock({ retries: 1 })).toBe('acquired');
    });
  });

  describe('when another run took the same stale lock over just before this run took the guard', () => {
    beforeEach(() => {
      leaveLock(HOUR, 'killed run');
    });

    describe('and holds its own lock', () => {
      beforeEach(async () => {
        await onTakingTheGuard(takeTheGuard => {
          // The other run removed the stale lock under the guard, released the guard and locked.
          rmSync(lockFile);
          writeFileSync(lockFile, 'other run');
          return takeTheGuard();
        });
      });

      it('should leave the lock of the other run in place', async () => {
        await tryLock({ retries: 0 });
        expect(lockOwner()).toBe('other run');
      });

      it('should not acquire the lock', async () => {
        expect(await tryLock({ retries: 0 })).toBe('refused');
      });

      it('should release the guard', async () => {
        await tryLock({ retries: 0 });
        expect(readdirSync(dir)).toEqual(['reports.csv.lock']);
      });
    });

    it('should acquire the lock at the next attempt when the other run has released its own lock already', async () => {
      await onTakingTheGuard(takeTheGuard => {
        // The other run removed the stale lock under the guard, then locked, wrote and released.
        rmSync(lockFile);
        return takeTheGuard();
      });
      expect(await tryLock({ retries: 1 })).toBe('acquired');
    });
  });

  describe('when a run was killed while taking a stale lock over', () => {
    beforeEach(() => {
      leaveLock(HOUR, 'killed run');
      leaveFile(guardFile, HOUR, 'killed run');
    });

    it('should acquire the lock at the next attempt', async () => {
      expect(await tryLock({ retries: 1 })).toBe('acquired');
    });

    it('should remove the guard it left behind', async () => {
      await tryLock({ retries: 1 });
      expect(readdirSync(dir)).toEqual(['reports.csv.lock']);
    });
  });

  it('should acquire the lock at the next attempt when it is released between an attempt and the check of its age', async () => {
    vi.mocked(openSync).mockImplementationOnce(() => {
      throw errnoError('EEXIST');
    });
    expect(await tryLock({ retries: 1 })).toBe('acquired');
  });
});
