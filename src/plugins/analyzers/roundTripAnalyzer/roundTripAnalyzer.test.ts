import { PERFORMANCE_REPORT_EVENT, ROUNDTRIP_COMPLETED_EVENT } from '@constants/event.const';
import { ONE_MINUTE, ONE_SECOND } from '@constants/time.const';
import { GekkoError } from '@errors/gekko.error';
import { calculateExposurePct, calculateVolatility } from '@helpers/finance/stats.helper';
import { CandleBucket, OrderCanceledEvent, OrderCompletedEvent, OrderErroredEvent, RoundTrip } from '@models/event.types';
import { OrderSide, OrderType } from '@models/order.types';
import { Portfolio } from '@models/portfolio.types';
import { Asset, TradingPair } from '@models/utility.types';
import { config } from '@services/configuration/configuration';
import { error, info, warning } from '@services/logger';
import { beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import { TradingReport } from './roundTrip.types';
import { RoundTripAnalyzer } from './roundTripAnalyzer';
import { EMPTY_TRADING_REPORT, LATE_FILL_CANDLES, PLUGIN_NAME } from './roundTripAnalyzer.const';
import { logFinalize, logRoundtrip } from './roundTripAnalyzer.helper';

const { watchOf } = vi.hoisted(() => ({
  /** The watch of a run on these assets, each against USDT, on a 1m timeframe */
  watchOf: (assets: string[]) => ({
    pairs: assets.map(asset => ({ symbol: `${asset}/USDT`, timeframe: '1m' })),
    assets,
    currency: 'USDT',
    timeframe: '1m',
    warmup: { candleCount: 100, tickrate: 1000 },
    mode: 'realtime',
    tickrate: 1000,
  }),
}));

vi.mock('@services/logger');
// The portfolio and the math helpers stay actual: the decimal ones work out the equities and the P&L, as in a run. Of the statistics,
// the two the tests read the arguments of are wrapped, their implementations actual.
vi.mock('@helpers/finance/stats.helper', async importOriginal => {
  const actual = await importOriginal<typeof import('@helpers/finance/stats.helper')>();
  return {
    ...actual,
    calculateExposurePct: vi.fn(actual.calculateExposurePct),
    calculateVolatility: vi.fn(actual.calculateVolatility),
  };
});
vi.mock('./roundTripAnalyzer.helper', async importOriginal => ({
  ...(await importOriginal<typeof import('./roundTripAnalyzer.helper')>()),
  logFinalize: vi.fn(),
  logRoundtrip: vi.fn(),
}));
// A run on BTC and ETH, unless a test watches others (see watching)
vi.mock('@services/configuration/configuration', () => {
  const Configuration = vi.fn(function () {
    return {
      getWatch: vi.fn(() => watchOf(['BTC', 'ETH'])),
      getStrategy: vi.fn(() => ({})),
      showLogo: vi.fn(),
      getPlugins: vi.fn(),
      getStorage: vi.fn(),
      getExchange: vi.fn(),
    };
  });
  return { config: new Configuration() };
});

const CONFIG = { name: PLUGIN_NAME, riskFreeReturn: 2, enableConsoleTable: true };
const DAY = 24 * 60 * ONE_MINUTE;

/** The next analyzer built watches these assets, each against USDT */
const watching = (assets: Asset[]) =>
  vi.spyOn(config, 'getWatch').mockReturnValueOnce(watchOf(assets) as ReturnType<typeof config.getWatch>);
/** A portfolio the Trader read, with these balances */
const holding = (balances: Record<string, number>): Portfolio =>
  new Map(Object.entries(balances).map(([asset, total]) => [asset, { free: total, used: 0, total }]));
/** The empty portfolio the Trader starts with, which the end of an order carries until one of its synchronizations succeeds */
const NOT_READ: Portfolio = new Map();
/** The bucket of a minute, or the timeframe bucket of a 1m timeframe: a candle of each pair given, flat at its close but for its low */
const bucketAt = (minute: number, closes: Record<string, number>, lows: Record<string, number> = {}) =>
  new Map(
    Object.entries(closes).map(([symbol, close]) => [
      symbol,
      { start: minute * ONE_MINUTE, open: close, high: close, low: lows[symbol] ?? close, close, volume: 1 },
    ]),
  ) as CandleBucket;
/** An order completed at the given date, with its fee in currency, and the portfolio the Trader read after it */
const completed = (symbol: TradingPair, side: OrderSide, date: number, price: number, amount: number, fee: number, portfolio: Portfolio) =>
  ({
    order: {
      id: `${symbol.split('/')[0]}-${side}-${date / ONE_MINUTE}`,
      symbol,
      side,
      type: 'MARKET',
      price,
      amount,
      fee,
      orderExecutionDate: date,
    },
    exchange: { portfolio, price },
  }) as OrderCompletedEvent;
/**
 * An order of 10 canceled at the given minute after filling that amount, and the portfolio after it: a LIMIT order at the given price
 * unless the test gives another type, and the mean price of its fills when the test gives one, as the Trader relays it
 */
const canceled = (
  symbol: TradingPair,
  side: OrderSide,
  minute: number,
  filled: number | undefined,
  portfolio: Portfolio,
  { type = 'LIMIT', price, fillPrice }: { type?: OrderType; price?: number; fillPrice?: number } = {},
) =>
  ({
    order: {
      id: `${symbol.split('/')[0]}-${side}-${minute}`,
      symbol,
      side,
      type,
      price,
      amount: 10,
      filled,
      fillPrice,
      orderCancelationDate: minute * ONE_MINUTE,
    },
    exchange: { portfolio, price: 0 },
  }) as OrderCanceledEvent;
/** A BUY of 10 BTC at 100 that ended in error at the given minute, and the portfolio after it */
const errored = (minute: number, portfolio: Portfolio) =>
  ({
    order: {
      id: `BUY-${minute}`,
      symbol: 'BTC/USDT',
      side: 'BUY',
      type: 'MARKET',
      price: 100,
      amount: 10,
      reason: 'refused',
      orderCreationDate: minute * ONE_MINUTE,
      orderErrorDate: minute * ONE_MINUTE,
      filled: 0,
      mayBeLive: false,
    },
    exchange: { portfolio, price: 100 },
  }) as OrderErroredEvent;

describe('RoundTripAnalyzer', () => {
  let analyzer: RoundTripAnalyzer;

  /**
   * Plays the bucket of a minute in the order the pipeline delivers its events (see PluginsStream): the bucket, then the events of the
   * TradingAdvisor, the end of the warmup when it completes it and the timeframe candle of a 1m timeframe
   */
  const runMinute = (minute: number, closes: Record<string, number>, { lows = {}, completesWarmup = false } = {}) => {
    const bucket = bucketAt(minute, closes, lows);
    analyzer['processOneMinuteBucket'](bucket);
    if (completesWarmup) analyzer.onStrategyWarmupCompleted([bucket]);
    analyzer.onTimeframeCandle([bucket]);
  };
  const tracker = (symbol: TradingPair) => analyzer['trackers'].get(symbol)!;
  /** The report processFinalize emits */
  const finalReport = async (failure?: Error): Promise<TradingReport> => {
    const emitSpy = vi.spyOn(analyzer as any, 'emit').mockImplementation(async () => {});
    await analyzer['processFinalize'](failure);
    return emitSpy.mock.lastCall![1] as TradingReport;
  };

  beforeEach(() => {
    analyzer = new RoundTripAnalyzer(CONFIG);
  });

  describe('constructor', () => {
    it.each`
      property                | expected
      ${'pluginName'}         | ${PLUGIN_NAME}
      ${'riskFreeReturn'}     | ${2}
      ${'enableConsoleTable'} | ${true}
    `('should initialize with $property $expected', ({ property, expected }) => {
      expect(analyzer[property as keyof RoundTripAnalyzer]).toBe(expected);
    });

    it('should fall back to the risk-free return of 5 % the schema defaults to when the configuration has none', () => {
      expect(new RoundTripAnalyzer({ name: PLUGIN_NAME, enableConsoleTable: false } as any)['riskFreeReturn']).toBe(5);
    });

    it('should track the round trips of every watched pair, in the order of watch.assets', () => {
      watching(['ETH', 'BTC', 'XRP']);
      expect([...new RoundTripAnalyzer(CONFIG)['trackers'].keys()]).toEqual(['ETH/USDT', 'BTC/USDT', 'XRP/USDT']);
    });

    it('should give each tracker the asset of its pair', () => {
      expect([...analyzer['trackers'].values()].map(({ asset }) => asset)).toEqual(['BTC', 'ETH']);
    });

    describe('benchmark', () => {
      it.each`
        assets            | benchmarkAsset | expected | description
        ${['BTC', 'ETH']} | ${undefined}   | ${'BTC'} | ${'BTC, watched, by default'}
        ${['ETH', 'SOL']} | ${undefined}   | ${'ETH'} | ${'the first asset by default, BTC not watched'}
        ${['BTC', 'ETH']} | ${'ETH'}       | ${'ETH'} | ${'the asset configured'}
      `('should measure the market on $expected watching $assets: $description', ({ assets, benchmarkAsset, expected }) => {
        watching(assets);
        expect(new RoundTripAnalyzer({ ...CONFIG, benchmarkAsset })['benchmarkPair']).toBe(`${expected}/USDT`);
      });

      it('should refuse a benchmark asset that is not watched, naming the watched assets', () => {
        expect(() => new RoundTripAnalyzer({ ...CONFIG, benchmarkAsset: 'SOL' })).toThrow(
          '[ROUNDTRIP ANALYZER] benchmarkAsset must be one of the watched assets (BTC and ETH), got "SOL"',
        );
      });

      // Reported in one line by main(), as the run stops while the plugins are built
      it('should refuse it with a GekkoError', () => {
        expect(() => new RoundTripAnalyzer({ ...CONFIG, benchmarkAsset: 'SOL' })).toThrow(GekkoError);
      });
    });
  });

  describe('processOneMinuteBucket', () => {
    it('should record the close of every watched pair', () => {
      analyzer['processOneMinuteBucket'](bucketAt(1, { 'BTC/USDT': 100, 'ETH/USDT': 10 }));
      expect(analyzer['latestPrices']).toEqual(
        new Map([
          ['BTC/USDT', 100],
          ['ETH/USDT', 10],
        ]),
      );
    });

    it.each`
      benchmarkAsset | expected
      ${undefined}   | ${100}
      ${'ETH'}       | ${10}
    `(
      'should take the close of the benchmark pair, $expected with the benchmark $benchmarkAsset, as the end price',
      ({ benchmarkAsset, expected }) => {
        analyzer = new RoundTripAnalyzer({ ...CONFIG, benchmarkAsset });
        analyzer['processOneMinuteBucket'](bucketAt(1, { 'BTC/USDT': 100, 'ETH/USDT': 10 }));
        expect(analyzer['endPrice']).toBe(expected);
      },
    );

    describe('when a watched pair is missing from the bucket', () => {
      beforeEach(() => {
        analyzer['processOneMinuteBucket'](bucketAt(1, { 'BTC/USDT': 100 }));
      });

      it('should warn of it', () => {
        expect(warning).toHaveBeenCalledExactlyOnceWith('roundtrip analyzer', 'Missing candle for ETH/USDT in bucket.');
      });

      it('should record the close of the others', () => {
        expect(analyzer['latestPrices'].get('BTC/USDT')).toBe(100);
      });
    });

    it('should refuse an empty bucket, which has no minute', () => {
      expect(() => analyzer['processOneMinuteBucket'](new Map())).toThrow(
        new GekkoError('core', 'Impossible to get first candle from bucket: Empty candle bucket'),
      );
    });

    it.each`
      warmup                       | completesWarmup | end
      ${'before the warmup'}       | ${false}        | ${0}
      ${'once the warmup is over'} | ${true}         | ${3 * ONE_MINUTE}
    `('should move the end of the period to $end $warmup', ({ completesWarmup, end }) => {
      runMinute(1, { 'BTC/USDT': 100, 'ETH/USDT': 10 }, { completesWarmup });
      runMinute(2, { 'BTC/USDT': 100, 'ETH/USDT': 10 });
      expect(analyzer['dates'].end).toBe(end);
    });

    it('should hand each tracker the candle of its pair: the low of ETH deepens the round trip of ETH alone', () => {
      runMinute(0, { 'BTC/USDT': 100, 'ETH/USDT': 10 }, { completesWarmup: true });
      analyzer.onOrderCompleted([
        completed('BTC/USDT', 'BUY', ONE_MINUTE, 100, 1, 0, holding({ BTC: 1, USDT: 900 })),
        completed('ETH/USDT', 'BUY', ONE_MINUTE, 10, 10, 0, holding({ BTC: 1, ETH: 10, USDT: 800 })),
      ]);
      runMinute(1, { 'BTC/USDT': 100, 'ETH/USDT': 10 }, { lows: { 'ETH/USDT': 9 } });
      const excursion = (symbol: TradingPair) => tracker(symbol)['openRoundTrip']?.maxAdverseExcursion;
      expect({ BTC: excursion('BTC/USDT'), ETH: excursion('ETH/USDT') }).toEqual({ BTC: 0, ETH: 10 });
    });
  });

  describe('onStrategyWarmupCompleted', () => {
    const CLOSES = { 'BTC/USDT': 100, 'ETH/USDT': 10 };

    describe.each`
      bucket                                    | missing
      ${'without the candle of ETH'}            | ${['ETH/USDT']}
      ${'missing, the event holding no bucket'} | ${['BTC/USDT', 'ETH/USDT']}
    `('when the timeframe bucket is $bucket', ({ missing }) => {
      beforeEach(() => {
        analyzer['processOneMinuteBucket'](bucketAt(1, CLOSES));
        analyzer.onStrategyWarmupCompleted(missing.length === 2 ? [] : [bucketAt(1, { 'BTC/USDT': 100 })]);
      });

      it(`should warn of the candle missing for ${missing.join(' and ')}`, () => {
        expect(vi.mocked(warning).mock.calls).toEqual(
          missing.map((pair: TradingPair) => ['roundtrip analyzer', `Missing candle for ${pair} during warmup completion.`]),
        );
      });

      it('should not complete the warmup', () => {
        expect(analyzer['warmupCompleted']).toBe(false);
      });
    });

    describe('with a candle of every watched pair', () => {
      // A portfolio of 1 BTC, 10 ETH and 1,000 USDT, received during the warmup, which the bucket of minute 1 completes
      const PORTFOLIO = holding({ BTC: 1, ETH: 10, USDT: 1000 });
      const completeWarmup = (benchmarkAsset?: Asset) => {
        analyzer = new RoundTripAnalyzer({ ...CONFIG, benchmarkAsset });
        analyzer.onPortfolioChange([PORTFOLIO]);
        runMinute(1, CLOSES, { completesWarmup: true });
      };

      it('should start the period, and end it, at the close of the bucket that completed the warmup', () => {
        completeWarmup();
        expect(analyzer['dates']).toEqual({ start: 2 * ONE_MINUTE, end: 2 * ONE_MINUTE });
      });

      it.each`
        benchmarkAsset | expected
        ${undefined}   | ${100}
        ${'ETH'}       | ${10}
      `(
        'should take the close of the benchmark pair, $expected with the benchmark $benchmarkAsset, as the start price',
        ({ benchmarkAsset, expected }) => {
          completeWarmup(benchmarkAsset);
          expect(analyzer['startPrice']).toBe(expected);
        },
      );

      it('should take the whole portfolio at those closes as the start: 1 BTC at 100, 10 ETH at 10 and 1,000 USDT', () => {
        completeWarmup();
        expect(analyzer['start']).toEqual({ equity: 1200, portfolio: PORTFOLIO });
      });

      it('should take no start without a portfolio received', () => {
        runMinute(1, CLOSES, { completesWarmup: true });
        expect(analyzer['start']).toEqual({ equity: 0, portfolio: null });
      });
    });

    describe('after trades during the warmup', () => {
      // From 1,200 USDT, BTC bought at 100 and sold at 120, and ETH bought at 10 and still held, during the warmup, which the bucket of
      // minute 9 completes at closes of 110 and 11: the period starts at minute 10, from 10 ETH and 1,120 USDT
      beforeEach(() => {
        runMinute(0, { 'BTC/USDT': 100, 'ETH/USDT': 10 });
        analyzer.onOrderCompleted([
          completed('BTC/USDT', 'BUY', ONE_MINUTE, 100, 1, 0, holding({ BTC: 1, ETH: 0, USDT: 1100 })),
          completed('ETH/USDT', 'BUY', 2 * ONE_MINUTE, 10, 10, 0, holding({ BTC: 1, ETH: 10, USDT: 1000 })),
          completed('BTC/USDT', 'SELL', 5 * ONE_MINUTE, 120, 1, 0, holding({ BTC: 0, ETH: 10, USDT: 1120 })),
        ]);
        runMinute(9, { 'BTC/USDT': 110, 'ETH/USDT': 11 }, { completesWarmup: true });
      });

      it('should log that the trades of every pair, and the round trips they closed, are left out, then the position each pair holds', () => {
        expect(vi.mocked(info).mock.calls).toEqual([
          [
            'roundtrip analyzer',
            'The report measures the period from 1970-01-01T00:10:00.000Z on: the 3 trades of the warmup, and the 1 round trip they closed, are left out.',
          ],
          [
            'roundtrip analyzer',
            // The whole portfolio at the start: 10 ETH at 11 and 1,120 USDT
            'Position on ETH/USDT opened during the warmup at 10 USDT on 1970-01-01T00:02:00.000Z: its round trip counts from the start of the period, at the start price of 11 USDT and with the start equity of 1,230 USDT.',
          ],
        ]);
      });

      it.each`
        symbol        | expected
        ${'BTC/USDT'} | ${0}
        ${'ETH/USDT'} | ${0}
      `('should count none of the trades of $symbol', ({ symbol, expected }) => {
        expect(tracker(symbol).tradeCount).toBe(expected);
      });
    });

    it('should log nothing of a warmup without any trade', () => {
      runMinute(1, CLOSES, { completesWarmup: true });
      expect(info).not.toHaveBeenCalled();
    });
  });

  describe('start equity', () => {
    const PORTFOLIO = holding({ BTC: 1, ETH: 10, USDT: 1000 });
    const LATER = holding({ USDT: 5000 });
    // The warmup completes with the bucket of minute 1, at 100 and 10; the prices double with the bucket of minute 2
    const completeWarmup = () => runMinute(1, { 'BTC/USDT': 100, 'ETH/USDT': 10 }, { completesWarmup: true });
    const runNextMinute = () => runMinute(2, { 'BTC/USDT': 200, 'ETH/USDT': 20 });

    it('should not be taken from a portfolio received during the warmup', () => {
      analyzer.onPortfolioChange([PORTFOLIO]);
      expect(analyzer['start']).toEqual({ equity: 0, portfolio: null });
    });

    describe('when the first portfolio comes after the bucket that completed the warmup, before the next', () => {
      beforeEach(() => {
        completeWarmup();
        analyzer.onPortfolioChange([PORTFOLIO]);
      });

      it('should value it at the start prices', () => {
        expect(analyzer['start']).toEqual({ equity: 1200, portfolio: PORTFOLIO });
      });

      // As with the default warmup of 0 candles: the first portfolio of the Trader arrives right after the first bucket completed it
      it('should not warn that it was taken late', () => {
        expect(warning).not.toHaveBeenCalled();
      });
    });

    describe('when the first portfolio comes with a later bucket', () => {
      beforeEach(() => {
        completeWarmup();
        runNextMinute();
        analyzer.onPortfolioChange([PORTFOLIO]);
      });

      it('should value it late, at the prices known then: 1 BTC at 200, 10 ETH at 20 and 1,000 USDT', () => {
        expect(analyzer['start']).toEqual({ equity: 1400, portfolio: PORTFOLIO });
      });

      it('should warn that it was taken late, and at which prices', () => {
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          'roundtrip analyzer',
          'No portfolio received during the warmup: start equity taken late, at the prices of 1970-01-01T00:03:00.000Z.',
        );
      });

      it('should not be moved by a later change', () => {
        analyzer.onPortfolioChange([LATER]);
        expect(analyzer['start'].equity).toBe(1400);
      });
    });

    it('should take the latest portfolio received', () => {
      analyzer.onPortfolioChange([PORTFOLIO, LATER]);
      expect(analyzer['latestPortfolio']).toBe(LATER);
    });
  });

  describe('mark to market', () => {
    const PORTFOLIO = holding({ BTC: 1, ETH: 10, USDT: 1000 });

    it('should not mark the portfolio before the warmup completes', () => {
      analyzer.onPortfolioChange([PORTFOLIO]);
      runMinute(1, { 'BTC/USDT': 100, 'ETH/USDT': 10 });
      expect(analyzer['currentEquity']).toBe(0);
    });

    it('should not mark it before any portfolio is received', () => {
      runMinute(1, { 'BTC/USDT': 100, 'ETH/USDT': 10 }, { completesWarmup: true });
      runMinute(2, { 'BTC/USDT': 200, 'ETH/USDT': 20 });
      expect(analyzer['currentEquity']).toBe(0);
    });

    it('should mark the whole portfolio at the closes of every pair on each timeframe candle', () => {
      analyzer.onPortfolioChange([PORTFOLIO]);
      runMinute(1, { 'BTC/USDT': 100, 'ETH/USDT': 10 }, { completesWarmup: true });
      runMinute(2, { 'BTC/USDT': 200, 'ETH/USDT': 30 });
      expect(analyzer['currentEquity']).toBe(1500);
    });

    // The last bucket closes no timeframe candle: the end is marked all the same
    it('should mark it at the last closes at the end of the run: the final balance', async () => {
      analyzer.onPortfolioChange([PORTFOLIO]);
      runMinute(1, { 'BTC/USDT': 100, 'ETH/USDT': 10 }, { completesWarmup: true });
      analyzer['processOneMinuteBucket'](bucketAt(2, { 'BTC/USDT': 200, 'ETH/USDT': 30 }));
      expect((await finalReport()).finalBalance).toBe(1500);
    });
  });

  describe('latest portfolio', () => {
    // The portfolio of a portfolio change, then the one an order carries, read by the Trader after the order
    const CHANGED = holding({ USDT: 100 });
    const AFTER = holding({ BTC: 1 });

    it.each`
      event                                             | deliver
      ${'a completed BUY'}                              | ${() => analyzer.onOrderCompleted([completed('BTC/USDT', 'BUY', ONE_MINUTE, 100, 1, 0, AFTER)])}
      ${'a completed SELL, skipped while flat'}         | ${() => analyzer.onOrderCompleted([completed('BTC/USDT', 'SELL', ONE_MINUTE, 100, 1, 0, AFTER)])}
      ${'a completed order without a valid price'}      | ${() => analyzer.onOrderCompleted([completed('BTC/USDT', 'BUY', ONE_MINUTE, NaN, 1, 0, AFTER)])}
      ${'a completed order of a pair not watched'}      | ${() => analyzer.onOrderCompleted([completed('XRP/USDT', 'BUY', ONE_MINUTE, 1, 1, 0, AFTER)])}
      ${'the last of the orders delivered together'}    | ${() => analyzer.onOrderCompleted([completed('BTC/USDT', 'BUY', ONE_MINUTE, 100, 1, 0, CHANGED), completed('ETH/USDT', 'BUY', ONE_MINUTE, 10, 1, 0, AFTER)])}
      ${'an order canceled after a partial fill'}       | ${() => analyzer.onOrderCanceled([canceled('BTC/USDT', 'BUY', 1, 4, AFTER, { price: 100 })])}
      ${'an order canceled without a fill'}             | ${() => analyzer.onOrderCanceled([canceled('BTC/USDT', 'BUY', 1, 0, AFTER)])}
      ${'the last of the cancelations delivered alike'} | ${() => analyzer.onOrderCanceled([canceled('BTC/USDT', 'BUY', 1, 0, CHANGED), canceled('BTC/USDT', 'BUY', 2, 0, AFTER)])}
      ${'an order ended in error'}                      | ${() => analyzer.onOrderErrored([errored(1, AFTER)])}
      ${'the last of the errors delivered together'}    | ${() => analyzer.onOrderErrored([errored(1, CHANGED), errored(2, AFTER)])}
    `('should take the portfolio after $event as the latest, whose portfolio change the Trader can hold back', ({ deliver }) => {
      analyzer.onPortfolioChange([CHANGED]);
      deliver();
      expect(analyzer['latestPortfolio']).toBe(AFTER);
    });

    // The Trader sends the portfolio it knows: the empty one it starts with until one of its synchronizations succeeds
    it.each`
      event                        | deliver
      ${'an order completed'}      | ${() => analyzer.onOrderCompleted([completed('BTC/USDT', 'BUY', ONE_MINUTE, 100, 1, 0, NOT_READ)])}
      ${'an order canceled'}       | ${() => analyzer.onOrderCanceled([canceled('BTC/USDT', 'BUY', 1, 0, NOT_READ)])}
      ${'an order ended in error'} | ${() => analyzer.onOrderErrored([errored(1, NOT_READ)])}
    `('should keep the latest portfolio when $event carries the empty portfolio of a Trader that has fetched none yet', ({ deliver }) => {
      analyzer.onPortfolioChange([CHANGED]);
      deliver();
      expect(analyzer['latestPortfolio']).toBe(CHANGED);
    });

    it('should neither count an order ended in error as a trade nor open a round trip with it', () => {
      analyzer.onOrderErrored([errored(1, AFTER)]);
      expect({ tradeCount: tracker('BTC/USDT').tradeCount, openRoundTrip: tracker('BTC/USDT')['openRoundTrip'] }).toEqual({
        tradeCount: 0,
        openRoundTrip: null,
      });
    });
  });

  describe('orders, dispatched by pair', () => {
    beforeEach(() => {
      runMinute(0, { 'BTC/USDT': 100, 'ETH/USDT': 10 }, { completesWarmup: true });
    });
    const openRoundTrip = (symbol: TradingPair) => tracker(symbol)['openRoundTrip'];

    it('should open the round trip of a BUY on the tracker of its pair alone', () => {
      analyzer.onOrderCompleted([completed('ETH/USDT', 'BUY', ONE_MINUTE, 10, 10, 0, holding({ ETH: 10, USDT: 900 }))]);
      expect({ BTC: openRoundTrip('BTC/USDT'), ETH: openRoundTrip('ETH/USDT')?.entryPrice }).toEqual({ BTC: null, ETH: 10 });
    });

    it('should count the part a canceled order filled on the tracker of its pair alone', () => {
      analyzer.onOrderCanceled([canceled('ETH/USDT', 'BUY', 1, 4, holding({ ETH: 4, USDT: 960 }), { price: 10 })]);
      expect({ BTC: tracker('BTC/USDT').tradeCount, ETH: tracker('ETH/USDT').tradeCount }).toEqual({ BTC: 0, ETH: 1 });
    });

    // A MARKET order without the price of its fills: the last close of its own pair, 10, not that of BTC
    it('should price the part a canceled order filled at the last close of its pair when nothing else prices it', () => {
      analyzer.onOrderCanceled([canceled('ETH/USDT', 'BUY', 1, 4, holding({ ETH: 4, USDT: 960 }), { type: 'MARKET', price: 12 })]);
      expect(openRoundTrip('ETH/USDT')?.entryPrice).toBe(10);
    });

    it.each`
      filled
      ${0}
      ${undefined}
    `('should count nothing of an order canceled with $filled filled', ({ filled }) => {
      analyzer.onOrderCanceled([canceled('ETH/USDT', 'BUY', 1, filled, holding({ USDT: 1000 }))]);
      expect(tracker('ETH/USDT').tradeCount).toBe(0);
    });

    describe('of a pair the run does not watch', () => {
      it.each`
        event                                    | deliver                                                                                                               | line
        ${'a completed SELL'}                    | ${() => analyzer.onOrderCompleted([completed('XRP/USDT', 'SELL', 2 * ONE_MINUTE, 1, 5, 0, holding({ USDT: 1000 }))])} | ${'SELL order XRP-SELL-2 on XRP/USDT'}
        ${'a BUY canceled after a partial fill'} | ${() => analyzer.onOrderCanceled([canceled('XRP/USDT', 'BUY', 2, 4, holding({ USDT: 1000 }), { price: 1 })])}         | ${'BUY order XRP-BUY-2 on XRP/USDT'}
      `('should skip $event with a warning naming the pairs watched', ({ deliver, line }) => {
        deliver();
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          'roundtrip analyzer',
          `${line}, a pair this run does not watch (BTC/USDT and ETH/USDT): skipped.`,
        );
      });

      it('should count it on no tracker', () => {
        analyzer.onOrderCompleted([completed('XRP/USDT', 'BUY', 2 * ONE_MINUTE, 1, 5, 0, holding({ USDT: 1000 }))]);
        expect([...analyzer['trackers'].values()].map(({ tradeCount }) => tradeCount)).toEqual([0, 0]);
      });

      it('should say nothing of an order canceled without a fill, which counts for nothing', () => {
        analyzer.onOrderCanceled([canceled('XRP/USDT', 'BUY', 2, 0, holding({ USDT: 1000 }))]);
        expect(warning).not.toHaveBeenCalled();
      });
    });
  });

  describe('entry equity', () => {
    // The last closes are 100 and 10 when the warmup completes, from 1 BTC and 1,000 USDT; BTC closes at 120 a minute later
    beforeEach(() => {
      analyzer.onPortfolioChange([holding({ BTC: 1, USDT: 1000 })]);
      runMinute(0, { 'BTC/USDT': 100, 'ETH/USDT': 10 }, { completesWarmup: true });
      runMinute(1, { 'BTC/USDT': 120, 'ETH/USDT': 10 });
    });
    /** A BUY of 10 ETH at 11 for a fee of 0.11, filled at minute 2: 1,000 - 110 - 0.11 USDT left */
    const buyEth = (portfolio = holding({ BTC: 1, ETH: 10, USDT: 889.89 })) =>
      analyzer.onOrderCompleted([completed('ETH/USDT', 'BUY', 2 * ONE_MINUTE, 11, 10, 0.11, portfolio)]);

    // 1 BTC at its last close, 120, 10 ETH at the price of the BUY, 11, not at the last close of ETH, 10, 889.89 USDT and the fee given
    // back: the 1,120 the portfolio was worth before the BUY
    it('should be the whole portfolio after the BUY that opens a round trip, its pair at the price of the BUY, plus its fee', () => {
      buyEth();
      expect(tracker('ETH/USDT')['openRoundTrip']?.entryEquity).toBe(1120);
    });

    it('should leave the last closes as they were', () => {
      buyEth();
      expect(analyzer['latestPrices'].get('ETH/USDT')).toBe(10);
    });

    it('should be unknown when the BUY carries the empty portfolio of a Trader that has read none yet', () => {
      buyEth(NOT_READ);
      expect(tracker('ETH/USDT')['openRoundTrip']?.entryEquity).toBeNaN();
    });
  });

  describe('round trips closed', () => {
    let deferredEmitSpy: MockInstance;
    /** The round trips emitted with ROUNDTRIP_COMPLETED_EVENT */
    const emittedRoundTrips = (): RoundTrip[] =>
      deferredEmitSpy.mock.calls.filter(([name]) => name === ROUNDTRIP_COMPLETED_EVENT).map(([, roundTrip]) => roundTrip);
    // From 1,000 USDT, 1 BTC bought at 100 at minute 1 and 10 ETH at 10 at minute 2, each entering with 1,000; ETH sold at 12 at minute 3,
    // 20 or 2 %, then BTC at 110 at minute 4, 10 or 1 %
    const overlap = () => {
      analyzer.onOrderCompleted([
        completed('BTC/USDT', 'BUY', ONE_MINUTE, 100, 1, 0, holding({ BTC: 1, USDT: 900 })),
        completed('ETH/USDT', 'BUY', 2 * ONE_MINUTE, 10, 10, 0, holding({ BTC: 1, ETH: 10, USDT: 800 })),
        completed('ETH/USDT', 'SELL', 3 * ONE_MINUTE, 12, 10, 0, holding({ BTC: 1, USDT: 920 })),
        completed('BTC/USDT', 'SELL', 4 * ONE_MINUTE, 110, 1, 0, holding({ USDT: 1030 })),
      ]);
    };

    beforeEach(() => {
      deferredEmitSpy = vi.spyOn(analyzer as any, 'addDeferredEmit');
      runMinute(0, { 'BTC/USDT': 100, 'ETH/USDT': 10 }, { completesWarmup: true });
    });

    it('should number them through the run in the order they close, every pair together', () => {
      overlap();
      expect(emittedRoundTrips().map(({ id, symbol }) => ({ id, symbol }))).toEqual([
        { id: 0, symbol: 'ETH/USDT' },
        { id: 1, symbol: 'BTC/USDT' },
      ]);
    });

    // Not in the order of the pairs: the volatility would be the same, but not the bits of its mean
    it('should weigh their profits in the order they closed, whatever the order of the pairs', async () => {
      analyzer.onPortfolioChange([holding({ USDT: 1000 })]);
      overlap();
      await finalReport();
      expect(calculateVolatility).toHaveBeenCalledWith([2, 1]);
    });

    it('should emit the round trip that a SELL canceled after a partial fill ends', () => {
      analyzer.onOrderCompleted([completed('BTC/USDT', 'BUY', ONE_MINUTE, 100, 4, 0, holding({ BTC: 4, USDT: 600 }))]);
      analyzer.onOrderCanceled([canceled('BTC/USDT', 'SELL', 2, 4, holding({ USDT: 1040 }), { price: 110 })]);
      expect(emittedRoundTrips().map(({ symbol, exitPrice, pnl }) => ({ symbol, exitPrice, pnl }))).toEqual([
        { symbol: 'BTC/USDT', exitPrice: 110, pnl: 40 },
      ]);
    });

    it('should log each, naming its pair in its table on a run that watches several', () => {
      overlap();
      expect(vi.mocked(logRoundtrip).mock.calls).toEqual(emittedRoundTrips().map(roundTrip => [roundTrip, 'USDT', true, true]));
    });

    it('should not name the pair of a round trip on a run that watches one', () => {
      watching(['BTC']);
      analyzer = new RoundTripAnalyzer(CONFIG);
      analyzer.onOrderCompleted([
        completed('BTC/USDT', 'BUY', ONE_MINUTE, 100, 1, 0, holding({ BTC: 1, USDT: 900 })),
        completed('BTC/USDT', 'SELL', 2 * ONE_MINUTE, 110, 1, 0, holding({ USDT: 1010 })),
      ]);
      expect(vi.mocked(logRoundtrip).mock.lastCall?.[3]).toBe(false);
    });

    it('should go on numbering them after the round trips the warmup closed, which the report leaves out', () => {
      analyzer = new RoundTripAnalyzer(CONFIG);
      deferredEmitSpy = vi.spyOn(analyzer as any, 'addDeferredEmit');
      analyzer.onOrderCompleted([
        completed('BTC/USDT', 'BUY', 0, 100, 1, 0, holding({ BTC: 1, USDT: 900 })),
        completed('BTC/USDT', 'SELL', ONE_MINUTE, 110, 1, 0, holding({ USDT: 1010 })),
      ]);
      runMinute(1, { 'BTC/USDT': 110, 'ETH/USDT': 10 }, { completesWarmup: true });
      overlap();
      expect(emittedRoundTrips().map(({ id }) => id)).toEqual([0, 1, 2]);
    });
  });

  describe('the report of a run on two pairs', () => {
    // From 2,000 USDT, received during the warmup, which the bucket of minute 0 completes: the period runs from minute 1 to minute 10.
    // BTC: 5 bought at 100 (fee 0.5), dated minute 1, sold at 110 (fee 0.55) at minute 5; then 1 bought at 120 (fee 0.12) at minute 9,
    // still held at the end. ETH: 50 bought at 10 (fee 0.5) at minute 3, sold at 9 (fee 0.45) at minute 7. Each order is heard after the
    // bucket of the minute it is dated in, as a backtest delivers it. BTC's low of 90 on minute 2, ETH's of 8.5 on minute 4.
    const CLOSES = [
      { 'BTC/USDT': 100, 'ETH/USDT': 10 },
      { 'BTC/USDT': 100, 'ETH/USDT': 10 },
      { 'BTC/USDT': 100, 'ETH/USDT': 10 },
      { 'BTC/USDT': 100, 'ETH/USDT': 10 },
      { 'BTC/USDT': 110, 'ETH/USDT': 10 },
      { 'BTC/USDT': 110, 'ETH/USDT': 9 },
      { 'BTC/USDT': 110, 'ETH/USDT': 9 },
      { 'BTC/USDT': 120, 'ETH/USDT': 9 },
      { 'BTC/USDT': 120, 'ETH/USDT': 8 },
      { 'BTC/USDT': 120, 'ETH/USDT': 8 },
    ];
    const LOWS: Record<number, Record<string, number>> = { 2: { 'BTC/USDT': 90 }, 4: { 'ETH/USDT': 8.5 } };
    const ORDERS: Record<number, OrderCompletedEvent> = {
      1: completed('BTC/USDT', 'BUY', ONE_MINUTE, 100, 5, 0.5, holding({ BTC: 5, ETH: 0, USDT: 1499.5 })),
      3: completed('ETH/USDT', 'BUY', 3 * ONE_MINUTE, 10, 50, 0.5, holding({ BTC: 5, ETH: 50, USDT: 999 })),
      5: completed('BTC/USDT', 'SELL', 5 * ONE_MINUTE, 110, 5, 0.55, holding({ BTC: 0, ETH: 50, USDT: 1548.45 })),
      7: completed('ETH/USDT', 'SELL', 7 * ONE_MINUTE, 9, 50, 0.45, holding({ BTC: 0, ETH: 0, USDT: 1998 })),
      9: completed('BTC/USDT', 'BUY', 9 * ONE_MINUTE, 120, 1, 0.12, holding({ BTC: 1, ETH: 0, USDT: 1877.88 })),
    };
    let deferredEmitSpy: MockInstance;
    const run = async (benchmarkAsset?: Asset) => {
      analyzer = new RoundTripAnalyzer({ ...CONFIG, benchmarkAsset });
      deferredEmitSpy = vi.spyOn(analyzer as any, 'addDeferredEmit');
      analyzer.onPortfolioChange([holding({ USDT: 2000 })]);
      CLOSES.forEach((closes, minute) => {
        runMinute(minute, closes, { lows: LOWS[minute], completesWarmup: minute === 0 });
        if (ORDERS[minute]) analyzer.onOrderCompleted([ORDERS[minute]]);
      });
      return finalReport();
    };

    it('should emit the round trips of both pairs, each its P&L from its own fills, numbered in the order they closed', async () => {
      await run();
      expect(deferredEmitSpy.mock.calls).toEqual([
        [
          ROUNDTRIP_COMPLETED_EVENT,
          {
            id: 0,
            symbol: 'BTC/USDT',
            entryAt: ONE_MINUTE,
            entryPrice: 100,
            // The portfolio after the BUY, 5 BTC at 100 and 1,499.5 USDT, and its fee: the 2,000 USDT before it
            entryEquity: 2000,
            exitAt: 5 * ONE_MINUTE,
            exitPrice: 110,
            cost: 500,
            proceeds: 550,
            fees: 1.05,
            duration: 4 * ONE_MINUTE,
            // The low of 90 on minute 2
            maxAdverseExcursion: 10,
            // 48.95 in % of 2,000
            profit: 2.4475,
            // 550 - 500 - 1.05
            pnl: 48.95,
          },
        ],
        [
          ROUNDTRIP_COMPLETED_EVENT,
          {
            id: 1,
            symbol: 'ETH/USDT',
            entryAt: 3 * ONE_MINUTE,
            entryPrice: 10,
            // 5 BTC at their last close, 100, 50 ETH at 10, 999 USDT and the fee: the 1,999.5 the portfolio was worth before the BUY
            entryEquity: 1999.5,
            exitAt: 7 * ONE_MINUTE,
            exitPrice: 9,
            cost: 500,
            proceeds: 450,
            fees: 0.95,
            duration: 4 * ONE_MINUTE,
            // The low of 8.5 on minute 4
            maxAdverseExcursion: 15,
            // -50.95 in % of 1,999.5, to 15 significant digits
            profit: -2.54813703425856,
            // 450 - 500 - 0.95
            pnl: -50.95,
          },
        ],
      ]);
    });

    it('should report the run, every pair together, with a breakdown by pair', async () => {
      expect(await run()).toMatchObject({
        id: 'TRADING REPORT',
        periodStartAt: ONE_MINUTE,
        periodEndAt: 10 * ONE_MINUTE,
        formattedDuration: '9 minutes',
        // The whole portfolio's value: 2,000 USDT at the start, 1 BTC at 120 and 1,877.88 USDT at the end
        startBalance: 2000,
        finalBalance: 1997.88,
        // 48.95 - 50.95 of the two round trips, and the fee of the BUY still open, 0.12
        netProfit: -2.12,
        totalReturnPct: -0.106,
        // BTC, the benchmark, from 100 to 120
        benchmarkAsset: 'BTC',
        startPrice: 100,
        endPrice: 120,
        marketReturnPct: 20,
        // Minutes 1 to 7 in a round trip of either pair, then 9 to 10: 7 of 9, the minutes 3 to 5 that both held once
        exposurePct: 77.7777777777778,
        // 1 of 2
        winRate: 50,
        // 3 of BTC, 2 of ETH
        tradeCount: 5,
        topMAEs: [15, 10],
        pairs: [
          {
            symbol: 'BTC/USDT',
            roundTripCount: 1,
            winCount: 1,
            winRate: 100,
            tradeCount: 3,
            pnl: 48.95,
            // Minutes 1 to 5, then 9 to 10: 5 of 9
            exposurePct: 55.5555555555556,
            maxAdverseExcursion: 10,
          },
          {
            symbol: 'ETH/USDT',
            roundTripCount: 1,
            winCount: 0,
            winRate: 0,
            tradeCount: 2,
            pnl: -50.95,
            // Minutes 3 to 7: 4 of 9
            exposurePct: 44.4444444444444,
            maxAdverseExcursion: 15,
          },
        ],
      });
    });

    it('should measure the exposure as the time spent in a round trip on any pair: 7 of the 9 minutes, not 9', async () => {
      await run();
      expect(calculateExposurePct).toHaveBeenCalledWith(7 * ONE_MINUTE, 9 * ONE_MINUTE);
    });

    it('should weigh the profits of the round trips of every pair, in the order they closed', async () => {
      await run();
      expect(calculateVolatility).toHaveBeenCalledWith([2.4475, -2.54813703425856]);
    });

    it.each`
      benchmarkAsset | expected
      ${'BTC'}       | ${{ benchmarkAsset: 'BTC', startPrice: 100, endPrice: 120, marketReturnPct: 20 }}
      ${'ETH'}       | ${{ benchmarkAsset: 'ETH', startPrice: 10, endPrice: 8, marketReturnPct: -20 }}
    `('should measure the market on its benchmark, $benchmarkAsset', async ({ benchmarkAsset, expected }) => {
      expect(await run(benchmarkAsset)).toMatchObject(expected);
    });

    it('should log the position still open on BTC after the report, with its P&L from its fills at the last close', async () => {
      await run();
      expect(info).toHaveBeenLastCalledWith(
        'roundtrip analyzer',
        // 120 - 120 - 0.12 in % of 1,998, the portfolio before its BUY: -0.006 %, -0.01% rounded half to even
        'Position still open on BTC/USDT at the end of the period, entered at 120 USDT on 1970-01-01T00:09:00.000Z: unrealized P&L of -0.12 USDT (-0.01%) at the last close, 120 USDT. The final balance and the exposure include it; the win rate, the ratios and the MAEs leave it out.',
      );
    });

    it('should hand the report to its table', async () => {
      const report = await run();
      expect(logFinalize).toHaveBeenCalledExactlyOnceWith(report, 'USDT');
    });
  });

  describe('the report of a run on one pair', () => {
    // 1 BTC and 100,000 USDT. The warmup of 0 candles ends with the first bucket, at 10,000: the period runs from minute 1 to 3. The
    // strategy buys 0.005 BTC at that close, with a fee of 0.035 USDT, and sells it at 12,000 a minute later, with a fee of 0.042 USDT.
    // With the portfolioUpdates filter of the example configuration (threshold 1 %, dust 10), neither report sends a portfolio change:
    // the orders alone carry the portfolio after them.
    let report: TradingReport;
    let deferredEmitSpy: MockInstance;
    beforeEach(async () => {
      watching(['BTC']);
      analyzer = new RoundTripAnalyzer(CONFIG);
      deferredEmitSpy = vi.spyOn(analyzer as any, 'addDeferredEmit');
      runMinute(0, { 'BTC/USDT': 10_000 }, { completesWarmup: true });
      analyzer.onPortfolioChange([holding({ BTC: 1, USDT: 100_000 })]);
      analyzer.onOrderCompleted([
        completed('BTC/USDT', 'BUY', ONE_MINUTE, 10_000, 0.005, 0.035, holding({ BTC: 1.005, USDT: 99_949.965 })),
      ]);
      runMinute(1, { 'BTC/USDT': 12_000 });
      analyzer.onOrderCompleted([
        completed('BTC/USDT', 'SELL', 2 * ONE_MINUTE, 12_000, 0.005, 0.042, holding({ BTC: 1, USDT: 100_009.923 })),
      ]);
      runMinute(2, { 'BTC/USDT': 12_000 });
      report = await finalReport();
    });

    // As before the round trips of every pair: the balances are the pair equity, the whole portfolio on one pair
    it.each`
      field               | expected       | description
      ${'startBalance'}   | ${110_000}     | ${'1 BTC at 10,000 and 100,000 USDT'}
      ${'finalBalance'}   | ${112_009.923} | ${'the portfolio after the SELL at the last close, not that of the last portfolio change'}
      ${'netProfit'}      | ${2_009.923}   | ${'the BTC held, up by 2,000, and the round trip, up by 10 less 0.077 of fees'}
      ${'exposurePct'}    | ${50}          | ${'a round trip of a minute in a period of two'}
      ${'tradeCount'}     | ${2}           | ${'the BUY and the SELL'}
      ${'winRate'}        | ${100}         | ${'one round trip, a win'}
      ${'benchmarkAsset'} | ${'BTC'}       | ${'its one asset'}
    `('should report $field $expected: $description', ({ field, expected }) => {
      expect(report[field as keyof TradingReport]).toBe(expected);
    });

    it('should break the report down to its one pair', () => {
      expect(report.pairs).toEqual([
        {
          symbol: 'BTC/USDT',
          roundTripCount: 1,
          winCount: 1,
          winRate: 100,
          tradeCount: 2,
          pnl: 9.923,
          exposurePct: 50,
          maxAdverseExcursion: 0,
        },
      ]);
    });

    // The pair equity from before the BUY to after the SELL made 2,009.923: the 1 BTC held before it, up by 2,000, counted in it
    it.each`
      field            | expected               | description
      ${'entryEquity'} | ${110_000}             | ${'1.005 BTC at 10,000, 99,949.965 USDT and the fee of 0.035: the portfolio before the BUY'}
      ${'cost'}        | ${50}                  | ${'0.005 at 10,000'}
      ${'proceeds'}    | ${60}                  | ${'0.005 at 12,000'}
      ${'fees'}        | ${0.077}               | ${'0.035 + 0.042'}
      ${'pnl'}         | ${9.923}               | ${'its fills alone: 60 - 50 - 0.077, the BTC held before it left out'}
      ${'profit'}      | ${0.00902090909090909} | ${'9.923 in % of 110,000, to 15 significant digits'}
    `('should emit the round trip with $field $expected: $description', ({ field, expected }) => {
      expect(deferredEmitSpy.mock.lastCall?.[1][field]).toBe(expected);
    });
  });

  describe('period', () => {
    // On a 1h timeframe, the bucket of minute 119 completes the warmup: it closes, at minute 120, the hourly candle that started at
    // minute 60
    const CANDLE_CLOSE = 120 * ONE_MINUTE;
    /** The report of a run that goes on for that many buckets after the one that completed the warmup */
    const reportAfter = async (buckets: number) => {
      analyzer.onPortfolioChange([holding({ USDT: 1000 })]);
      analyzer['processOneMinuteBucket'](bucketAt(119, { 'BTC/USDT': 100, 'ETH/USDT': 10 }));
      analyzer.onStrategyWarmupCompleted([bucketAt(60, { 'BTC/USDT': 100, 'ETH/USDT': 10 })]);
      for (let minute = 120; minute < 120 + buckets; minute++)
        analyzer['processOneMinuteBucket'](bucketAt(minute, { 'BTC/USDT': 100, 'ETH/USDT': 10 }));
      return finalReport();
    };

    it.each`
      buckets | run
      ${0}    | ${'ends with the warmup'}
      ${1}    | ${'goes on for a minute'}
      ${60}   | ${'goes on for an hour'}
    `('should start at the close of the candle that completed the warmup, not at its start, when the run $run', async ({ buckets }) => {
      expect((await reportAfter(buckets)).periodStartAt).toBe(CANDLE_CLOSE);
    });

    it.each`
      buckets | duration
      ${0}    | ${''}
      ${1}    | ${'1 minute'}
      ${60}   | ${'1 hour'}
    `(
      'should report a duration of "$duration" when the run goes on for $buckets buckets after the warmup',
      async ({ buckets, duration }) => {
        expect((await reportAfter(buckets)).formattedDuration).toBe(duration);
      },
    );

    // A run that ends with the bucket that completed the warmup has a period of 0 ms, and nothing exposed in it
    it('should report an exposure of 0 for a period of 0 ms', async () => {
      analyzer.onOrderCompleted([completed('BTC/USDT', 'BUY', 120 * ONE_MINUTE, 100, 1, 0, holding({ BTC: 1, USDT: 900 }))]);
      expect((await reportAfter(0)).exposurePct).toBe(0);
    });

    it('should warn that a period shorter than a day is annualized over a day', async () => {
      await reportAfter(60);
      expect(warning).toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining('Period shorter than a day'));
    });

    it('should not warn of a period of a day or more', async () => {
      await reportAfter(DAY / ONE_MINUTE);
      expect(warning).not.toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining('Period shorter than a day'));
    });
  });

  describe('calculateReportStatistics', () => {
    describe.each`
      missing                  | start                                     | startPrice | message
      ${'a start equity'}      | ${{ equity: 0, portfolio: new Map() }}    | ${100}     | ${'Start equity of 0 USDT: no return to measure. Emitting empty report.'}
      ${'the start portfolio'} | ${{ equity: 1000, portfolio: null }}      | ${100}     | ${'No portfolio data received. Emitting empty report.'}
      ${'the start price'}     | ${{ equity: 1000, portfolio: new Map() }} | ${null}    | ${'The warmup never completed: no period to measure. Emitting empty report.'}
    `('without $missing', ({ start, startPrice, message }) => {
      let report: TradingReport;
      beforeEach(() => {
        analyzer['start'] = start;
        analyzer['startPrice'] = startPrice;
        report = analyzer['calculateReportStatistics']();
      });

      it('should return the empty report', () => {
        expect(report).toEqual(EMPTY_TRADING_REPORT);
      });

      it(`should warn: ${message}`, () => {
        expect(warning).toHaveBeenCalledExactlyOnceWith('roundtrip analyzer', message);
      });
    });

    it('should break down the empty report by no pair, and name no benchmark', () => {
      expect(analyzer['calculateReportStatistics']()).toMatchObject({ pairs: [], benchmarkAsset: '' });
    });
  });

  describe('processFinalize', () => {
    beforeEach(() => {
      analyzer.onPortfolioChange([holding({ USDT: 1000 })]);
      runMinute(0, { 'BTC/USDT': 100, 'ETH/USDT': 10 }, { completesWarmup: true });
    });

    it('should emit the report directly', async () => {
      const emitSpy = vi.spyOn(analyzer as any, 'emit');
      await analyzer['processFinalize']();
      expect(emitSpy).toHaveBeenCalledWith(PERFORMANCE_REPORT_EVENT, expect.objectContaining({ id: 'TRADING REPORT', startBalance: 1000 }));
    });

    it('should say why the run was interrupted in the report', async () => {
      expect((await finalReport(new Error('circuit breaker'))).interruption).toBe('circuit breaker');
    });

    it('should hand the table the report, with the reason the run stopped before its end', async () => {
      const report = await finalReport(new Error('circuit breaker'));
      expect(logFinalize).toHaveBeenCalledWith(report, 'USDT');
    });

    it('should log the report through info when the console table is disabled', async () => {
      analyzer['enableConsoleTable'] = false;
      const report = await finalReport();
      expect(info).toHaveBeenCalledWith('roundtrip analyzer', report);
    });

    it('should log the positions still open in the order of watch.assets, after the report', async () => {
      analyzer.onOrderCompleted([
        completed('ETH/USDT', 'BUY', ONE_MINUTE, 10, 10, 0, holding({ ETH: 10, USDT: 900 })),
        completed('BTC/USDT', 'BUY', ONE_MINUTE, 100, 1, 0, holding({ BTC: 1, ETH: 10, USDT: 800 })),
      ]);
      analyzer['enableConsoleTable'] = false;
      await finalReport();
      expect(vi.mocked(info).mock.calls.map(([, message]) => (typeof message === 'string' ? message.slice(0, 31) : 'report'))).toEqual([
        'report',
        'Position still open on BTC/USDT',
        'Position still open on ETH/USDT',
      ]);
    });

    // Described as describeError writes a failure: a GekkoError without its tag, which the line has one of its own already
    describe.each`
      thrown                                                   | described
      ${new Error('disk full')}                                | ${'disk full'}
      ${new GekkoError('performance reporter', 'report lost')} | ${'report lost'}
      ${{ errno: -13 }}                                        | ${'{ errno: -13 }'}
    `('when a listener of the report throws $thrown', ({ thrown, described }) => {
      beforeEach(() => {
        analyzer.on(PERFORMANCE_REPORT_EVENT, async () => {
          throw thrown;
        });
      });

      it('should resolve all the same: the report was produced and logged', async () => {
        await expect(analyzer['processFinalize']()).resolves.toBeUndefined();
      });

      it(`should log the failure at error level: ${described}`, async () => {
        await analyzer['processFinalize']();
        expect(error).toHaveBeenCalledWith('roundtrip analyzer', `A listener failed on the performance report: ${described}`);
      });
    });

    it('should resolve only once the listeners of the report are done with it', async () => {
      let release = () => {};
      analyzer.on(PERFORMANCE_REPORT_EVENT, () => new Promise<void>(resolve => (release = resolve)));
      const finalized = vi.fn();
      const finalization = analyzer['processFinalize']().then(finalized);
      // A timer runs once the microtasks queued before it have: processFinalize would have resolved by then had it not waited
      await new Promise(resolve => setTimeout(resolve, 0));
      const finalizedBeforeRelease = finalized.mock.calls.length;
      release();
      await finalization;
      expect(finalizedBeforeRelease).toBe(0);
    });
  });

  describe('processInit', () => {
    it('should execute without error', () => {
      expect(() => analyzer['processInit']()).not.toThrow();
    });
  });

  describe('getStaticConfiguration', () => {
    it('should return correct Plugin Name', () => {
      expect(RoundTripAnalyzer.getStaticConfiguration().name).toBe(PLUGIN_NAME);
    });

    it('should configure modes correctly', () => {
      expect(RoundTripAnalyzer.getStaticConfiguration().modes).toEqual(['realtime', 'backtest']);
    });

    it('should configure eventsEmitted correctly', () => {
      expect(RoundTripAnalyzer.getStaticConfiguration().eventsEmitted).toEqual([PERFORMANCE_REPORT_EVENT, ROUNDTRIP_COMPLETED_EVENT]);
    });

    // A method of its own named on… would be wired as the handler of an event
    it('should export the six handlers it listens with, and nothing else', () => {
      expect(RoundTripAnalyzer.getStaticConfiguration().eventsHandlers).toEqual([
        'onPortfolioChange',
        'onStrategyWarmupCompleted',
        'onTimeframeCandle',
        'onOrderCompleted',
        'onOrderCanceled',
        'onOrderErrored',
      ]);
    });
  });

  describe('in pipeline order, on one pair', () => {
    /**
     * A 1m timeframe: the bucket of each minute closes a timeframe candle. The events of a bucket follow it in the order PluginsStream
     * flushes them: those of the TradingAdvisor (the end of the warmup, the timeframe candle), then those of the Trader. The Trader
     * reports an order with the portfolio change of the synchronization it waits for, then the end of the order: without a
     * portfolioUpdates filter, the change comes first, and in one array with the changes queued just before it.
     */
    const runBtcMinute = (minute: number, close: number, { low = close, completesWarmup = false } = {}) =>
      runMinute(minute, { 'BTC/USDT': close }, { lows: { 'BTC/USDT': low }, completesWarmup });
    const runBtcMinutes = (from: number, to: number, close: number) => {
      for (let minute = from; minute <= to; minute++) runBtcMinute(minute, close);
    };
    const btc = (amount: number, usdt: number) => holding({ BTC: amount, USDT: usdt });
    const filled = (side: OrderSide, minute: number, price: number, amount: number, fee: number, portfolio: Portfolio) =>
      completed('BTC/USDT', side, minute * ONE_MINUTE, price, amount, fee, portfolio);
    let deferredEmitSpy: MockInstance;
    /** The round trips emitted with ROUNDTRIP_COMPLETED_EVENT */
    const emittedRoundTrips = (): RoundTrip[] =>
      deferredEmitSpy.mock.calls.filter(([name]) => name === ROUNDTRIP_COMPLETED_EVENT).map(([, roundTrip]) => roundTrip);

    beforeEach(() => {
      watching(['BTC']);
      analyzer = new RoundTripAnalyzer(CONFIG);
      deferredEmitSpy = vi.spyOn(analyzer as any, 'addDeferredEmit');
    });

    describe('when a BUY of the warmup is still open when it completes', () => {
      // A warmup of 9 candles: the bucket of minute 9 completes it, and the period runs from minute 10 to minute 20. The init of the
      // strategy buys 10 BTC with 1,000 USDT at the close of minute 0, at 100. The price rises to 110 by the end of the warmup, dips to
      // 99 at minute 11, and the strategy sells the 10 BTC at 120 at the close of minute 12.
      let report: TradingReport;
      beforeEach(async () => {
        runBtcMinute(0, 100);
        analyzer.onPortfolioChange([btc(0, 1_000), btc(10, 0)]);
        analyzer.onOrderCompleted([filled('BUY', 1, 100, 10, 0, btc(10, 0))]);
        runBtcMinutes(1, 8, 105);
        runBtcMinute(9, 110, { completesWarmup: true });
        runBtcMinute(10, 110);
        runBtcMinute(11, 110, { low: 99 });
        runBtcMinute(12, 120);
        analyzer.onPortfolioChange([btc(0, 1_200)]);
        analyzer.onOrderCompleted([filled('SELL', 13, 120, 10, 0, btc(0, 1_200))]);
        runBtcMinutes(13, 19, 120);
        report = await finalReport();
      });

      it.each`
        field            | expected            | description
        ${'entryAt'}     | ${10 * ONE_MINUTE}  | ${'the start of the period'}
        ${'entryPrice'}  | ${110}              | ${'the start price'}
        ${'entryEquity'} | ${1_100}            | ${'the start equity'}
        ${'cost'}        | ${1_100}            | ${'the 10 BTC held at the start, at the start price'}
        ${'proceeds'}    | ${1_200}            | ${'the 10 BTC sold at 120'}
        ${'pnl'}         | ${100}              | ${'from the start price, not from the BUY of the warmup'}
        ${'profit'}      | ${9.09090909090909} | ${'that P&L, in % of the start equity, to 15 significant digits'}
        ${'duration'}    | ${3 * ONE_MINUTE}   | ${'from the start of the period to the SELL'}
      `('should emit its round trip with $field $expected: $description', ({ field, expected }) => {
        expect(emittedRoundTrips()[0][field as keyof RoundTrip]).toBe(expected);
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
        expect(report[field as keyof TradingReport]).toBe(expected);
      });
    });

    describe('when the position bought during the warmup is still held at the end', () => {
      // 10 BTC bought at 100 at the close of minute 0, the price unmoved, the period from minute 10 to 20
      let report: TradingReport;
      beforeEach(async () => {
        runBtcMinute(0, 100);
        analyzer.onPortfolioChange([btc(0, 1_000), btc(10, 0)]);
        analyzer.onOrderCompleted([filled('BUY', 1, 100, 10, 0, btc(10, 0))]);
        runBtcMinutes(1, 8, 100);
        runBtcMinute(9, 100, { completesWarmup: true });
        runBtcMinutes(10, 19, 100);
        report = await finalReport();
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

      it('should log it still open, from the start price, unmoved', () => {
        expect(info).toHaveBeenLastCalledWith(
          'roundtrip analyzer',
          expect.stringContaining(': unrealized P&L of 0 USDT (0%) at the last close,'),
        );
      });
    });

    describe('when a round trip opens and ends during the warmup', () => {
      // 10 BTC bought at 100 at the close of minute 0 and sold at 110 at the close of minute 7, during the warmup of 9 candles: the
      // period, from minute 10 to 12, starts flat
      let report: TradingReport;
      beforeEach(async () => {
        runBtcMinute(0, 100);
        analyzer.onPortfolioChange([btc(0, 1_000), btc(10, 0)]);
        analyzer.onOrderCompleted([filled('BUY', 1, 100, 10, 0, btc(10, 0))]);
        runBtcMinutes(1, 6, 100);
        runBtcMinute(7, 110);
        analyzer.onPortfolioChange([btc(0, 1_100)]);
        analyzer.onOrderCompleted([filled('SELL', 8, 110, 10, 0, btc(0, 1_100))]);
        runBtcMinute(8, 110);
        runBtcMinute(9, 110, { completesWarmup: true });
        runBtcMinutes(10, 11, 110);
        report = await finalReport();
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

    describe.each`
      end                             | deliver
      ${'ends in error'}              | ${() => analyzer.onOrderErrored([errored(1, NOT_READ)])}
      ${'is canceled without a fill'} | ${() => analyzer.onOrderCanceled([canceled('BTC/USDT', 'BUY', 1, 0, NOT_READ, { price: 100 })])}
    `('when an order $end during the warmup, before any synchronization of the Trader succeeds', ({ deliver }) => {
      // The exchange is out of reach at the start: the order the init of the strategy places at the close of minute 0 ends with the
      // empty portfolio the Trader starts with. The bucket of minute 1 completes the warmup, at 100, and the first portfolio fetched
      // comes after it: 1,000 USDT.
      let report: TradingReport;
      beforeEach(async () => {
        runBtcMinute(0, 100);
        deliver();
        runBtcMinute(1, 100, { completesWarmup: true });
        analyzer.onPortfolioChange([btc(0, 1_000)]);
        runBtcMinute(2, 110);
        report = await finalReport();
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

    describe.each`
      order                                           | type        | fillPrice    | usdt   | entryPrice | proceeds | pnl
      ${'a LIMIT BUY at 100'}                         | ${'LIMIT'}  | ${undefined} | ${600} | ${100}     | ${440}   | ${40}
      ${'a STICKY BUY sized at 100, its fills at 95'} | ${'STICKY'} | ${95}        | ${620} | ${95}      | ${440}   | ${60}
    `('when $order is canceled after filling 4 BTC', ({ type, fillPrice, usdt, entryPrice, proceeds, pnl }) => {
      // The warmup of 0 candles ends with the first bucket: the period runs from minute 1 to 4, from 1,000 USDT. A BUY of 10 BTC at 100
      // fills 4 of them before the strategy cancels it, at the close of minute 1; it sells the 4 BTC at 110 at the close of minute 2.
      // Counted at 100, the price a STICKY order carries, the part it filled at 95 made its round trip 40 where it made 60.
      let report: TradingReport;
      beforeEach(async () => {
        runBtcMinute(0, 100, { completesWarmup: true });
        analyzer.onPortfolioChange([btc(0, 1_000)]);
        runBtcMinute(1, 100);
        analyzer.onPortfolioChange([btc(4, usdt)]);
        analyzer.onOrderCanceled([canceled('BTC/USDT', 'BUY', 2, 4, btc(4, usdt), { type, price: 100, fillPrice })]);
        runBtcMinute(2, 110);
        analyzer.onPortfolioChange([btc(0, usdt + 440)]);
        analyzer.onOrderCompleted([filled('SELL', 3, 110, 4, 0, btc(0, usdt + 440))]);
        runBtcMinute(3, 110);
        report = await finalReport();
      });

      it.each`
        field            | description
        ${'entryPrice'}  | ${'the price of its fills, or the limit of a LIMIT order'}
        ${'entryEquity'} | ${'4 BTC at that price and the USDT left: the 1,000 USDT before it'}
        ${'proceeds'}    | ${'4 BTC sold at 110'}
        ${'pnl'}         | ${'4 BTC sold at 110, bought at that price, no fee known'}
      `('should emit the round trip of the part filled with $field: $description', ({ field }) => {
        const expected = { entryPrice, entryEquity: 1_000, proceeds, pnl }[field as 'entryPrice' | 'entryEquity' | 'proceeds' | 'pnl'];
        expect(emittedRoundTrips()[0][field as keyof RoundTrip]).toBe(expected);
      });

      it.each`
        field           | expected | description
        ${'tradeCount'} | ${2}     | ${'the part filled and the SELL'}
        ${'winRate'}    | ${100}   | ${'one round trip, a win'}
      `('should report $field $expected: $description', ({ field, expected }) => {
        expect(report[field as keyof TradingReport]).toBe(expected);
      });
    });

    describe('when a BUY that names its amount fills before any read of the Trader succeeds', () => {
      // Realtime: the TradingAdvisor read the balance at start-up, 1,000 USDT, then every read of the Trader fails for a while. The
      // warmup of 0 candles ends with the first bucket, at 100. A BUY of 1 BTC at 100, with a fee of 0.1 USDT, fills meanwhile: its end
      // carries the empty portfolio the Trader starts with. The reads come back: a portfolio change shows 1 BTC and 899.9 USDT. The
      // strategy sells the BTC at 110, with a fee of 0.11 USDT: the change of the read its report waits for comes first, 1,009.79 USDT,
      // then its end.
      let report: TradingReport;
      beforeEach(async () => {
        runBtcMinute(0, 100, { completesWarmup: true });
        analyzer.onOrderCompleted([filled('BUY', 1, 100, 1, 0.1, NOT_READ)]);
        runBtcMinute(1, 100);
        analyzer.onPortfolioChange([btc(1, 899.9)]);
        runBtcMinute(2, 110);
        analyzer.onPortfolioChange([btc(0, 1_009.79)]);
        analyzer.onOrderCompleted([filled('SELL', 3, 110, 1, 0.11, btc(0, 1_009.79))]);
        runBtcMinute(3, 110);
        report = await finalReport();
      });

      it.each`
        field            | expected | description
        ${'entryEquity'} | ${NaN}   | ${'unknown: no portfolio was read when its BUY filled'}
        ${'profit'}      | ${NaN}   | ${'unknown without an entry equity'}
        ${'pnl'}         | ${9.79}  | ${'known from its fills: 110 - 100 - 0.21'}
      `('should emit its round trip with $field $expected: $description', ({ field, expected }) => {
        expect(emittedRoundTrips()[0][field as keyof RoundTrip]).toBe(expected);
      });

      it('should count it in the win rate, its P&L known: 100', () => {
        expect(report.winRate).toBe(100);
      });

      it('should leave it out of the returns: no volatility', () => {
        expect(calculateVolatility).toHaveBeenCalledWith([]);
      });

      it('should warn that it is left out of the returns', () => {
        expect(warning).toHaveBeenCalledWith(
          'roundtrip analyzer',
          'Round trip 0 on BTC/USDT left out of the returns, its profit unknown: the Trader had read no portfolio when BUY order BTC-BUY-1 opened it.',
        );
      });
    });

    describe('when a round trip is sold back at its own price without a fee', () => {
      // Prices to 1e-6 and amounts to 1e-4, as on ETH/BTC. From 1 unit of the currency, a BUY of 0.0123 at 0.051234 costs 0.0006301782,
      // which the exchange books as 0.00063018; sold back at 0.051234, it brings in what it cost
      let report: TradingReport;
      beforeEach(async () => {
        runBtcMinute(0, 0.051234, { completesWarmup: true });
        analyzer.onPortfolioChange([btc(0, 1)]);
        analyzer.onOrderCompleted([filled('BUY', 1, 0.051234, 0.0123, 0, btc(0.0123, 0.99936982))]);
        runBtcMinute(1, 0.051234);
        analyzer.onOrderCompleted([filled('SELL', 2, 0.051234, 0.0123, 0, btc(0, 1))]);
        runBtcMinute(2, 0.051234);
        report = await finalReport();
      });

      it.each`
        field
        ${'pnl'}
        ${'profit'}
      `('should emit its round trip with $field 0', ({ field }) => {
        expect(emittedRoundTrips()[0][field as keyof RoundTrip]).toBe(0);
      });

      it('should count it neither as a win nor as a loss: a win rate of 0', () => {
        expect(report.winRate).toBe(0);
      });
    });

    describe('adverse excursion', () => {
      // The warmup of 0 candles ends with the bucket of minute 0: the period starts at minute 1, with 1,000 USDT. The strategy buys
      // 1 BTC on the candle of minute 1 and sells it on that of minute 3, both at 100: the BUY fills in minute 2, the SELL in minute 4.
      // The round trip reads the candles that close after its BUY fills and by the time its SELL does: those of minutes 2 and 3. Every
      // candle is flat at 100, but for the lows given.
      type Delivery = { buyAt: number; buyHeardAfter: number; sellAt: number; sellHeardAfter: number };
      /** 1 BTC bought or sold at 100 at `date`, and the portfolio the Trader read after it */
      const order = (side: OrderSide, date: number, portfolio: Portfolio) => completed('BTC/USDT', side, date, 100, 1, 0, portfolio);
      /** Plays the buckets of minutes 0 to `last`, each order heard after the bucket of the minute its delivery names */
      const play = ({ buyAt, buyHeardAfter, sellAt, sellHeardAfter }: Delivery, lows: Record<number, number>, last = 5) => {
        runBtcMinute(0, 100, { completesWarmup: true });
        analyzer.onPortfolioChange([btc(0, 1_000)]);
        for (let minute = 1; minute <= last; minute++) {
          runBtcMinute(minute, 100, { low: lows[minute] });
          if (minute === buyHeardAfter) analyzer.onOrderCompleted([order('BUY', buyAt, btc(1, 900))]);
          if (minute === sellHeardAfter) analyzer.onOrderCompleted([order('SELL', sellAt, btc(0, 1_000))]);
        }
      };
      /** The adverse excursion of the round trip the play ends */
      const playedExcursion = (...args: Parameters<typeof play>) => {
        play(...args);
        return emittedRoundTrips()[0].maxAdverseExcursion;
      };
      // Live, an order the strategy places at the close of a candle fills a few seconds into the next minute
      const LIVE_FILL_DELAY = 2 * ONE_SECOND;

      // A backtest delivers the end of an order with the bucket it filled in, realtime with the first bucket flushed after the Trader
      // has reported it, most often the next
      describe.each`
        timing                                                            | delay              | buyHeardAfter | sellHeardAfter
        ${'with the bucket each filled in, as a backtest delivers them'}  | ${0}               | ${1}          | ${3}
        ${'with the next bucket, as paper trading most often does'}       | ${0}               | ${2}          | ${4}
        ${'together, with the bucket after the SELL filled'}              | ${0}               | ${4}          | ${4}
        ${'with the next bucket, filled seconds into their minute, live'} | ${LIVE_FILL_DELAY} | ${2}          | ${4}
      `('when the end of each order is heard $timing', ({ delay, buyHeardAfter, sellHeardAfter }) => {
        const delivery = { buyAt: 2 * ONE_MINUTE + delay, buyHeardAfter, sellAt: 4 * ONE_MINUTE + delay, sellHeardAfter };

        it.each`
          minute | low   | excursion | candle
          ${1}   | ${70} | ${0}      | ${'before the minute the BUY fills in, not held'}
          ${2}   | ${95} | ${5}      | ${'of the minute the BUY fills in, held from the fill on'}
          ${3}   | ${97} | ${3}      | ${'before the minute the SELL fills in, the last held'}
          ${4}   | ${80} | ${0}      | ${'of the minute the SELL fills in, left out'}
        `(
          'should end the round trip with an adverse excursion of $excursion % from a low of $low on the candle $candle (minute $minute)',
          ({ minute, low, excursion }) => {
            expect(playedExcursion(delivery, { [minute]: low })).toBe(excursion);
          },
        );
      });

      it('should take back the candles that closed after the SELL before it was heard, each of them deepening the excursion', () => {
        const twoBucketsLate = { buyAt: 2 * ONE_MINUTE, buyHeardAfter: 1, sellAt: 4 * ONE_MINUTE, sellHeardAfter: 5 };
        expect(playedExcursion(twoBucketsLate, { 3: 97, 4: 90, 5: 80 })).toBe(3);
      });

      // The SELL fills at the close of the bucket the BUY is heard after, and is heard with it
      it.each`
        heardAfter               | excursion | description
        ${1 + LATE_FILL_CANDLES} | ${5}      | ${`the oldest of the ${LATE_FILL_CANDLES} kept`}
        ${2 + LATE_FILL_CANDLES} | ${0}      | ${'no longer kept'}
      `(
        'should end with an excursion of $excursion % when the BUY is heard after minute $heardAfter, its first candle $description',
        ({ heardAfter, excursion }) => {
          const late = {
            buyAt: 2 * ONE_MINUTE,
            buyHeardAfter: heardAfter,
            sellAt: (heardAfter + 1) * ONE_MINUTE,
            sellHeardAfter: heardAfter,
          };
          expect(playedExcursion(late, { 2: 95 }, heardAfter)).toBe(excursion);
        },
      );
    });
  });
});
