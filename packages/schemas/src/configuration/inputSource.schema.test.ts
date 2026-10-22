import { INPUT_SOURCES } from '@gekko/shared/constants/inputSources.const';
import { emaRibbonStrategySchema } from '../strategies/emaRibbon.schema';
import { rsiStrategySchema } from '../strategies/rsi.schema';
import { smaCrossoverStrategySchema } from '../strategies/smaCrossover.schema';
import { tmaStrategySchema } from '../strategies/tma.schema';
import { describe, expect, it } from 'vitest';
import { inputSourceSchema } from './inputSource.schema';

// Every source an indicator reads, in the order of INPUT_SOURCES
const SOURCES = Object.keys(INPUT_SOURCES);

describe('inputSourceSchema', () => {
  it('takes the sources an indicator reads, in their order', () => {
    expect(inputSourceSchema.options).toEqual(SOURCES);
  });

  it('refuses an unknown source, listing the sources in their order', () => {
    expect(inputSourceSchema.safeParse('hcl3').error?.issues).toMatchObject([
      { code: 'invalid_value', path: [], message: 'Invalid option: expected one of "open"|"high"|"low"|"close"|"hl2"|"hlc3"|"ohlc4"' },
    ]);
  });
});

// Each of these strategies listed the sources again, checked by the compiler for names it knew but not for one missing: a source added
// to the indicators was refused by all four
describe('src parameter of the strategies', () => {
  it.each`
    strategy          | schema                        | block
    ${'RSI'}          | ${rsiStrategySchema}          | ${{ period: 14, thresholds: { high: 70, low: 30, persistence: 1 } }}
    ${'TMA'}          | ${tmaStrategySchema}          | ${{ short: 5, medium: 10, long: 20 }}
    ${'SMACrossover'} | ${smaCrossoverStrategySchema} | ${{ period: 20 }}
    ${'EMARibbon'}    | ${emaRibbonStrategySchema}    | ${{ count: 6, start: 8, step: 2, spreadCompressionThreshold: 1 }}
  `('$strategy takes every source an indicator reads', ({ schema, block }) => {
    const accepted = SOURCES.filter(src => schema.safeParse({ ...block, src }).success);
    expect(accepted).toEqual(SOURCES);
  });
});
