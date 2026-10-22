import { omit } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { gridBotStrategySchema } from './gridBot.schema';
import {
  ABOVE_ZERO,
  AT_LEAST_ONE,
  AT_LEAST_ZERO,
  FRACTIONAL_NUMBER,
  INFINITE_NUMBER,
  misspeltIssues,
  missing,
  NAN_NUMBER,
  QUOTED_NUMBER,
  unknownKey,
} from './strategySchema.mock';

// The first example of the guide (documentation/built-in-strategies.md), without the name that labels the run: the StrategyManager
// parses the block without it
const block = { buyLevels: 5, sellLevels: 5, spacingType: 'percent', spacingValue: 1, retryOnError: 3 };
// The defaults of the guide's table, which the strategy gets for the keys a block leaves out
const DEFAULTS = { retryOnError: 3, atrPeriod: 14, resetMode: 'none', resetConfirmCandles: 1, resetCooldownCandles: 0 };
// The second example of the guide: an atr grid reset on either side, every option given
const ATR_BOTH = {
  buyLevels: 5,
  sellLevels: 5,
  spacingType: 'atr',
  spacingValue: 1.5,
  atrPeriod: 14,
  resetMode: 'both',
  resetConfirmCandles: 2,
  resetCooldownCandles: 10,
};
// The grids of the e2e flows: the live trader's, and the fixed and atr grids the reset flow resets upwards
const LIVE_TRADER = { buyLevels: 2, sellLevels: 2, spacingType: 'percent', spacingValue: 1 };
const FIXED_UP = { buyLevels: 2, sellLevels: 2, spacingType: 'fixed', spacingValue: 5, resetMode: 'up', resetConfirmCandles: 2 };
const ATR_UP = {
  buyLevels: 2,
  sellLevels: 2,
  spacingType: 'atr',
  spacingValue: 2.5,
  atrPeriod: 1,
  resetMode: 'up',
  resetConfirmCandles: 1,
};

const NO_LEVEL = 'buyLevels and sellLevels cannot both be 0: the grid needs at least one level';
const UNKNOWN_SPACING_TYPE = 'Invalid option: expected one of "percent"|"fixed"|"logarithmic"|"atr"';
const UNKNOWN_RESET_MODE = 'Invalid option: expected one of "none"|"up"|"down"|"both"';

describe('gridBotStrategySchema', () => {
  it.each`
    scenario                                                   | params                                                           | expected
    ${'the first example of the guide'}                        | ${block}                                                         | ${{ ...DEFAULTS, ...block }}
    ${'the required parameters alone, with every default'}     | ${omit(block, 'retryOnError')}                                   | ${{ ...DEFAULTS, ...block }}
    ${'the second example of the guide, every option given'}   | ${ATR_BOTH}                                                      | ${{ ...DEFAULTS, ...ATR_BOTH }}
    ${'the grid of the live trader e2e flow'}                  | ${LIVE_TRADER}                                                   | ${{ ...DEFAULTS, ...LIVE_TRADER }}
    ${'the fixed grid of the reset e2e flow'}                  | ${FIXED_UP}                                                      | ${{ ...DEFAULTS, ...FIXED_UP }}
    ${'the atr grid of the reset e2e flow'}                    | ${ATR_UP}                                                        | ${{ ...DEFAULTS, ...ATR_UP }}
    ${'a grid of sell levels only'}                            | ${{ ...block, buyLevels: 0 }}                                    | ${{ ...DEFAULTS, ...block, buyLevels: 0 }}
    ${'a grid of buy levels only'}                             | ${{ ...block, sellLevels: 0 }}                                   | ${{ ...DEFAULTS, ...block, sellLevels: 0 }}
    ${'a logarithmic spacing, the ratio less 1'}               | ${{ ...block, spacingType: 'logarithmic', spacingValue: 0.01 }}  | ${{ ...DEFAULTS, ...block, spacingType: 'logarithmic', spacingValue: 0.01 }}
    ${'an atr spacing under 1 × the ATR'}                      | ${{ ...block, spacingType: 'atr', spacingValue: 0.25 }}          | ${{ ...DEFAULTS, ...block, spacingType: 'atr', spacingValue: 0.25 }}
    ${'a retryOnError of 1, the fewest'}                       | ${{ ...block, retryOnError: 1 }}                                 | ${{ ...DEFAULTS, ...block, retryOnError: 1 }}
    ${'an atrPeriod with a percent spacing, which ignores it'} | ${{ ...block, atrPeriod: 7 }}                                    | ${{ ...DEFAULTS, ...block, atrPeriod: 7 }}
    ${'reset options with resetMode none, which ignores them'} | ${{ ...block, resetConfirmCandles: 3, resetCooldownCandles: 5 }} | ${{ ...DEFAULTS, ...block, resetConfirmCandles: 3, resetCooldownCandles: 5 }}
    ${'resetMode down'}                                        | ${{ ...block, resetMode: 'down' }}                               | ${{ ...DEFAULTS, ...block, resetMode: 'down' }}
  `('accepts $scenario', ({ params, expected }) => {
    expect(gridBotStrategySchema.parse(params)).toEqual(expected);
  });

  // Unchecked, a misspelt buyLevel built a grid of SELLs only
  it('refuses a misspelt level count (buyLevel), naming the parameter missing and the key unknown', () => {
    expect(gridBotStrategySchema.safeParse({ ...omit(block, 'buyLevels'), buyLevel: 5 }).error?.issues).toMatchObject(
      misspeltIssues(['buyLevels'], 'buyLevel'),
    );
  });

  // Each count is compared with 0 on its own: a negative count, refused by its bound, does not read as no level at all with one level
  // on the other side, nor with none
  it.each`
    scenario                                | params                                        | path              | message
    ${'both level counts 0'}                | ${{ ...block, buyLevels: 0, sellLevels: 0 }}  | ${[]}             | ${NO_LEVEL}
    ${'-1 buy levels with 1 sell level'}    | ${{ ...block, buyLevels: -1, sellLevels: 1 }} | ${['buyLevels']}  | ${AT_LEAST_ZERO}
    ${'-1 sell levels without a buy level'} | ${{ ...block, buyLevels: 0, sellLevels: -1 }} | ${['sellLevels']} | ${AT_LEAST_ZERO}
  `('refuses $scenario in one issue', ({ params, path, message }) => {
    expect(gridBotStrategySchema.safeParse(params).error?.issues).toMatchObject([{ path, message }]);
  });

  // Each was handed to the strategy as it was: buyLevels: 2.5 placed BUYs off the prices they were sized on, and the quoted
  // logarithmic '0.01' made a multiplier of 10.01. A misspelt resetMode would leave the grid in place without a word, and an atrPeriod
  // the ATR refuses would stop the run at init, naming the indicator's period rather than the option.
  it.each`
    scenario                                    | params                                                            | path                        | message
    ${'an unknown key'}                         | ${{ ...block, levels: 5 }}                                        | ${[]}                       | ${unknownKey('levels')}
    ${'an unknown reset option (resetCandles)'} | ${{ ...block, resetCandles: 2 }}                                  | ${[]}                       | ${unknownKey('resetCandles')}
    ${'a missing level count'}                  | ${omit(block, 'sellLevels')}                                      | ${['sellLevels']}           | ${missing('number')}
    ${'a fractional level count'}               | ${{ ...block, buyLevels: 2.5 }}                                   | ${['buyLevels']}            | ${FRACTIONAL_NUMBER}
    ${'a quoted level count'}                   | ${{ ...block, buyLevels: '5' }}                                   | ${['buyLevels']}            | ${QUOTED_NUMBER}
    ${'a missing spacingType'}                  | ${omit(block, 'spacingType')}                                     | ${['spacingType']}          | ${UNKNOWN_SPACING_TYPE}
    ${'an unknown spacingType (percentage)'}    | ${{ ...block, spacingType: 'percentage' }}                        | ${['spacingType']}          | ${UNKNOWN_SPACING_TYPE}
    ${'an unknown spacingType (atrPercent)'}    | ${{ ...block, spacingType: 'atrPercent' }}                        | ${['spacingType']}          | ${UNKNOWN_SPACING_TYPE}
    ${'a missing spacingValue'}                 | ${omit(block, 'spacingValue')}                                    | ${['spacingValue']}         | ${missing('number')}
    ${'a quoted spacingValue'}                  | ${{ ...block, spacingType: 'logarithmic', spacingValue: '0.01' }} | ${['spacingValue']}         | ${QUOTED_NUMBER}
    ${'a spacingValue of 0'}                    | ${{ ...block, spacingValue: 0 }}                                  | ${['spacingValue']}         | ${ABOVE_ZERO}
    ${'a negative spacingValue'}                | ${{ ...block, spacingValue: -1 }}                                 | ${['spacingValue']}         | ${ABOVE_ZERO}
    ${'an atr spacing of 0 × the ATR'}          | ${{ ...block, spacingType: 'atr', spacingValue: 0 }}              | ${['spacingValue']}         | ${ABOVE_ZERO}
    ${'a NaN spacingValue'}                     | ${{ ...block, spacingValue: NaN }}                                | ${['spacingValue']}         | ${NAN_NUMBER}
    ${'an infinite spacingValue'}               | ${{ ...block, spacingValue: Infinity }}                           | ${['spacingValue']}         | ${INFINITE_NUMBER}
    ${'a retryOnError of 0, once raised to 1'}  | ${{ ...block, retryOnError: 0 }}                                  | ${['retryOnError']}         | ${AT_LEAST_ONE}
    ${'a fractional retryOnError'}              | ${{ ...block, retryOnError: 1.5 }}                                | ${['retryOnError']}         | ${FRACTIONAL_NUMBER}
    ${'an atrPeriod of 0'}                      | ${{ ...ATR_BOTH, atrPeriod: 0 }}                                  | ${['atrPeriod']}            | ${AT_LEAST_ONE}
    ${'a fractional atrPeriod'}                 | ${{ ...ATR_BOTH, atrPeriod: 1.5 }}                                | ${['atrPeriod']}            | ${FRACTIONAL_NUMBER}
    ${'a quoted atrPeriod'}                     | ${{ ...ATR_BOTH, atrPeriod: '14' }}                               | ${['atrPeriod']}            | ${QUOTED_NUMBER}
    ${'an unknown resetMode (upward)'}          | ${{ ...block, resetMode: 'upward' }}                              | ${['resetMode']}            | ${UNKNOWN_RESET_MODE}
    ${'a resetMode in capitals (UP)'}           | ${{ ...block, resetMode: 'UP' }}                                  | ${['resetMode']}            | ${UNKNOWN_RESET_MODE}
    ${'a resetMode given as a number'}          | ${{ ...block, resetMode: 1 }}                                     | ${['resetMode']}            | ${UNKNOWN_RESET_MODE}
    ${'a resetConfirmCandles of 0'}             | ${{ ...ATR_BOTH, resetConfirmCandles: 0 }}                        | ${['resetConfirmCandles']}  | ${AT_LEAST_ONE}
    ${'a fractional resetConfirmCandles'}       | ${{ ...ATR_BOTH, resetConfirmCandles: 1.5 }}                      | ${['resetConfirmCandles']}  | ${FRACTIONAL_NUMBER}
    ${'a quoted resetConfirmCandles'}           | ${{ ...ATR_BOTH, resetConfirmCandles: '2' }}                      | ${['resetConfirmCandles']}  | ${QUOTED_NUMBER}
    ${'a negative resetCooldownCandles'}        | ${{ ...ATR_BOTH, resetCooldownCandles: -1 }}                      | ${['resetCooldownCandles']} | ${AT_LEAST_ZERO}
    ${'a fractional resetCooldownCandles'}      | ${{ ...ATR_BOTH, resetCooldownCandles: 0.5 }}                     | ${['resetCooldownCandles']} | ${FRACTIONAL_NUMBER}
    ${'a quoted resetCooldownCandles'}          | ${{ ...ATR_BOTH, resetCooldownCandles: '10' }}                    | ${['resetCooldownCandles']} | ${QUOTED_NUMBER}
  `('refuses $scenario', ({ params, path, message }) => {
    expect(gridBotStrategySchema.safeParse(params).error?.issues).toMatchObject([{ path, message }]);
  });
});
