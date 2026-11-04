import { BTC_ETH_TRADED_INFO, flatBucket, indicatorArguments, indicatorsAtInit } from '../helpers/positionBook/positionBook.mock';
import { logsAtInit, OrderRecorder, playSteps } from '../helpers/positionTracker/positionTracker.mock';
import { StrategyOrder } from '@gekko/shared/models/advice.types';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { LogLevel } from '@gekko/shared/models/logLevel.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { InitParams, OnCandleEventParams } from '../strategy.types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cciStrategySchema } from '@gekko/schemas/strategies/cci.schema';
import { CCI } from './cci.strategy';
import { CCIStrategyParams } from './cci.types';

// The CCI value of each step of the scenarios played below: null is what the indicator gives until it is ready
const CCI_VALUES = { over: 150, under: -150, neutral: 50, nan: NaN, null: null } as const;
// All-in, as the strategy creates them on one pair, or on the last of its pairs not invested: without amount, the Trader sizes them
// from all the free currency (BUY) or asset (SELL)
const allInBuy = { type: 'STICKY', side: 'BUY', symbol: 'BTC/USDT' } satisfies StrategyOrder;
const allInSell = { type: 'STICKY', side: 'SELL', symbol: 'BTC/USDT' } satisfies StrategyOrder;
const ethAllInBuy = { type: 'STICKY', side: 'BUY', symbol: 'ETH/USDT' } satisfies StrategyOrder;
const ethAllInSell = { type: 'STICKY', side: 'SELL', symbol: 'ETH/USDT' } satisfies StrategyOrder;
// The BUY of one of two pairs while the other is not long, flat or with its BUY pending: half of the free currency, as the book shares it
const halfBuy = { ...allInBuy, allocation: 50 } satisfies StrategyOrder;
const ethHalfBuy = { ...ethAllInBuy, allocation: 50 } satisfies StrategyOrder;
/** A portfolio holding `free` USDT */
const holdingUsdt = (free: number): Portfolio => new Map([['USDT', { free, used: 0, total: free }]]);

describe('CCI Strategy', () => {
  let strategy: CCI;
  let orders: OrderRecorder;
  let advices: StrategyOrder[];
  let logs: { level: LogLevel; message: string }[];
  let tools: any;
  let bucket: CandleBucket;
  let portfolio: Portfolio;
  let addIndicator: any;

  /** The params of a candle hook: the bucket, the portfolio and the tools of the test */
  const candleParams = () => ({ candle: bucket, portfolio, tools }) as unknown as OnCandleEventParams<CCIStrategyParams>;
  /**
   * Plays the steps (see playSteps): a candle is the CCI value of BTC/USDT (see CCI_VALUES), followed on two pairs by that of ETH/USDT
   * ('under/neutral')
   */
  const play = (steps: string) =>
    playSteps(steps, strategy, orders, step => {
      const [btc, eth] = step.split('/').map(name => {
        // A misspelt step would be an undefined CCI, a candle skipped
        if (!(name in CCI_VALUES)) throw new Error(`No step named ${name}, in "${steps}"`);
        return CCI_VALUES[name as keyof typeof CCI_VALUES];
      });
      const results: Record<TradingPair, (number | null)[]> = step.includes('/')
        ? { 'BTC/USDT': [btc], 'ETH/USDT': [eth] }
        : { 'BTC/USDT': [btc] };
      strategy.onTimeframeCandleAfterWarmup(candleParams(), ...indicatorArguments(results));
    });
  const sides = () => advices.map(({ side }) => side);
  /** Plays the steps one by one, and gives each order advised as `<side>@<candle>`: the candle it came on, from 1 */
  const advisedOn = (steps: string) => {
    const advised: string[] = [];
    let candle = 0;
    for (const step of steps.split(' ')) {
      if (!step.includes(':')) candle++;
      const before = advices.length;
      play(step);
      advised.push(...advices.slice(before).map(({ side }) => `${side}@${candle}`));
    }
    return advised;
  };
  /** The lines logged, each as `<level> <message>` */
  const loggedLines = () => logs.map(({ level, message }) => `${level} ${message}`);

  beforeEach(() => {
    strategy = new CCI();
    orders = new OrderRecorder();
    advices = orders.advices;
    logs = [];
    portfolio = new Map();
    addIndicator = vi.fn();

    tools = {
      strategyParams: { period: 14, thresholds: { up: 100, down: -100, persistence: 2 } },
      createOrder: orders.createOrder,
      cancelOrder: vi.fn(),
      log: vi.fn((level: LogLevel, message: string) => logs.push({ level, message })),
    };

    bucket = new Map();
    bucket.set('BTC/USDT', { start: Date.now(), open: 1, high: 2, low: 0, close: 10, volume: 100 } as any);

    strategy.init({ candle: bucket, portfolio, tools, addIndicator } as unknown as InitParams<CCIStrategyParams>);
  });

  describe('init', () => {
    it('should add CCI indicator with strategy period', () => {
      expect(addIndicator).toHaveBeenCalledWith('CCI', 'BTC/USDT', { period: 14 });
    });

    // The bucket holds a candle of every watched pair, in the order of watch.assets: the strategy trades every one, a CCI each
    it.each`
      case             | pairs                                   | expected
      ${'one pair'}    | ${['BTC/USDT']}                         | ${[['CCI', 'BTC/USDT', { period: 14 }]]}
      ${'two pairs'}   | ${['BTC/USDT', 'ETH/USDT']}             | ${[['CCI', 'BTC/USDT', { period: 14 }], ['CCI', 'ETH/USDT', { period: 14 }]]}
      ${'three pairs'} | ${['ETH/USDT', 'BTC/USDT', 'SOL/USDT']} | ${[['CCI', 'ETH/USDT', { period: 14 }], ['CCI', 'BTC/USDT', { period: 14 }], ['CCI', 'SOL/USDT', { period: 14 }]]}
    `('should add a CCI of the strategy period on every watched pair, in their order: $case', ({ pairs, expected }) => {
      expect(indicatorsAtInit(new CCI(), pairs, tools.strategyParams)).toEqual(expected);
    });

    // It traded the first pair alone and warned of the others: on several pairs, the book now says once which it trades and how, at
    // info level, and nothing is said on one
    it.each`
      case           | pairs                       | expected
      ${'one pair'}  | ${['BTC/USDT']}             | ${[]}
      ${'two pairs'} | ${['BTC/USDT', 'ETH/USDT']} | ${[BTC_ETH_TRADED_INFO]}
    `('should log nothing at init on one pair, and the pairs it trades on several: $case', ({ pairs, expected }) => {
      expect(logsAtInit(new CCI(), pairs, tools.strategyParams)).toEqual(expected);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // Two oversold candles, which buy once init has tracked the pairs: before it, the strategy trades no pair
    it('should do nothing before init has tracked the pairs', () => {
      strategy = new CCI();
      play('under under');
      expect({ advices, logs }).toEqual({ advices: [], logs: [] });
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
      strategy.onTimeframeCandleAfterWarmup(candleParams(), {
        results: cciRes,
        symbol: 'BTC/USDT',
      });
      expect({ advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Unskipped, a null or NaN CCI would read as between the thresholds and end the trend in progress, its order delayed
    it.each`
      case                                 | steps                                       | expectedSides
      ${'NaN within an oversold trend'}    | ${'under nan under'}                        | ${['BUY']}
      ${'NaN within an overbought trend'}  | ${'under under completed:1 over nan over'}  | ${['BUY', 'SELL']}
      ${'null within an oversold trend'}   | ${'under null under'}                       | ${['BUY']}
      ${'null within an overbought trend'} | ${'under under completed:1 over null over'} | ${['BUY', 'SELL']}
    `('should skip a candle whose CCI is null or NaN, as one not ready yet: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it.each`
      case                                         | steps                                                          | expectedSides
      ${'an overbought candle before persistence'} | ${'under under completed:1 over'}                              | ${['BUY']}
      ${'an overbought trend after persistence'}   | ${'under under completed:1 over over'}                         | ${['BUY', 'SELL']}
      ${'an overbought trend that continues'}      | ${'under under completed:1 over over over'}                    | ${['BUY', 'SELL']}
      ${'an oversold candle before persistence'}   | ${'under'}                                                     | ${[]}
      ${'an oversold trend after persistence'}     | ${'under under'}                                               | ${['BUY']}
      ${'an oversold trend that continues'}        | ${'under under under'}                                         | ${['BUY']}
      ${'a switch from overbought to oversold'}    | ${'under under completed:1 over over completed:2 under under'} | ${['BUY', 'SELL', 'BUY']}
      ${'an overbought trend when flat'}           | ${'over over over'}                                            | ${[]}
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
      case                                    | persistence | steps                                               | expected
      ${'oversold after neutral, at 0'}       | ${0}        | ${'neutral under'}                                  | ${['BUY@2']}
      ${'overbought after neutral, at 0'}     | ${0}        | ${'under completed:1 neutral over'}                 | ${['BUY@1', 'SELL@3']}
      ${'oversold after neutral, at 1'}       | ${1}        | ${'neutral under under'}                            | ${['BUY@3']}
      ${'oversold broken by neutral, at 1'}   | ${1}        | ${'under neutral under'}                            | ${[]}
      ${'oversold after neutral, at 2'}       | ${2}        | ${'neutral under under'}                            | ${['BUY@3']}
      ${'oversold broken by neutral, at 2'}   | ${2}        | ${'under neutral under under'}                      | ${['BUY@4']}
      ${'oversold after two neutrals, at 2'}  | ${2}        | ${'under neutral neutral under under'}              | ${['BUY@5']}
      ${'overbought after neutral, at 2'}     | ${2}        | ${'under under completed:1 neutral over over'}      | ${['BUY@2', 'SELL@5']}
      ${'overbought broken by neutral, at 2'} | ${2}        | ${'under under completed:1 over neutral over over'} | ${['BUY@2', 'SELL@6']}
      ${'oversold broken by neutral, at 3'}   | ${3}        | ${'under under neutral under under under'}          | ${['BUY@6']}
    `('should advise on the candle it did: $case', ({ persistence, steps, expected }) => {
      tools.strategyParams.thresholds.persistence = persistence;
      expect(advisedOn(steps)).toEqual(expected);
    });

    describe('persistence = 3', () => {
      beforeEach(() => {
        tools.strategyParams.thresholds.persistence = 3;
      });

      it.each`
        case                                    | steps                                             | expectedSides
        ${'two oversold candles'}               | ${'under under'}                                  | ${[]}
        ${'three oversold candles'}             | ${'under under under'}                            | ${['BUY']}
        ${'two overbought candles when long'}   | ${'under under under completed:1 over over'}      | ${['BUY']}
        ${'three overbought candles when long'} | ${'under under under completed:1 over over over'} | ${['BUY', 'SELL']}
      `('should wait for the third candle on $case', ({ steps, expectedSides }) => {
        play(steps);
        expect(sides()).toEqual(expectedSides);
      });
    });

    describe('persistence = 0', () => {
      beforeEach(() => {
        tools.strategyParams.thresholds.persistence = 0;
      });

      it.each`
        case                                | steps                       | expected
        ${'a BUY on oversold when flat'}    | ${'under'}                  | ${[allInBuy]}
        ${'a SELL on overbought when long'} | ${'under completed:1 over'} | ${[allInBuy, allInSell]}
      `('should emit an all-in STICKY order immediately: $case', ({ steps, expected }) => {
        play(steps);
        expect(advices).toStrictEqual(expected);
      });

      it.each`
        case                                         | steps                                                | expectedSides
        ${'overbought trends when flat'}             | ${'over neutral over neutral over'}                  | ${[]}
        ${'overbought trends once sold'}             | ${'under completed:1 over completed:2 neutral over'} | ${['BUY', 'SELL']}
        ${'oversold trends while long'}              | ${'under completed:1 neutral under neutral under'}   | ${['BUY']}
        ${'oversold trends while the BUY pends'}     | ${'under neutral under'}                             | ${['BUY']}
        ${'an overbought trend while the BUY pends'} | ${'under over'}                                      | ${['BUY']}
        ${'an overbought trend once the BUY filled'} | ${'under over completed:1 over'}                     | ${['BUY', 'SELL']}
        ${'an oversold trend while the SELL pends'}  | ${'under completed:1 over under'}                    | ${['BUY', 'SELL']}
        ${'overbought again while the SELL pends'}   | ${'under completed:1 over neutral over'}             | ${['BUY', 'SELL']}
      `('should advise once per position change on $case', ({ steps, expectedSides }) => {
        play(steps);
        expect(sides()).toEqual(expectedSides);
      });

      // An outcome reports nothing of an execution, unless its step gives the BTC left free after it ('errored:2:0', see playSteps). The
      // trend of an order canceled or errored stays adviced: flat again or still long, the next order waits for the next trend.
      it.each`
        case                                                   | steps                                                    | expectedSides
        ${'a BUY completed: long, it sells'}                   | ${'under completed:1 over'}                              | ${['BUY', 'SELL']}
        ${'a BUY canceled: flat, it buys on the next trend'}   | ${'under canceled:1 under neutral under'}                | ${['BUY', 'BUY']}
        ${'a BUY errored: flat, it buys on the next trend'}    | ${'under errored:1 under neutral under'}                 | ${['BUY', 'BUY']}
        ${'a BUY canceled: its trend stays adviced'}           | ${'under canceled:1 under under'}                        | ${['BUY']}
        ${'a SELL completed: flat, it buys again'}             | ${'under completed:1 over completed:2 under'}            | ${['BUY', 'SELL', 'BUY']}
        ${'a SELL canceled: long, it sells on the next trend'} | ${'under completed:1 over canceled:2 over neutral over'} | ${['BUY', 'SELL', 'SELL']}
        ${'a SELL errored: long, it sells on the next trend'}  | ${'under completed:1 over errored:2 over neutral over'}  | ${['BUY', 'SELL', 'SELL']}
        ${'a SELL errored: its trend stays adviced'}           | ${'under completed:1 over errored:2 over over'}          | ${['BUY', 'SELL']}
        ${'a SELL errored, all sold: flat, it buys again'}     | ${'under completed:1 over errored:2:0 under'}            | ${['BUY', 'SELL', 'BUY']}
        ${'another order completed: still pending'}            | ${'under completed:unknown neutral under over'}          | ${['BUY']}
        ${'another order canceled: still pending'}             | ${'under canceled:unknown neutral under over'}           | ${['BUY']}
        ${'another order errored: still pending'}              | ${'under errored:unknown neutral under over'}            | ${['BUY']}
      `('should track $case', ({ steps, expectedSides }) => {
        play(steps);
        expect(sides()).toEqual(expectedSides);
      });
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
      strategy.log(candleParams(), { results: cciRes, symbol: 'BTC/USDT' });
      expect(logs).toHaveLength(expectedLogsLength);
    });

    it('should log CCI property', () => {
      strategy.log(candleParams(), {
        results: 150.1234,
        symbol: 'BTC/USDT',
      });
      expect(logs).toEqual([{ level: 'debug', message: '[BTC/USDT] CCI: 150.12' }]);
    });

    it('should log nothing before init has tracked the pairs', () => {
      strategy = new CCI();
      strategy.log(candleParams(), { results: 150.1234, symbol: 'BTC/USDT' });
      expect(logs).toEqual([]);
    });
  });

  // Each pair has its own CCI, trend and position, and the book shares the currency among the BUYs of the pairs not invested
  describe('on two pairs, BTC/USDT then ETH/USDT', () => {
    beforeEach(() => {
      strategy = new CCI();
      bucket = flatBucket({ 'BTC/USDT': 10, 'ETH/USDT': 10 });
      strategy.init({ candle: bucket, portfolio, tools, addIndicator } as unknown as InitParams<CCIStrategyParams>);
      // Leaves out the line init logs on two pairs (see init): the rows below assert the lines of the candles
      logs = [];
    });

    describe('persistence = 0', () => {
      beforeEach(() => {
        tools.strategyParams.thresholds.persistence = 0;
      });

      // A BUY takes half of the free currency while the other pair is not long (flat, its BUY pending included), all of it once the
      // other pair is long (its SELL pending included); a SELL sells all of its pair's asset
      it.each`
        case                                             | steps                                                                           | expected
        ${'both oversold on one candle'}                 | ${'under/under'}                                                                | ${[halfBuy, ethHalfBuy]}
        ${'ETH oversold while the BUY of BTC pends'}     | ${'under/neutral neutral/under'}                                                | ${[halfBuy, ethHalfBuy]}
        ${'ETH oversold once the BUY of BTC completed'}  | ${'under/neutral completed:1 neutral/under'}                                    | ${[halfBuy, ethAllInBuy]}
        ${'ETH oversold on the candle BTC sells'}        | ${'under/neutral completed:1 over/under'}                                       | ${[halfBuy, allInSell, ethAllInBuy]}
        ${'ETH oversold once the SELL of BTC completed'} | ${'under/neutral completed:1 over/neutral completed:2 neutral/under'}           | ${[halfBuy, allInSell, ethHalfBuy]}
        ${'BTC oversold again while ETH is long'}        | ${'under/under completed:1 completed:2 over/neutral completed:3 under/neutral'} | ${[halfBuy, ethHalfBuy, allInSell, allInBuy]}
        ${'both overbought once both BUYs completed'}    | ${'under/under completed:1 completed:2 over/over'}                              | ${[halfBuy, ethHalfBuy, allInSell, ethAllInSell]}
      `('should size the BUY of each pair from the position of the other: $case', ({ steps, expected }) => {
        play(steps);
        expect(advices).toStrictEqual(expected);
      });

      // An outcome settles the position of its order's pair alone: the BUY of the other pair still pends, nothing to sell there yet. It
      // reports nothing of an execution, unless its step gives the asset left free after it ('errored:1:0.5', see playSteps).
      it.each`
        case                                     | steps                                                   | expected
        ${'the BUY of BTC completed'}            | ${'under/under completed:1 over/over'}                  | ${[halfBuy, ethHalfBuy, allInSell]}
        ${'the BUY of ETH completed'}            | ${'under/under completed:2 over/over'}                  | ${[halfBuy, ethHalfBuy, ethAllInSell]}
        ${'the BUY of BTC canceled'}             | ${'under/under canceled:1 neutral/neutral under/under'} | ${[halfBuy, ethHalfBuy, halfBuy]}
        ${'the BUY of ETH errored'}              | ${'under/under errored:2 neutral/neutral under/under'}  | ${[halfBuy, ethHalfBuy, ethHalfBuy]}
        ${'the BUY of BTC errored after a fill'} | ${'under/under errored:1:0.5 over/over'}                | ${[halfBuy, ethHalfBuy, allInSell]}
        ${'another order completed'}             | ${'under/under completed:unknown over/over'}            | ${[halfBuy, ethHalfBuy]}
      `('should leave the position of the other pair as it was: $case', ({ steps, expected }) => {
        play(steps);
        expect(advices).toStrictEqual(expected);
      });

      // The strategy reads the CCI of each pair by its pair (see indicatorsBySymbol): read by position, ETH's oversold CCI, given first,
      // would have bought BTC. A pair whose CCI is missing is skipped, as one not ready yet.
      it.each`
        case                   | results                                                                 | expected
        ${"ETH's CCI first"}   | ${{ 'ETH/USDT': [CCI_VALUES.under], 'BTC/USDT': [CCI_VALUES.neutral] }} | ${[ethHalfBuy]}
        ${"BTC's CCI missing"} | ${{ 'ETH/USDT': [CCI_VALUES.under] }}                                   | ${[ethHalfBuy]}
      `('should read the CCI of each pair by its pair: $case', ({ results, expected }) => {
        strategy.onTimeframeCandleAfterWarmup(candleParams(), ...indicatorArguments(results));
        expect(advices).toStrictEqual(expected);
      });
    });

    // Each pair counts the candles of its own trend, and a pair whose CCI is not ready yet is skipped alone
    it.each`
      case                                         | steps                                        | expected
      ${'ETH oversold on the candle BTC persists'} | ${'under/neutral under/under'}               | ${[halfBuy]}
      ${'ETH persisting a candle later'}           | ${'under/neutral under/under neutral/under'} | ${[halfBuy, ethHalfBuy]}
      ${'the CCI of BTC not ready yet'}            | ${'null/under null/under'}                   | ${[ethHalfBuy]}
    `('should follow the trend of each pair apart: $case', ({ steps, expected }) => {
      play(steps);
      expect(advices).toStrictEqual(expected);
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
      case                          | results                                            | expected
      ${'both ready'}               | ${{ 'BTC/USDT': [150.1234], 'ETH/USDT': [-42.5] }} | ${['debug [BTC/USDT] CCI: 150.12', 'debug [ETH/USDT] CCI: -42.50']}
      ${'the CCI of BTC not ready'} | ${{ 'BTC/USDT': [null], 'ETH/USDT': [-42.5] }}     | ${['debug [ETH/USDT] CCI: -42.50']}
      ${'the CCI of BTC missing'}   | ${{ 'ETH/USDT': [-42.5] }}                         | ${['debug [ETH/USDT] CCI: -42.50']}
    `('should log the CCI of each pair ready, prefixed with it: $case', ({ results, expected }) => {
      strategy.log(candleParams(), ...indicatorArguments(results));
      expect(loggedLines()).toEqual(expected);
    });

    // 50 % of 15 USDT is 7.5 USDT, which costs 7.125 USDT once 5 % is kept back for the fee: below the minimum cost of 10 USDT, the book
    // skips the BUY of BTC, and says so through the strategy's log. The strategy takes the BUY as placed: its trend is adviced, and its
    // next BUY waits for the next oversold trend of the pair, whose skip the book logs at debug level.
    describe('with a share of the currency below the minimum cost', () => {
      beforeEach(() => {
        portfolio = holdingUsdt(15);
        tools.marketData = new Map([
          ['BTC/USDT', { cost: { min: 10 } }],
          ['ETH/USDT', { cost: { min: 10 } }],
        ]);
      });

      it.each`
        case                     | steps                                                                        | expected
        ${'an oversold trend'}   | ${'under/neutral under/neutral under/neutral'}                               | ${['warn']}
        ${'two oversold trends'} | ${'under/neutral under/neutral neutral/neutral under/neutral under/neutral'} | ${['warn', 'debug']}
      `('should ask the book for one BUY of the pair per oversold trend, each skipped: $case', ({ steps, expected }) => {
        play(steps);
        expect(logs.filter(({ message }) => message.startsWith('[BTC/USDT] BUY skipped')).map(({ level }) => level)).toEqual(expected);
      });

      it('should create no order', () => {
        play('under/neutral under/neutral neutral/neutral under/neutral under/neutral');
        expect(advices).toEqual([]);
      });

      it('should buy on the next oversold trend once the currency allows it, the pair flat after the skip', () => {
        play('under/neutral under/neutral neutral/neutral');
        portfolio = holdingUsdt(100);
        play('under/neutral under/neutral');
        expect(advices).toStrictEqual([halfBuy]);
      });
    });
  });

  // The refusals of the schema are tested in @gekko/schemas: here, that the class declares it, the StrategyManager parsing the block with it
  it('should declare the strategy schema of @gekko/schemas', () => {
    expect(CCI.schema).toBe(cciStrategySchema);
  });
});
