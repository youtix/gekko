import { describe, expect, it } from 'vitest';
import { smaCrossoverStrategySchema } from './smaCrossover.schema';
import {
  ABOVE_ZERO,
  FRACTIONAL_NUMBER,
  INFINITE_NUMBER,
  misspeltIssues,
  missing,
  NAN_NUMBER,
  QUOTED_NUMBER,
  UNKNOWN_SOURCE,
  unknownKey,
} from './strategySchema.mock';

// The example of the guide (documentation/built-in-strategies.md), without the name that labels the run: the StrategyManager parses the
// block without it
const params = { period: 20, src: 'close' };

describe('smaCrossoverStrategySchema', () => {
  // With a period of 1 on the close, the SMA is the close itself, which never crosses it: the guide says Gekko does not refuse it
  it.each`
    scenario                                                     | block                        | expected
    ${'the example of the guide'}                                | ${params}                    | ${params}
    ${'a block without src, on the close (the warmup e2e flow)'} | ${{ period: 2 }}             | ${{ period: 2, src: 'close' }}
    ${'a source of the SMA besides the close (hl2)'}             | ${{ ...params, src: 'hl2' }} | ${{ ...params, src: 'hl2' }}
    ${'a period of 1, which never trades on the close'}          | ${{ ...params, period: 1 }}  | ${{ ...params, period: 1 }}
  `('accepts $scenario', ({ block, expected }) => {
    expect(smaCrossoverStrategySchema.parse(block)).toEqual(expected);
  });

  it('refuses a misspelt period (periode), naming the parameter missing and the key unknown', () => {
    expect(smaCrossoverStrategySchema.safeParse({ periode: 20, src: 'close' }).error?.issues).toMatchObject(
      misspeltIssues(['period'], 'periode'),
    );
  });

  // Unchecked, a period of 0 or 2.5 made the SMA NaN on every candle, and the strategy never traded
  it.each`
    scenario                                            | block                                   | path          | message
    ${'a misspelt src (source), not left to the close'} | ${{ period: 20, source: 'hl2' }}        | ${[]}         | ${unknownKey('source')}
    ${'a parameter of another strategy (thresholds)'}   | ${{ ...params, thresholds: { up: 1 } }} | ${[]}         | ${unknownKey('thresholds')}
    ${'an unknown source'}                              | ${{ ...params, src: 'hl3' }}            | ${['src']}    | ${UNKNOWN_SOURCE}
    ${'a source left empty'}                            | ${{ ...params, src: null }}             | ${['src']}    | ${UNKNOWN_SOURCE}
    ${'a missing period'}                               | ${{ src: 'close' }}                     | ${['period']} | ${missing('number')}
    ${'a quoted period'}                                | ${{ ...params, period: '20' }}          | ${['period']} | ${QUOTED_NUMBER}
    ${'a fractional period'}                            | ${{ ...params, period: 2.5 }}           | ${['period']} | ${FRACTIONAL_NUMBER}
    ${'a period of 0'}                                  | ${{ ...params, period: 0 }}             | ${['period']} | ${ABOVE_ZERO}
    ${'a negative period'}                              | ${{ ...params, period: -20 }}           | ${['period']} | ${ABOVE_ZERO}
    ${'a NaN period'}                                   | ${{ ...params, period: NaN }}           | ${['period']} | ${NAN_NUMBER}
    ${'an infinite period'}                             | ${{ ...params, period: Infinity }}      | ${['period']} | ${INFINITE_NUMBER}
  `('refuses $scenario', ({ block, path, message }) => {
    expect(smaCrossoverStrategySchema.safeParse(block).error?.issues).toMatchObject([{ path, message }]);
  });
});
