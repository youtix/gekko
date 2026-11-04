import { describe, expect, it } from 'vitest';
import { analyzerSchema } from './analyzer.schema';

// Shared by PortfolioAnalyzer and RoundTripAnalyzer
const name = 'RoundTripAnalyzer';
const defaults = { riskFreeReturn: 5, enableConsoleTable: false };
const custom = { riskFreeReturn: 2.5, enableConsoleTable: true };

describe('analyzerSchema', () => {
  it.each`
    scenario                          | options                      | expected
    ${'no option, with the defaults'} | ${{}}                        | ${{ name, ...defaults }}
    ${'a risk-free return of 0'}      | ${{ riskFreeReturn: 0 }}     | ${{ name, ...defaults, riskFreeReturn: 0 }}
    ${'every option'}                 | ${custom}                    | ${{ name, ...custom }}
    ${'a benchmark asset'}            | ${{ benchmarkAsset: 'ETH' }} | ${{ name, ...defaults, benchmarkAsset: 'ETH' }}
  `('accepts $scenario', ({ options, expected }) => {
    expect(analyzerSchema.parse({ name, ...options })).toEqual(expected);
  });

  it('refuses a benchmark asset that is not written in upper case, as watch.assets are', () => {
    expect(analyzerSchema.safeParse({ name, benchmarkAsset: 'eth' }).error?.issues).toMatchObject([
      { path: ['benchmarkAsset'], message: "Asset 'eth' must be written in upper-case letters and digits, as in BTC or 1INCH" },
    ]);
  });

  it('refuses a negative risk-free return', () => {
    expect(analyzerSchema.safeParse({ name, riskFreeReturn: -1 }).error?.issues).toMatchObject([
      { code: 'too_small', path: ['riskFreeReturn'] },
    ]);
  });

  it.each`
    scenario                                     | options                          | keys
    ${'a misspelt option (riskFreeRate)'}        | ${{ riskFreeRate: 0 }}           | ${['riskFreeRate']}
    ${'a misspelt option (enableConsoleTables)'} | ${{ enableConsoleTables: true }} | ${['enableConsoleTables']}
    ${'a misspelt option (benchmarkAssets)'}     | ${{ benchmarkAssets: 'BTC' }}    | ${['benchmarkAssets']}
  `('refuses $scenario', ({ options, keys }) => {
    expect(analyzerSchema.safeParse({ name, ...options }).error?.issues).toMatchObject([{ code: 'unrecognized_keys', keys, path: [] }]);
  });
});
