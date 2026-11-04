import { BTC_ETH_TRADED_INFO, flatBucket, indicatorArguments, indicatorsAtInit } from '../helpers/positionBook/positionBook.mock';
import { logsAtInit, OrderRecorder, playSteps } from '../helpers/positionTracker/positionTracker.mock';
import type { StrategyOrder } from '@gekko/shared/models/advice.types';
import type { CandleBucket } from '@gekko/shared/models/event.types';
import { LogLevel } from '@gekko/shared/models/logLevel.types';
import type { Portfolio } from '@gekko/shared/models/portfolio.types';
import type { TradingPair } from '@gekko/shared/models/utility.types';
import type { MarketData } from '@gekko/shared/models/exchange.types';
import { IndicatorResults, InitParams, OnCandleEventParams } from '../strategy.types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tmaStrategySchema } from '@gekko/schemas/strategies/tma.schema';
import { TMA } from './tma.strategy';
import { TMAStrategyParams } from './tma.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
const ULP = 2 ** -46; // the gap between 100 and the next double
// The short, medium and long SMAs of each alignment. On a flat stretch the SMAs holding only its price are equal in exact arithmetic,
// their running sums leave them a few ulps apart: 'flatRise' has the short one ulp above the medium, itself one ulp above the long,
// 'flatPeak' the medium one ulp above both others, 'flatDip' one ulp below both. In 'pairOver' and 'pairUnder' only the short and the
// medium hold the flat price, one ulp apart, the long still below or above it, and 'runningSums' are the SMAs 10, 21 and 50 that the
// running sums gave on the 26th candle of a stretch flat at 29864.4. 'tickRise' and 'tickPeak' are a tick apart: real alignments.
// 'longNull', 'mediumNull' and 'shortNull' have that SMA not ready yet: null, what the indicator gives until its period is full.
const ALIGNMENTS = {
  up: [10, 5, 2],
  down: [3, 5, 2],
  bearish: [2, 5, 10],
  flat: [100, 100, 100],
  flatRise: [100 + ULP, 100, 100 - ULP],
  flatPeak: [100 - ULP, 100, 100 - ULP],
  flatDip: [100 + ULP, 100, 100 + ULP],
  pairOver: [100 + ULP, 100, 99],
  pairUnder: [100 + ULP, 100, 101],
  runningSums: [29864.40000000007, 29864.40000000003, 29864.298399999956],
  tickRise: [100.02, 100.01, 100],
  tickPeak: [100, 100.01, 100],
  longNull: [10, 5, null],
  mediumNull: [10, null, 2],
  shortNull: [null, 5, 2],
} as const;
// All-in, as the strategy creates them: without amount, the Trader sizes them from all the free currency (BUY) or asset (SELL)
const allInBuy = { type: 'STICKY', side: 'BUY', symbol: BTC } satisfies StrategyOrder;
const allInSell = { type: 'STICKY', side: 'SELL', symbol: BTC } satisfies StrategyOrder;
/** The STICKY BUY of `pair` the strategy creates: allocated `allocation` % of the free currency, all-in without (see PositionBook.buy) */
const buyOf = (pair: TradingPair, allocation?: number): StrategyOrder =>
  allocation === undefined ? { type: 'STICKY', side: 'BUY', symbol: pair } : { type: 'STICKY', side: 'BUY', symbol: pair, allocation };
/** The all-in STICKY SELL of `pair` the strategy creates */
const sellOf = (pair: TradingPair): StrategyOrder => ({ type: 'STICKY', side: 'SELL', symbol: pair });
/** A portfolio holding `free` USDT, the currency of both pairs */
const usdt = (free: number): Portfolio => new Map([['USDT', { free, used: 0, total: free }]]);

describe('TMA Strategy', () => {
  let strategy: TMA;
  let orders: OrderRecorder;
  let advices: StrategyOrder[];
  let logs: { level: LogLevel; message: string }[];
  let tools: any;
  let bucket: CandleBucket;
  let portfolio: Portfolio;
  let addIndicator: any;

  // The short, medium and long SMA results of each pair, in that order, the pairs in the order of watch.assets
  const onCandles = (smasByPair: Record<TradingPair, readonly unknown[]>) =>
    strategy.onTimeframeCandleAfterWarmup(
      { candle: bucket, portfolio, tools } as unknown as OnCandleEventParams<TMAStrategyParams>,
      ...(indicatorArguments(smasByPair) as IndicatorResults<number | null>[]),
    );
  // The short, medium and long SMA results of a candle of BTC/USDT, in that order
  const onCandle = (...smas: unknown[]) => onCandles({ [BTC]: smas });

  /** The SMAs of the alignment `name` (see ALIGNMENTS), a step of `steps` */
  const alignment = (name: string, steps: string) => {
    if (!(name in ALIGNMENTS)) throw new Error(`No step named ${name}, in "${steps}"`);
    return ALIGNMENTS[name as keyof typeof ALIGNMENTS];
  };
  /**
   * Plays the steps (see playSteps): a candle is an alignment (see ALIGNMENTS) of BTC/USDT, or an alignment of BTC/USDT and one of
   * ETH/USDT, separated by a comma ('tickRise,flat')
   */
  const play = (steps: string) =>
    playSteps(steps, strategy, orders, step => {
      const [btc, eth] = step.split(',');
      onCandles(eth === undefined ? { [BTC]: alignment(btc, steps) } : { [BTC]: alignment(btc, steps), [ETH]: alignment(eth, steps) });
    });

  beforeEach(() => {
    strategy = new TMA();
    orders = new OrderRecorder();
    advices = orders.advices;
    logs = [];
    portfolio = new Map();
    addIndicator = vi.fn();

    tools = {
      strategyParams: { short: 3, medium: 5, long: 8, src: 'close' },
      marketData: new Map(),
      createOrder: orders.createOrder,
      cancelOrder: vi.fn(),
      log: vi.fn((level: LogLevel, message: string) => logs.push({ level, message })),
    };

    bucket = new Map();
    bucket.set(BTC, { close: 1 } as any);

    strategy.init({ candle: bucket, portfolio, tools, addIndicator } as unknown as InitParams<TMAStrategyParams>);
  });

  describe('init', () => {
    it('should add three SMA indicators with correct periods and src', () => {
      expect(addIndicator.mock.calls).toEqual([
        ['SMA', BTC, { period: 3, src: 'close' }],
        ['SMA', BTC, { period: 5, src: 'close' }],
        ['SMA', BTC, { period: 8, src: 'close' }],
      ]);
    });

    // The bucket holds a candle of every watched pair, in the order of watch.assets: the strategy trades them all, its SMAs on each
    it('should add the three SMAs of every watched pair, pair by pair', () => {
      expect(indicatorsAtInit(new TMA(), [BTC, ETH], tools.strategyParams)).toEqual([
        ['SMA', BTC, { period: 3, src: 'close' }],
        ['SMA', BTC, { period: 5, src: 'close' }],
        ['SMA', BTC, { period: 8, src: 'close' }],
        ['SMA', ETH, { period: 3, src: 'close' }],
        ['SMA', ETH, { period: 5, src: 'close' }],
        ['SMA', ETH, { period: 8, src: 'close' }],
      ]);
    });

    // Where it warned that it traded the first pair alone, the book says once which pairs it trades, and nothing on one pair
    it.each`
      case           | pairs         | expected
      ${'one pair'}  | ${[BTC]}      | ${[]}
      ${'two pairs'} | ${[BTC, ETH]} | ${[BTC_ETH_TRADED_INFO]}
    `('should say once, at init, which pairs it trades, on several only, without a warning: $case', ({ pairs, expected }) => {
      expect(logsAtInit(new TMA(), pairs, tools.strategyParams)).toEqual(expected);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // An uptrend, which buys once init has tracked the pairs: before it, the strategy trades none
    it('should do nothing before init has tracked the pairs', () => {
      strategy = new TMA();
      play('up');
      expect({ advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Nothing logged either: a NaN SMA failed every comparison, read as no clear trend, and an infinite one made a trend
    it.each`
      shortRes     | mediumRes    | longRes
      ${undefined} | ${5}         | ${2}
      ${10}        | ${undefined} | ${2}
      ${10}        | ${5}         | ${undefined}
      ${null}      | ${5}         | ${2}
      ${10}        | ${null}      | ${2}
      ${10}        | ${5}         | ${null}
      ${'invalid'} | ${5}         | ${2}
      ${NaN}       | ${5}         | ${2}
      ${10}        | ${NaN}       | ${2}
      ${10}        | ${5}         | ${NaN}
      ${Infinity}  | ${5}         | ${2}
      ${10}        | ${5}         | ${-Infinity}
    `(
      'should do nothing when results are invalid (short: $shortRes, med: $mediumRes, long: $longRes)',
      ({ shortRes, mediumRes, longRes }) => {
        onCandle(shortRes, mediumRes, longRes);
        expect({ advices, logs }).toEqual({ advices: [], logs: [] });
      },
    );

    // Compared as 0, a null long SMA would make an uptrend that buys, a null short or medium one a mixed alignment that sells
    it.each`
      case                            | steps                          | expectedSides
      ${'long SMA null, when flat'}   | ${'longNull'}                  | ${[]}
      ${'medium SMA null, when long'} | ${'up completed:1 mediumNull'} | ${['BUY']}
      ${'short SMA null, when long'}  | ${'up completed:1 shortNull'}  | ${['BUY']}
    `('should skip a candle whose SMA is null, as one not ready yet: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(advices.map(({ side }) => side)).toEqual(expectedSides);
    });

    it('should emit an all-in STICKY BUY on an uptrend when flat', () => {
      play('up');
      expect(advices).toStrictEqual([allInBuy]);
    });

    it('should log the long advice with the three SMAs', () => {
      play('up');
      expect(logs).toContainEqual({ level: 'info', message: '[BTC/USDT] Executing long advice due to detected uptrend: 10/5/2' });
    });

    it.each`
      shortRes | mediumRes | longRes
      ${3}     | ${5}      | ${2}
      ${5}     | ${3}      | ${7}
    `(
      'should emit an all-in STICKY SELL when long and short=$shortRes, med=$mediumRes, long=$longRes',
      ({ shortRes, mediumRes, longRes }) => {
        play('up completed:1');
        onCandle(shortRes, mediumRes, longRes);
        expect(advices).toStrictEqual([allInBuy, allInSell]);
      },
    );

    it.each`
      shortRes | mediumRes | longRes
      ${3}     | ${5}      | ${2}
      ${5}     | ${3}      | ${7}
    `('should log the short advice when short=$shortRes, med=$mediumRes, long=$longRes', ({ shortRes, mediumRes, longRes }) => {
      play('up completed:1');
      onCandle(shortRes, mediumRes, longRes);
      expect(logs).toContainEqual({
        level: 'info',
        message: `[BTC/USDT] Executing short advice due to detected downtrend: ${shortRes}/${mediumRes}/${longRes}`,
      });
    });

    it.each`
      case                                  | steps                                     | expectedSides
      ${'consecutive uptrend candles'}      | ${'up up up'}                             | ${['BUY']}
      ${'an uptrend while long'}            | ${'up completed:1 up up'}                 | ${['BUY']}
      ${'consecutive downtrend candles'}    | ${'up completed:1 down down down'}        | ${['BUY', 'SELL']}
      ${'a downtrend when flat'}            | ${'down down'}                            | ${[]}
      ${'a downtrend while the BUY pends'}  | ${'up down'}                              | ${['BUY']}
      ${'an uptrend while the SELL pends'}  | ${'up completed:1 down up'}               | ${['BUY', 'SELL']}
      ${'a downtrend once the SELL filled'} | ${'up completed:1 down completed:2 down'} | ${['BUY', 'SELL']}
      ${'a fully bearish alignment'}        | ${'up completed:1 bearish'}               | ${['BUY']}
    `('should advise once per position change on $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(advices.map(({ side }) => side)).toEqual(expectedSides);
    });

    it('should log debug when the alignment is fully bearish', () => {
      play('bearish');
      expect(logs).toContainEqual({ level: 'debug', message: '[BTC/USDT] No clear trend detected: 2/5/10' });
    });

    it('should not emit advice and log debug when no clear trend', () => {
      onCandle(5, 5, 5);
      expect(logs).toContainEqual({ level: 'debug', message: '[BTC/USDT] No clear trend detected: 5/5/5' });
    });
  });

  describe('on a flat stretch', () => {
    // Compared strictly, SMAs one ulp apart were ordered: an uptrend, or a mixed alignment read as a downtrend. The pair is the short
    // and the medium SMAs; long or flat, the position held when the stretch turns flat.
    it.each`
      case                                       | steps                                                     | expectedSides
      ${'three ulps apart, rising, when flat'}   | ${'flatRise'}                                             | ${[]}
      ${'pair ulps apart over long, when flat'}  | ${'pairOver'}                                             | ${[]}
      ${'running sums at 29864.4, when flat'}    | ${'runningSums'}                                          | ${[]}
      ${'medium ulps above both, when long'}     | ${'up completed:1 flatPeak'}                              | ${['BUY']}
      ${'medium ulps below both, when long'}     | ${'up completed:1 flatDip'}                               | ${['BUY']}
      ${'pair ulps apart under long, when long'} | ${'up completed:1 pairUnder'}                             | ${['BUY']}
      ${'long crossing the pair, when long'}     | ${'up completed:1 pairOver pairUnder pairOver pairUnder'} | ${['BUY']}
      ${'three SMAs equal, when long'}           | ${'up completed:1 flat'}                                  | ${['BUY']}
    `('should see no trend when two SMAs are within the tolerance: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(advices.map(({ side }) => side)).toEqual(expectedSides);
    });

    // The other pair: the medium and the long SMAs ulps apart, the short a real amount above or below them
    it.each`
      case                                       | setup               | smas                     | expectedSides
      ${'short above them, when flat'}           | ${''}               | ${[101, 100, 100 - ULP]} | ${[]}
      ${'short below, medium on top, when long'} | ${'up completed:1'} | ${[99, 100, 100 - ULP]}  | ${['BUY']}
      ${'short above, medium lowest, when long'} | ${'up completed:1'} | ${[101, 100, 100 + ULP]} | ${['BUY']}
    `('should see no trend when the medium and the long SMAs are within the tolerance: $case', ({ setup, smas, expectedSides }) => {
      play(setup);
      onCandle(...smas);
      expect(advices.map(({ side }) => side)).toEqual(expectedSides);
    });

    it.each`
      case                                       | steps                                           | expectedSides
      ${'three a tick apart, rising, when flat'} | ${'tickRise'}                                   | ${['BUY']}
      ${'medium a tick above both, when long'}   | ${'up completed:1 tickPeak'}                    | ${['BUY', 'SELL']}
      ${'flat stretch, then uptrend, when flat'} | ${'flatRise pairOver tickRise'}                 | ${['BUY']}
      ${'flat stretch, downtrend, when long'}    | ${'up completed:1 flatPeak pairUnder tickPeak'} | ${['BUY', 'SELL']}
    `('should trade a real alignment: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(advices.map(({ side }) => side)).toEqual(expectedSides);
    });

    it('should log no clear trend when two SMAs are within the tolerance', () => {
      play('pairOver');
      expect(logs).toContainEqual({ level: 'debug', message: `[BTC/USDT] No clear trend detected: ${100 + ULP}/100/99` });
    });
  });

  describe('order outcomes', () => {
    // An outcome reports nothing of an execution, unless its step gives the BTC left free after it ('errored:2:0', see playSteps)
    it.each`
      case                                               | steps                                    | expectedSides
      ${'a BUY completed: long, it sells'}               | ${'up completed:1 down'}                 | ${['BUY', 'SELL']}
      ${'a BUY canceled: flat, it buys again'}           | ${'up canceled:1 up'}                    | ${['BUY', 'BUY']}
      ${'a BUY errored: flat, it buys again'}            | ${'up errored:1 up'}                     | ${['BUY', 'BUY']}
      ${'a SELL completed: flat, it buys again'}         | ${'up completed:1 down completed:2 up'}  | ${['BUY', 'SELL', 'BUY']}
      ${'a SELL canceled: long, it sells again'}         | ${'up completed:1 down canceled:2 down'} | ${['BUY', 'SELL', 'SELL']}
      ${'a SELL errored: long, it sells again'}          | ${'up completed:1 down errored:2 down'}  | ${['BUY', 'SELL', 'SELL']}
      ${'a SELL errored, all sold: flat, it buys again'} | ${'up completed:1 down errored:2:0 up'}  | ${['BUY', 'SELL', 'BUY']}
      ${'another order completed: still pending'}        | ${'up completed:unknown up down'}        | ${['BUY']}
      ${'another order canceled: still pending'}         | ${'up canceled:unknown up down'}         | ${['BUY']}
      ${'another order errored: still pending'}          | ${'up errored:unknown up down'}          | ${['BUY']}
    `('should track $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(advices.map(({ side }) => side)).toEqual(expectedSides);
    });
  });

  describe('on two pairs', () => {
    // BTC/USDT then ETH/USDT, the order of watch.assets: each pair has its SMAs and its position, and a BUY takes an equal share of the
    // free currency among the pairs not invested (flat, a BUY pending or not), all of it once the other pair is long (see
    // PositionBook.buy). The candles are real alignments: 'tickRise' an uptrend, 'tickPeak' a mixed one, 'flat' none.
    beforeEach(() => {
      strategy = new TMA();
      bucket = flatBucket({ [BTC]: 100, [ETH]: 100 });
      strategy.init({ candle: bucket, portfolio, tools, addIndicator } as unknown as InitParams<TMAStrategyParams>);
      logs = []; // the line init logs is asserted with init's
    });

    it.each`
      case                                                      | steps                                                                      | expected
      ${'both rising: a BUY of each, of 50 %'}                  | ${'tickRise,tickRise'}                                                     | ${[buyOf(BTC, 50), buyOf(ETH, 50)]}
      ${'BTC rising alone: its BUY of 50 %'}                    | ${'tickRise,flat'}                                                         | ${[buyOf(BTC, 50)]}
      ${'the BUY of BTC pending: that of ETH of 50 %'}          | ${'tickRise,flat flat,tickRise'}                                           | ${[buyOf(BTC, 50), buyOf(ETH, 50)]}
      ${'BTC long: the BUY of ETH all-in'}                      | ${'tickRise,flat completed:1 tickRise,tickRise'}                           | ${[buyOf(BTC, 50), buyOf(ETH)]}
      ${'BTC long, its SELL pending: the BUY of ETH all-in'}    | ${'tickRise,flat completed:1 tickPeak,tickRise'}                           | ${[buyOf(BTC, 50), sellOf(BTC), buyOf(ETH)]}
      ${'BTC sold: the BUY of ETH of 50 % again'}               | ${'tickRise,flat completed:1 tickPeak,flat completed:2 flat,tickRise'}     | ${[buyOf(BTC, 50), sellOf(BTC), buyOf(ETH, 50)]}
      ${'both long: each sells all of it on its own downtrend'} | ${'tickRise,tickRise completed:1 completed:2 tickPeak,flat flat,tickPeak'} | ${[buyOf(BTC, 50), buyOf(ETH, 50), sellOf(BTC), sellOf(ETH)]}
    `('should trade each pair on its own position, its BUY allocated while the other is not invested: $case', ({ steps, expected }) => {
      play(steps);
      expect(advices).toStrictEqual(expected);
    });

    // A pair that neither buys on an uptrend nor sells on a mixed alignment has its order pending; one that sells, or beside which the
    // other pair buys all-in, is long
    it.each`
      case                                                     | steps                                                                                      | expected
      ${'the BUY of BTC completed: that of ETH still pending'} | ${'tickRise,tickRise completed:1 tickPeak,tickRise flat,tickPeak'}                         | ${[buyOf(BTC, 50), buyOf(ETH, 50), sellOf(BTC)]}
      ${'the BUY of ETH canceled: that of BTC still pending'}  | ${'tickRise,tickRise canceled:2 tickRise,tickRise tickPeak,flat'}                          | ${[buyOf(BTC, 50), buyOf(ETH, 50), buyOf(ETH, 50)]}
      ${'the BUY of ETH errored: BTC still long'}              | ${'tickRise,tickRise completed:1 errored:2 tickRise,tickRise'}                             | ${[buyOf(BTC, 50), buyOf(ETH, 50), buyOf(ETH)]}
      ${'the SELL of BTC errored: ETH still long'}             | ${'tickRise,tickRise completed:1 completed:2 tickPeak,flat errored:3 tickPeak,tickPeak'}   | ${[buyOf(BTC, 50), buyOf(ETH, 50), sellOf(BTC), sellOf(BTC), sellOf(ETH)]}
      ${'the SELL of BTC completed: ETH still long'}           | ${'tickRise,tickRise completed:1 completed:2 tickPeak,flat completed:3 tickRise,tickPeak'} | ${[buyOf(BTC, 50), buyOf(ETH, 50), sellOf(BTC), buyOf(BTC), sellOf(ETH)]}
    `('should leave the position of the other pair as it was on an outcome: $case', ({ steps, expected }) => {
      play(steps);
      expect(advices).toStrictEqual(expected);
    });

    it('should log the lines of each pair, prefixed with the pair', () => {
      play('tickRise,flat flat,tickRise completed:1 completed:2 tickPeak,tickPeak');
      expect(logs).toEqual([
        { level: 'info', message: '[BTC/USDT] Executing long advice due to detected uptrend: 100.02/100.01/100' },
        { level: 'debug', message: '[ETH/USDT] No clear trend detected: 100/100/100' },
        { level: 'debug', message: '[BTC/USDT] No clear trend detected: 100/100/100' },
        { level: 'info', message: '[ETH/USDT] Executing long advice due to detected uptrend: 100.02/100.01/100' },
        { level: 'info', message: '[BTC/USDT] Executing short advice due to detected downtrend: 100/100.01/100' },
        { level: 'info', message: '[ETH/USDT] Executing short advice due to detected downtrend: 100/100.01/100' },
      ]);
    });

    // The StrategyManager hands each hook the results of every indicator added: a pair without any is not traded, the others are
    it('should trade the pairs whose SMAs the hook gets, skipping a pair without any', () => {
      onCandles({ [ETH]: ALIGNMENTS.tickRise });
      expect(advices).toStrictEqual([buyOf(ETH, 50)]);
    });

    describe('a BUY the book skips', () => {
      // 50 % of 10 USDT is 4.75 USDT once 5 % is kept back for the fee, below the minimum cost of 10 USDT: the book sends nothing and
      // leaves the pair flat, nothing pending (see PositionBook.buy). ETH, flat on a mixed alignment, has nothing to sell.
      beforeEach(() => {
        portfolio = usdt(10);
        tools.marketData = new Map<TradingPair, MarketData>([
          [BTC, { cost: { min: 10 } }],
          [ETH, { cost: { min: 10 } }],
        ]);
      });

      it('should send nothing', () => {
        play('tickRise,tickPeak');
        expect(advices).toStrictEqual([]);
      });

      // The pair still flat, nothing pending, the next candle of the uptrend asks for the BUY again: sent once the currency funds it
      it('should ask for it again on the next candle of the uptrend', () => {
        play('tickRise,tickPeak');
        portfolio = usdt(100);
        play('tickRise,tickPeak');
        expect(advices).toStrictEqual([buyOf(BTC, 50)]);
      });

      // No advice on the candles whose BUY the book skips, the line of the book alone: a warning the first time, at debug level after
      // it. Logged before the BUY, the advice went out on every candle of the uptrend, an order announced that was never sent. It comes
      // with the BUY placed, once the currency funds it.
      it('should log the skip of the book alone on each candle of the uptrend, and the advice once the BUY is placed', () => {
        play('tickRise,tickPeak tickRise,tickPeak');
        portfolio = usdt(100);
        play('tickRise,tickPeak');
        expect(logs).toEqual([
          { level: 'warn', message: expect.stringMatching(/^\[BTC\/USDT\] BUY skipped: 50 % of the 10 USDT free, /) },
          { level: 'debug', message: expect.stringMatching(/^\[BTC\/USDT\] BUY skipped: 50 % of the 10 USDT free, /) },
          { level: 'info', message: '[BTC/USDT] Executing long advice due to detected uptrend: 100.02/100.01/100' },
        ]);
      });
    });
  });

  // The refusals of the schema are tested in @gekko/schemas: here, that the class declares it, the StrategyManager parsing the block with it
  it('should declare the strategy schema of @gekko/schemas', () => {
    expect(TMA.schema).toBe(tmaStrategySchema);
  });
});
