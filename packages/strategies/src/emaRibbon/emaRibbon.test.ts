import type { CandleBucket } from '@gekko/shared/models/event.types';
import type { OrderSide } from '@gekko/shared/models/order.types';
import type { TradingPair } from '@gekko/shared/models/utility.types';
import {
  AskedOrder,
  fakeTools,
  flatBucket,
  indicatorArguments,
  LoggedLine,
  logsAtInit,
  OrderRecorder,
  playInit,
  playPositionSteps,
  ScriptedPositions,
} from '../strategy.mock';
import type { AddIndicatorFn, OnCandleEventParams, Tools } from '../strategy.types';
import { beforeEach, describe, expect, it } from 'vitest';
import { emaRibbonStrategySchema } from '@gekko/schemas/strategies/emaRibbon.schema';
import { EMARibbon } from './emaRibbon.strategy';
import type { EMARibbonStrategyParams, RibbonResults } from './emaRibbon.types';

const BTC: TradingPair = 'BTC/USDT';
/** The second pair, watched after BTC/USDT */
const ETH: TradingPair = 'ETH/USDT';
/** The block of the suite: a ribbon of EMAs 2, 3 and 4 of the close, a bullish one buying below a spread of `threshold`, 1 unless given */
const paramsOf = (threshold = 1): EMARibbonStrategyParams => ({
  src: 'close',
  count: 3,
  start: 2,
  step: 1,
  spreadCompressionThreshold: threshold,
});
/** The addIndicator call of the ribbon of `pair`, as callsAtInit records it: the ribbon parameters of the block, the threshold left out */
const ribbonAddedOn = (pair: TradingPair) => ['addIndicator', 'EMARibbon', pair, { src: 'close', count: 3, start: 2, step: 1 }];
/** A flat candle at 100 of each of `pairs`, as the hooks get them: the strategy reads none of them, its ribbons alone */
const bucketOf = (pairs: TradingPair[]) => flatBucket(Object.fromEntries(pairs.map(pair => [pair, 100])));
/** The indicator arguments of a hook: the EMARibbon result given, on BTC/USDT */
const indicatorOf = (results: unknown) => [{ results, symbol: BTC }] as RibbonResults[];
/** The indicator's result for these EMAs, the fastest first, with their spread as the EMARibbon indicator computes it */
const resultOf = (emas: readonly number[]) => ({ results: [...emas], spread: Math.max(...emas) - Math.min(...emas) });
/** The indicator arguments of a hook: the result for these EMAs (see resultOf), on BTC/USDT */
const ribbonOf = (emas: readonly number[]) => indicatorOf(resultOf(emas));
// Ribbons of EMAs 2, 3 and 4, the fastest first, exactly as the EMARibbon indicator computes them from the closes given. On a straight
// rise of s a candle each EMA lags the close by (period - 1) × s / 2: the ribbon is bullish, its spread s. The scenarios chain them by
// their spreads, against a threshold of 1. Some also follow one another as consecutive candles: tight, tight+1 and tight+2; tight,
// tighter and tightest; tight then equalPair or dip; wide then slowing.
const RIBBONS = {
  // A rise by 0.5 a candle, closes 99.25 to 100.75, then 101.25 and 101.75: spread 0.5 on each candle
  tight: [100.5, 100.25, 100],
  'tight+1': [101, 100.75, 100.5],
  'tight+2': [101.5, 101.25, 101],
  // After tight, the rise stalls, two closes of 100.125: still bullish, the spread narrows to 0.2, then 0.087
  tighter: [100.25, 100.1875, 100.05],
  tightest: [100.16666666666667, 100.15625, 100.08],
  // After tight, a close of 99.75: the two fastest EMAs equal (spread 0.1); of 99.5: the fastest below the next (spread 0.075)
  equalPair: [100, 100, 99.9],
  dip: [99.83333333333333, 99.875, 99.8],
  // Rises by 3, 1 and 0.99 a candle, to closes of 104.5, 101.5 and 101.485: spreads 3, 1 (on the threshold) and 0.99. After wide, a
  // close of 103: spread 1.8
  wide: [103, 101.5, 100],
  slowing: [103, 102.25, 101.2],
  atThreshold: [101, 100.5, 100],
  underThreshold: [100.99, 100.495, 100],
  // A fall by 0.5 a candle, closes 101.25 to 99.75: bearish, spread 0.5
  bearish: [100, 100.25, 100.5],
} as const;
/** The STICKY BUY of `symbol`, as the strategy asks tools.positions for it: the position book sizes it */
const buy = (symbol: TradingPair): AskedOrder => ({ type: 'STICKY', side: 'BUY', symbol });
/** The STICKY SELL of `symbol`, as the strategy asks tools.positions for it: of all of its asset */
const sell = (symbol: TradingPair): AskedOrder => ({ type: 'STICKY', side: 'SELL', symbol });
/** The orders of BTC/USDT of these sides, in their order, as the strategy asks tools.positions for them */
const ordersOf = (sides: OrderSide[]) => sides.map(side => (side === 'BUY' ? buy(BTC) : sell(BTC)));

describe('EMARibbon', () => {
  let strategy: EMARibbon;
  let tools: Tools<EMARibbonStrategyParams>;
  let positions: ScriptedPositions;
  let logs: LoggedLine[];
  let orders: OrderRecorder;
  /** The candles the hooks get, one of each watched pair (see bucketOf) */
  let bucket: CandleBucket;

  /**
   * Makes the strategy anew and plays its init as the StrategyManager does, on fake tools of a run watching `pairs` (BTC/USDT unless
   * given) with the block of the suite under `threshold` (see paramsOf): init has tools.positions track the pairs, each FLAT until a
   * step says otherwise (see ScriptedPositions)
   */
  const start = (pairs: TradingPair[] = [BTC], threshold?: number) => {
    strategy = new EMARibbon();
    ({ tools, positions, logs, orders } = playInit(strategy, pairs, paramsOf(threshold)));
    bucket = bucketOf(pairs);
  };

  /**
   * Plays a timeframe candle as the StrategyManager does: onEachTimeframeCandle on every candle, the warmup included, then, once the
   * warmup is over, onTimeframeCandleAfterWarmup with the same results
   */
  const playCandle = (indicators: RibbonResults[], afterWarmup = true) => {
    const params: OnCandleEventParams<EMARibbonStrategyParams> = { candle: bucket, portfolio: new Map(), tools };
    strategy.onEachTimeframeCandle(params, ...indicators);
    if (afterWarmup) strategy.onTimeframeCandleAfterWarmup(params, ...indicators);
  };

  /**
   * Plays the steps (see playPositionSteps): a position (FLAT, LONG, BUYING, SELLING, SKIPPING) is what tools.positions answers from
   * then on, as the position book settled the orders before it; the name of one of the ribbons (RIBBONS unless others are given) is a
   * candle after the warmup, with the spread of its EMAs, the name in parentheses a warmup candle, and 'none' a candle whose ribbon is
   * not ready yet
   */
  const play = (steps: string, ribbons: Record<string, readonly number[]> = RIBBONS) =>
    playPositionSteps(steps, positions, step => {
      const isWarmup = step.startsWith('(') && step.endsWith(')');
      const name = isWarmup ? step.slice(1, -1) : step;
      if (name !== 'none' && !ribbons[name]) throw new Error(`No ribbon named ${name}, in "${steps}"`);
      playCandle(name === 'none' ? indicatorOf(null) : ribbonOf(ribbons[name]), !isWarmup);
    });

  /**
   * Plays the steps as play does, on a strategy that watches BTC/USDT and ETH/USDT (see start): a position names that of each pair,
   * BTC's then ETH's, '<btc>/<eth>', and so does a candle the ribbon of each pair, '-' for a pair whose ribbon the hooks do not get
   */
  const playPairs = (steps: string, ribbons: Record<string, readonly number[]> = RIBBONS) =>
    playPositionSteps(steps, positions, step => {
      const isWarmup = step.startsWith('(') && step.endsWith(')');
      const names = (isWarmup ? step.slice(1, -1) : step).split('/');
      if (names.length !== 2) throw new Error(`No ribbon of each pair on the candle ${step}, in "${steps}"`);
      const [btc, eth] = names.map((name): RibbonResults['results'][] => {
        if (name === '-') return [];
        if (name !== 'none' && !ribbons[name]) throw new Error(`No ribbon named ${name}, in "${steps}"`);
        return [name === 'none' ? null : resultOf(ribbons[name])];
      });
      playCandle(indicatorArguments({ [BTC]: btc, [ETH]: eth }), !isWarmup);
    });

  beforeEach(() => start());

  describe('init', () => {
    /**
     * The calls init makes, in order, on the first one-minute bucket of `pairs`: each call of tools.positions.track, 'track' followed by
     * what it is given, and each of addIndicator, 'addIndicator' followed by its arguments
     */
    const callsAtInit = (pairs: TradingPair[]) => {
      const fake = fakeTools(paramsOf(), { pairs });
      const calls: unknown[][] = [];
      const track = fake.positions.track.bind(fake.positions);
      fake.positions.track = (...args) => {
        calls.push(['track', ...args]);
        track(...args);
      };
      const addIndicator: AddIndicatorFn = (...args) => {
        calls.push(['addIndicator', ...args]);
      };
      new EMARibbon().init({ candle: bucketOf(pairs), portfolio: new Map(), tools: fake.tools, addIndicator });
      return calls;
    };

    // The strategy has tools.positions track every watched pair, one call without pairs, then trades every pair tracked, a ribbon each,
    // in their order (that of watch.assets)
    it.each`
      case           | pairs         | expected
      ${'one pair'}  | ${[BTC]}      | ${[['track'], ribbonAddedOn(BTC)]}
      ${'two pairs'} | ${[BTC, ETH]} | ${[['track'], ribbonAddedOn(BTC), ribbonAddedOn(ETH)]}
    `(
      'tracks every watched pair, then adds an EMARibbon indicator with the ribbon parameters on each, in their order: $case',
      ({ pairs, expected }) => {
        expect(callsAtInit(pairs)).toStrictEqual(expected);
      },
    );

    // On several pairs the position book says, once, which pairs the strategy trades and how they share the currency, through the
    // strategy's log: the strategy itself says nothing
    it.each`
      case           | pairs
      ${'one pair'}  | ${[BTC]}
      ${'two pairs'} | ${[BTC, ETH]}
    `('logs no line of its own: $case', ({ pairs }) => {
      expect(logsAtInit(new EMARibbon(), pairs, paramsOf())).toEqual([]);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // A ribbon that buys once init has tracked the pairs: before it, the strategy trades no pair
    it('does nothing before init has tracked the pairs', () => {
      strategy = new EMARibbon();
      ({ tools, positions, logs, orders } = fakeTools(paramsOf()));
      play('tight');
      expect({ asked: positions.advices, created: orders.advices, logs }).toEqual({ asked: [], created: [], logs: [] });
    });

    // Null is what the indicator gives until its slowest EMA is ready
    it.each`
      results
      ${undefined}
      ${null}
    `('does nothing while the ribbon is not ready ($results)', ({ results }) => {
      playCandle(indicatorOf(results));
      expect({ asked: positions.advices, logs }).toEqual({ asked: [], logs: [] });
    });

    // A BUY without amount, cost or allocation, which the position book sizes, a SELL of all of the asset, neither created with
    // tools.createOrder: the position book follows its own orders alone
    it.each`
      case                  | steps                   | expected
      ${'a BUY when flat'}  | ${'tight'}              | ${[buy(BTC)]}
      ${'a SELL when long'} | ${'tight LONG tighter'} | ${[buy(BTC), sell(BTC)]}
    `('places a STICKY order through tools.positions: $case', ({ steps, expected }) => {
      play(steps);
      expect({ asked: positions.advices, created: orders.advices }).toStrictEqual({ asked: expected, created: [] });
    });

    // Each EMA above the next, slower one, a spread below the threshold (1), not narrower than on the candle before
    it.each`
      case                                 | steps                | expectedSides
      ${'bullish, under the threshold'}    | ${'tight'}           | ${['BUY']}
      ${'bullish, just under it'}          | ${'underThreshold'}  | ${['BUY']}
      ${'bullish, on the threshold'}       | ${'atThreshold'}     | ${[]}
      ${'bullish, above the threshold'}    | ${'wide'}            | ${[]}
      ${'two EMAs equal'}                  | ${'equalPair'}       | ${[]}
      ${'the fastest EMA below the next'}  | ${'dip'}             | ${[]}
      ${'bearish'}                         | ${'bearish'}         | ${[]}
      ${'narrower than the candle before'} | ${'wide tight'}      | ${[]}
      ${'as wide as the candle before'}    | ${'bearish tight'}   | ${['BUY']}
      ${'wider than the candle before'}    | ${'equalPair tight'} | ${['BUY']}
    `('buys, when flat, a bullish ribbon below the threshold that is not narrowing: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(ordersOf(expectedSides));
    });

    // Long, a narrowing sells whatever the order of the EMAs and whatever the threshold
    it.each`
      case                                     | steps                        | expectedSides
      ${'narrower'}                            | ${'tight LONG tighter'}      | ${['BUY', 'SELL']}
      ${'as wide'}                             | ${'tight LONG tight+1'}      | ${['BUY']}
      ${'wider'}                               | ${'tight LONG wide'}         | ${['BUY']}
      ${'narrower, the fastest EMA below'}     | ${'tight LONG dip'}          | ${['BUY', 'SELL']}
      ${'narrower, still above the threshold'} | ${'tight LONG wide slowing'} | ${['BUY', 'SELL']}
      ${'narrower, when flat'}                 | ${'bearish dip'}             | ${[]}
    `('sells, when long, as soon as the spread narrows: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(ordersOf(expectedSides));
    });

    // A BUY signal places nothing once long, neither signal places anything while an order of the pair pends (BUYING, SELLING), and
    // once the SELL has filled (FLAT) a BUY signal buys again
    it.each`
      case                                   | steps                                    | expectedSides
      ${'a rise that goes on, once long'}    | ${'tight LONG tight+1 tight+2'}          | ${['BUY']}
      ${'a BUY signal while the BUY pends'}  | ${'tight BUYING tight+1'}                | ${['BUY']}
      ${'a narrowing while the BUY pends'}   | ${'tight BUYING tighter'}                | ${['BUY']}
      ${'a BUY signal while the SELL pends'} | ${'tight LONG tighter SELLING tight+1'}  | ${['BUY', 'SELL']}
      ${'a narrowing while the SELL pends'}  | ${'tight LONG tighter SELLING tightest'} | ${['BUY', 'SELL']}
      ${'a BUY signal once the SELL filled'} | ${'tight LONG tighter FLAT tight+1'}     | ${['BUY', 'SELL', 'BUY']}
      ${'a narrowing once the SELL filled'}  | ${'tight LONG tighter FLAT tightest'}    | ${['BUY', 'SELL']}
    `('advises once per position change on $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(ordersOf(expectedSides));
    });
  });

  describe('order outcomes', () => {
    // The position book settles each order as its outcome comes, before the next candle reads the position, and the strategy keeps no
    // memory of its orders: the position left decides what the next candle that signals places, LONG after a BUY completed, FLAT after
    // one canceled or errored without a fill, FLAT after a SELL completed or errored once all was sold, LONG after one canceled or errored
    it.each`
      case                                                                    | steps                                 | expectedSides
      ${'a BUY completed: long, it sells'}                                    | ${'tight LONG tighter'}               | ${['BUY', 'SELL']}
      ${'a BUY canceled, or errored without a fill: flat, it buys again'}     | ${'tight FLAT tight+1'}               | ${['BUY', 'BUY']}
      ${'a SELL completed or errored once all was sold: flat, it buys again'} | ${'tight LONG tighter FLAT tight+1'}  | ${['BUY', 'SELL', 'BUY']}
      ${'a SELL canceled or errored: long, it sells again'}                   | ${'tight LONG tighter LONG tightest'} | ${['BUY', 'SELL', 'SELL']}
    `('acts on the position its order left: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(ordersOf(expectedSides));
    });
  });

  describe('on two pairs', () => {
    beforeEach(() => start([BTC, ETH]));

    // A pair flat, with nothing pending, buys on its own signal, whatever the position of the other pair
    it.each`
      case                                                             | steps                                        | expected
      ${'both flat: a BUY of each'}                                    | ${'tight/tight'}                             | ${[buy(BTC), buy(ETH)]}
      ${'BTC flat again, the BUY of ETH pending: BTC buys'}            | ${'tight/tight FLAT/BUYING tight+1/tight+1'} | ${[buy(BTC), buy(ETH), buy(BTC)]}
      ${'BTC flat again, ETH long: BTC buys'}                          | ${'tight/tight FLAT/LONG tight+1/tight+1'}   | ${[buy(BTC), buy(ETH), buy(BTC)]}
      ${'ETH flat again, BTC long: ETH buys'}                          | ${'tight/tight LONG/FLAT tight+1/tight+1'}   | ${[buy(BTC), buy(ETH), buy(ETH)]}
      ${'BTC long and narrowing, ETH flat again: BTC sells, ETH buys'} | ${'tight/tight LONG/FLAT tighter/tight+1'}   | ${[buy(BTC), buy(ETH), sell(BTC), buy(ETH)]}
      ${'neither ribbon ready'}                                        | ${'none/none'}                               | ${[]}
    `('buys each pair on its own position: $case', ({ steps, expected }) => {
      playPairs(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    // A pair whose ribbon the hooks do not get is left as one whose ribbon is not ready yet: no order, and no spread to compare the
    // next one with, the spread it had before forgotten (wide's 3, from which tight's 0.5 would narrow)
    it.each`
      case                                                           | steps                   | expected
      ${'BTC without a ribbon: ETH buys'}                            | ${'-/tight'}            | ${[buy(ETH)]}
      ${'BTC without, then with one: nothing before it, it buys'}    | ${'-/tight tighter/-'}  | ${[buy(ETH), buy(BTC)]}
      ${'BTC with, without, then with one again: nothing before it'} | ${'wide/- -/- tight/-'} | ${[buy(BTC)]}
    `('leaves alone a pair it gets no ribbon of: $case', ({ steps, expected }) => {
      playPairs(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    // The position of each pair is its own: a pair long sells on its own narrowing, one whose BUY pends places nothing
    it.each`
      case                                              | steps                                          | expected
      ${'BTC long, the BUY of ETH pending: BTC sells'}  | ${'tight/tight LONG/BUYING tighter/tighter'}   | ${[buy(BTC), buy(ETH), sell(BTC)]}
      ${'ETH long, the BUY of BTC pending: ETH sells'}  | ${'tight/tight BUYING/LONG tighter/tighter'}   | ${[buy(BTC), buy(ETH), sell(ETH)]}
      ${'both long: each sells'}                        | ${'tight/tight LONG/LONG tighter/tighter'}     | ${[buy(BTC), buy(ETH), sell(BTC), sell(ETH)]}
      ${'the BUY of ETH errored: ETH alone buys again'} | ${'tight/tight BUYING/FLAT tight+1/tight+1'}   | ${[buy(BTC), buy(ETH), buy(ETH)]}
      ${'both BUYs pending: neither places anything'}   | ${'tight/tight BUYING/BUYING tighter/tight+1'} | ${[buy(BTC), buy(ETH)]}
    `('keeps a position per pair: $case', ({ steps, expected }) => {
      playPairs(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    // A BUY the position book skips (SKIPPING: its share of the currency under a minimum of the market) is neither sent nor pending,
    // and the book alone says so: each ribbon, still signaling on the next candle, asks again
    it('asks again, on each candle of its signal, for a BUY the position book skipped, logging no line of its own', () => {
      playPairs('SKIPPING/SKIPPING tight/tight tight+1/tight+1');
      expect({ asked: positions.advices, logs }).toStrictEqual({
        asked: [buy(BTC), buy(ETH), buy(BTC), buy(ETH)].map(order => ({ ...order, skipped: true })),
        logs: [],
      });
    });
  });

  describe('the first candle after the warmup', () => {
    const WARMUP_RIBBONS = {
      // EMAs 2, 3 and 4 as the StrategyManager computed them over closes rising by 2 from 100 through a warmup of 6 candles, spread 2
      // on its last three, then flat at 110: spread 1.47 on the candle after the warmup, 0.97 on the next
      rise4: [105, 104, 103],
      rise5: [107, 106, 105],
      rise6: [109, 108, 107],
      flat7: [109.66666666666667, 109, 108.2],
      flat8: [109.88888888888889, 109.5, 108.92],
      // The same EMAs after closes still rising, 112: spread 2 again; after a warmup flat at 100 (spread 0), a close of 103: spread 0.8
      rise7: [111, 110, 109],
      flat: [100, 100, 100],
      up: [102, 101.5, 101.2],
      // Spreads 3, 1 and 2
      wide: [103, 101.5, 100],
      narrow: [101, 100.5, 100],
      middle: [102, 101, 100],
    } as const;

    beforeEach(() => start([BTC], 100));

    // A bullish ribbon below the threshold buys on the first candle after the warmup only if its spread has not narrowed since the
    // last warmup candle, as on any other candle
    it.each`
      case                                      | steps                                    | expectedSides
      ${'narrower than at the warmup end'}      | ${'(rise4) (rise5) (rise6) flat7'}       | ${[]}
      ${'then narrower again: no round trip'}   | ${'(rise4) (rise5) (rise6) flat7 flat8'} | ${[]}
      ${'as wide as at the warmup end'}         | ${'(rise4) (rise5) (rise6) rise7'}       | ${['BUY']}
      ${'wider than at the warmup end'}         | ${'(flat) (flat) (flat) up'}             | ${['BUY']}
      ${'wider than the last warmup candle'}    | ${'(wide) (narrow) middle'}              | ${['BUY']}
      ${'narrower than the last warmup candle'} | ${'(narrow) (wide) middle'}              | ${[]}
      ${'the first of the ribbon'}              | ${'(none) (none) flat7'}                 | ${['BUY']}
    `('advises $expectedSides when the spread is $case', ({ steps, expectedSides }) => {
      play(steps, WARMUP_RIBBONS);
      expect(positions.advices).toStrictEqual(ordersOf(expectedSides));
    });

    it('advises nothing during the warmup, even on a ribbon that would buy', () => {
      play('(flat) (up) (up)', WARMUP_RIBBONS);
      expect(positions.advices).toHaveLength(0);
    });

    describe('on two pairs', () => {
      beforeEach(() => start([BTC, ETH], 100));

      // Each pair's spread is compared with its own on the last warmup candle: the rising pair's narrows from 2 to 1.47, the flat
      // pair's widens from 0 to 0.8. Compared with the other pair's, the rising pair's would widen from 0 and the flat pair's narrow.
      it.each`
        case                         | steps                                                | expected
        ${'BTC narrower, ETH wider'} | ${'(rise4/flat) (rise5/flat) (rise6/flat) flat7/up'} | ${[buy(ETH)]}
        ${'BTC wider, ETH narrower'} | ${'(flat/rise4) (flat/rise5) (flat/rise6) up/flat7'} | ${[buy(BTC)]}
      `('compares the spread of each pair with its own on the last warmup candle: $case', ({ steps, expected }) => {
        playPairs(steps, WARMUP_RIBBONS);
        expect(positions.advices).toStrictEqual(expected);
      });
    });
  });

  describe('EMAs within the tolerance of each other', () => {
    const CLOSE_EMAS = {
      // EMAs 10 to 45 (step 5) after 612 candles flat at 30203.69 that followed a random walk: each one froze a few ulps short of the
      // price, one or two ulps above the next, and the spread stopped narrowing
      frozen: [
        30203.68999999999, 30203.689999999988, 30203.68999999998, 30203.689999999977, 30203.689999999973, 30203.689999999966,
        30203.689999999962, 30203.68999999996,
      ],
      // Each EMA 2e-9 above the next, beyond the tolerance (1e-9 of their magnitude)
      apart: [1 + 4e-9, 1 + 2e-9, 1],
      // The fastest two, or the slowest two, 5e-10 apart: within the tolerance
      fastPairWithin: [1.0000000005, 1, 0.9],
      slowPairWithin: [1.1, 1.0000000005, 1],
    } as const;

    it.each`
      case                                   | steps               | expectedSides
      ${'a ribbon frozen on a flat market'}  | ${'frozen frozen'}  | ${[]}
      ${'each EMA above the next beyond it'} | ${'apart'}          | ${['BUY']}
      ${'the fastest two within it'}         | ${'fastPairWithin'} | ${[]}
      ${'the slowest two within it'}         | ${'slowPairWithin'} | ${[]}
    `('advises $expectedSides for $case', ({ steps, expectedSides }) => {
      play(steps, CLOSE_EMAS);
      expect(positions.advices).toStrictEqual(ordersOf(expectedSides));
    });
  });

  describe('a spread within the tolerance of the one before', () => {
    const CLOSE_SPREADS = {
      // EMAs 10 to 45 (step 5) on two candles in a row of a straight rise from 60000 by 3.33 a candle: in exact arithmetic the spread
      // stays 58.275, computed it fell by 1.25e-13 of itself
      rise47: [
        60141.52500000001, 60133.20000000001, 60124.87500000002, 60116.550000000025, 60108.22500000003, 60099.90000000002,
        60091.57500000001, 60083.25,
      ],
      rise48: [
        60144.855, 60136.53000000001, 60128.205000000016, 60119.88000000002, 60111.55500000002, 60103.230000000025, 60094.90500000001,
        60086.58,
      ],
      // Spread 1, then 2e-9 less (beyond the tolerance, 1e-9 of the spreads), or 5e-10 less (within)
      base: [2, 1.5, 1],
      beyond: [2 - 2e-9, 1.5, 1],
      within: [2 - 5e-10, 1.5, 1],
    } as const;

    beforeEach(() => start([BTC], 500));

    // LONG once the BUY completed, FLAT again once it was canceled without a fill
    it.each`
      case                                 | steps                   | expectedSides
      ${'long, down by rounding noise'}    | ${'rise47 LONG rise48'} | ${['BUY']}
      ${'flat, down by rounding noise'}    | ${'rise47 FLAT rise48'} | ${['BUY', 'BUY']}
      ${'long, down beyond the tolerance'} | ${'base LONG beyond'}   | ${['BUY', 'SELL']}
      ${'long, down within the tolerance'} | ${'base LONG within'}   | ${['BUY']}
      ${'flat, down beyond the tolerance'} | ${'base FLAT beyond'}   | ${['BUY']}
      ${'flat, down within the tolerance'} | ${'base FLAT within'}   | ${['BUY', 'BUY']}
    `('advises $expectedSides when $case', ({ steps, expectedSides }) => {
      play(steps, CLOSE_SPREADS);
      expect(positions.advices).toStrictEqual(ordersOf(expectedSides));
    });
  });

  describe('log', () => {
    /** Plays the log hook with these indicator arguments */
    const playLog = (indicators: RibbonResults[]) => strategy.log({ candle: bucket, portfolio: new Map(), tools }, ...indicators);

    // In a run, init tracks the pairs before any candle: before it, the strategy logs nothing
    it('does not log before init has tracked the pairs', () => {
      strategy = new EMARibbon();
      ({ tools, logs } = fakeTools(paramsOf()));
      playLog(ribbonOf(RIBBONS.tight));
      expect(logs).toEqual([]);
    });

    it.each`
      results
      ${undefined}
      ${null}
    `('does not log while the ribbon is not ready ($results)', ({ results }) => {
      playLog(indicatorOf(results));
      expect(logs).toEqual([]);
    });

    it('logs the EMAs of the ribbon and its spread, named by the pair', () => {
      playLog(ribbonOf(RIBBONS.tight));
      expect(logs).toEqual([
        { level: 'debug', message: '[BTC/USDT] Ribbon results: [100.5 / 100.25 / 100]' },
        { level: 'debug', message: '[BTC/USDT] Ribbon Spread: 0.5' },
      ]);
    });

    describe('on two pairs', () => {
      // A tight ribbon of BTC and a bearish one of ETH, with the lines they are logged with
      const btcRibbon = resultOf(RIBBONS.tight);
      const ethRibbon = resultOf(RIBBONS.bearish);
      const BTC_LINES = [
        { level: 'debug', message: '[BTC/USDT] Ribbon results: [100.5 / 100.25 / 100]' },
        { level: 'debug', message: '[BTC/USDT] Ribbon Spread: 0.5' },
      ];
      const ETH_LINES = [
        { level: 'debug', message: '[ETH/USDT] Ribbon results: [100 / 100.25 / 100.5]' },
        { level: 'debug', message: '[ETH/USDT] Ribbon Spread: 0.5' },
      ];

      beforeEach(() => start([BTC, ETH]));

      // In the order of the pairs, each line named by its pair; a pair whose ribbon the hook does not get logs nothing
      it.each`
        case                           | ribbons                                       | expected
        ${'both ribbons'}              | ${{ [BTC]: [btcRibbon], [ETH]: [ethRibbon] }} | ${[...BTC_LINES, ...ETH_LINES]}
        ${'the ribbon of BTC missing'} | ${{ [ETH]: [ethRibbon] }}                     | ${ETH_LINES}
      `('logs the EMAs and the spread of the ribbon of each pair: $case', ({ ribbons, expected }) => {
        playLog(indicatorArguments<RibbonResults['results']>(ribbons));
        expect(logs).toEqual(expected);
      });
    });
  });

  // The refusals of the schema are tested in @gekko/schemas: here, that the class declares it, the StrategyManager parsing the block
  // with it
  it('should declare the strategy schema of @gekko/schemas', () => {
    expect(EMARibbon.schema).toBe(emaRibbonStrategySchema);
  });
});
