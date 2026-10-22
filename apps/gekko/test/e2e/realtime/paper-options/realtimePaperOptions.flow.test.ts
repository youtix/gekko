import { PORTFOLIO_CHANGE_EVENT } from '@gekko/shared/constants/event.const';
import { ONE_MINUTE, ONE_SECOND } from '@gekko/shared/constants/time.const';
import type { Portfolio } from '@gekko/shared/models/portfolio.types';
import type { Trader as TraderClass } from '@gekko/plugins/trader/trader';
import type { traderSchema } from '@gekko/schemas/plugins/trader.schema';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import { REALTIME_START, startFakeClock } from '../../helpers/clock.helper';
import { paperExchange, type RawConfiguration } from '../../helpers/configuration.helper';
import { endRealtimeRun, mockRealtimeModules, runRealtimeUntil, useRealtimeConfiguration } from '../../helpers/realtimeRun.helper';
import { MockCCXTExchange } from '../../mocks/ccxt.mock';
import { clearLogs, findLoggedObject, findTextLines } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// 1. Mock winston, ccxt and the fetcher. Each test runs on real minutes under the fake clock, from 12:00:30, and ends its run before
// the next test starts (see realtimeRun.helper)
mockRealtimeModules();
// The Trader's lines read here are info lines, which the logger hands winston whatever the level: set, so that a level in the
// environment cannot add the debug lines
process.env.GEKKO_LOG_LEVEL = 'info';

// 2. Configuration: paper trading of BTC, DebugRealtime buying 1 BTC on the first candle, 12:00, and selling it on the second, unless a
// run gives the block of another strategy
type PaperRun = {
  balance: { BTC: number; USDT: number };
  trader?: Omit<z.input<typeof traderSchema>, 'name'>;
  feeOverride?: { maker?: number; taker?: number };
  analyzer?: 'RoundTripAnalyzer';
  strategy?: NonNullable<RawConfiguration['strategy']>;
};
let paperRun: PaperRun;
useRealtimeConfiguration(
  (): RawConfiguration => ({
    watch: { mode: 'realtime', assets: ['BTC'], currency: 'USDT', timeframe: '1m', warmup: { candleCount: 0 } },
    exchange: {
      ...paperExchange([
        { assetName: 'BTC', balance: paperRun.balance.BTC },
        { assetName: 'USDT', balance: paperRun.balance.USDT },
      ]),
      feeOverride: paperRun.feeOverride,
    },
    plugins: [
      { name: 'TradingAdvisor', strategyName: paperRun.strategy?.name ?? 'DebugRealtime' },
      { name: 'Trader', ...paperRun.trader },
      ...(paperRun.analyzer ? [{ name: paperRun.analyzer }] : []),
    ],
    strategy: paperRun.strategy ?? { name: 'DebugRealtime' },
  }),
);

// --------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------

/** The start of the minute hh:mm of the day the runs start on, 2024-01-01 (see REALTIME_START) */
const minute = (hours: number, minutes: number) => Date.UTC(2024, 0, 1, hours, minutes);

/** A portfolio the Trader emitted: when, and the total of each asset */
type EmittedPortfolio = { at: EpochTimeStamp; totals: Record<string, number> };

let Trader: typeof TraderClass;
let addDeferredEmit: TraderClass['addDeferredEmit'];
let emittedPortfolios: EmittedPortfolio[] = [];

/** How many synchronizations the Trader started: it reads the balance and the tickers, then emits the portfolio unless filtered */
const countSynchronizations = () => findTextLines('Synchronizing data with paper-binance', 'info').length;

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Realtime paper trading options', () => {
  beforeEach(async () => {
    clearLogs();
    MockCCXTExchange.reset();
    // The closes of 12:00 and 12:01, the candles DebugRealtime buys and sells on, then two more
    MockCCXTExchange.setPredefinedCandles('BTC/USDT', [{ close: 100 }, { close: 110 }, { close: 120 }, { close: 125 }]);

    // Every portfolio the Trader queues as a portfolio change, as it queues it: the run's own Trader, which the pipeline builds
    ({ Trader } = await import('@gekko/plugins/trader/trader'));
    addDeferredEmit = Trader.prototype.addDeferredEmit;
    emittedPortfolios = [];
    Trader.prototype.addDeferredEmit = function <T>(this: TraderClass, name: string, payload: T) {
      if (name === PORTFOLIO_CHANGE_EVENT) {
        const totals = Object.fromEntries(Array.from(payload as Portfolio, ([asset, { total }]) => [asset, total]));
        emittedPortfolios.push({ at: Date.now(), totals });
      }
      return addDeferredEmit.call(this, name, payload);
    };
    startFakeClock();
  });

  afterEach(async () => {
    // A realtime run never ends by itself: each test ends its own, plugins finalised and orders stopped, before the next one starts
    try {
      await endRealtimeRun();
    } finally {
      Trader.prototype.addDeferredEmit = addDeferredEmit;
    }
  });

  // The Trader synchronizes at start-up (12:00:30), at the end of the warmup, with the first candle (12:01:02), and after each order,
  // the BUY of 12:01:02 and the SELL of 12:02:02. The BUY of 1 BTC at 100 costs 100.1 with Binance's 0.1 % taker fee: 2 BTC and
  // 299,899.9 USDT. The SELL at 110 brings 110 - 0.11: 1 BTC and 300,009.79 USDT.
  const start = { at: REALTIME_START, totals: { BTC: 1, USDT: 300000 } };
  const warmupEnd = { at: minute(12, 1) + 2 * ONE_SECOND, totals: { BTC: 1, USDT: 300000 } };
  const afterBuy = { at: minute(12, 1) + 2 * ONE_SECOND, totals: { BTC: 2, USDT: 299899.9 } };
  const afterSell = { at: minute(12, 2) + 2 * ONE_SECOND, totals: { BTC: 1, USDT: 300009.79 } };

  it.each([
    ['left out: every synchronization emitted', undefined, [start, warmupEnd, afterBuy, afterSell]],
    [
      'threshold 60 %: the BUY doubling the BTC held emitted, the SELL halving it and the warmup unchanged held back',
      { threshold: 60, dust: 1 },
      [start, afterBuy],
    ],
    ['threshold 100 %: a BTC held doubled, a change of 100 %, is not above it', { threshold: 100, dust: 1 }, [start]],
    [
      'dust 150 USDT: 1 BTC at 100 or at 110 is dust, 2 at 100 are not: each crossing emitted, whatever the threshold',
      { threshold: 1000, dust: 150 },
      [start, afterBuy, afterSell],
    ],
  ])('Scenario A: portfolioUpdates %s', async (_title, portfolioUpdates, emitted) => {
    paperRun = { balance: { BTC: 1, USDT: 300000 }, trader: portfolioUpdates && { portfolioUpdates } };

    await runRealtimeUntil(() => countSynchronizations() === 4, { maxMinutes: 5 });

    // The first synchronization always emits. A later one emits when an asset crossed the dust (its total valued at the ticker, the
    // currency at 1), or when the total of an asset held changed by more than the threshold since the last portfolio emitted
    expect({ synchronizations: countSynchronizations(), emitted: emittedPortfolios }).toEqual({ synchronizations: 4, emitted });
  });

  // The rows above emit the same portfolios whether the filter compares a read with the last portfolio emitted, as it does, or with the
  // read before it: here two BUYs of 1 BTC from 3, on the first two candles, each a change under the threshold, add up above it
  it('Scenario A: portfolioUpdates threshold 50 %: two changes of the BTC held under it, emitted once they add up above it', async () => {
    paperRun = {
      balance: { BTC: 3, USDT: 300000 },
      trader: { portfolioUpdates: { threshold: 50, dust: 1 } },
      strategy: {
        name: 'DebugOrderScript',
        orders: [
          { candle: 0, side: 'BUY', type: 'MARKET' },
          { candle: 1, side: 'BUY', type: 'MARKET' },
        ],
      },
    };

    await runRealtimeUntil(() => countSynchronizations() === 4, { maxMinutes: 5 });

    // The start, then the warmup end and the first BUY with the first candle (12:01:02), the second BUY with the second (12:02:02). 3 to 4
    // BTC is 33 % since the portfolio emitted at start-up: held back. 4 to 5 is 25 % since the read before it, but 67 % since that
    // portfolio: emitted. The BUY at 100 costs 100.1, the BUY at 110 costs 110.11: 300,000 - 100.1 - 110.11 = 299,789.79 USDT.
    expect({ synchronizations: countSynchronizations(), emitted: emittedPortfolios }).toEqual({
      synchronizations: 4,
      emitted: [
        { at: REALTIME_START, totals: { BTC: 3, USDT: 300000 } },
        { at: minute(12, 2) + 2 * ONE_SECOND, totals: { BTC: 5, USDT: 299789.79 } },
      ],
    });
  });

  it.each([
    [
      'taker 0.2 %: the MARKET orders pay it',
      { taker: 0.002 },
      // The BUY of 1 BTC at 100 pays 0.2: 101 BTC and 299,899.8 USDT, worth 309,999.8 at 100, and 310,000 with the fee given back. The
      // SELL of 1 BTC at 110 pays 0.22: 110 - 100 - 0.42.
      { fees: 0.42, pnl: 9.58, profit: 0.00309032258064516 },
    ],
    [
      "maker 0: the taker fee it leaves out stays Binance's, 0.1 %",
      { maker: 0 },
      // The BUY pays 0.1, the SELL 0.11: 110 - 100 - 0.21
      { fees: 0.21, pnl: 9.79, profit: 0.00315806451612903 },
    ],
  ])('Scenario B: feeOverride %s', async (_title, feeOverride, { fees, pnl, profit }) => {
    paperRun = { balance: { BTC: 100, USDT: 300000 }, feeOverride, analyzer: 'RoundTripAnalyzer' };

    // The round trip exits on the second candle, and is heard as the third arrives, before the plugins process it
    const isRoundTrip = (message: Record<string, any>) => message.id === 0 && 'exitAt' in message;
    await runRealtimeUntil(() => findLoggedObject(isRoundTrip) !== undefined, { maxMinutes: 5 });

    // From the BUY on the candle of 12:00, filled at its end, to the SELL on that of 12:01. Its P&L is that of its fills, 1 BTC bought at
    // 100 and sold at 110, less their fees: the 100 BTC held before it, which that move valued 1,000 higher, are not its own. The profit
    // is the pnl over the entry equity, the whole portfolio before the BUY, in %, to 15 significant digits. The low of the candle held,
    // 110, is above the entry price: no adverse excursion.
    expect(findLoggedObject(isRoundTrip)).toEqual({
      id: 0,
      symbol: 'BTC/USDT',
      entryAt: minute(12, 1),
      entryPrice: 100,
      entryEquity: 310000,
      exitAt: minute(12, 2),
      exitPrice: 110,
      cost: 100,
      proceeds: 110,
      fees,
      pnl,
      profit,
      maxAdverseExcursion: 0,
      duration: ONE_MINUTE,
    });
  });
});
