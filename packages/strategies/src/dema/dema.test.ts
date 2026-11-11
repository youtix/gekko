import { CandleBucket } from '@gekko/shared/models/event.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
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
import { AddIndicatorFn, OnCandleEventParams, Tools } from '../strategy.types';
import { pick } from 'lodash-es';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demaStrategySchema } from '@gekko/schemas/strategies/dema.schema';
import { DEMA } from './dema.strategy';
import { DEMAStrategyParams } from './dema.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
// The parameters of the strategy: a trend is a diff above 0.5 or below -0.5 (see TRENDS)
const PARAMS: DEMAStrategyParams = { period: 14, thresholds: { up: 0.5, down: -0.5 } };
// The DEMA and SMA results of each candle step of the scenarios played below: diff = SMA - DEMA against the thresholds 0.5 / -0.5, a
// diff of exactly one of them (atUp, atDown) being none. Null is what an indicator gives until it is ready: the DEMA, ready later than
// the SMA of its period, or the SMA.
const TRENDS = {
  up: { dema: 1, sma: 2 },
  down: { dema: 1, sma: 0 },
  neutral: { dema: 1, sma: 1 },
  atUp: { dema: 1, sma: 1.5 },
  atDown: { dema: 1, sma: 0.5 },
  demaNull: { dema: null, sma: 2 },
  smaNull: { dema: 2, sma: null },
} as const;
// The close of the candles of each pair, which its lines quote
const CLOSES: Record<TradingPair, number> = { [BTC]: 10, [ETH]: 20 };
/** The STICKY BUY of `symbol` as the strategy asks tools.positions for it: the position book sizes it */
const buy = (symbol: TradingPair): AskedOrder => ({ type: 'STICKY', side: 'BUY', symbol });
/** That BUY, which the position book skips (see ScriptedPositions): asked for, neither sent nor pending */
const skippedBuy = (symbol: TradingPair): AskedOrder => ({ ...buy(symbol), skipped: true });
/** The STICKY SELL of `symbol` as the strategy asks tools.positions for it: of all of its asset */
const sell = (symbol: TradingPair): AskedOrder => ({ type: 'STICKY', side: 'SELL', symbol });
// The lines of a candle on each pair, at the close of its candles (see CLOSES): its trend (a diff of 1, -1 or 0, or one at a threshold,
// see TRENDS), then the advice the position allows
const LINES = {
  btcUp: { level: 'debug', message: '[BTC/USDT] We are currently in uptrend: @ 10.00000000 (1.00000/1.00000)' },
  btcBuy: { level: 'info', message: '[BTC/USDT] Executing long advice due to detected uptrend: @ 10.00000000 (1.00000/1.00000)' },
  btcDown: { level: 'debug', message: '[BTC/USDT] We are currently in a downtrend: @ 10.00000000 (1.00000/-1.00000)' },
  btcSell: { level: 'info', message: '[BTC/USDT] Executing short advice due to detected downtrend: @ 10.00000000 (1.00000/-1.00000)' },
  btcNeutral: { level: 'debug', message: '[BTC/USDT] We are currently not in an up or down trend: @ 10.00000000 (1.00000/0.00000)' },
  btcAtUp: { level: 'debug', message: '[BTC/USDT] We are currently not in an up or down trend: @ 10.00000000 (1.00000/0.50000)' },
  btcAtDown: { level: 'debug', message: '[BTC/USDT] We are currently not in an up or down trend: @ 10.00000000 (1.00000/-0.50000)' },
  ethUp: { level: 'debug', message: '[ETH/USDT] We are currently in uptrend: @ 20.00000000 (1.00000/1.00000)' },
  ethBuy: { level: 'info', message: '[ETH/USDT] Executing long advice due to detected uptrend: @ 20.00000000 (1.00000/1.00000)' },
  ethDown: { level: 'debug', message: '[ETH/USDT] We are currently in a downtrend: @ 20.00000000 (1.00000/-1.00000)' },
  ethSell: { level: 'info', message: '[ETH/USDT] Executing short advice due to detected downtrend: @ 20.00000000 (1.00000/-1.00000)' },
  ethNeutral: { level: 'debug', message: '[ETH/USDT] We are currently not in an up or down trend: @ 20.00000000 (1.00000/0.00000)' },
} satisfies Record<string, LoggedLine>;
// The lines of the log hook on each pair, its DEMA then its SMA being 1.23456 and 2.34567 on BTC/USDT, 3.45678 and 4.56789 on ETH/USDT
const PROPERTIES = {
  btc: { level: 'debug', message: '[BTC/USDT] Calculated DEMA and SMA properties for candle: DEMA: 1.23456 SMA: 2.34567' },
  eth: { level: 'debug', message: '[ETH/USDT] Calculated DEMA and SMA properties for candle: DEMA: 3.45678 SMA: 4.56789' },
} satisfies Record<string, LoggedLine>;

describe('DEMA Strategy', () => {
  let strategy: DEMA;
  let tools: Tools<DEMAStrategyParams>;
  let positions: ScriptedPositions;
  let logs: LoggedLine[];
  let orders: OrderRecorder;
  let pairs: TradingPair[];
  let bucket: CandleBucket;

  /**
   * A new strategy, its init played on fake tools of the pairs `watched`, in their order (watch.assets, see playInit), each flat with
   * nothing pending until the test sets its position (see ScriptedPositions); `logs` keeps what it logs next
   */
  const initOn = (...watched: TradingPair[]) => {
    pairs = watched;
    bucket = flatBucket(pick(CLOSES, watched));
    strategy = new DEMA();
    ({ tools, positions, logs, orders } = playInit(strategy, watched, PARAMS));
    logs.splice(0);
  };
  /** The params of a candle hook, on the bucket of the pairs watched unless another `candle` is given */
  const hookParams = (candle = bucket): OnCandleEventParams<DEMAStrategyParams> => ({ candle, portfolio: new Map(), tools });
  /**
   * Plays the steps (see playPositionSteps): a step naming a position for each pair watched sets what tools.positions answers from then
   * on ('LONG' on one pair, 'LONG/BUYING' on two, see ScriptedPosition), as the position book settles the outcome of an order; any other
   * step is a candle, which gives each pair watched the DEMA and SMA results of a trend (see TRENDS), in the order of the pairs,
   * separated by a slash ('up/neutral' is an uptrend on BTC/USDT and no trend on ETH/USDT)
   */
  const play = (steps: string) =>
    playPositionSteps(steps, positions, step => {
      const trends = step.split('/');
      const isCandle = trends.length === pairs.length && trends.every(trend => Object.hasOwn(TRENDS, trend));
      if (!isCandle) throw new Error(`No step named ${step}, in "${steps}"`);
      const results = pairs.map((pair, index) => {
        const { dema, sma } = TRENDS[trends[index] as keyof typeof TRENDS];
        return [pair, [dema, sma]] as const;
      });
      strategy.onTimeframeCandleAfterWarmup(hookParams(), ...indicatorArguments(Object.fromEntries(results)));
    });
  /** The sides of the orders asked of tools.positions, in order */
  const sides = () => positions.advices.map(({ side }) => side);
  /**
   * Plays the steps (see play), and returns what the strategy did, in the order it did it: each line it logged and each order it asked
   * of tools.positions. In a run, the strategyInfo event of an info line and the strategyCreateOrder event of an order come in that
   * order, which the e2e flows and the Telegram notifications show.
   */
  const playInOrder = (steps: string) => {
    const done: (LoggedLine | AskedOrder)[] = [];
    let taken = 0;
    // The orders asked since the line before, which come before the line being logged
    const takeOrders = () => {
      done.push(...positions.advices.slice(taken));
      taken = positions.advices.length;
    };
    vi.spyOn(tools, 'log').mockImplementation((level, message) => {
      takeOrders();
      done.push({ level, message });
    });
    play(steps);
    takeOrders();
    return done;
  };

  beforeEach(() => {
    initOn(BTC);
  });

  describe('init', () => {
    it.each`
      case           | watched       | expected
      ${'one pair'}  | ${[BTC]}      | ${[['DEMA', BTC, { period: 14 }], ['SMA', BTC, { period: 14 }]]}
      ${'two pairs'} | ${[BTC, ETH]} | ${[['DEMA', BTC, { period: 14 }], ['SMA', BTC, { period: 14 }], ['DEMA', ETH, { period: 14 }], ['SMA', ETH, { period: 14 }]]}
    `('should add a DEMA then an SMA of the strategy period on each pair, pair by pair: $case', ({ watched, expected }) => {
      expect(indicatorsAtInit(new DEMA(), watched, PARAMS)).toEqual(expected);
    });

    it.each`
      case           | watched
      ${'one pair'}  | ${[BTC]}
      ${'two pairs'} | ${[BTC, ETH]}
    `('should track every watched pair, through one call of tools.positions.track without pairs: $case', ({ watched }) => {
      const played = playInit(new DEMA(), watched, PARAMS);
      expect({ trackCalls: played.positions.trackCalls, pairs: played.positions.pairs }).toEqual({ trackCalls: [[]], pairs: watched });
    });

    // It adds its indicators on the pairs the position book tracks, which it reads once track has run
    it('should track the pairs before it adds an indicator', () => {
      ({ tools, positions } = fakeTools(PARAMS, { pairs: [BTC, ETH] }));
      const trackCallsAtEachIndicator: number[] = [];
      const addIndicator: AddIndicatorFn = () => {
        trackCallsAtEachIndicator.push(positions.trackCalls.length);
      };
      new DEMA().init({ candle: flatBucket(CLOSES), portfolio: new Map(), tools, addIndicator });
      expect(trackCallsAtEachIndicator).toEqual([1, 1, 1, 1]);
    });

    // The bucket holds a candle of every watched pair, in the order of watch.assets: the strategy trades them all, ignoring none. The
    // position book names them when there are several, in a line of its own (see Positions.track), which the fake tools do not log.
    it.each`
      case           | watched
      ${'one pair'}  | ${[BTC]}
      ${'two pairs'} | ${[BTC, ETH]}
    `('should warn of no pair at init: $case', ({ watched }) => {
      expect(logsAtInit(new DEMA(), watched, PARAMS)).toEqual([]);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // An uptrend, which buys once init has tracked the pairs
    it('should do nothing before init has tracked the pairs', () => {
      strategy = new DEMA();
      ({ tools, positions, logs } = fakeTools(PARAMS));
      play('up');
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
    });

    it('should do nothing if candle for the pair is not found', () => {
      strategy.onTimeframeCandleAfterWarmup(hookParams(new Map()), ...indicatorArguments({ [BTC]: [1, 2] }));
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Nothing logged either: a NaN result made a NaN diff, logged as no trend, and an infinite one an infinite trend, advised
    it.each`
      smaRes       | demaRes
      ${undefined} | ${undefined}
      ${1}         | ${undefined}
      ${undefined} | ${2}
      ${null}      | ${2}
      ${1}         | ${null}
      ${'invalid'} | ${2}
      ${NaN}       | ${2}
      ${1}         | ${NaN}
      ${Infinity}  | ${2}
      ${1}         | ${Infinity}
    `('should do nothing when results are invalid (sma: $smaRes, dema: $demaRes)', ({ smaRes, demaRes }) => {
      strategy.onTimeframeCandleAfterWarmup(hookParams(), { results: demaRes, symbol: BTC }, { results: smaRes, symbol: BTC });
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Unskipped, a null SMA would be subtracted as 0, a downtrend that sells, and a null DEMA would throw as the log message is built.
    // The DEMA, ready later than the SMA of its period, is null on the first candles of a trend the SMA already follows.
    it.each`
      case                                                      | steps                     | expectedSides
      ${'a null SMA, when long'}                                | ${'up LONG smaNull'}      | ${['BUY']}
      ${'a null DEMA, when flat'}                               | ${'demaNull'}             | ${[]}
      ${'an uptrend whose DEMA is ready from its third candle'} | ${'demaNull demaNull up'} | ${['BUY']}
    `('should skip a candle whose DEMA or SMA is null, as one not ready yet: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // An uptrend buys a pair flat with nothing pending there, a downtrend sells a pair long with nothing pending there, and an order
    // pending on the pair, a BUY's or a SELL's, holds both back: the position book answers canBuy and canSell. No trend advises nothing.
    it.each`
      candle       | position     | expected
      ${'up'}      | ${'FLAT'}    | ${{ advices: [buy(BTC)], lines: [LINES.btcUp, LINES.btcBuy] }}
      ${'up'}      | ${'LONG'}    | ${{ advices: [], lines: [LINES.btcUp] }}
      ${'up'}      | ${'BUYING'}  | ${{ advices: [], lines: [LINES.btcUp] }}
      ${'up'}      | ${'SELLING'} | ${{ advices: [], lines: [LINES.btcUp] }}
      ${'down'}    | ${'LONG'}    | ${{ advices: [sell(BTC)], lines: [LINES.btcDown, LINES.btcSell] }}
      ${'down'}    | ${'FLAT'}    | ${{ advices: [], lines: [LINES.btcDown] }}
      ${'down'}    | ${'BUYING'}  | ${{ advices: [], lines: [LINES.btcDown] }}
      ${'down'}    | ${'SELLING'} | ${{ advices: [], lines: [LINES.btcDown] }}
      ${'neutral'} | ${'FLAT'}    | ${{ advices: [], lines: [LINES.btcNeutral] }}
      ${'neutral'} | ${'LONG'}    | ${{ advices: [], lines: [LINES.btcNeutral] }}
    `(
      'should play a candle $candle on a pair $position as its position allows, logging its trend then its advice',
      ({ candle, position, expected }) => {
        play(`${position} ${candle}`);
        expect({ advices: positions.advices, lines: logs }).toStrictEqual(expected);
      },
    );

    // A trend is a diff beyond its threshold: one of exactly 0.5 does not buy a pair flat, nor one of exactly -0.5 sell a pair long
    it.each`
      candle      | position  | expected
      ${'atUp'}   | ${'FLAT'} | ${{ advices: [], lines: [LINES.btcAtUp] }}
      ${'atDown'} | ${'LONG'} | ${{ advices: [], lines: [LINES.btcAtDown] }}
    `('should take a diff at a threshold for no trend: $candle on a pair $position', ({ candle, position, expected }) => {
      play(`${position} ${candle}`);
      expect({ advices: positions.advices, lines: logs }).toStrictEqual(expected);
    });

    // Neither holds an amount, a cost or an allocation: the position book sizes a BUY, and a SELL sells all of the asset
    it('should place a STICKY BUY on an uptrend, then, once long, a STICKY SELL on a downtrend, through tools.positions', () => {
      play('up LONG down');
      expect(positions.advices).toStrictEqual([buy(BTC), sell(BTC)]);
    });

    // The position book creates them through the StrategyManager: created by the strategy itself, they would be no orders of the book's
    it('should create no order through tools.createOrder', () => {
      play('up LONG down');
      expect(orders.advices).toEqual([]);
    });

    // Each position step is the position the outcome of the order before it leads to, written when the case relies on it (see play):
    // a BUY pending, BUYING, then LONG once filled, a SELL pending, SELLING, then FLAT once filled
    it.each`
      case                                     | steps                                | expectedSides
      ${'an uptrend that continues'}           | ${'up up up'}                        | ${['BUY']}
      ${'an uptrend after a neutral pause'}    | ${'up LONG neutral up'}              | ${['BUY']}
      ${'a downtrend when flat'}               | ${'down down'}                       | ${[]}
      ${'a downtrend while the BUY pends'}     | ${'up BUYING down down'}             | ${['BUY']}
      ${'a downtrend once the BUY filled'}     | ${'up LONG down down'}               | ${['BUY', 'SELL']}
      ${'a BUY that fills during a downtrend'} | ${'up BUYING down LONG down'}        | ${['BUY', 'SELL']}
      ${'an uptrend while the SELL pends'}     | ${'up LONG down SELLING up up'}      | ${['BUY', 'SELL']}
      ${'a downtrend while the SELL pends'}    | ${'up LONG down SELLING up down'}    | ${['BUY', 'SELL']}
      ${'an uptrend once the SELL filled'}     | ${'up LONG down FLAT up'}            | ${['BUY', 'SELL', 'BUY']}
      ${'a SELL that fills during an uptrend'} | ${'up LONG down SELLING up FLAT up'} | ${['BUY', 'SELL', 'BUY']}
    `('should advise once per position change on $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it.each`
      case                                | steps             | expected
      ${'an uptrend when flat'}           | ${'up'}           | ${[LINES.btcUp, LINES.btcBuy]}
      ${'an uptrend while the BUY pends'} | ${'up BUYING up'} | ${[LINES.btcUp, LINES.btcBuy, LINES.btcUp]}
      ${'a downtrend when flat'}          | ${'down'}         | ${[LINES.btcDown]}
      ${'a downtrend when long'}          | ${'up LONG down'} | ${[LINES.btcUp, LINES.btcBuy, LINES.btcDown, LINES.btcSell]}
      ${'not an up or down trend'}        | ${'neutral'}      | ${[LINES.btcNeutral]}
    `('should log the trend of each candle and its advice, prefixed with the pair: $case', ({ steps, expected }) => {
      play(steps);
      expect(logs).toEqual(expected);
    });

    // After its trend line, the advice line of a BUY once the position book has placed it, that of a SELL before it is placed (see
    // playInOrder)
    it.each`
      case                             | steps          | expected
      ${'a BUY, once placed'}          | ${'up'}        | ${[LINES.btcUp, buy(BTC), LINES.btcBuy]}
      ${'a SELL, before it is placed'} | ${'LONG down'} | ${[LINES.btcDown, LINES.btcSell, sell(BTC)]}
    `('should log the advice of $case', ({ steps, expected }) => {
      expect(playInOrder(steps)).toStrictEqual(expected);
    });
  });

  describe('the position after an order', () => {
    // Each position step is the position the outcome of the order before it leads to, which the position book settles before the next
    // candle: an order that leaves the position as it was spends the trend that placed it, and the next order waits for the next trend
    it.each`
      case                                                                                       | steps                               | expectedSides
      ${'a BUY completed, or ended with enough filled to sell: long, it sells on the downtrend'} | ${'up LONG down'}                   | ${['BUY', 'SELL']}
      ${'a BUY ended without a fill: flat, it buys on the next uptrend, not on its own'}         | ${'up FLAT up neutral up down up'}  | ${['BUY', 'BUY']}
      ${'a SELL completed, or ended with all sold: flat, it buys again'}                         | ${'up LONG down FLAT up'}           | ${['BUY', 'SELL', 'BUY']}
      ${'a SELL ended without selling: long, it sells on the next downtrend, not on its own'}    | ${'up LONG down LONG down up down'} | ${['BUY', 'SELL', 'SELL']}
    `('should go by $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });
  });

  describe('log', () => {
    it.each`
      smaRes       | demaRes
      ${undefined} | ${undefined}
      ${1}         | ${undefined}
      ${undefined} | ${2}
      ${null}      | ${2}
      ${1}         | ${null}
      ${NaN}       | ${2}
      ${1}         | ${-Infinity}
    `('should not log when results are missing (sma: $smaRes, dema: $demaRes)', ({ smaRes, demaRes }) => {
      strategy.log(hookParams(), { results: demaRes, symbol: BTC }, { results: smaRes, symbol: BTC });
      expect(logs).toEqual([]);
    });

    it('should log DEMA and SMA properties', () => {
      strategy.log(hookParams(), ...indicatorArguments({ [BTC]: [1.23456, 2.34567] }));
      expect(logs).toEqual([PROPERTIES.btc]);
    });

    it('should log nothing before init has tracked the pairs', () => {
      strategy = new DEMA();
      ({ tools, positions, logs } = fakeTools(PARAMS));
      strategy.log(hookParams(), ...indicatorArguments({ [BTC]: [1.23456, 2.34567] }));
      expect(logs).toEqual([]);
    });
  });

  describe('on two pairs', () => {
    beforeEach(() => {
      initOn(BTC, ETH);
    });

    // The outcome of an order settles the position of its own pair, and leaves the other's as it was: each position step sets both, in
    // the order of the pairs
    it.each`
      case                                                              | steps                                     | expected
      ${'both flat, on one candle'}                                     | ${'up/up'}                                | ${[buy(BTC), buy(ETH)]}
      ${'ETH while the BUY of BTC pends'}                               | ${'up/neutral BUYING/FLAT neutral/up'}    | ${[buy(BTC), buy(ETH)]}
      ${'ETH on the candle BTC sells'}                                  | ${'up/neutral LONG/FLAT down/up'}         | ${[buy(BTC), sell(BTC), buy(ETH)]}
      ${'BTC long sells, ETH not while its BUY pends'}                  | ${'up/up LONG/BUYING down/down'}          | ${[buy(BTC), buy(ETH), sell(BTC)]}
      ${'ETH long sells, BTC not while its BUY pends'}                  | ${'up/up BUYING/LONG down/down'}          | ${[buy(BTC), buy(ETH), sell(ETH)]}
      ${'both long, both sell'}                                         | ${'up/up LONG/LONG down/down'}            | ${[buy(BTC), buy(ETH), sell(BTC), sell(ETH)]}
      ${'both BUYs pending: neither sells'}                             | ${'up/up BUYING/BUYING down/down'}        | ${[buy(BTC), buy(ETH)]}
      ${'ETH flat again: BTC long sells, ETH buys on its next uptrend'} | ${'up/up LONG/FLAT down/down neutral/up'} | ${[buy(BTC), buy(ETH), sell(BTC), buy(ETH)]}
      ${'BTC flat again: ETH long sells, BTC buys on its next uptrend'} | ${'up/up FLAT/LONG down/down up/neutral'} | ${[buy(BTC), buy(ETH), sell(ETH), buy(BTC)]}
    `('should keep a position per pair: $case', ({ steps, expected }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    it.each`
      case                                                     | steps                          | expected
      ${'an uptrend on BTC and a downtrend on ETH, both flat'} | ${'up/down'}                   | ${[LINES.btcUp, LINES.btcBuy, LINES.ethDown]}
      ${'no trend on BTC and an uptrend on ETH'}               | ${'neutral/up'}                | ${[LINES.btcNeutral, LINES.ethUp, LINES.ethBuy]}
      ${'a downtrend on both, both long'}                      | ${'up/up LONG/LONG down/down'} | ${[LINES.btcUp, LINES.btcBuy, LINES.ethUp, LINES.ethBuy, LINES.btcDown, LINES.btcSell, LINES.ethDown, LINES.ethSell]}
    `('should log the trend and the advice of each pair, prefixed with it, in the order of the pairs: $case', ({ steps, expected }) => {
      play(steps);
      expect(logs).toEqual(expected);
    });

    // Pair by pair, in the order of the pairs, the lines and the order of a pair as on one pair (see playInOrder), then those of the next
    it.each`
      case                                    | steps                    | expected
      ${'a BUY of each'}                      | ${'up/up'}               | ${[LINES.btcUp, buy(BTC), LINES.btcBuy, LINES.ethUp, buy(ETH), LINES.ethBuy]}
      ${'a SELL of each'}                     | ${'LONG/LONG down/down'} | ${[LINES.btcDown, LINES.btcSell, sell(BTC), LINES.ethDown, LINES.ethSell, sell(ETH)]}
      ${'a SELL of BTC and a BUY of ETH'}     | ${'LONG/FLAT down/up'}   | ${[LINES.btcDown, LINES.btcSell, sell(BTC), LINES.ethUp, buy(ETH), LINES.ethBuy]}
      ${'a BUY of BTC skipped, a BUY of ETH'} | ${'SKIPPING/FLAT up/up'} | ${[LINES.btcUp, skippedBuy(BTC), LINES.ethUp, buy(ETH), LINES.ethBuy]}
    `('should play each pair in turn, its lines and its order: $case', ({ steps, expected }) => {
      expect(playInOrder(steps)).toStrictEqual(expected);
    });

    // A pair skipped as on one pair: in a run, every bucket holds every pair, and every hook gets the indicators of each
    it.each`
      case                                | candle                       | indicators
      ${'without the candle of BTC'}      | ${flatBucket({ [ETH]: 20 })} | ${indicatorArguments({ [BTC]: [1, 2], [ETH]: [1, 2] })}
      ${'without the indicators of BTC'}  | ${flatBucket(CLOSES)}        | ${indicatorArguments({ [ETH]: [1, 2] })}
      ${'with the DEMA of BTC not ready'} | ${flatBucket(CLOSES)}        | ${indicatorArguments({ [BTC]: [null, 2], [ETH]: [1, 2] })}
    `('should skip a pair it cannot read and buy the other: $case', ({ candle, indicators }) => {
      strategy.onTimeframeCandleAfterWarmup(hookParams(candle), ...indicators);
      expect(positions.advices).toStrictEqual([buy(ETH)]);
    });

    // The position book skips the BUYs of BTC/USDT, a share of the currency under a minimum of its market (see Positions.buy): a BUY
    // skipped spends its uptrend all the same, as a refused BUY does, and the next one waits for the next uptrend. The strategy logs no
    // advice for it, the book's own line its only trace: logged before the BUY, the advice told of an order that was never sent.
    it.each`
      case                                                 | steps                                                 | expected
      ${'the next candles of its uptrend ask for nothing'} | ${'SKIPPING/FLAT up/neutral up/neutral'}              | ${{ advices: [skippedBuy(BTC)], lines: [LINES.btcUp, LINES.ethNeutral, LINES.btcUp, LINES.ethNeutral] }}
      ${'the next uptrend asks again'}                     | ${'SKIPPING/FLAT up/neutral down/neutral up/neutral'} | ${{ advices: [skippedBuy(BTC), skippedBuy(BTC)], lines: [LINES.btcUp, LINES.ethNeutral, LINES.btcDown, LINES.ethNeutral, LINES.btcUp, LINES.ethNeutral] }}
      ${'ETH buys beside it'}                              | ${'SKIPPING/FLAT up/up'}                              | ${{ advices: [skippedBuy(BTC), buy(ETH)], lines: [LINES.btcUp, LINES.ethUp, LINES.ethBuy] }}
    `('should take a BUY the position book skips as advised, no advice logged: $case', ({ steps, expected }) => {
      play(steps);
      expect({ advices: positions.advices, lines: logs }).toStrictEqual(expected);
    });

    it.each`
      case                               | indicators                                                                      | expected
      ${'both ready'}                    | ${indicatorArguments({ [BTC]: [1.23456, 2.34567], [ETH]: [3.45678, 4.56789] })} | ${[PROPERTIES.btc, PROPERTIES.eth]}
      ${'the DEMA of BTC not ready'}     | ${indicatorArguments({ [BTC]: [null, 2.34567], [ETH]: [3.45678, 4.56789] })}    | ${[PROPERTIES.eth]}
      ${'without the indicators of BTC'} | ${indicatorArguments({ [ETH]: [3.45678, 4.56789] })}                            | ${[PROPERTIES.eth]}
    `('should log the DEMA and SMA properties of each pair ready, prefixed with it: $case', ({ indicators, expected }) => {
      strategy.log(hookParams(), ...indicators);
      expect(logs).toEqual(expected);
    });
  });

  // The refusals of the schema are tested in @gekko/schemas: here, that the class declares it, the StrategyManager parsing the block with it
  it('should declare the strategy schema of @gekko/schemas', () => {
    expect(DEMA.schema).toBe(demaStrategySchema);
  });
});
