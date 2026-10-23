import { describe, expect, it } from 'vitest';
import { tradingAdvisorSchema } from './tradingAdvisor.schema';

const entry = { name: 'TradingAdvisor', strategyName: 'DEMA' };
const allOptions = { strategyPath: './my.strategy.ts', maxConsecutiveErrors: -1 };
const MAX_CONSECUTIVE_ERRORS_MESSAGE = 'maxConsecutiveErrors must be an integer of at least 1, or -1 to disable the circuit breaker';

describe('tradingAdvisorSchema', () => {
  it.each`
    scenario                                        | options       | expected
    ${'the required options, with the default 5'}   | ${{}}         | ${{ ...entry, maxConsecutiveErrors: 5 }}
    ${'every option, the circuit breaker disabled'} | ${allOptions} | ${{ ...entry, ...allOptions }}
  `('accepts $scenario', ({ options, expected }) => {
    expect(tradingAdvisorSchema.parse({ ...entry, ...options })).toEqual(expected);
  });

  // A stripped option would leave its default in place: maxConsecutiveError: -1 would keep the circuit breaker at 5 errors
  it.each`
    scenario                                     | options                                            | keys
    ${'a misspelt option (maxConsecutiveError)'} | ${{ maxConsecutiveError: -1 }}                     | ${['maxConsecutiveError']}
    ${'an option of the Trader plugin'}          | ${{ portfolioUpdates: { threshold: 1, dust: 1 } }} | ${['portfolioUpdates']}
  `('refuses $scenario', ({ options, keys }) => {
    expect(tradingAdvisorSchema.safeParse({ ...entry, ...options }).error?.issues).toMatchObject([
      { code: 'unrecognized_keys', keys, path: [] },
    ]);
  });

  it.each`
    value
    ${-1}
    ${1}
    ${5}
  `('accepts a maxConsecutiveErrors of $value', ({ value }) => {
    expect(tradingAdvisorSchema.parse({ ...entry, maxConsecutiveErrors: value }).maxConsecutiveErrors).toBe(value);
  });

  // 0 passed and stopped the run at the first errored order, as 1 does, where a user may have meant "never" (-1)
  it.each`
    value
    ${0}
    ${-2}
    ${1.5}
    ${'5'}
  `('refuses a maxConsecutiveErrors of $value, naming the values allowed', ({ value }) => {
    expect(tradingAdvisorSchema.safeParse({ ...entry, maxConsecutiveErrors: value }).error?.issues).toMatchObject([
      { path: ['maxConsecutiveErrors'], message: MAX_CONSECUTIVE_ERRORS_MESSAGE },
    ]);
  });
});
