import type { CandleBucket } from '@gekko/shared/models/event.types';
import type { TradingPair } from '@gekko/shared/models/utility.types';
import {
  AddedIndicator,
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
import { noop } from 'lodash-es';
import { beforeEach, describe, expect, it } from 'vitest';
import { tmaStrategySchema } from '@gekko/schemas/strategies/tma.schema';
import { TMA } from './tma.strategy';
import { TMAStrategyParams } from './tma.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
/** The parameters of the runs: SMAs of 3, 5 and 8 candles of the close */
const PARAMS: TMAStrategyParams = { short: 3, medium: 5, long: 8, src: 'close' };
/** The same SMAs of the mean of the high and the low */
const HL2_PARAMS: TMAStrategyParams = { ...PARAMS, src: 'hl2' };
const ULP = 2 ** -46; // the gap between 100 and the next double
// The short, medium and long SMAs of each alignment. 'up' is an uptrend, short above medium above long, 'down' and 'dip' the two mixed
// alignments, the medium SMA above both others or below both, which sell when long, 'bearish' the fully bearish one and 'flat' three
// equal SMAs, neither of them a trend. On a flat stretch the SMAs holding only its price are equal in exact arithmetic, their running
// sums leave them a few ulps apart: 'flatRise' has the short one ulp above the medium, itself one ulp above the long, 'flatPeak' the
// medium one ulp above both others, 'flatDip' one ulp below both. In 'pairOver' and 'pairUnder' only the short and the medium hold the
// flat price, one ulp apart, the long still below or above it, and 'runningSums' are the SMAs 10, 21 and 50 that the running sums gave
// on the 26th candle of a stretch flat at 29864.4. 'tickRise' and 'tickPeak' are a tick apart: real alignments. 'longNull',
// 'mediumNull' and 'shortNull' have that SMA not ready yet: null, what the indicator gives until its period is full; 'allNull' has none
// ready.
const ALIGNMENTS = {
  up: [10, 5, 2],
  down: [3, 5, 2],
  dip: [5, 3, 7],
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
  allNull: [null, null, null],
  longNull: [10, 5, null],
  mediumNull: [10, null, 2],
  shortNull: [null, 5, 2],
} as const;

/** The STICKY BUY of `pair` as the strategy asks tools.positions for it: without an amount, the position book sizes it */
const buyOf = (pair: TradingPair): AskedOrder => ({ type: 'STICKY', side: 'BUY', symbol: pair });
/** That BUY of `pair`, which the position book skipped: asked all the same, it got no id (see ScriptedPosition) */
const skippedBuyOf = (pair: TradingPair): AskedOrder => ({ ...buyOf(pair), skipped: true });
/** The STICKY SELL of `pair` as the strategy asks tools.positions for it: of all of its asset */
const sellOf = (pair: TradingPair): AskedOrder => ({ type: 'STICKY', side: 'SELL', symbol: pair });
/** The line of the BUY of `pair`, at info level, which the StrategyManager relays as strategy info: its SMAs short/medium/long */
const longAdvice = (pair: TradingPair, smas: string): LoggedLine => ({
  level: 'info',
  message: `[${pair}] Executing long advice due to detected uptrend: ${smas}`,
});
/** The line of the SELL of `pair`, at info level */
const shortAdvice = (pair: TradingPair, smas: string): LoggedLine => ({
  level: 'info',
  message: `[${pair}] Executing short advice due to detected downtrend: ${smas}`,
});
/** The line of an alignment of `pair` that is no trend, at debug level */
const noTrend = (pair: TradingPair, smas: string): LoggedLine => ({
  level: 'debug',
  message: `[${pair}] No clear trend detected: ${smas}`,
});
/** The addIndicator calls init makes for `pair`, in order: its short, medium and long SMAs, of the periods of PARAMS, on `src` */
const smasOf = (pair: TradingPair, src = 'close'): AddedIndicator[] => [
  ['SMA', pair, { period: 3, src }],
  ['SMA', pair, { period: 5, src }],
  ['SMA', pair, { period: 8, src }],
];

describe('TMA Strategy', () => {
  let strategy: TMA;
  let tools: Tools<TMAStrategyParams>;
  let positions: ScriptedPositions;
  let logs: LoggedLine[];
  /** The orders created through tools.createOrder, which the strategy leaves to tools.positions */
  let orders: OrderRecorder;
  /** The timeframe candle the hooks get: a flat candle of each pair watched, which the strategy does not read */
  let bucket: CandleBucket;

  /** Builds the strategy and the fake tools of a run watching `pairs` (see fakeTools), init not played: tools.positions tracks no pair */
  const setUp = (pairs: TradingPair[]) => {
    strategy = new TMA();
    ({ tools, positions, logs, orders } = fakeTools(PARAMS, { pairs }));
    bucket = flatBucket(Object.fromEntries(pairs.map(pair => [pair, 100])));
  };
  /** Builds them, then plays init as the StrategyManager does on the first one-minute bucket: tools.positions tracks `pairs` */
  const start = (pairs: TradingPair[]) => {
    setUp(pairs);
    strategy.init({ candle: bucket, portfolio: new Map(), tools, addIndicator: noop });
  };
  /**
   * Plays a timeframe candle after the warmup: the short, medium and long SMA results of each pair, in that order, the pairs in the order
   * of watch.assets
   */
  const onCandles = (smasByPair: Record<TradingPair, readonly unknown[]>) =>
    strategy.onTimeframeCandleAfterWarmup(
      { candle: bucket, portfolio: new Map(), tools },
      ...(indicatorArguments(smasByPair) as IndicatorResults<number | null>[]),
    );
  /** Plays a timeframe candle of BTC/USDT: its short, medium and long SMA results, in that order */
  const onCandle = (...smas: unknown[]) => onCandles({ [BTC]: smas });
  /** The SMAs of the alignment `name` (see ALIGNMENTS), a step of `steps` */
  const alignmentOf = (name: string, steps: string) => {
    if (!Object.hasOwn(ALIGNMENTS, name)) throw new Error(`No step named ${name}, in "${steps}"`);
    return ALIGNMENTS[name as keyof typeof ALIGNMENTS];
  };
  /**
   * Plays the steps (see playPositionSteps): a step in upper case sets what tools.positions answers for each pair watched, in their
   * order, separated by a slash ('LONG' on one pair, 'BUYING/FLAT' on two), as the position book settled the orders before it; any other
   * step is a candle: an alignment (see ALIGNMENTS) of BTC/USDT, or one of BTC/USDT and one of ETH/USDT, separated by a comma
   * ('tickRise,flat')
   */
  const play = (steps: string) =>
    playPositionSteps(steps, positions, step => {
      const [btc, eth] = step.split(',');
      const btcSmas = alignmentOf(btc, steps);
      onCandles(eth === undefined ? { [BTC]: btcSmas } : { [BTC]: btcSmas, [ETH]: alignmentOf(eth, steps) });
    });
  /** The sides of the orders the strategy asked of tools.positions, in order */
  const sides = () => positions.advices.map(({ side }) => side);
  /**
   * What `act` has the strategy do, in order: each order it asks of tools.positions (see AskedOrder) and each line it logs, which the
   * StrategyManager relays as they come, the order to the Trader, the line as strategy info
   */
  const journalOf = (act: () => void): (AskedOrder | LoggedLine)[] => {
    const journal: (AskedOrder | LoggedLine)[] = [];
    let journaled = positions.advices.length;
    // The orders asked since the last entry, before the line logged now, or at the end
    const journalOrders = () => {
      journal.push(...positions.advices.slice(journaled));
      journaled = positions.advices.length;
    };
    const { log } = tools;
    tools.log = (level, message) => {
      journalOrders();
      journal.push({ level, message });
      log(level, message);
    };
    act();
    journalOrders();
    return journal;
  };

  beforeEach(() => {
    start([BTC]);
  });

  describe('init', () => {
    // The bucket holds a candle of every watched pair, in the order of watch.assets: the strategy trades them all, its SMAs on each
    it.each`
      case           | pairs         | expected
      ${'one pair'}  | ${[BTC]}      | ${smasOf(BTC)}
      ${'two pairs'} | ${[BTC, ETH]} | ${[...smasOf(BTC), ...smasOf(ETH)]}
    `('should add the short, medium and long SMAs of every watched pair, pair by pair: $case', ({ pairs, expected }) => {
      expect(indicatorsAtInit(new TMA(), pairs, PARAMS)).toEqual(expected);
    });

    it('should add each SMA on the price source of its parameters', () => {
      expect(indicatorsAtInit(new TMA(), [BTC, ETH], HL2_PARAMS)).toEqual([...smasOf(BTC, 'hl2'), ...smasOf(ETH, 'hl2')]);
    });

    // The position book tracks every watched pair, in the order of watch.assets, when track is given none
    it.each`
      case           | pairs
      ${'one pair'}  | ${[BTC]}
      ${'two pairs'} | ${[BTC, ETH]}
    `('should have tools.positions track every watched pair, through one call without pairs: $case', ({ pairs }) => {
      const tracked = playInit(new TMA(), pairs, PARAMS).positions;
      expect({ trackCalls: tracked.trackCalls, pairs: tracked.pairs }).toEqual({ trackCalls: [[]], pairs });
    });

    // init adds the SMAs of the pairs tools.positions tracks, none until track is called
    it('should have tools.positions track the pairs before it adds their SMAs', () => {
      setUp([BTC, ETH]);
      const trackCallsAtEachSMA: number[] = [];
      const addIndicator = () => {
        trackCallsAtEachSMA.push(positions.trackCalls.length);
      };
      strategy.init({ candle: bucket, portfolio: new Map(), tools, addIndicator });
      expect(trackCallsAtEachSMA).toEqual([1, 1, 1, 1, 1, 1]);
    });

    // On several pairs the position book says once which pairs it trades, a line of the StrategyManager's (see Positions.track): the
    // strategy itself says nothing at init, of the pairs or of a pair it would ignore
    it.each`
      case           | pairs
      ${'one pair'}  | ${[BTC]}
      ${'two pairs'} | ${[BTC, ETH]}
    `('should log nothing of its own at init: $case', ({ pairs }) => {
      expect(logsAtInit(new TMA(), pairs, PARAMS)).toEqual([]);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // An uptrend, which buys once init has tracked the pairs, then a flat alignment, which says there is no trend: before init,
    // tools.positions tracks none, and the strategy neither trades nor logs anything of any pair
    it.each`
      case           | pairs         | steps
      ${'one pair'}  | ${[BTC]}      | ${'up flat'}
      ${'two pairs'} | ${[BTC, ETH]} | ${'tickRise,tickRise flat,flat'}
    `('should do nothing before init has tracked the pairs: $case', ({ pairs, steps }) => {
      setUp(pairs);
      play(steps);
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // A BUY on an uptrend when flat, told once placed; a SELL on a mixed alignment when long, told before it is placed (see 'the order
    // of the lines and of the orders they tell'); a line of no trend at debug level, whatever the position; nothing when the position
    // allows no order, and no line for a BUY the position book skips
    it.each`
      alignment    | position      | advices                | lines
      ${'up'}      | ${'FLAT'}     | ${[buyOf(BTC)]}        | ${[longAdvice(BTC, '10/5/2')]}
      ${'up'}      | ${'SKIPPING'} | ${[skippedBuyOf(BTC)]} | ${[]}
      ${'up'}      | ${'LONG'}     | ${[]}                  | ${[]}
      ${'up'}      | ${'BUYING'}   | ${[]}                  | ${[]}
      ${'up'}      | ${'SELLING'}  | ${[]}                  | ${[]}
      ${'down'}    | ${'LONG'}     | ${[sellOf(BTC)]}       | ${[shortAdvice(BTC, '3/5/2')]}
      ${'down'}    | ${'FLAT'}     | ${[]}                  | ${[]}
      ${'down'}    | ${'BUYING'}   | ${[]}                  | ${[]}
      ${'down'}    | ${'SELLING'}  | ${[]}                  | ${[]}
      ${'dip'}     | ${'LONG'}     | ${[sellOf(BTC)]}       | ${[shortAdvice(BTC, '5/3/7')]}
      ${'dip'}     | ${'FLAT'}     | ${[]}                  | ${[]}
      ${'dip'}     | ${'BUYING'}   | ${[]}                  | ${[]}
      ${'dip'}     | ${'SELLING'}  | ${[]}                  | ${[]}
      ${'bearish'} | ${'FLAT'}     | ${[]}                  | ${[noTrend(BTC, '2/5/10')]}
      ${'bearish'} | ${'LONG'}     | ${[]}                  | ${[noTrend(BTC, '2/5/10')]}
      ${'bearish'} | ${'BUYING'}   | ${[]}                  | ${[noTrend(BTC, '2/5/10')]}
      ${'bearish'} | ${'SELLING'}  | ${[]}                  | ${[noTrend(BTC, '2/5/10')]}
      ${'flat'}    | ${'FLAT'}     | ${[]}                  | ${[noTrend(BTC, '100/100/100')]}
      ${'flat'}    | ${'LONG'}     | ${[]}                  | ${[noTrend(BTC, '100/100/100')]}
      ${'flat'}    | ${'BUYING'}   | ${[]}                  | ${[noTrend(BTC, '100/100/100')]}
      ${'flat'}    | ${'SELLING'}  | ${[]}                  | ${[noTrend(BTC, '100/100/100')]}
    `(
      'should advise on the $alignment alignment, BTC/USDT $position, as tools.positions allows',
      ({ alignment, position, advices, lines }) => {
        play(`${position} ${alignment}`);
        expect({ advices: positions.advices, lines: logs }).toStrictEqual({ advices, lines });
      },
    );

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
        expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
      },
    );

    // Compared as 0, a null long SMA would make an uptrend that buys, a null short or medium one a mixed alignment that sells. An SMA is
    // null until its period is full: the candles of a trend before it are skipped, and the first one with all three ready trades.
    it.each`
      case                                                           | steps                               | expectedSides
      ${'long SMA null, when flat'}                                  | ${'longNull'}                       | ${[]}
      ${'medium SMA null, when long'}                                | ${'up LONG mediumNull'}             | ${['BUY']}
      ${'short SMA null, when long'}                                 | ${'up LONG shortNull'}              | ${['BUY']}
      ${'none ready, then the long one not yet, then up, when flat'} | ${'allNull longNull longNull up'}   | ${['BUY']}
      ${'medium, then short SMA null, then down, when long'}         | ${'LONG mediumNull shortNull down'} | ${['SELL']}
    `('should skip a candle whose SMA is null, as one not ready yet: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // The position book makes a pair pending once its order is placed, then long or flat once the order has ended: a step in upper case
    // sets what the book settled, an order placed changing nothing of the scripted positions
    it.each`
      case                                  | steps                               | expectedSides
      ${'consecutive uptrend candles'}      | ${'up BUYING up up'}                | ${['BUY']}
      ${'an uptrend while long'}            | ${'up LONG up up'}                  | ${['BUY']}
      ${'consecutive downtrend candles'}    | ${'up LONG down SELLING down down'} | ${['BUY', 'SELL']}
      ${'a downtrend when flat'}            | ${'down down'}                      | ${[]}
      ${'a downtrend while the BUY pends'}  | ${'up BUYING down'}                 | ${['BUY']}
      ${'an uptrend while the SELL pends'}  | ${'up LONG down SELLING up'}        | ${['BUY', 'SELL']}
      ${'a downtrend once the SELL filled'} | ${'up LONG down FLAT down'}         | ${['BUY', 'SELL']}
      ${'a fully bearish alignment'}        | ${'up LONG bearish'}                | ${['BUY']}
    `('should advise once per position change on $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });
  });

  describe('on a flat stretch', () => {
    // Compared strictly, SMAs one ulp apart were ordered: an uptrend, or a mixed alignment read as a downtrend. The pair is the short
    // and the medium SMAs; long or flat, the position held when the stretch turns flat.
    it.each`
      case                                       | steps                                              | expectedSides
      ${'three ulps apart, rising, when flat'}   | ${'flatRise'}                                      | ${[]}
      ${'pair ulps apart over long, when flat'}  | ${'pairOver'}                                      | ${[]}
      ${'running sums at 29864.4, when flat'}    | ${'runningSums'}                                   | ${[]}
      ${'medium ulps above both, when long'}     | ${'up LONG flatPeak'}                              | ${['BUY']}
      ${'medium ulps below both, when long'}     | ${'up LONG flatDip'}                               | ${['BUY']}
      ${'pair ulps apart under long, when long'} | ${'up LONG pairUnder'}                             | ${['BUY']}
      ${'long crossing the pair, when long'}     | ${'up LONG pairOver pairUnder pairOver pairUnder'} | ${['BUY']}
      ${'three SMAs equal, when long'}           | ${'up LONG flat'}                                  | ${['BUY']}
    `('should see no trend when two SMAs are within the tolerance: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // The other pair: the medium and the long SMAs ulps apart, the short a real amount above or below them
    it.each`
      case                                       | setup        | smas                     | expectedSides
      ${'short above them, when flat'}           | ${''}        | ${[101, 100, 100 - ULP]} | ${[]}
      ${'short below, medium on top, when long'} | ${'up LONG'} | ${[99, 100, 100 - ULP]}  | ${['BUY']}
      ${'short above, medium lowest, when long'} | ${'up LONG'} | ${[101, 100, 100 + ULP]} | ${['BUY']}
    `('should see no trend when the medium and the long SMAs are within the tolerance: $case', ({ setup, smas, expectedSides }) => {
      play(setup);
      onCandle(...smas);
      expect(sides()).toEqual(expectedSides);
    });

    it.each`
      case                                       | steps                                    | expectedSides
      ${'three a tick apart, rising, when flat'} | ${'tickRise'}                            | ${['BUY']}
      ${'medium a tick above both, when long'}   | ${'up LONG tickPeak'}                    | ${['BUY', 'SELL']}
      ${'flat stretch, then uptrend, when flat'} | ${'flatRise pairOver tickRise'}          | ${['BUY']}
      ${'flat stretch, downtrend, when long'}    | ${'up LONG flatPeak pairUnder tickPeak'} | ${['BUY', 'SELL']}
    `('should trade a real alignment: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it('should log no clear trend when two SMAs are within the tolerance', () => {
      play('pairOver');
      expect(logs).toEqual([noTrend(BTC, `${100 + ULP}/100/99`)]);
    });
  });

  describe('the position after an order', () => {
    // The position book settles each order before the next candle: a step in upper case sets the position its outcome leads to, flat
    // after a BUY canceled or errored without a fill, or a SELL that sold everything, long after a BUY completed, or a SELL canceled or
    // errored. While the order is pending, the candles of its signal place nothing; once it has ended without changing the position, the
    // next candle of the signal places it again.
    it.each`
      case                                                                | steps                                    | expectedSides
      ${'a BUY completed: long, it sells'}                                | ${'up BUYING up LONG down'}              | ${['BUY', 'SELL']}
      ${'a BUY canceled or errored, nothing filled: flat, it buys again'} | ${'up BUYING up FLAT up'}                | ${['BUY', 'BUY']}
      ${'a SELL completed, or errored, all sold: flat, it buys again'}    | ${'up LONG down SELLING down FLAT up'}   | ${['BUY', 'SELL', 'BUY']}
      ${'a SELL canceled or errored, nothing sold: long, it sells again'} | ${'up LONG down SELLING down LONG down'} | ${['BUY', 'SELL', 'SELL']}
    `('should trade on the position after $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });
  });

  describe('on two pairs', () => {
    // BTC/USDT then ETH/USDT, the order of watch.assets: each pair has its SMAs, and tools.positions answers for each pair alone, a step
    // in upper case setting what the position book settled from the outcomes of each pair's orders. The candles are real alignments:
    // 'tickRise' an uptrend, 'tickPeak' a mixed one, 'flat' none.
    beforeEach(() => {
      start([BTC, ETH]);
    });

    it.each`
      case                                                  | steps                                                                     | expected
      ${'both rising: a BUY of each, BTC first'}            | ${'tickRise,tickRise'}                                                    | ${[buyOf(BTC), buyOf(ETH)]}
      ${'BTC rising alone: its BUY'}                        | ${'tickRise,flat'}                                                        | ${[buyOf(BTC)]}
      ${'the BUY of BTC pending: that of ETH'}              | ${'tickRise,flat BUYING/FLAT flat,tickRise'}                              | ${[buyOf(BTC), buyOf(ETH)]}
      ${'BTC long: the BUY of ETH alone'}                   | ${'tickRise,flat LONG/FLAT tickRise,tickRise'}                            | ${[buyOf(BTC), buyOf(ETH)]}
      ${'BTC long: its SELL, then the BUY of ETH'}          | ${'tickRise,flat LONG/FLAT tickPeak,tickRise'}                            | ${[buyOf(BTC), sellOf(BTC), buyOf(ETH)]}
      ${'BTC sold: the BUY of ETH'}                         | ${'tickRise,flat LONG/FLAT tickPeak,flat FLAT/FLAT flat,tickRise'}        | ${[buyOf(BTC), sellOf(BTC), buyOf(ETH)]}
      ${'both long: each sells on its own mixed alignment'} | ${'tickRise,tickRise LONG/LONG tickPeak,flat SELLING/LONG flat,tickPeak'} | ${[buyOf(BTC), buyOf(ETH), sellOf(BTC), sellOf(ETH)]}
    `('should trade each pair on its own position: $case', ({ steps, expected }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    // The position of one pair changes nothing of what the other does: a pair that neither buys on an uptrend nor sells on a mixed
    // alignment has its order pending, one that sells, or beside which the other pair buys alone, is long
    it.each`
      case                                                        | steps                                                                      | expected
      ${'BTC long, ETH pending: BTC sells, ETH waits'}            | ${'tickRise,tickRise LONG/BUYING tickPeak,tickRise flat,tickPeak'}         | ${[buyOf(BTC), buyOf(ETH), sellOf(BTC)]}
      ${'BTC pending, ETH flat again: ETH buys again'}            | ${'tickRise,tickRise BUYING/FLAT tickRise,tickRise tickPeak,flat'}         | ${[buyOf(BTC), buyOf(ETH), buyOf(ETH)]}
      ${'BTC long, ETH flat again: ETH buys again'}               | ${'tickRise,tickRise LONG/FLAT tickRise,tickRise'}                         | ${[buyOf(BTC), buyOf(ETH), buyOf(ETH)]}
      ${'BTC long again after its SELL, ETH long: both sell'}     | ${'tickRise,tickRise LONG/LONG tickPeak,flat LONG/LONG tickPeak,tickPeak'} | ${[buyOf(BTC), buyOf(ETH), sellOf(BTC), sellOf(BTC), sellOf(ETH)]}
      ${'BTC flat after its SELL, ETH long: BTC buys, ETH sells'} | ${'tickRise,tickRise LONG/LONG tickPeak,flat FLAT/LONG tickRise,tickPeak'} | ${[buyOf(BTC), buyOf(ETH), sellOf(BTC), buyOf(BTC), sellOf(ETH)]}
    `('should read the position of each pair alone: $case', ({ steps, expected }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    it('should log the lines of each pair, prefixed with the pair', () => {
      play('tickRise,flat BUYING/FLAT flat,tickRise LONG/LONG tickPeak,tickPeak');
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
      expect({ advices: positions.advices, logs }).toStrictEqual({
        advices: [buyOf(ETH)],
        logs: [longAdvice(ETH, '100.02/100.01/100')],
      });
    });

    describe('a BUY the position book skips', () => {
      // On several pairs the position book skips a BUY the market would refuse as too small: it sends nothing, leaves the pair flat with
      // nothing pending, and says why in a line of its own (see Positions.buy). ETH, flat on a mixed alignment, has nothing to sell.
      beforeEach(() => {
        play('SKIPPING/FLAT');
      });

      it('should ask for the BUY on the uptrend, and log no advice', () => {
        play('tickRise,tickPeak');
        expect({ advices: positions.advices, logs }).toStrictEqual({ advices: [skippedBuyOf(BTC)], logs: [] });
      });

      // The pair still flat, nothing pending, the next candle of the uptrend asks for the BUY again: placed once the currency funds it
      it('should ask for it again on each candle of the uptrend, until it is placed', () => {
        play('tickRise,tickPeak tickRise,tickPeak FLAT/FLAT tickRise,tickPeak');
        expect(positions.advices).toStrictEqual([skippedBuyOf(BTC), skippedBuyOf(BTC), buyOf(BTC)]);
      });

      // No advice on the candles whose BUY the position book skips, the book's line alone: logged before the BUY, the advice went out on
      // every candle of the uptrend, an order announced that was never sent. It comes with the BUY placed, once the currency funds it.
      it('should log the advice once the BUY is placed, on none of the candles whose BUY is skipped', () => {
        play('tickRise,tickPeak tickRise,tickPeak FLAT/FLAT tickRise,tickPeak');
        expect(logs).toEqual([longAdvice(BTC, '100.02/100.01/100')]);
      });
    });
  });

  // A BUY is placed before the line that tells it, a SELL after its line: the StrategyManager relays each order to the Trader and each
  // line as strategy info as they come, so that the strat_create notification of a BUY comes before its strat_info line, and the
  // strat_info line of a SELL before its strat_create notification
  describe('the order of the lines and of the orders they tell', () => {
    it.each`
      case                                     | pairs         | steps                                              | expected
      ${'one pair: a BUY, then a SELL'}        | ${[BTC]}      | ${'up LONG down'}                                  | ${[buyOf(BTC), longAdvice(BTC, '10/5/2'), shortAdvice(BTC, '3/5/2'), sellOf(BTC)]}
      ${'two pairs: two BUYs, then two SELLs'} | ${[BTC, ETH]} | ${'tickRise,tickRise LONG/LONG tickPeak,tickPeak'} | ${[buyOf(BTC), longAdvice(BTC, '100.02/100.01/100'), buyOf(ETH), longAdvice(ETH, '100.02/100.01/100'), shortAdvice(BTC, '100/100.01/100'), sellOf(BTC), shortAdvice(ETH, '100/100.01/100'), sellOf(ETH)]}
    `('should place a BUY before its line, and log the line of a SELL before the SELL: $case', ({ pairs, steps, expected }) => {
      start(pairs);
      expect(journalOf(() => play(steps))).toStrictEqual(expected);
    });
  });

  // Created with tools.createOrder, an order would not be the position book's: its outcome would change no position, and the strategy
  // would buy again on the next candle of the uptrend
  it.each`
    case           | pairs         | steps
    ${'one pair'}  | ${[BTC]}      | ${'up LONG down'}
    ${'two pairs'} | ${[BTC, ETH]} | ${'tickRise,tickRise LONG/LONG tickPeak,tickPeak'}
  `('should place its orders through tools.positions alone, none through tools.createOrder: $case', ({ pairs, steps }) => {
    start(pairs);
    play(steps);
    expect(orders.advices).toEqual([]);
  });

  // The refusals of the schema are tested in @gekko/schemas: here, that the class declares it, the StrategyManager parsing the block with it
  it('should declare the strategy schema of @gekko/schemas', () => {
    expect(TMA.schema).toBe(tmaStrategySchema);
  });
});
