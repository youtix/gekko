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
import type { IndicatorResults, Tools } from '../strategy.types';
import { beforeEach, describe, expect, it } from 'vitest';
import { smaCrossoverStrategySchema } from '@gekko/schemas/strategies/smaCrossover.schema';
import { SMACrossover } from './smaCrossover.strategy';
import { SMACrossoverStrategyParams } from './smaCrossover.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
const PARAMS: SMACrossoverStrategyParams = { period: 20, src: 'close' };
const ULP = 2 ** -46; // the gap between 100 and the next double
// The close and the SMA of each step of the scenarios played below. The first candle only records where the price is. A flat window
// (one close for the whole period) leaves the running-sum SMA a few ulps off that close, on either side: 'on+' has it one ulp above
// the close, 'on-' one ulp below, 'on' on it. 'tick+' and 'tick-' have the close a tick above or below the SMA, 'nan' the SMA NaN,
// 'null' the SMA not ready yet, what the indicator gives until its period is full. 'no-candle' leaves the candle of the pair out of the
// bucket, its SMA given, and 'no-sma' its SMA out of the indicator arguments, its candle given.
const STEPS = {
  above: { close: 110, sma: 100 },
  below: { close: 90, sma: 100 },
  on: { close: 100, sma: 100 },
  'on+': { close: 100, sma: 100 + ULP },
  'on-': { close: 100, sma: 100 - ULP },
  'tick+': { close: 100.01, sma: 100 },
  'tick-': { close: 99.99, sma: 100 },
  nan: { close: 100, sma: NaN },
  null: { close: 100, sma: null },
  'no-candle': { close: null, sma: 100 },
  'no-sma': { close: 100, sma: undefined },
} as const;
// The prices of a step on each pair: ETH's are twenty times BTC's, so that a pair read with the candle or the SMA of the other would
// not cross where its own steps do, and the lines of the two pairs tell their figures apart
const PRICE_SCALE: Record<TradingPair, number> = { [BTC]: 1, [ETH]: 20 };
/** The MARKET BUY of `symbol` as the strategy asks tools.positions for it: the position book sizes it */
const buy = (symbol: TradingPair): AskedOrder => ({ type: 'MARKET', side: 'BUY', symbol });
/** The MARKET SELL of `symbol` as the strategy asks tools.positions for it: of all of its asset */
const sell = (symbol: TradingPair): AskedOrder => ({ type: 'MARKET', side: 'SELL', symbol });
/** A line the strategy logs at info, which the StrategyManager also relays to the strat_info subscribers */
const info = (message: string): LoggedLine => ({ level: 'info', message });
/** The SMA of BTC/USDT as the hooks get it, its results as given: a value no SMA gives included, as an untyped indicator could */
const btcSMA = (results: unknown) => [{ results, symbol: BTC }] as IndicatorResults<number | null>[];
// The lines of a crossover of BTC/USDT, from 'below' to 'above' (a BUY) or from 'above' to 'below' (a SELL), and of the first step
const BTC_BELOW = info('[BTC/USDT] Initial state: price below SMA');
const BTC_ABOVE = info('[BTC/USDT] Initial state: price above SMA');
const BTC_BUY = info('[BTC/USDT] SMA crossed DOWN price (100.00000 < 110.00000) => BUY');
const BTC_SELL = info('[BTC/USDT] SMA crossed UP price (100.00000 > 90.00000) => SELL');

describe('SMACrossover Strategy', () => {
  let strategy: SMACrossover;
  let tools: Tools<SMACrossoverStrategyParams>;
  let positions: ScriptedPositions;
  let logs: LoggedLine[];
  let orders: OrderRecorder;
  // The pairs the strategy under test was initialized on, in the order of watch.assets
  let tradedPairs: TradingPair[];

  /**
   * The strategy initialized on `pairs`, in their order (that of watch.assets), as the StrategyManager initializes it on the first
   * one-minute bucket, with fake tools of those pairs (see playInit): one set of tools for each strategy, as each run has its own
   */
  const initOn = (pairs: TradingPair[], strategyParams = PARAMS) => {
    tradedPairs = pairs;
    strategy = new SMACrossover();
    ({ tools, positions, logs, orders } = playInit(strategy, pairs, strategyParams));
  };
  /** A strategy init has not run on, with fake tools of BTC/USDT: their positions track no pair (see ScriptedPositions) */
  const notInitialized = () => {
    strategy = new SMACrossover();
    ({ tools, positions, logs, orders } = fakeTools(PARAMS));
  };

  /**
   * Plays a timeframe candle as the StrategyManager does: onEachTimeframeCandle on every candle, the warmup included, then, once the
   * warmup is over, onTimeframeCandleAfterWarmup with the same indicator arguments
   */
  const playCandle = (candle: CandleBucket, indicators: IndicatorResults<number | null>[], afterWarmup = true) => {
    const params = { candle, portfolio: new Map(), tools };
    strategy.onEachTimeframeCandle(params, ...indicators);
    if (afterWarmup) strategy.onTimeframeCandleAfterWarmup(params, ...indicators);
  };

  /**
   * Plays the steps (see playPositionSteps), separated by spaces. A step naming a position of each pair the strategy was initialized on,
   * in their order, separated by commas ('LONG' on one pair, 'LONG,FLAT' on two: see ScriptedPosition), sets what the position book
   * answers for them from then on, as it reads them once it has settled the outcomes the scenario has in mind: an order asked changes no
   * position. Any other step is a candle, which names a step (see STEPS) for each of those pairs, in their order, separated by commas
   * ('below,above': BTC below its SMA, ETH above its own), and in parentheses it is a warmup candle.
   */
  const play = (steps: string) =>
    playPositionSteps(steps, positions, step => {
      const isWarmup = step.startsWith('(') && step.endsWith(')');
      const names = (isWarmup ? step.slice(1, -1) : step).split(',');
      if (names.length !== tradedPairs.length || !names.every(name => name in STEPS)) {
        throw new Error(`No step named ${step} on ${tradedPairs.join(' and ')}, in "${steps}"`);
      }
      const closeByPair: Record<TradingPair, number> = {};
      const smaByPair: Record<TradingPair, (number | null)[]> = {};
      tradedPairs.forEach((pair, i) => {
        const { close, sma } = STEPS[names[i] as keyof typeof STEPS];
        if (close !== null) closeByPair[pair] = close * PRICE_SCALE[pair];
        if (sma !== undefined) smaByPair[pair] = [sma === null ? null : sma * PRICE_SCALE[pair]];
      });
      playCandle(flatBucket(closeByPair), indicatorArguments(smaByPair), !isWarmup);
    });
  /** The side of each order the strategy asked of tools.positions, in order */
  const sides = () => positions.advices.map(({ side }) => side);
  /**
   * Records, from now on, each line the strategy logs with the number of orders it had asked of tools.positions by then: the
   * TradingAdvisor relays its lines as strategyInfo and its orders as strategyCreateOrder in that order, which the Telegram
   * notifications show
   */
  const recordLinesWithOrders = () => {
    const lines: (LoggedLine & { ordersAsked: number })[] = [];
    const { log } = tools;
    tools.log = (level, message) => {
      lines.push({ level, message, ordersAsked: positions.advices.length });
      log(level, message);
    };
    return lines;
  };

  beforeEach(() => {
    // On BTC/USDT alone, as a run that watches one asset (see 'on two pairs' for two)
    initOn([BTC]);
  });

  describe('init', () => {
    // The bucket holds a candle of every watched pair, in the order of watch.assets: the strategy trades each of them, on an SMA of its own
    it.each`
      case           | pairs         | expected
      ${'one pair'}  | ${[BTC]}      | ${[['SMA', BTC, { period: 50, src: 'high' }]]}
      ${'two pairs'} | ${[BTC, ETH]} | ${[['SMA', BTC, { period: 50, src: 'high' }], ['SMA', ETH, { period: 50, src: 'high' }]]}
    `('should add an SMA on each pair, in order, with the period and src from strategyParams: $case', ({ pairs, expected }) => {
      expect(indicatorsAtInit(new SMACrossover(), pairs, { period: 50, src: 'high' })).toEqual(expected);
    });

    // The SMAs go on the pairs the position book tracks: track comes first, once and without pairs, every watched pair tracked then
    it.each`
      case           | pairs
      ${'one pair'}  | ${[BTC]}
      ${'two pairs'} | ${[BTC, ETH]}
    `('should have the position book track every watched pair, once, before it adds their SMAs: $case', ({ pairs }) => {
      const fake = fakeTools(PARAMS, { pairs });
      // The calls to track made by the time of each addIndicator call, and the pairs tracked then
      const trackedAtEachSMA: unknown[] = [];
      new SMACrossover().init({
        candle: flatBucket(Object.fromEntries(pairs.map((pair: TradingPair) => [pair, 100]))),
        portfolio: new Map(),
        tools: fake.tools,
        addIndicator: () => trackedAtEachSMA.push({ trackCalls: [...fake.positions.trackCalls], pairs: [...fake.positions.pairs] }),
      });
      expect(trackedAtEachSMA).toEqual(pairs.map(() => ({ trackCalls: [[]], pairs })));
    });

    // It used to trade the first pair only, and to warn of the others. When it tracks several, the position book says which it trades,
    // through the strategy's log (tested in @gekko/plugins)
    it.each`
      case           | pairs
      ${'one pair'}  | ${[BTC]}
      ${'two pairs'} | ${[BTC, ETH]}
    `('should log nothing at init, warning of no pair: $case', ({ pairs }) => {
      expect(logsAtInit(new SMACrossover(), pairs, PARAMS)).toEqual([]);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // In a run, init has the position book track the pairs before any candle: without it, the strategy has no pair to trade
    it('should do nothing before init, which gives it the pairs it trades', () => {
      notInitialized();
      // Below the SMA, then above it: a crossover, had init tracked the pair
      for (const close of [90, 110]) playCandle(flatBucket({ [BTC]: close }), btcSMA(100));
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
    });

    it('should do nothing if current candle is missing', () => {
      playCandle(new Map(), btcSMA(100));
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Nothing logged either: a NaN SMA, compared with the price, was recorded as the price being below it
    it.each`
      smaRes
      ${undefined}
      ${null}
      ${'invalid'}
      ${NaN}
      ${Infinity}
      ${-Infinity}
    `('should do nothing when SMA result is invalid ($smaRes)', ({ smaRes }) => {
      playCandle(flatBucket({ [BTC]: 100 }), btcSMA(smaRes));
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Compared as 0, a null SMA would put the price above it: that side recorded, the crossover of the next candle would be missed, and
    // a price below it on the first candle the SMA is ready would cross it downwards, a SELL when long
    it.each`
      case                                        | steps                           | expectedSides
      ${'NaN before the first state'}             | ${'nan above'}                  | ${[]}
      ${'NaN between the two sides of a cross'}   | ${'below nan above'}            | ${['BUY']}
      ${'NaN above the SMA, when long'}           | ${'below above LONG nan tick+'} | ${['BUY']}
      ${'null between the two sides of a cross'}  | ${'below null above'}           | ${['BUY']}
      ${'null until the SMA is ready, when long'} | ${'LONG null null null below'}  | ${[]}
    `('should skip a candle whose SMA is NaN or null, as one not ready yet: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it('should record initial state without creating an order on first candle', () => {
      playCandle(flatBucket({ [BTC]: 100 }), btcSMA(95)); // price above SMA
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [BTC_ABOVE] });
    });

    // A BUY is the price crossing above its SMA (the SMA crossing DOWN the price), a SELL the price crossing below it, on the second
    // candle, the position of the pair set before it. Each order is MARKET, without an amount: the position book sizes a BUY, and a
    // SELL sells all of the asset. A BUY the position book skips is asked as one placed would be, its crossover not logged: the book's
    // line, which the scripted positions do not log, is its only trace.
    it.each`
      signal    | position      | expected
      ${'BUY'}  | ${'FLAT'}     | ${{ advices: [buy(BTC)], logs: [BTC_BELOW, BTC_BUY] }}
      ${'BUY'}  | ${'SKIPPING'} | ${{ advices: [{ ...buy(BTC), skipped: true }], logs: [BTC_BELOW] }}
      ${'BUY'}  | ${'LONG'}     | ${{ advices: [], logs: [BTC_BELOW] }}
      ${'BUY'}  | ${'BUYING'}   | ${{ advices: [], logs: [BTC_BELOW] }}
      ${'BUY'}  | ${'SELLING'}  | ${{ advices: [], logs: [BTC_BELOW] }}
      ${'SELL'} | ${'LONG'}     | ${{ advices: [sell(BTC)], logs: [BTC_ABOVE, BTC_SELL] }}
      ${'SELL'} | ${'FLAT'}     | ${{ advices: [], logs: [BTC_ABOVE] }}
      ${'SELL'} | ${'SKIPPING'} | ${{ advices: [], logs: [BTC_ABOVE] }}
      ${'SELL'} | ${'BUYING'}   | ${{ advices: [], logs: [BTC_ABOVE] }}
      ${'SELL'} | ${'SELLING'}  | ${{ advices: [], logs: [BTC_ABOVE] }}
    `('should place the $signal of a crossover on a pair $position as its position allows', ({ signal, position, expected }) => {
      play(signal === 'BUY' ? `below ${position} above` : `above ${position} below`);
      expect({ advices: positions.advices, logs }).toStrictEqual(expected);
    });

    // A SELL is placed once its crossover is logged, a BUY logged once it is placed (see the BUY skipped above)
    it.each`
      signal    | steps                 | expected
      ${'BUY'}  | ${'below above'}      | ${[{ ...BTC_BELOW, ordersAsked: 0 }, { ...BTC_BUY, ordersAsked: 1 }]}
      ${'SELL'} | ${'above LONG below'} | ${[{ ...BTC_ABOVE, ordersAsked: 0 }, { ...BTC_SELL, ordersAsked: 0 }]}
    `('should log the crossover of a BUY once the BUY is placed, and that of a SELL before the SELL: $signal', ({ steps, expected }) => {
      const lines = recordLinesWithOrders();
      play(steps);
      expect(lines).toEqual(expected);
    });

    it('should place its orders through tools.positions alone, creating none with tools.createOrder', () => {
      play('below above LONG below');
      expect(orders.advices).toEqual([]);
    });

    // Long when the price stays below its SMA, flat when it stays above it: an order placed on a side and not on a crossover would show
    it.each`
      prices             | sma    | description      | position
      ${[110, 115, 120]} | ${100} | ${'stays above'} | ${'FLAT'}
      ${[90, 85, 80]}    | ${100} | ${'stays below'} | ${'LONG'}
      ${[100, 100, 100]} | ${100} | ${'equals'}      | ${'FLAT'}
    `('should not create order when price $description SMA, $position', ({ prices, sma, position }) => {
      positions.set(BTC, position);
      for (const price of prices) playCandle(flatBucket({ [BTC]: price }), btcSMA(sma));
      expect(positions.advices).toHaveLength(0);
    });

    it.each`
      case                                            | steps                                           | expectedSides
      ${'crossovers once each order filled'}          | ${'below above LONG below FLAT above'}          | ${['BUY', 'SELL', 'BUY']}
      ${'a cross below when flat'}                    | ${'above below above'}                          | ${['BUY']}
      ${'a cross below while the BUY pends'}          | ${'below above BUYING below above'}             | ${['BUY']}
      ${'a cross below skipped, then the BUY filled'} | ${'below above BUYING below LONG below'}        | ${['BUY']}
      ${'a cross above while long'}                   | ${'below above LONG below LONG above'}          | ${['BUY', 'SELL']}
      ${'a cross above while the SELL pends'}         | ${'below above LONG below SELLING above'}       | ${['BUY', 'SELL']}
      ${'a cross below while the SELL pends'}         | ${'below above LONG below SELLING above below'} | ${['BUY', 'SELL']}
    `('should advise once per position change on $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // src only selects what the SMA averages: the price that crosses it is the close, whatever the open, high and low of the candle
    it('should compare the close with the SMA, whatever source the SMA averages', () => {
      initOn([BTC], { period: 20, src: 'hl2' });
      // The close crosses the SMA upwards, while every other price of the candles, hl2, hlc3 and ohlc4 included, crosses it downwards or
      // stays on one side of it
      for (const candle of [
        { open: 120, high: 130, low: 88, close: 90 },
        { open: 85, high: 112, low: 60, close: 110 },
      ]) {
        playCandle(new Map([[BTC, { start: 0, volume: 1, ...candle }]]), btcSMA(100));
      }
      expect(sides()).toEqual(['BUY']);
    });
  });

  describe('the side of the price during the warmup', () => {
    // A step in parentheses is a warmup candle: the strategy records the side of the price on it, and trades nothing
    it.each`
      case                                         | steps                            | expectedSides
      ${'below at the warmup end, then above'}     | ${'(below) above'}               | ${['BUY']}
      ${'below, on the SMA at the end, above'}     | ${'(below) (on) above'}          | ${['BUY']}
      ${'above at the warmup end, then above'}     | ${'(above) above'}               | ${[]}
      ${'a cross within the warmup only'}          | ${'(below) (above) above'}       | ${[]}
      ${'a cross below at the end, when flat'}     | ${'(above) below'}               | ${[]}
      ${'no SMA in the warmup, then a cross'}      | ${'(nan) below above'}           | ${['BUY']}
      ${'no SMA in the warmup, the first side'}    | ${'(nan) above'}                 | ${[]}
      ${'the SMA ready on the last warmup candle'} | ${'(null) (null) (below) above'} | ${['BUY']}
    `('should trade a crossover from the last warmup candle on: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it('should log the initial state from the warmup, then the crossover after it', () => {
      play('(below) above');
      expect(logs).toEqual([BTC_BELOW, BTC_BUY]);
    });
  });

  describe('on a flat window', () => {
    // Compared strictly, an SMA one ulp above the price, or on it, read as the price below it, one ulp below as the price above it.
    // Long or flat is the position held when the window turns flat.
    it.each`
      case                                       | steps                                | expectedSides
      ${'SMA an ulp above the price, when long'} | ${'below above LONG on+'}            | ${['BUY']}
      ${'SMA on the price, when long'}           | ${'below above LONG on'}             | ${['BUY']}
      ${'SMA an ulp below the price, when long'} | ${'below above LONG on-'}            | ${['BUY']}
      ${'SMA wobbling around it, when long'}     | ${'below above LONG on- on+ on on+'} | ${['BUY']}
      ${'SMA an ulp below the price, when flat'} | ${'below on-'}                       | ${[]}
      ${'SMA on the price, when flat'}           | ${'below on'}                        | ${[]}
      ${'SMA an ulp above the price, when flat'} | ${'below on+'}                       | ${[]}
      ${'SMA wobbling around it, when flat'}     | ${'below on+ on- on on-'}            | ${[]}
    `('should not cross on a flat window: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it.each`
      case                                 | steps                               | expectedSides
      ${'a tick below the SMA, when long'} | ${'below above LONG on+ on- tick-'} | ${['BUY', 'SELL']}
      ${'a tick above the SMA, when long'} | ${'below above LONG on+ on- tick+'} | ${['BUY']}
      ${'a tick above the SMA, when flat'} | ${'below on- on+ tick+'}            | ${['BUY']}
      ${'a tick below the SMA, when flat'} | ${'below on- on+ tick-'}            | ${[]}
    `('should cross once the price leaves the SMA on the other side: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it.each`
      case                                    | steps               | expectedSides
      ${'on the SMA, then above it'}          | ${'on above'}       | ${[]}
      ${'ulps off the SMA, then above it'}    | ${'on+ on- above'}  | ${[]}
      ${'on the SMA, then below, then above'} | ${'on below above'} | ${['BUY']}
    `('should take the first side after the warmup as the initial state: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it('should log the initial state once the price leaves the SMA', () => {
      play('on on+ above');
      expect(logs).toEqual([BTC_ABOVE]);
    });
  });

  describe('once an order has ended', () => {
    // The position book settles the outcome of each of its orders (tested in @gekko/plugins), and the strategy trades the next crossover
    // of the pair from the position that outcome leaves, never on a candle that does not cross: an order that ended without the
    // position it asked for is not placed again
    it.each`
      case                                                                                   | steps                                              | expectedSides
      ${'a BUY completed: long, it sells on the next cross below'}                           | ${'below above LONG above below'}                  | ${['BUY', 'SELL']}
      ${'a BUY canceled, or errored without a fill: flat, it buys on the next cross above'}  | ${'below above FLAT above below above'}            | ${['BUY', 'BUY']}
      ${'a SELL completed, or errored once all sold: flat, it buys on the next cross above'} | ${'below above LONG below FLAT below above'}       | ${['BUY', 'SELL', 'BUY']}
      ${'a SELL canceled or errored: long, it sells on the next cross below'}                | ${'below above LONG below LONG below above below'} | ${['BUY', 'SELL', 'SELL']}
    `('should trade from the position the outcome leaves: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });
  });

  describe('log', () => {
    // In a run, init has the position book track the pairs before any candle
    it('should not log before init, which gives it the pairs it trades', () => {
      notInitialized();
      strategy.log({ candle: flatBucket({ [BTC]: 100 }), portfolio: new Map(), tools }, ...btcSMA(99.5));
      expect(logs).toHaveLength(0);
    });

    it('should not log if candle is missing', () => {
      strategy.log({ candle: new Map(), portfolio: new Map(), tools }, ...btcSMA(99.5));
      expect(logs).toHaveLength(0);
    });

    it.each`
      smaRes
      ${undefined}
      ${null}
      ${'invalid'}
      ${NaN}
      ${Infinity}
      ${-Infinity}
    `('should not log when SMA is missing or invalid ($smaRes)', ({ smaRes }) => {
      strategy.log({ candle: flatBucket({ [BTC]: 100.12345 }), portfolio: new Map(), tools }, ...btcSMA(smaRes));
      expect(logs).toHaveLength(0);
    });

    it('should log SMA and price values, after the pair', () => {
      strategy.log({ candle: flatBucket({ [BTC]: 100.12345 }), portfolio: new Map(), tools }, ...btcSMA(99.54321));
      expect(logs).toEqual([{ level: 'debug', message: '[BTC/USDT] SMA: 99.54321 | Price: 100.12345' }]);
    });
  });

  describe('on two pairs', () => {
    // BTC/USDT then ETH/USDT, as watch.assets lists them: a candle names the step of each, 'below,above' BTC below its SMA, ETH above
    // its own, and a position step the position of each, 'LONG,FLAT' BTC long, ETH flat (see play)
    beforeEach(() => {
      initOn([BTC, ETH]);
    });

    // Each pair crosses its own SMA, and the position book sizes each BUY, a share of the currency the strategy does not see (tested in
    // @gekko/plugins): the orders of one candle go pair by pair, in the order of watch.assets
    it.each`
      case                                                       | steps                                                                    | expected
      ${'both crossing above on one candle, both flat'}          | ${'below,below above,above'}                                             | ${[buy(BTC), buy(ETH)]}
      ${'ETH crossing above while the BTC BUY pends'}            | ${'below,below above,below BUYING,FLAT above,above'}                     | ${[buy(BTC), buy(ETH)]}
      ${'ETH crossing above while BTC is long'}                  | ${'below,below above,below LONG,FLAT above,above'}                       | ${[buy(BTC), buy(ETH)]}
      ${'BTC crossing above while ETH is long'}                  | ${'below,below below,above FLAT,LONG above,above'}                       | ${[buy(ETH), buy(BTC)]}
      ${'ETH crossing above as BTC sells on one candle'}         | ${'below,below above,below LONG,FLAT below,above'}                       | ${[buy(BTC), sell(BTC), buy(ETH)]}
      ${'BTC flat again after a round trip, ETH flat'}           | ${'below,below above,below LONG,FLAT below,below FLAT,FLAT above,below'} | ${[buy(BTC), sell(BTC), buy(BTC)]}
      ${'both crossing below on one candle, both long'}          | ${'below,below above,above LONG,LONG below,below'}                       | ${[buy(BTC), buy(ETH), sell(BTC), sell(ETH)]}
      ${'BTC crossing below, long, while ETH stays above, long'} | ${'below,below above,above LONG,LONG below,above'}                       | ${[buy(BTC), buy(ETH), sell(BTC)]}
      ${'BTC on its SMA, flat, while ETH crosses above'}         | ${'below,below on,above'}                                                | ${[buy(ETH)]}
    `('should trade each pair on its own crossovers: $case', ({ steps, expected }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    // What the position book answers for one pair, once the outcome of its order is settled, decides nothing for the other
    it.each`
      case                                                          | steps                                                            | expected
      ${'the BTC BUY canceled: BTC flat, ETH long sells'}           | ${'below,below above,above FLAT,LONG below,below above,above'}   | ${[buy(BTC), buy(ETH), sell(ETH), buy(BTC)]}
      ${'the ETH BUY errored: ETH flat buys again, BTC long sells'} | ${'below,below above,above LONG,FLAT below,below above,above'}   | ${[buy(BTC), buy(ETH), sell(BTC), buy(ETH)]}
      ${'the ETH BUY completed: the BTC BUY still pends'}           | ${'below,below above,above BUYING,LONG below,below above,above'} | ${[buy(BTC), buy(ETH), sell(ETH)]}
    `('should trade each pair on its own position: $case', ({ steps, expected }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    // Every bucket holds every pair, every hook gets the SMA of every pair, and the SMAs of one period are ready on the same candle: a
    // pair whose candle or SMA is missing all the same is skipped alone, the other traded, and it trades its own crossover once it has
    // both again
    it.each`
      case                                        | steps
      ${'the BTC candle missing from a bucket'}   | ${'below,below no-candle,above above,above'}
      ${'the BTC SMA not ready on a candle'}      | ${'below,below null,above above,above'}
      ${'the BTC SMA missing from the arguments'} | ${'below,below no-sma,above above,above'}
    `('should trade ETH on its crossover, then BTC on its own: $case', ({ steps }) => {
      play(steps);
      expect(positions.advices).toStrictEqual([buy(ETH), buy(BTC)]);
    });

    // Pair by pair, each SELL placed once its crossover is logged, each BUY logged once it is placed
    it('should log the lines of each pair, after the pair, each crossover beside its order', () => {
      const lines = recordLinesWithOrders();
      play('below,below above,above LONG,LONG below,below');
      expect(lines).toEqual([
        { ...BTC_BELOW, ordersAsked: 0 },
        { ...info('[ETH/USDT] Initial state: price below SMA'), ordersAsked: 0 },
        { ...BTC_BUY, ordersAsked: 1 },
        { ...info('[ETH/USDT] SMA crossed DOWN price (2000.00000 < 2200.00000) => BUY'), ordersAsked: 2 },
        { ...BTC_SELL, ordersAsked: 2 },
        { ...info('[ETH/USDT] SMA crossed UP price (2000.00000 > 1800.00000) => SELL'), ordersAsked: 3 },
      ]);
    });

    // The position book skips a BUY too small for the market, on several pairs (tested in @gekko/plugins): the strategy asks it as one
    // placed, its crossover not logged, the book's line its only trace (logged before it, the crossover announced a BUY that was never
    // sent), and asks again on the next crossover of the pair, not on the next candle
    it('should take a BUY the position book skips as one placed, its crossover unlogged: asked again on the next crossover, not on the next candle', () => {
      play('SKIPPING,FLAT below,below above,below above,below below,below above,below');
      expect({ advices: positions.advices, logs }).toStrictEqual({
        advices: [
          { ...buy(BTC), skipped: true },
          { ...buy(BTC), skipped: true },
        ],
        logs: [BTC_BELOW, info('[ETH/USDT] Initial state: price below SMA')],
      });
    });

    describe('log', () => {
      const btcLine = { level: 'debug', message: '[BTC/USDT] SMA: 100.00000 | Price: 110.00000' };
      const ethLine = { level: 'debug', message: '[ETH/USDT] SMA: 2000.00000 | Price: 1800.00000' };

      // But for the first row, what no run produces (see above): a bucket without the BTC candle, a BTC SMA not ready beside a ready ETH
      // one, the hook without the BTC SMA
      it.each`
        case                        | candle                                     | indicators                                              | expected
        ${'both pairs'}             | ${flatBucket({ [BTC]: 110, [ETH]: 1800 })} | ${indicatorArguments({ [BTC]: [100], [ETH]: [2000] })}  | ${[btcLine, ethLine]}
        ${'the BTC candle missing'} | ${flatBucket({ [ETH]: 1800 })}             | ${indicatorArguments({ [BTC]: [100], [ETH]: [2000] })}  | ${[ethLine]}
        ${'the BTC SMA not ready'}  | ${flatBucket({ [BTC]: 110, [ETH]: 1800 })} | ${indicatorArguments({ [BTC]: [null], [ETH]: [2000] })} | ${[ethLine]}
        ${'the BTC SMA missing'}    | ${flatBucket({ [BTC]: 110, [ETH]: 1800 })} | ${indicatorArguments({ [ETH]: [2000] })}                | ${[ethLine]}
      `('should log the SMA and the price of each pair whose candle and SMA it has: $case', ({ candle, indicators, expected }) => {
        strategy.log({ candle, portfolio: new Map(), tools }, ...indicators);
        expect(logs).toEqual(expected);
      });
    });
  });

  // The refusals of the schema are tested in @gekko/schemas: here, that the class declares it, the StrategyManager parsing the block
  // with it
  it('should declare the strategy schema of @gekko/schemas', () => {
    expect(SMACrossover.schema).toBe(smaCrossoverStrategySchema);
  });
});
