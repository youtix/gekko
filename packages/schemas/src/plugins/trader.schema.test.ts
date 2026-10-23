import { describe, expect, it } from 'vitest';
import { traderSchema } from './trader.schema';

const name = 'Trader';
const portfolioUpdates = { threshold: 1, dust: 10 };
const withEvery = { ...portfolioUpdates, every: 5 };

describe('traderSchema', () => {
  it.each`
    scenario                                | entry
    ${'no option: every portfolio emitted'} | ${{ name }}
    ${'the portfolio update filter'}        | ${{ name, portfolioUpdates }}
  `('accepts $scenario', ({ entry }) => {
    expect(traderSchema.parse(entry)).toEqual(entry);
  });

  it.each`
    scenario                              | options                                  | path                    | keys
    ${'a misspelt portfolioUpdates'}      | ${{ portfolioUpdate: portfolioUpdates }} | ${[]}                   | ${['portfolioUpdate']}
    ${'an unknown nested option (every)'} | ${{ portfolioUpdates: withEvery }}       | ${['portfolioUpdates']} | ${['every']}
  `('refuses $scenario', ({ options, path, keys }) => {
    expect(traderSchema.safeParse({ name, ...options }).error?.issues).toMatchObject([{ code: 'unrecognized_keys', keys, path }]);
  });
});
