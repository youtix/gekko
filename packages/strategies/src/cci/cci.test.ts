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
import type { AddIndicatorFn, OnCandleEventParams, Tools } from '../strategy.types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cciStrategySchema } from '@gekko/schemas/strategies/cci.schema';
import { CCI } from './cci.strategy';
import { CCIStrategyParams } from './cci.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
const SOL: TradingPair = 'SOL/USDT';
/** The parameters of the suite: a CCI of 14 candles, overbought from 100 up, oversold from -100 down, a trend persisting 2 candles */
const PARAMS: CCIStrategyParams = { period: 14, thresholds: { up: 100, down: -100, persistence: 2 } };
// The CCI value of each candle of the scenarios played below: null is what the indicator gives until it is ready
const CCI_VALUES = { over: 150, under: -150, neutral: 50, nan: NaN, null: null } as const;
/** The STICKY BUY of `symbol` as the strategy asks tools.positions for it: the position book sizes it */
const buy = (symbol: TradingPair): AskedOrder => ({ type: 'STICKY', side: 'BUY', symbol });
/** That BUY, skipped by the position book as too small for the market: buy gave no id (see ScriptedPositions) */
const skippedBuy = (symbol: TradingPair): AskedOrder => ({ ...buy(symbol), skipped: true });
/** The STICKY SELL of `symbol` as the strategy asks tools.positions for it: of all of its asset */
const sell = (symbol: TradingPair): AskedOrder => ({ type: 'STICKY', side: 'SELL', symbol });

describe('CCI Strategy', () => {
  let strategy: CCI;
  let tools: Tools<CCIStrategyParams>;
  let positions: ScriptedPositions;
  let logs: LoggedLine[];
  let orders: OrderRecorder;
  let bucket: CandleBucket;

  /**
   * Runs init on a new CCI as the StrategyManager does, on fake tools watching `pairs` (see playInit), its trends persisting
   * `persistence` candles: init has tools.positions track the pairs, each flat with nothing pending until a step says otherwise
   */
  const start = (pairs: TradingPair[] = [BTC], persistence = PARAMS.thresholds.persistence) => {
    strategy = new CCI();
    ({ tools, positions, logs, orders } = playInit(strategy, pairs, { ...PARAMS, thresholds: { ...PARAMS.thresholds, persistence } }));
    bucket = flatBucket(Object.fromEntries(pairs.map(pair => [pair, 10])));
  };
  /** The params of a candle hook: a flat candle of each pair watched and an empty portfolio, which CCI does not read, and the tools */
  const candleParams = (): OnCandleEventParams<CCIStrategyParams> => ({ candle: bucket, portfolio: new Map(), tools });
  /** Plays a candle after the warmup: the CCI of BTC/USDT (see CCI_VALUES), followed on two pairs by that of ETH/USDT ('under/neutral') */
  const playCandle = (step: string) => {
    const [btc, eth] = step.split('/').map(name => {
      // A misspelt step would be an undefined CCI, a candle skipped
      if (!Object.hasOwn(CCI_VALUES, name)) throw new Error(`No CCI named ${name}, in the candle ${step}`);
      return CCI_VALUES[name as keyof typeof CCI_VALUES];
    });
    const results: Record<TradingPair, (number | null)[]> = step.includes('/') ? { [BTC]: [btc], [ETH]: [eth] } : { [BTC]: [btc] };
    strategy.onTimeframeCandleAfterWarmup(candleParams(), ...indicatorArguments(results));
  };
  /**
   * Plays the steps, separated by spaces (see playPositionSteps): a step naming a position for each pair watched ('LONG' on one pair,
   * 'LONG/BUYING' on two) sets what tools.positions answers from then on, as the position book settles an order before the next
   * candle, and any other step is a candle (see playCandle). Asking for an order changes no position: the steps say each.
   */
  const play = (steps: string) => playPositionSteps(steps, positions, playCandle);
  /** The side of each order asked of tools.positions, in order */
  const sides = () => positions.advices.map(({ side }) => side);
  /** Plays the steps (see play), and gives each order asked as `<side>@<candle>`: the candle it came on, counted from 1 */
  const advisedOn = (steps: string) => {
    const advised: string[] = [];
    let candle = 0;
    playPositionSteps(steps, positions, step => {
      candle++;
      const before = positions.advices.length;
      playCandle(step);
      advised.push(...positions.advices.slice(before).map(({ side }) => `${side}@${candle}`));
    });
    return advised;
  };
  /** The lines logged, each as `<level> <message>` */
  const loggedLines = () => logs.map(({ level, message }) => `${level} ${message}`);
  /**
   * Plays the steps (see play), and gives what the strategy did, in order: each line it logged as `<level> <message>`, each order it
   * asked of tools.positions as `<SIDE> <pair>`, written before the first line logged after it
   */
  const traceOf = (steps: string) => {
    const trace: string[] = [];
    let written = 0;
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
    start();
  });

  describe('init', () => {
    // tools.positions tracks every watched pair, in the order of watch.assets: the strategy trades every one, a CCI each
    it.each`
      case             | pairs              | expected
      ${'one pair'}    | ${[BTC]}           | ${[['CCI', BTC, { period: 14 }]]}
      ${'two pairs'}   | ${[BTC, ETH]}      | ${[['CCI', BTC, { period: 14 }], ['CCI', ETH, { period: 14 }]]}
      ${'three pairs'} | ${[ETH, BTC, SOL]} | ${[['CCI', ETH, { period: 14 }], ['CCI', BTC, { period: 14 }], ['CCI', SOL, { period: 14 }]]}
    `('should add a CCI of the strategy period on every watched pair, in their order: $case', ({ pairs, expected }) => {
      expect(indicatorsAtInit(new CCI(), pairs, PARAMS)).toEqual(expected);
    });

    it.each`
      case           | pairs
      ${'one pair'}  | ${[BTC]}
      ${'two pairs'} | ${[BTC, ETH]}
    `('should have tools.positions track every watched pair, in one call without pairs: $case', ({ pairs }) => {
      const { positions: tracking } = playInit(new CCI(), pairs, PARAMS);
      expect({ trackCalls: tracking.trackCalls, pairs: tracking.pairs }).toEqual({ trackCalls: [[]], pairs });
    });

    // Each CCI is added on a pair tools.positions tracks: before track, it tracks none
    it('should have tools.positions track the pairs before it adds their CCI', () => {
      const fake = fakeTools(PARAMS, { pairs: [BTC, ETH] });
      const trackCallsBefore: number[] = [];
      const addIndicator: AddIndicatorFn = () => {
        trackCallsBefore.push(fake.positions.trackCalls.length);
      };
      new CCI().init({ candle: flatBucket({ [BTC]: 10, [ETH]: 10 }), portfolio: new Map(), tools: fake.tools, addIndicator });
      expect(trackCallsBefore).toEqual([1, 1]);
    });

    // On several pairs, the position book says once which it trades, through the strategy's log: the strategy itself says nothing
    it.each`
      case           | pairs
      ${'one pair'}  | ${[BTC]}
      ${'two pairs'} | ${[BTC, ETH]}
    `('should log nothing at init: $case', ({ pairs }) => {
      expect(logsAtInit(new CCI(), pairs, PARAMS)).toEqual([]);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // Two oversold candles, which buy once init has tracked the pairs: before it, the strategy trades no pair
    it('should do nothing before init has tracked the pairs', () => {
      strategy = new CCI();
      ({ tools, positions, logs } = fakeTools(PARAMS));
      play('under under');
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Nothing logged either: a NaN CCI failed both thresholds and ended the trend, and an infinite one started one
    it.each`
      cciRes
      ${undefined}
      ${'invalid'}
      ${null}
      ${NaN}
      ${Infinity}
      ${-Infinity}
    `('should do nothing when CCI result is invalid ($cciRes)', ({ cciRes }) => {
      strategy.onTimeframeCandleAfterWarmup(candleParams(), { results: cciRes, symbol: BTC });
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Unskipped, a null or NaN CCI would read as between the thresholds and end the trend in progress, its order delayed
    it.each`
      case                                 | steps                                | expectedSides
      ${'NaN within an oversold trend'}    | ${'under nan under'}                 | ${['BUY']}
      ${'NaN within an overbought trend'}  | ${'under under LONG over nan over'}  | ${['BUY', 'SELL']}
      ${'null within an oversold trend'}   | ${'under null under'}                | ${['BUY']}
      ${'null within an overbought trend'} | ${'under under LONG over null over'} | ${['BUY', 'SELL']}
    `('should skip a candle whose CCI is null or NaN, as one not ready yet: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // A trend's order is advised once, on the candle the trend persists: asking for it moves no scripted position, so the pair could
    // still buy (or sell) on the next candles of the trend, and the trend's advice alone keeps the strategy from asking again
    it.each`
      case                                         | steps                                            | expectedSides
      ${'an overbought candle before persistence'} | ${'under under LONG over'}                       | ${['BUY']}
      ${'an overbought trend after persistence'}   | ${'under under LONG over over'}                  | ${['BUY', 'SELL']}
      ${'an overbought trend that continues'}      | ${'under under LONG over over over'}             | ${['BUY', 'SELL']}
      ${'an oversold candle before persistence'}   | ${'under'}                                       | ${[]}
      ${'an oversold trend after persistence'}     | ${'under under'}                                 | ${['BUY']}
      ${'an oversold trend that continues'}        | ${'under under under'}                           | ${['BUY']}
      ${'a switch from overbought to oversold'}    | ${'under under LONG over over FLAT under under'} | ${['BUY', 'SELL', 'BUY']}
      ${'an overbought trend when flat'}           | ${'over over over'}                              | ${[]}
    `('should advise after persistence on $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    // The duration counts the candles of the trend, the current one included. The first neutral candle after a trend logged 0, where
    // the first neutral candle of a run and the first candle of a trend log 1. A null candle is skipped, and counts for nothing.
    it.each`
      steps                             | expected
      ${'neutral neutral'}              | ${['nodirection for 1', 'nodirection for 2']}
      ${'neutral neutral over neutral'} | ${['nodirection for 1', 'nodirection for 2', 'overbought for 1', 'nodirection for 1']}
      ${'over over neutral neutral'}    | ${['overbought for 1', 'overbought for 2', 'nodirection for 1', 'nodirection for 2']}
      ${'under neutral neutral'}        | ${['oversold for 1', 'nodirection for 1', 'nodirection for 2']}
      ${'over under under'}             | ${['overbought for 1', 'oversold for 1', 'oversold for 2']}
      ${'over neutral null neutral'}    | ${['overbought for 1', 'nodirection for 1', 'nodirection for 2']}
    `('should log the trend and its duration on each candle of $steps', ({ steps, expected }: { steps: string; expected: string[] }) => {
      play(steps);
      expect(logs.filter(({ level }) => level === 'debug')).toEqual(
        expected.map(trend => ({ level: 'debug', message: `[BTC/USDT] Trend: ${trend}` })),
      );
    });

    // At info level, on the first candle of each overbought or oversold trend: none for a neutral one, nor for a candle not ready yet
    it.each`
      steps                              | expected
      ${'neutral over over'}             | ${['overbought']}
      ${'under neutral under null over'} | ${['oversold', 'oversold', 'overbought']}
    `('should log each trend detected on $steps', ({ steps, expected }: { steps: string; expected: string[] }) => {
      play(steps);
      expect(logs.filter(({ level }) => level === 'info')).toEqual(
        expected.map(trend => ({ level: 'info', message: `[BTC/USDT] CCI: ${trend} trend detected` })),
      );
    });

    // The duration of a neutral stretch decides no order: the trend that follows starts over on its first candle, whatever came before.
    // A persistence of 1 waits for the second candle of a trend, as 2 does, where MACD and RSI advise on the first (kept as it is).
    it.each`
      case                                    | persistence | steps                                        | expected
      ${'oversold after neutral, at 0'}       | ${0}        | ${'neutral under'}                           | ${['BUY@2']}
      ${'overbought after neutral, at 0'}     | ${0}        | ${'under LONG neutral over'}                 | ${['BUY@1', 'SELL@3']}
      ${'oversold after neutral, at 1'}       | ${1}        | ${'neutral under under'}                     | ${['BUY@3']}
      ${'oversold broken by neutral, at 1'}   | ${1}        | ${'under neutral under'}                     | ${[]}
      ${'oversold after neutral, at 2'}       | ${2}        | ${'neutral under under'}                     | ${['BUY@3']}
      ${'oversold broken by neutral, at 2'}   | ${2}        | ${'under neutral under under'}               | ${['BUY@4']}
      ${'oversold after two neutrals, at 2'}  | ${2}        | ${'under neutral neutral under under'}       | ${['BUY@5']}
      ${'overbought after neutral, at 2'}     | ${2}        | ${'under under LONG neutral over over'}      | ${['BUY@2', 'SELL@5']}
      ${'overbought broken by neutral, at 2'} | ${2}        | ${'under under LONG over neutral over over'} | ${['BUY@2', 'SELL@6']}
      ${'oversold broken by neutral, at 3'}   | ${3}        | ${'under under neutral under under under'}   | ${['BUY@6']}
    `('should advise on the candle it did: $case', ({ persistence, steps, expected }) => {
      start([BTC], persistence);
      expect(advisedOn(steps)).toEqual(expected);
    });

    describe('persistence = 3', () => {
      beforeEach(() => {
        start([BTC], 3);
      });

      it.each`
        case                                    | steps                                      | expectedSides
        ${'two oversold candles'}               | ${'under under'}                           | ${[]}
        ${'three oversold candles'}             | ${'under under under'}                     | ${['BUY']}
        ${'two overbought candles when long'}   | ${'under under under LONG over over'}      | ${['BUY']}
        ${'three overbought candles when long'} | ${'under under under LONG over over over'} | ${['BUY', 'SELL']}
      `('should wait for the third candle on $case', ({ steps, expectedSides }) => {
        play(steps);
        expect(sides()).toEqual(expectedSides);
      });
    });

    describe('persistence = 0', () => {
      beforeEach(() => {
        start([BTC], 0);
      });

      // The order alone, its pair and its type: the position book sizes a BUY, all-in on one pair, and a SELL sells all of the asset
      it.each`
        case                                | steps                | expected
        ${'a BUY on oversold when flat'}    | ${'under'}           | ${[buy(BTC)]}
        ${'a SELL on overbought when long'} | ${'under LONG over'} | ${[buy(BTC), sell(BTC)]}
      `('should ask tools.positions for a STICKY order on the first candle of the trend: $case', ({ steps, expected }) => {
        play(steps);
        expect(positions.advices).toStrictEqual(expected);
      });

      // An order pending on the pair (BUYING, SELLING) allows neither side, and a trend the position does not allow is left unadviced:
      // the strategy advises it on the next candle of the trend that the position allows
      it.each`
        case                                         | steps                                       | expectedSides
        ${'overbought trends when flat'}             | ${'over neutral over neutral over'}         | ${[]}
        ${'overbought trends once sold'}             | ${'under LONG over FLAT neutral over'}      | ${['BUY', 'SELL']}
        ${'oversold trends while long'}              | ${'under LONG neutral under neutral under'} | ${['BUY']}
        ${'oversold trends while the BUY pends'}     | ${'under BUYING neutral under'}             | ${['BUY']}
        ${'an overbought trend while the BUY pends'} | ${'under BUYING over'}                      | ${['BUY']}
        ${'an overbought trend once the BUY filled'} | ${'under BUYING over LONG over'}            | ${['BUY', 'SELL']}
        ${'an oversold trend while the SELL pends'}  | ${'under LONG over SELLING under'}          | ${['BUY', 'SELL']}
        ${'overbought again while the SELL pends'}   | ${'under LONG over SELLING neutral over'}   | ${['BUY', 'SELL']}
      `('should advise once per position change on $case', ({ steps, expectedSides }) => {
        play(steps);
        expect(sides()).toEqual(expectedSides);
      });

      // The position book settles each order before the next candle, and the step after the candle that ordered says the position it
      // left. The trend of an order that left the pair as it was stays adviced: flat again or still long, the next order waits for the
      // next trend.
      it.each`
        case                                                                           | steps                                       | expectedSides
        ${'a BUY completed: long, it sells'}                                           | ${'under LONG over'}                        | ${['BUY', 'SELL']}
        ${'a BUY canceled or errored without a fill: flat, it buys on the next trend'} | ${'under FLAT under neutral under'}         | ${['BUY', 'BUY']}
        ${'a BUY canceled or errored without a fill: its trend stays adviced'}         | ${'under FLAT under under'}                 | ${['BUY']}
        ${'a SELL completed, or errored all sold: flat, it buys again'}                | ${'under LONG over FLAT under'}             | ${['BUY', 'SELL', 'BUY']}
        ${'a SELL canceled or errored: long, it sells on the next trend'}              | ${'under LONG over LONG over neutral over'} | ${['BUY', 'SELL', 'SELL']}
        ${'a SELL canceled or errored: its trend stays adviced'}                       | ${'under LONG over LONG over over'}         | ${['BUY', 'SELL']}
      `('should go by the position its order left: $case', ({ steps, expectedSides }) => {
        play(steps);
        expect(sides()).toEqual(expectedSides);
      });
    });

    // The position book places every order and settles its outcome: an order created with tools.createOrder would not be its own
    it('should ask tools.positions for every order, creating none through tools.createOrder', () => {
      play('under under LONG over over');
      expect({ asked: sides(), created: orders.advices }).toEqual({ asked: ['BUY', 'SELL'], created: [] });
    });

    // The TradingAdvisor relays an info line as strategyInfo and an order as strategyCreateOrder, in the order the strategy makes them,
    // which the strat_info and strat_create notifications follow: the trend detected comes before the order of its first candle, and
    // the duration of a trend after the order of its candle, pair by pair
    it.each`
      case                                | pairs         | persistence | steps                     | expected
      ${'a BUY on one pair'}              | ${[BTC]}      | ${0}        | ${'under'}                | ${['info [BTC/USDT] CCI: oversold trend detected', 'BUY BTC/USDT', 'debug [BTC/USDT] Trend: oversold for 1']}
      ${'a SELL on one pair'}             | ${[BTC]}      | ${0}        | ${'LONG over'}            | ${['info [BTC/USDT] CCI: overbought trend detected', 'SELL BTC/USDT', 'debug [BTC/USDT] Trend: overbought for 1']}
      ${'a BUY once the trend persists'}  | ${[BTC]}      | ${2}        | ${'under under'}          | ${['info [BTC/USDT] CCI: oversold trend detected', 'debug [BTC/USDT] Trend: oversold for 1', 'BUY BTC/USDT', 'debug [BTC/USDT] Trend: oversold for 2']}
      ${'a SELL of BTC and a BUY of ETH'} | ${[BTC, ETH]} | ${0}        | ${'LONG/FLAT over/under'} | ${['info [BTC/USDT] CCI: overbought trend detected', 'SELL BTC/USDT', 'debug [BTC/USDT] Trend: overbought for 1', 'info [ETH/USDT] CCI: oversold trend detected', 'BUY ETH/USDT', 'debug [ETH/USDT] Trend: oversold for 1']}
    `('should log the lines and ask for the orders of a candle in their order: $case', ({ pairs, persistence, steps, expected }) => {
      start(pairs, persistence);
      expect(traceOf(steps)).toEqual(expected);
    });
  });

  describe('log', () => {
    it.each`
      cciRes       | expectedLogsLength
      ${undefined} | ${0}
      ${null}      | ${0}
      ${'invalid'} | ${0}
      ${NaN}       | ${0}
      ${Infinity}  | ${0}
    `('should not log when CCI result is missing or invalid ($cciRes)', ({ cciRes, expectedLogsLength }) => {
      strategy.log(candleParams(), { results: cciRes, symbol: BTC });
      expect(logs).toHaveLength(expectedLogsLength);
    });

    it('should log the CCI of the pair to two decimals, prefixed with it', () => {
      strategy.log(candleParams(), { results: 150.1234, symbol: BTC });
      expect(logs).toEqual([{ level: 'debug', message: '[BTC/USDT] CCI: 150.12' }]);
    });

    it('should log nothing before init has tracked the pairs', () => {
      strategy = new CCI();
      ({ tools, positions, logs } = fakeTools(PARAMS));
      strategy.log(candleParams(), { results: 150.1234, symbol: BTC });
      expect(logs).toEqual([]);
    });
  });

  // Each pair has its own CCI, trend and position: the position book shares the currency among the BUYs of the pairs not invested
  // (tested in @gekko/plugins), and the strategy asks for the order of each pair on that pair's trend and position alone
  describe('on two pairs, BTC/USDT then ETH/USDT', () => {
    beforeEach(() => {
      start([BTC, ETH]);
    });

    describe('persistence = 0', () => {
      beforeEach(() => {
        start([BTC, ETH], 0);
      });

      // The position of the other pair changes nothing: each pair buys when flat and sells when long, nothing pending there
      it.each`
        case                                                       | steps                                                             | expected
        ${'both oversold on one candle'}                           | ${'under/under'}                                                  | ${[buy(BTC), buy(ETH)]}
        ${'ETH oversold while the BUY of BTC pends'}               | ${'under/neutral BUYING/FLAT neutral/under'}                      | ${[buy(BTC), buy(ETH)]}
        ${'ETH oversold while BTC is long'}                        | ${'under/neutral LONG/FLAT neutral/under'}                        | ${[buy(BTC), buy(ETH)]}
        ${'ETH oversold on the candle BTC sells'}                  | ${'under/neutral LONG/FLAT over/under'}                           | ${[buy(BTC), sell(BTC), buy(ETH)]}
        ${'ETH oversold once BTC is flat again'}                   | ${'under/neutral LONG/FLAT over/neutral FLAT/FLAT neutral/under'} | ${[buy(BTC), sell(BTC), buy(ETH)]}
        ${'BTC oversold again while ETH is long'}                  | ${'under/under LONG/LONG over/neutral FLAT/LONG under/neutral'}   | ${[buy(BTC), buy(ETH), sell(BTC), buy(BTC)]}
        ${'both overbought, both long'}                            | ${'under/under LONG/LONG over/over'}                              | ${[buy(BTC), buy(ETH), sell(BTC), sell(ETH)]}
        ${'both overbought, BTC long, the BUY of ETH pending'}     | ${'under/under LONG/BUYING over/over'}                            | ${[buy(BTC), buy(ETH), sell(BTC)]}
        ${'both overbought, ETH long, the BUY of BTC pending'}     | ${'under/under BUYING/LONG over/over'}                            | ${[buy(BTC), buy(ETH), sell(ETH)]}
        ${'both oversold again, BTC flat, the BUY of ETH pending'} | ${'under/under FLAT/BUYING neutral/neutral under/under'}          | ${[buy(BTC), buy(ETH), buy(BTC)]}
        ${'both oversold again, ETH flat, the BUY of BTC pending'} | ${'under/under BUYING/FLAT neutral/neutral under/under'}          | ${[buy(BTC), buy(ETH), buy(ETH)]}
      `('should ask for the order of each pair on its own trend and position: $case', ({ steps, expected }) => {
        play(steps);
        expect(positions.advices).toStrictEqual(expected);
      });

      // The strategy reads the CCI of each pair by its pair (see Tools.indicatorsBySymbol): read by position, ETH's oversold CCI, given
      // first, would have bought BTC. A pair whose CCI is missing is skipped, as one not ready yet. It walks the pairs tracked, in their
      // order, whatever the order of the indicators.
      it.each`
        case                                | results                                                       | expected
        ${"ETH's CCI first"}                | ${{ [ETH]: [CCI_VALUES.under], [BTC]: [CCI_VALUES.neutral] }} | ${[buy(ETH)]}
        ${"BTC's CCI missing"}              | ${{ [ETH]: [CCI_VALUES.under] }}                              | ${[buy(ETH)]}
        ${"both oversold, ETH's CCI first"} | ${{ [ETH]: [CCI_VALUES.under], [BTC]: [CCI_VALUES.under] }}   | ${[buy(BTC), buy(ETH)]}
      `('should read the CCI of each pair by its pair, the pairs in the order tracked: $case', ({ results, expected }) => {
        strategy.onTimeframeCandleAfterWarmup(candleParams(), ...indicatorArguments(results));
        expect(positions.advices).toStrictEqual(expected);
      });

      // The strategy reads the CCI of a pair alone, never its candle
      it('should trade each pair on its CCI, the candle of BTC/USDT missing from the bucket', () => {
        bucket = flatBucket({ [ETH]: 10 });
        play('under/under');
        expect(positions.advices).toStrictEqual([buy(BTC), buy(ETH)]);
      });
    });

    // Each pair counts the candles of its own trend, and a pair whose CCI is not ready yet is skipped alone
    it.each`
      case                                         | steps                                        | expected
      ${'ETH oversold on the candle BTC persists'} | ${'under/neutral under/under'}               | ${[buy(BTC)]}
      ${'ETH persisting a candle later'}           | ${'under/neutral under/under neutral/under'} | ${[buy(BTC), buy(ETH)]}
      ${'the CCI of BTC not ready yet'}            | ${'null/under null/under'}                   | ${[buy(ETH)]}
    `('should follow the trend of each pair apart: $case', ({ steps, expected }) => {
      play(steps);
      expect(positions.advices).toStrictEqual(expected);
    });

    // Each pair starts without a direction, a trend of its own: shared, the second pair would have logged 'nodirection for 2'
    it('should log the trend of each pair, prefixed with it, in the order of the pairs', () => {
      play('neutral/neutral');
      expect(loggedLines()).toEqual(['debug [BTC/USDT] Trend: nodirection for 1', 'debug [ETH/USDT] Trend: nodirection for 1']);
    });

    // The lines of a candle come pair by pair: on the first, a trend of BTC starts while ETH has none; on the second, the trend of BTC
    // persists and buys while that of ETH starts
    it('should log the lines of each pair one pair after the other: an oversold trend of each', () => {
      play('under/neutral under/under');
      expect(loggedLines()).toEqual([
        'info [BTC/USDT] CCI: oversold trend detected',
        'debug [BTC/USDT] Trend: oversold for 1',
        'debug [ETH/USDT] Trend: nodirection for 1',
        'debug [BTC/USDT] Trend: oversold for 2',
        'info [ETH/USDT] CCI: oversold trend detected',
        'debug [ETH/USDT] Trend: oversold for 1',
      ]);
    });

    // An overbought trend of BTC and an oversold one of ETH start on one candle; on the next, BTC turns neutral, and ETH's CCI, not ready,
    // logs nothing
    it('should log the lines of each pair one pair after the other: a trend of each, then one pair not ready', () => {
      play('over/under neutral/null');
      expect(loggedLines()).toEqual([
        'info [BTC/USDT] CCI: overbought trend detected',
        'debug [BTC/USDT] Trend: overbought for 1',
        'info [ETH/USDT] CCI: oversold trend detected',
        'debug [ETH/USDT] Trend: oversold for 1',
        'debug [BTC/USDT] Trend: nodirection for 1',
      ]);
    });

    it.each`
      case                          | results                                  | expected
      ${'both ready'}               | ${{ [BTC]: [150.1234], [ETH]: [-42.5] }} | ${['debug [BTC/USDT] CCI: 150.12', 'debug [ETH/USDT] CCI: -42.50']}
      ${'the CCI of BTC not ready'} | ${{ [BTC]: [null], [ETH]: [-42.5] }}     | ${['debug [ETH/USDT] CCI: -42.50']}
      ${'the CCI of BTC missing'}   | ${{ [ETH]: [-42.5] }}                    | ${['debug [ETH/USDT] CCI: -42.50']}
    `('should log the CCI of each pair ready, prefixed with it: $case', ({ results, expected }) => {
      strategy.log(candleParams(), ...indicatorArguments(results));
      expect(loggedLines()).toEqual(expected);
    });

    // A share of the currency below a minimum of the market: the position book skips the BUY of BTC (tested in @gekko/plugins), and buy
    // gives no id. The strategy takes the BUY as asked: its trend is adviced, and its next BUY waits for the next oversold trend.
    describe('with the BUYs of BTC skipped by the position book', () => {
      beforeEach(() => {
        positions.set(BTC, 'SKIPPING');
      });

      it.each`
        case                     | steps                                                                        | expected
        ${'an oversold trend'}   | ${'under/neutral under/neutral under/neutral'}                               | ${[skippedBuy(BTC)]}
        ${'two oversold trends'} | ${'under/neutral under/neutral neutral/neutral under/neutral under/neutral'} | ${[skippedBuy(BTC), skippedBuy(BTC)]}
      `('should ask for one BUY of the pair per oversold trend, each skipped: $case', ({ steps, expected }) => {
        play(steps);
        expect(positions.advices).toStrictEqual(expected);
      });

      it('should buy on the next oversold trend once the position book places the BUYs of the pair, flat after the skip', () => {
        play('under/neutral under/neutral neutral/neutral FLAT/FLAT under/neutral under/neutral');
        expect(positions.advices).toStrictEqual([skippedBuy(BTC), buy(BTC)]);
      });

      // The strategy logs no line about its orders: a BUY skipped leaves the lines of a BUY placed, the position book alone saying it
      // skipped it
      it.each`
        position
        ${'FLAT'}
        ${'SKIPPING'}
      `('should log the trend and its duration, and nothing of its BUY, whether placed or skipped: $position', ({ position }) => {
        positions.set(BTC, position);
        play('under/neutral under/neutral');
        expect(loggedLines()).toEqual([
          'info [BTC/USDT] CCI: oversold trend detected',
          'debug [BTC/USDT] Trend: oversold for 1',
          'debug [ETH/USDT] Trend: nodirection for 1',
          'debug [BTC/USDT] Trend: oversold for 2',
          'debug [ETH/USDT] Trend: nodirection for 2',
        ]);
      });
    });
  });

  // The refusals of the schema are tested in @gekko/schemas: here, that the class declares it, the StrategyManager parsing the block with it
  it('should declare the strategy schema of @gekko/schemas', () => {
    expect(CCI.schema).toBe(cciStrategySchema);
  });
});
