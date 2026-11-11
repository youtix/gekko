import type { CandleBucket } from '@gekko/shared/models/event.types';
import type { TradingPair } from '@gekko/shared/models/utility.types';
import {
  AskedOrder,
  fakeTools,
  flatBucket,
  indicatorArguments,
  indicatorsAtInit,
  LoggedLine,
  logsAtInit,
  OrderRecorder,
  playInit,
  playPositionSteps,
  ScriptedPositions,
} from '../strategy.mock';
import type { OnCandleEventParams, Tools } from '../strategy.types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { macdStrategySchema } from '@gekko/schemas/strategies/macd.schema';
import { MACD } from './macd.strategy';
import { MACDStrategyParams } from './macd.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
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
/**
 * The strategy parameters of the suite, which trade on the field `macdSrc` names, the MACD line unless given, once a trend has lasted
 * `persistence` candles, 2 unless given
 */
const paramsOf = ({
  macdSrc = 'macd',
  persistence = 2,
}: { macdSrc?: MACDStrategyParams['macdSrc']; persistence?: number } = {}): MACDStrategyParams => ({
  ...PERIODS,
  macdSrc,
  thresholds: { up: 0.5, down: -0.5, persistence },
});
/** The STICKY BUY of `symbol` as the strategy asks tools.positions for it: the position book sizes it */
const buy = (symbol: TradingPair): AskedOrder => ({ type: 'STICKY', side: 'BUY', symbol });
/** The STICKY SELL of `symbol` as the strategy asks tools.positions for it: of all of its asset */
const sell = (symbol: TradingPair): AskedOrder => ({ type: 'STICKY', side: 'SELL', symbol });
/** The STICKY BUY of `symbol` as the strategy asks tools.positions for it, which the position book skips (see ScriptedPositions) */
const skippedBuy = (symbol: TradingPair): AskedOrder => ({ ...buy(symbol), skipped: true });
/** A bucket holding a candle of each of `pairs`, in their order (that of watch.assets) */
const bucketOf = (pairs: TradingPair[]) => flatBucket(Object.fromEntries(pairs.map(pair => [pair, 1])));
/**
 * Plays init on a bucket of `pairs`, in their order (that of watch.assets), on fake tools of those pairs (see fakeTools): returns the
 * calls of tools.positions.track, and the pairs tools.positions tracked as each addIndicator call came
 */
const trackAtInit = (pairs: TradingPair[]) => {
  const { tools, positions } = fakeTools(paramsOf(), { pairs });
  const trackedAtEachIndicator: TradingPair[][] = [];
  const addIndicator = () => {
    trackedAtEachIndicator.push([...positions.pairs]);
  };
  new MACD().init({ candle: bucketOf(pairs), portfolio: new Map(), tools, addIndicator });
  return { trackCalls: positions.trackCalls, trackedAtEachIndicator };
};

describe('MACD Strategy', () => {
  let strategy: MACD;
  let tools: Tools<MACDStrategyParams>;
  let positions: ScriptedPositions;
  let logs: LoggedLine[];
  /** The orders created through tools.createOrder, which a strategy trading through tools.positions never creates */
  let orders: OrderRecorder;
  let bucket: CandleBucket;

  /**
   * Builds the strategy and plays its init on a bucket of `pairs`, in their order (that of watch.assets), on fake tools of its own
   * (see playInit): each pair answers FLAT until the test sets another position
   */
  const initOn = (pairs: TradingPair[], params = paramsOf()) => {
    strategy = new MACD();
    ({ tools, positions, logs, orders } = playInit(strategy, pairs, params));
    bucket = bucketOf(pairs);
  };
  /** Builds the strategy on fake tools of BTC/USDT without playing its init: tools.positions tracks no pair (see fakeTools) */
  const skipInit = () => {
    strategy = new MACD();
    ({ tools, positions, logs, orders } = fakeTools(paramsOf()));
  };
  /** The params of a candle hook: the bucket of the pairs, an empty portfolio, which the strategy does not read, and the tools */
  const candleParams = (): OnCandleEventParams<MACDStrategyParams> => ({ candle: bucket, portfolio: new Map(), tools });
  /**
   * Plays the steps (see playPositionSteps): a position of each pair of the bucket, in its order, separated by slashes, as the
   * position book would have settled the orders before it ('LONG' on BTC/USDT alone, 'LONG/FLAT' on BTC/USDT and ETH/USDT), or a
   * candle, the MACD result of each pair of the bucket, in its order, separated by commas (see MACD_RESULTS): 'up' on BTC/USDT alone,
   * 'up,none' on BTC/USDT and ETH/USDT
   */
  const play = (steps: string) =>
    playPositionSteps(steps, positions, step => {
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
  const sides = () => positions.advices.map(({ side }) => side);
  /**
   * Plays the steps (see play), and gives what the strategy did, in order: each line it logged, as `<level> <message>`, and each order
   * it asked tools.positions for, as `<SIDE> <pair>`, written before the first line logged after it
   */
  const traceOf = (steps: string) => {
    const trace: string[] = [];
    let written = 0;
    // The orders asked since the line before, which come before the line being logged
    const writeOrders = () => {
      trace.push(...positions.advices.slice(written).map(({ side, symbol }) => `${side} ${symbol}`));
      written = positions.advices.length;
    };
    vi.spyOn(tools, 'log').mockImplementation((level, message) => {
      writeOrders();
      trace.push(`${level} ${message}`);
    });
    play(steps);
    writeOrders();
    return trace;
  };

  beforeEach(() => {
    initOn([BTC]);
  });

  describe('init', () => {
    // The bucket holds a candle of every watched pair, in the order of watch.assets: each pair gets a MACD of its own, in that order,
    // of the periods of the strategy parameters
    it.each`
      case                    | pairs         | expected
      ${'BTC/USDT'}           | ${[BTC]}      | ${[['MACD', BTC, PERIODS]]}
      ${'BTC/USDT, ETH/USDT'} | ${[BTC, ETH]} | ${[['MACD', BTC, PERIODS], ['MACD', ETH, PERIODS]]}
      ${'ETH/USDT, BTC/USDT'} | ${[ETH, BTC]} | ${[['MACD', ETH, PERIODS], ['MACD', BTC, PERIODS]]}
    `('should add a MACD on each watched pair, in the order of watch.assets: $case', ({ pairs, expected }) => {
      expect(indicatorsAtInit(new MACD(), pairs, paramsOf())).toStrictEqual(expected);
    });

    // tools.positions tracks no pair until init calls track, which tracks every watched pair when given none
    it.each`
      case           | pairs         | expected
      ${'one pair'}  | ${[BTC]}      | ${{ trackCalls: [[]], trackedAtEachIndicator: [[BTC]] }}
      ${'two pairs'} | ${[BTC, ETH]} | ${{ trackCalls: [[]], trackedAtEachIndicator: [[BTC, ETH], [BTC, ETH]] }}
    `(
      'should track every watched pair, through one call of tools.positions.track without pairs, before it adds their MACDs: $case',
      ({ pairs, expected }) => {
        expect(trackAtInit(pairs)).toStrictEqual(expected);
      },
    );

    // The position book says once which pairs it tracks when they are several, a line tested with it in @gekko/plugins: the strategy
    // itself logs nothing at init, and warns of no pair
    it.each`
      case           | pairs
      ${'one pair'}  | ${[BTC]}
      ${'two pairs'} | ${[BTC, ETH]}
    `('should log nothing at init: $case', ({ pairs }) => {
      expect(logsAtInit(new MACD(), pairs, paramsOf())).toEqual([]);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // An uptrend over the persistence, which buys once init has tracked the pairs: before it, the strategy knows no pair to trade
    it('should do nothing before init has tracked the pairs', () => {
      skipInit();
      play('up up');
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
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
      strategy.onTimeframeCandleAfterWarmup(candleParams(), ...indicatorArguments({ [BTC]: [macdRes] }));
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Unskipped, a null MACD would throw as its field is read
    it.each`
      case                         | steps                          | expectedSides
      ${'null within an uptrend'}  | ${'up null up'}                | ${['BUY']}
      ${'null within a downtrend'} | ${'up up LONG down null down'} | ${['BUY', 'SELL']}
    `('should skip a candle whose MACD is null, as one not ready yet: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // Once a trend has lasted the persistence, the position of its pair decides: a BUY needs it flat, a SELL long, with no order of the
    // pair pending. A BUY the position book skips is asked all the same, the strategy taking it as placed.
    it.each`
      trend     | position      | expected
      ${'up'}   | ${'FLAT'}     | ${[buy(BTC)]}
      ${'up'}   | ${'SKIPPING'} | ${[skippedBuy(BTC)]}
      ${'up'}   | ${'LONG'}     | ${[]}
      ${'up'}   | ${'BUYING'}   | ${[]}
      ${'up'}   | ${'SELLING'}  | ${[]}
      ${'down'} | ${'LONG'}     | ${[sell(BTC)]}
      ${'down'} | ${'FLAT'}     | ${[]}
      ${'down'} | ${'SKIPPING'} | ${[]}
      ${'down'} | ${'BUYING'}   | ${[]}
      ${'down'} | ${'SELLING'}  | ${[]}
    `(
      'should place a STICKY order through tools.positions on a $trend trend over the persistence as a pair $position allows',
      ({ trend, position, expected }) => {
        positions.set(BTC, position);
        play(`${trend} ${trend}`);
        expect(positions.advices).toStrictEqual(expected);
      },
    );

    // The position book places every order and settles its outcome: an order created with tools.createOrder would not be its own, and
    // one placed through both would be sent twice
    it('should place its orders through tools.positions alone, none through tools.createOrder', () => {
      play('up up LONG down down');
      expect({ asked: sides(), created: orders.advices }).toEqual({ asked: ['BUY', 'SELL'], created: [] });
    });

    // Each position is written after the candle of the order that leads to it, as the position book would have settled that order:
    // BUYING or SELLING while it pends, then LONG or FLAT once it has filled
    it.each`
      case                                      | steps                                           | expectedSides
      ${'an uptrend before persistence'}        | ${'up'}                                         | ${[]}
      ${'an uptrend that continues'}            | ${'up up BUYING up'}                            | ${['BUY']}
      ${'a downtrend before persistence'}       | ${'up up LONG down'}                            | ${['BUY']}
      ${'a downtrend that continues'}           | ${'up up LONG down down SELLING down'}          | ${['BUY', 'SELL']}
      ${'a switch from up to down and back'}    | ${'up up LONG down down FLAT up up'}            | ${['BUY', 'SELL', 'BUY']}
      ${'an uptrend after a shorter downtrend'} | ${'up up BUYING down up up'}                    | ${['BUY']}
      ${'an uptrend while long'}                | ${'up up LONG down up up'}                      | ${['BUY']}
      ${'a downtrend after a shorter uptrend'}  | ${'up up LONG down down FLAT up down down'}     | ${['BUY', 'SELL']}
      ${'a downtrend when flat'}                | ${'down down down'}                             | ${[]}
      ${'a downtrend while the BUY pends'}      | ${'up up BUYING down down'}                     | ${['BUY']}
      ${'a new downtrend while the SELL pends'} | ${'up up LONG down down SELLING up down down'}  | ${['BUY', 'SELL']}
      ${'an uptrend once the SELL filled'}      | ${'up up LONG down down SELLING up up FLAT up'} | ${['BUY', 'SELL', 'BUY']}
    `('should advise once per position change on $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // An order canceled, or errored, leaves the position it found: the step after the order writes it, as the position book settles
    // such an outcome. The trend of that order stays adviced: the strategy orders again on the next trend only
    it.each`
      case                                           | steps                                            | expectedSides
      ${'a BUY without a fill: flat, it buys again'} | ${'up up FLAT up down up up'}                    | ${['BUY', 'BUY']}
      ${'a SELL: long, it sells again'}              | ${'up up LONG down down LONG down up down down'} | ${['BUY', 'SELL', 'SELL']}
    `('should wait for the next trend once its order was canceled or errored: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // A candle without a trend neither ends the trend around it nor counts in it: the uptrend buys on its second candle all the same
    it('should log each trend and the candles it lasts, each line prefixed with its pair, as it trades', () => {
      play('up none up LONG down down');
      expect({ advices: positions.advices, logs }).toStrictEqual({
        advices: [buy(BTC), sell(BTC)],
        logs: [
          { level: 'info', message: '[BTC/USDT] MACD: up trend detected' },
          { level: 'debug', message: '[BTC/USDT] In uptrend since 1 candle' },
          { level: 'debug', message: '[BTC/USDT] MACD: no trend detected' },
          { level: 'debug', message: '[BTC/USDT] In uptrend since 2 candles' },
          { level: 'info', message: '[BTC/USDT] MACD: down trend detected' },
          { level: 'debug', message: '[BTC/USDT] In downtrend since 1 candle' },
          { level: 'debug', message: '[BTC/USDT] In downtrend since 2 candles' },
        ],
      });
    });

    // The TradingAdvisor relays an info line as strategyInfo and an order as strategyCreateOrder, in the order the strategy makes them,
    // which the strat_info and strat_create notifications follow: the lines of a candle come before the order it places there, pair by
    // pair. On a persistence of 0 or 1, that is the trend detected before the order of the trend's first candle (see traceOf).
    const orderedOnFirstCandle = [
      'info [BTC/USDT] MACD: up trend detected',
      'debug [BTC/USDT] In uptrend since 1 candle',
      'BUY BTC/USDT',
      'info [BTC/USDT] MACD: down trend detected',
      'debug [BTC/USDT] In downtrend since 1 candle',
      'SELL BTC/USDT',
    ];
    const orderedOnSecondCandle = [
      'info [BTC/USDT] MACD: up trend detected',
      'debug [BTC/USDT] In uptrend since 1 candle',
      'debug [BTC/USDT] In uptrend since 2 candles',
      'BUY BTC/USDT',
      'info [BTC/USDT] MACD: down trend detected',
      'debug [BTC/USDT] In downtrend since 1 candle',
      'debug [BTC/USDT] In downtrend since 2 candles',
      'SELL BTC/USDT',
    ];
    const btcSellsEthBuys = [
      'info [BTC/USDT] MACD: down trend detected',
      'debug [BTC/USDT] In downtrend since 1 candle',
      'SELL BTC/USDT',
      'info [ETH/USDT] MACD: up trend detected',
      'debug [ETH/USDT] In uptrend since 1 candle',
      'BUY ETH/USDT',
    ];
    it.each`
      case                                    | pairs         | persistence | steps                     | expected
      ${'a BUY then a SELL, persistence 0'}   | ${[BTC]}      | ${0}        | ${'up LONG down'}         | ${orderedOnFirstCandle}
      ${'a BUY then a SELL, persistence 1'}   | ${[BTC]}      | ${1}        | ${'up LONG down'}         | ${orderedOnFirstCandle}
      ${'a BUY then a SELL, persistence 2'}   | ${[BTC]}      | ${2}        | ${'up up LONG down down'} | ${orderedOnSecondCandle}
      ${'BTC sells, ETH buys, persistence 1'} | ${[BTC, ETH]} | ${1}        | ${'LONG/FLAT down,up'}    | ${btcSellsEthBuys}
    `('should log the lines of a candle before the order it places there: $case', ({ pairs, persistence, steps, expected }) => {
      initOn(pairs, paramsOf({ persistence }));
      expect(traceOf(steps)).toEqual(expected);
    });

    it('should log when no trend detected, and advise nothing', () => {
      play('none');
      expect({ advices: positions.advices, logs }).toEqual({
        advices: [],
        logs: [{ level: 'debug', message: '[BTC/USDT] MACD: no trend detected' }],
      });
    });
  });

  describe('macdSrc', () => {
    // Each step has one field of the result beyond a threshold: the field macdSrc names makes the trend, and the others do not
    it.each`
      macdSrc     | case                            | steps                                                   | expectedSides
      ${'macd'}   | ${'the others up, when flat'}   | ${'signalUp signalUp histUp histUp'}                    | ${[]}
      ${'macd'}   | ${'the others down, when long'} | ${'up up LONG signalDown signalDown histDown histDown'} | ${['BUY']}
      ${'signal'} | ${'its field up, when flat'}    | ${'signalUp signalUp'}                                  | ${['BUY']}
      ${'signal'} | ${'the others up, when flat'}   | ${'up up histUp histUp'}                                | ${[]}
      ${'signal'} | ${'its field down, when long'}  | ${'signalUp signalUp LONG signalDown signalDown'}       | ${['BUY', 'SELL']}
      ${'signal'} | ${'the others down, when long'} | ${'signalUp signalUp LONG down down histDown histDown'} | ${['BUY']}
      ${'hist'}   | ${'its field up, when flat'}    | ${'histUp histUp'}                                      | ${['BUY']}
      ${'hist'}   | ${'the others up, when flat'}   | ${'up up signalUp signalUp'}                            | ${[]}
      ${'hist'}   | ${'its field down, when long'}  | ${'histUp histUp LONG histDown histDown'}               | ${['BUY', 'SELL']}
      ${'hist'}   | ${'the others down, when long'} | ${'histUp histUp LONG down down signalDown signalDown'} | ${['BUY']}
    `('should trade on the $macdSrc field only: $case', ({ macdSrc, steps, expectedSides }) => {
      initOn([BTC], paramsOf({ macdSrc }));
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });
  });

  describe('log', () => {
    // In a run, init tracks the pairs before any candle: before it, the strategy knows no pair to log the MACD of
    it('should log nothing before init has tracked the pairs', () => {
      skipInit();
      strategy.log(candleParams(), ...indicatorArguments<MACDResult>({ [BTC]: [MACD_RESULTS.up] }));
      expect(logs).toEqual([]);
    });

    it.each`
      macdRes
      ${null}
      ${undefined}
      ${'invalid'}
      ${{ macd: NaN, signal: 0, hist: 0 }}
      ${{ macd: 1, signal: 0, hist: Infinity }}
    `('should not log when MACD result is missing or invalid ($macdRes)', ({ macdRes }) => {
      strategy.log(candleParams(), ...indicatorArguments({ [BTC]: [macdRes] }));
      expect(logs).toHaveLength(0);
    });

    // A result the indicator can produce: its hist is macd - signal, 1 exactly in binary
    it('should log MACD properties', () => {
      strategy.log(candleParams(), ...indicatorArguments<MACDResult>({ [BTC]: [{ macd: 3.12345678, signal: 2.12345678, hist: 1 }] }));
      expect(logs).toEqual([
        { level: 'debug', message: '[BTC/USDT] macd: 3.12345678' },
        { level: 'debug', message: '[BTC/USDT] signal: 2.12345678' },
        { level: 'debug', message: '[BTC/USDT] hist: 1.00000000' },
      ]);
    });
  });

  describe('on two pairs', () => {
    beforeEach(() => {
      initOn([BTC, ETH]);
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

    // Each pair has its own trend and its own position: the position of one pair, written as the position book would have settled the
    // orders before it, leaves the orders of the other as they were
    it.each`
      case                                                      | steps                                                | expected
      ${'both flat: a BUY of each, in the order of the pairs'}  | ${'up,up up,up'}                                     | ${[buy(BTC), buy(ETH)]}
      ${'BTC not ready on a candle: ETH buys first'}            | ${'up,up null,up up,up'}                             | ${[buy(ETH), buy(BTC)]}
      ${'BTC long: ETH buys on its own trend'}                  | ${'up,none up,none LONG/FLAT none,up none,up'}       | ${[buy(BTC), buy(ETH)]}
      ${'BTC long, ETH flat: BTC sells as ETH buys'}            | ${'up,none up,none LONG/FLAT down,up down,up'}       | ${[buy(BTC), sell(BTC), buy(ETH)]}
      ${'ETH long, BTC still buying: ETH sells alone'}          | ${'up,up up,up BUYING/LONG down,down down,down'}     | ${[buy(BTC), buy(ETH), sell(ETH)]}
      ${'BTC flat again, ETH long: BTC buys on its next trend'} | ${'up,up up,up FLAT/LONG down,none up,none up,none'} | ${[buy(BTC), buy(ETH), buy(BTC)]}
    `('should trade each pair on its own position: $case', ({ steps, expected }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    // On several pairs the position book skips a BUY whose share of the currency the market would refuse, with lines of its own, tested
    // with it in @gekko/plugins. The strategy takes a skipped BUY as placed: its trend adviced, it asks again on the next uptrend only
    it.each`
      case                              | steps                                                        | expected
      ${'an uptrend that continues'}    | ${'SKIPPING/FLAT up,none up,none up,none'}                   | ${[skippedBuy(BTC)]}
      ${'an uptrend after a downtrend'} | ${'SKIPPING/FLAT up,none up,none down,none up,none up,none'} | ${[skippedBuy(BTC), skippedBuy(BTC)]}
    `('should spend the signal of a BUY the position book skips: $case', ({ steps, expected }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    // The strategy logs no line that says it placed a BUY: a candle whose BUY the position book skips logs what it logs with the BUY
    // placed, its trend lines alone
    it('should log no line of a BUY the position book skips, as of a BUY it places', () => {
      play('SKIPPING/FLAT up,none up,none');
      expect(logs).toEqual([
        { level: 'info', message: '[BTC/USDT] MACD: up trend detected' },
        { level: 'debug', message: '[BTC/USDT] In uptrend since 1 candle' },
        { level: 'debug', message: '[ETH/USDT] MACD: no trend detected' },
        { level: 'debug', message: '[BTC/USDT] In uptrend since 2 candles' },
        { level: 'debug', message: '[ETH/USDT] MACD: no trend detected' },
      ]);
    });
  });

  // The refusals of the schema are tested in @gekko/schemas: here, that the class declares it, the StrategyManager parsing the block with it
  it('should declare the strategy schema of @gekko/schemas', () => {
    expect(MACD.schema).toBe(macdStrategySchema);
  });
});
