import type { CandleBucket } from '@gekko/shared/models/event.types';
import type { TradingPair } from '@gekko/shared/models/utility.types';
import { listInWords } from '@gekko/shared/utils/string/string.utils';
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
import { sortBy } from 'lodash-es';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rsiStrategySchema } from '@gekko/schemas/strategies/rsi.schema';
import { RSI } from './rsi.strategy';
import { RSIStrategyParams } from './rsi.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
/** The strategy parameters of the suite: a trend below 30 or above 70 advises its order once it has lasted 2 candles */
const PARAMS: RSIStrategyParams = { period: 14, src: 'close', thresholds: { high: 70, low: 30, persistence: 2 } };
/** What init hands the RSI of each pair: the period and the source of PARAMS */
const RSI_PARAMETERS = { period: 14, src: 'close' };
// The RSI of each name a candle step gives a pair (see play), on the thresholds of PARAMS: an RSI at a threshold is in no trend, and
// null is what the indicator gives until it is ready
const RSI_VALUES = {
  high: 75,
  low: 20,
  neutral: 50,
  atHigh: 70,
  atLow: 30,
  nan: NaN,
  inf: Infinity,
  '-inf': -Infinity,
  null: null,
} as const;
/** Whether a candle step names an RSI (see RSI_VALUES) */
const isRSIName = (name: string): name is keyof typeof RSI_VALUES => Object.hasOwn(RSI_VALUES, name);
/** The STICKY BUY of `symbol` as the strategy asks tools.positions for it: the position book sizes it */
const buy = (symbol: TradingPair): AskedOrder => ({ type: 'STICKY', side: 'BUY', symbol });
/** The STICKY BUY of `symbol` as the strategy asks tools.positions for it, which the position book skips (see ScriptedPositions) */
const skippedBuy = (symbol: TradingPair): AskedOrder => ({ ...buy(symbol), skipped: true });
/** The STICKY SELL of `symbol` as the strategy asks tools.positions for it: of all of its asset */
const sell = (symbol: TradingPair): AskedOrder => ({ type: 'STICKY', side: 'SELL', symbol });
/** A line the strategy logs at info level, which the StrategyManager also relays as strategy info */
const info = (message: string): LoggedLine => ({ level: 'info', message });
/** A line the strategy logs at debug level, which the StrategyManager does not relay */
const debug = (message: string): LoggedLine => ({ level: 'debug', message });
/** A bucket holding a candle of each of `pairs`, in their order (that of watch.assets) */
const bucketOf = (pairs: TradingPair[]) => flatBucket(Object.fromEntries(pairs.map(pair => [pair, 100])));
/**
 * Plays init on a bucket of `pairs`, in their order (that of watch.assets), on fake tools of those pairs (see fakeTools): returns the
 * calls of tools.positions.track, and the pairs it had tracked at each addIndicator call
 */
const trackAtInit = (pairs: TradingPair[]) => {
  const { tools, positions } = fakeTools(PARAMS, { pairs });
  const trackedAtEachIndicator: TradingPair[][] = [];
  const addIndicator = () => {
    trackedAtEachIndicator.push([...positions.pairs]);
  };
  new RSI().init({ candle: bucketOf(pairs), portfolio: new Map(), tools, addIndicator });
  return { trackCalls: positions.trackCalls, trackedAtEachIndicator };
};

describe('RSI Strategy', () => {
  let strategy: RSI;
  let tools: Tools<RSIStrategyParams>;
  let positions: ScriptedPositions;
  let logs: LoggedLine[];
  /** The orders created through tools.createOrder, which the strategy leaves to tools.positions */
  let orders: OrderRecorder;
  let bucket: CandleBucket;

  /**
   * Builds the strategy and plays its init on a bucket of `pairs`, in their order (that of watch.assets), on fake tools of its own
   * (see playInit): each pair answers FLAT until the test sets another position
   */
  const start = (pairs: TradingPair[], params = PARAMS) => {
    strategy = new RSI();
    ({ tools, positions, logs, orders } = playInit(strategy, pairs, params));
    bucket = bucketOf(pairs);
  };
  /** The params of a candle hook: the bucket, an empty portfolio, which the strategy does not read, and the tools */
  const candleParams = (): OnCandleEventParams<RSIStrategyParams> => ({ candle: bucket, portfolio: new Map(), tools });
  /**
   * Plays the steps (see playPositionSteps): a position of each pair watched, in their order, separated by slashes, as the position
   * book would have settled the orders before it ('LONG' on BTC/USDT alone, 'LONG/FLAT' on BTC/USDT and ETH/USDT), or a candle, the
   * RSI of each pair watched, in their order, separated by commas (see RSI_VALUES): 'low' on BTC/USDT alone, 'low,neutral' on BTC/USDT
   * and ETH/USDT
   */
  const play = (steps: string) =>
    playPositionSteps(steps, positions, step => {
      const { watched } = positions;
      const names = step.split(',');
      // A misspelt step would be an undefined RSI, a candle skipped
      if (names.length !== watched.length || !names.every(isRSIName)) {
        throw new Error(`No step named ${step} on ${listInWords(watched)}, in "${steps}"`);
      }
      const rsis = watched.map((symbol, index) => ({ results: RSI_VALUES[names[index]], symbol }));
      strategy.onTimeframeCandleAfterWarmup(candleParams(), ...rsis);
    });
  /** The side of each order the strategy asked tools.positions for, in order */
  const sides = () => positions.advices.map(({ side }) => side);
  /**
   * Plays the steps (see play), and returns what the strategy did, in order: each line it logged (`<level> <message>`) and each order
   * it asked tools.positions for (`<SIDE> <pair>`). The StrategyManager relays its info lines and its orders as they come
   * (strategyInfo, strategyCreateOrder): the Telegram subscribers read them in that order (strat_info, strat_create).
   */
  const timelineOf = (steps: string) => {
    const lines = vi.spyOn(tools, 'log');
    const buys = vi.spyOn(positions, 'buy');
    const sells = vi.spyOn(positions, 'sell');
    play(steps);
    const done = [
      ...lines.mock.calls.map(([level, message], index) => ({ at: lines.mock.invocationCallOrder[index], what: `${level} ${message}` })),
      ...buys.mock.calls.map(([{ symbol }], index) => ({ at: buys.mock.invocationCallOrder[index], what: `BUY ${symbol}` })),
      ...sells.mock.calls.map(([{ symbol }], index) => ({ at: sells.mock.invocationCallOrder[index], what: `SELL ${symbol}` })),
    ];
    return sortBy(done, 'at').map(({ what }) => what);
  };

  beforeEach(() => {
    start([BTC]);
  });

  describe('init', () => {
    // The bucket holds a candle of every watched pair, in the order of watch.assets: each pair gets an RSI of its own, in that order,
    // of the period and the source of the strategy parameters
    it.each`
      case                                 | pairs         | params                                   | expected
      ${'BTC/USDT'}                        | ${[BTC]}      | ${PARAMS}                                | ${[['RSI', BTC, RSI_PARAMETERS]]}
      ${'BTC/USDT, ETH/USDT'}              | ${[BTC, ETH]} | ${PARAMS}                                | ${[['RSI', BTC, RSI_PARAMETERS], ['RSI', ETH, RSI_PARAMETERS]]}
      ${'ETH/USDT, BTC/USDT'}              | ${[ETH, BTC]} | ${PARAMS}                                | ${[['RSI', ETH, RSI_PARAMETERS], ['RSI', BTC, RSI_PARAMETERS]]}
      ${'BTC/USDT, a period of 21 on hl2'} | ${[BTC]}      | ${{ ...PARAMS, period: 21, src: 'hl2' }} | ${[['RSI', BTC, { period: 21, src: 'hl2' }]]}
    `(
      'should add an RSI of its period and source on each watched pair, in the order of watch.assets: $case',
      ({ pairs, params, expected }) => {
        expect(indicatorsAtInit(new RSI(), pairs, params)).toStrictEqual(expected);
      },
    );

    // tools.positions tracks no pair until init calls track, which tracks every watched pair when given none
    it.each`
      case           | pairs         | expected
      ${'one pair'}  | ${[BTC]}      | ${{ trackCalls: [[]], trackedAtEachIndicator: [[BTC]] }}
      ${'two pairs'} | ${[BTC, ETH]} | ${{ trackCalls: [[]], trackedAtEachIndicator: [[BTC, ETH], [BTC, ETH]] }}
    `(
      'should track every watched pair, through one call of tools.positions.track without pairs, before it adds their RSIs: $case',
      ({ pairs, expected }) => {
        expect(trackAtInit(pairs)).toStrictEqual(expected);
      },
    );

    // The position book says once which pairs it tracks when they are several, a line tested with it in @gekko/plugins: the strategy
    // itself logs nothing at init
    it.each`
      case           | pairs
      ${'one pair'}  | ${[BTC]}
      ${'two pairs'} | ${[BTC, ETH]}
    `('should log nothing at init: $case', ({ pairs }) => {
      expect(logsAtInit(new RSI(), pairs, PARAMS)).toEqual([]);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // A low trend over the persistence, which buys once init has tracked the pairs: before it, the strategy knows no pair to trade
    it('should do nothing before init has tracked the pairs', () => {
      strategy = new RSI();
      ({ tools, positions, logs, orders } = fakeTools(PARAMS));
      play('low low');
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
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
      strategy.onTimeframeCandleAfterWarmup(candleParams(), ...indicatorArguments({ [BTC]: [rsiRes] }));
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Compared as 0, a null RSI would count toward a low trend, or end a high one
    it.each`
      case                                        | steps                            | expectedSides
      ${'NaN within a low trend'}                 | ${'low nan low'}                 | ${['BUY']}
      ${'Infinity within a low trend'}            | ${'low inf low'}                 | ${['BUY']}
      ${'-Infinity twice when flat'}              | ${'-inf -inf'}                   | ${[]}
      ${'Infinity twice when long'}               | ${'low low LONG inf inf'}        | ${['BUY']}
      ${'null after a low candle'}                | ${'low null'}                    | ${[]}
      ${'null within a high trend'}               | ${'low low LONG high null high'} | ${['BUY', 'SELL']}
      ${'null until ready, then a low candle'}    | ${'null null low'}               | ${[]}
      ${'null until ready, then two low candles'} | ${'null null low low'}           | ${['BUY']}
    `('should skip a candle whose RSI is not a finite number, as one not ready yet: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // Once a trend has lasted the persistence, the position of its pair decides: a BUY needs it flat, a SELL long, with no order of the
    // pair pending. A BUY the position book skips is asked all the same, the strategy taking it as placed.
    it.each`
      trend     | position      | expected
      ${'low'}  | ${'FLAT'}     | ${[buy(BTC)]}
      ${'low'}  | ${'SKIPPING'} | ${[skippedBuy(BTC)]}
      ${'low'}  | ${'LONG'}     | ${[]}
      ${'low'}  | ${'BUYING'}   | ${[]}
      ${'low'}  | ${'SELLING'}  | ${[]}
      ${'high'} | ${'LONG'}     | ${[sell(BTC)]}
      ${'high'} | ${'FLAT'}     | ${[]}
      ${'high'} | ${'SKIPPING'} | ${[]}
      ${'high'} | ${'BUYING'}   | ${[]}
      ${'high'} | ${'SELLING'}  | ${[]}
    `(
      'should place a STICKY order through tools.positions on a $trend trend over the persistence as a pair $position allows',
      ({ trend, position, expected }) => {
        positions.set(BTC, position);
        play(`${trend} ${trend}`);
        expect(positions.advices).toStrictEqual(expected);
      },
    );

    // The position book places every order and settles its outcome: created with tools.createOrder, an order would not be its own, its
    // outcome changing no position, and created beside the book's, it would be sent twice
    it('should place its orders through tools.positions alone, none through tools.createOrder', () => {
      play('low low LONG high high');
      expect({ asked: sides(), created: orders.advices }).toEqual({ asked: ['BUY', 'SELL'], created: [] });
    });

    // Each position is written after the candle of the order that leads to it, as the position book would have settled that order:
    // BUYING or SELLING while it pends, then LONG or FLAT once it has filled
    it.each`
      case                                        | steps                                                | expectedSides
      ${'a low trend before persistence'}         | ${'low'}                                             | ${[]}
      ${'a low trend that continues'}             | ${'low low BUYING low'}                              | ${['BUY']}
      ${'a high trend before persistence'}        | ${'low low LONG high'}                               | ${['BUY']}
      ${'a high trend that continues'}            | ${'low low LONG high high SELLING high'}             | ${['BUY', 'SELL']}
      ${'a switch from low to high and back'}     | ${'low low LONG high high FLAT low low'}             | ${['BUY', 'SELL', 'BUY']}
      ${'neutral values'}                         | ${'neutral neutral'}                                 | ${[]}
      ${'an RSI at the low threshold'}            | ${'atLow atLow'}                                     | ${[]}
      ${'an RSI at the high threshold, long'}     | ${'LONG atHigh atHigh'}                              | ${[]}
      ${'a neutral candle within a low trend'}    | ${'low neutral low'}                                 | ${['BUY']}
      ${'a low trend after a shorter high trend'} | ${'low low BUYING high low low'}                     | ${['BUY']}
      ${'a low trend while long'}                 | ${'low low LONG neutral low low'}                    | ${['BUY']}
      ${'a new low trend while long'}             | ${'low low LONG high low low'}                       | ${['BUY']}
      ${'a high trend after a shorter low trend'} | ${'low low LONG high high FLAT low high high'}       | ${['BUY', 'SELL']}
      ${'a high trend when flat'}                 | ${'high high high'}                                  | ${[]}
      ${'a high trend while the BUY pends'}       | ${'low low BUYING high high'}                        | ${['BUY']}
      ${'a high trend once the BUY filled'}       | ${'low low BUYING high high LONG high'}              | ${['BUY', 'SELL']}
      ${'a low trend while the SELL pends'}       | ${'low low LONG high high SELLING low low'}          | ${['BUY', 'SELL']}
      ${'a new high trend while the SELL pends'}  | ${'low low LONG high high SELLING low high high'}    | ${['BUY', 'SELL']}
      ${'a low trend once the SELL filled'}       | ${'low low LONG high high SELLING low low FLAT low'} | ${['BUY', 'SELL', 'BUY']}
    `('should advise once per position change on $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // The position an order leaves once it has ended, written after the candle that placed it, as the position book settles that end.
    // The trend of an order canceled, or errored, stays adviced: the strategy orders again on the next trend only
    it.each`
      case                                                         | steps                                               | expectedSides
      ${'a BUY completed: long, it sells'}                         | ${'low low LONG high high'}                         | ${['BUY', 'SELL']}
      ${'a BUY without a fill: flat, it buys on the next trend'}   | ${'low low FLAT low high low low'}                  | ${['BUY', 'BUY']}
      ${'a SELL completed: flat, it buys again'}                   | ${'low low LONG high high FLAT low low'}            | ${['BUY', 'SELL', 'BUY']}
      ${'a SELL without a fill: long, it sells on the next trend'} | ${'low low LONG high high LONG high low high high'} | ${['BUY', 'SELL', 'SELL']}
    `('should trade on the position the end of its order left: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // Every line about a pair starts with it: on several pairs, the lines of each pair are told apart. A candle without a trend
    // neither ends the trend around it nor counts in it.
    it.each`
      case                                     | steps                | expected
      ${'a low trend'}                         | ${'low low'}         | ${[info('[BTC/USDT] RSI: low trend detected'), debug('[BTC/USDT] In low trend since 1 candle'), debug('[BTC/USDT] In low trend since 2 candles')]}
      ${'a high trend'}                        | ${'high'}            | ${[info('[BTC/USDT] RSI: high trend detected'), debug('[BTC/USDT] In high trend since 1 candle')]}
      ${'a low trend ended by a high one'}     | ${'low high'}        | ${[info('[BTC/USDT] RSI: low trend detected'), debug('[BTC/USDT] In low trend since 1 candle'), info('[BTC/USDT] RSI: high trend detected'), debug('[BTC/USDT] In high trend since 1 candle')]}
      ${'a neutral candle within a low trend'} | ${'low neutral low'} | ${[info('[BTC/USDT] RSI: low trend detected'), debug('[BTC/USDT] In low trend since 1 candle'), debug('[BTC/USDT] In low trend since 2 candles')]}
      ${'neutral values'}                      | ${'neutral'}         | ${[]}
      ${'an RSI at either threshold'}          | ${'atLow atHigh'}    | ${[]}
    `('should log the trends of the pair, each line prefixed with it: $case', ({ steps, expected }) => {
      play(steps);
      expect(logs).toStrictEqual(expected);
    });

    // On a persistence of 0 or 1, a trend advises on its first candle: the line saying that it started comes before the order, its
    // strategy info relayed first
    it.each`
      case                                     | persistence | steps               | expected
      ${'a BUY on a persistence of 0'}         | ${0}        | ${'low'}            | ${['info [BTC/USDT] RSI: low trend detected', 'debug [BTC/USDT] In low trend since 1 candle', 'BUY BTC/USDT']}
      ${'a BUY on a low trend of 1 candle'}    | ${1}        | ${'low'}            | ${['info [BTC/USDT] RSI: low trend detected', 'debug [BTC/USDT] In low trend since 1 candle', 'BUY BTC/USDT']}
      ${'a SELL on a high trend of 1 candle'}  | ${1}        | ${'LONG high'}      | ${['info [BTC/USDT] RSI: high trend detected', 'debug [BTC/USDT] In high trend since 1 candle', 'SELL BTC/USDT']}
      ${'a BUY on a low trend of 2 candles'}   | ${2}        | ${'low low'}        | ${['info [BTC/USDT] RSI: low trend detected', 'debug [BTC/USDT] In low trend since 1 candle', 'debug [BTC/USDT] In low trend since 2 candles', 'BUY BTC/USDT']}
      ${'a SELL on a high trend of 2 candles'} | ${2}        | ${'LONG high high'} | ${['info [BTC/USDT] RSI: high trend detected', 'debug [BTC/USDT] In high trend since 1 candle', 'debug [BTC/USDT] In high trend since 2 candles', 'SELL BTC/USDT']}
    `('should log the lines of a candle before the order it advises there: $case', ({ persistence, steps, expected }) => {
      start([BTC], { ...PARAMS, thresholds: { ...PARAMS.thresholds, persistence } });
      expect(timelineOf(steps)).toEqual(expected);
    });
  });

  describe('on two pairs', () => {
    beforeEach(() => {
      start([BTC, ETH]);
    });

    it('should log the trends of each pair, each line prefixed with its pair', () => {
      play('low,high low,high');
      expect(logs).toStrictEqual([
        info('[BTC/USDT] RSI: low trend detected'),
        debug('[BTC/USDT] In low trend since 1 candle'),
        info('[ETH/USDT] RSI: high trend detected'),
        debug('[ETH/USDT] In high trend since 1 candle'),
        debug('[BTC/USDT] In low trend since 2 candles'),
        debug('[ETH/USDT] In high trend since 2 candles'),
      ]);
    });

    // Pair by pair, in the order of watch.assets: the lines of a pair, then the order they advise, then the lines of the next pair
    it('should log the lines of each pair before the order it advises, pair by pair', () => {
      positions.set(ETH, 'LONG');
      expect(timelineOf('low,high low,high')).toEqual([
        'info [BTC/USDT] RSI: low trend detected',
        'debug [BTC/USDT] In low trend since 1 candle',
        'info [ETH/USDT] RSI: high trend detected',
        'debug [ETH/USDT] In high trend since 1 candle',
        'debug [BTC/USDT] In low trend since 2 candles',
        'BUY BTC/USDT',
        'debug [ETH/USDT] In high trend since 2 candles',
        'SELL ETH/USDT',
      ]);
    });

    // Each pair has its own trend and its own position: on a candle, each pair whose trend has lasted the persistence orders as its own
    // position allows, in the order of the pairs, whatever the position of the other
    it.each`
      state              | steps                    | expected
      ${'FLAT/FLAT'}     | ${'low,low low,low'}     | ${[buy(BTC), buy(ETH)]}
      ${'LONG/FLAT'}     | ${'low,low low,low'}     | ${[buy(ETH)]}
      ${'BUYING/FLAT'}   | ${'low,low low,low'}     | ${[buy(ETH)]}
      ${'SELLING/FLAT'}  | ${'low,low low,low'}     | ${[buy(ETH)]}
      ${'FLAT/LONG'}     | ${'low,low low,low'}     | ${[buy(BTC)]}
      ${'SKIPPING/FLAT'} | ${'low,low low,low'}     | ${[skippedBuy(BTC), buy(ETH)]}
      ${'LONG/LONG'}     | ${'high,high high,high'} | ${[sell(BTC), sell(ETH)]}
      ${'LONG/FLAT'}     | ${'high,high high,high'} | ${[sell(BTC)]}
      ${'FLAT/LONG'}     | ${'high,high high,high'} | ${[sell(ETH)]}
      ${'LONG/BUYING'}   | ${'high,high high,high'} | ${[sell(BTC)]}
      ${'LONG/SELLING'}  | ${'high,high high,high'} | ${[sell(BTC)]}
      ${'LONG/FLAT'}     | ${'high,low high,low'}   | ${[sell(BTC), buy(ETH)]}
      ${'FLAT/LONG'}     | ${'high,low high,low'}   | ${[]}
    `('should order each pair as its own position allows, on $steps: $state', ({ state, steps, expected }) => {
      play(`${state} ${steps}`);
      expect(positions.advices).toStrictEqual(expected);
    });

    // Each position is written after the candle of the order that leads to it, as the position book would have settled the orders
    // before it: the position of one pair leaves the orders of the other as they were
    it.each`
      case                                                            | steps                                                                                              | expected
      ${'BTC long: ETH buys on its own trend'}                        | ${'low,neutral low,neutral LONG/FLAT neutral,low neutral,low'}                                     | ${[buy(BTC), buy(ETH)]}
      ${'BTC long, ETH flat: BTC sells as ETH buys'}                  | ${'low,neutral low,neutral LONG/FLAT high,low high,low'}                                           | ${[buy(BTC), sell(BTC), buy(ETH)]}
      ${'BTC sold: BTC buys again'}                                   | ${'low,neutral low,neutral LONG/FLAT high,neutral high,neutral FLAT/FLAT low,neutral low,neutral'} | ${[buy(BTC), sell(BTC), buy(BTC)]}
      ${'BTC sold: ETH buys'}                                         | ${'low,neutral low,neutral LONG/FLAT high,neutral high,neutral FLAT/FLAT neutral,low neutral,low'} | ${[buy(BTC), sell(BTC), buy(ETH)]}
      ${'both long: each sells on its own high trend'}                | ${'low,low low,low LONG/LONG high,neutral high,high high,high'}                                    | ${[buy(BTC), buy(ETH), sell(BTC), sell(ETH)]}
      ${'a trend per pair: the high trend of ETH leaves that of BTC'} | ${'low,high low,low'}                                                                              | ${[buy(BTC)]}
      ${'a persistence per pair: ETH buys on its second low candle'}  | ${'low,low low,neutral neutral,low'}                                                               | ${[buy(BTC), buy(ETH)]}
      ${'BTC not ready: ETH buys, BTC flat'}                          | ${'null,low null,low'}                                                                             | ${[buy(ETH)]}
      ${'ETH sold: it buys on its next low trend, BTC still long'}    | ${'low,low low,low LONG/LONG neutral,high neutral,high LONG/FLAT low,low low,low'}                 | ${[buy(BTC), buy(ETH), sell(ETH), buy(ETH)]}
    `('should trade each pair on its own trend and position: $case', ({ steps, expected }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    // The StrategyManager passes the RSI of every pair: a pair whose RSI is missing is skipped, as one not ready
    it('should trade the pair whose RSI it gets, and skip the pair whose RSI is missing', () => {
      strategy.onTimeframeCandleAfterWarmup(candleParams(), ...indicatorArguments({ [BTC]: [RSI_VALUES.low] }));
      strategy.onTimeframeCandleAfterWarmup(candleParams(), ...indicatorArguments({ [BTC]: [RSI_VALUES.low] }));
      expect({ advices: positions.advices, logs }).toStrictEqual({
        advices: [buy(BTC)],
        logs: [
          info('[BTC/USDT] RSI: low trend detected'),
          debug('[BTC/USDT] In low trend since 1 candle'),
          debug('[BTC/USDT] In low trend since 2 candles'),
        ],
      });
    });

    // The strategy reads the RSI of a pair, never its candle: a candle missing from the bucket of the hook, which the StrategyManager
    // never hands, changes none of its orders
    it('should trade each pair on its RSI, the candle of BTC/USDT missing from the bucket', () => {
      bucket = bucketOf([ETH]);
      play('low,low low,low');
      expect(positions.advices).toStrictEqual([buy(BTC), buy(ETH)]);
    });

    // On several pairs the position book skips a BUY whose share of the currency the market would refuse, with lines of its own, tested
    // with it in @gekko/plugins. The strategy takes a skipped BUY as placed: its trend adviced, it asks again on the next low trend only
    it.each`
      case                              | steps                                                                                                   | expected
      ${'a low trend that continues'}   | ${'SKIPPING/FLAT low,neutral low,neutral low,neutral'}                                                  | ${[skippedBuy(BTC)]}
      ${'a low trend after a high one'} | ${'SKIPPING/FLAT low,neutral low,neutral low,neutral high,neutral low,neutral low,neutral low,neutral'} | ${[skippedBuy(BTC), skippedBuy(BTC)]}
    `('should spend the advice of a BUY the position book skips: $case', ({ steps, expected }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    // The strategy logs its trends, not its orders: the position book alone says why it skips a BUY
    it.each`
      position      | advice
      ${'FLAT'}     | ${buy(ETH)}
      ${'SKIPPING'} | ${skippedBuy(ETH)}
    `('should log the same lines whether the position book places or skips its BUY: ETH $position', ({ position, advice }) => {
      positions.set(ETH, position);
      play('neutral,low neutral,low');
      expect({ advices: positions.advices, logs }).toStrictEqual({
        advices: [advice],
        logs: [
          info('[ETH/USDT] RSI: low trend detected'),
          debug('[ETH/USDT] In low trend since 1 candle'),
          debug('[ETH/USDT] In low trend since 2 candles'),
        ],
      });
    });
  });

  // The refusals of the schema are tested in @gekko/schemas: here, that the class declares it, the StrategyManager parsing the block with it
  it('should declare the strategy schema of @gekko/schemas', () => {
    expect(RSI.schema).toBe(rsiStrategySchema);
  });
});
