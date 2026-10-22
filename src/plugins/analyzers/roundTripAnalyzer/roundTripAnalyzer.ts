import { PERFORMANCE_REPORT_EVENT, ROUNDTRIP_COMPLETED_EVENT } from '@constants/event.const';
import { ONE_MINUTE } from '@constants/time.const';
import { describeError } from '@errors/error.helper';
import { getFirstCandleFromBucket } from '@helpers/candle/candle.helper';
import { calculateMarketReturnPct, calculateWinRate, extractTopMAEs } from '@helpers/finance/stats.helper';
import { calculatePortfolioTotalValue, isFetchedPortfolio } from '@helpers/portfolio/portfolio.helper';
import { CandleBucket, OrderCanceledEvent, OrderCompletedEvent, OrderErroredEvent, RoundTrip } from '@models/event.types';
import { Portfolio } from '@models/portfolio.types';
import { Asset, TradingPair } from '@models/utility.types';
import { error, info, warning } from '@services/logger';
import { toISOString } from '@utils/date/date.utils';
import { isFiniteNumber } from '@utils/math/math.utils';
import { listInWords, pluralize } from '@utils/string/string.utils';
import { first, isNil, sortBy, sumBy } from 'lodash-es';
import { Plugin } from '../../plugin';
import { calculatePerformanceStatistics, pickBenchmarkAsset } from '../analyzer.helper';
import { analyzerSchema } from '../analyzer.schema';
import { AnalyzerConfig } from '../analyzer.types';
import { DateRange, Start, TradingReport } from './roundTrip.types';
import { EMPTY_TRADING_REPORT, PLUGIN_NAME } from './roundTripAnalyzer.const';
import { logFinalize, logRoundtrip, measureCoveredMs } from './roundTripAnalyzer.helper';
import { RoundTripTracker } from './roundTripTracker';

/**
 * Measures a strategy round trip by round trip, on every watched pair: a round trip goes from the BUY that opens a position on a pair
 * while flat to the SELL that leaves it flat again, and its P&L comes from its own fills (see RoundTrip). Each pair has a
 * RoundTripTracker of its own, which follows its round trips: the analyzer hands it the candles and the fills of its pair, numbers the
 * round trips it closes across the pairs, logs and emits them. The analyzer holds what the pairs share: the portfolio, which they value
 * together in the currency they share, the last close of every pair, the period, the benchmark, and the report, run-wide, with a
 * breakdown by pair (see TradingReport).
 */
export class RoundTripAnalyzer extends Plugin {
  /** The asset whose price gives the market return of the report (see pickBenchmarkAsset) */
  private readonly benchmarkAsset: Asset;
  private readonly benchmarkPair: TradingPair;
  /**
   * The whole portfolio's value the report ends with: the latest portfolio, marked to market at the close of every timeframe candle
   * and at the end of the run (see markToMarket)
   */
  private currentEquity: number;
  /** The end of the last bucket processed: the close time of its candles */
  private currentTimestamp: EpochTimeStamp;
  /**
   * The period measured, from the close of the timeframe candle that completed the warmup to the end of the last bucket. The start
   * prices and the start equity are taken at that close, and the strategy acts from then on: the start of that candle, a timeframe
   * earlier, would stretch the period by a timeframe and understate the annualized return and the exposure. The report describes the
   * period alone: the trading of the warmup is left out of it (see leaveOutWarmupTrading).
   */
  private dates: DateRange;
  /** The last close of the benchmark pair: the end price of the report */
  private endPrice: number;
  /**
   * The most recent portfolio received: the one the start equity values when the warmup completes, and the one marked to market
   * (see markToMarket). A portfolio change brings it, and so does the end of an order, completed, canceled or in error, which carries
   * the portfolio the Trader read after it: never older than the portfolio change queued before it, and the only news of a fill whose
   * change the portfolioUpdates filter of the Trader holds back, as it does for a fill that moves no balance enough. An order may end
   * in error after a partial fill. Not the empty portfolio of a Trader that has fetched none yet (see refreshLatestPortfolio).
   */
  private latestPortfolio: Portfolio | null;
  /** The last close of every watched pair, which the portfolio is valued at (see valuePortfolio) */
  private readonly latestPrices: Map<TradingPair, number>;
  /**
   * The id of the next round trip to close: the ids follow one another through the run in the order the round trips close, every pair
   * together, the round trips of the warmup included
   */
  private nextRoundTripId: number;
  private riskFreeReturn: number;
  private start: Start;
  /** The close of the benchmark pair when the warmup completed: the start price of the report, null until then */
  private startPrice: number | null;
  /** The round trips of each watched pair, in the order of watch.assets */
  private readonly trackers: Map<TradingPair, RoundTripTracker>;
  private warmupCompleted: boolean;
  private enableConsoleTable: boolean;

  constructor({ riskFreeReturn, enableConsoleTable, benchmarkAsset }: AnalyzerConfig) {
    super(PLUGIN_NAME);

    this.benchmarkAsset = pickBenchmarkAsset(this.assets, benchmarkAsset, 'roundtrip analyzer');
    this.benchmarkPair = `${this.benchmarkAsset}/${this.currency}`;
    this.currentEquity = 0;
    this.currentTimestamp = 0;
    this.dates = { start: 0, end: 0 };
    this.endPrice = 0;
    this.latestPortfolio = null;
    this.latestPrices = new Map();
    this.nextRoundTripId = 0;
    this.riskFreeReturn = riskFreeReturn ?? 5;
    this.start = { equity: 0, portfolio: null };
    this.startPrice = null;
    this.trackers = new Map(
      this.pairs.map((symbol, index) => [
        symbol,
        new RoundTripTracker({
          symbol,
          asset: this.assets[index],
          currency: this.currency,
          // The pair of the tracker at the price given, every other pair at its last close
          valuePortfolio: (portfolio, price) => this.valuePortfolio(portfolio, new Map(this.latestPrices).set(symbol, price)),
          nextRoundTripId: () => this.nextRoundTripId++,
        }),
      ]),
    );
    this.warmupCompleted = false;
    this.enableConsoleTable = enableConsoleTable;
  }

  // --- BEGIN LISTENERS ---

  public onPortfolioChange(events: Portfolio[]): void {
    // Latest strategy: only process the most recent payload
    const portfolio = events[events.length - 1];
    this.latestPortfolio = portfolio;

    // The start is taken when the warmup completes (see Start), unless no portfolio had been received by then
    if (!this.warmupCompleted || this.start.portfolio) return;
    this.start = { equity: this.valuePortfolio(portfolio), portfolio };
    // Received before the next bucket, it is valued at the start prices all the same. So is the first portfolio of the Trader with the
    // default warmup of 0 candles: the first bucket completes the warmup, and its end is delivered first.
    if (this.currentTimestamp === this.dates.start) return;
    warning(
      'roundtrip analyzer',
      `No portfolio received during the warmup: start equity taken late, at the prices of ${toISOString(this.currentTimestamp)}.`,
    );
  }

  /**
   * Starts the period with the bucket that completed the warmup, which processOneMinuteBucket has read before this event: its closes
   * are the start prices, of the benchmark and of each pair, and value the start equity (see Start). A watched pair without a candle in
   * the timeframe bucket leaves the warmup uncompleted, with a warning.
   */
  public onStrategyWarmupCompleted(timeframeBuckets: CandleBucket[]): void {
    // Only one warmup event is expected
    const timeframeBucket = first(timeframeBuckets);
    const missing = this.pairs.filter(pair => !timeframeBucket?.has(pair));
    for (const pair of missing) warning('roundtrip analyzer', `Missing candle for ${pair} during warmup completion.`);
    if (missing.length) return;

    this.warmupCompleted = true;
    // The period starts at the close of that candle (see dates): the end of the bucket that completed it. It ends there too until the
    // next bucket.
    this.dates = { start: this.currentTimestamp, end: this.currentTimestamp };
    // The close of the benchmark pair in that bucket, which processOneMinuteBucket recorded as the end price: the market return's start
    this.startPrice = this.endPrice;
    // The latest portfolio, valued at the start prices (see Start). Without one yet, the next portfolio received gives the start.
    const portfolio = this.latestPortfolio;
    if (portfolio) this.start = { equity: this.valuePortfolio(portfolio), portfolio };
    this.leaveOutWarmupTrading();
  }

  /**
   * Marks the whole portfolio's value to market at the close of every timeframe candle after the warmup. The timeframe candle event
   * comes with the bucket that closed the candle, whose closes processOneMinuteBucket has recorded as the last prices: those of the
   * candle. The end of the run is marked too (see processFinalize).
   */
  public onTimeframeCandle(_timeframeBuckets: CandleBucket[]): void {
    this.markToMarket();
  }

  public onOrderCompleted(events: OrderCompletedEvent[]): void {
    for (const { order, exchange } of events) {
      const closed = this.findTracker(order)?.registerCompleted(order, exchange.portfolio);
      if (closed) this.handleCompletedRoundtrip(closed);
      // The portfolio after the fill is the latest, whether the fill counts in a round trip or not (see latestPortfolio)
      this.refreshLatestPortfolio(exchange.portfolio);
    }
  }

  /**
   * A BUY or a SELL canceled after a partial fill counts for the part it filled, on the tracker of its pair (see
   * RoundTripTracker.registerCanceled). A cancelation with no fill counts for nothing, but its portfolio is the latest all the same (see
   * latestPortfolio).
   */
  public onOrderCanceled(events: OrderCanceledEvent[]): void {
    for (const { order, exchange } of events) {
      const { filled } = order;
      // No fill reported (undefined) counts for nothing, as 0 does
      if (!isNil(filled) && filled > 0) {
        const closed = this.findTracker(order)?.registerCanceled(order, filled, exchange.portfolio);
        if (closed) this.handleCompletedRoundtrip(closed);
      }
      this.refreshLatestPortfolio(exchange.portfolio);
    }
  }

  /**
   * An order that ended in error only refreshes the latest portfolio (see latestPortfolio). It may have filled in part before, as its
   * event says (`order.filled`, what the exchange reported, more having maybe executed when the order may still be live), but that
   * part counts in no round trip: what the account still holds catches the part a SELL sold (see RoundTripTracker.registerSell), not the
   * part a BUY bought.
   */
  public onOrderErrored(events: OrderErroredEvent[]): void {
    for (const { exchange } of events) this.refreshLatestPortfolio(exchange.portfolio);
  }
  // --- END LISTENERS ---

  // --- BEGIN INTERNALS ---

  /**
   * The tracker of the pair of an order; undefined, with a warning, for a pair this run does not watch, which no order of the strategy
   * can name (createOrder refuses it): such an event is said and skipped, not counted on another pair
   */
  private findTracker({ id, side, symbol }: Pick<OrderCompletedEvent['order'], 'id' | 'side' | 'symbol'>): RoundTripTracker | undefined {
    const tracker = this.trackers.get(symbol);
    if (!tracker) {
      const watched = listInWords(this.pairs);
      warning('roundtrip analyzer', `${side} order ${id} on ${symbol}, a pair this run does not watch (${watched}): skipped.`);
    }
    return tracker;
  }

  /** Takes the portfolio an order event carries as the latest (see latestPortfolio), unless the Trader had fetched none yet */
  private refreshLatestPortfolio(portfolio: Portfolio): void {
    if (isFetchedPortfolio(portfolio)) this.latestPortfolio = portfolio;
  }

  /**
   * The whole portfolio's value in the currency: the currency, and every watched asset at the price of its pair, the last closes unless
   * `prices` gives others. The pair of each watched asset is read from Plugin.pairs, which holds them in the order of Plugin.assets,
   * rather than built anew on every call. An asset that is not watched (BNB kept for the fees) is left out.
   */
  private valuePortfolio(portfolio: Portfolio, prices = this.latestPrices): number {
    return calculatePortfolioTotalValue(portfolio, prices, this.currency, this.assets, this.pairs);
  }

  /**
   * The report describes the period alone (see dates): a trade counted before it starts is left out of it, with the round trips it
   * closed, and a round trip still open is rebased at the start of the period, on each pair (see RoundTripTracker.startPeriod). Logged
   * once, every pair together, before the rebasing of each pair is.
   */
  private leaveOutWarmupTrading(): void {
    const trackers = [...this.trackers.values()];
    const tradeCount = sumBy(trackers, tracker => tracker.tradeCount);
    if (tradeCount > 0) {
      const roundTripCount = sumBy(trackers, tracker => tracker.closedRoundTrips.length);
      const trades = `${tradeCount} ${pluralize('trade', tradeCount)}`;
      const roundTrips = `${roundTripCount} ${pluralize('round trip', roundTripCount)}`;
      const warmupTrading = `the ${trades} of the warmup, and the ${roundTrips} they closed`;
      info(
        'roundtrip analyzer',
        `The report measures the period from ${toISOString(this.dates.start)} on: ${warmupTrading}, are left out.`,
      );
    }
    for (const tracker of trackers) tracker.startPeriod({ at: this.dates.start, equity: this.start.equity });
  }

  /** The whole portfolio's value: the latest portfolio at the last closes, once the warmup has completed */
  private markToMarket(): void {
    if (!this.warmupCompleted || !this.latestPortfolio) return;
    this.currentEquity = this.valuePortfolio(this.latestPortfolio);
  }

  /**
   * Logs the round trip a tracker closed, naming its pair in its table when the run watches several, and emits it. A round trip has no
   * id of its pair: the ids follow one another across the pairs (see nextRoundTripId).
   */
  private handleCompletedRoundtrip(roundTrip: RoundTrip): void {
    logRoundtrip(roundTrip, this.currency, this.enableConsoleTable, this.pairs.length > 1);
    this.addDeferredEmit<RoundTrip>(ROUNDTRIP_COMPLETED_EVENT, roundTrip);
  }

  private calculateReportStatistics(): TradingReport {
    // Said apart: the three read alike as "No portfolio data received", a start worth 0 included, which sent the user looking for a
    // Trader or an exchange that had sent one
    if (!this.startPrice) {
      warning('roundtrip analyzer', 'The warmup never completed: no period to measure. Emitting empty report.');
      return EMPTY_TRADING_REPORT;
    }
    if (!this.start.portfolio) {
      warning('roundtrip analyzer', 'No portfolio data received. Emitting empty report.');
      return EMPTY_TRADING_REPORT;
    }
    // The returns are relative to the start equity: a portfolio worth nothing when the period started has none
    if (!(this.start.equity > 0)) {
      warning('roundtrip analyzer', `Start equity of ${this.start.equity} ${this.currency}: no return to measure. Emitting empty report.`);
      return EMPTY_TRADING_REPORT;
    }

    const trackers = [...this.trackers.values()];
    // The round trips closed during the period, every pair together, in the order they closed, which their ids follow
    const roundTrips = sortBy(
      trackers.flatMap(tracker => tracker.closedRoundTrips),
      ({ id }) => id,
    );
    const statistics = calculatePerformanceStatistics(
      {
        periodStartAt: this.dates.start,
        periodEndAt: this.dates.end,
        startEquity: this.start.equity,
        endEquity: this.currentEquity,
        // The profits of the round trips closed, in % of their entry equity: one whose entry no portfolio read valued has none (see
        // RoundTripTracker.closeRoundTrip), and the positions still open at the end are in none
        returns: roundTrips.map(({ profit }) => profit).filter(isFiniteNumber),
        marketReturnPct: calculateMarketReturnPct(this.endPrice, this.startPrice),
        // The time spent in a round trip on any pair: the round trips of two pairs held at once count the time they share once
        exposureMs: measureCoveredMs(
          trackers.flatMap(tracker => tracker.exposureIntervals(this.dates.end)),
          this.dates,
        ),
        riskFreeReturn: this.riskFreeReturn,
      },
      'roundtrip analyzer',
    );

    return {
      id: 'TRADING REPORT',
      ...statistics,
      startPrice: this.startPrice,
      endPrice: this.endPrice,
      benchmarkAsset: this.benchmarkAsset,
      startBalance: this.start.equity,
      finalBalance: this.currentEquity,
      // Every round trip closed: its P&L is known from its fills, its profit unknown at worst. Rounded once, by the printers: rounded to
      // 4 decimals here first, 40 wins of 103 (38.83495 %) were written 38.84 %.
      winRate: calculateWinRate(roundTrips.filter(({ pnl }) => pnl > 0).length, roundTrips.length),
      topMAEs: extractTopMAEs(roundTrips.map(({ maxAdverseExcursion }) => maxAdverseExcursion)),
      tradeCount: sumBy(trackers, tracker => tracker.tradeCount),
      pairs: trackers.map(tracker => tracker.summarize(this.dates)),
    };
  }
  // --- END INTERNALS ---

  // --------------------------------------------------------------------------
  //                           PLUGIN LIFECYCLE HOOKS
  // --------------------------------------------------------------------------

  protected processInit(): void {
    /* noop */
  }

  /**
   * Records the close of every watched pair, the benchmark's as the end price, and hands each tracker the candle of its pair: counted
   * in the adverse excursion of its round trip in progress once the period has started (see RoundTripTracker.readCandle). A pair
   * missing from the bucket is warned of, and keeps its last close.
   */
  protected processOneMinuteBucket(bucket: CandleBucket): void {
    // In epoch milliseconds, the end of the minute every candle of the bucket shares: date-fns' addMinutes built two Dates on every
    // bucket for this sum
    this.currentTimestamp = getFirstCandleFromBucket(bucket).start + ONE_MINUTE;
    for (const tracker of this.trackers.values()) {
      const candle = bucket.get(tracker.symbol);
      if (!candle) {
        warning('roundtrip analyzer', `Missing candle for ${tracker.symbol} in bucket.`);
        continue;
      }
      this.latestPrices.set(tracker.symbol, candle.close);
      if (tracker.symbol === this.benchmarkPair) this.endPrice = candle.close;
      tracker.readCandle(candle, this.warmupCompleted);
    }
    if (this.warmupCompleted) this.dates.end = this.currentTimestamp;
  }

  protected async processFinalize(failure?: Error): Promise<void> {
    // The end is marked to market too: the last bucket may have closed no timeframe candle, and orders may have filled since the last
    // close that did
    this.markToMarket();
    // A run stopped before its end (a crash, missing candles, the circuit breaker) gives the report of a partial period, and says why
    const report: TradingReport = { ...this.calculateReportStatistics(), ...(failure && { interruption: failure.message }) };
    if (this.enableConsoleTable) logFinalize(report, this.currency);
    else info('roundtrip analyzer', report);
    for (const tracker of this.trackers.values()) tracker.logOpenPosition();

    // Emit directly: processFinalize is the final lifecycle hook. Awaited, so that the run ends once the listeners are done with the
    // report, and caught: the report is logged above whatever a listener does with it. Neither awaited nor caught, a listener that
    // failed rejected a promise nobody held, and a backtest that ended normally exited with code 1.
    try {
      await this.emit<TradingReport>(PERFORMANCE_REPORT_EVENT, report);
    } catch (err) {
      error('roundtrip analyzer', `A listener failed on the performance report: ${describeError(err)}`);
    }
  }

  public static getStaticConfiguration() {
    return {
      schema: analyzerSchema,
      modes: ['realtime', 'backtest'],
      dependencies: [],
      inject: [],
      eventsHandlers: Object.getOwnPropertyNames(RoundTripAnalyzer.prototype).filter(p => p.startsWith('on')),
      eventsEmitted: [PERFORMANCE_REPORT_EVENT, ROUNDTRIP_COMPLETED_EVENT],
      name: PLUGIN_NAME,
    };
  }
}
