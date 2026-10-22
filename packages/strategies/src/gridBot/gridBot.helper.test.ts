import { OrderOutOfRangeError } from '@gekko/shared/errors/orderOutOfRange.error';
import { MarketData } from '@gekko/shared/models/exchange.types';
import { assertOrderWithinLimits } from '@gekko/shared/helpers/market/market.helper';
import { addPrecise } from '@gekko/shared/utils/math/math.utils';
import { omit } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { gridBotStrategySchema } from '@gekko/schemas/strategies/gridBot.schema';
import { GridBot } from './gridBot.strategy';
import { GridBounds, GridLayout, GridSpacingType } from './gridBot.types';
import {
  checkLowestBuyPrice,
  checkPriceTick,
  checkRoundTripFee,
  computeGridBounds,
  computeGridPrices,
  computeLevelPrice,
  computeRebalancePlan,
  deriveLevelQuantity,
  describeSpacing,
  getGridFunding,
  getMakerFee,
  getMaximumAmount,
  getMinimumAmount,
  getMinimumStep,
  getOutOfRangeSide,
  getPortfolioContent,
  getRebalanceBuyCost,
  getRebalanceOrderPrice,
  hasOnlyOneSide,
  inferAmountPrecision,
  inferPricePrecision,
  isResetSide,
  resolveSpacing,
  roundAmount,
  roundPrice,
  validateConfig,
} from './gridBot.helper';

// The documented dummy-cex block (config/backtest.yml), its 8 decimals handed on as steps by its schema, and a market charging a
// 0.1 % maker fee, as Binance does
const documentedMarketData: MarketData = {
  price: { min: 0.01, max: 1_000_000 },
  amount: { min: 0.00001, max: 9000 },
  cost: { min: 5, max: 9_000_000 },
  precision: { price: 1e-8, amount: 1e-8 },
  fee: { maker: 0.0004, taker: 0.0007 },
};
const tenthPercentFeeMarketData: MarketData = {
  price: { min: 0.01 },
  amount: { min: 0.00001 },
  cost: { min: 5 },
  precision: { price: 0.01, amount: 0.00001 },
  fee: { maker: 0.001, taker: 0.001 },
};
// The documented block with Binance's BTC/USDT steps, an amount to 5 decimals and a price to the cent, which CCXTExchange truncates an
// amount to
const binanceStepsMarketData: MarketData = { ...documentedMarketData, precision: { price: 0.01, amount: 0.00001 } };
// Binance's DOGE/BTC: whole coins, a price to the satoshi, and the minimum cost of its pairs quoted in BTC
const dogeBtcMarketData: MarketData = { amount: { min: 1 }, cost: { min: 0.0001 }, precision: { price: 1e-8, amount: 1 } };
// Hyperliquid's BTC loaded at 9990, 5 significant digits in a price: a tick of 0.1 stated there, of 1 from 10000 on, and a maker fee of
// 0.04 %
const significantDigitsMarketData: MarketData = { precision: { price: 0.1, priceSignificantDigits: 5 }, fee: { maker: 0.0004 } };
// A pair around 1 on 5 significant digits, a tick of 0.00001 under 1 and of 0.0001 from 1 on, at a maker fee of 0.04 %
const aroundOneMarketData: MarketData = { precision: { price: 0.00001, priceSignificantDigits: 5 }, fee: { maker: 0.0004 } };
// A tick of 0.01 at a maker fee of 0.04 %, on which a level spaced by 3.3 above 4123.35 breaks even exactly: its SELL at 4126.65 brings
// in 4126.65 × 0.9996 = 4124.99934, what its BUY costs, 4123.35 × 1.0004, though 4124.999339999999 in binary
const exactBreakEvenMarketData: MarketData = { precision: { price: 0.01 }, fee: { maker: 0.0004 } };
// A token priced under a thousandth of a cent, such as PEPE/USDT: a tick of 1e-8, whole units, a maker fee of 0.1 %
const pepeMarketData: MarketData = { precision: { price: 1e-8, amount: 1 }, fee: { maker: 0.001 } };

describe('gridBot.helper', () => {
  describe('inferPricePrecision', () => {
    it.each`
      tick      | description                                    | expected
      ${0.01}   | ${'a tick to the cent'}                        | ${{ priceDecimals: 2, priceStep: 0.01 }}
      ${1e-8}   | ${'a tick of 8 decimals'}                      | ${{ priceDecimals: 8, priceStep: 1e-8 }}
      ${1e-7}   | ${'a tick String writes with an exponent'}     | ${{ priceDecimals: 7, priceStep: 1e-7 }}
      ${0.0015} | ${'a tick of 0.0015'}                          | ${{ priceDecimals: 4, priceStep: 0.0015 }}
      ${0.25}   | ${'a tick of 0.25, not one unit of a decimal'} | ${{ priceDecimals: 2, priceStep: 0.25 }}
      ${1}      | ${'a tick of 1'}                               | ${{ priceDecimals: 0, priceStep: 1 }}
      ${10}     | ${'a tick of 10'}                              | ${{ priceDecimals: 0, priceStep: 10 }}
    `('is $description and its decimals', ({ tick, expected }) => {
      expect(inferPricePrecision({ precision: { price: tick } })).toEqual(expected);
    });

    // The decimals used to be read from the close: a close of 100 put the prices of a grid spaced by 0.5 % at whole units, 99, 99,
    // 100, 100, 101 and 101
    it.each`
      marketData                            | description
      ${{}}                                 | ${'no precision'}
      ${{ precision: { amount: 0.01 } }}    | ${'an amount precision only'}
      ${{ precision: { price: 0 } }}        | ${'a tick of 0, as a disabled tick size reads'}
      ${{ precision: { price: -0.01 } }}    | ${'a negative tick'}
      ${{ precision: { price: NaN } }}      | ${'a tick that is not a number'}
      ${{ precision: { price: Infinity } }} | ${'an infinite tick'}
    `('is 8 decimals (DEFAULT_PRICE_PRECISION) without a tick for a market stating $description', ({ marketData }) => {
      expect(inferPricePrecision(marketData)).toEqual({ priceDecimals: 8 });
    });

    // Hyperliquid's tick depends on the price: precision.price is its tick at the price the markets were loaded at, 0.1 at 9990
    it.each`
      precision                                    | description              | expected
      ${{ price: 0.1, priceSignificantDigits: 5 }} | ${'a tick of 0.1'}       | ${{ priceDecimals: 1, priceStep: 0.1, priceSignificantDigits: 5 }}
      ${{ priceSignificantDigits: 5 }}             | ${'no tick: 8 decimals'} | ${{ priceDecimals: 8, priceSignificantDigits: 5 }}
    `('reads the significant digits of a market whose tick depends on the price, with $description', ({ precision, expected }) => {
      expect(inferPricePrecision({ precision })).toStrictEqual(expected);
    });

    it.each`
      digits      | description
      ${0}        | ${'0'}
      ${-5}       | ${'a negative number'}
      ${4.5}      | ${'a fraction'}
      ${NaN}      | ${'a value that is not a number'}
      ${Infinity} | ${'an infinite value'}
    `('reads no significant digits from $description, which states no such rule', ({ digits }) => {
      expect(inferPricePrecision({ precision: { price: 0.1, priceSignificantDigits: digits } })).toStrictEqual({
        priceDecimals: 1,
        priceStep: 0.1,
      });
    });
  });

  // The step itself, not its decimals: on a step that is not one unit of a decimal, 10 or 0.5, the amounts were rounded to its decimals,
  // 4705 and 1.4, which the exchange takes as 4700 and 1
  describe('inferAmountPrecision', () => {
    it.each`
      marketData                             | description                                          | expected
      ${{ precision: { amount: 0.001 } }}    | ${'an amount step of 0.001'}                         | ${0.001}
      ${{ precision: { amount: 1e-8 } }}     | ${'an amount step String writes with an exponent'}   | ${1e-8}
      ${{ precision: { amount: 1 } }}        | ${'an amount step of 1'}                             | ${1}
      ${{ precision: { amount: 10 } }}       | ${'an amount step of 10, not one unit of 0 decimal'} | ${10}
      ${{ precision: { amount: 0.5 } }}      | ${'an amount step of 0.5, not one unit of a tenth'}  | ${0.5}
      ${{}}                                  | ${'no precision: DEFAULT_AMOUNT_PRECISION'}          | ${1e-8}
      ${{ precision: { amount: 0 } }}        | ${'an amount step of 0, which states none'}          | ${1e-8}
      ${{ precision: { amount: Infinity } }} | ${'an infinite amount step, which states none'}      | ${1e-8}
    `('is the step $expected for $description', ({ marketData, expected }) => {
      expect(inferAmountPrecision(marketData)).toBe(expected);
    });
  });

  describe('roundPrice', () => {
    it.each`
      value      | decimals | step         | expected
      ${100.123} | ${2}     | ${undefined} | ${100.12}
      ${100.126} | ${2}     | ${undefined} | ${100.13}
      ${100.123} | ${2}     | ${0.05}      | ${100.1}
      ${100.13}  | ${2}     | ${0.05}      | ${100.15}
      ${100.025} | ${2}     | ${0.05}      | ${100.05}
    `('rounds $value to $expected (decimals=$decimals, step=$step)', ({ value, decimals, step, expected }) => {
      expect(roundPrice(value, decimals, step)).toBe(expected);
    });

    // A price on a tie used to be divided by the step in binary, which put it under the half: 1.005 / 0.01 is 100.49999999999999,
    // and 1.005 was rounded to 1 where round rounds it to 1.01
    it.each`
      value        | decimals | step     | description                                                       | expected
      ${1.005}     | ${2}     | ${0.01}  | ${'1.005 / 0.01 being 100.49999999999999'}                        | ${1.01}
      ${0.285}     | ${2}     | ${0.01}  | ${'0.285 / 0.01 being 28.499999999999996'}                        | ${0.29}
      ${4.35}      | ${1}     | ${0.1}   | ${'4.35 / 0.1 being 43.49999999999999'}                           | ${4.4}
      ${2752.0325} | ${3}     | ${0.001} | ${'2752.0325 / 0.001 being 2752032.4999999995'}                   | ${2752.033}
      ${61234.465} | ${2}     | ${0.01}  | ${'61234.465 / 0.01 being 6123446.499999999'}                     | ${61234.47}
      ${10.075}    | ${2}     | ${0.05}  | ${'on a step of 0.05, 10.075 / 0.05 being 201.49999999999997'}    | ${10.1}
      ${10.125}    | ${2}     | ${0.25}  | ${'on a step of 0.25, halfway between 10 and 10.25'}              | ${10.25}
      ${2.25}      | ${1}     | ${0.5}   | ${'on a step of 0.5, halfway between 2 and 2.5'}                  | ${2.5}
      ${1235}      | ${0}     | ${10}    | ${'on a step of 10, halfway between 1230 and 1240'}               | ${1240}
      ${-10.075}   | ${2}     | ${0.05}  | ${'below 0, to the multiple above, as round rounds -1.005 to -1'} | ${-10.05}
    `('rounds a tie upwards, as round does: $description', ({ value, decimals, step, expected }) => {
      expect(roundPrice(value, decimals, step)).toBe(expected);
    });

    it.each`
      value      | decimals | step    | description                                                   | expected
      ${10.124}  | ${2}     | ${0.25} | ${'10.124 on a step of 0.25, nearer to 10'}                   | ${10}
      ${1234.5}  | ${0}     | ${10}   | ${'1234.5 on a step of 10, nearer to 1230'}                   | ${1230}
      ${0.3}     | ${1}     | ${0.1}  | ${'0.3 on a step of 0.1, 0.3 / 0.1 being 2.9999999999999996'} | ${0.3}
      ${0.01}    | ${2}     | ${0.05} | ${'0.01 on a step of 0.05, nearer to 0'}                      | ${0}
      ${100.004} | ${2}     | ${0.01} | ${'100.004 to the cent'}                                      | ${100}
    `('rounds to the nearest multiple of the step: $description', ({ value, decimals, step, expected }) => {
      expect(roundPrice(value, decimals, step)).toBe(expected);
    });

    it.each`
      value        | description
      ${Infinity}  | ${'an infinite price'}
      ${-Infinity} | ${'a price of -Infinity'}
      ${NaN}       | ${'a price that is not a number'}
    `('returns 0 for $description', ({ value }) => {
      expect(roundPrice(value, 2, 0.01)).toBe(0);
    });

    it('returns 0 for a price that is not finite, without a step', () => {
      expect(roundPrice(Infinity, 2)).toBe(0);
    });

    // As Hyperliquid takes a price, 5 significant digits at most, an integer part of more digits kept whole, the tick at the price
    // where it is coarser than the step. On a market loaded at 9990, a step of 0.1, 10000.4 was kept, which the exchange takes as 10000
    describe('on a market that takes 5 significant digits in a price', () => {
      it.each`
        value            | decimals | step         | description                                                         | expected
        ${10000.4}       | ${1}     | ${0.1}       | ${'from 10000 on, a tick of 1'}                                     | ${10000}
        ${10000.5}       | ${1}     | ${0.1}       | ${'a tie upwards, as the exchange rounds it'}                       | ${10001}
        ${9999.95}       | ${1}     | ${0.1}       | ${'under 10000, a tie on the step, upwards'}                        | ${10000}
        ${9999.94}       | ${1}     | ${0.1}       | ${'under 10000, the step'}                                          | ${9999.9}
        ${123456.7}      | ${1}     | ${0.1}       | ${'an integer part of 6 digits, kept whole'}                        | ${123457}
        ${12.34567}      | ${1}     | ${0.1}       | ${'the step, coarser than the tick of 0.001 at 12.345'}             | ${12.3}
        ${12.34567}      | ${8}     | ${undefined} | ${'without a step, the tick of 0.001'}                              | ${12.346}
        ${0.00123456}    | ${8}     | ${undefined} | ${'without a step, the tick of 1e-7'}                               | ${0.0012346}
        ${1.23456789e-7} | ${8}     | ${undefined} | ${'without a step, the 8 decimals, coarser than the tick of 1e-11'} | ${1.2e-7}
        ${-10000.4}      | ${1}     | ${0.1}       | ${'a price under 0, at the step'}                                   | ${-10000.4}
      `('rounds $value to $expected: $description', ({ value, decimals, step, expected }) => {
        expect(roundPrice(value, decimals, step, 5)).toBe(expected);
      });

      it.each`
        digits       | description
        ${undefined} | ${'no significant digits'}
        ${0}         | ${'0 significant digits'}
        ${4.5}       | ${'a fraction of a digit'}
      `('rounds 10000.4 to the step, 10000.4, on a market that states $description', ({ digits }) => {
        expect(roundPrice(10000.4, 1, 0.1, digits)).toBe(10000.4);
      });
    });
  });

  // As the exchange truncates an amount (see roundToStep): to the step, not to its decimals
  describe('roundAmount', () => {
    it.each`
      value      | step     | expected
      ${1.999}   | ${0.01}  | ${1.99}
      ${1.001}   | ${0.01}  | ${1}
      ${0.1234}  | ${0.001} | ${0.123}
      ${4705.33} | ${10}    | ${4700}
      ${1.4}     | ${0.5}   | ${1}
    `('rounds $value down to $expected on a step of $step', ({ value, step, expected }) => {
      expect(roundAmount(value, step)).toBe(expected);
    });

    it('returns 0 for non-positive values', () => {
      expect(roundAmount(-1, 0.01)).toBe(0);
    });

    it('returns 0 for non-finite values', () => {
      expect(roundAmount(Infinity, 0.01)).toBe(0);
    });
  });

  describe('computeLevelPrice', () => {
    const center = 100;
    const decimals = 2;

    describe('fixed spacing', () => {
      it.each`
        index | value | expected
        ${0}  | ${5}  | ${100}
        ${1}  | ${5}  | ${105}
        ${-1} | ${5}  | ${95}
        ${2}  | ${5}  | ${110}
        ${-2} | ${5}  | ${90}
      `('returns $expected for index=$index, value=$value', ({ index, value, expected }) => {
        expect(computeLevelPrice(center, index, decimals, 'fixed', value)).toBe(expected);
      });
    });

    describe('percent spacing', () => {
      it.each`
        index | value | expected
        ${0}  | ${5}  | ${100}
        ${1}  | ${5}  | ${105}
        ${-1} | ${5}  | ${95}
        ${2}  | ${10} | ${120}
        ${-2} | ${10} | ${80}
      `('returns $expected for index=$index, value=$value', ({ index, value, expected }) => {
        expect(computeLevelPrice(center, index, decimals, 'percent', value)).toBe(expected);
      });
    });

    describe('logarithmic spacing', () => {
      it.each`
        index | value  | expected
        ${0}  | ${0.1} | ${100}
        ${1}  | ${0.1} | ${110}
        ${-1} | ${0.1} | ${90.91}
        ${2}  | ${0.1} | ${121}
      `('returns $expected for index=$index, value=$value', ({ index, value, expected }) => {
        expect(computeLevelPrice(center, index, decimals, 'logarithmic', value)).toBe(expected);
      });

      it('returns 0 for invalid multiplier', () => {
        expect(computeLevelPrice(center, 1, decimals, 'logarithmic', -2)).toBe(0);
      });
    });

    // Computed in binary, a price on a tie could fall under the half before it was rounded: 100.1 + 0.005 was 100.10499999999999,
    // rounded to 100.1, and 61235 × 1.005 was 61541.174999999996, rounded to 61541.17. So could a product left in binary, added in
    // decimal: 0.035 × 7 is 0.24500000000000002, and 66127.4 × 1.5 % × 5 is 4959.554999999999
    it.each`
      centerPrice | index | spacingType  | spacingValue | description                                                 | expected
      ${100.1}    | ${1}  | ${'fixed'}   | ${0.005}     | ${'100.105, 100.1 + 0.005 being 100.10499999999999'}        | ${100.11}
      ${100.32}   | ${-3} | ${'fixed'}   | ${0.005}     | ${'100.305, 100.32 - 0.015 being 100.30499999999999'}       | ${100.31}
      ${13865}    | ${7}  | ${'fixed'}   | ${0.035}     | ${'13865.245, 0.035 × 7 being 0.24500000000000002'}         | ${13865.25}
      ${61235}    | ${1}  | ${'percent'} | ${0.5}       | ${'61541.175, 61235 × 1.005 being 61541.174999999996'}      | ${61541.18}
      ${61235}    | ${-3} | ${'percent'} | ${1.5}       | ${'58479.425, 61235 × 0.955 being 58479.424999999996'}      | ${58479.43}
      ${27985}    | ${5}  | ${'percent'} | ${0.3}       | ${'28404.775, 27985 × 1.015 being 28404.774999999998'}      | ${28404.78}
      ${66127.4}  | ${5}  | ${'percent'} | ${1.5}       | ${'71086.955, 66127.4 × 1.5 % × 5 being 4959.554999999999'} | ${71086.96}
    `(
      'rounds a $spacingType price on a tie upwards, as round rounds it: $description',
      ({ centerPrice, index, spacingType, spacingValue, expected }) => {
        expect(computeLevelPrice(centerPrice, index, 2, spacingType, spacingValue, 0.01)).toBe(expected);
      },
    );

    it.each`
      spacingType  | centerPrice | spacingValue | description
      ${'fixed'}   | ${100}      | ${NaN}       | ${'a fixed spacing that is not a number'}
      ${'percent'} | ${100}      | ${NaN}       | ${'a percent spacing that is not a number'}
      ${'percent'} | ${NaN}      | ${1}         | ${'a center price that is not a number'}
    `('returns 0 for $description', ({ spacingType, centerPrice, spacingValue }) => {
      expect(computeLevelPrice(centerPrice, 1, 2, spacingType, spacingValue, 0.01)).toBe(0);
    });
  });

  describe('computeGridPrices', () => {
    it.each`
      buyLevels | sellLevels | spacingType  | spacingValue | description                                            | expected
      ${2}      | ${2}       | ${'fixed'}   | ${5}         | ${'a 2/2 grid'}                                        | ${[90, 95, 100, 105, 110]}
      ${2}      | ${0}       | ${'fixed'}   | ${5}         | ${'a grid of buy levels only, up to the center price'} | ${[90, 95, 100]}
      ${0}      | ${2}       | ${'fixed'}   | ${5}         | ${'a grid of sell levels only, from the center price'} | ${[100, 105, 110]}
      ${3}      | ${3}       | ${'percent'} | ${0.001}     | ${'a 3/3 grid spaced by 0.001 %, rounded to the cent'} | ${[100, 100, 100, 100, 100, 100, 100]}
    `('are $expected for $description around 100', ({ buyLevels, sellLevels, spacingType, spacingValue, expected }) => {
      expect(computeGridPrices(100, { buyLevels, sellLevels, spacingType, spacingValue }, 2, 0.01)).toEqual(expected);
    });

    // 61235 ± 0.5 % is 60928.825 and 61541.175, two ties at the cent and at 0.05, rounded upwards as round rounds them. Computed and
    // divided in binary, they fell under the half, 60928.82 and 61541.17 at the cent. Without a tick, the decimals of the close made
    // whole units of them.
    it.each`
      marketData                            | description                                        | expected
      ${{ precision: { price: 0.01 } }}     | ${'to the cent'}                                   | ${[60622.65, 60928.83, 61235, 61541.18, 61847.35]}
      ${{ precision: { price: 0.05 } }}     | ${'to a step of 0.05'}                             | ${[60622.65, 60928.85, 61235, 61541.2, 61847.35]}
      ${{ precision: { price: 0.25 } }}     | ${'to a step of 0.25'}                             | ${[60622.75, 60928.75, 61235, 61541.25, 61847.25]}
      ${{ precision: { price: 1 } }}        | ${'to whole units'}                                | ${[60623, 60929, 61235, 61541, 61847]}
      ${{ precision: { price: 1e-8 } }}     | ${'to 8 decimals'}                                 | ${[60622.65, 60928.825, 61235, 61541.175, 61847.35]}
      ${{ precision: { amount: 0.00001 } }} | ${'to 8 decimals on a market that states no tick'} | ${[60622.65, 60928.825, 61235, 61541.175, 61847.35]}
    `('are $expected for a 2/2 grid spaced by 0.5 % around 61235, $description', ({ marketData, expected }) => {
      const { priceDecimals, priceStep } = inferPricePrecision(marketData);
      const halfPercent = { buyLevels: 2, sellLevels: 2, spacingType: 'percent', spacingValue: 0.5 } as const;

      expect(computeGridPrices(61235, halfPercent, priceDecimals, priceStep)).toEqual(expected);
    });

    // Hyperliquid's BTC loaded at 9990, its tick of 0.1 stated there: the prices from 10000 on are whole units, as it takes them
    it.each`
      precision                                    | description                                           | expected
      ${{ price: 0.1, priceSignificantDigits: 5 }} | ${'5 significant digits, 10000.5 and 10001 at 10001'} | ${[9998, 9998.5, 9999, 9999.5, 10000, 10001, 10001]}
      ${{ price: 0.1 }}                            | ${'a tick of 0.1 alone'}                              | ${[9998, 9998.5, 9999, 9999.5, 10000, 10000.5, 10001]}
    `('are $expected for a 2/4 grid spaced by 0.5 around 9999, on a market of $description', ({ precision, expected }) => {
      const { priceDecimals, priceStep, priceSignificantDigits } = inferPricePrecision({ precision });
      const halfUnit = { buyLevels: 2, sellLevels: 4, spacingType: 'fixed', spacingValue: 0.5 } as const;

      expect(computeGridPrices(9999, halfUnit, priceDecimals, priceStep, priceSignificantDigits)).toEqual(expected);
    });
  });

  describe('computeGridBounds', () => {
    it('returns correct bounds for symmetric grid', () => {
      expect(computeGridBounds(100, 2, 2, 2, 'fixed', 5)).toEqual({ min: 90, max: 110 });
    });

    it('returns correct bounds for asymmetric grid', () => {
      expect(computeGridBounds(100, 1, 3, 2, 'fixed', 5)).toEqual({ min: 95, max: 115 });
    });

    it('returns null for zero levels', () => {
      expect(computeGridBounds(100, 0, 0, 2, 'fixed', 5)).toBeNull();
    });

    it('returns null for invalid prices', () => {
      expect(computeGridBounds(10, 5, 2, 2, 'fixed', 5)).toBeNull();
    });

    it('handles only buy levels', () => {
      expect(computeGridBounds(100, 2, 0, 2, 'fixed', 5)).toEqual({ min: 90, max: 100 });
    });

    it('handles only sell levels', () => {
      expect(computeGridBounds(100, 0, 2, 2, 'fixed', 5)).toEqual({ min: 100, max: 110 });
    });

    // Its highest price, 10000.5, at the tick of 1 of 5 significant digits from 10000 on
    it('returns the bounds rounded as the orders are, on a market of 5 significant digits', () => {
      expect(computeGridBounds(9999, 2, 3, 1, 'fixed', 0.5, 0.1, 5)).toEqual({ min: 9998, max: 10001 });
    });
  });

  describe('getOutOfRangeSide', () => {
    // A 2/2 grid at 100 spaced by 5: 90, 95, 100, 105 and 110
    const bounds: GridBounds = { min: 90, max: 110 };
    const reentryPrices = { below: 95, above: 105 };

    it.each`
      price     | previous   | expected
      ${80}     | ${null}    | ${'below'}
      ${89.99}  | ${null}    | ${'below'}
      ${90}     | ${null}    | ${null}
      ${100}    | ${null}    | ${null}
      ${110}    | ${null}    | ${null}
      ${110.01} | ${null}    | ${'above'}
      ${120}    | ${null}    | ${'above'}
      ${94.99}  | ${'below'} | ${'below'}
      ${95}     | ${'below'} | ${null}
      ${105.01} | ${'above'} | ${'above'}
      ${105}    | ${'above'} | ${null}
      ${100}    | ${'above'} | ${null}
      ${80}     | ${'above'} | ${'below'}
      ${120}    | ${'below'} | ${'above'}
      ${106}    | ${'below'} | ${null}
      ${94}     | ${'above'} | ${null}
    `('returns $expected for price=$price, out $previous before', ({ price, previous, expected }) => {
      expect(getOutOfRangeSide(price, bounds, reentryPrices, previous)).toBe(expected);
    });
  });

  describe('isResetSide', () => {
    it.each`
      resetMode | side       | expected
      ${'none'} | ${'above'} | ${false}
      ${'none'} | ${'below'} | ${false}
      ${'up'}   | ${'above'} | ${true}
      ${'up'}   | ${'below'} | ${false}
      ${'down'} | ${'above'} | ${false}
      ${'down'} | ${'below'} | ${true}
      ${'both'} | ${'above'} | ${true}
      ${'both'} | ${'below'} | ${true}
    `('is $expected for resetMode $resetMode and a close $side the grid', ({ resetMode, side, expected }) => {
      expect(isResetSide(resetMode, side)).toBe(expected);
    });
  });

  // How the messages of the checks name the spacing of the grid they refuse or warn of
  describe('describeSpacing', () => {
    it.each`
      spacing                                                                                                                | description                          | expected
      ${{ spacingType: 'percent', spacingValue: 1 }}                                                                         | ${'a configured spacing'}            | ${'spacingValue 1 (percent)'}
      ${{ spacingType: 'fixed', spacingValue: 48.01, description: 'a step of 48.01 (spacingValue 1.5 × ATR 32.0071, atr)' }} | ${'an atr step, by its description'} | ${'a step of 48.01 (spacingValue 1.5 × ATR 32.0071, atr)'}
    `('names $description $expected', ({ spacing, expected }) => {
      expect(describeSpacing(spacing)).toBe(expected);
    });
  });

  // The strategy block as the StrategyManager parses it, without name, before the strategy is created
  // The refusals of the schema are tested in @gekko/schemas: here, that the class declares it, the StrategyManager parsing the block with it
  it('should declare the strategy schema of @gekko/schemas', () => {
    expect(GridBot.schema).toBe(gridBotStrategySchema);
  });

  describe('validateConfig', () => {
    // The levels and the spacing the strategy checks, its spacing resolved (see GridLayout)
    const validParams: GridLayout = { buyLevels: 2, sellLevels: 2, spacingType: 'fixed', spacingValue: 5 };

    it('returns null for valid config', () => {
      expect(validateConfig(validParams, 100, {})).toBeNull();
    });

    // A center price that is not a finite number, which the strategy never passes, read the limits: NaN was refused for being above a
    // maximum of undefined
    it.each`
      center
      ${0}
      ${-1}
      ${NaN}
      ${Infinity}
    `('returns error for a center price of $center, not a finite number above 0', ({ center }) => {
      expect(validateConfig({ ...validParams, buyLevels: 0 }, center, {})).toBe('Center price must be positive');
    });

    // On a tick of 1, where the lowest of a logarithmic grid, 100 / 1.1 ** 60, 0.328, rounds to 0
    it.each`
      buyLevels | spacingType      | spacingValue | expected
      ${25}     | ${'fixed'}       | ${5}         | ${'the lowest of buyLevels 25, spaced by spacingValue 5 (fixed) below the center price 100, would be at -25'}
      ${4}      | ${'percent'}     | ${25}        | ${'the lowest of buyLevels 4, spaced by spacingValue 25 (percent) below the center price 100, would be at 0'}
      ${60}     | ${'logarithmic'} | ${0.1}       | ${'the lowest of buyLevels 60, spaced by spacingValue 0.1 (logarithmic) below the center price 100, would be at 0'}
    `(
      'returns error naming the parameters for non-positive buy prices ($spacingType spacing)',
      ({ buyLevels, spacingType, spacingValue, expected }) => {
        expect(validateConfig({ ...validParams, buyLevels, spacingType, spacingValue }, 100, { precision: { price: 1 } })).toBe(
          `Grid configuration would result in non-positive buy prices: ${expected}`,
        );
      },
    );

    // The decimals of the close of 100 used to round a grid spaced by 0.5 % to whole units, 99, 99, 100, 100, 101 and 101: two levels
    // bought and sold at one price
    it('returns null for a grid spaced by 0.5 % around 100 on a market that states no tick, its prices to 8 decimals', () => {
      const halfPercent = { ...validParams, buyLevels: 3, sellLevels: 3, spacingType: 'percent' as const, spacingValue: 0.5 };

      expect(validateConfig(halfPercent, 100, {})).toBeNull();
    });

    // Every figure with every decimal (see formatEveryDecimal), where String wrote 1e-7 and 1e-8
    it('returns error naming the tick of 8 decimals for two adjacent prices rounded together on a market that states no tick', () => {
      const underTheDefaultTick = { ...validParams, buyLevels: 1, sellLevels: 1, spacingType: 'percent' as const, spacingValue: 1e-7 };

      expect(validateConfig(underTheDefaultTick, 1, {})).toBe(
        'Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.0000001 (percent) around the center price 1, two adjacent prices of the grid would both round to 1 at the price tick 0.00000001',
      );
    });

    // A spacing under the tick used to be accepted, the prices of the grid rounded onto each other: percent 0.001 at 100 put every
    // price of a 3/3 grid at 100, where its levels bought and sold at zero spread, two fees a round trip for nothing
    it.each`
      center    | buyLevels | sellLevels | spacingType      | spacingValue | tick      | description                                                     | price
      ${100}    | ${3}      | ${3}       | ${'percent'}     | ${0.001}     | ${0.01}   | ${'every price of the grid at the center price'}                | ${100}
      ${100}    | ${2}      | ${2}       | ${'fixed'}       | ${0.004}     | ${0.01}   | ${'the prices next to the center price at the center price'}    | ${100}
      ${100}    | ${1}      | ${1}       | ${'logarithmic'} | ${0.00004}   | ${0.01}   | ${'a logarithmic spacing under the tick'}                       | ${100}
      ${100}    | ${3}      | ${3}       | ${'fixed'}       | ${0.008}     | ${0.01}   | ${'the farthest prices only, 0.016 and 0.024 below the center'} | ${99.98}
      ${0.0123} | ${5}      | ${5}       | ${'percent'}     | ${0.5}       | ${0.0001} | ${'a coin whose tick is 0.8 % of its price, duplicated levels'} | ${0.0121}
      ${10.25}  | ${2}      | ${2}       | ${'percent'}     | ${1}         | ${0.25}   | ${'a tick of 0.25, not one unit of a decimal'}                  | ${10.25}
      ${100}    | ${1}      | ${0}       | ${'fixed'}       | ${0.004}     | ${0.01}   | ${'one buy level, which sells at the center price'}             | ${100}
      ${100}    | ${0}      | ${1}       | ${'fixed'}       | ${0.004}     | ${0.01}   | ${'one sell level, which buys at the center price'}             | ${100}
    `(
      'returns error naming the parameter and the tick for two adjacent prices rounded to the same tick: $description',
      ({ center, buyLevels, sellLevels, spacingType, spacingValue, tick, price }) => {
        expect(
          validateConfig({ ...validParams, buyLevels, sellLevels, spacingType, spacingValue }, center, { precision: { price: tick } }),
        ).toBe(
          `Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue ${spacingValue} (${spacingType}) around the center price ${center}, two adjacent prices of the grid would both round to ${price} at the price tick ${tick}`,
        );
      },
    );

    // 0.008 below and above 100 round to 99.99 and 100.01: the grid is a tick apart, as rounded, not a level at zero spread
    it.each`
      spacingValue | description
      ${0.01}      | ${'exactly one tick'}
      ${0.008}     | ${'under one tick, the 2/2 grid rounded a tick apart'}
    `('returns null for a fixed spacing of $spacingValue at 100 on a tick of 0.01: $description', ({ spacingValue }) => {
      expect(validateConfig({ ...validParams, spacingValue }, 100, { precision: { price: 0.01 } })).toBeNull();
    });

    it('returns error for price below exchange minimum', () => {
      expect(validateConfig({ ...validParams, buyLevels: 0 }, 0.5, { price: { min: 1 } })).toBe(
        'Center price 0.5 is below exchange minimum 1',
      );
    });

    it('returns error for price above exchange maximum', () => {
      expect(validateConfig(validParams, 1000, { price: { max: 500 } })).toBe('Center price 1000 is above exchange maximum 500');
    });

    // Every figure with every decimal (see formatEveryDecimal): String wrote a price under a millionth with an exponent, 5e-7
    it.each`
      center      | price                | description                     | expected
      ${5e-7}     | ${{ min: 0.000001 }} | ${'below the exchange minimum'} | ${'Center price 0.0000005 is below exchange minimum 0.000001'}
      ${0.000002} | ${{ max: 0.000001 }} | ${'above the exchange maximum'} | ${'Center price 0.000002 is above exchange maximum 0.000001'}
    `('returns error writing every decimal of a center price $description, under a millionth', ({ center, price, expected }) => {
      const tickApart: GridLayout = { buyLevels: 1, sellLevels: 1, spacingType: 'fixed', spacingValue: 1e-8 };

      expect(validateConfig(tickApart, center, { price, precision: { price: 1e-8 } })).toBe(expected);
    });

    // Read as the order layer reads them for every order (checkOrderPrice): a limit that is not a finite number above 0 sets none. Read
    // by hand, a maximum of -1 refused every price, which the order layer would have taken
    it.each`
      price                     | description
      ${{ min: 0, max: 0 }}     | ${'limits of 0, as Binance disables a filter bound'}
      ${{ max: -1 }}            | ${'a negative maximum'}
      ${{ min: Infinity }}      | ${'an infinite minimum'}
      ${{ min: NaN, max: NaN }} | ${'limits that are not numbers'}
    `('returns null for a center price within no limit: $description', ({ price }) => {
      expect(validateConfig(validParams, 100, { price })).toBeNull();
    });

    // The start refuses it: Hyperliquid would take 10000.5 and 10001 as 10001
    it('returns error naming the rule of a market that takes 5 significant digits in a price, its tick stated as 0.1', () => {
      const halfUnit = { ...validParams, buyLevels: 2, sellLevels: 4, spacingValue: 0.5 };

      expect(validateConfig(halfUnit, 9999, { precision: { price: 0.1, priceSignificantDigits: 5 } })).toBe(
        'Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.5 (fixed) around the center price 9999, two adjacent prices of the grid would both round to 10001 at the price tick 1, the market taking 5 significant digits in a price (precision.priceSignificantDigits)',
      );
    });

    // Checked last, the tick leaves every configuration refused before refused with the same message
    it('returns error for price below exchange minimum before the one of a grid spaced under the tick', () => {
      const underTick = { ...validParams, spacingType: 'percent' as const, spacingValue: 0.001 };

      expect(validateConfig(underTick, 0.5, { price: { min: 1 }, precision: { price: 0.01 } })).toBe(
        'Center price 0.5 is below exchange minimum 1',
      );
    });
  });

  // Checked when the grid starts (validateConfig), and again around the price a rebalance ended at, which used to be left unchecked:
  // lower, the lowest BUY of a fixed grid falls at or below 0, and that of a percent grid rounds to 0 on the tick after a far larger fall
  describe('checkLowestBuyPrice', () => {
    // 2 buy levels spaced by 5: the lowest BUY 10 under the center price
    const fixedFive = { buyLevels: 2, spacingType: 'fixed', spacingValue: 5 } as const;
    // 2 buy levels spaced by 49.99 % of the center price: the lowest BUY at 0.02 % of it
    const percentAtTheBottom = { buyLevels: 2, spacingType: 'percent', spacingValue: 49.99 } as const;

    it.each`
      center   | params                            | description
      ${10.01} | ${fixedFive}                      | ${'fixed 5 around 10.01, its lowest BUY at 0.01'}
      ${0}     | ${{ ...fixedFive, buyLevels: 0 }} | ${'a grid without buy levels, whatever its center price, checked apart'}
      ${100}   | ${percentAtTheBottom}             | ${'percent 49.99 around 100, its lowest BUY at 0.02'}
    `('is null for $description', ({ center, params }) => {
      expect(checkLowestBuyPrice(params, center, 2, 0.01)).toBeNull();
    });

    // Rounded as its order is: 0.2 is 0 on a tick of 0.5
    it.each`
      center | params                                 | tick    | description                                                      | expected
      ${10}  | ${fixedFive}                           | ${0.01} | ${'at 0 itself: fixed 5 around 10'}                              | ${'the lowest of buyLevels 2, spaced by spacingValue 5 (fixed) below the center price 10, would be at 0'}
      ${9}   | ${fixedFive}                           | ${0.01} | ${'under 0: fixed 5 around 9'}                                   | ${'the lowest of buyLevels 2, spaced by spacingValue 5 (fixed) below the center price 9, would be at -1'}
      ${20}  | ${percentAtTheBottom}                  | ${0.01} | ${'rounded to 0 on the tick: percent 49.99 around 20, at 0.004'} | ${'the lowest of buyLevels 2, spaced by spacingValue 49.99 (percent) below the center price 20, would be at 0'}
      ${10}  | ${{ ...fixedFive, spacingValue: 4.9 }} | ${0.5}  | ${'rounded to 0 on a tick of 0.5: fixed 4.9 around 10, at 0.2'}  | ${'the lowest of buyLevels 2, spaced by spacingValue 4.9 (fixed) below the center price 10, would be at 0'}
    `('is the error naming the parameters and the center price for a lowest BUY $description', ({ center, params, tick, expected }) => {
      const { priceDecimals, priceStep } = inferPricePrecision({ precision: { price: tick } });

      expect(checkLowestBuyPrice(params, center, priceDecimals, priceStep)).toBe(
        `Grid configuration would result in non-positive buy prices: ${expected}`,
      );
    });

    // Every figure with every decimal (see formatEveryDecimal), where String wrote 5e-7, 9e-7 and -1e-7
    it('is the error writing every decimal of a grid priced under a millionth: fixed 0.0000005 around 0.0000009', () => {
      expect(checkLowestBuyPrice({ buyLevels: 2, spacingType: 'fixed', spacingValue: 5e-7 }, 9e-7, 8, 1e-8)).toBe(
        'Grid configuration would result in non-positive buy prices: the lowest of buyLevels 2, spaced by spacingValue 0.0000005 (fixed) below the center price 0.0000009, would be at -0.0000001',
      );
    });

    // A huge ATR makes a step that a fixed spacing of its size would make: refused, the message naming the step and its ATR
    it('is the error naming an atr step and its ATR for a lowest BUY under 0: 5 buy levels spaced by 1 × ATR 30 around 100', () => {
      const { spacing } = resolveSpacing({ sellLevels: 5, spacingType: 'atr', spacingValue: 1 }, 100, { precision: { price: 0.01 } }, 30);

      expect(checkLowestBuyPrice({ buyLevels: 5, ...spacing }, 100, 2, 0.01)).toBe(
        'Grid configuration would result in non-positive buy prices: the lowest of buyLevels 5, spaced by a step of 30 (spacingValue 1 × ATR 30, atr) below the center price 100, would be at -50',
      );
    });
  });

  // A percent or logarithmic step shrinks with the price: 0.0084 % keeps the prices of a 3/3 grid a tick apart at 100, not at 99. A
  // fixed step does not, the center price being on the tick
  describe('checkPriceTick', () => {
    const nearTheTick = { buyLevels: 3, sellLevels: 3, spacingValue: 0.0084 };

    it.each`
      center | spacingType  | description
      ${100} | ${'percent'} | ${'percent 0.0084 at 100: 99.97, 99.98, 99.99, 100, 100.01, 100.02 and 100.03'}
      ${99}  | ${'fixed'}   | ${'fixed 0.0084 at 99: 98.97, 98.98, 98.99, 99, 99.01, 99.02 and 99.03'}
    `('is null for $description', ({ center, spacingType }) => {
      expect(checkPriceTick({ ...nearTheTick, spacingType }, center, 2, 0.01)).toBeNull();
    });

    it('is the error of percent 0.0084 at 99, whose prices round to 98.98 twice', () => {
      expect(checkPriceTick({ ...nearTheTick, spacingType: 'percent' }, 99, 2, 0.01)).toBe(
        'Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.0084 (percent) around the center price 99, two adjacent prices of the grid would both round to 98.98 at the price tick 0.01',
      );
    });

    // Hyperliquid takes 5 significant digits in a price: on its BTC loaded at 9990, its tick stated as 0.1, a grid spaced by 0.5 around
    // 9999 passed, while its prices 10000.5 and 10001 were both sent at 10001
    describe('on a market that takes 5 significant digits in a price, its tick stated as 0.1', () => {
      const halfUnit = { buyLevels: 2, sellLevels: 4, spacingType: 'fixed', spacingValue: 0.5 } as const;

      it('is the error naming the rule for two prices its tick of 1 rounds together from 10000 on', () => {
        expect(checkPriceTick(halfUnit, 9999, 1, 0.1, 5)).toBe(
          'Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.5 (fixed) around the center price 9999, two adjacent prices of the grid would both round to 10001 at the price tick 1, the market taking 5 significant digits in a price (precision.priceSignificantDigits)',
        );
      });

      it.each`
        params                              | digits       | description
        ${halfUnit}                         | ${undefined} | ${'spaced by 0.5, on a market that states no such rule'}
        ${{ ...halfUnit, spacingValue: 1 }} | ${5}         | ${'spaced by 1, a tick apart from 10000 on: 10000, 10001, 10002 and 10003'}
      `('is null for a 2/4 grid around 9999 $description', ({ params, digits }) => {
        expect(checkPriceTick(params, 9999, 1, 0.1, digits)).toBeNull();
      });

      // At 100, the tick of 5 significant digits is the step, 0.01: the step rounded them together, as without the rule
      it('is the error naming the step alone for two prices the step rounds together', () => {
        expect(checkPriceTick({ buyLevels: 2, sellLevels: 2, spacingType: 'fixed', spacingValue: 0.004 }, 100, 2, 0.01, 5)).toBe(
          'Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.004 (fixed) around the center price 100, two adjacent prices of the grid would both round to 100 at the price tick 0.01',
        );
      });

      // Without a fee the minimum step is one tick at the center price (see getMinimumStep), which keeps an atr step of 0.5 around 9999:
      // under the tick of 1 from 10000 on, refused as a fixed spacing of 0.5 is, the message naming the step and its ATR
      it('is the error naming an atr step and its ATR for two prices its tick of 1 rounds together from 10000 on', () => {
        const withoutFee: MarketData = { precision: { price: 0.1, priceSignificantDigits: 5 } };
        const { spacing } = resolveSpacing({ sellLevels: 4, spacingType: 'atr', spacingValue: 1 }, 9999, withoutFee, 0.5);

        expect(checkPriceTick({ buyLevels: 2, sellLevels: 4, ...spacing }, 9999, 1, 0.1, 5)).toBe(
          'Grid configuration would result in a level buying and selling at the same price: spaced by a step of 0.5 (spacingValue 1 × ATR 0.5, atr) around the center price 9999, two adjacent prices of the grid would both round to 10001 at the price tick 1, the market taking 5 significant digits in a price (precision.priceSignificantDigits)',
        );
      });
    });
  });

  // A spacing under the round-trip fee used to be accepted without a word: every round trip of a level paid more in fees than it
  // earned, and the more the grid traded, the more it lost
  describe('checkRoundTripFee', () => {
    const fivePerSide = { buyLevels: 5, sellLevels: 5, retryOnError: 3 };
    /** The warning, from what it names: the round trip's break-even, the fee, the levels under it and the narrowest of them */
    const underFee = (spacing: string, breakEven: string, fee: number, count: string, narrowest: string) =>
      `spacingValue ${spacing} is under the round-trip fee: a level that sells less than ${breakEven} above its buy, paying the maker fee of ${fee} (fee.maker) on its BUY and on its SELL, loses money at each round trip, ${count} here, the narrowest ${narrowest}`;

    // A maker fee of 0.0004 costs a round trip 0.08003 % of the price, 0.1 % costs 0.2002 %: 2 × fee / (1 - fee)
    it.each`
      center   | spacingType      | spacingValue | maker     | description                                           | breakEven      | count             | narrowest
      ${60000} | ${'fixed'}       | ${10}        | ${0.0004} | ${'fixed 10 at 60000, 0.0167 % a level'}              | ${'0.08003 %'} | ${'10 out of 10'} | ${'selling at 60050, 0.01666 % above its buy at 60040'}
      ${60000} | ${'percent'}     | ${0.05}      | ${0.0004} | ${'percent 0.05'}                                     | ${'0.08003 %'} | ${'10 out of 10'} | ${'selling at 60150, 0.0499 % above its buy at 60120'}
      ${60000} | ${'logarithmic'} | ${0.0005}    | ${0.0004} | ${'logarithmic 0.0005'}                               | ${'0.08003 %'} | ${'10 out of 10'} | ${'selling at 59940.04, 0.04999 % above its buy at 59910.09'}
      ${60000} | ${'fixed'}       | ${100}       | ${0.001}  | ${'the documentation example of fixed 100, at 0.1 %'} | ${'0.2002 %'}  | ${'10 out of 10'} | ${'selling at 60500, 0.1656 % above its buy at 60400'}
      ${60000} | ${'fixed'}       | ${48}        | ${0.0004} | ${'fixed 48, under the fee above the center only'}    | ${'0.08003 %'} | ${'5 out of 10'}  | ${'selling at 60240, 0.07974 % above its buy at 60192'}
      ${100}   | ${'percent'}     | ${0.08}      | ${0.0004} | ${'percent 0.08, a hair under the fee above 100'}     | ${'0.08003 %'} | ${'5 out of 10'}  | ${'selling at 100.4, 0.07974 % above its buy at 100.32'}
      ${100}   | ${'fixed'}       | ${0.01}      | ${0.0004} | ${'fixed 0.01 at 100, one tick'}                      | ${'0.08003 %'} | ${'10 out of 10'} | ${'selling at 100.05, 0.009996 % above its buy at 100.04'}
    `(
      'warns of $description, naming the parameter, the fee and the narrowest level',
      ({ center, spacingType, spacingValue, maker, breakEven, count, narrowest }) => {
        const marketData: MarketData = { precision: { price: 0.01 }, fee: { maker } };

        expect(checkRoundTripFee({ ...fivePerSide, spacingType, spacingValue }, center, marketData)).toBe(
          underFee(`${spacingValue} (${spacingType})`, breakEven, maker, count, narrowest),
        );
      },
    );

    it.each`
      center      | spacingType  | spacingValue | marketData                                                | description
      ${61234.56} | ${'percent'} | ${1}         | ${documentedMarketData}                                   | ${'the documentation example, 1 % a level at a maker fee of 0.0004'}
      ${100}      | ${'percent'} | ${0.09}      | ${{ precision: { price: 0.01 }, fee: { maker: 0.0004 } }} | ${'percent 0.09, over the fee by a hair: 0.08968 % for the narrowest level'}
      ${100}      | ${'fixed'}   | ${0.01}      | ${{ precision: { price: 0.01 } }}                         | ${'one tick on a market that states no fee'}
      ${100}      | ${'fixed'}   | ${0.01}      | ${{ precision: { price: 0.01 }, fee: { taker: 0.001 } }}  | ${'one tick on a market that states a taker fee only, which LIMIT orders resting in the book do not pay'}
    `('returns null for $description', ({ center, spacingType, spacingValue, marketData }) => {
      expect(checkRoundTripFee({ ...fivePerSide, spacingType, spacingValue }, center, marketData)).toBeNull();
    });

    // Its SELL at 10000.3 is placed at 10000, at the tick of 1 of 5 significant digits from 10000 on
    it('names the narrowest level at its prices on a market that takes 5 significant digits in a price', () => {
      const marketData: MarketData = { precision: { price: 0.1, priceSignificantDigits: 5 }, fee: { maker: 0.0004 } };
      const oneLevelASide = { buyLevels: 1, sellLevels: 1, spacingType: 'fixed', spacingValue: 0.6, retryOnError: 3 } as const;

      expect(checkRoundTripFee(oneLevelASide, 9999.7, marketData)).toBe(
        underFee('0.6 (fixed)', '0.08003 %', 0.0004, '2 out of 2', 'selling at 10000, 0.003 % above its buy at 9999.7'),
      );
    });

    // Equal in exact arithmetic, the SELL bringing in 4124.99934 as the BUY costs, the two products were compared as binary gave them,
    // 4124.999339999999 against 4124.99934: the level was warned of as one that sells less than 0.08003 % above its buy, named as
    // selling 0.08003 % above it. They are compared within compareWithTolerance's tolerance, a level a tick under still losing
    it.each`
      spacingValue | description                                   | expected
      ${3.3}       | ${'its break-even exactly: no warning'}       | ${null}
      ${3.29}      | ${'a tick under its break-even: the warning'} | ${underFee('3.29 (fixed)', '0.08003 %', 0.0004, '1 out of 1', 'selling at 4126.64, 0.07979 % above its buy at 4123.35')}
    `(
      'reads a sell level spaced by $spacingValue above 4123.35 at 0.04 % as the minimum step does, $description',
      ({ spacingValue, expected }) => {
        const oneSellLevel: GridLayout = { buyLevels: 0, sellLevels: 1, spacingType: 'fixed', spacingValue };

        expect(checkRoundTripFee(oneSellLevel, 4123.35, exactBreakEvenMarketData)).toBe(expected);
      },
    );

    // Every figure with every decimal (see formatEveryDecimal): String wrote the step, 1e-8, and the percentage, 1.667e-7
    it('warns writing every decimal of a spacing of one tick of 0.00000001 at 6, 0.0000001667 % a level', () => {
      const oneTick: GridLayout = { ...fivePerSide, spacingType: 'fixed', spacingValue: 1e-8 };

      expect(checkRoundTripFee(oneTick, 6, { precision: { price: 1e-8 }, fee: { maker: 0.001 } })).toBe(
        underFee(
          '0.00000001 (fixed)',
          '0.2002 %',
          0.001,
          '10 out of 10',
          'selling at 5.99999996, 0.0000001667 % above its buy at 5.99999995',
        ),
      );
    });

    // No step breaks even on 501 sell levels at 0.1 %, 500 × 0.2002 % being over 1: an atr step is kept at one tick (see getMinimumStep),
    // and warned of here, the message naming the step and its ATR
    it('warns of an atr step naming its ATR: one tick on 501 sell levels at 0.1 %, at which no step breaks even', () => {
      const { spacing } = resolveSpacing(
        { sellLevels: 501, spacingType: 'atr', spacingValue: 1.5 },
        60000,
        tenthPercentFeeMarketData,
        0.004,
      );

      expect(checkRoundTripFee({ buyLevels: 0, sellLevels: 501, ...spacing }, 60000, tenthPercentFeeMarketData)).toBe(
        'a step of 0.01 (spacingValue 1.5 × ATR 0.004, atr) is under the round-trip fee: a level that sells less than 0.2002 % above its buy, paying the maker fee of 0.001 (fee.maker) on its BUY and on its SELL, loses money at each round trip, 501 out of 501 here, the narrowest selling at 60005.01, 0.00001667 % above its buy at 60005',
      );
    });
  });

  // The step under which a level of a fixed grid loses money at each round trip (see checkRoundTripFee), which an atr spacing is raised
  // to (see resolveSpacing). At a fixed step, the highest level, whose buy price is the largest, earns the least for it.
  describe('getMinimumStep', () => {
    // r = 2 × 0.001 / 0.999 = 0.2002 % at a maker fee of 0.1 %: the highest of 5 sell levels buys 4 steps above the center price, so
    // step ≥ 60000 × r / (1 − 4 × r) = 121.0898…, and without a sell level the BUY next to the center price, at 60000 − step, so
    // step ≥ 60000 × r / (1 + r) = 119.8801…
    it.each`
      center   | sellLevels | marketData                                               | description                                                                             | expected
      ${60000} | ${5}       | ${tenthPercentFeeMarketData}                             | ${'5 sell levels at 60000, a maker fee of 0.1 %: 121.0898… rounded up to the cent'}     | ${121.09}
      ${60000} | ${0}       | ${tenthPercentFeeMarketData}                             | ${'no sell level: 119.8801… rounded up to the cent'}                                    | ${119.89}
      ${60000} | ${5}       | ${{ fee: { maker: 0.001 } }}                             | ${'a market that states no tick: rounded up to DEFAULT_PRICE_PRECISION, 8 decimals'}    | ${121.08980828}
      ${60000} | ${5}       | ${{}}                                                    | ${'a market that states neither a tick nor a fee: one tick of 8 decimals'}              | ${1e-8}
      ${60000} | ${5}       | ${{ precision: { price: 0.05 }, fee: { maker: 0.001 } }} | ${'a tick of 0.05, not one unit of a decimal: rounded up to it'}                        | ${121.1}
      ${60000} | ${5}       | ${{ precision: { price: 0.5 }, fee: { maker: 0.001 } }}  | ${'a tick of 0.5: rounded up to it'}                                                    | ${121.5}
      ${20000} | ${2}       | ${significantDigitsMarketData}                           | ${'2 sell levels at 20000 on 5 significant digits: 16.0192… rounded up to a tick of 1'} | ${17}
      ${60000} | ${500}     | ${tenthPercentFeeMarketData}                             | ${'500 sell levels, 499 × r = 0.999 under 1: twice the center price'}                   | ${120000.01}
    `('is $expected for $description', ({ center, sellLevels, marketData, expected }) => {
      expect(getMinimumStep(center, sellLevels, marketData)).toBe(expected);
    });

    // A step under a tick rounds two adjacent prices to one (see checkPriceTick): one tick at least, and one tick where no fee calls for
    // more, or where no step breaks even, which checkRoundTripFee then warns of as for any grid
    it.each`
      center   | sellLevels | marketData                                                 | description
      ${60000} | ${5}       | ${{ precision: { price: 0.01 } }}                          | ${'a market without a fee'}
      ${60000} | ${5}       | ${{ precision: { price: 0.01 }, fee: { taker: 0.001 } }}   | ${'a taker fee only, which the LIMIT orders of the grid do not pay'}
      ${60000} | ${5}       | ${{ precision: { price: 0.01 }, fee: { maker: -0.0001 } }} | ${'a maker rebate, at which every step breaks even'}
      ${0}     | ${5}       | ${tenthPercentFeeMarketData}                               | ${'a center price of 0'}
      ${NaN}   | ${5}       | ${tenthPercentFeeMarketData}                               | ${'a center price that is not a number'}
      ${60000} | ${501}     | ${tenthPercentFeeMarketData}                               | ${'501 sell levels, 500 × r over 1: no step breaks even'}
    `('is one tick, 0.01, for $description', ({ center, sellLevels, marketData }) => {
      expect(getMinimumStep(center, sellLevels, marketData)).toBe(0.01);
    });

    // Worked out on the prices as they are spaced, the step was taken for the minimum while the orders, each placed at its price rounded
    // to the tick there, lost money: 8.1 around 9999 on 5 significant digits put the highest SELL of 2 at 10015, 8 above its BUY at 10007
    // (10015.2 and 10007.1 on the tick of 1 from 10000 on), which checkRoundTripFee warned of right after its step was said to break even.
    // Raised to whole numbers of the tick at the highest price of the grid, until no level loses money as checkRoundTripFee reckons it
    it.each`
      center    | sellLevels | marketData                     | description                                                                                  | expected
      ${9999}   | ${2}       | ${significantDigitsMarketData} | ${'2 sell levels around 9999, where 8.1 lost: 9, its SELLs at 10008 and 10017'}              | ${9}
      ${9999}   | ${5}       | ${significantDigitsMarketData} | ${'5 sell levels around 9999, where 8.1 lost on 4 levels: 9'}                                | ${9}
      ${9994.4} | ${1}       | ${significantDigitsMarketData} | ${'a sell level around 9994.4, where 8 put its SELL at 10002, 7.6 above its BUY: 9'}         | ${9}
      ${9999.4} | ${1}       | ${significantDigitsMarketData} | ${'a sell level around 9999.4, where 8.1 puts its SELL at 10008, up from 10007.5: 8.1 kept'} | ${8.1}
      ${0.9999} | ${5}       | ${aroundOneMarketData}         | ${'5 sell levels around 0.9999, where 0.00081 put 4 of 10 levels under the fee: 0.0009'}     | ${0.0009}
    `('is $expected for $description', ({ center, sellLevels, marketData, expected }) => {
      expect(getMinimumStep(center, sellLevels, marketData)).toBe(expected);
    });

    // Its break-even exactly, which binary read as a loss, so that the step was raised a tick, to 3.31: the products a level compares are
    // compared within compareWithTolerance's tolerance, as checkRoundTripFee compares them
    it('is 3.3 for a sell level around 4123.35 at 0.04 %, its break-even exactly', () => {
      expect(getMinimumStep(4123.35, 1, exactBreakEvenMarketData)).toBe(3.3);
    });

    // Beyond the largest number, the prices of its grid are 0 (see roundPrice), and a step raised by a tick no longer grows
    it('is the step worked out, not raised, for a center price whose grid passes the largest number', () => {
      expect(getMinimumStep(1.79e308, 5, tenthPercentFeeMarketData)).toBe(3.61251261352169e305);
    });

    // As the strategy checks the grid it builds: at the minimum, checkRoundTripFee finds no level losing money, and one tick under it the
    // levels that earn the least for the step lose, the highest first, or without a sell level the BUY next to the center price. On 5
    // significant digits, that tick is the one at the highest price of the grid: 1 from 10000 on, 0.0001 from 1 on
    describe.each`
      center    | buyLevels | sellLevels | marketData                     | description                     | under     | losing
      ${60000}  | ${5}      | ${5}       | ${tenthPercentFeeMarketData}   | ${'a 5/5 grid at 60000, 0.1 %'} | ${121.08} | ${'1 out of 10 here, the narrowest selling at 60605.4, 0.2002 % above its buy at 60484.32'}
      ${60000}  | ${5}      | ${0}       | ${tenthPercentFeeMarketData}   | ${'a grid of buy levels only'}  | ${119.88} | ${'1 out of 5 here, the narrowest selling at 60000, 0.2002 % above its buy at 59880.12'}
      ${9999}   | ${2}      | ${2}       | ${significantDigitsMarketData} | ${'a 2/2 grid around 9999'}     | ${8}      | ${'2 out of 4 here, the narrowest selling at 10015, 0.07994 % above its buy at 10007'}
      ${0.9999} | ${5}      | ${5}       | ${aroundOneMarketData}         | ${'a 5/5 grid around 0.9999'}   | ${0.0008} | ${'5 out of 10 here, the narrowest selling at 1.0039, 0.07975 % above its buy at 1.0031'}
    `('for $description', ({ center, buyLevels, sellLevels, marketData, under, losing }) => {
      const gridSpacedBy = (spacingValue: number): GridLayout => ({ buyLevels, sellLevels, spacingType: 'fixed', spacingValue });

      it('leaves no level losing money at each round trip: checkRoundTripFee is null', () => {
        expect(checkRoundTripFee(gridSpacedBy(getMinimumStep(center, sellLevels, marketData)), center, marketData)).toBeNull();
      });

      it(`is the smallest: spaced by ${under}, the grid loses money at each round trip, ${losing}`, () => {
        expect(checkRoundTripFee(gridSpacedBy(under), center, marketData)).toContain(`loses money at each round trip, ${losing}`);
      });
    });
  });

  describe('resolveSpacing', () => {
    // On a market without a fee, whose minimum step is one tick: the step resolved as it is, unraised
    const withoutFee: MarketData = { precision: { price: 0.01 } };
    const atrSpacedBy = (spacingValue: number, sellLevels = 5) => ({ sellLevels, spacingType: 'atr' as const, spacingValue });

    // The ATR is read by an atr spacing only
    it.each`
      spacingType      | spacingValue
      ${'percent'}     | ${1}
      ${'fixed'}       | ${100}
      ${'logarithmic'} | ${0.01}
    `(
      'is the configured $spacingType spacing as it is, without a description or a warning, whatever the ATR',
      ({ spacingType, spacingValue }) => {
        expect(resolveSpacing({ sellLevels: 5, spacingType, spacingValue }, 60000, tenthPercentFeeMarketData, 32)).toStrictEqual({
          spacing: { spacingType, spacingValue },
        });
      },
    );

    // To the nearest tick at the center price, a tie upwards, as the prices are (see roundPrice), the product read as it is written
    it.each`
      spacingValue | atr                  | description                                                                  | expected
      ${1.5}       | ${32.00714285714286} | ${'48.0107…, down to the nearest tick'}                                      | ${48.01}
      ${2}         | ${16.0049}           | ${'32.0098, up to the nearest tick'}                                         | ${32.01}
      ${1}         | ${48.005}            | ${'48.005, a tie upwards'}                                                   | ${48.01}
      ${0.3}       | ${2.25}              | ${'0.675, a tie upwards, though 0.3 × 2.25 is 0.6749999999999999 in binary'} | ${0.68}
    `('is a fixed step of $expected for spacingValue $spacingValue × ATR $atr: $description', ({ spacingValue, atr, expected }) => {
      expect(resolveSpacing(atrSpacedBy(spacingValue), 60000, withoutFee, atr).spacing.spacingValue).toBe(expected);
    });

    // The description names the step and its origin for the messages of the checks (see describeSpacing), the ATR to 6 significant
    // digits. A step at or above the minimum (see getMinimumStep), 121.09 at 60000 on a maker fee of 0.1 %, is kept as it is.
    it.each`
      atr                  | marketData                   | step      | description                                                            | expected
      ${32.00714285714286} | ${withoutFee}                | ${48.01}  | ${'a step of 48.01, 1.5 × an ATR of 32.00714285714286, without a fee'} | ${'a step of 48.01 (spacingValue 1.5 × ATR 32.0071, atr)'}
      ${123.456789}        | ${withoutFee}                | ${185.19} | ${'a step of 185.19, 1.5 × an ATR of 123.456789, without a fee'}       | ${'a step of 185.19 (spacingValue 1.5 × ATR 123.457, atr)'}
      ${100}               | ${tenthPercentFeeMarketData} | ${150}    | ${'a step of 150, above the minimum step of 121.09'}                   | ${'a step of 150 (spacingValue 1.5 × ATR 100, atr)'}
      ${80.72666666666667} | ${tenthPercentFeeMarketData} | ${121.09} | ${'a step of 121.09, the minimum step itself'}                         | ${'a step of 121.09 (spacingValue 1.5 × ATR 80.7267, atr)'}
    `('keeps $description, described as $expected, without a warning', ({ atr, marketData, step, expected }) => {
      expect(resolveSpacing(atrSpacedBy(1.5), 60000, marketData, atr)).toStrictEqual({
        spacing: { spacingType: 'fixed', spacingValue: step, description: expected },
      });
    });

    /** A step of spacingValue 1.5 × `atr` at 60000, `step` on the tick of 0.01, raised to `minimum`, its warning ending `instead` */
    const raised = (atr: number, step: number, minimum: number, instead: string) => ({
      spacing: {
        spacingType: 'fixed',
        spacingValue: minimum,
        description: `a step of ${minimum} (the minimum step, spacingValue 1.5 × ATR ${atr} giving ${step}, atr)`,
      },
      warning: `ATR spacing: spacingValue 1.5 × ATR ${atr} is a step of ${step} on the price tick 0.01, ${instead}`,
    });
    const underTheFee =
      'under 121.09, the minimum step at which every level of the grid breaks even on the maker fee of 0.001 (fee.maker): the grid is spaced by 121.09 instead';
    const underTheTick = 'under the price tick: the grid is spaced by one tick, 0.01, instead';

    // A lull in the volatility would space the grid under the round-trip fee, or under the tick: raised to the minimum step, with a
    // warning naming the step, the tick and the minimum
    it.each`
      atr      | marketData                   | description                                                  | expected
      ${0.004} | ${tenthPercentFeeMarketData} | ${'a step of 0.01, under the minimum step of 121.09'}        | ${raised(0.004, 0.01, 121.09, underTheFee)}
      ${0.002} | ${tenthPercentFeeMarketData} | ${'a step rounded to 0, under the minimum step of 121.09'}   | ${raised(0.002, 0, 121.09, underTheFee)}
      ${0.002} | ${withoutFee}                | ${'a step rounded to 0 without a fee, under the price tick'} | ${raised(0.002, 0, 0.01, underTheTick)}
    `('raises $description, with a warning', ({ atr, marketData, expected }) => {
      expect(resolveSpacing(atrSpacedBy(1.5), 60000, marketData, atr)).toStrictEqual(expected);
    });

    // Where no step breaks even, the minimum is one tick too (see getMinimumStep): the warning, chosen by the fee alone, called that tick
    // the minimum step at which every level breaks even, right before checkRoundTripFee warned that every level loses money
    const noStepBreaksEven = (fee: number, levels: string) =>
      `${underTheTick}; no step breaks even on the maker fee of ${fee} (fee.maker) with ${levels}`;
    it.each`
      center   | sellLevels | marketData                                           | description                                   | instead
      ${60000} | ${501}     | ${tenthPercentFeeMarketData}                         | ${'501 sell levels at 0.1 %, 500 × r over 1'} | ${noStepBreaksEven(0.001, '501 sell levels')}
      ${60000} | ${1}       | ${{ precision: { price: 0.01 }, fee: { maker: 1 } }} | ${'a sell level at a maker fee of 1'}         | ${noStepBreaksEven(1, '1 sell level')}
      ${0}     | ${5}       | ${tenthPercentFeeMarketData}                         | ${'a center price of 0, which makes no grid'} | ${underTheTick}
    `('raises a step rounded to 0 to one tick, saying why, for $description', ({ center, sellLevels, marketData, instead }) => {
      expect(resolveSpacing(atrSpacedBy(1.5, sellLevels), center, marketData, 0.002)).toStrictEqual(raised(0.002, 0, 0.01, instead));
    });

    // Every figure with every decimal (see formatEveryDecimal): on a token priced under a thousandth of a cent, String wrote its ATR, its
    // tick and its steps with an exponent, 4.5e-8, 1e-8 and 5e-8
    it.each`
      atr       | description                                    | expected
      ${4.5e-8} | ${'a step of 0.00000005, above the minimum'}   | ${{ spacing: { spacingType: 'fixed', spacingValue: 5e-8, description: 'a step of 0.00000005 (spacingValue 1 × ATR 0.000000045, atr)' } }}
      ${3e-9}   | ${'a step rounded to 0, raised to 0.00000003'} | ${{ spacing: { spacingType: 'fixed', spacingValue: 3e-8, description: 'a step of 0.00000003 (the minimum step, spacingValue 1 × ATR 0.000000003 giving 0, atr)' }, warning: 'ATR spacing: spacingValue 1 × ATR 0.000000003 is a step of 0 on the price tick 0.00000001, under 0.00000003, the minimum step at which every level of the grid breaks even on the maker fee of 0.001 (fee.maker): the grid is spaced by 0.00000003 instead' }}
    `('writes every decimal of $description around 0.00001234 on a tick of 0.00000001', ({ atr, expected }) => {
      expect(resolveSpacing(atrSpacedBy(1), 0.00001234, pepeMarketData, atr)).toStrictEqual(expected);
    });

    // Its break-even exactly (see getMinimumStep): raised to 3.31, with a warning that named 3.31 the minimum step at which every level
    // breaks even, while 3.3 did
    it('keeps a step of 3.3 for a sell level around 4123.35 at 0.04 %, its break-even exactly, without a warning', () => {
      expect(resolveSpacing(atrSpacedBy(1, 1), 4123.35, exactBreakEvenMarketData, 3.3)).toStrictEqual({
        spacing: { spacingType: 'fixed', spacingValue: 3.3, description: 'a step of 3.3 (spacingValue 1 × ATR 3.3, atr)' },
      });
    });

    // Its prices above 10000 rounded to the tick of 1 there, a step of 8.5 sells the highest of 2 levels 8 above its buy, under the fee
    it('raises a step of 8.5 around 9999 on 5 significant digits to 9, at which every level breaks even as it trades', () => {
      expect(resolveSpacing(atrSpacedBy(1, 2), 9999, significantDigitsMarketData, 8.5)).toStrictEqual({
        spacing: {
          spacingType: 'fixed',
          spacingValue: 9,
          description: 'a step of 9 (the minimum step, spacingValue 1 × ATR 8.5 giving 8.5, atr)',
        },
        warning:
          'ATR spacing: spacingValue 1 × ATR 8.5 is a step of 8.5 on the price tick 0.1, under 9, the minimum step at which every level of the grid breaks even on the maker fee of 0.0004 (fee.maker): the grid is spaced by 9 instead',
      });
    });

    // A step at or above the minimum step is checked on the prices as the orders are placed, as the minimum is (see getMinimumStep)
    describe('at or above the minimum step', () => {
      // The market of significantDigitsMarketData with a fixed tick of 0.1, at any price
      const fixedTickMarketData: MarketData = { precision: { price: 0.1 }, fee: { maker: 0.0004 } };
      // 5 significant digits at a maker fee of 0.043 %, whose round trip takes a SELL 0.08604 % above its BUY
      const higherFeeMarketData: MarketData = { precision: { price: 0.1, priceSignificantDigits: 5 }, fee: { maker: 0.00043 } };

      // On a fixed tick the prices are exactly a step apart, and on 5 significant digits a step that is a whole number of the tick of 1
      // from 10000 on keeps them so, or the tick rounds them apart by enough: every level breaks even as it trades
      it.each`
        center    | sellLevels | atr    | marketData                     | description                                                                                   | step
        ${9940}   | ${8}       | ${8.3} | ${fixedTickMarketData}         | ${'8.3 for 8 sell levels around 9940 on a fixed tick of 0.1, its highest SELL at 10006.4'}    | ${8.3}
        ${9999}   | ${2}       | ${10}  | ${significantDigitsMarketData} | ${'10 around 9999 on 5 significant digits, a whole number of the tick of 1: 10009 and 10019'} | ${10}
        ${9999}   | ${2}       | ${9.4} | ${significantDigitsMarketData} | ${'9.4 around 9999, its SELLs at 10008 and 10018, 9 and 10 above their BUYs'}                 | ${9.4}
        ${9995.5} | ${1}       | ${8.1} | ${significantDigitsMarketData} | ${'8.1 around 9995.5, its SELL at 10004, 8.5 above its BUY'}                                  | ${8.1}
      `('keeps a step of $description, without a warning', ({ center, sellLevels, atr, marketData, step }) => {
        expect(resolveSpacing(atrSpacedBy(1, sellLevels), center, marketData, atr)).toStrictEqual({
          spacing: { spacingType: 'fixed', spacingValue: step, description: `a step of ${step} (spacingValue 1 × ATR ${atr}, atr)` },
        });
      });

      // Kept as it was, a step at or above the minimum was only compared with it, never checked on its own prices: on 5 significant
      // digits, 8.3 for 8 sell levels around 9940, over the minimum of 8, put the highest SELL at 10006, 7.9 above its BUY at 9998.1
      // (10006.4 on the tick of 1 from 10000 on), under the fee of 0.04 %, which checkRoundTripFee warned of right after
      it('raises a step of 8.3 for 8 sell levels around 9940 on 5 significant digits to 9, a whole number of the tick of 1 from 10000 on', () => {
        expect(resolveSpacing(atrSpacedBy(1, 8), 9940, significantDigitsMarketData, 8.3)).toStrictEqual({
          spacing: {
            spacingType: 'fixed',
            spacingValue: 9,
            description: 'a step of 9 (spacingValue 1 × ATR 8.3 giving 8.3, raised on the price tick 1, atr)',
          },
          warning:
            'ATR spacing: spacingValue 1 × ATR 8.3 is a step of 8.3 on the price tick 0.1, at which a level of the grid loses money on the maker fee of 0.0004 (fee.maker) on the price tick 1 at the top of the grid: the grid is spaced by 9 instead',
        });
      });

      /**
       * A step of spacingValue 1 × `atr`, `atrStep` on the tick `tick` at the center price, raised to `step` on the tick `topTick` at the
       * top of the grid, at a maker fee of `maker`
       */
      const raisedAtTheTop = (atr: number, tick: number, atrStep: number, maker: number, step: number, topTick: number) => ({
        spacing: {
          spacingType: 'fixed',
          spacingValue: step,
          description: `a step of ${step} (spacingValue 1 × ATR ${atr} giving ${atrStep}, raised on the price tick ${topTick}, atr)`,
        },
        warning: `ATR spacing: spacingValue 1 × ATR ${atr} is a step of ${atrStep} on the price tick ${tick}, at which a level of the grid loses money on the maker fee of ${maker} (fee.maker) on the price tick ${topTick} at the top of the grid: the grid is spaced by ${step} instead`,
      });

      // Raised by the tick at the top of the grid until no level loses money there: 0.0001 from 1 on, and twice at a maker fee of 0.043 %,
      // where 9 still sells a level at 10006, 8.6 above its BUY at 9997.4
      it.each`
        center    | sellLevels | atr         | marketData             | description                                                                             | expected
        ${0.994}  | ${8}       | ${0.000828} | ${aroundOneMarketData} | ${'0.00083 around 0.994, over the minimum of 0.0008, to 0.0009'}                        | ${raisedAtTheTop(0.000828, 0.00001, 0.00083, 0.0004, 0.0009, 0.0001)}
        ${9961.4} | ${5}       | ${8.8}      | ${higherFeeMarketData} | ${'8.8 around 9961.4 at a maker fee of 0.043 %, over the minimum of 8.7, twice: to 10'} | ${raisedAtTheTop(8.8, 0.1, 8.8, 0.00043, 10, 1)}
      `('raises a step of $description, with a warning', ({ center, sellLevels, atr, marketData, expected }) => {
        expect(resolveSpacing(atrSpacedBy(1, sellLevels), center, marketData, atr)).toStrictEqual(expected);
      });

      // As the strategy checks the grid it builds (see checkRoundTripFee), 2 buy levels below the center price
      it.each`
        center    | sellLevels | atr         | marketData                     | description
        ${9940}   | ${8}       | ${8.3}      | ${fixedTickMarketData}         | ${'8.3 kept around 9940 on a fixed tick'}
        ${9999}   | ${2}       | ${10}       | ${significantDigitsMarketData} | ${'10 kept around 9999'}
        ${9999}   | ${2}       | ${9.4}      | ${significantDigitsMarketData} | ${'9.4 kept around 9999'}
        ${9995.5} | ${1}       | ${8.1}      | ${significantDigitsMarketData} | ${'8.1 kept around 9995.5'}
        ${9940}   | ${8}       | ${8.3}      | ${significantDigitsMarketData} | ${'8.3 raised to 9 around 9940'}
        ${0.994}  | ${8}       | ${0.000828} | ${aroundOneMarketData}         | ${'0.00083 raised to 0.0009 around 0.994'}
        ${9961.4} | ${5}       | ${8.8}      | ${higherFeeMarketData}         | ${'8.8 raised to 10 around 9961.4'}
      `(
        'leaves no level losing money at each round trip on the step resolved, $description: checkRoundTripFee is null',
        ({ center, sellLevels, atr, marketData }) => {
          const { spacing } = resolveSpacing(atrSpacedBy(1, sellLevels), center, marketData, atr);

          expect(checkRoundTripFee({ buyLevels: 2, sellLevels, ...spacing }, center, marketData)).toBeNull();
        },
      );

      // The grids the steps raised would have been: the level astride the tick of 1 from 10000 on, or of 0.0001 from 1 on, loses money
      it.each`
        center    | sellLevels | marketData                     | step       | description                    | losing
        ${9940}   | ${8}       | ${significantDigitsMarketData} | ${8.3}     | ${'8.3 around 9940'}           | ${'1 out of 10 here, the narrowest selling at 10006, 0.07902 % above its buy at 9998.1'}
        ${0.994}  | ${8}       | ${aroundOneMarketData}         | ${0.00083} | ${'0.00083 around 0.994'}      | ${'1 out of 10 here, the narrowest selling at 1.0006, 0.07902 % above its buy at 0.99981'}
        ${9961.4} | ${5}       | ${higherFeeMarketData}         | ${9}       | ${'9, the first raise of 8.8'} | ${'1 out of 7 here, the narrowest selling at 10006, 0.08602 % above its buy at 9997.4'}
      `(
        'is right to raise $description: spaced by it, the grid loses money at each round trip, $losing',
        ({ center, sellLevels, marketData, step, losing }) => {
          const asItWas: GridLayout = { buyLevels: 2, sellLevels, spacingType: 'fixed', spacingValue: step };

          expect(checkRoundTripFee(asItWas, center, marketData)).toContain(`loses money at each round trip, ${losing}`);
        },
      );
    });

    // The strategy refuses to start before the ATR has a value, but a candle whose ATR is not a number leaves it null
    it.each`
      atr
      ${null}
      ${undefined}
      ${NaN}
      ${Infinity}
    `('takes an ATR of $atr for 0, a step raised to the minimum', ({ atr }) => {
      expect(resolveSpacing(atrSpacedBy(1.5), 60000, tenthPercentFeeMarketData, atr)).toStrictEqual(raised(0, 0, 121.09, underTheFee));
    });
  });

  // GridBot used to raise an amount to amount.min, or to cost.min at its price, left unrounded: CCXTExchange truncated it to the
  // amount step, under cost.min again, and the exchange refused it
  describe('getMinimumAmount', () => {
    it.each`
      price       | marketData                                                                       | description                                                                          | expected
      ${100}      | ${{ precision: { amount: 0.01 } }}                                               | ${'no limit: one amount step'}                                                       | ${0.01}
      ${100}      | ${{}}                                                                            | ${'no limit and no precision: one step of 8 decimals'}                               | ${1e-8}
      ${100}      | ${{ amount: { min: 0, max: 0 }, cost: { min: 0 }, precision: { amount: 0.01 } }} | ${'limits of 0, which bound nothing: one amount step'}                               | ${0.01}
      ${100}      | ${{ amount: { min: 0.1 }, precision: { amount: 0.01 } }}                         | ${'amount.min'}                                                                      | ${0.1}
      ${100}      | ${{ amount: { min: 0.015 }, precision: { amount: 0.01 } }}                       | ${'amount.min off the amount step, rounded up to it'}                                | ${0.02}
      ${58172.83} | ${{ cost: { min: 5 }, precision: { amount: 0.00001 } }}                          | ${'cost.min / price, 0.0000859507…, rounded up to the amount step'}                  | ${0.00009}
      ${58172.83} | ${{ amount: { min: 0.0001 }, cost: { min: 5 }, precision: { amount: 0.00001 } }} | ${'the larger of amount.min and cost.min / price'}                                   | ${0.0001}
      ${50000}    | ${{ cost: { min: 5 }, precision: { amount: 1e-8 } }}                             | ${'cost.min / price exactly, 0.0001 × 50000 being 5 in floating point'}              | ${0.0001}
      ${100000}   | ${{ cost: { min: 7 }, precision: { amount: 1e-8 } }}                             | ${'cost.min / price exactly, 0.00007 × 100000 being 7 in decimal'}                   | ${0.00007}
      ${0.000001} | ${dogeBtcMarketData}                                                             | ${'cost.min / price exactly, 100, though 0.0001 / 0.000001 is 100.00000000000001'}   | ${100}
      ${8e-7}     | ${dogeBtcMarketData}                                                             | ${'cost.min / price exactly, 125, though 0.0001 / 8e-7 is 125.00000000000001'}       | ${125}
      ${0}        | ${{ cost: { min: 5 }, precision: { amount: 0.01 } }}                             | ${'a price of 0, which sets no amount from cost.min: one amount step'}               | ${0.01}
      ${1}        | ${{ cost: { min: 5 }, precision: { amount: 10 } }}                               | ${'cost.min / price on an amount step of 10: 10, not the 5 the exchange sends as 0'} | ${10}
      ${1}        | ${{ amount: { min: 0.7 }, precision: { amount: 0.5 } }}                          | ${'amount.min rounded up to a step of 0.5: 1, not 0.7'}                              | ${1}
    `('is $expected for $description', ({ price, marketData, expected }) => {
      expect(getMinimumAmount(price, marketData)).toBe(expected);
    });

    // As the order layer checks an order, its cost worked out in decimal (see assertOrderWithinLimits): the minimum is taken, and one
    // step under it is not
    describe.each`
      price        | marketData                                           | step
      ${58172.83}  | ${binanceStepsMarketData}                            | ${0.00001}
      ${61234.57}  | ${documentedMarketData}                              | ${1e-8}
      ${100000}    | ${{ cost: { min: 7 }, precision: { amount: 1e-8 } }} | ${1e-8}
      ${800000}    | ${{ cost: { min: 7 }, precision: { amount: 1e-8 } }} | ${1e-8}
      ${0.0001234} | ${{ cost: { min: 5 }, precision: { amount: 1 } }}    | ${1}
      ${0.000001}  | ${dogeBtcMarketData}                                 | ${1}
      ${8e-7}      | ${dogeBtcMarketData}                                 | ${1}
    `('at $price', ({ price, marketData, step }) => {
      it('is an amount the order layer takes', () => {
        const amount = getMinimumAmount(price, marketData);
        expect(() => assertOrderWithinLimits({ tag: 'strategy', amount, price, marketData })).not.toThrow();
      });

      it('is the smallest: the order layer refuses one step less', () => {
        const amount = addPrecise(getMinimumAmount(price, marketData), -step);
        expect(() => assertOrderWithinLimits({ tag: 'strategy', amount, price, marketData })).toThrow(OrderOutOfRangeError);
      });
    });
  });

  describe('getMaximumAmount', () => {
    it.each`
      price     | marketData                                                                  | description                                                        | expected
      ${100}    | ${{ precision: { amount: 0.01 } }}                                          | ${'no limit'}                                                      | ${Infinity}
      ${100}    | ${{ amount: { max: 0 }, cost: { max: 0 } }}                                 | ${'limits of 0, which bound nothing'}                              | ${Infinity}
      ${100}    | ${{ amount: { max: 10 }, precision: { amount: 0.01 } }}                     | ${'amount.max'}                                                    | ${10}
      ${300}    | ${{ cost: { max: 1000 }, precision: { amount: 0.01 } }}                     | ${'cost.max / price, 3.333…, rounded down to the amount step'}     | ${3.33}
      ${300}    | ${{ amount: { max: 3 }, cost: { max: 1000 }, precision: { amount: 0.01 } }} | ${'the smaller of amount.max and cost.max / price'}                | ${3}
      ${300000} | ${{ cost: { max: 3 }, precision: { amount: 1e-8 } }}                        | ${'cost.max / price exactly, 0.00001 × 300000 being 3 in decimal'} | ${0.00001}
      ${100}    | ${{ amount: { max: 4705 }, precision: { amount: 10 } }}                     | ${'amount.max rounded down to a step of 10: 4700, not 4705'}       | ${4700}
    `('is $expected for $description', ({ price, marketData, expected }) => {
      expect(getMaximumAmount(price, marketData)).toBe(expected);
    });

    // As the order layer checks an order, its cost worked out in decimal (see assertOrderWithinLimits): the maximum is taken, and one
    // step over it is not
    describe.each`
      price       | marketData                                              | step
      ${300}      | ${{ cost: { max: 1000 }, precision: { amount: 0.01 } }} | ${0.01}
      ${300000}   | ${{ cost: { max: 3 }, precision: { amount: 1e-8 } }}    | ${1e-8}
      ${61234.57} | ${documentedMarketData}                                 | ${1e-8}
      ${58172.83} | ${binanceStepsMarketData}                               | ${0.00001}
      ${100}      | ${{ amount: { max: 10 }, precision: { amount: 0.01 } }} | ${0.01}
    `('at $price', ({ price, marketData, step }) => {
      it('is an amount the order layer takes', () => {
        const amount = getMaximumAmount(price, marketData);
        expect(() => assertOrderWithinLimits({ tag: 'strategy', amount, price, marketData })).not.toThrow();
      });

      it('is the largest: the order layer refuses one step more', () => {
        const amount = addPrecise(getMaximumAmount(price, marketData), step);
        expect(() => assertOrderWithinLimits({ tag: 'strategy', amount, price, marketData })).toThrow(OrderOutOfRangeError);
      });
    });
  });

  // StickyOrder places a BUY one minimum price above the bid, a SELL one below the ask
  describe('getRebalanceOrderPrice', () => {
    it.each`
      side      | marketData                  | description                  | expected
      ${'BUY'}  | ${{ price: { min: 0.01 } }} | ${'a minimum price of 0.01'} | ${100.01}
      ${'SELL'} | ${{ price: { min: 0.01 } }} | ${'a minimum price of 0.01'} | ${99.99}
      ${'BUY'}  | ${{}}                       | ${'no minimum price'}        | ${100}
      ${'SELL'} | ${{}}                       | ${'no minimum price'}        | ${100}
    `('is $expected for a $side planned at 100, on a market with $description', ({ side, marketData, expected }) => {
      expect(getRebalanceOrderPrice(side, 100, marketData)).toBe(expected);
    });

    it.each`
      side      | price       | description                                   | expected
      ${'BUY'}  | ${101.2}    | ${'101.2 + 0.01 being 101.21000000000001'}    | ${101.21}
      ${'SELL'} | ${61234.56} | ${'61234.56 - 0.01 being 61234.549999999996'} | ${61234.55}
    `('is $expected for a $side planned at $price, worked out in decimal: $description', ({ side, price, expected }) => {
      expect(getRebalanceOrderPrice(side, price, { price: { min: 0.01 } })).toBe(expected);
    });
  });

  describe('getMakerFee', () => {
    it.each`
      fee                                 | description                    | expected
      ${{ maker: 0.0004, taker: 0.0007 }} | ${'a maker fee'}               | ${0.0004}
      ${{ taker: 0.0007 }}                | ${'a taker fee, but no maker'} | ${0}
      ${undefined}                        | ${'no fee'}                    | ${0}
    `('is $expected on a market that states $description', ({ fee, expected }) => {
      expect(getMakerFee({ fee })).toBe(expected);
    });
  });

  // What the simulator reserves for a STICKY BUY: StickyOrder places it one minimum price above the bid, the maker fee on top
  describe('getRebalanceBuyCost', () => {
    it.each`
      marketData                                          | description                          | expected
      ${{ price: { min: 0.01 }, fee: { maker: 0.0004 } }} | ${'a minimum price and a maker fee'} | ${1000.50004}
      ${{ price: { min: 0.01 } }}                         | ${'a minimum price, but no fee'}     | ${1000.1}
      ${{}}                                               | ${'neither'}                         | ${1000}
    `('is $expected for 10 planned at 100, on a market that states $description', ({ marketData, expected }) => {
      expect(getRebalanceBuyCost(10, 100, marketData)).toBe(expected);
    });

    // Reckoned in binary, the cost of a BUY the free currency paid exactly came out over it, and the strategy left the BUY out
    it.each`
      amount   | price     | marketData                                          | description                                               | expected
      ${0.27}  | ${100}    | ${{ price: { min: 0.01 } }}                         | ${'0.27 at 100.01, 27.002700000000004 in binary'}         | ${27.0027}
      ${0.019} | ${2500.5} | ${{ price: { min: 0.01 }, fee: { maker: 0.0004 } }} | ${'0.019 at 2500.51, the fee on top, 47.528693876000006'} | ${47.528693876}
    `('is $expected, worked out in decimal: $description', ({ amount, price, marketData, expected }) => {
      expect(getRebalanceBuyCost(amount, price, marketData)).toBe(expected);
    });
  });

  describe('getGridFunding', () => {
    it.each`
      center | grid                                                                               | marketData                        | description                                                        | expected
      ${100} | ${{ buyLevels: 2, sellLevels: 2, spacingType: 'fixed', spacingValue: 5 }}          | ${{}}                             | ${'2/2 spaced by 5: a unit for each SELL, the BUYs at 95 and 90'}  | ${{ asset: 2, currency: 185 }}
      ${100} | ${{ buyLevels: 1, sellLevels: 3, spacingType: 'fixed', spacingValue: 5 }}          | ${{}}                             | ${'1/3 spaced by 5'}                                               | ${{ asset: 3, currency: 95 }}
      ${100} | ${{ buyLevels: 5, sellLevels: 5, spacingType: 'percent', spacingValue: 1 }}        | ${documentedMarketData}           | ${'5/5 spaced by 1 %, the maker fee of 0.0004 on top of the BUYs'} | ${{ asset: 5, currency: 485 * 1.0004 }}
      ${100} | ${{ buyLevels: 5, sellLevels: 0, spacingType: 'percent', spacingValue: 1 }}        | ${{}}                             | ${'a buy-only grid'}                                               | ${{ asset: 0, currency: 485 }}
      ${100} | ${{ buyLevels: 0, sellLevels: 5, spacingType: 'percent', spacingValue: 1 }}        | ${documentedMarketData}           | ${'a sell-only grid'}                                              | ${{ asset: 5, currency: 0 }}
      ${100} | ${{ buyLevels: 1, sellLevels: 1, spacingType: 'logarithmic', spacingValue: 0.05 }} | ${{ precision: { price: 0.01 } }} | ${'a BUY at 95.24, rounded to the tick as it is placed'}           | ${{ asset: 1, currency: 95.24 }}
      ${10}  | ${{ buyLevels: 5, sellLevels: 2, spacingType: 'fixed', spacingValue: 5 }}          | ${{}}                             | ${'the BUYs priced above 0 only: 5, not 0 and below'}              | ${{ asset: 2, currency: 5 }}
    `('takes $expected a unit of the quantity of a level for $description', ({ center, grid, marketData, expected }) => {
      expect(getGridFunding(center, grid, marketData)).toEqual(expected);
    });

    // As they are placed, at the tick of 1 of 5 significant digits from 10000 on: 10048.5 is 10049 there
    it('takes the BUYs at their prices on a market that takes 5 significant digits in a price: 10049 and 10047 around 10050', () => {
      const buyOnly = { buyLevels: 2, sellLevels: 0, spacingType: 'fixed', spacingValue: 1.5 } as const;

      expect(getGridFunding(10050, buyOnly, { precision: { price: 0.1, priceSignificantDigits: 5 } })).toEqual({
        asset: 0,
        currency: 20096,
      });
    });
  });

  describe('computeRebalancePlan', () => {
    const marketData: MarketData = { precision: { amount: 0.01 } };
    // A unit of the quantity of a level takes 2 BTC, one for each SELL, and 185 USDT, its BUYs at 95 and 90
    const twoByTwo = { buyLevels: 2, sellLevels: 2, spacingType: 'fixed', spacingValue: 5 } as const;
    const fiveByFive = { buyLevels: 5, sellLevels: 5, spacingType: 'percent', spacingValue: 1 } as const;
    const sellOnly = (sellLevels: number) => ({ ...fiveByFive, buyLevels: 0, sellLevels });

    it('returns BUY plan when asset value is low for symmetric levels', () => {
      expect(computeRebalancePlan(100, 0, 1000, twoByTwo, marketData)?.side).toBe('BUY');
    });

    it('returns SELL plan when asset value is high', () => {
      expect(computeRebalancePlan(100, 10, 0, twoByTwo, marketData)?.side).toBe('SELL');
    });

    // 2.5 a level: 5 BTC for its SELLs, 462.5 USDT for its BUYs
    it('returns null for a portfolio at the split that funds every level alike', () => {
      expect(computeRebalancePlan(100, 5, 462.5, twoByTwo, marketData)).toBeNull();
    });

    // 1000 USDT fund 1.015 a level on 2/8 levels: 8.12 BTC for the SELLs, the rest for the BUYs at 95 and 90
    it('computes correct ratio for asymmetric levels', () => {
      expect(computeRebalancePlan(100, 0, 1000, { ...twoByTwo, sellLevels: 8 }, marketData)?.amount).toBe(8.12);
    });

    it('returns null for zero center price', () => {
      expect(computeRebalancePlan(0, 0, 1000, twoByTwo, marketData)).toBeNull();
    });

    it('returns null for zero levels', () => {
      expect(computeRebalancePlan(100, 5, 500, { ...twoByTwo, buyLevels: 0, sellLevels: 0 }, marketData)).toBeNull();
    });

    it('returns null for empty portfolio', () => {
      expect(computeRebalancePlan(100, 0, 0, twoByTwo, marketData)).toBeNull();
    });

    it('applies amount limits', () => {
      const marketDataWithMax: MarketData = { amount: { max: 10 }, precision: { amount: 0.01 } };

      expect(computeRebalancePlan(100, 0, 10000, twoByTwo, marketDataWithMax)?.amount).toBe(10);
    });

    // 1000 at the price of its STICKY order, 100.01, is 9.99900…: at the center price it would be 10, refused for a cost of 1000.1
    it('caps the amount at the market maximum at the price its STICKY order is placed at', () => {
      const marketDataWithMaxCost: MarketData = { cost: { max: 1000 }, price: { min: 0.01 }, precision: { amount: 0.01 } };

      expect(computeRebalancePlan(100, 0, 10000, twoByTwo, marketDataWithMaxCost)?.amount).toBe(9.99);
    });

    // An amount under amount.min used to be raised to it, beyond what the gap called for and what the balances paid: 1 USDT held
    // planned a BUY of 0.1, 10 USDT. Under the market's minimum, a plan is no order to send: the strategy leaves it out
    it.each`
      center      | assetFree  | currencyFree | grid                                            | marketData                                                | description                                                           | expected
      ${100}      | ${0}       | ${1}         | ${{ ...twoByTwo, buyLevels: 1, sellLevels: 1 }} | ${{ precision: { amount: 0.001 }, amount: { min: 0.1 } }} | ${'a BUY of 0.005, under amount.min 0.1'}                             | ${0.005}
      ${61234.56} | ${0.00235} | ${146}       | ${fiveByFive}                                   | ${documentedMarketData}                                   | ${'a BUY of 3.23 USDT, under cost.min 5, a small account 2.2 % idle'} | ${0.0000527}
    `('plans $description as it is', ({ center, assetFree, currencyFree, grid, marketData, expected }) => {
      expect(computeRebalancePlan(center, assetFree, currencyFree, grid, marketData)?.amount).toBe(expected);
    });

    // A sell-only grid wants the whole value in the asset: started in currency, it planned a BUY of the whole currency at the center
    // price, which the simulator refused at every attempt, its STICKY order placed one minimum price above the bid and the maker fee on
    // top, and the run stopped before any grid was built. All in currency here, the plans are BUYs.
    describe('in currency, on a market with a minimum price and a maker fee', () => {
      it.each`
        center      | grid           | marketData                         | description                                                                | expected
        ${100}      | ${sellOnly(5)} | ${documentedMarketData}            | ${'a sell-only grid'}                                                      | ${9.99500209}
        ${61234.56} | ${sellOnly(3)} | ${tenthPercentFeeMarketData}       | ${'a sell-only grid, at a 0.1 % maker fee'}                                | ${0.01631}
        ${100}      | ${fiveByFive}  | ${documentedMarketData}            | ${'a 5/5 grid spaced by 1 %, the split that funds it'}                     | ${5.07385493}
        ${100}      | ${sellOnly(5)} | ${{ precision: { amount: 1e-8 } }} | ${'a sell-only grid, on a market that states neither: the whole currency'} | ${10}
      `('plans a BUY of $expected for $description', ({ center, grid, marketData, expected }) => {
        expect(computeRebalancePlan(center, 0, 1000, grid, marketData)?.amount).toBe(expected);
      });

      it.each`
        center      | grid           | marketData                   | description
        ${100}      | ${sellOnly(5)} | ${documentedMarketData}      | ${'a sell-only grid'}
        ${61234.56} | ${sellOnly(3)} | ${tenthPercentFeeMarketData} | ${'a sell-only grid, at a 0.1 % maker fee'}
        ${100}      | ${fiveByFive}  | ${documentedMarketData}      | ${'a 5/5 grid'}
      `(
        'plans a BUY the currency pays at the price of its STICKY order, the maker fee on top, for $description',
        ({ center, grid, marketData }) => {
          const { amount } = computeRebalancePlan(center, 0, 1000, grid, marketData)!;

          expect(amount * (center + marketData.price.min) * (1 + marketData.fee.maker)).toBeLessThanOrEqual(1000);
        },
      );

      // A whole number of steps at 100.01, the price of the STICKY BUY, its cost worked out in decimal, as the simulator books it and
      // the exchange charges it. Divided in binary, 7.0007 / 100.01 was 0.06999999999999999, a BUY of 0.06; and reckoned in binary,
      // 0.27 cost 27.002700000000004, more than the 27.0027 free, which the strategy then left out for insufficient currency
      describe('on currency paying a whole number of amount steps', () => {
        const cents: MarketData = { price: { min: 0.01 }, precision: { price: 0.01, amount: 0.01 } };

        it.each`
          currency   | description                                                     | expected
          ${4.0004}  | ${'0.04 for 4.0004'}                                            | ${0.04}
          ${7.0007}  | ${'0.07 for 7.0007, 7.0007 / 100.01 being 0.06999999999999999'} | ${0.07}
          ${27.0027} | ${'0.27 for 27.0027, which costs 27.002700000000004 in binary'} | ${0.27}
        `('plans a BUY of all the currency pays, not a step less: $description', ({ currency, expected }) => {
          expect(computeRebalancePlan(100, 0, currency, sellOnly(5), cents)?.amount).toBe(expected);
        });

        it.each`
          currency              | description                                                                       | expected
          ${7.0006}             | ${'0.06 for 7.0006, 0.07 costing 7.0007'}                                         | ${0.06}
          ${29.002899999999997} | ${'0.28 for an ulp under 29.0029, though divided by 100.01 in binary it is 0.29'} | ${0.28}
        `('plans a BUY the currency pays, not a step more: $description', ({ currency, expected }) => {
          expect(computeRebalancePlan(100, 0, currency, sellOnly(5), cents)?.amount).toBe(expected);
        });

        // As the strategy checks it before sending it (see getRebalanceBuyCost): a plan it would leave out is no plan
        it.each`
          currency
          ${7.0007}
          ${27.0027}
          ${51.0051}
        `('plans a BUY whose cost $currency pays, as the strategy checks it', ({ currency }) => {
          const { amount } = computeRebalancePlan(100, 0, currency, sellOnly(5), cents)!;

          expect(getRebalanceBuyCost(amount, 100, cents)).toBeLessThanOrEqual(currency);
        });
      });
    });

    // The rebalance aimed at sellLevels / (buyLevels + sellLevels) of the value in the asset, 50/50 for a symmetric grid. The BUYs,
    // below the center price, cost less than the SELLs are worth, and the grid is sized on its scarcer side: once the asset was split
    // over the sell levels, from 3 % of the currency for 5/5 levels spaced by 1 % to 21 % for 20/20 spaced by 2 % stayed idle, and a
    // portfolio at 50/50 was not rebalanced at all
    describe('to the split that funds every level alike', () => {
      interface Start {
        center: number;
        assetFree: number;
        currencyFree: number;
        grid: GridLayout;
        marketData: MarketData;
      }
      const grid = (buyLevels: number, sellLevels: number, spacingType: GridSpacingType, spacingValue: number) => ({
        buyLevels,
        sellLevels,
        spacingType,
        spacingValue,
      });
      /** At 50/50, 5 BTC and 500 USDT at 100, on a market without fee: V7's grids */
      const fiftyFifty = (start: Start['grid']): Start => ({
        center: 100,
        assetFree: 5,
        currencyFree: 500,
        grid: start,
        marketData: { precision: { price: 0.01, amount: 1e-8 } },
      });
      /** All in currency or all in the asset, on the documented market, a maker fee of 0.0004 and a minimum price of 0.01 */
      const documented = (start: Start['grid'], assetFree: number, currencyFree: number, center = 100): Start => ({
        center,
        assetFree,
        currencyFree,
        grid: start,
        marketData: documentedMarketData,
      });

      /**
       * The value the grid leaves idle once the plan has filled, its STICKY order booked as the simulator books it, at its price with
       * the maker fee: what the quantity of a level does not take, a unit of the asset for each SELL and each BUY's price in currency
       * with the fee on top
       */
      const idleOnceFilled = ({ center, assetFree, currencyFree, grid: start, marketData }: Start) => {
        const plan = computeRebalancePlan(center, assetFree, currencyFree, start, marketData);
        const fee = getMakerFee(marketData);
        const bought = plan ? (plan.side === 'BUY' ? plan.amount : -plan.amount) : 0;
        const paid = plan ? getRebalanceOrderPrice(plan.side, center, marketData) * (plan.side === 'BUY' ? 1 + fee : 1 - fee) : 0;
        const asset = assetFree + bought;
        const currency = currencyFree - bought * paid;
        const { priceDecimals, priceStep } = inferPricePrecision(marketData);
        const { spacingType, spacingValue } = start;
        const size = deriveLevelQuantity(
          center,
          asset,
          currency,
          start.buyLevels,
          start.sellLevels,
          priceDecimals,
          spacingType,
          spacingValue,
          marketData,
          priceStep,
        );
        const buyPrices = Array.from({ length: size.buyLevels }, (_, i) =>
          computeLevelPrice(center, -(i + 1), priceDecimals, spacingType, spacingValue, priceStep),
        );
        const currencyLeft = buyPrices.reduce((left, price) => left - size.quantity * price * (1 + fee), currency);
        return (asset - size.sellLevels * size.quantity) * center + currencyLeft;
      };

      it.each`
        start                                                      | description                                                | expected
        ${fiftyFifty(grid(5, 5, 'percent', 1))}                    | ${'5/5 spaced by 1 %, at 50/50'}                           | ${'BUY 0.07614213'}
        ${fiftyFifty(grid(20, 20, 'percent', 2))}                  | ${'20/20 spaced by 2 %, at 50/50'}                         | ${'BUY 0.58659217'}
        ${documented(grid(5, 5, 'percent', 1), 0, 1000)}           | ${'5/5 spaced by 1 %, all in currency'}                    | ${'BUY 5.07385493'}
        ${documented(grid(5, 5, 'percent', 1), 10, 0)}             | ${'5/5 spaced by 1 %, all in the asset'}                   | ${'SELL 4.92610737'}
        ${documented(grid(1, 3, 'fixed', 5), 0, 1000)}             | ${'1/3 spaced by 5, all in currency: 75.9 % in the asset'} | ${'BUY 7.59132339'}
        ${documented(grid(5, 0, 'percent', 1), 3.3, 0)}            | ${'a buy-only grid: the whole asset, not a step less'}     | ${'SELL 3.3'}
        ${documented(grid(5, 5, 'percent', 1), 0, 1000, 61234.56)} | ${'the documented 5/5 grid, 1000 USDT at 61234.56'}        | ${'BUY 0.00828635'}
      `('plans $expected for $description', ({ start, expected }) => {
        const { center, assetFree, currencyFree, grid: params, marketData } = start;
        const plan = computeRebalancePlan(center, assetFree, currencyFree, params, marketData);

        expect(plan && `${plan.side} ${plan.amount}`).toBe(expected);
      });

      it.each`
        start                                                      | description
        ${fiftyFifty(grid(5, 5, 'percent', 1))}                    | ${'5/5 spaced by 1 %, at 50/50: 3 % of the currency idled'}
        ${fiftyFifty(grid(10, 10, 'percent', 1))}                  | ${'10/10 spaced by 1 %, at 50/50: 5.5 %'}
        ${fiftyFifty(grid(20, 20, 'percent', 1))}                  | ${'20/20 spaced by 1 %, at 50/50: 10.5 %'}
        ${fiftyFifty(grid(20, 20, 'percent', 2))}                  | ${'20/20 spaced by 2 %, at 50/50: 21 %'}
        ${fiftyFifty(grid(20, 20, 'logarithmic', 0.02))}           | ${'20/20 spaced by 0.02 logarithmic, at 50/50: 18.24 %'}
        ${documented(grid(5, 5, 'percent', 1), 0, 1000)}           | ${'5/5 spaced by 1 %, all in currency: 2.91 %'}
        ${documented(grid(5, 5, 'percent', 1), 10, 0)}             | ${'5/5 spaced by 1 %, all in the asset: 2.91 %'}
        ${documented(grid(1, 3, 'fixed', 5), 0, 1000)}             | ${'1/3 spaced by 5, all in currency: 4.82 %'}
        ${documented(grid(3, 1, 'fixed', 5), 0, 1000)}             | ${'3/1 spaced by 5, all in currency: 9.95 %'}
        ${documented(grid(5, 5, 'percent', 1), 0, 1000, 61234.56)} | ${'the documented 5/5 grid, 1000 USDT at 61234.56'}
      `('leaves less than 0.01 % of the value idle once filled, for $description', ({ start }) => {
        const { center, assetFree, currencyFree } = start;

        expect(idleOnceFilled(start)).toBeLessThan(0.0001 * (assetFree * center + currencyFree));
      });
    });

    // The 1 % tolerance used to be on the amount the rebalance traded, and the deviation is now measured by what the grid would leave
    // idle without it: a lopsided grid idles much more of the value than it takes to trade, 5 % of it for a BUY of 0.5 % on 9/1 levels
    describe('when the grid would leave idle less than 1 % of the value, or more', () => {
      const nineByOne = { ...twoByTwo, buyLevels: 9, sellLevels: 1, spacingValue: 1 };

      it.each`
        assetFree | currencyFree | grid         | description                                                     | expected
        ${5}      | ${472}       | ${twoByTwo}  | ${'2/2 spaced by 5, 9.5 USDT of 972 idle, 0.98 %'}              | ${null}
        ${5}      | ${473}       | ${twoByTwo}  | ${'2/2 spaced by 5, 10.5 USDT of 973 idle, 1.08 %'}             | ${'BUY 0.05'}
        ${4.9}    | ${462.5}     | ${twoByTwo}  | ${'2/2 spaced by 5, 9.25 USDT of 952.5 idle, 0.97 %'}           | ${null}
        ${5.1}    | ${462.5}     | ${twoByTwo}  | ${'2/2 spaced by 5, 0.1 BTC idle, 10 USDT of 972.5, 1.03 %'}    | ${'SELL 0.04'}
        ${1}      | ${855}       | ${nineByOne} | ${'9/1 spaced by 1, at the split'}                              | ${null}
        ${0.95}   | ${860}       | ${nineByOne} | ${'9/1 spaced by 1, 47.75 USDT of 955 idle for a BUY of 0.5 %'} | ${'BUY 0.05'}
      `('plans $expected at 100 for $description', ({ assetFree, currencyFree, grid, expected }) => {
        const plan = computeRebalancePlan(100, assetFree, currencyFree, grid, marketData);

        expect(plan && `${plan.side} ${plan.amount}`).toBe(expected);
      });
    });
  });

  describe('deriveLevelQuantity', () => {
    interface Grid {
      center: number;
      assetFree: number;
      currencyFree: number;
      buyLevels: number;
      sellLevels: number;
      spacingType: GridSpacingType;
      spacingValue: number;
      marketData: MarketData;
      /** The prices of its BUYs, in the order the grid places them: the lowest first */
      buyPrices?: number[];
    }

    /** The size of the grid, with the precision the strategy infers from the market data */
    const sizeOf = ({ center, assetFree, currencyFree, buyLevels, sellLevels, spacingType, spacingValue, marketData }: Grid) => {
      const { priceDecimals, priceStep } = inferPricePrecision(marketData);
      return deriveLevelQuantity(
        center,
        assetFree,
        currencyFree,
        buyLevels,
        sellLevels,
        priceDecimals,
        spacingType,
        spacingValue,
        marketData,
        priceStep,
      );
    };

    // 2/2 levels spaced by 5 around 100, its BUYs at 95 and 90 and its SELLs at 105 and 110, on a tick and an amount step of 0.01. On 10
    // BTC and 1000 USDT, a SELL takes 10 / 2 = 5 and a BUY 1000 / (95 + 90) = 5.405…: the BTC binds, 5 a level
    const twoByTwo: Grid = {
      center: 100,
      assetFree: 10,
      currencyFree: 1000,
      buyLevels: 2,
      sellLevels: 2,
      spacingType: 'fixed',
      spacingValue: 5,
      marketData: { precision: { price: 0.01, amount: 0.01 } },
    };
    // The USDT binds: 500 / 185 = 2.7027… a BUY, 2.7 on the step
    const shortOfUsdt: Grid = { ...twoByTwo, currencyFree: 500 };
    // 1000 / (95 + 90 + 85) = 3.7037… a BUY
    const threeByTwo: Grid = { ...twoByTwo, buyLevels: 3 };
    // 1000 / 185 = 5.405… a BUY, the BTC left idle
    const buyLevelsOnly: Grid = { ...twoByTwo, sellLevels: 0 };
    // 10 / 2 = 5 a SELL, the USDT left idle
    const sellLevelsOnly: Grid = { ...twoByTwo, buyLevels: 0 };
    // 500 / (185 × 1.001) = 2.7000027… a BUY, the maker fee of 0.1 % on top, where 500 / 185 is 2.7027 on an amount step of 0.0001
    const withMakerFee: Grid = { ...shortOfUsdt, marketData: { precision: { price: 0.01, amount: 0.0001 }, fee: { maker: 0.001 } } };
    // Spaced by 3.3 on a tick of 0.5, its BUYs are at 96.5 and 93.5, 96.7 and 93.4 rounded to the tick: 950 / 190 = 5 a BUY, where the
    // prices off the tick give 950 / 190.1 = 4.997…
    const onTickOfHalf: Grid = {
      ...twoByTwo,
      currencyFree: 950,
      spacingValue: 3.3,
      marketData: { precision: { price: 0.5, amount: 0.01 } },
    };
    // Around 10, the BUYs of 5 levels spaced by 5 would be at 5, 0, -5, -10 and -15: only the one above 0 is sized, 1000 / 5 = 200
    const buyPricesDownToZero: Grid = { ...twoByTwo, center: 10, buyLevels: 5 };
    // amount.max 1 caps the 5 a level, and amount.min 0.1 is the minimum, which every level funds
    const amountLimits: Grid = { ...twoByTwo, marketData: { amount: { min: 0.1, max: 1 }, precision: { price: 0.01, amount: 0.01 } } };
    // cost.max 300 at the highest price, 110, caps the 5 a level at 300 / 110 = 2.727…
    const costMax: Grid = { ...twoByTwo, marketData: { cost: { max: 300 }, precision: { price: 0.01, amount: 0.01 } } };
    // cost.min 10: 0.2 BTC and 20 USDT fund 0.1 a level, 0.2 / 2 and 20 / 185 = 0.108…, which costs 9 at 90, the lowest price. The
    // minimum there is 10 / 90 = 0.111…, 0.12 on the step: the farthest level of each side is left out, and the 0.2 BTC fund one SELL
    // of 0.2, the 20 USDT one BUY at 95 of 20 / 95 = 0.21, its minimum 10 / 95 = 0.105…, 0.11
    const costMin: Grid = {
      ...twoByTwo,
      assetFree: 0.2,
      currencyFree: 20,
      marketData: { cost: { min: 10 }, precision: { price: 0.01, amount: 0.01 } },
    };

    // Every level trades the smaller of two shares, rounded down to the amount step: the free BTC split over the sell levels, and the
    // free USDT split over the prices of the buy levels, the maker fee on top. These sizes used to be asserted above 0, at most 1 or at
    // least 0, which held with the cost limits left out, or with every BUY sized at the center price.
    it.each`
      grid                                              | description                                             | expected
      ${twoByTwo}                                       | ${'2/2 levels, limited by the BTC'}                     | ${{ quantity: 5, buyLevels: 2, sellLevels: 2, minimumAmount: 0.01 }}
      ${shortOfUsdt}                                    | ${'2/2 levels, limited by the USDT'}                    | ${{ quantity: 2.7, buyLevels: 2, sellLevels: 2, minimumAmount: 0.01 }}
      ${threeByTwo}                                     | ${'3/2 levels'}                                         | ${{ quantity: 3.7, buyLevels: 3, sellLevels: 2, minimumAmount: 0.01 }}
      ${buyLevelsOnly}                                  | ${'buy levels only'}                                    | ${{ quantity: 5.4, buyLevels: 2, sellLevels: 0, minimumAmount: 0.01 }}
      ${sellLevelsOnly}                                 | ${'sell levels only'}                                   | ${{ quantity: 5, buyLevels: 0, sellLevels: 2, minimumAmount: 0.01 }}
      ${{ ...twoByTwo, buyLevels: 0, sellLevels: 0 }}   | ${'no level'}                                           | ${{ quantity: 0, buyLevels: 0, sellLevels: 0, minimumAmount: 0.01 }}
      ${{ ...twoByTwo, assetFree: 0, currencyFree: 0 }} | ${'nothing free'}                                       | ${{ quantity: 0, buyLevels: 0, sellLevels: 0, minimumAmount: 0.01 }}
      ${withMakerFee}                                   | ${'BUYs paying the maker fee on top'}                   | ${{ quantity: 2.7, buyLevels: 2, sellLevels: 2, minimumAmount: 0.0001 }}
      ${onTickOfHalf}                                   | ${'BUYs at their prices rounded to the tick'}           | ${{ quantity: 5, buyLevels: 2, sellLevels: 2, minimumAmount: 0.01 }}
      ${buyPricesDownToZero}                            | ${'the BUYs priced above 0 only'}                       | ${{ quantity: 5, buyLevels: 1, sellLevels: 2, minimumAmount: 0.01 }}
      ${amountLimits}                                   | ${'levels capped by amount.max'}                        | ${{ quantity: 1, buyLevels: 2, sellLevels: 2, minimumAmount: 0.1 }}
      ${costMax}                                        | ${'levels capped by cost.max at the highest price'}     | ${{ quantity: 2.72, buyLevels: 2, sellLevels: 2, minimumAmount: 0.01 }}
      ${costMin}                                        | ${'the levels cost.min leaves out at the lowest price'} | ${{ quantity: 0.2, buyLevels: 1, sellLevels: 1, minimumAmount: 0.11 }}
    `('sizes $description', ({ grid, expected }) => {
      expect(sizeOf(grid)).toEqual(expected);
    });

    // Its BUYs are placed at 10049 and 10047, 10048.5 rounded to the tick of 1 of 5 significant digits: sized at 10048.5, 1 a level
    // costs 20096, more than the 20095.5 free
    it('sizes BUYs at the prices they are placed at, on a market that takes 5 significant digits in a price: 0.99 for 20095.5', () => {
      const rule: MarketData = { precision: { price: 0.1, amount: 0.01, priceSignificantDigits: 5 } };

      expect(deriveLevelQuantity(10050, 0, 20095.5, 2, 0, 1, 'fixed', 1.5, rule, 0.1, 5).quantity).toBe(0.99);
    });

    // Each share is the largest amount on the step that its free balance funds, its need worked out in decimal. Divided in binary and
    // rounded down, a share fell a step short where the balance funds a whole number of steps: 7.0007 / 100.01 is 0.06999999999999999,
    // and 0.3 / 3 is 0.09999999999999999
    describe('on free balances funding a whole number of amount steps', () => {
      const cents: MarketData = { precision: { price: 0.01, amount: 0.01 } };
      // Its one BUY at 100.01, spaced by 0.01 around 100.02
      const oneBuy: Grid = {
        center: 100.02,
        assetFree: 0,
        currencyFree: 7.0007,
        buyLevels: 1,
        sellLevels: 0,
        spacingType: 'fixed',
        spacingValue: 0.01,
        marketData: cents,
      };
      const threeSells: Grid = { ...oneBuy, center: 100, assetFree: 0.3, currencyFree: 0, buyLevels: 0, sellLevels: 3, spacingValue: 1 };

      it.each`
        grid                                                                 | description                                                            | expected
        ${oneBuy}                                                            | ${'7.0007 USDT for one BUY at 100.01: 0.07, not 0.06'}                 | ${{ quantity: 0.07, buyLevels: 1, sellLevels: 0, minimumAmount: 0.01 }}
        ${{ ...oneBuy, currencyFree: 7.0006 }}                               | ${'7.0006 USDT for one BUY at 100.01: 0.06, 0.07 costing 7.0007'}      | ${{ quantity: 0.06, buyLevels: 1, sellLevels: 0, minimumAmount: 0.01 }}
        ${threeSells}                                                        | ${'0.3 BTC over three SELLs: 0.1, not 0.09'}                           | ${{ quantity: 0.1, buyLevels: 0, sellLevels: 3, minimumAmount: 0.01 }}
        ${{ ...threeSells, assetFree: 0.29999999 }}                          | ${'0.29999999 BTC over three SELLs: 0.09'}                             | ${{ quantity: 0.09, buyLevels: 0, sellLevels: 3, minimumAmount: 0.01 }}
        ${{ ...threeSells, marketData: { ...cents, amount: { min: 0.1 } } }} | ${'0.3 BTC over three SELLs at amount.min 0.1: three of 0.1, not two'} | ${{ quantity: 0.1, buyLevels: 0, sellLevels: 3, minimumAmount: 0.1 }}
        ${{ ...threeSells, assetFree: 0.7, sellLevels: 7 }}                  | ${'0.7 BTC over seven SELLs: 0.1, not 0.09'}                           | ${{ quantity: 0.1, buyLevels: 0, sellLevels: 7, minimumAmount: 0.01 }}
      `('sizes $description', ({ grid, expected }) => {
        expect(sizeOf(grid)).toEqual(expected);
      });
    });

    // As the exchange takes an amount, truncated to the step: rounded to the decimals of a step of 0.5, the grid was sized at 3.3 a level,
    // which the exchange takes as 3
    it('sizes 10 BTC over three SELLs on an amount step of 0.5: 3 a level', () => {
      const halfStep: Grid = { ...twoByTwo, buyLevels: 0, sellLevels: 3, marketData: { precision: { price: 0.01, amount: 0.5 } } };

      expect(sizeOf(halfStep)).toEqual({ quantity: 3, buyLevels: 0, sellLevels: 3, minimumAmount: 0.5 });
    });

    // The simulator charges the maker fee in currency on top of each BUY. Sized on the prices alone, the BUYs of a grid limited by its
    // currency needed the whole free currency before their fees: the last one placed, the highest, was refused at every attempt
    describe('limited by the free currency, on a market with a maker fee', () => {
      const buyOnly: Grid = {
        center: 100,
        assetFree: 0,
        currencyFree: 1000,
        buyLevels: 2,
        sellLevels: 0,
        spacingType: 'fixed',
        spacingValue: 5,
        marketData: documentedMarketData,
        buyPrices: [90, 95],
      };
      // Inside the 1 % window, so not rebalanced: 1.01 BTC a SELL, more than the currency pays a BUY
      const slightlyRichInAsset: Grid = {
        center: 100,
        assetFree: 5.05,
        currencyFree: 495,
        buyLevels: 5,
        sellLevels: 5,
        spacingType: 'percent',
        spacingValue: 0.1,
        marketData: documentedMarketData,
        buyPrices: [99.5, 99.6, 99.7, 99.8, 99.9],
      };
      const documentedOneLevelASide: Grid = {
        center: 61234.56,
        assetFree: 0.05,
        currencyFree: 3000,
        buyLevels: 1,
        sellLevels: 1,
        spacingType: 'percent',
        spacingValue: 1,
        marketData: documentedMarketData,
        buyPrices: [60622.2144],
      };
      const tenthPercentFee: Grid = {
        center: 100,
        assetFree: 10,
        currencyFree: 300,
        buyLevels: 5,
        sellLevels: 5,
        spacingType: 'percent',
        spacingValue: 1,
        marketData: tenthPercentFeeMarketData,
        buyPrices: [95, 96, 97, 98, 99],
      };
      const withoutFee: Grid = { ...buyOnly, marketData: omit(documentedMarketData, 'fee') };

      /** What the free currency has left once every BUY of the grid is placed, as the simulator reserves them: with the fee on top */
      const leftOnceEveryBuyIsPlaced = (grid: Grid) => {
        const { quantity } = sizeOf(grid);
        const fee = grid.marketData.fee?.maker ?? 0;
        return grid.buyPrices!.reduce((free, price) => free - quantity * price * (1 + fee), grid.currencyFree);
      };

      it.each`
        grid                       | description                                                            | expected
        ${buyOnly}                 | ${'a buy-only grid, all in currency'}                                  | ${5.4032441}
        ${slightlyRichInAsset}     | ${'a 5/5 grid slightly rich in asset'}                                 | ${0.9925819}
        ${documentedOneLevelASide} | ${'the documented grid of one level a side'}                           | ${0.04946702}
        ${tenthPercentFee}         | ${'a 5/5 grid at a 0.1 % maker fee'}                                   | ${0.61793}
        ${withoutFee}              | ${'a buy-only grid, on a market that states no fee, as charging none'} | ${5.4054054}
      `('sizes $description to $expected', ({ grid, expected }) => {
        expect(sizeOf(grid).quantity).toBe(expected);
      });

      it.each`
        grid                       | description
        ${buyOnly}                 | ${'a buy-only grid, all in currency'}
        ${slightlyRichInAsset}     | ${'a 5/5 grid slightly rich in asset'}
        ${documentedOneLevelASide} | ${'the documented grid of one level a side'}
        ${tenthPercentFee}         | ${'a 5/5 grid at a 0.1 % maker fee'}
      `('leaves the free currency paying every BUY of $description, the last one placed included', ({ grid }) => {
        expect(leftOnceEveryBuyIsPlaced(grid)).toBeGreaterThanOrEqual(0);
      });
    });

    // The quantity used to be raised to amount.min, or to cost.min at the lowest price, beyond what the free balances funded, and
    // left unrounded. On 0.0004 BTC and 25 USDT, a 5/5 grid of 0.0000859507… a level: the simulator refused the highest BUY and the
    // highest SELL for want of funds, and CCXTExchange truncated the amount to 0.00008, under cost.min, refusing 7 levels of 10
    describe('on free balances too small for every level at the market minimum', () => {
      const smallAccount: Grid = {
        center: 61234.56,
        assetFree: 0.0004,
        currencyFree: 25,
        buyLevels: 5,
        sellLevels: 5,
        spacingType: 'percent',
        spacingValue: 1,
        marketData: binanceStepsMarketData,
      };
      const smallInAsset: Grid = { ...smallAccount, currencyFree: 10_000 };
      // To 8 decimals, 0.00008596 at 58172.832, the configured lowest price, but 0.00008506 at 58785.1776, the lowest of the levels the
      // currency funds: 4 SELLs of 0.00008507 are funded at the latter
      const smallAtEightDecimals: Grid = { ...smallAccount, assetFree: 0.0003403, marketData: documentedMarketData };
      const tenthAmountMin: MarketData = { amount: { min: 0.1 }, precision: { price: 0.01, amount: 0.01 } };
      const underAmountMin: Grid = {
        center: 100,
        assetFree: 0.05,
        currencyFree: 5,
        buyLevels: 5,
        sellLevels: 5,
        spacingType: 'fixed',
        spacingValue: 1,
        marketData: { amount: { min: 0.1 }, precision: { price: 0.01, amount: 0.001 } },
      };
      const allInCurrency: Grid = {
        center: 100,
        assetFree: 0,
        currencyFree: 1000,
        buyLevels: 2,
        sellLevels: 2,
        spacingType: 'fixed',
        spacingValue: 5,
        marketData: tenthAmountMin,
      };
      const allInAsset: Grid = { ...allInCurrency, assetFree: 10, currencyFree: 0 };
      const documentedOneLevelASide: Grid = {
        center: 61234.56,
        assetFree: 0.05,
        currencyFree: 3000,
        buyLevels: 1,
        sellLevels: 1,
        spacingType: 'percent',
        spacingValue: 1,
        marketData: documentedMarketData,
      };
      // cost.max 210 at the highest price, 105: 2 a level
      const underMaximumCost: Grid = {
        center: 100,
        assetFree: 100,
        currencyFree: 100_000,
        buyLevels: 1,
        sellLevels: 1,
        spacingType: 'fixed',
        spacingValue: 5,
        marketData: { cost: { max: 210 }, precision: { price: 0.01, amount: 0.01 } },
      };

      const priceAtOf = ({ center, spacingType, spacingValue, marketData }: Grid) => {
        const { priceDecimals, priceStep } = inferPricePrecision(marketData);
        return (steps: number) => computeLevelPrice(center, steps, priceDecimals, spacingType, spacingValue, priceStep);
      };
      /** The lowest price an order of the grid is ever placed at: its lowest BUY, or the center price, where its lowest SELL buys back */
      const lowestPriceOf = (grid: Grid) => priceAtOf(grid)(-sizeOf(grid).buyLevels);
      /** What the free balances have left, the smaller of the two, once every order of the grid is placed, BUYs with the fee on top */
      const leftOnceEveryOrderIsPlaced = (grid: Grid) => {
        const { quantity, buyLevels, sellLevels } = sizeOf(grid);
        const priceAt = priceAtOf(grid);
        const fee = grid.marketData.fee?.maker ?? 0;
        const buys = Array.from({ length: buyLevels }, (_, i) => priceAt(-buyLevels + i));
        const currencyLeft = buys.reduce((free, price) => free - quantity * price * (1 + fee), grid.currencyFree);
        return Math.min(currencyLeft, grid.assetFree - sellLevels * quantity);
      };

      it.each`
        grid                       | description                                                           | expected
        ${smallAccount}            | ${'0.0004 BTC and 25 USDT: the farthest level of each side left out'} | ${{ quantity: 0.0001, buyLevels: 4, sellLevels: 4, minimumAmount: 0.00009 }}
        ${smallInAsset}            | ${'0.0004 BTC and 10000 USDT: the farthest sell level left out'}      | ${{ quantity: 0.0001, buyLevels: 5, sellLevels: 4, minimumAmount: 0.00009 }}
        ${smallAtEightDecimals}    | ${'to 8 decimals, at the minimum of the lowest level kept'}           | ${{ quantity: 0.00008507, buyLevels: 4, sellLevels: 4, minimumAmount: 0.00008506 }}
        ${underAmountMin}          | ${'0.05 BTC and 5 USDT, under amount.min 0.1 on either side: none'}   | ${{ quantity: 0, buyLevels: 0, sellLevels: 0, minimumAmount: 0.1 }}
        ${allInCurrency}           | ${'all in currency: the sell levels left out'}                        | ${{ quantity: 5.4, buyLevels: 2, sellLevels: 0, minimumAmount: 0.1 }}
        ${allInAsset}              | ${'all in asset: the buy levels left out'}                            | ${{ quantity: 5, buyLevels: 0, sellLevels: 2, minimumAmount: 0.1 }}
        ${documentedOneLevelASide} | ${'the documented grid of one level a side: whole'}                   | ${{ quantity: 0.04946702, buyLevels: 1, sellLevels: 1, minimumAmount: 0.00008248 }}
        ${underMaximumCost}        | ${'a grid capped by cost.max at its highest price'}                   | ${{ quantity: 2, buyLevels: 1, sellLevels: 1, minimumAmount: 0.01 }}
      `('sizes $description', ({ grid, expected }) => {
        expect(sizeOf(grid)).toEqual(expected);
      });

      it.each`
        grid                       | description
        ${smallAccount}            | ${'0.0004 BTC and 25 USDT'}
        ${smallInAsset}            | ${'0.0004 BTC and 10000 USDT'}
        ${smallAtEightDecimals}    | ${'0.0003403 BTC and 25 USDT, to 8 decimals'}
        ${documentedOneLevelASide} | ${'the documented grid of one level a side'}
      `('sizes every order of $description at a cost of cost.min or more, its lowest price included', ({ grid }) => {
        expect(sizeOf(grid).quantity * lowestPriceOf(grid)).toBeGreaterThanOrEqual(grid.marketData.cost.min);
      });

      it.each`
        grid                       | description
        ${smallAccount}            | ${'0.0004 BTC and 25 USDT'}
        ${smallInAsset}            | ${'0.0004 BTC and 10000 USDT'}
        ${smallAtEightDecimals}    | ${'0.0003403 BTC and 25 USDT, to 8 decimals'}
        ${allInCurrency}           | ${'all in currency'}
        ${allInAsset}              | ${'all in asset'}
        ${documentedOneLevelASide} | ${'the documented grid of one level a side'}
      `('leaves the free balances paying every order of $description', ({ grid }) => {
        expect(leftOnceEveryOrderIsPlaced(grid)).toBeGreaterThanOrEqual(0);
      });

      // CCXTExchange truncates an amount to the step: one off the step was sent smaller than sized. On the step, it is a quantity that
      // rounding down to the step leaves as it is
      it.each`
        grid                | description
        ${smallAccount}     | ${'0.0004 BTC and 25 USDT'}
        ${smallInAsset}     | ${'0.0004 BTC and 10000 USDT'}
        ${underMaximumCost} | ${'a grid capped by cost.max'}
      `('sizes $description on the amount step', ({ grid }) => {
        const { quantity } = sizeOf(grid);

        expect(roundAmount(quantity, inferAmountPrecision(grid.marketData))).toBe(quantity);
      });
    });
  });

  describe('getPortfolioContent', () => {
    const portfolio = new Map([
      ['BTC', { free: 1, used: 0.5, total: 1.5 }],
      ['USDT', { free: 100, used: 0, total: 100 }],
    ]);

    it.each`
      base     | quote     | description                                            | expected
      ${'BTC'} | ${'USDT'} | ${'the balances of the asset and of the currency'}     | ${{ asset: { free: 1, used: 0.5, total: 1.5 }, currency: { free: 100, used: 0, total: 100 } }}
      ${'ETH'} | ${'USDT'} | ${'a balance of 0 for an asset the portfolio lacks'}   | ${{ asset: { free: 0, used: 0, total: 0 }, currency: { free: 100, used: 0, total: 100 } }}
      ${'BTC'} | ${'EUR'}  | ${'a balance of 0 for a currency the portfolio lacks'} | ${{ asset: { free: 1, used: 0.5, total: 1.5 }, currency: { free: 0, used: 0, total: 0 } }}
    `('reads $description', ({ base, quote, expected }) => {
      expect(getPortfolioContent(portfolio, base, quote)).toEqual(expected);
    });
  });

  describe('hasOnlyOneSide', () => {
    it('returns true for only BUY orders', () => {
      const levels = [
        { side: 'BUY' as const, orderId: '1' },
        { side: 'BUY' as const, orderId: '2' },
      ];

      expect(hasOnlyOneSide(levels)).toBe(true);
    });

    it('returns true for only SELL orders', () => {
      const levels = [
        { side: 'SELL' as const, orderId: '1' },
        { side: 'SELL' as const, orderId: '2' },
      ];

      expect(hasOnlyOneSide(levels)).toBe(true);
    });

    it('returns false for both sides', () => {
      const levels = [
        { side: 'BUY' as const, orderId: '1' },
        { side: 'SELL' as const, orderId: '2' },
      ];

      expect(hasOnlyOneSide(levels)).toBe(false);
    });

    it('ignores levels without orders', () => {
      const levels = [
        { side: 'BUY' as const, orderId: '1' },
        { side: 'SELL' as const, orderId: undefined },
      ];

      expect(hasOnlyOneSide(levels)).toBe(true);
    });

    it('returns false for empty levels', () => {
      expect(hasOnlyOneSide([])).toBe(false);
    });
  });
});
