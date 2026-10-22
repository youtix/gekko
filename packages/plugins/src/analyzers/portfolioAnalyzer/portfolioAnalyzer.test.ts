import { EQUITY_SNAPSHOT_EVENT, PERFORMANCE_REPORT_EVENT } from '@gekko/shared/constants/event.const';
import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { Asset } from '@gekko/shared/models/utility.types';
import { config } from '@gekko/core/configuration/configuration';
import { error, info, warning } from '@gekko/core/logger/logger';
import { calculatePortfolioTotalValue, createEmptyPortfolio } from '@gekko/shared/helpers/portfolio/portfolio.helper';
import { omit } from 'lodash-es';
import { beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { PortfolioAnalyzer } from './portfolioAnalyzer';
import { EMPTY_PORTFOLIO_REPORT } from './portfolioAnalyzer.const';
import { PortfolioReport } from './portfolioAnalyzer.types';
import { logPortfolioReport } from './portfolioAnalyzer.helper';

// Mock dependencies
vi.mock('./portfolioAnalyzer.helper', () => ({
  logPortfolioReport: vi.fn(),
}));

vi.mock('@gekko/core/configuration/configuration', () => ({
  config: {
    getWatch: vi.fn(),
    getStrategy: vi.fn(),
  },
}));

vi.mock('@gekko/core/logger/logger', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// The actual valuation, watched: how often the analyzer values a portfolio, and with what
vi.mock('@gekko/shared/helpers/portfolio/portfolio.helper', async importOriginal => {
  const actual = await importOriginal<typeof import('@gekko/shared/helpers/portfolio/portfolio.helper')>();
  return { ...actual, calculatePortfolioTotalValue: vi.fn(actual.calculatePortfolioTotalValue) };
});

/** The bucket of a minute, or the timeframe bucket of a 1m timeframe, its candles closing at the given prices */
const bucketAt = (minute: number, btc: number, eth = 10) => {
  const bucket = new Map() as CandleBucket;
  bucket.set('BTC/USDT', { start: minute * ONE_MINUTE, open: btc, high: btc, low: btc, close: btc, volume: 1 });
  bucket.set('ETH/USDT', { start: minute * ONE_MINUTE, open: eth, high: eth, low: eth, close: eth, volume: 1 });
  return bucket;
};
/** A portfolio holding these amounts and nothing else */
const holding = (btc: number, eth = 0, usdt = 0): Portfolio =>
  new Map([
    ['BTC', { total: btc, free: btc, used: 0 }],
    ['ETH', { total: eth, free: eth, used: 0 }],
    ['USDT', { total: usdt, free: usdt, used: 0 }],
  ]);

describe('PortfolioAnalyzer', () => {
  let analyzer: PortfolioAnalyzer;
  let emitSpy: MockInstance;
  let deferredEmitSpy: MockInstance;

  beforeEach(() => {
    vi.mocked(config.getWatch).mockReturnValue({
      assets: ['BTC', 'ETH'],
      currency: 'USDT',
      timeframe: '1m',
      mode: 'backtest',
      warmup: { candleCount: 0 },
      pairs: [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }],
    } as any);

    analyzer = new PortfolioAnalyzer({ enableConsoleTable: false, name: 'PortfolioAnalyzer', riskFreeReturn: 5 });

    // Performance report uses `emit`, Equity Snapshot uses `addDeferredEmit`
    emitSpy = vi.spyOn(analyzer as any, 'emit').mockImplementation(() => {});
    deferredEmitSpy = vi.spyOn(analyzer as any, 'addDeferredEmit').mockImplementation(() => {});
  });

  describe('Configuration', () => {
    it.each`
      property                | expected
      ${'riskFreeReturn'}     | ${5}
      ${'enableConsoleTable'} | ${false}
      ${'benchmarkAsset'}     | ${'SOL'}
    `('should use default config values and fallback - $property = $expected', ({ property, expected }) => {
      vi.mocked(config.getWatch).mockReturnValue({
        assets: ['SOL', 'ETH'],
        currency: 'USDT',
        timeframe: '1m',
        mode: 'backtest',
        warmup: { candleCount: 0 },
        pairs: [{ symbol: 'SOL/USDT' }, { symbol: 'ETH/USDT' }],
      } as any);

      const analyzerObj = new PortfolioAnalyzer({ name: 'PortfolioAnalyzer' } as any);
      expect((analyzerObj as any)[property]).toBe(expected);
    });
  });

  describe('Benchmark', () => {
    // Each asset moves its own way from the close that completes the warmup to the last one: the figures of a report tell which asset
    // it measured the market against
    const CLOSES: Record<Asset, { start: number; end: number }> = {
      BTC: { start: 100, end: 200 },
      ETH: { start: 10, end: 15 },
      SOL: { start: 20, end: 25 },
    };
    /** The bucket of a minute, the candle of each watched asset's pair closing at the price given */
    const bucketOf = (minute: number, assets: Asset[], priceOf: (asset: Asset) => number) => {
      const bucket = new Map() as CandleBucket;
      for (const asset of assets) {
        const price = priceOf(asset);
        bucket.set(`${asset}/USDT`, { start: minute * ONE_MINUTE, open: price, high: price, low: price, close: price, volume: 1 });
      }
      return bucket;
    };
    /** An analyzer built while the configuration watches these assets on USDT, with that benchmarkAsset option */
    const analyzerWatching = (assets: Asset[], benchmarkAsset?: Asset) => {
      vi.mocked(config.getWatch).mockReturnValue({
        assets,
        currency: 'USDT',
        timeframe: '1m',
        mode: 'backtest',
        warmup: { candleCount: 0 },
        pairs: assets.map(asset => ({ symbol: `${asset}/USDT` })),
      } as any);
      return new PortfolioAnalyzer({ enableConsoleTable: false, name: 'PortfolioAnalyzer', riskFreeReturn: 5, benchmarkAsset });
    };
    /**
     * The report of a run holding 1000 USDT, its events in the order the pipeline delivers them (see PluginsStream): the bucket of minute
     * 1 completes the warmup at the start closes, the bucket of minute 2 closes the next timeframe candle at the end closes
     */
    const reportOf = (assets: Asset[], benchmarkAsset?: Asset): PortfolioReport => {
      const benchmarked = analyzerWatching(assets, benchmarkAsset);
      const emit: MockInstance = vi.spyOn(benchmarked as any, 'emit').mockImplementation(() => {});
      const firstBucket = bucketOf(1, assets, asset => CLOSES[asset].start);
      (benchmarked as any).processOneMinuteBucket(firstBucket);
      benchmarked.onStrategyWarmupCompleted([firstBucket]);
      benchmarked.onTimeframeCandle([firstBucket]);
      benchmarked.onPortfolioChange([holding(0, 0, 1000)]);
      const lastBucket = bucketOf(2, assets, asset => CLOSES[asset].end);
      (benchmarked as any).processOneMinuteBucket(lastBucket);
      benchmarked.onTimeframeCandle([lastBucket]);
      (benchmarked as any).processFinalize();
      return emit.mock.lastCall![1];
    };

    it.each`
      scenario                                 | assets            | benchmarkAsset | field                | expected | description
      ${'BTC and ETH are watched, no option'}  | ${['BTC', 'ETH']} | ${undefined}   | ${'benchmarkAsset'}  | ${'BTC'} | ${'BTC, watched'}
      ${'BTC and ETH are watched, no option'}  | ${['BTC', 'ETH']} | ${undefined}   | ${'marketReturnPct'} | ${100}   | ${'BTC from 100 to 200'}
      ${'ETH and SOL are watched, no option'}  | ${['ETH', 'SOL']} | ${undefined}   | ${'benchmarkAsset'}  | ${'ETH'} | ${'the first asset, BTC not being watched'}
      ${'ETH and SOL are watched, no option'}  | ${['ETH', 'SOL']} | ${undefined}   | ${'marketReturnPct'} | ${50}    | ${'ETH from 10 to 15'}
      ${'BTC and ETH are watched, option ETH'} | ${['BTC', 'ETH']} | ${'ETH'}       | ${'benchmarkAsset'}  | ${'ETH'} | ${'the asset of the option'}
      ${'BTC and ETH are watched, option ETH'} | ${['BTC', 'ETH']} | ${'ETH'}       | ${'startPrice'}      | ${10}    | ${'the close of ETH ending the warmup'}
      ${'BTC and ETH are watched, option ETH'} | ${['BTC', 'ETH']} | ${'ETH'}       | ${'endPrice'}        | ${15}    | ${'the last close of ETH'}
      ${'BTC and ETH are watched, option ETH'} | ${['BTC', 'ETH']} | ${'ETH'}       | ${'marketReturnPct'} | ${50}    | ${'ETH from 10 to 15, while BTC doubled'}
    `('should report $field $expected when $scenario: $description', ({ assets, benchmarkAsset, field, expected }) => {
      expect(reportOf(assets, benchmarkAsset)[field as keyof PortfolioReport]).toBe(expected);
    });

    // As the plugins are built, before any candle: main() reports it in one line, and the run exits with code 1
    const REFUSAL = '[PORTFOLIO ANALYZER] benchmarkAsset must be one of the watched assets (BTC and ETH), got "SOL"';

    it(`should refuse a benchmarkAsset that is not watched: ${REFUSAL}`, () => {
      expect(() => analyzerWatching(['BTC', 'ETH'], 'SOL')).toThrowError(expect.objectContaining({ message: REFUSAL }));
    });

    it('should refuse it with a GekkoError', () => {
      expect(() => analyzerWatching(['BTC', 'ETH'], 'SOL')).toThrowError(GekkoError);
    });
  });

  describe('MTM Valuation', () => {
    it.each`
      btcAmount | ethAmount | usdtAmount | expectedEquity
      ${1}      | ${2}      | ${10000}   | ${66000}
      ${0}      | ${0}      | ${1000}    | ${1000}
    `(
      'should mark the portfolio at the closes of a timeframe candle after warmup ($expectedEquity)',
      ({ btcAmount, ethAmount, usdtAmount, expectedEquity }) => {
        (analyzer as any).processOneMinuteBucket(bucketAt(1, 1000));
        analyzer.onPortfolioChange([holding(btcAmount, ethAmount, usdtAmount)]);
        analyzer.onStrategyWarmupCompleted([bucketAt(1, 1000)]);
        (analyzer as any).processOneMinuteBucket(bucketAt(2, 50000, 3000));
        analyzer.onTimeframeCandle([bucketAt(2, 50000, 3000)]);

        const curve = (analyzer as any).equityCurve;
        expect(curve[curve.length - 1].totalValue).toBe(expectedEquity);
      },
    );

    it('should skip valuation if prices are missing (startEquity)', () => {
      const portfolio: Portfolio = new Map([['BTC', { total: 1, free: 1, used: 0 }]]);
      (analyzer as any).warmupCompleted = true;
      analyzer.onPortfolioChange([portfolio]);
      expect((analyzer as any).startEquity).toBeNull();
    });

    it('should not update equityCurve if prices are missing', () => {
      const portfolio: Portfolio = new Map([['BTC', { total: 1, free: 1, used: 0 }]]);
      analyzer.onPortfolioChange([portfolio]);
      expect((analyzer as any).equityCurve.length).toBe(0);
    });
  });

  describe('Reporting', () => {
    it('should emit empty report if insufficient data', () => {
      (analyzer as any).processFinalize();
      expect(emitSpy).toHaveBeenCalledWith(PERFORMANCE_REPORT_EVENT, EMPTY_PORTFOLIO_REPORT);
    });

    it('should say why the run was interrupted in the report', () => {
      (analyzer as any).processFinalize(new Error('a stream upstream failed'));
      expect(emitSpy).toHaveBeenCalledWith(PERFORMANCE_REPORT_EVENT, {
        ...EMPTY_PORTFOLIO_REPORT,
        interruption: 'a stream upstream failed',
      });
    });

    it('should log warning if insufficient data', () => {
      (analyzer as any).processFinalize();
      expect(warning).toHaveBeenCalledWith('portfolio analyzer', expect.stringContaining('Insufficient data'));
    });

    it('should use console table log if enabled', () => {
      const tableAnalyzer = new PortfolioAnalyzer({ enableConsoleTable: true, name: 'PortfolioAnalyzer', riskFreeReturn: 5 });
      (tableAnalyzer as any).processFinalize();
      expect(logPortfolioReport).toHaveBeenCalled();
    });

    // The table prints the reason above it (see logPortfolioReport), in place of the info line that carried it
    it('should hand the table the reason the run stopped before its end', () => {
      const tableAnalyzer = new PortfolioAnalyzer({ enableConsoleTable: true, name: 'PortfolioAnalyzer', riskFreeReturn: 5 });
      (tableAnalyzer as any).processFinalize(new Error('a stream upstream failed'));
      expect(logPortfolioReport).toHaveBeenCalledWith({ ...EMPTY_PORTFOLIO_REPORT, interruption: 'a stream upstream failed' }, 'USDT');
    });

    // The actual emit, which calls the listeners of the report one after the other, each awaited
    describe('with the listeners of the performance report', () => {
      beforeEach(() => {
        emitSpy.mockRestore();
      });

      it('should end its finalization once a listener is done with the report', async () => {
        const done: string[] = [];
        analyzer.on(PERFORMANCE_REPORT_EVENT, async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          done.push('report written');
        });
        await analyzer.processCloseStream();
        expect(done).toEqual(['report written']);
      });

      // The line has a tag of its own: a GekkoError is quoted without its tag
      it.each`
        failure                       | listener                                                                     | message
        ${'an Error'}                 | ${() => Promise.reject(new Error('disk full'))}                              | ${'A listener failed on the performance report: disk full'}
        ${'a GekkoError'}             | ${() => Promise.reject(new GekkoError('performance reporter', 'disk full'))} | ${'A listener failed on the performance report: disk full'}
        ${'a value that is no Error'} | ${() => Promise.reject({ errno: -13 })}                                      | ${'A listener failed on the performance report: { errno: -13 }'}
      `('should log a listener that fails with $failure: $message', async ({ listener, message }) => {
        analyzer.on(PERFORMANCE_REPORT_EVENT, listener);
        await analyzer.processCloseStream();
        expect(error).toHaveBeenCalledWith('portfolio analyzer', message);
      });

      it('should end its finalization when a listener fails, the report logged', async () => {
        analyzer.on(PERFORMANCE_REPORT_EVENT, () => Promise.reject(new Error('disk full')));
        await expect(analyzer.processCloseStream()).resolves.toBeUndefined();
      });
    });

    it('should handle zero elapsed years and zero volatility with one snapshot (volatility check)', () => {
      (analyzer as any).startEquity = 1000;
      (analyzer as any).dates.start = 1000;
      (analyzer as any).dates.end = 1000;
      (analyzer as any).recordSnapshot(1000, 1000);

      const report = (analyzer as any).calculateReportStatistics();
      expect(report.volatility).toBe(0);
    });

    it('should handle zero elapsed years and zero volatility with one snapshot (profit check)', () => {
      (analyzer as any).startEquity = 1000;
      (analyzer as any).dates.start = 1000;
      (analyzer as any).dates.end = 1000;
      (analyzer as any).recordSnapshot(1000, 1000);

      const report = (analyzer as any).calculateReportStatistics();
      expect(report.annualizedNetProfit).toBe(0);
    });

    describe('Metrics calculation on Finalize', () => {
      // In the order the pipeline delivers the events (see PluginsStream): each bucket closes a timeframe candle (1m timeframe), whose
      // event comes after it, and before the portfolio the Trader reads in that bucket
      const YEAR = 31536000000;
      const runMinute = (start: number, btc: number) => {
        const bucket = new Map() as CandleBucket;
        bucket.set('BTC/USDT', { start, open: btc, high: btc, low: btc, close: btc, volume: 1 });
        bucket.set('ETH/USDT', { start, open: 10, high: 10, low: 10, close: 10, volume: 1 });
        (analyzer as any).processOneMinuteBucket(bucket);
        return bucket;
      };

      beforeEach(() => {
        // The first bucket completes the warmup: the period starts at its end, the portfolio holding 1000 USDT
        const firstBucket = runMinute(1000, 100);
        analyzer.onStrategyWarmupCompleted([firstBucket]);
        analyzer.onTimeframeCandle([firstBucket]);
        analyzer.onPortfolioChange([new Map([['USDT', { total: 1000, free: 1000, used: 0 }]])]);

        // A year later, 5 BTC bought at 110
        analyzer.onTimeframeCandle([runMinute(1000 + YEAR, 110)]);
        analyzer.onPortfolioChange([
          new Map([
            ['BTC', { total: 5, free: 5, used: 0 }],
            ['USDT', { total: 450, free: 450, used: 0 }],
          ]),
        ]);

        // Two years later, BTC at 200: an equity of 1450
        analyzer.onTimeframeCandle([runMinute(1000 + 2 * YEAR, 200)]);

        // Finalize
        (analyzer as any).processFinalize();
      });

      it.each`
        field               | expected | description
        ${'netProfit'}      | ${450}   | ${'from 1000 USDT to 1450'}
        ${'totalReturnPct'} | ${45}    | ${'450 of 1000'}
        ${'benchmarkAsset'} | ${'BTC'} | ${'BTC, watched'}
        ${'periodStartAt'}  | ${61000} | ${'the end of the bucket that completed the warmup'}
        ${'exposurePct'}    | ${50}    | ${'BTC held through the second year of the two'}
      `('should emit a report with $field $expected: $description', ({ field, expected }) => {
        expect(emitSpy).toHaveBeenCalledWith(PERFORMANCE_REPORT_EVENT, expect.objectContaining({ [field]: expected }));
      });
    });

    describe('Final report log', () => {
      beforeEach(() => {
        (analyzer as any).startEquity = 1000;
        (analyzer as any).recordSnapshot(1000, 1000);
        (analyzer as any).recordSnapshot(2000, 1100);
        (analyzer as any).processFinalize();
      });

      it('should log the report without its equity curve', () => {
        expect(vi.mocked(info).mock.lastCall![1]).not.toHaveProperty('equityCurve');
      });

      it('should log the number of equity snapshots', () => {
        expect(info).toHaveBeenCalledWith('portfolio analyzer', expect.objectContaining({ equityCurveLength: 2 }));
      });

      it('should log every other field of the emitted report', () => {
        expect(info).toHaveBeenCalledWith('portfolio analyzer', expect.objectContaining(omit(emitSpy.mock.lastCall![1], 'equityCurve')));
      });

      it('should emit the report with its whole equity curve', () => {
        expect(emitSpy).toHaveBeenCalledWith(
          PERFORMANCE_REPORT_EVENT,
          expect.objectContaining({
            equityCurve: [
              { date: 1000, totalValue: 1000 },
              { date: 2000, totalValue: 1100 },
            ],
          }),
        );
      });
    });

    it('should handle benchmark return calculation with missing data (0 startPrice)', () => {
      (analyzer as any).startEquity = 1000;
      (analyzer as any).recordSnapshot(1000, 1100);
      (analyzer as any).recordSnapshot(2000, 1100);

      (analyzer as any).startBenchmarkPrice = 0;
      (analyzer as any).endBenchmarkPrice = 100;

      const report = (analyzer as any).calculateReportStatistics();
      expect(report.marketReturnPct).toBe(0);
    });
  });

  describe('Events', () => {
    // The events come in the order the pipeline delivers them (see PluginsStream): the timeframe candle after its bucket
    const runMinute = (minute: number, btc: number) => {
      (analyzer as any).processOneMinuteBucket(bucketAt(minute, btc));
      analyzer.onTimeframeCandle([bucketAt(minute, btc)]);
    };

    it('should send each point of the equity curve to the live dashboards, deferred', () => {
      analyzer.onPortfolioChange([holding(1)]);
      (analyzer as any).processOneMinuteBucket(bucketAt(1, 100));
      analyzer.onStrategyWarmupCompleted([bucketAt(1, 100)]);
      analyzer.onTimeframeCandle([bucketAt(1, 100)]);
      runMinute(2, 200);
      expect(deferredEmitSpy.mock.calls).toEqual([
        [EQUITY_SNAPSHOT_EVENT, { date: 2 * ONE_MINUTE, totalValue: 100 }],
        [EQUITY_SNAPSHOT_EVENT, { date: 3 * ONE_MINUTE, totalValue: 200 }],
      ]);
    });

    it('should send no point before the warmup completes', () => {
      runMinute(1, 100);
      analyzer.onPortfolioChange([holding(1)]);
      runMinute(2, 200);
      expect(deferredEmitSpy).not.toHaveBeenCalled();
    });

    it('should send no point while a price is missing', () => {
      // The bucket that completes the warmup has no ETH candle: no price yet for the ETH held
      const withoutEth = bucketAt(1, 100);
      withoutEth.delete('ETH/USDT');
      analyzer.onPortfolioChange([holding(0, 1)]);
      (analyzer as any).processOneMinuteBucket(withoutEth);
      analyzer.onStrategyWarmupCompleted([withoutEth]);
      analyzer.onTimeframeCandle([withoutEth]);
      expect(deferredEmitSpy).not.toHaveBeenCalled();
    });

    it('should not send the last point of the curve, which nothing would deliver once the run has ended', () => {
      analyzer.onPortfolioChange([holding(1)]);
      (analyzer as any).processOneMinuteBucket(bucketAt(1, 100));
      analyzer.onStrategyWarmupCompleted([bucketAt(1, 100)]);
      (analyzer as any).processOneMinuteBucket(bucketAt(2, 200));
      (analyzer as any).processFinalize();
      expect(deferredEmitSpy).not.toHaveBeenCalled();
    });
  });

  describe('Warmup', () => {
    it.each`
      property                 | expected
      ${'warmupCompleted'}     | ${true}
      ${'startBenchmarkPrice'} | ${12345}
    `('should set properties on warmup completed ($property -> $expected)', ({ property, expected }) => {
      const bucket = new Map() as CandleBucket;
      bucket.set('BTC/USDT', { start: 5000, open: 100, high: 100, low: 100, close: 12345, volume: 1 });

      analyzer.onStrategyWarmupCompleted([bucket]);
      expect((analyzer as any)[property]).toBe(expected);
    });

    it('should warn if benchmark candle is missing', () => {
      const bucket = new Map() as CandleBucket;
      analyzer.onStrategyWarmupCompleted([bucket]);
      expect(warning).toHaveBeenCalledWith('portfolio analyzer', expect.stringContaining('Missing benchmark candle'));
    });

    it('should warn if timeframe bucket is missing', () => {
      analyzer.onStrategyWarmupCompleted([]);
      expect(warning).toHaveBeenCalledWith('portfolio analyzer', expect.stringContaining('Missing timeframe bucket'));
    });

    it('should leave startBenchmarkPrice as 0 if missing benchmark candle', () => {
      const bucket = new Map() as CandleBucket;
      analyzer.onStrategyWarmupCompleted([bucket]);
      expect((analyzer as any).startBenchmarkPrice).toBe(0);
    });
  });

  describe('Start equity', () => {
    const runMinute = (minute: number, btc: number, eth?: number) => (analyzer as any).processOneMinuteBucket(bucketAt(minute, btc, eth));
    const completeWarmup = (minute: number, btc: number, eth?: number) => analyzer.onStrategyWarmupCompleted([bucketAt(minute, btc, eth)]);
    const receive = (portfolio: Portfolio) => analyzer.onPortfolioChange([portfolio]);

    // BTC doubles during the warmup, which the bucket of minute 2 completes, then goes on rising. The events come in the order the
    // pipeline delivers them (see PluginsStream): a portfolio the Trader reads arrives after the bucket it was read in, and the one it
    // reads at the end of the warmup after the analyzer has heard of that end.
    const receivedInWarmup = () => {
      runMinute(1, 100);
      receive(holding(1));
      runMinute(2, 200);
      completeWarmup(2, 200);
      receive(holding(1));
    };
    // As with the default warmup of 0 candles: the first portfolio arrives right after the end of the warmup, before the next bucket
    const receivedAtWarmupEnd = () => {
      runMinute(1, 100);
      runMinute(2, 200);
      completeWarmup(2, 200);
      receive(holding(1));
    };
    const receivedAfterWarmup = () => {
      runMinute(1, 100);
      runMinute(2, 200);
      completeWarmup(2, 200);
      runMinute(3, 300);
      receive(holding(1));
    };
    const thenChanged = (run: () => void) => () => {
      run();
      runMinute(4, 400);
      receive(holding(2));
    };

    it('should not be taken from a portfolio received during the warmup', () => {
      runMinute(1, 100);
      receive(holding(1));
      expect((analyzer as any).startEquity).toBeNull();
    });

    it('should not be taken when the warmup completes before any price is known', () => {
      receive(holding(1));
      completeWarmup(2, 200);
      expect((analyzer as any).startEquity).toBeNull();
    });

    it.each`
      btc  | eth  | usdt     | expected
      ${1} | ${2} | ${10000} | ${122000}
      ${0} | ${0} | ${1000}  | ${1000}
    `(
      'should value $btc BTC, $eth ETH and $usdt USDT at the closes that completed the warmup: $expected',
      ({ btc, eth, usdt, expected }) => {
        runMinute(1, 50000, 3000);
        receive(holding(btc, eth, usdt));
        runMinute(2, 100000, 6000);
        completeWarmup(2, 100000, 6000);
        expect((analyzer as any).startEquity).toBe(expected);
      },
    );

    it.each`
      scenario                            | run                                 | expected | description
      ${'in the warmup'}                  | ${receivedInWarmup}                 | ${200}   | ${'at the closes ending the warmup'}
      ${'at the end of the warmup'}       | ${receivedAtWarmupEnd}              | ${200}   | ${'at the closes ending the warmup'}
      ${'after the warmup'}               | ${receivedAfterWarmup}              | ${300}   | ${'late, at the prices known then'}
      ${'in the warmup, then changed'}    | ${thenChanged(receivedInWarmup)}    | ${200}   | ${'unmoved by the later change'}
      ${'after the warmup, then changed'} | ${thenChanged(receivedAfterWarmup)} | ${300}   | ${'unmoved by the later change'}
    `('should be $expected with a portfolio received $scenario: $description', ({ run, expected }) => {
      run();
      expect((analyzer as any).startEquity).toBe(expected);
    });

    it('should warn that it was taken late, at the prices of a later minute, when the first portfolio came after the warmup', () => {
      receivedAfterWarmup();
      expect(warning).toHaveBeenCalledWith(
        'portfolio analyzer',
        expect.stringContaining('start equity taken late, at the prices of 1970-01-01T00:04:00.000Z'),
      );
    });

    it.each`
      scenario                      | run
      ${'in the warmup'}            | ${receivedInWarmup}
      ${'at the end of the warmup'} | ${receivedAtWarmupEnd}
    `('should not warn that it was taken late with a portfolio received $scenario', ({ run }) => {
      run();
      expect(warning).not.toHaveBeenCalledWith('portfolio analyzer', expect.stringContaining('taken late'));
    });

    describe('in a run without trade, BTC doubling during the warmup', () => {
      beforeEach(() => {
        receivedInWarmup();
        (analyzer as any).processFinalize();
      });

      it.each`
        field                | expected
        ${'startEquity'}     | ${200}
        ${'endEquity'}       | ${200}
        ${'netProfit'}       | ${0}
        ${'totalReturnPct'}  | ${0}
        ${'marketReturnPct'} | ${0}
        ${'alpha'}           | ${0}
      `('should report $field $expected', ({ field, expected }) => {
        expect(emitSpy).toHaveBeenCalledWith(PERFORMANCE_REPORT_EVENT, expect.objectContaining({ [field]: expected }));
      });
    });

    describe('in a run from an empty portfolio', () => {
      beforeEach(() => {
        runMinute(1, 100);
        receive(holding(0));
        runMinute(2, 200);
        completeWarmup(2, 200);
        receive(holding(0));
        runMinute(3, 300);
        (analyzer as any).processFinalize();
      });

      it('should emit the empty report', () => {
        expect(emitSpy).toHaveBeenCalledWith(PERFORMANCE_REPORT_EVENT, EMPTY_PORTFOLIO_REPORT);
      });

      it('should warn that a start equity of 0 gives no return to measure', () => {
        expect(warning).toHaveBeenCalledWith('portfolio analyzer', expect.stringContaining('Start equity of 0 USDT: no return to measure'));
      });
    });
  });

  describe('Period', () => {
    // On a 1h timeframe, the bucket of minute 119 completes the warmup: it closes, at minute 120, the hourly candles that started at
    // minute 60. The events come in the order the pipeline delivers them (see PluginsStream).
    const COMPLETING_MINUTE = 119;
    const CANDLE_CLOSE = 120 * ONE_MINUTE;
    const hourlyCandlesBucket = () => bucketAt(60, 100);
    const completeWarmup = (timeframeBucket: CandleBucket) => {
      (analyzer as any).processOneMinuteBucket(bucketAt(COMPLETING_MINUTE, 100));
      analyzer.onStrategyWarmupCompleted([timeframeBucket]);
    };
    /** The report of a run that goes on for that many buckets after the one that completed the warmup */
    const reportAfter = (buckets: number): PortfolioReport => {
      completeWarmup(hourlyCandlesBucket());
      analyzer.onPortfolioChange([holding(1)]);
      for (let minute = COMPLETING_MINUTE + 1; minute <= COMPLETING_MINUTE + buckets; minute++)
        (analyzer as any).processOneMinuteBucket(bucketAt(minute, 100));
      return (analyzer as any).calculateReportStatistics();
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
      buckets | duration           | run
      ${0}    | ${0}               | ${'ends with the warmup'}
      ${1}    | ${ONE_MINUTE}      | ${'goes on for a minute'}
      ${60}   | ${60 * ONE_MINUTE} | ${'goes on for an hour'}
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

    it('should start at the close of the candle that completed the warmup without a candle of the benchmark asset', () => {
      completeWarmup(new Map() as CandleBucket);
      expect((analyzer as any).dates.start).toBe(CANDLE_CLOSE);
    });
  });

  describe('Mark to market', () => {
    // A 1m timeframe: every bucket closes a timeframe candle, whose event the analyzer hears after the bucket, and before the portfolio
    // the Trader reads in that bucket (see PluginsStream). The bucket of minute 1 completes the warmup at a BTC price of 100: the
    // period starts at minute 2. ETH, at 10, is never held.
    const runMinute = (minute: number, btc: number, closesTimeframeCandle = true) => {
      (analyzer as any).processOneMinuteBucket(bucketAt(minute, btc));
      if (closesTimeframeCandle) analyzer.onTimeframeCandle([bucketAt(minute, btc)]);
    };
    const receive = (portfolio: Portfolio) => analyzer.onPortfolioChange([portfolio]);
    const completeWarmup = () => {
      (analyzer as any).processOneMinuteBucket(bucketAt(1, 100));
      analyzer.onStrategyWarmupCompleted([bucketAt(1, 100)]);
      analyzer.onTimeframeCandle([bucketAt(1, 100)]);
    };
    /** A run from that portfolio, received during the warmup */
    const startWith = (portfolio: Portfolio) => {
      runMinute(0, 100);
      receive(portfolio);
      completeWarmup();
    };
    const finalReport = (): PortfolioReport => {
      (analyzer as any).processFinalize();
      return emitSpy.mock.lastCall![1];
    };

    // 1 BTC held through the run, no portfolio change after the warmup: its price doubles
    const holdWhileDoubling = () => {
      startWith(holding(1));
      runMinute(2, 100);
      runMinute(3, 150);
      runMinute(4, 200);
    };
    // 1 BTC bought with 100 USDT at the close of minute 2, sold back at 100 at the close of minute 4: the price halves in between
    const tradeAroundDip = () => {
      startWith(holding(0, 0, 100));
      runMinute(2, 100);
      receive(holding(1));
      runMinute(3, 50);
      runMinute(4, 100);
      receive(holding(0, 0, 100));
      runMinute(5, 100);
    };
    // As tradeAroundDip, but the SELL leaves 0.001 BTC, worth 0.1 % of the equity: an amount below the lot size, which no SELL can sell
    const tradeAroundDipLeavingDust = () => {
      startWith(holding(0, 0, 100));
      runMinute(2, 100);
      receive(holding(1));
      runMinute(3, 50);
      runMinute(4, 100);
      receive(holding(0.001, 0, 99.9));
      runMinute(5, 100);
    };
    // 100 USDT held through the run, while the price of BTC moves: the Trader synchronizes once in between
    const holdCurrency = () => {
      startWith(holding(0, 0, 100));
      runMinute(2, 50);
      receive(holding(0, 0, 100));
      runMinute(3, 200);
    };
    // 0.0001 BTC bought at 100.00004 with 100 USDT, then sold back at that price. The exchanges book a cost to 8 decimals, 0.01 for
    // 0.010000004: the holding is valued 4e-9 above the currency it cost, a peak that the sale at the same price never regains
    const tradeBookedToTheUnit = () => {
      startWith(holding(0, 0, 100));
      runMinute(2, 100.00004);
      receive(holding(0.0001, 0, 99.99));
      runMinute(3, 100.00004);
      receive(holding(0, 0, 100));
      runMinute(4, 100.00004);
      runMinute(5, 100.00004);
    };

    it('should add a point at the close of every timeframe candle, the latest portfolio valued at its closes', () => {
      holdWhileDoubling();
      expect((analyzer as any).equityCurve).toEqual([
        { date: 2 * ONE_MINUTE, totalValue: 100 },
        { date: 3 * ONE_MINUTE, totalValue: 100 },
        { date: 4 * ONE_MINUTE, totalValue: 150 },
        { date: 5 * ONE_MINUTE, totalValue: 200 },
      ]);
    });

    // The dip of tradeAroundDip lasts from the point of the curve dated 3 minutes, the last at the peak, to the one dated 5, back at it
    it.each`
      scenario                                    | run                          | field                  | expected
      ${'holding BTC while its price doubles'}    | ${holdWhileDoubling}         | ${'endEquity'}         | ${200}
      ${'holding BTC while its price doubles'}    | ${holdWhileDoubling}         | ${'netProfit'}         | ${100}
      ${'holding BTC while its price doubles'}    | ${holdWhileDoubling}         | ${'exposurePct'}       | ${100}
      ${'holding BTC while its price doubles'}    | ${holdWhileDoubling}         | ${'marketReturnPct'}   | ${100}
      ${'buying BTC before a dip, selling after'} | ${tradeAroundDip}            | ${'maxDrawdownPct'}    | ${50}
      ${'buying BTC before a dip, selling after'} | ${tradeAroundDip}            | ${'longestDrawdownMs'} | ${2 * ONE_MINUTE}
      ${'buying BTC before a dip, selling after'} | ${tradeAroundDip}            | ${'exposurePct'}       | ${50}
      ${'selling all of it but dust after a dip'} | ${tradeAroundDipLeavingDust} | ${'exposurePct'}       | ${50}
      ${'holding the currency only'}              | ${holdCurrency}              | ${'exposurePct'}       | ${0}
      ${'selling at the price it was bought at'}  | ${tradeBookedToTheUnit}      | ${'maxDrawdownPct'}    | ${0}
      ${'selling at the price it was bought at'}  | ${tradeBookedToTheUnit}      | ${'longestDrawdownMs'} | ${0}
      ${'selling at the price it was bought at'}  | ${tradeBookedToTheUnit}      | ${'volatility'}        | ${0}
      ${'selling at the price it was bought at'}  | ${tradeBookedToTheUnit}      | ${'sharpeRatio'}       | ${0}
    `('should report $field $expected when $scenario', ({ run, field, expected }) => {
      run();
      expect(finalReport()[field as keyof PortfolioReport]).toBe(expected);
    });

    // The exposure and the curve each valued the latest portfolio, at the same prices: twice a timeframe candle, in decimal
    it('should value the portfolio once per timeframe candle', () => {
      startWith(holding(1));
      vi.mocked(calculatePortfolioTotalValue).mockClear();
      runMinute(2, 100);
      runMinute(3, 150);
      runMinute(4, 200);
      expect(calculatePortfolioTotalValue).toHaveBeenCalledTimes(3);
    });

    it('should value the portfolio once at the end of the run', () => {
      startWith(holding(1));
      runMinute(2, 200);
      vi.mocked(calculatePortfolioTotalValue).mockClear();
      finalReport();
      expect(calculatePortfolioTotalValue).toHaveBeenCalledOnce();
    });

    // Not rebuilt from the assets on every call
    it('should value the portfolio with the pairs of the watched assets', () => {
      holdWhileDoubling();
      expect(calculatePortfolioTotalValue).toHaveBeenLastCalledWith(
        expect.any(Map),
        expect.any(Map),
        'USDT',
        ['BTC', 'ETH'],
        ['BTC/USDT', 'ETH/USDT'],
      );
    });

    // 1000 USDT of equity, BTC at 100: at least 1 % of the equity (see DUST_TOLERANCE) is a position, less is dust
    it.each`
      btc     | usdt   | share      | exposurePct
      ${0.05} | ${995} | ${'0.5 %'} | ${0}
      ${0.1}  | ${990} | ${'1 %'}   | ${100}
    `('should count $btc BTC worth $share of the equity as exposed for $exposurePct % of the period', ({ btc, usdt, exposurePct }) => {
      startWith(holding(btc, 0, usdt));
      runMinute(2, 100);
      expect(finalReport().exposurePct).toBe(exposurePct);
    });

    describe('annualization', () => {
      /**
       * 1 BTC held through a run that goes on for that many minutes after the warmup, its price at 110 the first minute, then at 99: a
       * total return of -1 %, and one return per minute, 10 %, -10 %, then 0, whose mean is 0. Annualized by sqrt(returns / years), the
       * standard deviation of the returns is sqrt((100 + 100) / years), their downside deviation sqrt(100 / years). Over a day, 1/365 of
       * a year, the yearly return is -365 % and 5 % less is -370; over two days, -182.5 % and -187.5.
       */
      const holdFor = (minutes: number) => {
        startWith(holding(1));
        for (let minute = 2; minute < 2 + minutes; minute++) runMinute(minute, minute === 2 ? 110 : 99);
        return finalReport();
      };

      it.each`
        minutes | horizon                              | expected
        ${8}    | ${'a day, the period being shorter'} | ${-365}
        ${2880} | ${'the period'}                      | ${-182.5}
      `('should annualize the return of a run of $minutes minutes over $horizon: $expected %', ({ minutes, expected }) => {
        expect(holdFor(minutes).annualizedReturnPct).toBe(expected);
      });

      it.each`
        ratio             | minutes | formula                   | expected
        ${'sharpeRatio'}  | ${8}    | ${'-370 / sqrt(73000)'}   | ${-370 / Math.sqrt(73000)}
        ${'sortinoRatio'} | ${8}    | ${'-370 / sqrt(36500)'}   | ${-370 / Math.sqrt(36500)}
        ${'sharpeRatio'}  | ${2880} | ${'-187.5 / sqrt(36500)'} | ${-187.5 / Math.sqrt(36500)}
        ${'sortinoRatio'} | ${2880} | ${'-187.5 / sqrt(18250)'} | ${-187.5 / Math.sqrt(18250)}
      `(
        'should annualize the $ratio of a run of $minutes minutes over the years that annualize its return: $formula',
        ({ ratio, minutes, expected }) => {
          expect(holdFor(minutes)[ratio as 'sharpeRatio']).toBeCloseTo(expected, 12);
        },
      );

      it('should warn that a run of 8 minutes is annualized over a day', () => {
        holdFor(8);
        expect(warning).toHaveBeenCalledWith('portfolio analyzer', expect.stringContaining('Period shorter than a day'));
      });
    });

    it('should measure the volatility of the returns between two trades', () => {
      tradeAroundDip();
      expect(finalReport().volatility).toBeGreaterThan(0);
    });

    it('should add no point with a portfolio change, which the next timeframe candle marks', () => {
      startWith(holding(1));
      receive(holding(2));
      expect((analyzer as any).equityCurve).toEqual([{ date: 2 * ONE_MINUTE, totalValue: 100 }]);
    });

    describe('when the portfolioUpdates filter of the Trader holds back the portfolio change of a fill', () => {
      // 100 USDT when the warmup completes, BTC at 100. At the close of minute 2, the strategy buys BTC with them: only the end of the
      // order carries the portfolio after it. BTC then doubles.
      const BOUGHT = holding(1);
      const HALF_BOUGHT = holding(0.5, 0, 50);
      const completedBuy = () =>
        analyzer.onOrderCompleted([{ order: { id: 'buy', side: 'BUY', amount: 1 }, exchange: { portfolio: BOUGHT, price: 100 } } as any]);
      const canceledBuy = () =>
        analyzer.onOrderCanceled([
          { order: { id: 'buy', side: 'BUY', amount: 1, filled: 0.5 }, exchange: { portfolio: HALF_BOUGHT, price: 100 } } as any,
        ]);
      // An order can end in error after a partial fill: its event carries the portfolio after it too
      const erroredBuy = () =>
        analyzer.onOrderErrored([
          { order: { id: 'buy', side: 'BUY', amount: 1, reason: 'refused' }, exchange: { portfolio: HALF_BOUGHT, price: 100 } } as any,
        ]);
      const buyHeardThrough = (deliver: () => void) => {
        startWith(holding(0, 0, 100));
        runMinute(2, 100);
        deliver();
        runMinute(3, 200);
      };

      it.each`
        event                                     | deliver         | field            | expected
        ${'its completion'}                       | ${completedBuy} | ${'endEquity'}   | ${200}
        ${'its completion'}                       | ${completedBuy} | ${'netProfit'}   | ${100}
        ${'its completion'}                       | ${completedBuy} | ${'exposurePct'} | ${50}
        ${'its cancelation after a partial fill'} | ${canceledBuy}  | ${'endEquity'}   | ${150}
        ${'its cancelation after a partial fill'} | ${canceledBuy}  | ${'exposurePct'} | ${50}
        ${'its error after a partial fill'}       | ${erroredBuy}   | ${'endEquity'}   | ${150}
        ${'its error after a partial fill'}       | ${erroredBuy}   | ${'exposurePct'} | ${50}
      `('should report $field $expected from the portfolio that $event carries', ({ deliver, field, expected }) => {
        buyHeardThrough(deliver);
        expect(finalReport()[field as keyof PortfolioReport]).toBe(expected);
      });

      it.each`
        event                                     | deliver
        ${'its completion'}                       | ${completedBuy}
        ${'its cancelation after a partial fill'} | ${canceledBuy}
        ${'its error after a partial fill'}       | ${erroredBuy}
      `('should add no point to the curve with $event, which the next timeframe candle marks', ({ deliver }) => {
        startWith(holding(0, 0, 100));
        deliver();
        expect((analyzer as any).equityCurve).toEqual([{ date: 2 * ONE_MINUTE, totalValue: 100 }]);
      });

      it.each`
        event                                     | deliver
        ${'its completion'}                       | ${completedBuy}
        ${'its cancelation after a partial fill'} | ${canceledBuy}
        ${'its error after a partial fill'}       | ${erroredBuy}
      `('should not count $event as a portfolio change', ({ deliver }) => {
        buyHeardThrough(deliver);
        expect(finalReport().portfolioChangeCount).toBe(1);
      });

      it('should value the portfolio of the last order delivered with others', () => {
        startWith(holding(0, 0, 100));
        analyzer.onOrderCompleted([
          { order: { id: 'first' }, exchange: { portfolio: HALF_BOUGHT, price: 100 } } as any,
          { order: { id: 'second' }, exchange: { portfolio: BOUGHT, price: 100 } } as any,
        ]);
        runMinute(2, 200);
        expect(finalReport().endEquity).toBe(200);
      });
    });

    describe('when an order ends before any synchronization of the Trader succeeds', () => {
      // The exchange is out of reach at the start: the end of an order placed during the warmup carries the empty portfolio the
      // Trader starts with. The bucket of minute 1 completes the warmup, and the first portfolio fetched, 100 USDT, comes after it.
      const NOT_FETCHED = { exchange: { portfolio: createEmptyPortfolio(), price: 100 } };
      it.each`
        event               | deliver
        ${'completed'}      | ${() => analyzer.onOrderCompleted([{ order: { id: 'buy' }, ...NOT_FETCHED } as any])}
        ${'canceled'}       | ${() => analyzer.onOrderCanceled([{ order: { id: 'buy', filled: 0 }, ...NOT_FETCHED } as any])}
        ${'ended in error'} | ${() => analyzer.onOrderErrored([{ order: { id: 'buy', reason: 'refused' }, ...NOT_FETCHED } as any])}
      `('should take the start equity from the first portfolio fetched, not from that of an order $event', ({ deliver }) => {
        runMinute(0, 100);
        deliver();
        completeWarmup();
        receive(holding(0, 0, 100));
        runMinute(2, 100);
        expect(finalReport().startEquity).toBe(100);
      });
    });

    it('should take the start equity at the first timeframe candle with every price known when the warmup had none', () => {
      // The buckets up to the one that completes the warmup have no ETH candle: no price for ETH yet, and no portfolio valued
      const withoutEth = (minute: number) => {
        const bucket = bucketAt(minute, 100);
        bucket.delete('ETH/USDT');
        return bucket;
      };
      (analyzer as any).processOneMinuteBucket(withoutEth(0));
      receive(holding(1));
      (analyzer as any).processOneMinuteBucket(withoutEth(1));
      analyzer.onStrategyWarmupCompleted([withoutEth(1)]);
      analyzer.onTimeframeCandle([withoutEth(1)]);
      runMinute(2, 200);
      expect((analyzer as any).startEquity).toBe(200);
    });

    it('should start the curve with the start equity when the first portfolio comes after the warmup', () => {
      runMinute(0, 100);
      completeWarmup();
      receive(holding(1));
      runMinute(2, 200);
      expect((analyzer as any).equityCurve).toEqual([
        { date: 2 * ONE_MINUTE, totalValue: 100 },
        { date: 3 * ONE_MINUTE, totalValue: 200 },
      ]);
    });

    it.each`
      scenario                              | run
      ${'before the warmup completes'}      | ${() => [runMinute(0, 100), receive(holding(1)), runMinute(1, 200)]}
      ${'before any portfolio is received'} | ${() => [runMinute(0, 100), completeWarmup(), runMinute(2, 200)]}
    `('should add no point $scenario', ({ run }) => {
      run();
      expect((analyzer as any).equityCurve).toHaveLength(0);
    });

    describe('at the end of the run', () => {
      it.each`
        lastBucket                      | closesTimeframeCandle
        ${'closes a timeframe candle'}  | ${true}
        ${'closes no timeframe candle'} | ${false}
      `(
        'should end the curve with the latest portfolio at the last prices when the last bucket $lastBucket',
        ({ closesTimeframeCandle }) => {
          startWith(holding(1));
          runMinute(2, 200, closesTimeframeCandle);
          expect(finalReport().equityCurve.at(-1)).toEqual({ date: 3 * ONE_MINUTE, totalValue: 200 });
        },
      );

      it('should end the curve with the portfolio after the fills that followed the last mark', () => {
        startWith(holding(1));
        runMinute(2, 200);
        receive(holding(0, 0, 199)); // sold at 200, with a fee of 1
        expect(finalReport().equityCurve).toEqual([
          { date: 2 * ONE_MINUTE, totalValue: 100 },
          { date: 3 * ONE_MINUTE, totalValue: 199 },
        ]);
      });

      // The last bucket, of minute 3, closes no timeframe candle: a minute since the last mark, of the 2 of the period
      it.each`
        latestPortfolio                           | sell     | exposurePct
        ${'still holds BTC'}                      | ${false} | ${100}
        ${'has sold its BTC since the last mark'} | ${true}  | ${50}
      `('should count the time since the last mark as exposed only when the latest portfolio $latestPortfolio', ({ sell, exposurePct }) => {
        startWith(holding(1));
        runMinute(2, 100);
        if (sell) receive(holding(0, 0, 100));
        runMinute(3, 100, false);
        expect(finalReport().exposurePct).toBe(exposurePct);
      });

      it('should count no exposure before any portfolio is received', () => {
        runMinute(0, 100);
        completeWarmup();
        runMinute(2, 100);
        (analyzer as any).processFinalize();
        expect((analyzer as any).exposureMs).toBe(0);
      });
    });
  });

  describe('Process Bucket', () => {
    it('should throw error if missing candle in bucket', () => {
      const bucket = new Map() as CandleBucket;
      expect(() => {
        (analyzer as any).processOneMinuteBucket(bucket);
      }).toThrowError('Impossible to get first candle from bucket');
    });

    it('should ignore asset with missing candle in bucket', () => {
      const bucket = new Map() as CandleBucket;
      bucket.set('DOGE/USDT' as any, { start: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1 });
      (analyzer as any).processOneMinuteBucket(bucket);
      expect((analyzer as any).latestPrices.size).toBe(0);
    });

    it('should not update end date if warmup is not completed', () => {
      const bucket = new Map() as CandleBucket;
      bucket.set('BTC/USDT' as any, { start: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1 });
      (analyzer as any).warmupCompleted = false;
      (analyzer as any).dates.end = 0;
      (analyzer as any).processOneMinuteBucket(bucket);
      expect((analyzer as any).dates.end).toBe(0);
    });
  });

  describe('Process Init', () => {
    it('should be a noop when processInit is called', () => {
      expect(() => (analyzer as any).processInit()).not.toThrow();
    });
  });

  describe('Static Configuration', () => {
    it('should configure runtime modes', () => {
      const config = PortfolioAnalyzer.getStaticConfiguration();
      expect(config.modes).toEqual(['realtime', 'backtest']);
    });

    it('should declare correct event handlers', () => {
      const config = PortfolioAnalyzer.getStaticConfiguration();
      expect(config.eventsHandlers).toEqual([
        'onPortfolioChange',
        'onOrderCompleted',
        'onOrderCanceled',
        'onOrderErrored',
        'onStrategyWarmupCompleted',
        'onTimeframeCandle',
      ]);
    });

    it('should declare emitted events', () => {
      const config = PortfolioAnalyzer.getStaticConfiguration();
      expect(config.eventsEmitted).toEqual(expect.arrayContaining([PERFORMANCE_REPORT_EVENT, EQUITY_SNAPSHOT_EVENT]));
    });
  });
});
