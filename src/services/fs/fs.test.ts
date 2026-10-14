import { ONE_MINUTE, ONE_SECOND } from '@constants/time.const';
import { waitSync } from '@utils/process/process.utils';
import { existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockSync } from './fs.service';
import { LockSyncOptions } from './fs.types';

// The locks are real files in a temporary directory. openSync is a spy that calls the real function, so that a test can make
// one attempt meet what another run did just before it.
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

vi.mock('@utils/process/process.utils', () => ({
  waitSync: vi.fn(),
}));

const HOUR = 60 * ONE_MINUTE;

const errnoError = (code: string) => Object.assign(new Error(code), { code });

describe('lockSync', () => {
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

  /** The outcome of one call, so that a test can expect it whether the call throws or not. */
  const tryLock = (options?: LockSyncOptions) => {
    try {
      lockSync(target, options);
      return 'acquired';
    } catch {
      return 'refused';
    }
  };

  /** Who holds the lock: lockSync leaves its lock file empty. */
  const lockOwner = () => readFileSync(lockFile, 'utf8') || 'lockSync';

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
    it('should create the lock file', () => {
      lockSync(target);
      expect(existsSync(lockFile)).toBe(true);
    });

    it('should acquire the lock without waiting', () => {
      lockSync(target);
      expect(waitSync).not.toHaveBeenCalled();
    });

    it('should remove the lock file on release', () => {
      const release = lockSync(target);
      release();
      expect(existsSync(lockFile)).toBe(false);
    });

    it('should ignore a lock file that is already gone on release', () => {
      const release = lockSync(target);
      rmSync(lockFile);
      expect(release).not.toThrow();
    });

    it('should throw the error met when the lock file cannot be created', () => {
      expect(() => lockSync(path.join(dir, 'missing', 'reports.csv'))).toThrow(/ENOENT/);
    });
  });

  describe('when another run holds the lock', () => {
    beforeEach(() => {
      leaveLock(0);
    });

    it('should acquire the lock once the other run has released it', () => {
      vi.mocked(waitSync).mockImplementationOnce(() => rmSync(lockFile));
      expect(tryLock({ retries: 1 })).toBe('acquired');
    });

    it.each`
      retryDelayMs | delay
      ${undefined} | ${50}
      ${20}        | ${20}
    `('should wait $delay ms between attempts when retryDelayMs is $retryDelayMs', ({ retryDelayMs, delay }) => {
      tryLock({ retryDelayMs });
      expect(waitSync).toHaveBeenCalledWith(delay);
    });

    it.each`
      retries      | attempts
      ${undefined} | ${4}
      ${1}         | ${2}
      ${2}         | ${3}
    `('should give up after $attempts attempt(s) when retries is $retries', ({ retries, attempts }) => {
      tryLock({ retries });
      expect(openSync).toHaveBeenCalledTimes(attempts);
    });

    it('should leave the lock of the other run in place', () => {
      tryLock();
      expect(lockOwner()).toBe('another run');
    });

    it('should throw an error naming the lock file once the attempts are exhausted', () => {
      expect(() => lockSync(target)).toThrow(
        `Could not acquire the lock of ${target} after 4 attempts: ${lockFile} is held by another run, or was left behind by a run that was killed less than 30 s ago; delete it if no other run is writing ${target}`,
      );
    });

    it('should give the age from which a lock is taken over in the error', () => {
      expect(() => lockSync(target, { staleMs: 10 * ONE_SECOND })).toThrow('killed less than 10 s ago');
    });
  });

  describe('when a run that was killed left its lock behind', () => {
    it.each`
      age   | staleMs
      ${31} | ${undefined}
      ${11} | ${10 * ONE_SECOND}
    `('should take over, at the first attempt, a lock $age s old when staleMs is $staleMs', ({ age, staleMs }) => {
      leaveLock(age * ONE_SECOND);
      expect(tryLock({ retries: 0, staleMs })).toBe('acquired');
    });

    it.each`
      age   | staleMs
      ${29} | ${undefined}
      ${9}  | ${10 * ONE_SECOND}
    `('should not take over a lock $age s old when staleMs is $staleMs', ({ age, staleMs }) => {
      leaveLock(age * ONE_SECOND);
      expect(tryLock({ retries: 0, staleMs })).toBe('refused');
    });

    describe('for longer than staleMs', () => {
      beforeEach(() => {
        leaveLock(HOUR, 'killed run');
      });

      it('should acquire the lock without waiting', () => {
        tryLock();
        expect(waitSync).not.toHaveBeenCalled();
      });

      it('should replace the lock by its own', () => {
        tryLock();
        expect(lockOwner()).toBe('lockSync');
      });

      it('should leave no other file behind', () => {
        tryLock();
        expect(readdirSync(dir)).toEqual(['reports.csv.lock']);
      });

      it('should remove its own lock on release', () => {
        const release = lockSync(target);
        release();
        expect(readdirSync(dir)).toEqual([]);
      });

      it('should throw an error other than ENOENT met while taking the lock over', async () => {
        const denied = errnoError('EACCES');
        await onTakingTheGuard(() => {
          throw denied;
        });
        expect(() => lockSync(target)).toThrow(denied);
      });
    });
  });

  describe('when another run is taking the same stale lock over', () => {
    beforeEach(() => {
      leaveLock(HOUR, 'killed run');
      leaveFile(guardFile, 0, 'other run');
    });

    it('should leave the guard of the other run in place', () => {
      tryLock({ retries: 0 });
      expect(existsSync(guardFile)).toBe(true);
    });

    it('should acquire the lock at the next attempt once the other run is done', () => {
      vi.mocked(waitSync).mockImplementationOnce(() => {
        rmSync(guardFile);
        rmSync(lockFile);
      });
      expect(tryLock({ retries: 1 })).toBe('acquired');
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

      it('should leave the lock of the other run in place', () => {
        tryLock({ retries: 0 });
        expect(lockOwner()).toBe('other run');
      });

      it('should not acquire the lock', () => {
        expect(tryLock({ retries: 0 })).toBe('refused');
      });

      it('should release the guard', () => {
        tryLock({ retries: 0 });
        expect(readdirSync(dir)).toEqual(['reports.csv.lock']);
      });
    });

    it('should acquire the lock at the next attempt when the other run has released its own lock already', async () => {
      await onTakingTheGuard(takeTheGuard => {
        // The other run removed the stale lock under the guard, then locked, wrote and released.
        rmSync(lockFile);
        return takeTheGuard();
      });
      expect(tryLock({ retries: 1 })).toBe('acquired');
    });
  });

  describe('when a run was killed while taking a stale lock over', () => {
    beforeEach(() => {
      leaveLock(HOUR, 'killed run');
      leaveFile(guardFile, HOUR, 'killed run');
    });

    it('should acquire the lock at the next attempt', () => {
      expect(tryLock({ retries: 1 })).toBe('acquired');
    });

    it('should remove the guard it left behind', () => {
      tryLock({ retries: 1 });
      expect(readdirSync(dir)).toEqual(['reports.csv.lock']);
    });
  });

  it('should acquire the lock at the next attempt when it is released between an attempt and the check of its age', () => {
    vi.mocked(openSync).mockImplementationOnce(() => {
      throw errnoError('EEXIST');
    });
    expect(tryLock({ retries: 1 })).toBe('acquired');
  });
});
