import { afterAll, beforeAll } from 'vitest';

/**
 * Runs the tests of the describe block it is called in as a host set to `timeZone` would, then puts the host's zone back. Node reads
 * TZ again whenever it is assigned, so a machine in UTC, as CI is, meets what local-time code does around a DST change: date-fns'
 * startOfMinute read the second pass of the hour repeated when DST ends an hour early, and the tests, run in UTC, could not see it.
 * The zone is the process's: a test file has its process to itself in vitest's default pool (forks), not in a pool of threads.
 */
export const useTimeZone = (timeZone: string) => {
  let hostTimeZone: string | undefined;
  beforeAll(() => {
    hostTimeZone = process.env.TZ;
    process.env.TZ = timeZone;
  });
  afterAll(() => {
    if (hostTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = hostTimeZone;
  });
};
