import { describe, expect, it } from 'vitest';
import { getRetryDelay } from './fetch.utils';

describe('getRetryDelay', () => {
  // The attempts are numbered from 0, the first one: it waits baseDelay after the first attempt failed
  it.each`
    attempt | baseDelay | maxDelay | expected
    ${0}    | ${1000}   | ${3000}  | ${1000}
    ${1}    | ${1000}   | ${3000}  | ${1584.9625007211562}
    ${2}    | ${1000}   | ${3000}  | ${2000}
    ${3}    | ${1000}   | ${3000}  | ${2321.928094887362}
    ${5}    | ${1000}   | ${3000}  | ${2807.354922057604}
    ${6}    | ${1000}   | ${3000}  | ${3000}
    ${10}   | ${1000}   | ${3000}  | ${3000}
    ${3}    | ${500}    | ${1500}  | ${1160.964047443681}
  `('returns $expected ms for attempt $attempt, baseDelay $baseDelay, maxDelay $maxDelay', ({ attempt, baseDelay, maxDelay, expected }) => {
    const result = getRetryDelay(attempt, baseDelay, maxDelay);
    expect(result).toBe(expected);
  });

  it('returns 1000 ms with the default delays for attempt 0, the first one', () => {
    expect(getRetryDelay(0)).toBe(1000);
  });
});
