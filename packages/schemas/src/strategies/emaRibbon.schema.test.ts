import { omit } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { emaRibbonStrategySchema } from './emaRibbon.schema';
import {
  ABOVE_ZERO,
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
const params = { src: 'close', count: 8, start: 10, step: 5, spreadCompressionThreshold: 500 };

const COUNT_MESSAGE = 'count must be at least 2 (the spread of a single EMA is always 0)';

describe('emaRibbonStrategySchema', () => {
  // The guide's threshold scales with the price: at 0 or below the strategy never buys, a spread never being below it, but nothing
  // refuses it
  it.each`
    scenario                                                | block                                           | expected
    ${'the example of the guide'}                           | ${params}                                       | ${params}
    ${'a block without src, on the close'}                  | ${omit(params, 'src')}                          | ${params}
    ${'a source of the indicator besides the close (hlc3)'} | ${{ ...params, src: 'hlc3' }}                   | ${{ ...params, src: 'hlc3' }}
    ${'the smallest ribbon: 2 EMAs, of periods 1 and 2'}    | ${{ ...params, count: 2, start: 1, step: 1 }}   | ${{ ...params, count: 2, start: 1, step: 1 }}
    ${'a threshold of 0, under which no spread is'}         | ${{ ...params, spreadCompressionThreshold: 0 }} | ${{ ...params, spreadCompressionThreshold: 0 }}
  `('accepts $scenario', ({ block, expected }) => {
    expect(emaRibbonStrategySchema.parse(block)).toEqual(expected);
  });

  it('refuses a misspelt spreadCompressionThreshold (spreadCompresionThreshold), naming both keys', () => {
    const { spreadCompressionThreshold: spreadCompresionThreshold, ...ribbon } = params;
    expect(emaRibbonStrategySchema.safeParse({ ...ribbon, spreadCompresionThreshold }).error?.issues).toMatchObject(
      misspeltIssues(['spreadCompressionThreshold'], 'spreadCompresionThreshold'),
    );
  });

  // A fractional step gave fractional periods, whose EMA never seeded, and a step of 0 EMAs of the same period, whose spread is always 0
  it.each`
    scenario                                            | block                                                  | path                              | message
    ${'a misspelt src (source), not left to the close'} | ${{ ...omit(params, 'src'), source: 'hl2' }}           | ${[]}                             | ${unknownKey('source')}
    ${'an unknown source'}                              | ${{ ...params, src: 'median' }}                        | ${['src']}                        | ${UNKNOWN_SOURCE}
    ${'a source in capitals'}                           | ${{ ...params, src: 'CLOSE' }}                         | ${['src']}                        | ${UNKNOWN_SOURCE}
    ${'a missing count'}                                | ${omit(params, 'count')}                               | ${['count']}                      | ${missing('number')}
    ${'a quoted count'}                                 | ${{ ...params, count: '8' }}                           | ${['count']}                      | ${QUOTED_NUMBER}
    ${'a fractional count'}                             | ${{ ...params, count: 7.5 }}                           | ${['count']}                      | ${FRACTIONAL_NUMBER}
    ${'a count of 1, whose spread is always 0'}         | ${{ ...params, count: 1 }}                             | ${['count']}                      | ${COUNT_MESSAGE}
    ${'a count of 0'}                                   | ${{ ...params, count: 0 }}                             | ${['count']}                      | ${COUNT_MESSAGE}
    ${'a fractional start'}                             | ${{ ...params, start: 10.5 }}                          | ${['start']}                      | ${FRACTIONAL_NUMBER}
    ${'a start of 0'}                                   | ${{ ...params, start: 0 }}                             | ${['start']}                      | ${ABOVE_ZERO}
    ${'a fractional step'}                              | ${{ ...params, step: 1.5 }}                            | ${['step']}                       | ${FRACTIONAL_NUMBER}
    ${'a step of 0'}                                    | ${{ ...params, step: 0 }}                              | ${['step']}                       | ${ABOVE_ZERO}
    ${'a negative step'}                                | ${{ ...params, step: -5 }}                             | ${['step']}                       | ${ABOVE_ZERO}
    ${'a quoted threshold'}                             | ${{ ...params, spreadCompressionThreshold: '500' }}    | ${['spreadCompressionThreshold']} | ${QUOTED_NUMBER}
    ${'an infinite threshold'}                          | ${{ ...params, spreadCompressionThreshold: Infinity }} | ${['spreadCompressionThreshold']} | ${INFINITE_NUMBER}
  `('refuses $scenario', ({ block, path, message }) => {
    expect(emaRibbonStrategySchema.safeParse(block).error?.issues).toMatchObject([{ path, message }]);
  });
});
