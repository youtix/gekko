import { BTC_ETH_TRADED_INFO, flatBucket, indicatorArguments, indicatorsAtInit } from '@helpers/strategy/positionBook/positionBook.mock';
import { logsAtInit, OrderRecorder, playSteps } from '@helpers/strategy/positionTracker/positionTracker.mock';
import type { StrategyOrder } from '@models/advice.types';
import type { CandleBucket } from '@models/event.types';
import { LogLevel } from '@models/logLevel.types';
import type { Portfolio } from '@models/portfolio.types';
import { InitParams, OnCandleEventParams } from '@strategies/strategy.types';
import { omit } from 'lodash-es';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMARibbon } from './emaRibbon.strategy';
import { EMARibbonStrategyParams } from './emaRibbon.types';

const symbol = 'BTC/USDT';
/** The second pair, watched after BTC/USDT */
const ETH = 'ETH/USDT';
/** The indicator arguments of a hook: the EMARibbon result given, on the pair traded */
const indicatorOf = (results: unknown) => [{ results, symbol }] as any;
/** The indicator's result for these EMAs, the fastest first, with their spread as the EMARibbon indicator computes it */
const resultOf = (emas: readonly number[]) => ({ results: [...emas], spread: Math.max(...emas) - Math.min(...emas) });
/** The indicator arguments of a hook: the result for these EMAs (see resultOf), on the pair traded */
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
// All-in, as the strategy creates them: without amount, the Trader sizes them from all the free currency (BUY) or asset (SELL)
const allInBuy = { type: 'STICKY', side: 'BUY', symbol } satisfies StrategyOrder;
const allInSell = { type: 'STICKY', side: 'SELL', symbol } satisfies StrategyOrder;
// On two pairs, a BUY takes half of the free currency while the other pair is not invested either (see PositionBook.buy), all of it
// once the other pair is long; a SELL is all-in on its pair
const halfBuy = { ...allInBuy, allocation: 50 } satisfies StrategyOrder;
const ethHalfBuy = { ...halfBuy, symbol: ETH } satisfies StrategyOrder;
const ethAllInBuy = { ...allInBuy, symbol: ETH } satisfies StrategyOrder;
const ethAllInSell = { ...allInSell, symbol: ETH } satisfies StrategyOrder;

describe('EMARibbon', () => {
  let strategy: EMARibbon;
  let addIndicator: any;
  let orders: OrderRecorder;
  let advices: StrategyOrder[];
  let logs: { level: LogLevel; message: string }[];
  let tools: any;
  let bucket: CandleBucket;
  let portfolio: Portfolio;

  /**
   * Plays a timeframe candle as the StrategyManager does: onEachTimeframeCandle on every candle, the warmup included, then, once the
   * warmup is over, onTimeframeCandleAfterWarmup with the same results
   */
  const playCandle = (indicators: any[], afterWarmup = true) => {
    const params = { candle: bucket, portfolio, tools } as unknown as OnCandleEventParams<EMARibbonStrategyParams>;
    strategy.onEachTimeframeCandle(params, ...indicators);
    if (afterWarmup) strategy.onTimeframeCandleAfterWarmup(params, ...indicators);
  };

  /**
   * Plays the steps (see playSteps): the name of one of the ribbons (RIBBONS unless others are given) is a candle after the warmup,
   * with the spread of its EMAs, the name in parentheses a warmup candle, and 'none' a candle whose ribbon is not ready yet
   */
  const play = (steps: string, ribbons: Record<string, readonly number[]> = RIBBONS) =>
    playSteps(steps, strategy, orders, step => {
      const isWarmup = step.startsWith('(') && step.endsWith(')');
      const name = isWarmup ? step.slice(1, -1) : step;
      if (name !== 'none' && !ribbons[name]) throw new Error(`No ribbon named ${name}, in "${steps}"`);
      playCandle(name === 'none' ? indicatorOf(null) : ribbonOf(ribbons[name]), !isWarmup);
    });
  const sides = () => advices.map(({ side }) => side);

  /** Makes the strategy anew on a bucket of BTC/USDT then ETH/USDT, as init gets it, and forgets the line the book logs there */
  const initOnTwoPairs = () => {
    strategy = new EMARibbon();
    bucket = flatBucket({ [symbol]: 100, [ETH]: 100 });
    strategy.init({ candle: bucket, portfolio, tools, addIndicator } as unknown as InitParams<EMARibbonStrategyParams>);
    logs = [];
  };

  /**
   * Plays the steps as play does, on a strategy that watches BTC/USDT and ETH/USDT (see initOnTwoPairs): a candle names the ribbon of
   * each pair, BTC's then ETH's, '<btc>/<eth>', and '-' a pair whose ribbon the hooks do not get
   */
  const playPairs = (steps: string, ribbons: Record<string, readonly number[]> = RIBBONS) =>
    playSteps(steps, strategy, orders, step => {
      const isWarmup = step.startsWith('(') && step.endsWith(')');
      const names = (isWarmup ? step.slice(1, -1) : step).split('/');
      if (names.length !== 2) throw new Error(`No ribbon of each pair on the candle ${step}, in "${steps}"`);
      const [btc, eth] = names.map(name => {
        if (name === '-') return [];
        if (name !== 'none' && !ribbons[name]) throw new Error(`No ribbon named ${name}, in "${steps}"`);
        return [name === 'none' ? null : resultOf(ribbons[name])];
      });
      playCandle(indicatorArguments({ [symbol]: btc, [ETH]: eth }), !isWarmup);
    });

  beforeEach(() => {
    strategy = new EMARibbon();
    orders = new OrderRecorder();
    advices = orders.advices;
    logs = [];
    addIndicator = vi.fn();
    tools = {
      createOrder: orders.createOrder,
      log: vi.fn((level: LogLevel, message: string) => logs.push({ level, message })),
      strategyParams: { src: 'close', count: 3, start: 2, step: 1, spreadCompressionThreshold: 1 },
    };
    portfolio = new Map();

    bucket = new Map();
    bucket.set(symbol, { close: 100 } as any);

    strategy.init({ candle: bucket, tools, addIndicator } as unknown as InitParams<EMARibbonStrategyParams>);
  });

  describe('init', () => {
    const ribbonParams = { src: 'close', count: 3, start: 2, step: 1 };

    // The bucket holds a candle of every watched pair, in the order of watch.assets: the strategy trades every one, a ribbon each
    it.each`
      case           | pairs            | expected
      ${'one pair'}  | ${[symbol]}      | ${[['EMARibbon', symbol, ribbonParams]]}
      ${'two pairs'} | ${[symbol, ETH]} | ${[['EMARibbon', symbol, ribbonParams], ['EMARibbon', ETH, ribbonParams]]}
    `('adds an EMARibbon indicator with the ribbon parameters on each pair, in their order: $case', ({ pairs, expected }) => {
      expect(indicatorsAtInit(new EMARibbon(), pairs, tools.strategyParams)).toEqual(expected);
    });

    // On several pairs the position book says, once, which pairs the strategy trades and how they share the currency
    it.each`
      case           | pairs            | expected
      ${'one pair'}  | ${[symbol]}      | ${[]}
      ${'two pairs'} | ${[symbol, ETH]} | ${[BTC_ETH_TRADED_INFO]}
    `('says once, at init, which pairs it trades, but for one pair: $case', ({ pairs, expected }) => {
      expect(logsAtInit(new EMARibbon(), pairs, tools.strategyParams)).toEqual(expected);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // A ribbon that buys once init has tracked the pairs: before it, the strategy trades no pair
    it('does nothing before init has tracked the pairs', () => {
      strategy = new EMARibbon();
      play('tight');
      expect({ advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Null is what the indicator gives until its slowest EMA is ready
    it.each`
      results
      ${undefined}
      ${null}
    `('does nothing while the ribbon is not ready ($results)', ({ results }) => {
      playCandle(indicatorOf(results));
      expect({ advices, logs }).toEqual({ advices: [], logs: [] });
    });

    it.each`
      case                  | steps                          | expected
      ${'a BUY when flat'}  | ${'tight'}                     | ${[allInBuy]}
      ${'a SELL when long'} | ${'tight completed:1 tighter'} | ${[allInBuy, allInSell]}
    `('advises an all-in STICKY order: $case', ({ steps, expected }) => {
      play(steps);
      expect(advices).toStrictEqual(expected);
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
      expect(sides()).toEqual(expectedSides);
    });

    // Long, a narrowing sells whatever the order of the EMAs and whatever the threshold
    it.each`
      case                                     | steps                               | expectedSides
      ${'narrower'}                            | ${'tight completed:1 tighter'}      | ${['BUY', 'SELL']}
      ${'as wide'}                             | ${'tight completed:1 tight+1'}      | ${['BUY']}
      ${'wider'}                               | ${'tight completed:1 wide'}         | ${['BUY']}
      ${'narrower, the fastest EMA below'}     | ${'tight completed:1 dip'}          | ${['BUY', 'SELL']}
      ${'narrower, still above the threshold'} | ${'tight completed:1 wide slowing'} | ${['BUY', 'SELL']}
      ${'narrower, when flat'}                 | ${'bearish dip'}                    | ${[]}
    `('sells, when long, as soon as the spread narrows: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it.each`
      case                                   | steps                                               | expectedSides
      ${'a rise that goes on, once long'}    | ${'tight completed:1 tight+1 tight+2'}              | ${['BUY']}
      ${'a BUY signal while the BUY pends'}  | ${'tight tight+1'}                                  | ${['BUY']}
      ${'a narrowing while the BUY pends'}   | ${'tight tighter'}                                  | ${['BUY']}
      ${'a BUY signal while the SELL pends'} | ${'tight completed:1 tighter tight+1'}              | ${['BUY', 'SELL']}
      ${'a narrowing while the SELL pends'}  | ${'tight completed:1 tighter tightest'}             | ${['BUY', 'SELL']}
      ${'a BUY signal once the SELL filled'} | ${'tight completed:1 tighter completed:2 tight+1'}  | ${['BUY', 'SELL', 'BUY']}
      ${'a narrowing once the SELL filled'}  | ${'tight completed:1 tighter completed:2 tightest'} | ${['BUY', 'SELL']}
    `('advises once per position change on $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });
  });

  describe('order outcomes', () => {
    // An outcome reports nothing of an execution, unless its step gives the BTC left free after it ('errored:2:0', see playSteps)
    it.each`
      case                                               | steps                                              | expectedSides
      ${'a BUY completed: long, it sells'}               | ${'tight completed:1 tighter'}                     | ${['BUY', 'SELL']}
      ${'a BUY canceled: flat, it buys again'}           | ${'tight canceled:1 tight+1'}                      | ${['BUY', 'BUY']}
      ${'a BUY errored: flat, it buys again'}            | ${'tight errored:1 tight+1'}                       | ${['BUY', 'BUY']}
      ${'a SELL completed: flat, it buys again'}         | ${'tight completed:1 tighter completed:2 tight+1'} | ${['BUY', 'SELL', 'BUY']}
      ${'a SELL canceled: long, it sells again'}         | ${'tight completed:1 tighter canceled:2 tightest'} | ${['BUY', 'SELL', 'SELL']}
      ${'a SELL errored: long, it sells again'}          | ${'tight completed:1 tighter errored:2 tightest'}  | ${['BUY', 'SELL', 'SELL']}
      ${'a SELL errored, all sold: flat, it buys again'} | ${'tight completed:1 tighter errored:2:0 tight+1'} | ${['BUY', 'SELL', 'BUY']}
      ${'another order completed: still pending'}        | ${'tight completed:unknown tight+1 tighter'}       | ${['BUY']}
      ${'another order canceled: still pending'}         | ${'tight canceled:unknown tight+1 tighter'}        | ${['BUY']}
      ${'another order errored: still pending'}          | ${'tight errored:unknown tight+1 tighter'}         | ${['BUY']}
    `('should track $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });
  });

  describe('on two pairs', () => {
    beforeEach(initOnTwoPairs);

    // Each BUY takes an equal share of the free currency among the pairs not invested, the pair asking and a pair whose BUY is pending
    // among them, and all of it when the other pair is long, its SELL pending included (see PositionBook.buy)
    it.each`
      case                                             | steps                                                   | expected
      ${'both flat, a BUY of each: half each'}         | ${'tight/tight'}                                        | ${[halfBuy, ethHalfBuy]}
      ${'BTC again, while the BUY of ETH pends: half'} | ${'tight/tight canceled:1 tight+1/tight+1'}             | ${[halfBuy, ethHalfBuy, halfBuy]}
      ${'BTC again, while ETH is long: all'}           | ${'tight/tight completed:2 canceled:1 tight+1/tight+1'} | ${[halfBuy, ethHalfBuy, allInBuy]}
      ${'ETH again, while BTC is long: all'}           | ${'tight/tight completed:1 canceled:2 tight+1/tight+1'} | ${[halfBuy, ethHalfBuy, ethAllInBuy]}
      ${'ETH again, while the SELL of BTC pends: all'} | ${'tight/tight completed:1 canceled:2 tighter/tight+1'} | ${[halfBuy, ethHalfBuy, allInSell, ethAllInBuy]}
      ${'neither ribbon ready'}                        | ${'none/none'}                                          | ${[]}
    `('buys each pair with its share of the currency: $case', ({ steps, expected }) => {
      playPairs(steps);
      expect(advices).toStrictEqual(expected);
    });

    // A pair whose ribbon the hooks do not get is left as one whose ribbon is not ready yet: no order, and no spread to compare the
    // next one with. BTC, flat, still counts among the pairs not invested.
    it.each`
      case                                                        | steps                  | expected
      ${'BTC without a ribbon: ETH buys, half'}                   | ${'-/tight'}           | ${[ethHalfBuy]}
      ${'BTC without, then with one: nothing before it, it buys'} | ${'-/tight tighter/-'} | ${[ethHalfBuy, halfBuy]}
    `('leaves alone a pair it gets no ribbon of: $case', ({ steps, expected }) => {
      playPairs(steps);
      expect(advices).toStrictEqual(expected);
    });

    // The outcome of an order settles the position of its own pair, the other pair's left as it was
    it.each`
      case                                              | steps                                                    | expected
      ${'BTC long, the BUY of ETH pending: BTC sells'}  | ${'tight/tight completed:1 tighter/tighter'}             | ${[halfBuy, ethHalfBuy, allInSell]}
      ${'ETH long, the BUY of BTC pending: ETH sells'}  | ${'tight/tight completed:2 tighter/tighter'}             | ${[halfBuy, ethHalfBuy, ethAllInSell]}
      ${'both long: each sells'}                        | ${'tight/tight completed:1 completed:2 tighter/tighter'} | ${[halfBuy, ethHalfBuy, allInSell, ethAllInSell]}
      ${'the BUY of ETH errored: ETH alone buys again'} | ${'tight/tight errored:2 tight+1/tight+1'}               | ${[halfBuy, ethHalfBuy, ethHalfBuy]}
      ${'another order completed: both still pending'}  | ${'tight/tight completed:unknown tighter/tight+1'}       | ${[halfBuy, ethHalfBuy]}
    `('keeps a position per pair: $case', ({ steps, expected }) => {
      playPairs(steps);
      expect(advices).toStrictEqual(expected);
    });

    // 15 USDT free: half of it, 7.5 USDT, costs 7.125 USDT once 5 % is kept back for the fee, below the minimum cost of 10 USDT. The book
    // sends neither BUY, and leaves nothing pending: each ribbon, still signaling on the next candle, asks again, its skip logged at
    // debug level from then on.
    it('asks again, on each candle of its signal, for a BUY skipped below the minimum cost of the market, nothing sent', () => {
      portfolio = new Map([['USDT', { free: 15, used: 0, total: 15 }]]);
      tools.marketData = new Map([
        [symbol, { cost: { min: 10 } }],
        [ETH, { cost: { min: 10 } }],
      ]);
      const skipped = (pair: string) =>
        `[${pair}] BUY skipped: 50 % of the 15 USDT free, 7.125 USDT once 5 % is kept back for the fee, is below the minimum cost of 10 USDT of the market: watch fewer pairs or fund the account`;
      const nextSkips = '; the next skips of this pair are logged at debug level until a BUY of it is placed';
      playPairs('tight/tight tight+1/tight+1');
      expect({ advices, logs }).toEqual({
        advices: [],
        logs: [
          { level: 'warn', message: `${skipped(symbol)}${nextSkips}` },
          { level: 'warn', message: `${skipped(ETH)}${nextSkips}` },
          { level: 'debug', message: skipped(symbol) },
          { level: 'debug', message: skipped(ETH) },
        ],
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

    beforeEach(() => {
      tools.strategyParams.spreadCompressionThreshold = 100;
    });

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
      expect(sides()).toEqual(expectedSides);
    });

    it('advises nothing during the warmup, even on a ribbon that would buy', () => {
      play('(flat) (up) (up)', WARMUP_RIBBONS);
      expect(advices).toHaveLength(0);
    });

    describe('on two pairs', () => {
      beforeEach(initOnTwoPairs);

      // Each pair's spread is compared with its own on the last warmup candle: the rising pair's narrows from 2 to 1.47, the flat
      // pair's widens from 0 to 0.8. Compared with the other pair's, the rising pair's would widen from 0 and the flat pair's narrow.
      it.each`
        case                         | steps                                                | expected
        ${'BTC narrower, ETH wider'} | ${'(rise4/flat) (rise5/flat) (rise6/flat) flat7/up'} | ${[ethHalfBuy]}
        ${'BTC wider, ETH narrower'} | ${'(flat/rise4) (flat/rise5) (flat/rise6) up/flat7'} | ${[halfBuy]}
      `('compares the spread of each pair with its own on the last warmup candle: $case', ({ steps, expected }) => {
        playPairs(steps, WARMUP_RIBBONS);
        expect(advices).toStrictEqual(expected);
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
      expect(sides()).toEqual(expectedSides);
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

    beforeEach(() => {
      tools.strategyParams.spreadCompressionThreshold = 500;
    });

    // An order canceled reports nothing of an execution here: the strategy is flat again
    it.each`
      case                                 | steps                          | expectedSides
      ${'long, down by rounding noise'}    | ${'rise47 completed:1 rise48'} | ${['BUY']}
      ${'flat, down by rounding noise'}    | ${'rise47 canceled:1 rise48'}  | ${['BUY', 'BUY']}
      ${'long, down beyond the tolerance'} | ${'base completed:1 beyond'}   | ${['BUY', 'SELL']}
      ${'long, down within the tolerance'} | ${'base completed:1 within'}   | ${['BUY']}
      ${'flat, down beyond the tolerance'} | ${'base canceled:1 beyond'}    | ${['BUY']}
      ${'flat, down within the tolerance'} | ${'base canceled:1 within'}    | ${['BUY', 'BUY']}
    `('advises $expectedSides when $case', ({ steps, expectedSides }) => {
      play(steps, CLOSE_SPREADS);
      expect(sides()).toEqual(expectedSides);
    });
  });

  describe('log', () => {
    it.each`
      results
      ${undefined}
      ${null}
    `('does not log while the ribbon is not ready ($results)', ({ results }) => {
      strategy.log({ candle: bucket, tools } as unknown as OnCandleEventParams<EMARibbonStrategyParams>, ...indicatorOf(results));
      expect(logs).toEqual([]);
    });

    it('logs the EMAs of the ribbon and its spread, named by the pair', () => {
      strategy.log({ candle: bucket, tools } as unknown as OnCandleEventParams<EMARibbonStrategyParams>, ...ribbonOf(RIBBONS.tight));
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

      beforeEach(initOnTwoPairs);

      // In the order of the pairs, each line named by its pair; a pair whose ribbon the hook does not get logs nothing
      it.each`
        case                           | ribbons                                          | expected
        ${'both ribbons'}              | ${{ [symbol]: [btcRibbon], [ETH]: [ethRibbon] }} | ${[...BTC_LINES, ...ETH_LINES]}
        ${'the ribbon of BTC missing'} | ${{ [ETH]: [ethRibbon] }}                        | ${ETH_LINES}
      `('logs the EMAs and the spread of the ribbon of each pair: $case', ({ ribbons, expected }) => {
        const params = { candle: bucket, tools } as unknown as OnCandleEventParams<EMARibbonStrategyParams>;
        strategy.log(params, ...(indicatorArguments(ribbons) as any[]));
        expect(logs).toEqual(expected);
      });
    });
  });

  describe('schema', () => {
    // The documentation's example, without the name that labels the run: the manager parses the block without it
    const params = { src: 'close', count: 8, start: 10, step: 5, spreadCompressionThreshold: 500 };

    it.each`
      scenario                                                      | block                         | expected
      ${'the documentation example'}                                | ${params}                     | ${params}
      ${'a source of the indicator besides close and ohlc4 (hlc3)'} | ${{ ...params, src: 'hlc3' }} | ${{ ...params, src: 'hlc3' }}
      ${'a block without src, on the close'}                        | ${omit(params, 'src')}        | ${params}
    `('accepts $scenario', ({ block, expected }) => {
      expect(EMARibbon.schema.parse(block)).toEqual(expected);
    });

    it('refuses a misspelt spreadCompressionThreshold (spreadCompresionThreshold)', () => {
      const { spreadCompressionThreshold: spreadCompresionThreshold, ...ribbon } = params;
      expect(EMARibbon.schema.safeParse({ ...ribbon, spreadCompresionThreshold }).error?.issues).toMatchObject([
        { path: ['spreadCompressionThreshold'] },
        { code: 'unrecognized_keys', keys: ['spreadCompresionThreshold'], path: [] },
      ]);
    });

    it.each`
      scenario                                            | block                                                  | path
      ${'a quoted count'}                                 | ${{ ...params, count: '8' }}                           | ${['count']}
      ${'a count of 1'}                                   | ${{ ...params, count: 1 }}                             | ${['count']}
      ${'a fractional count'}                             | ${{ ...params, count: 7.5 }}                           | ${['count']}
      ${'a fractional start'}                             | ${{ ...params, start: 10.5 }}                          | ${['start']}
      ${'a start of 0'}                                   | ${{ ...params, start: 0 }}                             | ${['start']}
      ${'a fractional step'}                              | ${{ ...params, step: 1.5 }}                            | ${['step']}
      ${'a step of 0'}                                    | ${{ ...params, step: 0 }}                              | ${['step']}
      ${'an unknown source'}                              | ${{ ...params, src: 'median' }}                        | ${['src']}
      ${'a misspelt src (source), not left to the close'} | ${{ ...omit(params, 'src'), source: 'hl2' }}           | ${[]}
      ${'a quoted threshold'}                             | ${{ ...params, spreadCompressionThreshold: '500' }}    | ${['spreadCompressionThreshold']}
      ${'an infinite threshold'}                          | ${{ ...params, spreadCompressionThreshold: Infinity }} | ${['spreadCompressionThreshold']}
    `('refuses $scenario', ({ block, path }) => {
      expect(EMARibbon.schema.safeParse(block).error?.issues).toMatchObject([{ path }]);
    });

    it('says why it refuses a count of 1', () => {
      expect(EMARibbon.schema.safeParse({ ...params, count: 1 }).error?.issues[0].message).toBe(
        'count must be at least 2 (the spread of a single EMA is always 0)',
      );
    });
  });
});
