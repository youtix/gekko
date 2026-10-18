import { BTC_ETH_TRADED_INFO, flatBucket, indicatorsAtInit } from '@helpers/strategy/positionBook/positionBook.mock';
import { logsAtInit, OrderRecorder, playSteps } from '@helpers/strategy/positionTracker/positionTracker.mock';
import type { StrategyOrder } from '@models/advice.types';
import type { CandleBucket } from '@models/event.types';
import type { Portfolio } from '@models/portfolio.types';
import { InitParams, OnCandleEventParams } from '@strategies/strategy.types';
import { noop, omit } from 'lodash-es';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RSI } from './rsi.strategy';
import { RSIStrategyParams } from './rsi.types';

const symbol = 'BTC/USDT';
const ethSymbol = 'ETH/USDT';
// The RSI value (thresholds 70 / 30) of each step of the scenarios played below: null is what the indicator gives until it is ready
const RSI_VALUES = { high: 75, low: 20, neutral: 50, nan: NaN, inf: Infinity, '-inf': -Infinity, null: null } as const;
// All-in, as the strategy creates them: without amount, the Trader sizes them from all the free currency (BUY) or asset (SELL)
const allInBuy = { type: 'STICKY', side: 'BUY', symbol } satisfies StrategyOrder;
const allInSell = { type: 'STICKY', side: 'SELL', symbol } satisfies StrategyOrder;
// On BTC/USDT and ETH/USDT, a BUY takes half of the free currency while the other pair is not invested, all of it once the other is
// long (see PositionBook.buy), and a SELL sells all of its asset
const btcHalfBuy = { ...allInBuy, allocation: 50 } satisfies StrategyOrder;
const ethHalfBuy = { ...allInBuy, symbol: ethSymbol, allocation: 50 } satisfies StrategyOrder;
const ethAllInBuy = { ...allInBuy, symbol: ethSymbol } satisfies StrategyOrder;
const ethAllInSell = { ...allInSell, symbol: ethSymbol } satisfies StrategyOrder;

describe('RSI Strategy', () => {
  let strategy: RSI;
  let orders: OrderRecorder;
  let advices: StrategyOrder[];
  let tools: any;
  let bucket: CandleBucket;
  let portfolio: Portfolio;
  let addIndicator: any;

  /** The params of a candle hook: the bucket of the pairs the strategy was started on, the portfolio and the tools */
  const candleParams = () => ({ candle: bucket, portfolio, tools }) as unknown as OnCandleEventParams<RSIStrategyParams>;
  /**
   * Plays the steps (see playSteps): a candle is the RSI of each pair of the bucket, in its order, separated by commas (see RSI_VALUES):
   * 'low' on BTC/USDT, 'low,neutral' on BTC/USDT and ETH/USDT
   */
  const play = (steps: string) =>
    playSteps(steps, strategy, orders, step => {
      const pairs = [...bucket.keys()];
      const values = step.split(',');
      // A misspelt step would be an undefined RSI, a candle skipped
      if (values.length !== pairs.length || values.some(value => !(value in RSI_VALUES))) {
        throw new Error(`No step named ${step} on ${pairs.join(', ')}, in "${steps}"`);
      }
      const rsis = pairs.map((pair, index) => ({ results: RSI_VALUES[values[index] as keyof typeof RSI_VALUES], symbol: pair }));
      strategy.onTimeframeCandleAfterWarmup(candleParams(), ...rsis);
    });
  const sides = () => advices.map(({ side }) => side);

  beforeEach(() => {
    strategy = new RSI();
    orders = new OrderRecorder();
    advices = orders.advices;
    addIndicator = vi.fn();

    tools = {
      strategyParams: { period: 14, src: 'close', thresholds: { high: 70, low: 30, persistence: 2 } },
      createOrder: orders.createOrder,
      cancelOrder: vi.fn(),
      log: vi.fn(),
      marketData: new Map(),
    };

    bucket = new Map();
    bucket.set(symbol, { close: 1 } as any);
    // No balance read yet: the book skips no BUY (see PositionBook.buy)
    portfolio = new Map();

    strategy.init({ candle: bucket, portfolio, tools, addIndicator } as unknown as InitParams<RSIStrategyParams>);
  });

  describe('init', () => {
    const rsiParameters = { period: 14, src: 'close' };

    it('should add RSI indicator with strategy period and src', () => {
      expect(addIndicator).toHaveBeenCalledWith('RSI', symbol, { period: 14, src: 'close' });
    });

    // One RSI per pair, in the order of the bucket, that of watch.assets: the hooks get their results in that order
    it.each`
      case                        | pairs                  | expected
      ${'BTC/USDT then ETH/USDT'} | ${[symbol, ethSymbol]} | ${[['RSI', symbol, rsiParameters], ['RSI', ethSymbol, rsiParameters]]}
      ${'ETH/USDT then BTC/USDT'} | ${[ethSymbol, symbol]} | ${[['RSI', ethSymbol, rsiParameters], ['RSI', symbol, rsiParameters]]}
    `('should add an RSI of its period and source on each pair, in order: $case', ({ pairs, expected }) => {
      expect(indicatorsAtInit(new RSI(), pairs, tools.strategyParams)).toEqual(expected);
    });

    // The bucket holds a candle of every watched pair, in the order of watch.assets: the strategy trades them all, and the book says so
    // on several, where the strategy warned that it traded the first one only
    it.each`
      case           | pairs                  | expected
      ${'one pair'}  | ${[symbol]}            | ${[]}
      ${'two pairs'} | ${[symbol, ethSymbol]} | ${[BTC_ETH_TRADED_INFO]}
    `('should log the pairs it trades at init, on several only: $case', ({ pairs, expected }) => {
      expect(logsAtInit(new RSI(), pairs, tools.strategyParams)).toEqual(expected);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // A low trend over the persistence, which buys once init has tracked the pairs: before it, the strategy trades no pair
    it('should do nothing before init has tracked the pairs', () => {
      strategy = new RSI();
      play('low low');
      expect({ advices, logged: tools.log.mock.calls }).toEqual({ advices: [], logged: [] });
    });

    // Nothing logged either: an infinite RSI started a trend
    it.each`
      rsiRes
      ${undefined}
      ${null}
      ${'invalid'}
      ${NaN}
      ${Infinity}
      ${-Infinity}
    `('should do nothing when RSI result is invalid ($rsiRes)', ({ rsiRes }) => {
      strategy.onTimeframeCandleAfterWarmup(candleParams(), { results: rsiRes, symbol });
      expect({ advices, logged: tools.log.mock.calls }).toEqual({ advices: [], logged: [] });
    });

    // Compared as 0, a null RSI would count toward a low trend, or end a high one
    it.each`
      case                             | steps                                   | expectedSides
      ${'NaN within a low trend'}      | ${'low nan low'}                        | ${['BUY']}
      ${'Infinity within a low trend'} | ${'low inf low'}                        | ${['BUY']}
      ${'-Infinity twice when flat'}   | ${'-inf -inf'}                          | ${[]}
      ${'Infinity twice when long'}    | ${'low low completed:1 inf inf'}        | ${['BUY']}
      ${'null after a low candle'}     | ${'low null'}                           | ${[]}
      ${'null within a high trend'}    | ${'low low completed:1 high null high'} | ${['BUY', 'SELL']}
    `('should skip a candle whose RSI is not a finite number, as one not ready yet: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it.each`
      case                                  | steps                              | expected
      ${'a BUY on a low trend when flat'}   | ${'low low'}                       | ${[allInBuy]}
      ${'a SELL on a high trend when long'} | ${'low low completed:1 high high'} | ${[allInBuy, allInSell]}
    `('should emit an all-in STICKY order after persistence: $case', ({ steps, expected }) => {
      play(steps);
      expect(advices).toStrictEqual(expected);
    });

    // A book of one pair skips no BUY: sent all-in whatever the currency free, it is refused by the exchange when that is too little, as
    // it always was (see PositionBook.buy)
    it('should send its all-in BUY on one pair whatever the minimum cost of the market', () => {
      portfolio = new Map([['USDT', { free: 10, used: 0, total: 10 }]]);
      tools.marketData = new Map([[symbol, { cost: { min: 10 } }]]);
      play('low low');
      expect(advices).toStrictEqual([allInBuy]);
    });

    it.each`
      case                                        | steps                                                        | expectedSides
      ${'a low trend before persistence'}         | ${'low'}                                                     | ${[]}
      ${'a low trend that continues'}             | ${'low low low'}                                             | ${['BUY']}
      ${'a high trend before persistence'}        | ${'low low completed:1 high'}                                | ${['BUY']}
      ${'a high trend that continues'}            | ${'low low completed:1 high high high'}                      | ${['BUY', 'SELL']}
      ${'a switch from low to high and back'}     | ${'low low completed:1 high high completed:2 low low'}       | ${['BUY', 'SELL', 'BUY']}
      ${'neutral values'}                         | ${'neutral neutral'}                                         | ${[]}
      ${'a low trend after a shorter high trend'} | ${'low low high low low'}                                    | ${['BUY']}
      ${'a low trend while long'}                 | ${'low low completed:1 neutral low low'}                     | ${['BUY']}
      ${'a high trend after a shorter low trend'} | ${'low low completed:1 high high completed:2 low high high'} | ${['BUY', 'SELL']}
      ${'a high trend when flat'}                 | ${'high high high'}                                          | ${[]}
      ${'a high trend while the BUY pends'}       | ${'low low high high'}                                       | ${['BUY']}
      ${'a high trend once the BUY filled'}       | ${'low low high high completed:1 high'}                      | ${['BUY', 'SELL']}
      ${'a low trend while the SELL pends'}       | ${'low low completed:1 high high low low'}                   | ${['BUY', 'SELL']}
      ${'a new high trend while the SELL pends'}  | ${'low low completed:1 high high low high high'}             | ${['BUY', 'SELL']}
    `('should advise once per position change on $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // Every line about a pair starts with it: on several pairs, the lines of each pair are told apart
    it.each`
      case                                 | steps         | expected
      ${'a low trend'}                     | ${'low low'}  | ${[['info', '[BTC/USDT] RSI: low trend detected'], ['debug', '[BTC/USDT] In low trend since 1 candle'], ['debug', '[BTC/USDT] In low trend since 2 candles']]}
      ${'a high trend'}                    | ${'high'}     | ${[['info', '[BTC/USDT] RSI: high trend detected'], ['debug', '[BTC/USDT] In high trend since 1 candle']]}
      ${'a low trend ended by a high one'} | ${'low high'} | ${[['info', '[BTC/USDT] RSI: low trend detected'], ['debug', '[BTC/USDT] In low trend since 1 candle'], ['info', '[BTC/USDT] RSI: high trend detected'], ['debug', '[BTC/USDT] In high trend since 1 candle']]}
      ${'neutral values'}                  | ${'neutral'}  | ${[]}
    `('should log the trends of the pair, each line prefixed with it: $case', ({ steps, expected }) => {
      play(steps);
      expect(tools.log.mock.calls).toEqual(expected);
    });
  });

  describe('order outcomes', () => {
    // An outcome reports nothing of an execution, unless its step gives the BTC left free after it ('errored:2:0', see playSteps)
    it.each`
      case                                                   | steps                                                            | expectedSides
      ${'a BUY completed: long, it sells'}                   | ${'low low completed:1 high high'}                               | ${['BUY', 'SELL']}
      ${'a BUY canceled: flat, it buys on the next trend'}   | ${'low low canceled:1 low high low low'}                         | ${['BUY', 'BUY']}
      ${'a BUY errored: flat, it buys on the next trend'}    | ${'low low errored:1 low high low low'}                          | ${['BUY', 'BUY']}
      ${'a SELL completed: flat, it buys again'}             | ${'low low completed:1 high high completed:2 low low'}           | ${['BUY', 'SELL', 'BUY']}
      ${'a SELL canceled: long, it sells on the next trend'} | ${'low low completed:1 high high canceled:2 high low high high'} | ${['BUY', 'SELL', 'SELL']}
      ${'a SELL errored: long, it sells on the next trend'}  | ${'low low completed:1 high high errored:2 high low high high'}  | ${['BUY', 'SELL', 'SELL']}
      ${'a SELL errored, all sold: flat, it buys again'}     | ${'low low completed:1 high high errored:2:0 low low'}           | ${['BUY', 'SELL', 'BUY']}
      ${'another order completed: still pending'}            | ${'low low completed:unknown low high high'}                     | ${['BUY']}
      ${'another order canceled: still pending'}             | ${'low low canceled:unknown low high high'}                      | ${['BUY']}
      ${'another order errored: still pending'}              | ${'low low errored:unknown low high high'}                       | ${['BUY']}
    `('should track $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });
  });

  describe('on two pairs', () => {
    beforeEach(() => {
      strategy = new RSI();
      bucket = flatBucket({ [symbol]: 100, [ethSymbol]: 100 });
      // The line of the book at init is pinned above (see init): tools.log gets the lines of the candles alone
      const initParams = { candle: bucket, portfolio, tools: { ...tools, log: noop }, addIndicator: noop };
      strategy.init(initParams as unknown as InitParams<RSIStrategyParams>);
    });

    // Each candle is the RSI of BTC/USDT, then of ETH/USDT: a pair whose BUY is pending is not invested yet, and counts in the share
    // of the next BUY, a pair whose SELL is pending is still long (see PositionBook.buy)
    it.each`
      case                                                            | steps                                                                                                  | expected
      ${'both flat: half of the currency each, on one candle'}        | ${'low,low low,low'}                                                                                   | ${[btcHalfBuy, ethHalfBuy]}
      ${'BTC long: ETH buys all-in'}                                  | ${'low,neutral low,neutral completed:1 neutral,low neutral,low'}                                       | ${[btcHalfBuy, ethAllInBuy]}
      ${'BTC selling: ETH buys all-in, BTC long until its SELL'}      | ${'low,neutral low,neutral completed:1 high,low high,low'}                                             | ${[btcHalfBuy, allInSell, ethAllInBuy]}
      ${'BTC sold: BTC buys half again'}                              | ${'low,neutral low,neutral completed:1 high,neutral high,neutral completed:2 low,neutral low,neutral'} | ${[btcHalfBuy, allInSell, btcHalfBuy]}
      ${'BTC sold: ETH buys half'}                                    | ${'low,neutral low,neutral completed:1 high,neutral high,neutral completed:2 neutral,low neutral,low'} | ${[btcHalfBuy, allInSell, ethHalfBuy]}
      ${'both long: each sells on its own high trend'}                | ${'low,low low,low completed:1 completed:2 high,neutral high,high high,high'}                          | ${[btcHalfBuy, ethHalfBuy, allInSell, ethAllInSell]}
      ${'a trend per pair: the high trend of ETH leaves that of BTC'} | ${'low,high low,low'}                                                                                  | ${[btcHalfBuy]}
      ${'a persistence per pair: ETH buys on its second low candle'}  | ${'low,low low,neutral neutral,low'}                                                                   | ${[btcHalfBuy, ethHalfBuy]}
      ${'BTC not ready: ETH buys half, BTC flat'}                     | ${'null,low null,low'}                                                                                 | ${[ethHalfBuy]}
    `('should trade each pair on its own trend and position: $case', ({ steps, expected }) => {
      play(steps);
      expect(advices).toStrictEqual(expected);
    });

    // The outcome of an order settles the position of its pair alone ('errored:1:0.5' leaves 0.5 BTC free after it, see playSteps)
    it.each`
      case                                                       | steps                                                                                              | expected
      ${'the BUY of ETH errored: BTC, long, sells alone'}        | ${'low,low low,low completed:1 errored:2 high,high high,high'}                                     | ${[btcHalfBuy, ethHalfBuy, allInSell]}
      ${'the BUY of BTC canceled: ETH, long, sells alone'}       | ${'low,low low,low canceled:1 completed:2 high,high high,high'}                                    | ${[btcHalfBuy, ethHalfBuy, ethAllInSell]}
      ${'the BUY of BTC errored after a fill: both sell'}        | ${'low,low low,low errored:1:0.5 completed:2 high,high high,high'}                                 | ${[btcHalfBuy, ethHalfBuy, allInSell, ethAllInSell]}
      ${'the SELL of ETH errored, all sold: BTC long, ETH buys'} | ${'low,low low,low completed:1 completed:2 neutral,high neutral,high errored:3:0 low,low low,low'} | ${[btcHalfBuy, ethHalfBuy, ethAllInSell, ethAllInBuy]}
      ${'another order completed: both BUYs still pending'}      | ${'low,low low,low completed:unknown high,high high,high'}                                         | ${[btcHalfBuy, ethHalfBuy]}
    `('should settle the position of the pair of each order alone: $case', ({ steps, expected }) => {
      play(steps);
      expect(advices).toStrictEqual(expected);
    });

    it('should log the trends of each pair, each line prefixed with its pair', () => {
      play('low,high low,high');
      expect(tools.log.mock.calls).toEqual([
        ['info', '[BTC/USDT] RSI: low trend detected'],
        ['debug', '[BTC/USDT] In low trend since 1 candle'],
        ['info', '[ETH/USDT] RSI: high trend detected'],
        ['debug', '[ETH/USDT] In high trend since 1 candle'],
        ['debug', '[BTC/USDT] In low trend since 2 candles'],
        ['debug', '[ETH/USDT] In high trend since 2 candles'],
      ]);
    });

    // The StrategyManager passes the RSI of every pair: a pair whose RSI is missing is skipped, as one not ready
    it('should trade the pair whose RSI it gets, and skip the pair whose RSI is missing', () => {
      strategy.onTimeframeCandleAfterWarmup(candleParams(), { results: RSI_VALUES.low, symbol });
      strategy.onTimeframeCandleAfterWarmup(candleParams(), { results: RSI_VALUES.low, symbol });
      expect({ advices, logged: tools.log.mock.calls }).toStrictEqual({
        advices: [btcHalfBuy],
        logged: [
          ['info', '[BTC/USDT] RSI: low trend detected'],
          ['debug', '[BTC/USDT] In low trend since 1 candle'],
          ['debug', '[BTC/USDT] In low trend since 2 candles'],
        ],
      });
    });

    // 10 USDT free, a minimum cost of 10 USDT: half of the currency, 5 USDT, costs 4.75 USDT once 5 % is kept back for the fee, and the
    // book skips the BUY (see PositionBook.buy). The advice of the trend is spent all the same: the next BUY waits for the next low trend.
    it('should spend the advice of a BUY the book skips: one skip per low trend, at warn level then at debug level', () => {
      portfolio = new Map([['USDT', { free: 10, used: 0, total: 10 }]]);
      tools.marketData = new Map([
        [symbol, { cost: { min: 10 } }],
        [ethSymbol, { cost: { min: 10 } }],
      ]);
      play('low,neutral low,neutral low,neutral high,neutral low,neutral low,neutral low,neutral');
      const skip =
        '[BTC/USDT] BUY skipped: 50 % of the 10 USDT free, 4.75 USDT once 5 % is kept back for the fee, is below the minimum cost of 10 USDT of the market: watch fewer pairs or fund the account';
      expect({
        advices,
        skips: tools.log.mock.calls.filter(([, message]: [string, string]) => message.includes('BUY skipped')),
      }).toStrictEqual({
        advices: [],
        skips: [
          ['warn', `${skip}; the next skips of this pair are logged at debug level until a BUY of it is placed`],
          ['debug', skip],
        ],
      });
    });
  });

  describe('schema', () => {
    // The documentation's example, without the name that labels the run: the manager parses the block without it
    const params = { period: 14, src: 'close', thresholds: { high: 70, low: 30, persistence: 1 } };
    const onOhlc4 = { period: 21, src: 'ohlc4', thresholds: { high: 70, low: 30, persistence: 0 } };
    const withThresholds = (thresholds: object) => ({ ...params, thresholds: { ...params.thresholds, ...thresholds } });

    it.each`
      scenario                               | block                       | expected
      ${'the documentation example'}         | ${params}                   | ${params}
      ${'a persistence of 0, on ohlc4'}      | ${onOhlc4}                  | ${onOhlc4}
      ${'a block without src, on the close'} | ${omit(params, 'src')}      | ${params}
      ${'a period of 2, the smallest'}       | ${{ ...params, period: 2 }} | ${{ ...params, period: 2 }}
    `('accepts $scenario', ({ block, expected }) => {
      expect(RSI.schema.parse(block)).toEqual(expected);
    });

    it('refuses a misspelt high threshold (hight)', () => {
      expect(RSI.schema.safeParse({ ...params, thresholds: { hight: 70, low: 30, persistence: 1 } }).error?.issues).toMatchObject([
        { path: ['thresholds', 'high'] },
        { code: 'unrecognized_keys', keys: ['hight'], path: ['thresholds'] },
      ]);
    });

    it.each`
      scenario                                         | block                                       | path
      ${'a quoted period'}                             | ${{ ...params, period: '14' }}              | ${['period']}
      ${'a fractional period'}                         | ${{ ...params, period: 14.5 }}              | ${['period']}
      ${'a period of 0'}                               | ${{ ...params, period: 0 }}                 | ${['period']}
      ${'a period of 1'}                               | ${{ ...params, period: 1 }}                 | ${['period']}
      ${'an unknown source'}                           | ${{ ...params, src: 'hcl3' }}               | ${['src']}
      ${'a misspelt src (scr), not left to the close'} | ${{ ...omit(params, 'src'), scr: 'ohlc4' }} | ${[]}
      ${'a missing thresholds block'}                  | ${omit(params, 'thresholds')}               | ${['thresholds']}
      ${'a quoted threshold'}                          | ${withThresholds({ high: '70' })}           | ${['thresholds', 'high']}
      ${'an infinite threshold'}                       | ${withThresholds({ low: -Infinity })}       | ${['thresholds', 'low']}
      ${'a negative persistence'}                      | ${withThresholds({ persistence: -1 })}      | ${['thresholds', 'persistence']}
    `('refuses $scenario', ({ block, path }) => {
      expect(RSI.schema.safeParse(block).error?.issues).toMatchObject([{ path }]);
    });

    // A period of 1 read every unchanged close as oversold, the flat candles that fill a gap included, and the strategy bought on them
    it('says why it refuses a period of 1', () => {
      expect(RSI.schema.safeParse({ ...params, period: 1 }).error?.issues[0].message).toBe(
        'period must be at least 2 (the RSI of a single change is 100 on a rise, and 0 on a fall or an unchanged close)',
      );
    });
  });
});
