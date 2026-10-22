import { ORDER_INITIATED_EVENT, PORTFOLIO_CHANGE_EVENT } from '@gekko/shared/constants/event.const';
import { ONE_MINUTE, ONE_SECOND } from '@gekko/shared/constants/time.const';
import type { OrderCompletedEvent, OrderInitiatedEvent, RoundTrip } from '@gekko/shared/models/event.types';
import type { Portfolio } from '@gekko/shared/models/portfolio.types';
import type { Trader } from '@gekko/plugins/trader/trader';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { isNil, isObjectLike, range } from 'lodash-es';
import { minuteOf, REALTIME_START, startFakeClock } from '../../helpers/clock.helper';
import { mockConfiguration, paperExchange, type RawConfiguration } from '../../helpers/configuration.helper';
import { endRealtimeRun, mockRealtimeModules, runRealtimeFor, runRealtimeUntil } from '../../helpers/realtimeRun.helper';
import { MockCCXTExchange } from '../../mocks/ccxt.mock';
import { clearLogs, findLoggedObject, isTextLine, logStore } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// 1. Mock winston, ccxt and the fetcher. Each test runs on real minutes under the fake clock, and ends its run before the next test
// starts (see realtimeRun.helper)
mockRealtimeModules();
// The flows read the strategy's debug lines from the winston mock: the logger hands a debug line to winston only when
// GEKKO_LOG_LEVEL lets it through, and the logger is loaded after this, by the pipeline
process.env.GEKKO_LOG_LEVEL = 'debug';

// 2. Mock Configuration
/** What a scenario runs on the paper exchange, BTC against USDT on 1-minute candles without a warmup */
type PaperRun = {
  strategy: NonNullable<RawConfiguration['strategy']>;
  analyzer: 'RoundTripAnalyzer' | 'PortfolioAnalyzer';
  /** 100 BTC and 300,000 USDT, on the synchronization periods the schema gives, unless the scenario sets its own */
  exchange?: ReturnType<typeof paperExchange>;
};

let paper: PaperRun;

mockConfiguration(() => ({
  watch: { mode: 'realtime', assets: ['BTC'], currency: 'USDT', timeframe: '1m', tickrate: 100, warmup: { candleCount: 0 } },
  exchange:
    paper.exchange ??
    paperExchange([
      { assetName: 'BTC', balance: 100 },
      { assetName: 'USDT', balance: 300000 },
    ]),
  plugins: [{ name: 'TradingAdvisor', strategyName: paper.strategy.name }, { name: 'Trader' }, { name: paper.analyzer }],
  strategy: paper.strategy,
}));

// --------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------

/**
 * The time `minutes` and `seconds` past 12:00 on the fake clock, which starts at 12:00:30 (REALTIME_START). The Heart ticks at 12:01:02
 * and every minute after, each tick fetching the minute that has just closed: the candle of 12:00 at 12:01:02, and so on.
 */
const at = (minutes: number, seconds = 0) => minuteOf(REALTIME_START) + minutes * ONE_MINUTE + seconds * ONE_SECOND;

/** An event the Trader queued for the other plugins, as it queued it, and the time on the fake clock it did */
type TraderEvent = { at: EpochTimeStamp; name: string; payload: unknown };

let traderEvents: TraderEvent[];
let traderEventsSpy: { mockRestore: () => void };

/** An order event, as the scenarios compare it (see orderEvents) */
type OrderEventSummary = {
  at: EpochTimeStamp;
  name: string;
  order: string;
  executedAt?: EpochTimeStamp;
  exchangePrice: number;
  readAt?: EpochTimeStamp;
};

/**
 * The order events the Trader queued, oldest first: when, which one, the order (its side, type and amount, then the price the strategy
 * asked for, none for a MARKET order, or once completed the price it executed at), when it executed, once completed, the last price of
 * its pair, which the event carries, and when the Trader read the balances the event carries (see ExchangeEvent.portfolioReadAt)
 */
const orderEvents = () =>
  traderEvents
    .filter(({ name }) => name !== PORTFOLIO_CHANGE_EVENT)
    .map((event): OrderEventSummary => {
      const { order, exchange } = event.payload as OrderInitiatedEvent | OrderCompletedEvent;
      const { side, type, amount, price } = order;
      const described = `${side} ${type} ${amount}${isNil(price) ? '' : ` at ${price}`}`;
      const execution = 'orderExecutionDate' in order && { executedAt: order.orderExecutionDate };
      return {
        at: event.at,
        name: event.name,
        order: described,
        ...execution,
        exchangePrice: exchange.price,
        readAt: exchange.portfolioReadAt,
      };
    });

/** The ids of the orders the Trader initiated, in the order it did */
const initiatedOrderIds = () =>
  traderEvents.filter(({ name }) => name === ORDER_INITIATED_EVENT).map(({ payload }) => (payload as OrderInitiatedEvent).order.id);

/** The balances the Trader queued as portfolio changes, one per balance it read, oldest first, with the time it read them */
const portfolioChanges = () =>
  traderEvents
    .filter(({ name }) => name === PORTFOLIO_CHANGE_EVENT)
    .map(event => ({ at: event.at, balance: Object.fromEntries(event.payload as Portfolio) }));

/** What the strategy and its StrategyManager logged, oldest first */
const strategyLines = () =>
  logStore
    .filter(isTextLine)
    .filter(({ _tag }) => _tag === 'STRATEGY')
    .map(({ message }) => message);

/** The round trips the RoundTripAnalyzer logged as they closed, oldest first: numbered from 0, where its report is named */
const loggedRoundTrips = () =>
  logStore.map(({ message }) => message).filter(message => isObjectLike(message) && typeof (message as RoundTrip).id === 'number');

/** The report the analyzer logged when the plugins were finalised: the PortfolioAnalyzer logs the length of its equity curve */
const loggedReport = (id: 'TRADING REPORT' | 'PORTFOLIO PROFIT REPORT') => findLoggedObject(message => message.id === id);

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Realtime Paper Trader Flow', () => {
  beforeEach(async () => {
    // Reset inject singletons
    const { inject } = await import('@gekko/core/injecter/injecter');
    inject.reset();
    clearLogs();

    // Reset mocks
    MockCCXTExchange.reset();
    startFakeClock();

    // Every event the Trader queues is recorded as it is queued, copied: the prices and the balances the strategy and the analyzers
    // hear of. The pipeline builds its Trader from this class once the run starts.
    const { Trader } = await import('@gekko/plugins/trader/trader');
    const queue = Trader.prototype.addDeferredEmit;
    traderEvents = [];
    traderEventsSpy = spyOn(Trader.prototype, 'addDeferredEmit').mockImplementation(function (this: Trader, name, payload) {
      traderEvents.push({ at: Date.now(), name, payload: structuredClone(payload) });
      queue.call(this, name, payload);
    });
  });

  // A realtime run never ends by itself: each test ends its own, plugins finalised and orders stopped, before the next one starts
  afterEach(async () => {
    try {
      await endRealtimeRun();
    } finally {
      traderEventsSpy.mockRestore();
    }
  });

  // The round trip reads the one-minute candles that close after its BUY filled, at 12:01:00, and by the time its SELL filled, at
  // 12:02:00: the candle of 12:01 alone. The candle of 12:00 closes as the BUY fills. Each order is reported once the bucket it was sent
  // with is flushed, and heard before the next bucket is processed: the BUY before the candle of 12:01, the SELL before that of 12:02,
  // which closes after the SELL filled. Read as each bucket arrived, when the end of an order was heard after the hooks of the next
  // bucket, the round trip skipped the candle of 12:01, which it held, and read that of 12:02, after it: 0 and 5 in the first and the
  // last rows.
  it.each([
    { candle: 'of 12:01, which the position holds', index: 1, mae: 5 },
    { candle: 'of 12:00, which closes as the BUY fills', index: 0, mae: 0 },
    { candle: 'of 12:02, which closes after the SELL filled', index: 2, mae: 0 },
  ])('Scenario A: one round trip from 100 to 110, a low of 95 on the candle $candle: MAE $mae', async ({ index, mae }) => {
    paper = { strategy: { name: 'DebugRealtime' }, analyzer: 'RoundTripAnalyzer' };
    // DebugRealtime buys 1 BTC with its first candle and sells it with its second. Each candle opens at its close, its high and its low
    // there too, but for the low of 95 of the row.
    MockCCXTExchange.setPredefinedCandles(
      'BTC/USDT',
      [100, 110, 120].map((close, n) => (n === index ? { close, low: 95 } : { close })),
    );

    // The round trip is heard at 12:03:02, as the bucket of 12:02 arrives: the SELL, reported once the bucket of 12:01 was flushed, is
    // delivered before the plugins process the next one
    await runRealtimeUntil(() => loggedRoundTrips().length > 0, { maxMinutes: 5 });
    await endRealtimeRun();

    // The simulator charges the taker fee of the market, Binance's 0.1 %, on top of a MARKET BUY and out of a SELL's proceeds. The BUY of
    // 1 BTC at 100 costs 100.1: 101 BTC and 299,899.9 USDT. The SELL of 1 BTC at 110 brings 110 - 0.11 = 109.89: 100 BTC and 300,009.79
    // USDT.
    expect({
      strategyLines: strategyLines(),
      orderEvents: orderEvents(),
      roundTrips: loggedRoundTrips(),
      report: loggedReport('TRADING REPORT'),
    }).toEqual({
      strategyLines: [
        'Strategy warmup done ! Sending first candle bucket (2024-01-01T12:00:00.000Z) to strategy',
        'Iteration: 0 for BTC/USDT',
        'Trigger BUY for BTC/USDT',
        'Iteration: 1 for BTC/USDT',
        'Trigger SELL for BTC/USDT',
        'Iteration: 2 for BTC/USDT',
      ],
      // The Trader prices each order at the close of the candle it is sent with, which every event of the order carries: it takes the
      // close of each bucket, and the ticker its synchronizations read, at the end of the warmup and after each fill, quotes it too. That
      // ticker quoted a price of its own, about 10,000, which the BUY was priced at and all but the SELL's first event carried, while
      // these candles traded at 100 and 110. Each MARKET order fills as it is sent, at the clock of the simulator, the close of its
      // candle, and is reported before the next tick. Each event carries the balances the Trader read last, and when: the BUY is placed
      // after the read of the end of the warmup, each end comes with the read after it, and the SELL goes out with the BUY's.
      orderEvents: [
        { at: at(1, 2), name: 'orderInitiated', order: 'BUY MARKET 1', exchangePrice: 100, readAt: at(1, 2) },
        { at: at(1, 2), name: 'orderCompleted', order: 'BUY MARKET 1 at 100', executedAt: at(1), exchangePrice: 100, readAt: at(1, 2) },
        { at: at(2, 2), name: 'orderInitiated', order: 'SELL MARKET 1', exchangePrice: 110, readAt: at(1, 2) },
        { at: at(2, 2), name: 'orderCompleted', order: 'SELL MARKET 1 at 110', executedAt: at(2), exchangePrice: 110, readAt: at(2, 2) },
      ],
      roundTrips: [
        {
          id: 0,
          symbol: 'BTC/USDT',
          entryAt: at(1),
          entryPrice: 100,
          // The whole portfolio before the BUY: after it, 101 BTC at its price, 100, and 299,899.9 USDT, 309,999.9, its fee given back:
          // the 100 BTC × 100 + 300,000 USDT held before it
          entryEquity: 310000,
          exitAt: at(2),
          exitPrice: 110,
          // From its fills alone: the BUY of 1 BTC at 100, the SELL of 1 BTC at 110, and their fees, 0.1 and 0.11
          cost: 100,
          proceeds: 110,
          fees: 0.21,
          // 110 - 100 - 0.21: the 100 BTC held before the round trip are not its own. Valued with them, from the pair equity before the
          // BUY to the pair equity after the SELL, 100 × 110 + 300,009.79, it made 1,009.79, their rise from 100 to 110 included.
          pnl: 9.79,
          // 9.79 / 310,000 × 100, to 15 significant digits
          profit: 0.00315806451612903,
          // (100 - 95) / 100 × 100 for the low on the candle of 12:01
          maxAdverseExcursion: mae,
          duration: ONE_MINUTE,
        },
      ],
      report: {
        id: 'TRADING REPORT',
        // From the close of the candle that completed the warmup, 12:00's, to that of the last candle processed, 12:02's
        periodStartAt: at(1),
        periodEndAt: at(3),
        formattedDuration: '2 minutes',
        // The whole portfolio, from 310,000 to 312,009.79, 100 × 120 + 300,009.79 at the last close: the 100 BTC held throughout gain
        // 2,000, the round trip 9.79, 10 less the fees of 0.1 and 0.11
        netProfit: 2009.79,
        // The period is shorter than a day: annualized over a day, 1/366 of the year 2024, 2,009.79 × 366
        annualizedNetProfit: 735583.14,
        // 2,009.79 / 310,000 × 100, to 15 significant digits
        totalReturnPct: 0.64831935483871,
        // 2,009.79 / 310,000 × 100 × 366, to 15 significant digits
        annualizedReturnPct: 237.284883870968,
        // BTC's, the one asset watched: from its close of 12:00, 100, to that of 12:02, 120
        benchmarkAsset: 'BTC',
        marketReturnPct: 20,
        // 0.64831935483871 - 20
        alpha: -19.35168064516129,
        // The round trip, 12:01 to 12:02: 1 of the 2 minutes
        exposurePct: 50,
        // A single profit, which deviates from nothing: no ratio either
        volatility: 0,
        downsideDeviation: 0,
        sharpeRatio: 0,
        sortinoRatio: 0,
        startPrice: 100,
        endPrice: 120,
        startBalance: 310000,
        finalBalance: 312009.79,
        winRate: 100,
        topMAEs: [mae],
        tradeCount: 2,
        // The one pair: its round trip, a win of 9.79, its two trades and its exposure
        pairs: [
          {
            symbol: 'BTC/USDT',
            roundTripCount: 1,
            winCount: 1,
            winRate: 100,
            tradeCount: 2,
            pnl: 9.79,
            exposurePct: 50,
            maxAdverseExcursion: mae,
          },
        ],
        // The run is ended through the signal of its pipeline: the plugins are finalised with the AbortError as the failure that stopped
        // it. The harness destroyed the last stream without an error instead, and the report read as that of a completed run, an end no
        // realtime run has in production.
        interruption: 'The operation was aborted.',
      },
    });
  });

  it('Scenario B: a 0.1 % trailing stop, active at a peak of 10000, its stop at 9990, sells its 1 BTC at 9800 and is over', async () => {
    paper = { strategy: { name: 'DebugTrailingStop', wait: 0, trigger: 9930, percentage: 0.1 }, analyzer: 'RoundTripAnalyzer' };
    MockCCXTExchange.setPredefinedCandles('BTC/USDT', [
      // 12:00: the BUY of 1 BTC, sent with this candle with its stop, fills at its close
      { close: 9500 },
      // 12:01: the BUY's completion, reported once the bucket of 12:00 was flushed, is heard before this candle, and arms the stop, dormant
      // until a high reaches its trigger, 9930
      { close: 9500 },
      // 12:02: opens at its close, 10000, above the trigger: the stop is active from the open, its peak 10000 and its stop price 0.1 %
      // below, 9990, which the low of 9995 stays above
      { close: 10000, low: 9995 },
      // 12:03: opens at its close, 9800, below the stop price: the stop triggers, and its MARKET SELL of 1 BTC fills at 9800
      { close: 9800 },
      // 12:04: the SELL's completion is heard before this candle, for all the stop sells: the stop is over
      { close: 9800 },
    ]);

    // Until the strategy logs the completion of the stop's SELL, at 12:05:02
    const completions = () => strategyLines().filter(line => line.startsWith('Trailing stop order completed')).length;
    await runRealtimeUntil(() => completions() === 2, { maxMinutes: 8 });
    await endRealtimeRun();

    // The StrategyManager hands the strategy the end of each order, the activation and the trigger of the stop, which DebugTrailingStop
    // logs. Once the run has ended, it names the stops still armed or selling ("Strategy ended with…"): none, the stop being over. A stop
    // that ignored its trigger would be said active as it was armed, at a peak and a stop price of 0.
    const [buyId, sellId] = initiatedOrderIds();
    expect({ strategyLines: strategyLines(), orderEvents: orderEvents() }).toEqual({
      strategyLines: [
        'Strategy warmup done ! Sending first candle bucket (2024-01-01T12:00:00.000Z) to strategy',
        'Trailing stop BUY order created',
        `Trailing stop order completed: ${buyId}`,
        `Trailing stop activated: BUY ${buyId} on BTC/USDT, peak 10000, stop price 9990`,
        `Trailing stop triggered: BUY ${buyId} on BTC/USDT at stop price 9990, its MARKET SELL ${sellId} of 1 sent`,
        `Trailing stop order completed: ${sellId}`,
      ],
      // The SELL the stop sends with the candle of 12:03 completes for the amount of the stop, the 1 BTC its BUY filled. It goes out with
      // the balances read after the BUY, three minutes before: nothing read them again since.
      orderEvents: [
        { at: at(1, 2), name: 'orderInitiated', order: 'BUY MARKET 1', exchangePrice: 9500, readAt: at(1, 2) },
        { at: at(1, 2), name: 'orderCompleted', order: 'BUY MARKET 1 at 9500', executedAt: at(1), exchangePrice: 9500, readAt: at(1, 2) },
        { at: at(4, 2), name: 'orderInitiated', order: 'SELL MARKET 1', exchangePrice: 9800, readAt: at(1, 2) },
        { at: at(4, 2), name: 'orderCompleted', order: 'SELL MARKET 1 at 9800', executedAt: at(4), exchangePrice: 9800, readAt: at(4, 2) },
      ],
    });
  });

  it('Scenario C: the synchronization of 12:02:30 reads the 9508.55 USDT a resting LIMIT BUY reserves, which fills at 12:03', async () => {
    paper = {
      // A LIMIT BUY of 1 BTC at 9500 with the candle of 12:00, its first, and a MARKET SELL of 1 BTC with that of 12:04
      strategy: { name: 'DebugBacktest', buyCandleIndex: 0, sellCandleIndex: 4, buyLimitPrice: 9500 },
      analyzer: 'PortfolioAnalyzer',
      exchange: {
        ...paperExchange([
          { assetName: 'BTC', balance: 0 },
          { assetName: 'USDT', balance: 300000 },
        ]),
        // From the start of the Trader, 12:00:30: at 12:02:30, 12:04:30 and 12:06:30
        exchangeSynchInterval: 2 * ONE_MINUTE,
        // Binance's VIP 1 fee for the LIMIT BUY, merged into the fees of the market: the MARKET SELL pays its taker fee, 0.1 %
        feeOverride: { maker: 0.0009 },
      },
    };
    // BTC trades at 10000 every minute, from 12:00 to 12:06, but for the low of 12:02, 9400: the first to reach the LIMIT BUY
    MockCCXTExchange.setPredefinedCandles(
      'BTC/USDT',
      range(7).map(n => (n === 2 ? { close: 10000, low: 9400 } : { close: 10000 })),
    );

    // Seven minutes, to 12:07:30: the balance read at 12:06:30 is delivered with the candle of 12:06, at 12:07:02
    await runRealtimeFor({ minutes: 7 });
    await endRealtimeRun();

    expect({
      orderEvents: orderEvents(),
      portfolioChanges: portfolioChanges(),
      report: loggedReport('PORTFOLIO PROFIT REPORT'),
    }).toEqual({
      // The LIMIT BUY rests from 12:01:02, its cost reserved, 9500 × 1.0009 = 9508.55, until the low of 12:02 reaches it: it fills at its
      // price, at 12:03:00, the close of that candle. It is polled every 20 s from its creation: the poll of 12:03:02 reads it before the
      // candle of 12:02 is processed, that of 12:03:22 reads its fill. The MARKET SELL sent with the candle of 12:04 fills as it is sent,
      // at 10000, and brings 10000 × 0.999 = 9990. It goes out with the balances the periodic read of 12:04:30 read.
      orderEvents: [
        { at: at(1, 2), name: 'orderInitiated', order: 'BUY LIMIT 1 at 9500', exchangePrice: 10000, readAt: at(1, 2) },
        { at: at(3, 22), name: 'orderCompleted', order: 'BUY LIMIT 1 at 9500', executedAt: at(3), exchangePrice: 10000, readAt: at(3, 22) },
        { at: at(5, 2), name: 'orderInitiated', order: 'SELL MARKET 1', exchangePrice: 10000, readAt: at(4, 30) },
        {
          at: at(5, 2),
          name: 'orderCompleted',
          order: 'SELL MARKET 1 at 10000',
          executedAt: at(5),
          exchangePrice: 10000,
          readAt: at(5, 2),
        },
      ],
      // The Trader reads the balance at its start, at the end of the warmup, after each order and every two minutes, and queues each read
      // as a portfolio change. At 12:02:30, while the BUY rests, the read shows what it reserves.
      portfolioChanges: [
        { at: at(0, 30), balance: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 300000, used: 0, total: 300000 } } },
        // At the end of the warmup, with the candle of 12:00
        { at: at(1, 2), balance: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 300000, used: 0, total: 300000 } } },
        // Periodic, the BUY resting
        { at: at(2, 30), balance: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 290491.45, used: 9508.55, total: 300000 } } },
        // After the BUY, from the poll that read its fill
        { at: at(3, 22), balance: { BTC: { free: 1, used: 0, total: 1 }, USDT: { free: 290491.45, used: 0, total: 290491.45 } } },
        { at: at(4, 30), balance: { BTC: { free: 1, used: 0, total: 1 }, USDT: { free: 290491.45, used: 0, total: 290491.45 } } },
        // After the SELL
        { at: at(5, 2), balance: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 300481.45, used: 0, total: 300481.45 } } },
        { at: at(6, 30), balance: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 300481.45, used: 0, total: 300481.45 } } },
      ],
      report: {
        id: 'PORTFOLIO PROFIT REPORT',
        // From the close of the candle that completed the warmup, 12:00's, to that of the last candle processed, 12:06's
        periodStartAt: at(1),
        periodEndAt: at(7),
        formattedDuration: '6 minutes',
        // 9990 - 9508.55: bought 500 below the market, less 8.55 and 10 of fees
        netProfit: 481.45,
        // 481.45 × 366, over a day of 2024
        annualizedNetProfit: 176210.7,
        // 481.45 / 300000 × 100
        totalReturnPct: 0.160483333333333,
        // 481.45 / 300000 × 100 × 366
        annualizedReturnPct: 58.7369,
        marketReturnPct: 0,
        alpha: 0.160483333333333,
        // The curve has a point at the close of each candle, marked once the fills reported before its bucket arrived are heard: the BUY's,
        // read at 12:03:22, before the point of 12:04, the SELL's, reported once the point of 12:05 was marked, before that of 12:06. The
        // spans that end on a point holding BTC, 12:03 to 12:05: 2 of the 6 minutes.
        exposurePct: 33.3333333333333,
        // The curve holds 300000 to 12:03, the reservation counted in the total, then 300491.45 at 12:04 and 12:05, BTC at 10000, and
        // 300481.45 at 12:06 and 12:07, after the SELL. Its 6 returns are four of 0, 0.16381666666667055 (491.45 / 300000 × 100) and
        // -0.003327881708447944 (-10 / 300491.45 × 100): their population standard deviation, and the root mean square of the loss over
        // them
        volatility: 0.06131095614191739,
        downsideDeviation: 0.001358602018339833,
        // 53.7369, the annualized return less the risk-free 5, over each deviation × √(6 returns × 366 a year)
        sharpeRatio: 18.703304831141146,
        sortinoRatio: 844.0422483784159,
        startPrice: 10000,
        endPrice: 10000,
        // The fee of the SELL from the peak of 12:05: 10 / 300491.45 × 100, the last two minutes
        maxDrawdownPct: 0.00332788170844794,
        longestDrawdownMs: 2 * ONE_MINUTE,
        startEquity: 300000,
        endEquity: 300481.45,
        // Counted once per delivery: the reads of the start and of the end of the warmup together, after the hooks of the candle of 12:00,
        // then each of those of 12:02:30, 12:03:22, 12:04:30, 12:05:02 and 12:06:30 as the next bucket arrives, before its hooks
        portfolioChangeCount: 6,
        benchmarkAsset: 'BTC',
        interruption: 'The operation was aborted.',
        // One point per candle after the warmup, that which completed it included
        equityCurveLength: 7,
      },
    });
  });
});
