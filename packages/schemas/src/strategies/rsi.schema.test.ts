import { omit } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { rsiStrategySchema } from './rsi.schema';
import {
  AT_LEAST_ZERO,
  FRACTIONAL_NUMBER,
  INFINITE_NUMBER,
  misspeltIssues,
  missing,
  QUOTED_NUMBER,
  UNKNOWN_SOURCE,
  unknownKey,
} from './strategySchema.mock';

// The example of the guide (documentation/built-in-strategies.md), without the name that labels the run: the StrategyManager parses the
// block without it
const params = { period: 14, src: 'close', thresholds: { high: 70, low: 30, persistence: 1 } };
// The block of config/backtest.yml and of the quick start, on the mean of the four prices
const onOhlc4 = { period: 21, src: 'ohlc4', thresholds: { high: 70, low: 30, persistence: 0 } };
const withThresholds = (thresholds: Record<string, unknown>) => ({ ...params, thresholds: { ...params.thresholds, ...thresholds } });
// Unchecked, a misspelt high threshold (hight) compared the RSI with undefined: the strategy bought once and never sold
const withHight = { ...params, thresholds: { hight: 70, low: 30, persistence: 1 } };

const PERIOD_MESSAGE = 'period must be at least 2 (the RSI of a single change is 100 on a rise, and 0 on a fall or an unchanged close)';

describe('rsiStrategySchema', () => {
  // The RSI lies between 0 and 100 and the comparisons are strict: a high of 100 never sells and a low of 0 never buys, which nothing
  // refuses, as nothing checks that low is below high
  it.each`
    scenario                                                  | block                                    | expected
    ${'the example of the guide'}                             | ${params}                                | ${params}
    ${'the block of config/backtest.yml, on ohlc4'}           | ${onOhlc4}                               | ${onOhlc4}
    ${'a block without src, on the close'}                    | ${omit(onOhlc4, 'src')}                  | ${{ ...onOhlc4, src: 'close' }}
    ${'a period of 2, the smallest'}                          | ${{ ...params, period: 2 }}              | ${{ ...params, period: 2 }}
    ${'a high of 100 and a low of 0, which never trade'}      | ${withThresholds({ high: 100, low: 0 })} | ${withThresholds({ high: 100, low: 0 })}
    ${'thresholds the wrong way round, which nothing checks'} | ${withThresholds({ high: 30, low: 70 })} | ${withThresholds({ high: 30, low: 70 })}
  `('accepts $scenario', ({ block, expected }) => {
    expect(rsiStrategySchema.parse(block)).toEqual(expected);
  });

  it('refuses a misspelt high threshold (hight), naming the parameter missing and the key unknown', () => {
    expect(rsiStrategySchema.safeParse(withHight).error?.issues).toMatchObject(misspeltIssues(['thresholds', 'high'], 'hight'));
  });

  // The guide quotes this refusal under the StrategyManager's header, which names the strategy: the issues by their path, shortest first
  it('lists a misspelt high threshold (hight) as the guide quotes it', () => {
    const { error } = rsiStrategySchema.safeParse(withHight);
    expect(error && z.prettifyError(error)).toBe(
      '✖ Unrecognized key: "hight"\n  → at thresholds\n✖ Invalid input: expected number, received undefined\n  → at thresholds.high',
    );
  });

  // A period of 1 read every unchanged close, the flat candles that fill a gap included, as oversold: the strategy bought on them
  it.each`
    scenario                                                 | block                                       | path                             | message
    ${'a misspelt src (scr), not left to the close'}         | ${{ ...omit(params, 'src'), scr: 'ohlc4' }} | ${[]}                            | ${unknownKey('scr')}
    ${'an unknown source'}                                   | ${{ ...params, src: 'hcl3' }}               | ${['src']}                       | ${UNKNOWN_SOURCE}
    ${'a missing period'}                                    | ${omit(params, 'period')}                   | ${['period']}                    | ${missing('number')}
    ${'a quoted period'}                                     | ${{ ...params, period: '14' }}              | ${['period']}                    | ${QUOTED_NUMBER}
    ${'a fractional period'}                                 | ${{ ...params, period: 14.5 }}              | ${['period']}                    | ${FRACTIONAL_NUMBER}
    ${'a period of 1, which reads a flat close as oversold'} | ${{ ...params, period: 1 }}                 | ${['period']}                    | ${PERIOD_MESSAGE}
    ${'a period of 0'}                                       | ${{ ...params, period: 0 }}                 | ${['period']}                    | ${PERIOD_MESSAGE}
    ${'a missing thresholds block'}                          | ${omit(params, 'thresholds')}               | ${['thresholds']}                | ${missing('object')}
    ${'a quoted threshold'}                                  | ${withThresholds({ high: '70' })}           | ${['thresholds', 'high']}        | ${QUOTED_NUMBER}
    ${'an infinite threshold'}                               | ${withThresholds({ low: -Infinity })}       | ${['thresholds', 'low']}         | ${INFINITE_NUMBER}
    ${'a negative persistence'}                              | ${withThresholds({ persistence: -1 })}      | ${['thresholds', 'persistence']} | ${AT_LEAST_ZERO}
    ${'a fractional persistence'}                            | ${withThresholds({ persistence: 2.5 })}     | ${['thresholds', 'persistence']} | ${FRACTIONAL_NUMBER}
  `('refuses $scenario', ({ block, path, message }) => {
    expect(rsiStrategySchema.safeParse(block).error?.issues).toMatchObject([{ path, message }]);
  });
});
