import { BTC_ETH_TRADED_INFO, flatBucket, indicatorArguments, indicatorsAtInit } from '../helpers/positionBook/positionBook.mock';
import { LoggedLine, logsAtInit, OrderRecorder, playSteps } from '../helpers/positionTracker/positionTracker.mock';
import { StrategyOrder } from '@gekko/shared/models/advice.types';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { LogLevel } from '@gekko/shared/models/logLevel.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { InitParams, OnCandleEventParams } from '../strategy.types';
import { pick } from 'lodash-es';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demaStrategySchema } from '@gekko/schemas/strategies/dema.schema';
import { DEMA } from './dema.strategy';
import { DEMAStrategyParams } from './dema.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
// The DEMA and SMA results of each step of the scenarios played below: diff = SMA - DEMA against the thresholds 0.5 / -0.5. Null is
// what an indicator gives until it is ready: the DEMA, ready later than the SMA of its period, or the SMA.
const TRENDS = {
  up: { dema: 1, sma: 2 },
  down: { dema: 1, sma: 0 },
  neutral: { dema: 1, sma: 1 },
  demaNull: { dema: null, sma: 2 },
  smaNull: { dema: 2, sma: null },
} as const;
// The close of the candles of each pair, which its lines quote
const CLOSES: Record<TradingPair, number> = { [BTC]: 10, [ETH]: 20 };
// All-in, as the strategy creates them on one pair: without amount, the Trader sizes them from all the free currency (BUY) or asset (SELL)
const allInBuy = { type: 'STICKY', side: 'BUY', symbol: 'BTC/USDT' } satisfies StrategyOrder;
const allInSell = { type: 'STICKY', side: 'SELL', symbol: 'BTC/USDT' } satisfies StrategyOrder;
/** The STICKY BUY of `symbol` allocated that share of the free currency, in %, or all-in, without the key, when left out */
const buy = (symbol: TradingPair, allocation?: number): StrategyOrder =>
  allocation === undefined ? { type: 'STICKY', side: 'BUY', symbol } : { type: 'STICKY', side: 'BUY', symbol, allocation };
/** The all-in STICKY SELL of `symbol` */
const sell = (symbol: TradingPair): StrategyOrder => ({ type: 'STICKY', side: 'SELL', symbol });
// The lines of a candle on each pair, at the close of its candles (see CLOSES): its trend (a diff of 1, -1 or 0, see TRENDS), then the
// advice the position allows
const LINES = {
  btcUp: { level: 'debug', message: '[BTC/USDT] We are currently in uptrend: @ 10.00000000 (1.00000/1.00000)' },
  btcBuy: { level: 'info', message: '[BTC/USDT] Executing long advice due to detected uptrend: @ 10.00000000 (1.00000/1.00000)' },
  btcDown: { level: 'debug', message: '[BTC/USDT] We are currently in a downtrend: @ 10.00000000 (1.00000/-1.00000)' },
  btcSell: { level: 'info', message: '[BTC/USDT] Executing short advice due to detected downtrend: @ 10.00000000 (1.00000/-1.00000)' },
  btcNeutral: { level: 'debug', message: '[BTC/USDT] We are currently not in an up or down trend: @ 10.00000000 (1.00000/0.00000)' },
  ethUp: { level: 'debug', message: '[ETH/USDT] We are currently in uptrend: @ 20.00000000 (1.00000/1.00000)' },
  ethBuy: { level: 'info', message: '[ETH/USDT] Executing long advice due to detected uptrend: @ 20.00000000 (1.00000/1.00000)' },
  ethDown: { level: 'debug', message: '[ETH/USDT] We are currently in a downtrend: @ 20.00000000 (1.00000/-1.00000)' },
  ethSell: { level: 'info', message: '[ETH/USDT] Executing short advice due to detected downtrend: @ 20.00000000 (1.00000/-1.00000)' },
  ethNeutral: { level: 'debug', message: '[ETH/USDT] We are currently not in an up or down trend: @ 20.00000000 (1.00000/0.00000)' },
} satisfies Record<string, LoggedLine>;
// What the book logs when it skips a BUY of BTC/USDT: 50 % of the 10 USDT free is 5 USDT, which buys 4.75 USDT once 5 % is kept back
// for the fee, below the minimum cost of 10 USDT of the market. Its first skip is a warning, its next ones that line at debug level.
const BTC_BUY_SKIP =
  '[BTC/USDT] BUY skipped: 50 % of the 10 USDT free, 4.75 USDT once 5 % is kept back for the fee, is below the minimum cost of 10 USDT of the market: watch fewer pairs or fund the account';
const BTC_BUY_SKIPPED: LoggedLine = {
  level: 'warn',
  message: `${BTC_BUY_SKIP}; the next skips of this pair are logged at debug level until a BUY of it is placed`,
};
const BTC_BUY_SKIPPED_AGAIN: LoggedLine = { level: 'debug', message: BTC_BUY_SKIP };

describe('DEMA Strategy', () => {
  let strategy: DEMA;
  let orders: OrderRecorder;
  let advices: StrategyOrder[];
  let logs: LoggedLine[];
  let tools: any;
  let pairs: TradingPair[];
  let bucket: CandleBucket;
  let portfolio: Portfolio;
  let addIndicator: any;

  /** A new strategy, its init played on a bucket of the pairs `watched`, in their order (watch.assets); `logs` keeps what it logs next */
  const initOn = (...watched: TradingPair[]) => {
    pairs = watched;
    bucket = flatBucket(pick(CLOSES, watched));
    strategy = new DEMA();
    strategy.init({ candle: bucket, portfolio, tools, addIndicator } as unknown as InitParams<DEMAStrategyParams>);
    logs = [];
  };
  /** The params of a candle hook, on the bucket of the pairs watched unless another `candle` is given */
  const hookParams = (candle = bucket) => ({ candle, portfolio, tools }) as unknown as OnCandleEventParams<DEMAStrategyParams>;
  /**
   * Plays the steps (see playSteps): a candle gives each pair watched the DEMA and SMA results of a trend (see TRENDS), in the order of
   * the pairs, separated by a slash ('up/neutral' is an uptrend on BTC/USDT and no trend on ETH/USDT)
   */
  const play = (steps: string) =>
    playSteps(steps, strategy, orders, step => {
      const trends = step.split('/');
      const isCandle = trends.length === pairs.length && trends.every(trend => trend in TRENDS);
      if (!isCandle) throw new Error(`No step named ${step}, in "${steps}"`);
      const results = pairs.map((pair, index) => {
        const { dema, sma } = TRENDS[trends[index] as keyof typeof TRENDS];
        return [pair, [dema, sma]] as const;
      });
      strategy.onTimeframeCandleAfterWarmup(hookParams(), ...indicatorArguments(Object.fromEntries(results)));
    });
  const sides = () => advices.map(({ side }) => side);

  beforeEach(() => {
    orders = new OrderRecorder();
    advices = orders.advices;
    logs = [];
    addIndicator = vi.fn();
    portfolio = new Map();

    tools = {
      strategyParams: { period: 14, thresholds: { up: 0.5, down: -0.5 } },
      marketData: new Map(),
      createOrder: orders.createOrder,
      cancelOrder: vi.fn(),
      log: vi.fn((level: LogLevel, message: string) => logs.push({ level, message })),
    };

    initOn(BTC);
  });

  describe('init', () => {
    it.each`
      case           | watched       | expected
      ${'one pair'}  | ${[BTC]}      | ${[['DEMA', BTC, { period: 14 }], ['SMA', BTC, { period: 14 }]]}
      ${'two pairs'} | ${[BTC, ETH]} | ${[['DEMA', BTC, { period: 14 }], ['SMA', BTC, { period: 14 }], ['DEMA', ETH, { period: 14 }], ['SMA', ETH, { period: 14 }]]}
    `('should add a DEMA then an SMA of the strategy period on each pair, pair by pair: $case', ({ watched, expected }) => {
      expect(indicatorsAtInit(new DEMA(), watched, tools.strategyParams)).toEqual(expected);
    });

    // The bucket holds a candle of every watched pair, in the order of watch.assets: the strategy trades them all, ignoring none
    it.each`
      case           | watched       | expected
      ${'one pair'}  | ${[BTC]}      | ${[]}
      ${'two pairs'} | ${[BTC, ETH]} | ${[BTC_ETH_TRADED_INFO]}
    `('should warn of no pair at init, and name the pairs it trades when there are several: $case', ({ watched, expected }) => {
      expect(logsAtInit(new DEMA(), watched, tools.strategyParams)).toEqual(expected);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // An uptrend, which buys once init has tracked the pairs
    it('should do nothing before init has tracked the pairs', () => {
      strategy = new DEMA();
      play('up');
      expect({ advices, logs }).toEqual({ advices: [], logs: [] });
    });

    it('should do nothing if candle for the pair is not found', () => {
      strategy.onTimeframeCandleAfterWarmup(hookParams(new Map()), { results: 1, symbol: 'BTC/USDT' }, { results: 2, symbol: 'BTC/USDT' });
      expect(advices).toHaveLength(0);
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
      strategy.onTimeframeCandleAfterWarmup(
        hookParams(),
        { results: demaRes, symbol: 'BTC/USDT' },
        { results: smaRes, symbol: 'BTC/USDT' },
      );
      expect({ advices, logs }).toEqual({ advices: [], logs: [] });
    });

    // Unskipped, a null SMA would be subtracted as 0, a downtrend that sells, and a null DEMA would throw as the log message is built
    it.each`
      case                        | steps                       | expectedSides
      ${'a null SMA, when long'}  | ${'up completed:1 smaNull'} | ${['BUY']}
      ${'a null DEMA, when flat'} | ${'demaNull'}               | ${[]}
    `('should skip a candle whose DEMA or SMA is null, as one not ready yet: $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it.each`
      case                                 | steps                    | expected
      ${'a BUY on an uptrend when flat'}   | ${'up'}                  | ${[allInBuy]}
      ${'a SELL on a downtrend when long'} | ${'up completed:1 down'} | ${[allInBuy, allInSell]}
    `('should emit an all-in STICKY order: $case', ({ steps, expected }) => {
      play(steps);
      expect(advices).toStrictEqual(expected);
    });

    // On one pair the book never skips: the exchange refuses a BUY of too little currency, which is how the strategy learns of a holding
    // present at start-up
    it('should send its all-in BUY on one pair, below the minimum cost of the market too', () => {
      portfolio = new Map([['USDT', { free: 10, used: 0, total: 10 }]]);
      tools.marketData = new Map([[BTC, { cost: { min: 10 } }]]);
      play('up');
      expect(advices).toStrictEqual([allInBuy]);
    });

    it.each`
      case                                     | steps                                      | expectedSides
      ${'an uptrend that continues'}           | ${'up up up'}                              | ${['BUY']}
      ${'an uptrend after a neutral pause'}    | ${'up completed:1 neutral up'}             | ${['BUY']}
      ${'a downtrend when flat'}               | ${'down down'}                             | ${[]}
      ${'a downtrend while the BUY pends'}     | ${'up down down'}                          | ${['BUY']}
      ${'a downtrend once the BUY filled'}     | ${'up completed:1 down down'}              | ${['BUY', 'SELL']}
      ${'a BUY that fills during a downtrend'} | ${'up down completed:1 down'}              | ${['BUY', 'SELL']}
      ${'an uptrend while the SELL pends'}     | ${'up completed:1 down up up'}             | ${['BUY', 'SELL']}
      ${'a downtrend while the SELL pends'}    | ${'up completed:1 down up down'}           | ${['BUY', 'SELL']}
      ${'an uptrend once the SELL filled'}     | ${'up completed:1 down completed:2 up'}    | ${['BUY', 'SELL', 'BUY']}
      ${'a SELL that fills during an uptrend'} | ${'up completed:1 down up completed:2 up'} | ${['BUY', 'SELL', 'BUY']}
    `('should advise once per position change on $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });

    it.each`
      case                                | steps                    | expected
      ${'an uptrend when flat'}           | ${'up'}                  | ${[LINES.btcUp, LINES.btcBuy]}
      ${'an uptrend while the BUY pends'} | ${'up up'}               | ${[LINES.btcUp, LINES.btcBuy, LINES.btcUp]}
      ${'a downtrend when flat'}          | ${'down'}                | ${[LINES.btcDown]}
      ${'a downtrend when long'}          | ${'up completed:1 down'} | ${[LINES.btcUp, LINES.btcBuy, LINES.btcDown, LINES.btcSell]}
      ${'not an up or down trend'}        | ${'neutral'}             | ${[LINES.btcNeutral]}
    `('should log the trend of each candle and its advice, prefixed with the pair: $case', ({ steps, expected }) => {
      play(steps);
      expect(logs).toEqual(expected);
    });
  });

  describe('order outcomes', () => {
    // An outcome reports nothing of an execution, unless its step gives the BTC left free after it ('errored:2:0', see playSteps)
    it.each`
      case                                                       | steps                                            | expectedSides
      ${'a BUY completed: long, it sells'}                       | ${'up completed:1 down'}                         | ${['BUY', 'SELL']}
      ${'a BUY canceled: flat, it buys on the next uptrend'}     | ${'up canceled:1 up neutral up down up'}         | ${['BUY', 'BUY']}
      ${'a BUY errored: flat, it buys on the next uptrend'}      | ${'up errored:1 up neutral up down up'}          | ${['BUY', 'BUY']}
      ${'a SELL completed: flat, it buys again'}                 | ${'up completed:1 down completed:2 up'}          | ${['BUY', 'SELL', 'BUY']}
      ${'a SELL canceled: long, it sells on the next downtrend'} | ${'up completed:1 down canceled:2 down up down'} | ${['BUY', 'SELL', 'SELL']}
      ${'a SELL errored: long, it sells on the next downtrend'}  | ${'up completed:1 down errored:2 down up down'}  | ${['BUY', 'SELL', 'SELL']}
      ${'a SELL errored, all sold: flat, it buys again'}         | ${'up completed:1 down errored:2:0 up'}          | ${['BUY', 'SELL', 'BUY']}
      ${'another order completed: still pending'}                | ${'up completed:unknown down up'}                | ${['BUY']}
      ${'another order canceled: still pending'}                 | ${'up canceled:unknown down up'}                 | ${['BUY']}
      ${'another order errored: still pending'}                  | ${'up errored:unknown down up'}                  | ${['BUY']}
    `('should track $case', ({ steps, expectedSides }) => {
      play(steps);
      expect(sides()).toEqual(expectedSides);
    });
  });

  describe('log', () => {
    it.each`
      smaRes       | demaRes      | expectedLogsLength
      ${undefined} | ${undefined} | ${0}
      ${1}         | ${undefined} | ${0}
      ${undefined} | ${2}         | ${0}
      ${null}      | ${2}         | ${0}
      ${1}         | ${null}      | ${0}
      ${NaN}       | ${2}         | ${0}
      ${1}         | ${-Infinity} | ${0}
    `('should not log when results are missing (sma: $smaRes, dema: $demaRes)', ({ smaRes, demaRes, expectedLogsLength }) => {
      strategy.log(hookParams(), { results: demaRes, symbol: 'BTC/USDT' }, { results: smaRes, symbol: 'BTC/USDT' });
      expect(logs).toHaveLength(expectedLogsLength);
    });

    it('should log DEMA and SMA properties', () => {
      strategy.log(hookParams(), { results: 1.23456, symbol: 'BTC/USDT' }, { results: 2.34567, symbol: 'BTC/USDT' });
      expect(logs).toContainEqual({
        level: 'debug',
        message: '[BTC/USDT] Calculated DEMA and SMA properties for candle: DEMA: 1.23456 SMA: 2.34567',
      });
    });
  });

  describe('on two pairs', () => {
    const btcProperties = {
      level: 'debug',
      message: '[BTC/USDT] Calculated DEMA and SMA properties for candle: DEMA: 1.23456 SMA: 2.34567',
    };
    const ethProperties = {
      level: 'debug',
      message: '[ETH/USDT] Calculated DEMA and SMA properties for candle: DEMA: 3.45678 SMA: 4.56789',
    };

    beforeEach(() => {
      initOn(BTC, ETH);
    });

    // Each BUY takes an equal share of the free currency among the pairs not long, the pair buying and a pair whose BUY is pending
    // included: 50 % while the other pair is not long, all of it, without an allocation, once that pair is (its SELL pending too)
    it.each`
      case                                                        | steps                                                           | expected
      ${'both flat, on one candle'}                               | ${'up/up'}                                                      | ${[buy(BTC, 50), buy(ETH, 50)]}
      ${'ETH while the BUY of BTC pends'}                         | ${'up/neutral neutral/up'}                                      | ${[buy(BTC, 50), buy(ETH, 50)]}
      ${'ETH once BTC is long'}                                   | ${'up/neutral completed:1 neutral/up'}                          | ${[buy(BTC, 50), buy(ETH)]}
      ${'ETH on the candle BTC sells'}                            | ${'up/neutral completed:1 down/up'}                             | ${[buy(BTC, 50), sell(BTC), buy(ETH)]}
      ${'ETH once BTC has sold'}                                  | ${'up/neutral completed:1 down/neutral completed:2 neutral/up'} | ${[buy(BTC, 50), sell(BTC), buy(ETH, 50)]}
      ${'ETH once the BUY of BTC was canceled, no fill reported'} | ${'up/neutral canceled:1 neutral/up'}                           | ${[buy(BTC, 50), buy(ETH, 50)]}
      ${'ETH once the BUY of BTC errored, 1 BTC free after it'}   | ${'up/neutral errored:1:1 neutral/up'}                          | ${[buy(BTC, 50), buy(ETH)]}
    `('should allocate each BUY its share of the currency: $case', ({ steps, expected }) => {
      play(steps);
      expect(advices).toStrictEqual(expected);
    });

    // The outcome of an order settles the position of its own pair, and leaves the other's as it was
    it.each`
      case                                                            | steps                                                  | expected
      ${'BTC long sells, ETH not while its BUY pends'}                | ${'up/up completed:1 down/down'}                       | ${[buy(BTC, 50), buy(ETH, 50), sell(BTC)]}
      ${'ETH long sells, BTC not while its BUY pends'}                | ${'up/up completed:2 down/down'}                       | ${[buy(BTC, 50), buy(ETH, 50), sell(ETH)]}
      ${'both long, both sell'}                                       | ${'up/up completed:1 completed:2 down/down'}           | ${[buy(BTC, 50), buy(ETH, 50), sell(BTC), sell(ETH)]}
      ${'ETH canceled: BTC long sells, ETH buys on its next uptrend'} | ${'up/up completed:1 canceled:2 down/down neutral/up'} | ${[buy(BTC, 50), buy(ETH, 50), sell(BTC), buy(ETH)]}
      ${'BTC errored: ETH long sells, BTC buys on its next uptrend'}  | ${'up/up errored:1 completed:2 down/down up/neutral'}  | ${[buy(BTC, 50), buy(ETH, 50), sell(ETH), buy(BTC)]}
      ${'another order completed: both BUYs still pending'}           | ${'up/up completed:unknown down/down'}                 | ${[buy(BTC, 50), buy(ETH, 50)]}
    `('should keep a position per pair: $case', ({ steps, expected }) => {
      play(steps);
      expect(advices).toStrictEqual(expected);
    });

    it.each`
      case                                                     | steps                                        | expected
      ${'an uptrend on BTC and a downtrend on ETH, both flat'} | ${'up/down'}                                 | ${[LINES.btcUp, LINES.btcBuy, LINES.ethDown]}
      ${'no trend on BTC and an uptrend on ETH'}               | ${'neutral/up'}                              | ${[LINES.btcNeutral, LINES.ethUp, LINES.ethBuy]}
      ${'a downtrend on both, both long'}                      | ${'up/up completed:1 completed:2 down/down'} | ${[LINES.btcUp, LINES.btcBuy, LINES.ethUp, LINES.ethBuy, LINES.btcDown, LINES.btcSell, LINES.ethDown, LINES.ethSell]}
    `('should log the trend and the advice of each pair, prefixed with it, in the order of the pairs: $case', ({ steps, expected }) => {
      play(steps);
      expect(logs).toEqual(expected);
    });

    // A pair skipped as on one pair: in a run, every bucket holds every pair, and every hook gets the indicators of each
    it.each`
      case                                | candle                       | indicators
      ${'without the candle of BTC'}      | ${flatBucket({ [ETH]: 20 })} | ${indicatorArguments({ [BTC]: [1, 2], [ETH]: [1, 2] })}
      ${'without the indicators of BTC'}  | ${flatBucket(CLOSES)}        | ${indicatorArguments({ [ETH]: [1, 2] })}
      ${'with the DEMA of BTC not ready'} | ${flatBucket(CLOSES)}        | ${indicatorArguments({ [BTC]: [null, 2], [ETH]: [1, 2] })}
    `('should skip a pair it cannot read and buy the other its share: $case', ({ candle, indicators }) => {
      strategy.onTimeframeCandleAfterWarmup(hookParams(candle), ...indicators);
      expect(advices).toStrictEqual([buy(ETH, 50)]);
    });

    // 10 USDT free, and a minimum cost of 10 USDT on the market of BTC/USDT alone: the book skips its BUY, which spends its uptrend all
    // the same, as a refused BUY does. The strategy logs no advice for it, the book's line its only trace: logged before the BUY, the
    // advice told of an order that was never sent. Every line is asserted, debug included: the book's debug line is what shows a BUY
    // asked for again.
    it.each`
      case                                                        | steps                                   | expected
      ${'the next candles of its uptrend advise nothing'}         | ${'up/neutral up/neutral'}              | ${{ orders: [], lines: [LINES.btcUp, BTC_BUY_SKIPPED, LINES.ethNeutral, LINES.btcUp, LINES.ethNeutral] }}
      ${'the next uptrend advises again, skipped at debug level'} | ${'up/neutral down/neutral up/neutral'} | ${{ orders: [], lines: [LINES.btcUp, BTC_BUY_SKIPPED, LINES.ethNeutral, LINES.btcDown, LINES.ethNeutral, LINES.btcUp, BTC_BUY_SKIPPED_AGAIN, LINES.ethNeutral] }}
      ${'ETH buys its share beside it'}                           | ${'up/up'}                              | ${{ orders: [buy(ETH, 50)], lines: [LINES.btcUp, BTC_BUY_SKIPPED, LINES.ethUp, LINES.ethBuy] }}
    `('should take a BUY the book skips as advised, nothing sent and no advice logged: $case', ({ steps, expected }) => {
      portfolio = new Map([['USDT', { free: 10, used: 0, total: 10 }]]);
      tools.marketData = new Map([[BTC, { cost: { min: 10 } }]]);
      play(steps);
      expect({ orders: advices, lines: logs }).toStrictEqual(expected);
    });

    it.each`
      case                               | indicators                                                                      | expected
      ${'both ready'}                    | ${indicatorArguments({ [BTC]: [1.23456, 2.34567], [ETH]: [3.45678, 4.56789] })} | ${[btcProperties, ethProperties]}
      ${'the DEMA of BTC not ready'}     | ${indicatorArguments({ [BTC]: [null, 2.34567], [ETH]: [3.45678, 4.56789] })}    | ${[ethProperties]}
      ${'without the indicators of BTC'} | ${indicatorArguments({ [ETH]: [3.45678, 4.56789] })}                            | ${[ethProperties]}
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
