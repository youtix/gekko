import type { StrategyOrder } from '@models/advice.types';
import type { CandleBucket } from '@models/event.types';
import { LogLevel } from '@models/logLevel.types';
import { Portfolio } from '@models/portfolio.types';
import { TradingPair } from '@models/utility.types';
import { BTC_ETH_TRADED_INFO, flatBucket, indicatorArguments, indicatorsAtInit } from '@strategies/positionBook.mock';
import { logsAtInit, OrderRecorder, playSteps } from '@strategies/positionTracker.mock';
import { InitParams, OnCandleEventParams } from '@strategies/strategy.types';
import { omit } from 'lodash-es';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MACD } from './macd.strategy';
import { MACDStrategyParams } from './macd.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
const makeIndicator = (res: any) => [{ results: res, symbol: BTC }] as any;
// The MACD result of each step of the scenarios played below (hist = macd - signal), with one field only beyond the thresholds
// 0.5 / -0.5: only the field macdSrc names can make a trend. up and down move the MACD line, which the suite trades (macdSrc: 'macd'),
// signalUp and signalDown the signal line, histUp and histDown the histogram. Null is what the indicator gives until it is ready.
const MACD_RESULTS = {
  up: { macd: 0.8, signal: 0.4, hist: 0.4 },
  down: { macd: -0.8, signal: -0.4, hist: -0.4 },
  none: { macd: 0, signal: 0, hist: 0 },
  signalUp: { macd: 0.4, signal: 0.8, hist: -0.4 },
  signalDown: { macd: -0.4, signal: -0.8, hist: 0.4 },
  histUp: { macd: 0.4, signal: -0.4, hist: 0.8 },
  histDown: { macd: -0.4, signal: 0.4, hist: -0.8 },
  null: null,
} as const;
/** What the MACD indicator gives the hooks, null until it is ready */
type MACDResult = IndicatorRegistry['MACD']['output'];
// The periods of the strategy parameters below, which init hands each MACD
const PERIODS = { short: 12, long: 26, signal: 9 };
// All-in, as the strategy creates them: without amount, the Trader sizes them from all the free currency (BUY) or asset (SELL)
const allInBuy = { type: 'STICKY', side: 'BUY', symbol: BTC } satisfies StrategyOrder;
const allInSell = { type: 'STICKY', side: 'SELL', symbol: BTC } satisfies StrategyOrder;
/** A BUY of `symbol` as the strategy creates it on several pairs: all-in, or with the share of the free currency it takes, in % */
const buyOf = (symbol: TradingPair, allocation?: number): StrategyOrder =>
  allocation === undefined ? { type: 'STICKY', side: 'BUY', symbol } : { type: 'STICKY', side: 'BUY', symbol, allocation };
/** A SELL of `symbol` as the strategy creates it: all-in */
const sellOf = (symbol: TradingPair): StrategyOrder => ({ type: 'STICKY', side: 'SELL', symbol });

describe('MACD Strategy', () => {
  let strategy: MACD;
  let orders: OrderRecorder;
  let advices: StrategyOrder[];
  let logs: { level: LogLevel; message: string }[];
  let tools: any;
  let bucket: CandleBucket;
  let portfolio: Portfolio;
  let addIndicator: any;

  /** Builds the strategy and plays its init on a bucket of `pairs`, in their order (that of watch.assets) */
  const initOn = (pairs: TradingPair[]) => {
    strategy = new MACD();
    bucket = flatBucket(Object.fromEntries(pairs.map(pair => [pair, 1])));
    strategy.init({ candle: bucket, portfolio, tools, addIndicator } as unknown as InitParams<MACDStrategyParams>);
  };
  /** The params of a candle hook: the bucket of init, the portfolio of the test and the tools */
  const candleParams = () => ({ candle: bucket, portfolio, tools }) as unknown as OnCandleEventParams<MACDStrategyParams>;
  /**
   * Plays the steps (see playSteps): a candle is the MACD result of each pair of the bucket, in its order, separated by commas (see
   * MACD_RESULTS): 'up' on BTC/USDT alone, 'up,none' on BTC/USDT and ETH/USDT
   */
  const play = (steps: string) =>
    playSteps(steps, strategy, orders, step => {
      const names = step.split(',');
      // A misspelt step would be an undefined result, a candle skipped
      if (names.length !== bucket.size || !names.every(name => name in MACD_RESULTS)) {
        throw new Error(`No step named ${step} on ${[...bucket.keys()].join(', ')}, in "${steps}"`);
      }
      const results = [...bucket.keys()].map((symbol, index) => ({
        results: MACD_RESULTS[names[index] as keyof typeof MACD_RESULTS],
        symbol,
      }));
      strategy.onTimeframeCandleAfterWarmup(candleParams(), ...results);
    });
  const sides = () => advices.map(({ side }) => side);

  beforeEach(() => {
    orders = new OrderRecorder();
    advices = orders.advices;
    logs = [];
    portfolio = new Map();
    addIndicator = vi.fn();

    tools = {
      strategyParams: {
        short: 12,
        long: 26,
        signal: 9,
        macdSrc: 'macd',
        thresholds: { up: 0.5, down: -0.5, persistence: 2 },
      },
      createOrder: orders.createOrder,
      cancelOrder: vi.fn(),
      log: vi.fn((level: LogLevel, message: string) => logs.push({ level, message })),
      marketData: new Map(),
    };

    initOn([BTC]);
  });

  describe('init', () => {
    it('should add MACD indicator with strategy parameters', () => {
      expect(addIndicator).toHaveBeenCalledWith('MACD', BTC, { short: 12, long: 26, signal: 9 });
    });

    // The bucket holds a candle of every watched pair, in the order of watch.assets: each pair gets a MACD of its own, in that order
    it.each`
      case                    | pairs         | expected
      ${'BTC/USDT, ETH/USDT'} | ${[BTC, ETH]} | ${[['MACD', BTC, PERIODS], ['MACD', ETH, PERIODS]]}
      ${'ETH/USDT, BTC/USDT'} | ${[ETH, BTC]} | ${[['MACD', ETH, PERIODS], ['MACD', BTC, PERIODS]]}
    `('should add a MACD on each watched pair, in the order of watch.assets: $case', ({ pairs, expected }) => {
      expect(indicatorsAtInit(new MACD(), pairs, tools.strategyParams)).toEqual(expected);
    });

    // The position book says once which pairs the strategy trades, and how: on one pair, init logs nothing, as it always did
    it.each`
      case           | pairs         | expected
      ${'one pair'}  | ${[BTC]}      | ${[]}
      ${'two pairs'} | ${[BTC, ETH]} | ${[BTC_ETH_TRADED_INFO]}
    `('should say once, at init, which pairs it trades, without a warning: $case', ({ pairs, expected }) => {
      expect(logsAtInit(new MACD(), pairs, tools.strategyParams)).toEqual(expected);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // An uptrend over the persistence, which buys once init has tracked the pairs: before it, the strategy knows no pair to trade
    it('should do nothing before init has tracked the pairs', () => {
      strategy = new MACD();
      play('up up');
      expect({ advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Nothing logged either: a NaN MACD failed both thresholds, logged as no trend, and an infinite one started a trend
    it.each`
      macdRes
      ${null}
      ${undefined}
      ${'invalid'}
      ${{ macd: 'not_number', signal: 0, hist: 0 }}
      ${{ macd: 1, signal: 'not_number', hist: 0 }}
      ${{ macd: 1, signal: 0, hist: 'not_number' }}
      ${{ macd: NaN, signal: 0, hist: 0 }}
      ${{ macd: Infinity, signal: 1, hist: 1 }}
      ${{ macd: 1, signal: NaN, hist: 0 }}
      ${{ macd: 1, signal: 1, hist: -Infinity }}
    `('should do nothing when MACD result is invalid ($macdRes)', ({ macdRes }) => {
      strategy.onTimeframeCandleAfterWarmup(candleParams(), ...makeIndicator(macdRes));
      expect({ advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Unskipped, a null MACD would throw as its field is read
    it.each`
      case                         | steps                                 | expectedSides
      ${'null within an uptrend'}  | ${'up null up'}                       | ${['BUY']}
      ${'null within a downtrend'} | ${'up up completed:1 down null down'} | ${['BUY', 'SELL']}
    `('should skip a candle whose MACD is null, as one not ready yet: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it.each`
      case                                 | steps                            | expected
      ${'a BUY on an uptrend when flat'}   | ${'up up'}                       | ${[allInBuy]}
      ${'a SELL on a downtrend when long'} | ${'up up completed:1 down down'} | ${[allInBuy, allInSell]}
    `('should emit an all-in STICKY order after persistence: $case', ({ steps, expected }) => {
      play(steps);
      expect(advices).toStrictEqual(expected);
    });

    it.each`
      case                                      | steps                                                     | expectedSides
      ${'an uptrend before persistence'}        | ${'up'}                                                   | ${[]}
      ${'an uptrend that continues'}            | ${'up up up'}                                             | ${['BUY']}
      ${'a downtrend before persistence'}       | ${'up up completed:1 down'}                               | ${['BUY']}
      ${'a downtrend that continues'}           | ${'up up completed:1 down down down'}                     | ${['BUY', 'SELL']}
      ${'a switch from up to down and back'}    | ${'up up completed:1 down down completed:2 up up'}        | ${['BUY', 'SELL', 'BUY']}
      ${'an uptrend after a shorter downtrend'} | ${'up up down up up'}                                     | ${['BUY']}
      ${'an uptrend while long'}                | ${'up up completed:1 down up up'}                         | ${['BUY']}
      ${'a downtrend after a shorter uptrend'}  | ${'up up completed:1 down down completed:2 up down down'} | ${['BUY', 'SELL']}
      ${'a downtrend when flat'}                | ${'down down down'}                                       | ${[]}
      ${'a downtrend while the BUY pends'}      | ${'up up down down'}                                      | ${['BUY']}
      ${'a new downtrend while the SELL pends'} | ${'up up completed:1 down down up down down'}             | ${['BUY', 'SELL']}
      ${'an uptrend once the SELL filled'}      | ${'up up completed:1 down down up up completed:2 up'}     | ${['BUY', 'SELL', 'BUY']}
    `('should advise once per position change on $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it('should log when no trend detected, and advise nothing', () => {
      play('none');
      expect({ advices, logs }).toEqual({ advices: [], logs: [{ level: 'debug', message: '[BTC/USDT] MACD: no trend detected' }] });
    });
  });

  describe('macdSrc', () => {
    // Each step has one field of the result beyond a threshold: the field macdSrc names makes the trend, and the others do not
    it.each`
      macdSrc     | case                            | steps                                                          | expectedSides
      ${'macd'}   | ${'the others up, when flat'}   | ${'signalUp signalUp histUp histUp'}                           | ${[]}
      ${'macd'}   | ${'the others down, when long'} | ${'up up completed:1 signalDown signalDown histDown histDown'} | ${['BUY']}
      ${'signal'} | ${'its field up, when flat'}    | ${'signalUp signalUp'}                                         | ${['BUY']}
      ${'signal'} | ${'the others up, when flat'}   | ${'up up histUp histUp'}                                       | ${[]}
      ${'signal'} | ${'its field down, when long'}  | ${'signalUp signalUp completed:1 signalDown signalDown'}       | ${['BUY', 'SELL']}
      ${'signal'} | ${'the others down, when long'} | ${'signalUp signalUp completed:1 down down histDown histDown'} | ${['BUY']}
      ${'hist'}   | ${'its field up, when flat'}    | ${'histUp histUp'}                                             | ${['BUY']}
      ${'hist'}   | ${'the others up, when flat'}   | ${'up up signalUp signalUp'}                                   | ${[]}
      ${'hist'}   | ${'its field down, when long'}  | ${'histUp histUp completed:1 histDown histDown'}               | ${['BUY', 'SELL']}
      ${'hist'}   | ${'the others down, when long'} | ${'histUp histUp completed:1 down down signalDown signalDown'} | ${['BUY']}
    `('should trade on the $macdSrc field only: $case', ({ macdSrc, steps, expectedSides }) => {
      tools.strategyParams.macdSrc = macdSrc;
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });
  });

  describe('order outcomes', () => {
    // An outcome reports nothing of an execution, unless its step gives the BTC left free after it ('errored:2:0', see playSteps)
    it.each`
      case                                                   | steps                                                         | expectedSides
      ${'a BUY completed: long, it sells'}                   | ${'up up completed:1 down down'}                              | ${['BUY', 'SELL']}
      ${'a BUY canceled: flat, it buys on the next trend'}   | ${'up up canceled:1 up down up up'}                           | ${['BUY', 'BUY']}
      ${'a BUY errored: flat, it buys on the next trend'}    | ${'up up errored:1 up down up up'}                            | ${['BUY', 'BUY']}
      ${'a SELL completed: flat, it buys again'}             | ${'up up completed:1 down down completed:2 up up'}            | ${['BUY', 'SELL', 'BUY']}
      ${'a SELL canceled: long, it sells on the next trend'} | ${'up up completed:1 down down canceled:2 down up down down'} | ${['BUY', 'SELL', 'SELL']}
      ${'a SELL errored: long, it sells on the next trend'}  | ${'up up completed:1 down down errored:2 down up down down'}  | ${['BUY', 'SELL', 'SELL']}
      ${'a SELL errored, all sold: flat, it buys again'}     | ${'up up completed:1 down down errored:2:0 up up'}            | ${['BUY', 'SELL', 'BUY']}
      ${'another order completed: still pending'}            | ${'up up completed:unknown up down down'}                     | ${['BUY']}
      ${'another order canceled: still pending'}             | ${'up up canceled:unknown up down down'}                      | ${['BUY']}
      ${'another order errored: still pending'}              | ${'up up errored:unknown up down down'}                       | ${['BUY']}
    `('should track $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });
  });

  describe('log', () => {
    it.each`
      macdRes
      ${null}
      ${undefined}
      ${'invalid'}
      ${{ macd: NaN, signal: 0, hist: 0 }}
      ${{ macd: 1, signal: 0, hist: Infinity }}
    `('should not log when MACD result is missing or invalid ($macdRes)', ({ macdRes }) => {
      strategy.log(candleParams(), ...makeIndicator(macdRes));
      expect(logs).toHaveLength(0);
    });

    // A result the indicator can produce: its hist is macd - signal, 1 exactly in binary
    it('should log MACD properties', () => {
      strategy.log(candleParams(), ...makeIndicator({ macd: 3.12345678, signal: 2.12345678, hist: 1 }));
      expect(logs).toEqual([
        { level: 'debug', message: '[BTC/USDT] macd: 3.12345678' },
        { level: 'debug', message: '[BTC/USDT] signal: 2.12345678' },
        { level: 'debug', message: '[BTC/USDT] hist: 1.00000000' },
      ]);
    });
  });

  describe('on two pairs', () => {
    // The line init logs on two pairs is asserted with init: the rows below read the lines of their candles alone
    beforeEach(() => {
      initOn([BTC, ETH]);
      logs = [];
    });

    it('should log the trend of each pair, each line prefixed with its pair', () => {
      play('up,down');
      expect(logs).toEqual([
        { level: 'info', message: '[BTC/USDT] MACD: up trend detected' },
        { level: 'debug', message: '[BTC/USDT] In uptrend since 1 candle' },
        { level: 'info', message: '[ETH/USDT] MACD: down trend detected' },
        { level: 'debug', message: '[ETH/USDT] In downtrend since 1 candle' },
      ]);
    });

    // Each pair counts the candles of its own trend: the uptrend of ETH starts on the second candle of that of BTC
    it('should count the candles of each trend on its own pair', () => {
      play('up,none up,up');
      expect(logs).toEqual([
        { level: 'info', message: '[BTC/USDT] MACD: up trend detected' },
        { level: 'debug', message: '[BTC/USDT] In uptrend since 1 candle' },
        { level: 'debug', message: '[ETH/USDT] MACD: no trend detected' },
        { level: 'debug', message: '[BTC/USDT] In uptrend since 2 candles' },
        { level: 'info', message: '[ETH/USDT] MACD: up trend detected' },
        { level: 'debug', message: '[ETH/USDT] In uptrend since 1 candle' },
      ]);
    });

    it('should log the MACD of each pair, each line prefixed with its pair', () => {
      strategy.log(candleParams(), ...indicatorArguments<MACDResult>({ [BTC]: [MACD_RESULTS.up], [ETH]: [MACD_RESULTS.down] }));
      expect(logs).toEqual([
        { level: 'debug', message: '[BTC/USDT] macd: 0.80000000' },
        { level: 'debug', message: '[BTC/USDT] signal: 0.40000000' },
        { level: 'debug', message: '[BTC/USDT] hist: 0.40000000' },
        { level: 'debug', message: '[ETH/USDT] macd: -0.80000000' },
        { level: 'debug', message: '[ETH/USDT] signal: -0.40000000' },
        { level: 'debug', message: '[ETH/USDT] hist: -0.40000000' },
      ]);
    });

    // A pair whose MACD is not ready yet (null) is skipped alone, and so is one whose MACD the arguments leave out, which the
    // StrategyManager never does: the MACD of ETH, at 0, is read as usual
    const btcNotReady = indicatorArguments({ [BTC]: [null], [ETH]: [MACD_RESULTS.none] });
    const btcLeftOut = indicatorArguments({ [ETH]: [MACD_RESULTS.none] });
    const ethNoTrend = ['[ETH/USDT] MACD: no trend detected'];
    const ethMacdAtZero = ['[ETH/USDT] macd: 0.00000000', '[ETH/USDT] signal: 0.00000000', '[ETH/USDT] hist: 0.00000000'];
    it.each`
      hook                              | case                               | indicators     | expected
      ${'onTimeframeCandleAfterWarmup'} | ${'BTC not ready yet'}             | ${btcNotReady} | ${ethNoTrend}
      ${'onTimeframeCandleAfterWarmup'} | ${'BTC left out of the arguments'} | ${btcLeftOut}  | ${ethNoTrend}
      ${'log'}                          | ${'BTC not ready yet'}             | ${btcNotReady} | ${ethMacdAtZero}
      ${'log'}                          | ${'BTC left out of the arguments'} | ${btcLeftOut}  | ${ethMacdAtZero}
    `('should read ETH alone in $hook: $case', ({ hook, indicators, expected }) => {
      strategy[hook as 'onTimeframeCandleAfterWarmup' | 'log'](candleParams(), ...indicators);
      expect(logs.map(({ message }) => message)).toEqual(expected);
    });

    // Each pair has its own position, which the outcomes of its own orders alone settle. The BUY of a pair takes 50 % of the free
    // currency while the other pair is not invested (flat, its BUY pending or not), all of it once the other is long (its SELL pending
    // or not)
    it.each`
      case                                                          | steps                                                             | expected
      ${'both flat: a BUY of each, 50 % each'}                      | ${'up,up up,up'}                                                  | ${[buyOf(BTC, 50), buyOf(ETH, 50)]}
      ${'BTC not ready on a candle: ETH buys first, 50 % each'}     | ${'up,up null,up up,up'}                                          | ${[buyOf(ETH, 50), buyOf(BTC, 50)]}
      ${'BTC long: the BUY of ETH all-in'}                          | ${'up,none up,none completed:1 none,up none,up'}                  | ${[buyOf(BTC, 50), buyOf(ETH)]}
      ${'BTC long, ETH flat: BTC sells as ETH buys, all-in'}        | ${'up,none up,none completed:1 down,up down,up'}                  | ${[buyOf(BTC, 50), sellOf(BTC), buyOf(ETH)]}
      ${'the BUY of ETH completed: ETH sells, BTC still pending'}   | ${'up,up up,up completed:2 down,down down,down'}                  | ${[buyOf(BTC, 50), buyOf(ETH, 50), sellOf(ETH)]}
      ${'the BUY of BTC canceled: ETH still long, BTC buys all-in'} | ${'up,up up,up completed:2 canceled:1 down,none up,none up,none'} | ${[buyOf(BTC, 50), buyOf(ETH, 50), buyOf(BTC)]}
    `('should trade each pair on its own position: $case', ({ steps, expected }) => {
      play(steps);
      expect(advices).toStrictEqual(expected);
    });

    // 10 USDT free and a minimum cost of 10 USDT on both markets: a share of 50 %, 5 USDT, costs 4.75 once 5 % is kept back for the
    // fee, and the book skips it, with a warning, then debug lines. The strategy takes a skipped BUY as placed: its trend adviced, it
    // asks again on the next uptrend only
    it.each`
      case                              | steps                                          | expected
      ${'an uptrend that continues'}    | ${'up,none up,none up,none'}                   | ${['warn']}
      ${'an uptrend after a downtrend'} | ${'up,none up,none down,none up,none up,none'} | ${['warn', 'debug']}
    `('should spend the signal of a BUY the book skips: $case', ({ steps, expected }) => {
      portfolio = new Map([['USDT', { free: 10, used: 0, total: 10 }]]);
      tools.marketData = new Map([
        [BTC, { cost: { min: 10 } }],
        [ETH, { cost: { min: 10 } }],
      ]);
      play(steps);
      const skips = logs.filter(({ message }) => message.startsWith('[BTC/USDT] BUY skipped')).map(({ level }) => level);
      expect({ advices, skips }).toEqual({ advices: [], skips: expected });
    });
  });

  describe('schema', () => {
    // The documentation's example, without the name that labels the run: the manager parses the block without it
    const params = { short: 12, long: 26, signal: 9, macdSrc: 'hist', thresholds: { up: 0, down: 0, persistence: 1 } };
    const withThresholds = (thresholds: object) => ({ ...params, thresholds: { ...params.thresholds, ...thresholds } });
    const swappedPeriods = 'short must be below long (swapped periods give the opposite MACD, equal ones a MACD of 0)';
    const signalOfOneOnHist =
      'signal must be at least 2 with macdSrc: hist (a signal of 1 makes the signal line the MACD line itself, and the histogram 0)';

    it('accepts the documentation example as it is', () => {
      expect(MACD.schema.parse(params)).toEqual(params);
    });

    // A signal of 1 is refused with the histogram only: the MACD line, which the signal line then equals, still moves
    it.each`
      scenario                                | block
      ${'a signal of 1 with macdSrc: macd'}   | ${{ ...params, signal: 1, macdSrc: 'macd' }}
      ${'a signal of 1 with macdSrc: signal'} | ${{ ...params, signal: 1, macdSrc: 'signal' }}
      ${'a signal of 2 with macdSrc: hist'}   | ${{ ...params, signal: 2 }}
    `('accepts $scenario', ({ block }) => {
      expect(MACD.schema.parse(block)).toEqual(block);
    });

    it('refuses a misspelt persistence (persistance)', () => {
      expect(MACD.schema.safeParse({ ...params, thresholds: { up: 0, down: 0, persistance: 1 } }).error?.issues).toMatchObject([
        { path: ['thresholds', 'persistence'] },
        { code: 'unrecognized_keys', keys: ['persistance'], path: ['thresholds'] },
      ]);
    });

    // A period of 0 is refused once, by its bound alone: neither the comparison of the periods nor the check of the signal reports it
    it.each`
      scenario                                  | block                                   | path
      ${'an unknown macdSrc (histogram)'}       | ${{ ...params, macdSrc: 'histogram' }}  | ${['macdSrc']}
      ${'a missing macdSrc'}                    | ${omit(params, 'macdSrc')}              | ${['macdSrc']}
      ${'a quoted signal'}                      | ${{ ...params, signal: '9' }}           | ${['signal']}
      ${'a fractional long'}                    | ${{ ...params, long: 26.5 }}            | ${['long']}
      ${'a short of 0'}                         | ${{ ...params, short: 0 }}              | ${['short']}
      ${'a long of 0'}                          | ${{ ...params, long: 0 }}               | ${['long']}
      ${'a signal of 0'}                        | ${{ ...params, signal: 0 }}             | ${['signal']}
      ${'swapped periods (short 26, long 12)'}  | ${{ ...params, short: 26, long: 12 }}   | ${[]}
      ${'equal periods'}                        | ${{ ...params, short: 26, long: 26 }}   | ${[]}
      ${'a signal of 1 with macdSrc: hist'}     | ${{ ...params, signal: 1 }}             | ${[]}
      ${'an infinite threshold'}                | ${withThresholds({ up: Infinity })}     | ${['thresholds', 'up']}
      ${'a fractional persistence'}             | ${withThresholds({ persistence: 0.5 })} | ${['thresholds', 'persistence']}
      ${'a src (the MACD strategy takes none)'} | ${{ ...params, src: 'close' }}          | ${[]}
    `('refuses $scenario', ({ block, path }) => {
      expect(MACD.schema.safeParse(block).error?.issues).toMatchObject([{ path }]);
    });

    it.each`
      scenario                              | block                                 | message
      ${'swapped periods'}                  | ${{ ...params, short: 26, long: 12 }} | ${swappedPeriods}
      ${'a signal of 1 with macdSrc: hist'} | ${{ ...params, signal: 1 }}           | ${signalOfOneOnHist}
    `('says why it refuses $scenario', ({ block, message }) => {
      expect(MACD.schema.safeParse(block).error?.issues[0].message).toBe(message);
    });

    // Each check reports on its own, so that a block with both mistakes is refused with both at once
    it('reports a signal of 1 with macdSrc: hist besides swapped periods', () => {
      const block = { ...params, short: 26, long: 12, signal: 1 };
      expect(MACD.schema.safeParse(block).error?.issues.map(({ message }) => message)).toEqual([swappedPeriods, signalOfOneOnHist]);
    });
  });
});
