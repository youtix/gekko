import { PERFORMANCE_REPORT_EVENT, ROUNDTRIP_COMPLETED_EVENT } from '@constants/event.const';
import { CandleBucket, OrderCanceledEvent, OrderCompletedEvent, RoundTrip } from '@models/event.types';
import { Portfolio } from '@models/portfolio.types';
import { config } from '@services/configuration/configuration';
import { debug, info, warning } from '@services/logger';
import * as statsUtils from '@utils/finance/stats.utils';
import { stdev } from '@utils/math/math.utils';
import { calculatePairEquity, getAssetBalance } from '@utils/portfolio/portfolio.utils';
import { beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { TradingReport } from './roundTrip.types';
import { RoundTripAnalyzer } from './roundTripAnalyzer';
import { EMPTY_TRADING_REPORT, PLUGIN_NAME } from './roundTripAnalyzer.const';
import { logFinalize, logRoundtrip } from './roundTripAnalyzer.utils';

// Mocks
vi.mock('@services/logger');
vi.mock('@utils/finance/stats.utils');
// stdev only, which the tests drive: the formatters of the log lines read isFiniteNumber, and the decimal helpers stay actual
vi.mock('@utils/math/math.utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@utils/math/math.utils')>()),
  stdev: vi.fn(),
}));
vi.mock('@utils/math/round.utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@utils/math/round.utils')>()),
  round: (val: number) => val,
}));
// The two the tests drive; isFetchedPortfolio stays actual, an automock would read every portfolio as one the Trader never fetched
vi.mock('@utils/portfolio/portfolio.utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@utils/portfolio/portfolio.utils')>()),
  calculatePairEquity: vi.fn(),
  getAssetBalance: vi.fn(),
}));
vi.mock('./roundTripAnalyzer.utils');

// Mock Configuration
vi.mock('@services/configuration/configuration', () => {
  const Configuration = vi.fn(function () {
    return {
      getWatch: vi.fn(() => ({
        pairs: [{ symbol: 'BTC/USDT', timeframe: '1m' }],
        assets: ['BTC'],
        currency: 'USDT',
        timeframe: '1m',
        warmup: { candleCount: 100, tickrate: 1000 },
        mode: 'realtime',
        tickrate: 1000,
      })),
      getStrategy: vi.fn(() => ({})),
      showLogo: vi.fn(),
      getPlugins: vi.fn(),
      getStorage: vi.fn(),
      getExchange: vi.fn(),
    };
  });
  return { config: new Configuration() };
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/**
 * The portfolio the orders below carry. What it holds does not matter, portfolio.utils is mocked, but it is not empty: the Trader sends
 * an empty one only before it has fetched any (see isFetchedPortfolio).
 */
const PORTFOLIO: Portfolio = new Map([['BTC', { free: 1, used: 0, total: 1 }]]);
/** A completed order executed at the given minute, with its fee in currency (undefined when the test leaves it out) */
const completed = (side: 'BUY' | 'SELL', minute: number, price: number, amount: number, fee?: number) =>
  ({
    order: { id: `${side}-${minute}`, side, price, amount, fee, orderExecutionDate: minute * MINUTE },
    exchange: { portfolio: PORTFOLIO },
  }) as any;
const buy = (minute: number, price: number, amount: number, fee?: number) => completed('BUY', minute, price, amount, fee);
const sell = (minute: number, price: number, amount: number) => completed('SELL', minute, price, amount);
/** An order of 10 canceled at the given minute after filling that amount, with the price the strategy asked for, if any */
const canceled = (side: 'BUY' | 'SELL', minute: number, filled: number, price?: number) =>
  ({
    order: { id: `${side}-${minute}`, side, price, amount: 10, filled, remaining: 10 - filled, orderCancelationDate: minute * MINUTE },
    exchange: { portfolio: PORTFOLIO },
  }) as any;
/** A BUY of 10 at 100 that ended in error at the given minute */
const errored = (minute: number) =>
  ({
    order: { id: `BUY-${minute}`, side: 'BUY', price: 100, amount: 10, reason: 'refused', orderErrorDate: minute * MINUTE },
    exchange: { portfolio: PORTFOLIO },
  }) as any;
/** What the account holds of the asset after each SELL that reads it: only a SELL of an open round trip does */
const holdAfterSells = (...amounts: number[]) =>
  amounts.forEach(total => vi.mocked(getAssetBalance).mockReturnValueOnce({ total, free: total, used: 0 }));
const OPEN_ROUND_TRIP = { entryAt: 1000, entryPrice: 100, entryEquity: 1000, bought: 1, sold: 0, exitPrice: 0, maxAdverseExcursion: 0 };
/** The bucket of a minute, or the timeframe bucket of a 1m timeframe, its candle closing at the given price */
const bucketAt = (minute: number, close: number) =>
  new Map([['BTC/USDT', { start: minute * MINUTE, open: close, high: close, low: close, close, volume: 1 }]]) as CandleBucket;

describe('RoundTripAnalyzer', () => {
  let analyzer: RoundTripAnalyzer;
  const mockConfig = { name: PLUGIN_NAME, riskFreeReturn: 2, enableConsoleTable: true };

  beforeEach(() => {
    (calculatePairEquity as any).mockReturnValue({ total: 1000, free: 500, used: 500 });
    (getAssetBalance as any).mockReturnValue({ total: 1.5, free: 1.5, used: 0 });
    (stdev as any).mockReturnValue(0.05);

    Object.keys(statsUtils).forEach(key => {
      // @ts-expect-error iterating over all exports
      if (typeof statsUtils[key] === 'function' && 'mockReturnValue' in statsUtils[key]) {
        // @ts-expect-error mocking dynamically
        (statsUtils[key] as any).mockReturnValue(0);
      }
    });

    vi.mocked(warning).mockClear();
    vi.mocked(logFinalize).mockClear();
    vi.mocked(logRoundtrip).mockClear();

    analyzer = new RoundTripAnalyzer(mockConfig);
  });

  describe('constructor', () => {
    it.each`
      property                | expected
      ${'pluginName'}         | ${PLUGIN_NAME}
      ${'riskFreeReturn'}     | ${2}
      ${'enableConsoleTable'} | ${true}
      ${'symbol'}             | ${'BTC/USDT'}
      ${'asset'}              | ${'BTC'}
    `('should initialize with correct default $property as $expected', ({ property, expected }) => {
      expect((analyzer as any)[property]).toBe(expected);
    });

    it('should fall back to the risk-free return of 5 % the schema defaults to when the configuration has none', () => {
      expect(new RoundTripAnalyzer({ name: PLUGIN_NAME, enableConsoleTable: false } as any)['riskFreeReturn']).toBe(5);
    });

    it('should throw error if multiple pairs are configured', () => {
      vi.spyOn(config, 'getWatch').mockReturnValueOnce({
        pairs: [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }] as any,
        assets: ['BTC', 'ETH'],
        currency: 'USDT',
        timeframe: '1m',
        warmup: { candleCount: 100, tickrate: 1000 },
        mode: 'realtime',
        tickrate: 1000,
      });

      expect(() => new RoundTripAnalyzer(mockConfig)).toThrow('RoundTripAnalyzer can only be used with a single pair');
    });
  });

  describe('onPortfolioChange', () => {
    it('should call calculatePairEquity', () => {
      const portfolio = { id: 'test', balance: 1000, timestamp: 1000, assets: [] } as any;
      analyzer.onPortfolioChange([portfolio]);
      expect(calculatePairEquity).toHaveBeenCalledWith(portfolio, 'BTC/USDT', 0);
    });

    it('should update currentEquity', () => {
      const portfolio = { id: 'test', balance: 1000, timestamp: 1000, assets: [] } as any;
      analyzer.onPortfolioChange([portfolio]);
      expect(analyzer['currentEquity']).toBe(1000);
    });

    it('should update currentEquity for subsequent events', () => {
      const p1 = { id: '1' } as any;
      const p2 = { id: '2' } as any;
      (calculatePairEquity as any).mockReturnValueOnce({ total: 1000 }).mockReturnValueOnce({ total: 2000 });

      analyzer.onPortfolioChange([p1]);
      analyzer.onPortfolioChange([p2]);

      expect(analyzer['currentEquity']).toBe(2000);
    });
  });

  describe('onStrategyWarmupCompleted', () => {
    it('should log warning if candle is missing', () => {
      const bucket = new Map() as CandleBucket;
      analyzer.onStrategyWarmupCompleted([bucket]);
      expect(warning).toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining('Missing candle'));
    });

    it('should not set warmupCompleted if candle is missing', () => {
      const bucket = new Map() as CandleBucket;
      analyzer.onStrategyWarmupCompleted([bucket]);
      expect(analyzer['warmupCompleted']).toBe(false);
    });

    it('should set warmupCompleted to true if candle is found', () => {
      const candle = { start: 1000, close: 50000 } as any;
      const bucket = new Map([['BTC/USDT', candle]]) as CandleBucket;
      analyzer.onStrategyWarmupCompleted([bucket]);
      expect(analyzer['warmupCompleted']).toBe(true);
    });

    it.each`
      property
      ${'startPrice'}
      ${'endPrice'}
    `('should set $property to the close of the candle if candle is found', ({ property }) => {
      const candle = { start: 1000, close: 50000 } as any;
      const bucket = new Map([['BTC/USDT', candle]]) as CandleBucket;
      analyzer.onStrategyWarmupCompleted([bucket]);
      expect(analyzer[property as 'startPrice' | 'endPrice']).toBe(50000);
    });
  });

  describe('trading during the warmup', () => {
    // The bucket of minute 9 completes the warmup at a price of 110: the period starts at minute 10. The mocked calculatePairEquity
    // values any portfolio as 1 BTC (see beforeEach): the start equity is 110 too.
    const completeWarmup = () => {
      analyzer['processOneMinuteBucket'](bucketAt(9, 110));
      analyzer.onStrategyWarmupCompleted([bucketAt(9, 110)]);
    };

    beforeEach(() => {
      vi.mocked(calculatePairEquity).mockImplementation((_portfolio, _pair, price) => ({ total: price, free: price, used: 0 }));
    });

    describe('when a round trip ended during the warmup', () => {
      beforeEach(() => {
        holdAfterSells(0);
        analyzer.onOrderCompleted([buy(1, 100, 1), sell(5, 120, 1)]);
        completeWarmup();
      });

      it('should drop it from the round trips of the report', () => {
        expect(analyzer['roundTrips']).toEqual([]);
      });

      it('should count none of its trades', () => {
        expect(analyzer['tradeCount']).toBe(0);
      });

      it('should count none of its time as exposed', () => {
        analyzer['processOneMinuteBucket'](bucketAt(10, 110));
        expect(analyzer['calculateExposureMs']()).toBe(0);
      });

      it('should log that the trading of the warmup is left out of the report', () => {
        expect(info).toHaveBeenCalledWith(
          'roundtrip analyzer',
          'The report measures the period from 1970-01-01T00:10:00.000Z on: the 2 trade(s) of the warmup, and the 1 round trip(s) they closed, are left out.',
        );
      });

      it('should go on numbering the round trips of the period after it', () => {
        holdAfterSells(0);
        analyzer.onOrderCompleted([buy(11, 110, 1), sell(13, 120, 1)]);
        expect(analyzer['roundTrips'][0].id).toBe(1);
      });
    });

    describe('when a round trip opened during the warmup is still open', () => {
      // Two BTC bought at 100, one sold at 120, during the warmup
      beforeEach(() => {
        holdAfterSells(1);
        analyzer.onOrderCompleted([buy(1, 100, 2, 1), sell(5, 120, 1)]);
        completeWarmup();
      });

      it.each`
        field                    | expected       | description
        ${'entryAt'}             | ${10 * MINUTE} | ${'the start of the period'}
        ${'entryPrice'}          | ${110}         | ${'the start price'}
        ${'entryEquity'}         | ${110}         | ${'the start equity'}
        ${'bought'}              | ${2}           | ${'what its BUYs bought, which the rule that ends it needs'}
        ${'sold'}                | ${1}           | ${'what its SELLs sold'}
        ${'exitPrice'}           | ${120}         | ${'the mean price of its SELLs so far'}
        ${'maxAdverseExcursion'} | ${0}           | ${'none, tracked after the warmup only'}
      `('should rebase it at the start of the period, with $field $expected: $description', ({ field, expected }) => {
        expect(analyzer['openRoundTrip']?.[field as keyof typeof OPEN_ROUND_TRIP]).toBe(expected);
      });

      it('should log that its round trip counts from the start of the period', () => {
        expect(info).toHaveBeenCalledWith(
          'roundtrip analyzer',
          'Position opened during the warmup at 100 USDT, on 1970-01-01T00:01:00.000Z: its round trip counts from the start of the period, at the start price of 110 USDT and with the start equity of 110 USDT.',
        );
      });

      it('should count none of the trades of the warmup', () => {
        expect(analyzer['tradeCount']).toBe(0);
      });

      describe('then ended by a SELL of the period, at 125', () => {
        beforeEach(() => {
          holdAfterSells(0);
          analyzer.onOrderCompleted([sell(12, 125, 1)]);
        });

        it.each`
          field            | expected       | description
          ${'entryAt'}     | ${10 * MINUTE} | ${'the start of the period'}
          ${'entryEquity'} | ${110}         | ${'the start equity'}
          ${'pnl'}         | ${15}          | ${'the pair equity after the SELL less the start equity'}
          ${'duration'}    | ${2 * MINUTE}  | ${'from the start of the period to the SELL'}
        `('should close its round trip with $field $expected: $description', ({ field, expected }) => {
          expect(analyzer['roundTrips'][0][field as keyof RoundTrip]).toBe(expected);
        });

        it('should count that SELL, the first trade of the period, which does not sell a position held before it', () => {
          expect(analyzer['tradeCount']).toBe(1);
        });
      });
    });

    describe('when flat at the end of the warmup', () => {
      beforeEach(() => {
        completeWarmup();
        analyzer.onOrderCompleted([sell(12, 125, 1)]);
      });

      it('should skip a SELL of the period before any trade, which sells a position held before it', () => {
        expect(analyzer['tradeCount']).toBe(0);
      });

      it('should log nothing about a warmup without any trade', () => {
        expect(info).not.toHaveBeenCalled();
      });
    });
  });

  describe('period', () => {
    // On a 1h timeframe, the bucket of minute 119 completes the warmup: it closes, at minute 120, the hourly candle that started at
    // minute 60. The events come in the order the pipeline delivers them (see PluginsStream).
    const COMPLETING_MINUTE = 119;
    const CANDLE_CLOSE = 120 * MINUTE;
    const hourlyCandleBucket = () =>
      new Map([['BTC/USDT', { start: 60 * MINUTE, open: 100, high: 100, low: 100, close: 100, volume: 60 }]]) as CandleBucket;
    /** The report of a run that goes on for that many buckets after the one that completed the warmup */
    const reportAfter = (buckets: number) => {
      analyzer.onPortfolioChange([new Map()]);
      analyzer['processOneMinuteBucket'](bucketAt(COMPLETING_MINUTE, 100));
      analyzer.onStrategyWarmupCompleted([hourlyCandleBucket()]);
      for (let minute = COMPLETING_MINUTE + 1; minute <= COMPLETING_MINUTE + buckets; minute++)
        analyzer['processOneMinuteBucket'](bucketAt(minute, 100));
      return analyzer['calculateReportStatistics']();
    };

    it.each`
      buckets | run
      ${0}    | ${'ends with the warmup'}
      ${1}    | ${'goes on for a minute'}
      ${60}   | ${'goes on for an hour'}
    `('should start at the close of the candle that completed the warmup, not at its start, when the run $run', ({ buckets }) => {
      expect(reportAfter(buckets).periodStartAt).toBe(CANDLE_CLOSE);
    });

    it.each`
      buckets | duration       | run
      ${0}    | ${0}           | ${'ends with the warmup'}
      ${1}    | ${MINUTE}      | ${'goes on for a minute'}
      ${60}   | ${60 * MINUTE} | ${'goes on for an hour'}
    `('should last $duration ms when the run $run', ({ buckets, duration }) => {
      const { periodStartAt, periodEndAt } = reportAfter(buckets);
      expect(periodEndAt - periodStartAt).toBe(duration);
    });

    it.each`
      buckets | duration
      ${1}    | ${'1 minute'}
      ${60}   | ${'1 hour'}
    `('should report a duration of $duration when the run goes on for that long after the warmup', ({ buckets, duration }) => {
      expect(reportAfter(buckets).formattedDuration).toBe(duration);
    });

    it.each`
      buckets | horizonEnd                      | horizon
      ${60}   | ${CANDLE_CLOSE + DAY}           | ${'a day from the start of the period, an hour long'}
      ${1500} | ${CANDLE_CLOSE + 1500 * MINUTE} | ${'the period, 25 hours long'}
    `('should compute the years that annualize the return and the ratios over $horizon', ({ buckets, horizonEnd }) => {
      reportAfter(buckets);
      expect(statsUtils.calculateElapsedYears).toHaveBeenCalledWith(CANDLE_CLOSE, horizonEnd);
    });

    it.each`
      ratio
      ${'calculateSharpeRatio'}
      ${'calculateSortinoRatio'}
    `('should annualize the ratio of $ratio over the years that annualize the return', ({ ratio }) => {
      // A day in years: the horizon of a run of an hour
      vi.mocked(statsUtils.calculateElapsedYears).mockReturnValue(1 / 365);
      reportAfter(60);
      const horizonYears = vi.mocked(statsUtils.calculateAnnualizedReturnPct).mock.lastCall?.[1];
      expect(vi.mocked(statsUtils[ratio as 'calculateSharpeRatio']).mock.lastCall?.[0].elapsedYears).toBe(horizonYears);
    });

    it.each`
      buckets | duration
      ${1}    | ${MINUTE}
      ${60}   | ${60 * MINUTE}
    `('should measure the exposure over the $duration ms of the period', ({ buckets, duration }) => {
      reportAfter(buckets);
      expect(statsUtils.calculateExposurePct).toHaveBeenCalledWith(0, duration);
    });

    describe('when the run ends with the bucket that completed the warmup', () => {
      it('should not divide the exposure by a period of 0 ms', () => {
        reportAfter(0);
        expect(statsUtils.calculateExposurePct).not.toHaveBeenCalled();
      });

      it('should report an exposure of 0', () => {
        vi.mocked(statsUtils.calculateExposurePct).mockReturnValue(50);
        expect(reportAfter(0).exposurePct).toBe(0);
      });
    });
  });

  describe('start equity', () => {
    // Told apart by identity: the mocked calculatePairEquity values any portfolio as 1 BTC and nothing else (see beforeEach)
    const HELD: Portfolio = new Map();
    const LATER: Portfolio = new Map();

    const runMinute = (minute: number, close: number) => analyzer['processOneMinuteBucket'](bucketAt(minute, close));
    const completeWarmup = (minute: number, close: number) => analyzer.onStrategyWarmupCompleted([bucketAt(minute, close)]);
    const receive = (portfolio: Portfolio) => analyzer.onPortfolioChange([portfolio]);

    // The price doubles during the warmup, which the candle of minute 2 completes, then goes on rising. The events come in the order
    // the pipeline delivers them (see PluginsStream): a portfolio the Trader reads arrives after the bucket it was read in, and the one
    // it reads at the end of the warmup after the analyzer has heard of that end.
    const receivedInWarmup = () => {
      runMinute(1, 100);
      receive(HELD);
      runMinute(2, 200);
      completeWarmup(2, 200);
      receive(HELD);
    };
    // As with the default warmup of 0 candles: the first portfolio arrives right after the end of the warmup, before the next bucket
    const receivedAtWarmupEnd = () => {
      runMinute(1, 100);
      runMinute(2, 200);
      completeWarmup(2, 200);
      receive(HELD);
    };
    const receivedAfterWarmup = () => {
      runMinute(1, 100);
      runMinute(2, 200);
      completeWarmup(2, 200);
      runMinute(3, 300);
      receive(HELD);
    };
    const thenChanged = (run: () => void) => () => {
      run();
      runMinute(4, 400);
      receive(LATER);
    };

    beforeEach(() => {
      // 1 BTC and nothing else: the pair equity is the price
      vi.mocked(calculatePairEquity).mockImplementation((_portfolio, _pair, price) => ({ total: price, free: price, used: 0 }));
    });

    it('should not be taken from a portfolio received during the warmup', () => {
      runMinute(1, 100);
      receive(HELD);
      expect(analyzer['start']).toEqual({ equity: 0, portfolio: null });
    });

    it.each`
      scenario                            | run                                 | equity | description
      ${'in the warmup'}                  | ${receivedInWarmup}                 | ${200} | ${'at the close ending the warmup'}
      ${'at the end of the warmup'}       | ${receivedAtWarmupEnd}              | ${200} | ${'at the close ending the warmup'}
      ${'after the warmup'}               | ${receivedAfterWarmup}              | ${300} | ${'late, at the price known then'}
      ${'in the warmup, then changed'}    | ${thenChanged(receivedInWarmup)}    | ${200} | ${'unmoved by the later change'}
      ${'after the warmup, then changed'} | ${thenChanged(receivedAfterWarmup)} | ${300} | ${'unmoved by the later change'}
    `('should be $equity with a portfolio received $scenario: $description', ({ run, equity }) => {
      run();
      expect(analyzer['start'].equity).toBe(equity);
    });

    it.each`
      scenario                            | run
      ${'in the warmup'}                  | ${receivedInWarmup}
      ${'at the end of the warmup'}       | ${receivedAtWarmupEnd}
      ${'after the warmup'}               | ${receivedAfterWarmup}
      ${'in the warmup, then changed'}    | ${thenChanged(receivedInWarmup)}
      ${'after the warmup, then changed'} | ${thenChanged(receivedAfterWarmup)}
    `('should come with the portfolio it values, with a portfolio received $scenario', ({ run }) => {
      run();
      expect(analyzer['start'].portfolio).toBe(HELD);
    });

    it('should warn that it was taken late, at another price than the start price, when the first portfolio came after the warmup', () => {
      receivedAfterWarmup();
      expect(warning).toHaveBeenCalledWith(
        'roundtrip analyzer',
        expect.stringContaining('start equity taken late, at 300 (start price 200)'),
      );
    });

    it.each`
      scenario                      | run
      ${'in the warmup'}            | ${receivedInWarmup}
      ${'at the end of the warmup'} | ${receivedAtWarmupEnd}
    `('should not warn that it was taken late with a portfolio received $scenario', ({ run }) => {
      run();
      expect(warning).not.toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining('taken late'));
    });

    describe('in a run without trade, the price doubling during the warmup', () => {
      let report: TradingReport;
      beforeEach(() => {
        receivedInWarmup();
        report = analyzer['calculateReportStatistics']();
      });

      it.each`
        field             | expected
        ${'startBalance'} | ${200}
        ${'finalBalance'} | ${200}
        ${'netProfit'}    | ${0}
      `('should report $field $expected', ({ field, expected }) => {
        expect(report[field as keyof TradingReport]).toBe(expected);
      });

      it('should compute the total return from a start equity equal to the final balance', () => {
        expect(statsUtils.calculateTotalReturnPct).toHaveBeenCalledWith(200, 200);
      });
    });
  });

  describe('onTimeframeCandle', () => {
    beforeEach(() => {
      // 1 BTC and nothing else: the pair equity is the price
      vi.mocked(calculatePairEquity).mockImplementation((_portfolio, _pair, price) => ({ total: price, free: price, used: 0 }));
    });

    it('should not mark the pair equity to market before the warmup completes', () => {
      analyzer['processOneMinuteBucket'](bucketAt(1, 100));
      analyzer.onPortfolioChange([new Map()]);
      analyzer['processOneMinuteBucket'](bucketAt(2, 200));
      analyzer.onTimeframeCandle([bucketAt(2, 200)]);
      expect(analyzer['currentEquity']).toBe(100);
    });

    it('should not mark the pair equity to market before any portfolio is received', () => {
      analyzer['processOneMinuteBucket'](bucketAt(1, 100));
      analyzer.onStrategyWarmupCompleted([bucketAt(1, 100)]);
      analyzer.onTimeframeCandle([bucketAt(1, 100)]);
      expect(calculatePairEquity).not.toHaveBeenCalled();
    });
  });

  describe('mark to market', () => {
    // A 1m timeframe: every bucket closes a timeframe candle, whose event the analyzer hears after the bucket (see PluginsStream). The
    // portfolio comes during the warmup, which the bucket of minute 1 completes at a price of 100: the period starts at minute 2.
    const runMinute = (minute: number, close: number, closesTimeframeCandle = true) => {
      analyzer['processOneMinuteBucket'](bucketAt(minute, close));
      if (closesTimeframeCandle) analyzer.onTimeframeCandle([bucketAt(minute, close)]);
    };
    /**
     * A run of 4 minutes, from minute 2 to minute 6, where the price goes from 100 to 200 once these orders have filled, at the close of
     * minute 3. No portfolio change comes after the warmup: with the portfolioUpdates filter of the Trader, none comes while only the
     * price moves.
     */
    const run = (orders: OrderCompletedEvent[], { lastBucketClosesTimeframeCandle = true } = {}) => {
      runMinute(0, 100);
      analyzer.onPortfolioChange([new Map()]);
      analyzer['processOneMinuteBucket'](bucketAt(1, 100));
      analyzer.onStrategyWarmupCompleted([bucketAt(1, 100)]);
      analyzer.onTimeframeCandle([bucketAt(1, 100)]);
      runMinute(2, 100);
      runMinute(3, 100);
      analyzer.onOrderCompleted(orders);
      runMinute(4, 150);
      runMinute(5, 200, lastBucketClosesTimeframeCandle);
    };
    /** The report emitted at the end of the run */
    const finalReport = (): TradingReport => {
      const emitSpy = vi.spyOn(analyzer as any, 'emit');
      analyzer['processFinalize']();
      return emitSpy.mock.lastCall![1] as TradingReport;
    };
    // A long position: the BUY filled at the close of minute 3, at 100
    const LONG = [buy(4, 100, 1)];

    beforeEach(() => {
      // 1 BTC and nothing else: the pair equity is the price
      vi.mocked(calculatePairEquity).mockImplementation((_portfolio, _pair, price) => ({ total: price, free: price, used: 0 }));
    });

    it.each`
      lastBucket                      | closesTimeframeCandle | field             | expected
      ${'closes a timeframe candle'}  | ${true}               | ${'finalBalance'} | ${200}
      ${'closes a timeframe candle'}  | ${true}               | ${'netProfit'}    | ${100}
      ${'closes no timeframe candle'} | ${false}              | ${'finalBalance'} | ${200}
      ${'closes no timeframe candle'} | ${false}              | ${'netProfit'}    | ${100}
    `(
      'should report $field $expected, at the last close, for a long position whose price doubles when the last bucket $lastBucket',
      ({ closesTimeframeCandle, field, expected }) => {
        run(LONG, { lastBucketClosesTimeframeCandle: closesTimeframeCandle });
        expect(finalReport()[field as keyof TradingReport]).toBe(expected);
      },
    );

    it.each`
      orders                                        | exposed       | description
      ${LONG}                                       | ${2 * MINUTE} | ${'a round trip still open, from its BUY at minute 4 to the end at minute 6'}
      ${[buy(2, 100, 1), sell(3, 100, 1), ...LONG]} | ${3 * MINUTE} | ${'a round trip of a minute, then one still open for two'}
      ${[buy(2, 100, 1), sell(3, 100, 1)]}          | ${1 * MINUTE} | ${'a round trip of a minute, closed before the end'}
      ${[buy(7, 100, 1)]}                           | ${0}          | ${'a round trip still open, its BUY dated after the end'}
    `('should measure an exposure of $exposed ms over the 4 minutes of the period with $description', ({ orders, exposed }) => {
      run(orders);
      finalReport();
      expect(statsUtils.calculateExposurePct).toHaveBeenCalledWith(exposed, 4 * MINUTE);
    });

    it('should say in the final log that a position was still open, with its entry and its unrealized P&L at the last close', () => {
      run(LONG);
      finalReport();
      expect(info).toHaveBeenCalledWith(
        'roundtrip analyzer',
        expect.stringContaining(
          'Position still open at the end of the period, entered at 100 USDT on 1970-01-01T00:04:00.000Z: unrealized P&L of 100 USDT (+100%) at the last close, 200 USDT.',
        ),
      );
    });

    it('should not say that a position was still open when the run ends flat', () => {
      run([buy(2, 100, 1), sell(3, 100, 1)]);
      finalReport();
      expect(info).not.toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining('still open'));
    });
  });

  describe('latest portfolio', () => {
    // The portfolio of a portfolio change, then the one an order carries, read by the Trader after the order
    const CHANGED: Portfolio = new Map([['USDT', { free: 100, used: 0, total: 100 }]]);
    const AFTER_ORDER: Portfolio = new Map([['BTC', { free: 1, used: 0, total: 1 }]]);
    const carrying = (event: any) => ({ ...event, exchange: { portfolio: AFTER_ORDER } });

    it.each`
      event                                             | deliver
      ${'a completed BUY'}                              | ${() => analyzer.onOrderCompleted([carrying(buy(2, 100, 1))])}
      ${'a completed SELL, skipped while flat'}         | ${() => analyzer.onOrderCompleted([carrying(sell(2, 100, 1))])}
      ${'a completed order without a valid price'}      | ${() => analyzer.onOrderCompleted([carrying(buy(2, NaN, 1))])}
      ${'an order canceled after a partial fill'}       | ${() => analyzer.onOrderCanceled([carrying(canceled('BUY', 2, 4, 100))])}
      ${'an order canceled without a fill'}             | ${() => analyzer.onOrderCanceled([carrying(canceled('BUY', 2, 0, 100))])}
      ${'the last of the orders delivered together'}    | ${() => analyzer.onOrderCompleted([buy(2, 100, 1), carrying(buy(3, 100, 1))])}
      ${'the last of the cancelations delivered alike'} | ${() => analyzer.onOrderCanceled([canceled('BUY', 2, 0), carrying(canceled('BUY', 3, 0))])}
      ${'an order ended in error'}                      | ${() => analyzer.onOrderErrored([carrying(errored(2))])}
      ${'the last of the errors delivered together'}    | ${() => analyzer.onOrderErrored([errored(2), carrying(errored(3))])}
    `('should take the portfolio after $event as the latest, whose portfolio change the Trader can hold back', ({ deliver }) => {
      analyzer.onPortfolioChange([CHANGED]);
      deliver();
      expect(analyzer['latestPortfolio']).toBe(AFTER_ORDER);
    });

    // The Trader sends the portfolio it knows: the empty one it starts with until one of its synchronizations succeeds
    const notFetched = (event: any) => ({ ...event, exchange: { portfolio: new Map() } });
    it.each`
      event                        | deliver
      ${'an order completed'}      | ${() => analyzer.onOrderCompleted([notFetched(buy(2, 100, 1))])}
      ${'an order canceled'}       | ${() => analyzer.onOrderCanceled([notFetched(canceled('BUY', 2, 0))])}
      ${'an order ended in error'} | ${() => analyzer.onOrderErrored([notFetched(errored(2))])}
    `('should keep the latest portfolio when $event carries the empty portfolio of a Trader that has fetched none yet', ({ deliver }) => {
      analyzer.onPortfolioChange([CHANGED]);
      deliver();
      expect(analyzer['latestPortfolio']).toBe(CHANGED);
    });

    it('should neither count an order ended in error as a trade nor open a round trip with it', () => {
      analyzer.onOrderErrored([errored(2)]);
      expect({ tradeCount: analyzer['tradeCount'], openRoundTrip: analyzer['openRoundTrip'] }).toEqual({
        tradeCount: 0,
        openRoundTrip: null,
      });
    });

    it('should mark to market the portfolio after the last order', () => {
      analyzer['processOneMinuteBucket'](bucketAt(1, 100));
      analyzer.onStrategyWarmupCompleted([bucketAt(1, 100)]);
      analyzer.onPortfolioChange([CHANGED]);
      analyzer.onOrderCompleted([carrying(buy(2, 100, 1))]);
      analyzer['processOneMinuteBucket'](bucketAt(2, 120));
      analyzer.onTimeframeCandle([bucketAt(2, 120)]);
      expect(calculatePairEquity).toHaveBeenLastCalledWith(AFTER_ORDER, 'BTC/USDT', 120);
    });
  });

  describe('logOpenRoundTrip', () => {
    it.each`
      entryEquity | currentEquity | pnl
      ${100}      | ${200}        | ${'unrealized P&L of 100 USDT (+100%)'}
      ${100}      | ${50}         | ${'unrealized P&L of -50 USDT (-50%)'}
      ${0}        | ${50}         | ${'unrealized P&L of 50 USDT (0%)'}
    `('should log $pnl from an entry equity of $entryEquity to $currentEquity', ({ entryEquity, currentEquity, pnl }) => {
      analyzer['currentEquity'] = currentEquity;
      analyzer['logOpenRoundTrip']({ ...OPEN_ROUND_TRIP, entryEquity });
      expect(info).toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining(pnl));
    });
  });

  describe('onOrderCompleted', () => {
    it('should ignore first order if it is SELL', () => {
      analyzer.onOrderCompleted([sell(1, 100, 1)]);
      expect(analyzer['tradeCount']).toBe(0);
    });

    it('should increment tradeCount on valid order', () => {
      analyzer.onOrderCompleted([buy(1, 100, 1)]);
      expect(analyzer['tradeCount']).toBe(1);
    });

    it('should register the fill of the order, dated at its execution, with the portfolio after it', () => {
      const event = buy(1, 100, 1, 0.5);
      const spy = vi.spyOn(analyzer as any, 'registerRoundtripPart');
      analyzer.onOrderCompleted([event]);
      expect(spy).toHaveBeenCalledWith(
        { id: 'BUY-1', side: 'BUY', date: MINUTE, price: 100, amount: 1, fee: 0.5 },
        event.exchange.portfolio,
      );
    });

    describe('when a batch holds a SELL before any BUY, then a BUY', () => {
      const batch = [sell(1, 90, 1), buy(2, 100, 1)];

      it('should count only the BUY as a trade', () => {
        analyzer.onOrderCompleted(batch);
        expect(analyzer['tradeCount']).toBe(1);
      });

      it('should open the round trip with the BUY that follows the skipped SELL', () => {
        analyzer.onOrderCompleted(batch);
        expect(analyzer['openRoundTrip']?.entryPrice).toBe(100);
      });
    });
  });

  describe('onOrderCanceled', () => {
    // The last close is 90: the price of a fill whose order had none
    beforeEach(() => {
      analyzer['processOneMinuteBucket'](bucketAt(1, 90));
    });

    describe.each`
      order                | event                         | price
      ${'with a price'}    | ${canceled('BUY', 2, 4, 100)} | ${100}
      ${'without a price'} | ${canceled('BUY', 2, 4)}      | ${90}
    `('BUY canceled after filling 4 of 10, $order', ({ event, price }) => {
      beforeEach(() => {
        vi.mocked(calculatePairEquity).mockReturnValue({ total: 2500, free: 0, used: 0 });
        analyzer.onOrderCanceled([event]);
      });

      it(`should open a round trip with the part filled, at ${price}, dated at the cancelation, its fee unknown`, () => {
        expect(analyzer['openRoundTrip']).toEqual({
          entryAt: 2 * MINUTE,
          entryPrice: price,
          entryEquity: 2500,
          bought: 4,
          sold: 0,
          exitPrice: 0,
          maxAdverseExcursion: 0,
        });
      });

      it('should value the pair equity at the price of the fill', () => {
        expect(calculatePairEquity).toHaveBeenCalledWith(PORTFOLIO, 'BTC/USDT', price);
      });

      it('should count the fill as a trade', () => {
        expect(analyzer['tradeCount']).toBe(1);
      });

      it('should log the fill at debug', () => {
        expect(debug).toHaveBeenCalledWith(
          'roundtrip analyzer',
          `BUY order BUY-2 canceled after a partial fill: its 4 filled count at ${price}, fee unknown.`,
        );
      });
    });

    describe('SELL canceled after a partial fill that sells what a round trip bought', () => {
      beforeEach(() => {
        holdAfterSells(0);
        analyzer.onOrderCompleted([buy(1, 100, 4)]);
        analyzer.onOrderCanceled([canceled('SELL', 3, 4, 110)]);
      });

      it('should end the round trip', () => {
        expect(analyzer['roundTrips']).toHaveLength(1);
      });

      it('should exit at the price of the order', () => {
        expect(analyzer['roundTrips'][0].exitPrice).toBe(110);
      });
    });

    it.each`
      filled
      ${0}
      ${NaN}
    `('should count no trade for an order canceled with $filled filled', ({ filled }) => {
      analyzer.onOrderCanceled([canceled('BUY', 2, filled, 100)]);
      expect(analyzer['tradeCount']).toBe(0);
    });

    it('should skip a SELL canceled after a partial fill while flat, before any trade', () => {
      analyzer.onOrderCanceled([canceled('SELL', 2, 4, 100)]);
      expect(analyzer['tradeCount']).toBe(0);
    });
  });

  describe('registerRoundtripPart', () => {
    it.each`
      price        | amount | description
      ${null}      | ${1}   | ${'null price'}
      ${undefined} | ${1}   | ${'missing price'}
      ${NaN}       | ${1}   | ${'NaN price'}
      ${0}         | ${1}   | ${'zero price'}
      ${-1}        | ${1}   | ${'negative price'}
      ${100}       | ${NaN} | ${'NaN amount'}
      ${100}       | ${0}   | ${'zero amount'}
    `('should log warning and abort if order has an invalid price or amount ($description)', ({ price, amount }) => {
      analyzer.onOrderCompleted([{ order: { id: '123', side: 'BUY', price, amount }, exchange: { portfolio: {} } } as any]);
      expect(warning).toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining('without a valid price or amount'));
    });

    it.each`
      side      | price  | amount
      ${'BUY'}  | ${NaN} | ${1}
      ${'BUY'}  | ${100} | ${NaN}
      ${'SELL'} | ${NaN} | ${1}
      ${'SELL'} | ${100} | ${0}
    `('should leave the round trip untouched when a $side has price $price and amount $amount', ({ side, price, amount }) => {
      analyzer['openRoundTrip'] = { ...OPEN_ROUND_TRIP };
      analyzer.onOrderCompleted([completed(side, 2, price, amount)]);
      expect(analyzer['openRoundTrip']).toEqual(OPEN_ROUND_TRIP);
    });

    describe('BUY while flat', () => {
      it('should open a round trip at its date, price and amount, with the pair equity before it: after it, plus its fee', () => {
        vi.mocked(calculatePairEquity).mockReturnValue({ total: 2500, free: 0, used: 0 });
        analyzer.onOrderCompleted([buy(1, 100, 2, 0.5)]);
        expect(analyzer['openRoundTrip']).toEqual({
          entryAt: MINUTE,
          entryPrice: 100,
          entryEquity: 2500.5,
          bought: 2,
          sold: 0,
          exitPrice: 0,
          maxAdverseExcursion: 0,
        });
      });

      it('should value the pair equity at the price of the BUY', () => {
        analyzer.onOrderCompleted([buy(1, 100, 2)]);
        expect(calculatePairEquity).toHaveBeenCalledWith(PORTFOLIO, 'BTC/USDT', 100);
      });

      it('should not update currentEquity', () => {
        analyzer.onOrderCompleted([buy(1, 100, 2)]);
        expect(analyzer['currentEquity']).toBe(0);
      });
    });

    describe('BUY while a round trip is open (scale-in)', () => {
      beforeEach(() => {
        vi.mocked(calculatePairEquity)
          .mockReturnValueOnce({ total: 1000, free: 0, used: 0 })
          .mockReturnValueOnce({ total: 900, free: 0, used: 0 });
        analyzer.onOrderCompleted([buy(1, 100, 1, 1)]);
        analyzer['openRoundTrip']!.maxAdverseExcursion = 5;
        analyzer.onOrderCompleted([buy(3, 130, 2, 2)]);
      });

      it.each`
        field                    | expected  | description
        ${'entryAt'}             | ${MINUTE} | ${'the date of the first BUY'}
        ${'entryPrice'}          | ${120}    | ${'the mean price of both BUYs, weighted by their amounts'}
        ${'entryEquity'}         | ${1001}   | ${'the pair equity before the first BUY, whatever the second one paid in fee'}
        ${'bought'}              | ${3}      | ${'the amount of both BUYs'}
        ${'maxAdverseExcursion'} | ${5}      | ${'the adverse excursion so far'}
      `('should keep the round trip open with $field $expected: $description', ({ field, expected }) => {
        expect(analyzer['openRoundTrip']?.[field as keyof typeof OPEN_ROUND_TRIP]).toBe(expected);
      });
    });

    describe.each`
      scenario                                   | orders                                                | held      | entryPrice | exitAt | exitPrice
      ${'BUY, SELL'}                             | ${[buy(1, 100, 1), sell(5, 120, 1)]}                  | ${[0]}    | ${100}     | ${5}   | ${120}
      ${'BUY, SELL, SELL'}                       | ${[buy(1, 100, 1), sell(5, 120, 1), sell(8, 150, 1)]} | ${[0]}    | ${100}     | ${5}   | ${120}
      ${'BUY, BUY, SELL of both'}                | ${[buy(1, 100, 1), buy(3, 130, 2), sell(5, 150, 3)]}  | ${[0]}    | ${120}     | ${5}   | ${150}
      ${'BUY, SELL of a part, SELL of the rest'} | ${[buy(1, 100, 2), sell(3, 110, 1), sell(5, 130, 1)]} | ${[1, 0]} | ${100}     | ${5}   | ${120}
    `('after $scenario', ({ orders, held, entryPrice, exitAt, exitPrice }) => {
      let emitSpy: MockInstance;
      beforeEach(() => {
        holdAfterSells(...held);
        emitSpy = vi.spyOn(analyzer as any, 'addDeferredEmit');
        analyzer.onOrderCompleted(orders);
      });

      it('should close exactly one round trip', () => {
        expect(analyzer['roundTrips']).toHaveLength(1);
      });

      it('should leave no round trip open', () => {
        expect(analyzer['openRoundTrip']).toBeNull();
      });

      it('should enter at the date of the first BUY', () => {
        expect(analyzer['roundTrips'][0].entryAt).toBe(MINUTE);
      });

      it('should enter at the mean price of the BUYs, weighted by their amounts', () => {
        expect(analyzer['roundTrips'][0].entryPrice).toBe(entryPrice);
      });

      it('should exit at the date of the SELL that leaves it flat', () => {
        expect(analyzer['roundTrips'][0].exitAt).toBe(exitAt * MINUTE);
      });

      it('should exit at the mean price of its SELLs, weighted by their amounts', () => {
        expect(analyzer['roundTrips'][0].exitPrice).toBe(exitPrice);
      });

      it('should count its duration alone as exposure in a period that holds it', () => {
        analyzer['dates'] = { start: 0, end: 10 * MINUTE };
        expect(analyzer['calculateExposureMs']()).toBe((exitAt - 1) * MINUTE);
      });

      it('should emit ROUNDTRIP_COMPLETED_EVENT once', () => {
        expect(emitSpy).toHaveBeenCalledExactlyOnceWith(ROUNDTRIP_COMPLETED_EVENT, analyzer['roundTrips'][0]);
      });
    });

    describe('BUY, then SELL of a part of it', () => {
      let emitSpy: MockInstance;
      beforeEach(() => {
        holdAfterSells(1);
        emitSpy = vi.spyOn(analyzer as any, 'addDeferredEmit');
        analyzer.onOrderCompleted([buy(1, 100, 2), sell(3, 110, 1)]);
      });

      it('should close no round trip yet', () => {
        expect(analyzer['roundTrips']).toHaveLength(0);
      });

      it('should emit no ROUNDTRIP_COMPLETED_EVENT', () => {
        expect(emitSpy).not.toHaveBeenCalled();
      });

      it('should count it as exposed from its BUY to the end of the period, still open', () => {
        analyzer['dates'] = { start: 0, end: 10 * MINUTE };
        expect(analyzer['calculateExposureMs']()).toBe(9 * MINUTE);
      });

      it('should keep the round trip open with the amount and the price of the SELL', () => {
        expect(analyzer['openRoundTrip']).toEqual({ ...OPEN_ROUND_TRIP, entryAt: MINUTE, bought: 2, sold: 1, exitPrice: 110 });
      });
    });

    describe('SELL while a round trip is open', () => {
      it.each`
        sold     | held     | closes   | description
        ${1}     | ${0}     | ${true}  | ${'sells it all'}
        ${1}     | ${100}   | ${true}  | ${'sells it all, the account still holding what it held before'}
        ${0.995} | ${0.005} | ${true}  | ${'leaves dust, at most 1 % of the amount bought'}
        ${0.98}  | ${0.02}  | ${false} | ${'leaves more than 1 % of the amount bought'}
        ${0.5}   | ${100}   | ${false} | ${'sells half, the account still holding what it held before'}
        ${0.5}   | ${0}     | ${true}  | ${'sells half, the account holding no more (the other half was sold unseen)'}
      `('should close the round trip ($closes) when it $description', ({ sold, held, closes }) => {
        holdAfterSells(held);
        analyzer.onOrderCompleted([buy(1, 100, 1), sell(3, 110, sold)]);
        expect(analyzer['roundTrips']).toHaveLength(closes ? 1 : 0);
      });

      it('should read what the account holds of the asset', () => {
        analyzer.onOrderCompleted([buy(1, 100, 1), sell(3, 110, 1)]);
        expect(getAssetBalance).toHaveBeenCalledWith(PORTFOLIO, 'BTC');
      });

      it('should exit with the pair equity after the SELL', () => {
        holdAfterSells(0);
        vi.mocked(calculatePairEquity)
          .mockReturnValueOnce({ total: 1000, free: 0, used: 0 })
          .mockReturnValueOnce({ total: 1100, free: 0, used: 0 });
        analyzer.onOrderCompleted([buy(1, 100, 1), sell(3, 110, 1)]);
        expect(analyzer['roundTrips'][0].exitEquity).toBe(1100);
      });

      it('should update currentEquity', () => {
        vi.mocked(calculatePairEquity).mockReturnValue({ total: 2000, free: 0, used: 0 });
        analyzer.onOrderCompleted([buy(1, 100, 2), sell(3, 110, 1)]);
        expect(analyzer['currentEquity']).toBe(2000);
      });

      it('should start the adverse excursion of the next round trip at 0', () => {
        holdAfterSells(0);
        analyzer.onOrderCompleted([buy(1, 100, 1)]);
        analyzer['openRoundTrip']!.maxAdverseExcursion = 5;
        analyzer.onOrderCompleted([sell(3, 110, 1), buy(5, 105, 1)]);
        expect(analyzer['openRoundTrip']?.maxAdverseExcursion).toBe(0);
      });
    });

    describe('BUY with a fee, then SELL', () => {
      // The BUY leaves a pair equity of 1000, its fee paid, and the SELL one of 1000.5, its own fee paid: after its BUY, the round
      // trip gained 0.5, less than a fee of 1 paid by that BUY
      const closeRoundTrip = (fee?: number) => {
        holdAfterSells(0);
        vi.mocked(calculatePairEquity)
          .mockReturnValueOnce({ total: 1000, free: 0, used: 0 })
          .mockReturnValueOnce({ total: 1000.5, free: 0, used: 0 });
        analyzer.onOrderCompleted([buy(1, 100, 1, fee), sell(3, 110, 1)]);
      };

      it.each`
        fee          | field            | expected                       | description
        ${1}         | ${'entryEquity'} | ${1001}                        | ${'the pair equity before the BUY: after it, plus its fee'}
        ${1}         | ${'exitEquity'}  | ${1000.5}                      | ${'the pair equity after the SELL'}
        ${1}         | ${'pnl'}         | ${-0.5}                        | ${'a loss: the round trip gained less than the fee of its BUY'}
        ${1}         | ${'profit'}      | ${(100 * 1000.5) / 1001 - 100} | ${'that loss, in % of the entry equity'}
        ${0}         | ${'entryEquity'} | ${1000}                        | ${'without a fee, the pair equity after the BUY'}
        ${0}         | ${'pnl'}         | ${0.5}                         | ${'without a fee, a gain'}
        ${undefined} | ${'entryEquity'} | ${1000}                        | ${'an unknown fee counts as 0'}
        ${NaN}       | ${'entryEquity'} | ${1000}                        | ${'a fee that is not a number counts as 0'}
      `('should record $field $expected when the BUY paid a fee of $fee: $description', ({ fee, field, expected }) => {
        closeRoundTrip(fee);
        expect(analyzer['roundTrips'][0][field as keyof RoundTrip]).toBeCloseTo(expected, 10);
      });

      it.each`
        fee  | wins | outcome
        ${1} | ${0} | ${'a loss'}
        ${0} | ${1} | ${'a win'}
      `('should count the round trip as $outcome in the win rate when the BUY paid a fee of $fee', ({ fee, wins }) => {
        closeRoundTrip(fee);
        analyzer['start'] = { equity: 1000, portfolio: {} as any };
        analyzer['startPrice'] = 100;
        analyzer['calculateReportStatistics']();
        expect(statsUtils.calculateWinRate).toHaveBeenCalledWith(wins, 1);
      });
    });

    describe.each`
      flat                                   | before                               | roundTrips
      ${'after a round trip has ended'}      | ${[buy(1, 100, 1), sell(3, 110, 1)]} | ${1}
      ${'after a BUY skipped for its price'} | ${[buy(1, NaN, 1)]}                  | ${0}
    `('SELL while flat, $flat', ({ before, roundTrips }) => {
      beforeEach(() => {
        holdAfterSells(0);
        analyzer.onOrderCompleted(before);
        vi.mocked(calculatePairEquity).mockReturnValue({ total: 1234, free: 0, used: 0 });
        analyzer.onOrderCompleted([sell(5, 150, 1)]);
      });

      it('should skip it with a debug log', () => {
        expect(debug).toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining('no round trip is open'));
      });

      it('should close no round trip with it', () => {
        expect(analyzer['roundTrips']).toHaveLength(roundTrips);
      });

      it('should leave no round trip open', () => {
        expect(analyzer['openRoundTrip']).toBeNull();
      });

      it('should still update currentEquity', () => {
        expect(analyzer['currentEquity']).toBe(1234);
      });
    });
  });

  describe('handleCompletedRoundtrip', () => {
    const roundTrip = { ...OPEN_ROUND_TRIP, sold: 1, exitPrice: 110, maxAdverseExcursion: 5 };

    it.each`
      field                    | expected
      ${'id'}                  | ${0}
      ${'entryAt'}             | ${1000}
      ${'entryPrice'}          | ${100}
      ${'entryEquity'}         | ${1000}
      ${'exitAt'}              | ${3000}
      ${'exitPrice'}           | ${110}
      ${'exitEquity'}          | ${1100}
      ${'pnl'}                 | ${100}
      ${'profit'}              | ${10}
      ${'maxAdverseExcursion'} | ${5}
      ${'duration'}            | ${2000}
    `('should record the round trip with $field $expected', ({ field, expected }) => {
      analyzer['handleCompletedRoundtrip'](roundTrip, 3000, 1100);
      expect(analyzer['roundTrips'][0][field as keyof RoundTrip]).toBe(expected);
    });

    it('should log the roundtrip', () => {
      analyzer['handleCompletedRoundtrip'](roundTrip, 3000, 1100);
      expect(logRoundtrip).toHaveBeenCalledWith(analyzer['roundTrips'][0], 'USDT', true);
    });

    it('should number successive round trips', () => {
      analyzer['handleCompletedRoundtrip'](roundTrip, 3000, 1100);
      analyzer['handleCompletedRoundtrip']({ ...roundTrip, entryAt: 5000 }, 9000, 1200);
      expect(analyzer['roundTrips'][1].id).toBe(1);
    });

    it('should add the durations of successive round trips to the exposure', () => {
      analyzer['dates'] = { start: 0, end: 10_000 };
      analyzer['handleCompletedRoundtrip'](roundTrip, 3000, 1100);
      analyzer['handleCompletedRoundtrip']({ ...roundTrip, entryAt: 5000 }, 9000, 1200);
      expect(analyzer['calculateExposureMs']()).toBe(6000);
    });

    it('should report a profit of 0 when the entry equity is 0', () => {
      analyzer['handleCompletedRoundtrip']({ ...roundTrip, entryEquity: 0 }, 3000, 1100);
      expect(analyzer['roundTrips'][0].profit).toBe(0);
    });
  });

  describe('calculateExposureMs', () => {
    // A period from minute 10 to minute 20
    beforeEach(() => {
      analyzer['dates'] = { start: 10 * MINUTE, end: 20 * MINUTE };
    });

    it.each`
      entryAt | exitAt | exposed | description
      ${12}   | ${15}  | ${3}    | ${'within the period, in full'}
      ${8}    | ${15}  | ${5}    | ${'entered before the start (a fill heard after the warmup, dated before it), from the start'}
      ${15}   | ${22}  | ${5}    | ${'exited after the end (a fill dated after the close of the last bucket), until the end'}
      ${2}    | ${8}   | ${0}    | ${'before the period, not at all'}
      ${21}   | ${22}  | ${0}    | ${'after the period, not at all'}
    `('should count a closed round trip $description: $exposed minutes', ({ entryAt, exitAt, exposed }) => {
      analyzer['roundTrips'] = [{ entryAt: entryAt * MINUTE, exitAt: exitAt * MINUTE } as RoundTrip];
      expect(analyzer['calculateExposureMs']()).toBe(exposed * MINUTE);
    });

    it.each`
      entryAt | exposed | description
      ${12}   | ${8}    | ${'from its entry to the end'}
      ${8}    | ${10}   | ${'entered before the start, from the start to the end'}
      ${21}   | ${0}    | ${'entered after the end, not at all'}
    `('should count the round trip still open $description: $exposed minutes', ({ entryAt, exposed }) => {
      analyzer['openRoundTrip'] = { ...OPEN_ROUND_TRIP, entryAt: entryAt * MINUTE };
      expect(analyzer['calculateExposureMs']()).toBe(exposed * MINUTE);
    });

    it('should add the time of the round trips closed and that of the one still open', () => {
      analyzer['roundTrips'] = [{ entryAt: 12 * MINUTE, exitAt: 15 * MINUTE } as RoundTrip];
      analyzer['openRoundTrip'] = { ...OPEN_ROUND_TRIP, entryAt: 17 * MINUTE };
      expect(analyzer['calculateExposureMs']()).toBe(6 * MINUTE);
    });
  });

  describe('processOneMinuteBucket', () => {
    it('should warn if missing candle', () => {
      const bucket = new Map() as CandleBucket;
      analyzer['processOneMinuteBucket'](bucket);
      expect(warning).toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining('Missing candle'));
    });

    it('should not move the end of the period if warmup not completed', () => {
      analyzer['processOneMinuteBucket'](bucketAt(1, 100));
      expect(analyzer['dates'].end).toBe(0);
    });

    it('should update dates.end if warmup completed', () => {
      analyzer['warmupCompleted'] = true;
      const candle = { start: 1000, close: 100, low: 90 } as any;
      const bucket = new Map([['BTC/USDT', candle]]) as CandleBucket;
      analyzer['processOneMinuteBucket'](bucket);
      expect(analyzer['dates'].end).toBe(1000 + 60000); // addMinutes(1)
    });

    it('should update maxAdverseExcursion if in trade and candle low drops further', () => {
      analyzer['warmupCompleted'] = true;
      analyzer['openRoundTrip'] = { ...OPEN_ROUND_TRIP };
      const candle = { start: 1000, close: 90, low: 80 } as any;
      const bucket = new Map([['BTC/USDT', candle]]) as CandleBucket;
      analyzer['processOneMinuteBucket'](bucket);
      expect(analyzer['openRoundTrip']?.maxAdverseExcursion).toBe(20);
    });

    it('should NOT update maxAdverseExcursion if in trade but candle low does not drop further', () => {
      analyzer['warmupCompleted'] = true;
      analyzer['openRoundTrip'] = { ...OPEN_ROUND_TRIP, maxAdverseExcursion: 25 };
      const candle = { start: 1000, close: 95, low: 90 } as any;
      const bucket = new Map([['BTC/USDT', candle]]) as CandleBucket;
      analyzer['processOneMinuteBucket'](bucket);
      expect(analyzer['openRoundTrip']?.maxAdverseExcursion).toBe(25); // stays the same
    });

    it('should measure maxAdverseExcursion from the mean price of the BUYs after a scale-in', () => {
      analyzer['warmupCompleted'] = true;
      analyzer.onOrderCompleted([buy(1, 100, 1), buy(2, 80, 1)]);
      const candle = { start: 1000, close: 85, low: 81 } as any;
      const bucket = new Map([['BTC/USDT', candle]]) as CandleBucket;
      analyzer['processOneMinuteBucket'](bucket);
      expect(analyzer['openRoundTrip']?.maxAdverseExcursion).toBeCloseTo(10); // (90 - 81) / 90
    });
  });

  describe('processInit', () => {
    it('should execute without error', () => {
      expect(() => analyzer['processInit']()).not.toThrow();
    });
  });

  describe('processFinalize', () => {
    it('should calculate report and emit it directly', () => {
      const emitSpy = vi.spyOn(analyzer as any, 'emit');
      const calcSpy = vi.spyOn(analyzer as any, 'calculateReportStatistics');
      const mockReport = { id: 'TRADING REPORT' } as any;
      calcSpy.mockReturnValue(mockReport);

      analyzer['processFinalize']();
      expect(emitSpy).toHaveBeenCalledWith(PERFORMANCE_REPORT_EVENT, mockReport);
    });

    it('should say why the run was interrupted in the report', () => {
      const emitSpy = vi.spyOn(analyzer as any, 'emit');
      vi.spyOn(analyzer as any, 'calculateReportStatistics').mockReturnValue({ id: 'TRADING REPORT' });

      analyzer['processFinalize'](new Error('circuit breaker'));
      expect(emitSpy).toHaveBeenCalledWith(PERFORMANCE_REPORT_EVENT, { id: 'TRADING REPORT', interruption: 'circuit breaker' });
    });

    it('should log final report when console table enabled', () => {
      const calcSpy = vi.spyOn(analyzer as any, 'calculateReportStatistics');
      const mockReport = { id: 'TRADING REPORT' } as any;
      calcSpy.mockReturnValue(mockReport);
      analyzer['enableConsoleTable'] = true;

      analyzer['processFinalize']();
      expect(logFinalize).toHaveBeenCalledWith(mockReport, 'USDT'); // NOTE: Removed third argument mapping
    });

    it('should log final report through info when console table disabled', () => {
      vi.spyOn(analyzer as any, 'calculateReportStatistics').mockReturnValue(EMPTY_TRADING_REPORT);
      analyzer['enableConsoleTable'] = false;

      analyzer['processFinalize']();
      expect(info).toHaveBeenCalledWith('roundtrip analyzer', EMPTY_TRADING_REPORT);
    });
  });

  describe('calculateReportStatistics', () => {
    describe.each`
      missing                  | start                                     | startPrice
      ${'the start equity'}    | ${{ equity: 0, portfolio: new Map() }}    | ${100}
      ${'the start portfolio'} | ${{ equity: 1000, portfolio: null }}      | ${100}
      ${'the start price'}     | ${{ equity: 1000, portfolio: new Map() }} | ${null}
    `('without $missing', ({ start, startPrice }) => {
      let report: TradingReport;
      beforeEach(() => {
        analyzer['start'] = start;
        analyzer['startPrice'] = startPrice;
        report = analyzer['calculateReportStatistics']();
      });

      it('should return the empty report', () => {
        expect(report).toEqual(EMPTY_TRADING_REPORT);
      });

      it('should warn that no portfolio data was received', () => {
        expect(warning).toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining('No portfolio data'));
      });
    });

    it('should warn that a period shorter than a day is annualized over a day', () => {
      analyzer['start'] = { equity: 1000, portfolio: {} as any };
      analyzer['startPrice'] = 100;
      analyzer['dates'] = { start: 1000, end: 2000 };
      analyzer['calculateReportStatistics']();
      expect(warning).toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining('Period shorter than a day'));
    });

    it('should calculate full report metrics successfully', () => {
      analyzer['start'] = { equity: 1000, portfolio: {} as any };
      analyzer['currentEquity'] = 2000;
      analyzer['startPrice'] = 100;
      analyzer['endPrice'] = 200;
      analyzer['dates'] = { start: Date.now() - 31536000000, end: Date.now() }; // 1 year approx
      analyzer['roundTrips'] = [
        { pnl: 500, profit: 50, maxAdverseExcursion: 0 } as any,
        { pnl: 500, profit: 50, maxAdverseExcursion: 0 } as any,
      ];
      analyzer['tradeCount'] = 2;

      (statsUtils.calculateAnnualizedReturnPct as any).mockReturnValue(100);
      (statsUtils.calculateTotalReturnPct as any).mockReturnValue(100);

      const report = analyzer['calculateReportStatistics']();

      expect(report.finalBalance).toBe(2000);
    });

    it('should call calculateSharpeRatio during report generation', () => {
      analyzer['start'] = { equity: 1000, portfolio: {} as any };
      analyzer['currentEquity'] = 2000;
      analyzer['startPrice'] = 100;
      analyzer['endPrice'] = 200;
      analyzer['dates'] = { start: Date.now() - 31536000000, end: Date.now() }; // 1 year approx
      analyzer['roundTrips'] = [];
      analyzer['tradeCount'] = 0;

      analyzer['calculateReportStatistics']();
      expect(statsUtils.calculateSharpeRatio).toHaveBeenCalled();
    });

    it('should calculate null winRate smoothly', () => {
      analyzer['start'] = { equity: 1000, portfolio: {} as any };
      analyzer['currentEquity'] = 2000;
      analyzer['startPrice'] = 100;
      analyzer['endPrice'] = 200;
      analyzer['dates'] = { start: Date.now() - 31536000000, end: Date.now() }; // 1 year approx
      analyzer['roundTrips'] = [];
      analyzer['tradeCount'] = 0;

      (statsUtils.calculateWinRate as any).mockReturnValue(null);
      const report = analyzer['calculateReportStatistics']();
      expect(report.winRate).toBeNull();
    });
  });

  describe('getStaticConfiguration', () => {
    it('should return correct Plugin Name', () => {
      const config = RoundTripAnalyzer.getStaticConfiguration();
      expect(config.name).toBe(PLUGIN_NAME);
    });

    it('should configure modes correctly', () => {
      const config = RoundTripAnalyzer.getStaticConfiguration();
      expect(config.modes).toEqual(['realtime', 'backtest']);
    });

    it('should configure eventsEmitted correctly', () => {
      const config = RoundTripAnalyzer.getStaticConfiguration();
      expect(config.eventsEmitted).toEqual([PERFORMANCE_REPORT_EVENT, ROUNDTRIP_COMPLETED_EVENT]);
    });

    it.each`
      handler
      ${'onPortfolioChange'}
      ${'onStrategyWarmupCompleted'}
      ${'onTimeframeCandle'}
      ${'onOrderCompleted'}
      ${'onOrderCanceled'}
      ${'onOrderErrored'}
    `('should export $handler as a handler', ({ handler }) => {
      const config = RoundTripAnalyzer.getStaticConfiguration();
      expect(config.eventsHandlers).toContain(handler);
    });
  });

  describe('with the real portfolio and statistics utils, in pipeline order', () => {
    /**
     * A 1m timeframe: the bucket of each minute closes a timeframe candle. The events of a bucket follow it in the order PluginsStream
     * flushes them: those of the TradingAdvisor (the end of the warmup, the timeframe candle), then those of the Trader. The Trader
     * reports an order with the portfolio change of the synchronization it waits for, then the end of the order: without a
     * portfolioUpdates filter, the change comes first, and in one array with the changes queued just before it.
     */
    const runMinute = (minute: number, close: number, { low = close, completesWarmup = false } = {}) => {
      const bucket = new Map([['BTC/USDT', { start: minute * MINUTE, open: close, high: close, low, close, volume: 1 }]]) as CandleBucket;
      analyzer['processOneMinuteBucket'](bucket);
      if (completesWarmup) analyzer.onStrategyWarmupCompleted([bucket]);
      analyzer.onTimeframeCandle([bucket]);
    };
    const runMinutes = (from: number, to: number, close: number) => {
      for (let minute = from; minute <= to; minute++) runMinute(minute, close);
    };
    const holding = (btc: number, usdt: number): Portfolio =>
      new Map([
        ['BTC', { free: btc, used: 0, total: btc }],
        ['USDT', { free: usdt, used: 0, total: usdt }],
      ]);
    /** An order filled at the given minute, and the portfolio the Trader read after it */
    const filled = (side: 'BUY' | 'SELL', minute: number, price: number, amount: number, fee: number, portfolio: Portfolio) =>
      ({
        order: { id: `${side}-${minute}`, side, price, amount, fee, orderExecutionDate: minute * MINUTE },
        exchange: { portfolio, price },
      }) as OrderCompletedEvent;
    /** An order of 10 at the given price canceled at the given minute after filling that amount, and the portfolio after it */
    const canceledAfterFill = (side: 'BUY' | 'SELL', minute: number, price: number, filledAmount: number, portfolio: Portfolio) =>
      ({
        order: { id: `${side}-${minute}`, side, price, amount: 10, filled: filledAmount, orderCancelationDate: minute * MINUTE },
        exchange: { portfolio, price },
      }) as OrderCanceledEvent;
    let emitSpy: MockInstance;
    let deferredEmitSpy: MockInstance;
    const finalReport = (): TradingReport => {
      analyzer['processFinalize']();
      return emitSpy.mock.lastCall![1];
    };
    /** The round trips emitted with ROUNDTRIP_COMPLETED_EVENT */
    const emittedRoundTrips = (): RoundTrip[] =>
      deferredEmitSpy.mock.calls.filter(([name]) => name === ROUNDTRIP_COMPLETED_EVENT).map(([, roundTrip]) => roundTrip);

    beforeEach(async () => {
      const actualPortfolio = await vi.importActual<typeof import('@utils/portfolio/portfolio.utils')>('@utils/portfolio/portfolio.utils');
      const actualStats = await vi.importActual<typeof import('@utils/finance/stats.utils')>('@utils/finance/stats.utils');
      const actualMath = await vi.importActual<typeof import('@utils/math/math.utils')>('@utils/math/math.utils');
      vi.mocked(calculatePairEquity).mockImplementation(actualPortfolio.calculatePairEquity);
      vi.mocked(getAssetBalance).mockImplementation(actualPortfolio.getAssetBalance);
      vi.mocked(stdev).mockImplementation(actualMath.stdev);
      for (const [name, implementation] of Object.entries(actualStats))
        if (typeof implementation === 'function')
          vi.mocked(statsUtils[name as keyof typeof statsUtils] as any).mockImplementation(implementation);
      emitSpy = vi.spyOn(analyzer as any, 'emit').mockImplementation(async () => {});
      deferredEmitSpy = vi.spyOn(analyzer as any, 'addDeferredEmit');
    });

    describe('when the portfolioUpdates filter of the Trader holds back the portfolio changes of a small round trip', () => {
      // 1 BTC and 100,000 USDT. The warmup of 0 candles ends with the first bucket, at 10,000: the period runs from minute 1 to 3. The
      // strategy buys 0.005 BTC at that close, with a fee of 0.035 USDT, and sells it at 12,000 a minute later, with a fee of 0.042
      // USDT. With the filter of the example configuration (threshold 1 %, dust 10), neither report sends a portfolio change: the
      // orders alone carry the portfolio after them.
      let report: TradingReport;
      beforeEach(() => {
        runMinute(0, 10_000, { completesWarmup: true });
        analyzer.onPortfolioChange([holding(1, 100_000)]);
        analyzer.onOrderCompleted([filled('BUY', 1, 10_000, 0.005, 0.035, holding(1.005, 99_949.965))]);
        runMinute(1, 12_000);
        analyzer.onOrderCompleted([filled('SELL', 2, 12_000, 0.005, 0.042, holding(1, 100_009.923))]);
        runMinute(2, 12_000);
        report = finalReport();
      });

      it.each`
        field             | expected       | description
        ${'startBalance'} | ${110_000}     | ${'1 BTC at 10,000 and 100,000 USDT'}
        ${'finalBalance'} | ${112_009.923} | ${'the portfolio after the SELL at the last close, not that of the last portfolio change'}
        ${'netProfit'}    | ${2_009.923}   | ${'the BTC held, up by 2,000, and the round trip, up by 10 less 0.077 of fees'}
        ${'exposurePct'}  | ${50}          | ${'a round trip of a minute in a period of two'}
        ${'tradeCount'}   | ${2}           | ${'the BUY and the SELL'}
        ${'winRate'}      | ${100}         | ${'one round trip, a win'}
      `('should report $field $expected: $description', ({ field, expected }) => {
        expect(report[field as keyof TradingReport]).toBeCloseTo(expected, 6);
      });

      it('should measure the P&L of the round trip from the pair equity before the BUY to the pair equity after the SELL', () => {
        expect(emittedRoundTrips()[0].pnl).toBeCloseTo(2_009.923, 6);
      });
    });

    describe('when a BUY of the warmup is still open when it completes', () => {
      // A warmup of 9 candles: the bucket of minute 9 completes it, and the period runs from minute 10 to minute 20. The init of the
      // strategy buys 10 BTC with 1,000 USDT at the close of minute 0, at 100. The price rises to 110 by the end of the warmup, dips to
      // 99 at minute 11, and the strategy sells the 10 BTC at 120 at the close of minute 12.
      let report: TradingReport;
      beforeEach(() => {
        runMinute(0, 100);
        analyzer.onPortfolioChange([holding(0, 1_000), holding(10, 0)]);
        analyzer.onOrderCompleted([filled('BUY', 1, 100, 10, 0, holding(10, 0))]);
        runMinutes(1, 8, 105);
        runMinute(9, 110, { completesWarmup: true });
        runMinute(10, 110);
        runMinute(11, 110, { low: 99 });
        runMinute(12, 120);
        analyzer.onPortfolioChange([holding(0, 1_200)]);
        analyzer.onOrderCompleted([filled('SELL', 13, 120, 10, 0, holding(0, 1_200))]);
        runMinutes(13, 19, 120);
        report = finalReport();
      });

      it.each`
        field            | expected       | description
        ${'entryAt'}     | ${10 * MINUTE} | ${'the start of the period'}
        ${'entryPrice'}  | ${110}         | ${'the start price'}
        ${'entryEquity'} | ${1_100}       | ${'the start equity'}
        ${'pnl'}         | ${100}         | ${'from the start equity, not from the BUY of the warmup'}
        ${'profit'}      | ${100 / 11}    | ${'that P&L, in % of the start equity'}
        ${'duration'}    | ${3 * MINUTE}  | ${'from the start of the period to the SELL'}
      `('should emit its round trip with $field $expected: $description', ({ field, expected }) => {
        expect(emittedRoundTrips()[0][field as keyof RoundTrip]).toBeCloseTo(expected, 10);
      });

      it('should measure its adverse excursion from the start price: 10 %, not 1 % from the price of the BUY', () => {
        expect(report.topMAEs).toEqual([10]);
      });

      it.each`
        field             | expected | description
        ${'startBalance'} | ${1_100} | ${'10 BTC at the start price'}
        ${'finalBalance'} | ${1_200} | ${'1,200 USDT'}
        ${'netProfit'}    | ${100}   | ${'that of the round trip'}
        ${'exposurePct'}  | ${30}    | ${'3 minutes of the 10 of the period, not 120 % from the BUY of the warmup'}
        ${'tradeCount'}   | ${1}     | ${'the SELL alone, the BUY of the warmup left out'}
        ${'winRate'}      | ${100}   | ${'one round trip, a win'}
      `('should report $field $expected: $description', ({ field, expected }) => {
        expect(report[field as keyof TradingReport]).toBeCloseTo(expected, 10);
      });
    });

    describe('when the position bought during the warmup is still held at the end', () => {
      // As the reviewer's run: 10 BTC bought at 100 at the close of minute 0, the price unmoved, the period from minute 10 to 20
      let report: TradingReport;
      beforeEach(() => {
        runMinute(0, 100);
        analyzer.onPortfolioChange([holding(0, 1_000), holding(10, 0)]);
        analyzer.onOrderCompleted([filled('BUY', 1, 100, 10, 0, holding(10, 0))]);
        runMinutes(1, 8, 100);
        runMinute(9, 100, { completesWarmup: true });
        runMinutes(10, 19, 100);
        report = finalReport();
      });

      it.each`
        field             | expected | description
        ${'exposurePct'}  | ${100}   | ${'the whole period, not 190 % from the BUY of the warmup'}
        ${'tradeCount'}   | ${0}     | ${'no trade during the period'}
        ${'winRate'}      | ${null}  | ${'no round trip closed'}
        ${'finalBalance'} | ${1_000} | ${'10 BTC at 100'}
        ${'netProfit'}    | ${0}     | ${'the price unmoved'}
      `('should report $field $expected: $description', ({ field, expected }) => {
        expect(report[field as keyof TradingReport]).toBe(expected);
      });
    });

    describe('when a round trip opens and ends during the warmup', () => {
      // 10 BTC bought at 100 at the close of minute 0 and sold at 110 at the close of minute 7, during the warmup of 9 candles: the
      // period, from minute 10 to 12, starts flat
      let report: TradingReport;
      beforeEach(() => {
        runMinute(0, 100);
        analyzer.onPortfolioChange([holding(0, 1_000), holding(10, 0)]);
        analyzer.onOrderCompleted([filled('BUY', 1, 100, 10, 0, holding(10, 0))]);
        runMinutes(1, 6, 100);
        runMinute(7, 110);
        analyzer.onPortfolioChange([holding(0, 1_100)]);
        analyzer.onOrderCompleted([filled('SELL', 8, 110, 10, 0, holding(0, 1_100))]);
        runMinute(8, 110);
        runMinute(9, 110, { completesWarmup: true });
        runMinutes(10, 11, 110);
        report = finalReport();
      });

      it.each`
        field            | expected | description
        ${'netProfit'}   | ${0}     | ${'the period starts once the round trip is over'}
        ${'winRate'}     | ${null}  | ${'its round trip left out, not a win rate of 100 %'}
        ${'exposurePct'} | ${0}     | ${'none of its time, not 350 %'}
        ${'tradeCount'}  | ${0}     | ${'none of its trades'}
        ${'volatility'}  | ${0}     | ${'no return of a round trip'}
      `('should report $field $expected: $description', ({ field, expected }) => {
        expect(report[field as keyof TradingReport]).toBe(expected);
      });

      it('should still have emitted its round trip, when it ended', () => {
        expect(emittedRoundTrips()).toHaveLength(1);
      });
    });

    // The empty portfolio the Trader starts with, which the end of an order carries until one of its synchronizations succeeds
    const NOT_FETCHED = { portfolio: new Map(), price: 100 };
    describe.each`
      end                             | deliver
      ${'ends in error'}              | ${() => analyzer.onOrderErrored([{ ...errored(1), exchange: NOT_FETCHED }])}
      ${'is canceled without a fill'} | ${() => analyzer.onOrderCanceled([{ ...canceled('BUY', 1, 0, 100), exchange: NOT_FETCHED }])}
    `('when an order $end during the warmup, before any synchronization of the Trader succeeds', ({ deliver }) => {
      // The exchange is out of reach at the start: the order the init of the strategy places at the close of minute 0 ends with the
      // empty portfolio the Trader starts with. The bucket of minute 1 completes the warmup, at 100, and the first portfolio fetched
      // comes after it: 1,000 USDT.
      let report: TradingReport;
      beforeEach(() => {
        runMinute(0, 100);
        deliver();
        runMinute(1, 100, { completesWarmup: true });
        analyzer.onPortfolioChange([holding(0, 1_000)]);
        runMinute(2, 110);
        report = finalReport();
      });

      it.each`
        field             | expected
        ${'startBalance'} | ${1_000}
        ${'finalBalance'} | ${1_000}
      `(
        'should report $field $expected, from the first portfolio fetched, not the empty report of a start equity of 0',
        ({ field, expected }) => {
          expect(report[field as keyof TradingReport]).toBe(expected);
        },
      );
    });

    describe('when a BUY is canceled after a partial fill', () => {
      // The warmup of 0 candles ends with the first bucket: the period runs from minute 1 to 4, from 1,000 USDT. A BUY of 10 BTC at 100
      // fills 4 of them before the strategy cancels it, at the close of minute 1; it sells the 4 BTC at 110 at the close of minute 2.
      let report: TradingReport;
      beforeEach(() => {
        runMinute(0, 100, { completesWarmup: true });
        analyzer.onPortfolioChange([holding(0, 1_000)]);
        runMinute(1, 100);
        analyzer.onPortfolioChange([holding(4, 600)]);
        analyzer.onOrderCanceled([canceledAfterFill('BUY', 2, 100, 4, holding(4, 600))]);
        runMinute(2, 110);
        analyzer.onPortfolioChange([holding(0, 1_040)]);
        analyzer.onOrderCompleted([filled('SELL', 3, 110, 4, 0, holding(0, 1_040))]);
        runMinute(3, 110);
        report = finalReport();
      });

      it.each`
        field            | expected | description
        ${'entryEquity'} | ${1_000} | ${'4 BTC at 100 and 600 USDT'}
        ${'exitEquity'}  | ${1_040} | ${'1,040 USDT'}
        ${'pnl'}         | ${40}    | ${'4 BTC bought at 100, sold at 110'}
      `('should emit the round trip of the part filled with $field $expected: $description', ({ field, expected }) => {
        expect(emittedRoundTrips()[0][field as keyof RoundTrip]).toBe(expected);
      });

      it.each`
        field           | expected | description
        ${'tradeCount'} | ${2}     | ${'the part filled and the SELL, not the SELL skipped while flat'}
        ${'winRate'}    | ${100}   | ${'one round trip, a win'}
        ${'netProfit'}  | ${40}    | ${'that of the round trip'}
      `('should report $field $expected: $description', ({ field, expected }) => {
        expect(report[field as keyof TradingReport]).toBe(expected);
      });
    });
  });
});
