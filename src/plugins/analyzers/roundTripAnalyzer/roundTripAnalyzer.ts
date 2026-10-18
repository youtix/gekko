import { PERFORMANCE_REPORT_EVENT, ROUNDTRIP_COMPLETED_EVENT } from '@constants/event.const';
import { ONE_MINUTE } from '@constants/time.const';
import { describeError } from '@errors/error.helper';
import { RingBuffer } from '@helpers/collection/ringBuffer';
import { calculateMarketReturnPct, calculateWinRate, extractTopMAEs } from '@helpers/finance/stats.helper';
import { calculatePairEquity, getAssetBalance, isFetchedPortfolio } from '@helpers/portfolio/portfolio.helper';
import { CandleBucket, OrderCanceledEvent, OrderCompletedEvent, OrderErroredEvent, RoundTrip } from '@models/event.types';
import { Portfolio } from '@models/portfolio.types';
import { Asset, TradingPair } from '@models/utility.types';
import { debug, error, info, warning } from '@services/logger';
import { toISOString } from '@utils/date/date.utils';
import { addPrecise, isFiniteNumber } from '@utils/math/math.utils';
import { formatAmount, formatSignedPercent, pluralize } from '@utils/string/string.utils';
import { first, isNil, sumBy } from 'lodash-es';
import { Plugin } from '../../plugin';
import { DUST_TOLERANCE } from '../analyzer.const';
import { calculatePerformanceStatistics } from '../analyzer.helper';
import { analyzerSchema } from '../analyzer.schema';
import { AnalyzerConfig } from '../analyzer.types';
import { DateRange, ExcursionCandle, Fill, OpenRoundTrip, OrderFill, Start, TradingReport } from './roundTrip.types';
import { EMPTY_TRADING_REPORT, LATE_FILL_CANDLES, PLUGIN_NAME } from './roundTripAnalyzer.const';
import {
  addToMeanPrice,
  countCandle,
  getEquityChange,
  logFinalize,
  logRoundtrip,
  measureAdverseExcursion,
  measureRoundTrip,
} from './roundTripAnalyzer.helper';

export class RoundTripAnalyzer extends Plugin {
  /**
   * The pair equity the report ends with: the latest portfolio, marked to market at the close of every timeframe candle and at the
   * end of the run (see markToMarket), and updated with every portfolio change and every SELL in between
   */
  private currentEquity: number;
  /** The end of the last bucket processed: the close time of its candle */
  private currentTimestamp: EpochTimeStamp;
  private lastPriceUpdate: number;
  /**
   * The period measured, from the close of the timeframe candle that completed the warmup to the end of the last bucket. The start
   * price and the start equity are taken at that close, and the strategy acts from then on: the start of that candle, a timeframe
   * earlier, would stretch the period by a timeframe and understate the annualized return and the exposure. The report describes the
   * period alone: the trading of the warmup is left out of it (see leaveOutWarmupTrading).
   */
  private dates: DateRange;
  private endPrice: number;
  /**
   * The most recent portfolio received: the one the start equity values when the warmup completes, and the one marked to market
   * (see markToMarket). A portfolio change brings it, and so does the end of an order, completed, canceled or in error, which carries
   * the portfolio the Trader read after it: never older than the portfolio change queued before it, and the only news of a fill whose
   * change the portfolioUpdates filter of the Trader holds back, as it does for a fill that moves no balance enough. An order may end
   * in error after a partial fill. Not the empty portfolio of a Trader that has fetched none yet (see refreshLatestPortfolio).
   */
  private latestPortfolio: Portfolio | null;
  /** The id of the next round trip to end: the ids follow one another through the run, the round trips of the warmup included */
  private nextRoundTripId: number;
  /** The round trip in progress, null while flat */
  private openRoundTrip: OpenRoundTrip | null;
  /**
   * The one-minute candles of the last LATE_FILL_CANDLES minutes of the period, oldest first: those that closed after the BUY that
   * opens a round trip, read before that BUY was heard, count in its adverse excursion once it is (see countCandle)
   */
  private recentCandles: RingBuffer<ExcursionCandle>;
  private riskFreeReturn: number;
  /** The round trips closed during the period */
  private roundTrips: RoundTrip[];
  private start: Start;
  private startPrice: number | null;
  /** The fills counted as trades: during the warmup, then from the start of the period (see leaveOutWarmupTrading) */
  private tradeCount: number;
  private warmupCompleted: boolean;
  private enableConsoleTable: boolean;
  private asset: Asset;
  private symbol: TradingPair;

  constructor({ riskFreeReturn, enableConsoleTable }: AnalyzerConfig) {
    super(PLUGIN_NAME);

    if (this.assets.length !== 1) throw new Error('RoundTripAnalyzer can only be used with a single pair');

    this.symbol = this.pairs[0];
    this.asset = this.assets[0];
    this.currentEquity = 0;
    this.currentTimestamp = 0;
    this.lastPriceUpdate = 0;
    this.dates = { start: 0, end: 0 };
    this.endPrice = 0;
    this.latestPortfolio = null;
    this.nextRoundTripId = 0;
    this.openRoundTrip = null;
    this.recentCandles = new RingBuffer(LATE_FILL_CANDLES);
    this.riskFreeReturn = riskFreeReturn ?? 5;
    this.roundTrips = [];
    this.start = { equity: 0, portfolio: null };
    this.startPrice = null;
    this.tradeCount = 0;
    this.warmupCompleted = false;
    this.enableConsoleTable = enableConsoleTable;
  }

  // --- BEGIN LISTENERS ---

  public onPortfolioChange(events: Portfolio[]): void {
    // Latest strategy: only process the most recent payload
    const portfolio = events[events.length - 1];
    this.latestPortfolio = portfolio;
    this.currentEquity = calculatePairEquity(portfolio, this.symbol, this.lastPriceUpdate).total;

    // The start is taken when the warmup completes (see Start), unless no portfolio had been received by then
    if (!this.warmupCompleted || this.start.portfolio) return;
    this.start = { equity: this.currentEquity, portfolio };
    // Valued at the start price, it is the start equity all the same. So is a portfolio received before the next bucket, such as the
    // first one of the Trader with the default warmup of 0 candles: the first bucket completes it, and its end is delivered first.
    if (this.lastPriceUpdate === this.startPrice) return;
    warning(
      'roundtrip analyzer',
      `No portfolio received during the warmup: start equity taken late, at ${this.lastPriceUpdate} (start price ${this.startPrice}).`,
    );
  }

  public onStrategyWarmupCompleted(timeframeBuckets: CandleBucket[]): void {
    // Only one warmup event is expected
    const timeframeBucket = first(timeframeBuckets);
    const candle = timeframeBucket?.get(this.symbol);
    if (!candle) {
      warning('roundtrip analyzer', `Missing candle for ${this.symbol} during warmup completion.`);
      return;
    }
    this.warmupCompleted = true;
    // The period starts at the close of that candle (see dates): the end of the bucket that completed it, which processOneMinuteBucket
    // has seen before this event. It ends there too until the next bucket.
    this.dates = { start: this.currentTimestamp, end: this.currentTimestamp };
    this.startPrice = candle.close;
    this.endPrice = candle.close;
    // The latest portfolio, valued at the start price (see Start). Without one yet, the next portfolio received gives the start.
    const portfolio = this.latestPortfolio;
    if (portfolio) this.start = { equity: calculatePairEquity(portfolio, this.symbol, candle.close).total, portfolio };
    this.leaveOutWarmupTrading(candle.close);
  }

  /**
   * Marks the pair equity to market at the close of every timeframe candle after the warmup. Otherwise only the portfolio changes and
   * the SELLs value it, and a position kept the price of the last one, up to the end of the run when it was still open: the Trader
   * sends a portfolio change with each of its synchronizations, or only when an amount changes with its portfolioUpdates filter.
   */
  public onTimeframeCandle(_timeframeBuckets: CandleBucket[]): void {
    this.markToMarket();
  }

  public onOrderCompleted(events: OrderCompletedEvent[]): void {
    for (const { order, exchange } of events) {
      const { id, side, price, amount, fee, orderExecutionDate } = order;
      this.registerTrade({ id, side, date: orderExecutionDate, price, amount, fee }, exchange.portfolio);
      // The portfolio after the fill is the latest, whether the fill counts in a round trip or not (see latestPortfolio): taken once
      // the fill is counted, which that portfolio shows (see valueEntryEquity)
      this.refreshLatestPortfolio(exchange.portfolio);
    }
  }

  /**
   * A BUY or a SELL canceled after a partial fill counts for the part it filled, as an order completed with that amount would: without
   * it, the position it bought would be in no round trip, and the SELL of that position would come while flat. The fill is dated at
   * the cancelation and priced at the price of the order, a limit it reached or beat, or at the last close for an order without one
   * (MARKET, or STICKY without a price); its fee is unknown, and counts as 0 (see Fill). A cancelation with no fill counts for nothing,
   * but its portfolio is the latest all the same (see latestPortfolio).
   */
  public onOrderCanceled(events: OrderCanceledEvent[]): void {
    for (const { order, exchange } of events) {
      const { id, side, price, filled, orderCancelationDate } = order;
      // No fill reported (undefined) counts for nothing, as 0 does
      if (!isNil(filled) && filled > 0) {
        const fillPrice = price ?? this.lastPriceUpdate;
        debug(
          'roundtrip analyzer',
          `${side} order ${id} canceled after a partial fill: its ${filled} filled count at ${fillPrice}, fee unknown.`,
        );
        this.registerTrade({ id, side, date: orderCancelationDate, price: fillPrice, amount: filled, fee: NaN }, exchange.portfolio);
      }
      this.refreshLatestPortfolio(exchange.portfolio);
    }
  }

  /**
   * An order that ended in error only refreshes the latest portfolio (see latestPortfolio). It may have filled in part before, as its
   * event says (`order.filled`, what the exchange reported, more having maybe executed when the order may still be live), but that
   * part counts in no round trip: what the account still holds catches the part a SELL sold (see registerSell), not the part a BUY
   * bought.
   */
  public onOrderErrored(events: OrderErroredEvent[]): void {
    for (const { exchange } of events) this.refreshLatestPortfolio(exchange.portfolio);
  }
  // --- END LISTENERS ---

  // --- BEGIN INTERNALS ---

  /**
   * Takes the portfolio an order event carries as the latest (see latestPortfolio), unless the Trader had fetched none yet, and values
   * with it the entry equity of a round trip opened before any (see valueEntryEquity)
   */
  private refreshLatestPortfolio(portfolio: Portfolio): void {
    if (!isFetchedPortfolio(portfolio)) return;
    this.latestPortfolio = portfolio;
    this.valueEntryEquity(portfolio);
  }

  /**
   * Values the entry equity of the open round trip whose BUY filled before the Trader had read any portfolio (see PendingEntry), with the
   * first portfolio an order ends with since, once the fill of that order is counted: the pair equity it shows at the price of that BUY,
   * less what the fills of the round trip changed it by. That portfolio was read after every fill heard so far: the report of an order
   * waits for the reads started before its order ended. Not a portfolio change: the Trader sends the change of the read a report waits
   * for before the end of its order, which the change shows already and the round trip has not counted yet.
   */
  private valueEntryEquity(portfolio: Portfolio): void {
    const roundTrip = this.openRoundTrip;
    if (!roundTrip?.pendingEntry) return;
    const { orderId, price, change } = roundTrip.pendingEntry;
    roundTrip.entryEquity = addPrecise(calculatePairEquity(portfolio, this.symbol, price).total, -change);
    roundTrip.pendingEntry = undefined;
    info(
      'roundtrip analyzer',
      `BUY order ${orderId} filled before the Trader read any portfolio: its round trip enters with ${formatAmount(roundTrip.entryEquity)} ${this.currency}, from the first portfolio read after it.`,
    );
  }

  /**
   * The report describes the period alone (see dates): a trade counted before it starts is left out of it. None is any more:
   * createOrder refuses an order until the warmup is over, init's too, and the warmup event reaches the analyzers before the end of any
   * order created after it. Should one be counted all the same, the round trips closed by then are dropped, with their exposure and
   * the trades counted so far, and a round trip still open is rebased at the start of the period: entered then, at the start price, with
   * the start equity, so that its P&L, its exposure and its adverse excursion (tracked after the warmup only) measure the period. Its
   * amounts are kept, and with them the mean price of the SELLs it made: the rule that ends it needs them (see registerSell). Both are
   * logged.
   */
  private leaveOutWarmupTrading(startPrice: number): void {
    if (this.tradeCount > 0) {
      const trades = `${this.tradeCount} ${pluralize('trade', this.tradeCount)}`;
      const roundTrips = `${this.roundTrips.length} ${pluralize('round trip', this.roundTrips.length)}`;
      const warmupTrading = `the ${trades} of the warmup, and the ${roundTrips} they closed`;
      info(
        'roundtrip analyzer',
        `The report measures the period from ${toISOString(this.dates.start)} on: ${warmupTrading}, are left out.`,
      );
    }
    this.roundTrips = [];
    this.tradeCount = 0;

    const roundTrip = this.openRoundTrip;
    if (!roundTrip) return;
    const { entryPrice, entryAt } = roundTrip;
    info(
      'roundtrip analyzer',
      [
        `Position opened during the warmup at ${formatAmount(entryPrice)} ${this.currency}, on ${toISOString(entryAt)}:`,
        `its round trip counts from the start of the period, at the start price of ${formatAmount(startPrice)} ${this.currency}`,
        `and with the start equity of ${formatAmount(this.start.equity)} ${this.currency}.`,
      ].join(' '),
    );
    roundTrip.entryAt = this.dates.start;
    roundTrip.entryPrice = startPrice;
    // 0 without a start taken yet, which leaves its P&L unknown (see measureRoundTrip): it no longer waits for a portfolio either
    roundTrip.entryEquity = this.start.equity;
    roundTrip.pendingEntry = undefined;
  }

  /**
   * The pair equity of the latest portfolio at the last close, once the warmup has completed. The timeframe candle event comes with
   * the bucket that closed the candle, whose close processOneMinuteBucket has recorded as the last price: that of the candle.
   */
  private markToMarket(): void {
    if (!this.warmupCompleted || !this.latestPortfolio) return;
    this.currentEquity = calculatePairEquity(this.latestPortfolio, this.symbol, this.lastPriceUpdate).total;
  }

  /** Counts a fill as a trade, and in the round trips (see registerRoundtripPart), with the portfolio after it */
  private registerTrade(orderFill: OrderFill, portfolio: Portfolio): void {
    // A SELL while flat before the first trade sells a position held before, which no round trip bought: skip it, not the batch. Not a
    // SELL of the round trip the warmup left open: it is a trade of the period, which can reduce or end it (see leaveOutWarmupTrading).
    if (orderFill.side === 'SELL' && this.tradeCount === 0 && !this.openRoundTrip) return;
    this.tradeCount++;
    this.registerRoundtripPart(orderFill, portfolio);
  }

  /**
   * A round trip goes from flat to a position and back to flat: see registerBuy and registerSell. A fill is valued with the portfolio
   * its event carries, which the Trader read after it. The limit: two fills whose reports share one synchronization of the Trader carry
   * the same portfolio, read after both, so the entry or the exit equity the first one gives already includes the second.
   */
  private registerRoundtripPart({ id, side, date, price, amount, fee }: OrderFill, portfolio: Portfolio): void {
    // The Trader sets the price and the amount of every fill it reports, estimating those of an order whose trades it cannot read: what
    // is skipped here is a fill priced at the last close before any bucket (0), or a price the event type leaves optional
    if (isNil(price) || !(price > 0) || !(amount > 0)) {
      warning('roundtrip analyzer', `Order ${id} filled without a valid price or amount. Skipping roundtrip update.`);
      return;
    }

    // The empty portfolio of a Trader that had read none yet holds none of the account's balances (see isFetchedPortfolio): valued, it
    // made the equity after the fill 0, and the account held nothing after a SELL
    const isFetched = isFetchedPortfolio(portfolio);
    const fill: Fill = {
      id,
      date,
      price,
      amount,
      // An unknown fee counts as 0, as the Trader reports it when the exchange gives no fee rate: exact for a fee paid in BNB, which
      // the pair equity leaves out, too low for one the pair paid. A fee that is not a number would make the round trip NaN.
      fee: Number.isFinite(fee) ? fee : 0,
      equity: isFetched ? calculatePairEquity(portfolio, this.symbol, price).total : NaN,
    };
    // A round trip that waits for a portfolio to value its entry counts the fill first: the portfolio after it shows it (see PendingEntry)
    const pendingEntry = this.openRoundTrip?.pendingEntry;
    if (pendingEntry) pendingEntry.change = addPrecise(pendingEntry.change, getEquityChange(side, fill, pendingEntry.price));
    if (isFetched) this.valueEntryEquity(portfolio);
    if (side === 'BUY') return this.registerBuy(fill);

    if (isFetched) this.currentEquity = fill.equity;
    // A SELL after a round trip has ended, or after a BUY skipped for its price, sells nothing a round trip bought
    if (!this.openRoundTrip) return debug('roundtrip analyzer', `SELL order ${id} filled while no round trip is open: skipped.`);
    this.registerSell(this.openRoundTrip, fill, isFetched ? getAssetBalance(portfolio, this.asset).total : Infinity);
  }

  /** A BUY opens a round trip while flat, and adds to the position of the open one otherwise (scale-in) */
  private registerBuy({ id, date, price, amount, fee, equity }: Fill): void {
    const roundTrip = this.openRoundTrip;
    if (!roundTrip) {
      const opened: OpenRoundTrip = {
        entryAt: date,
        entryPrice: price,
        // The pair equity before the BUY, its fee given back (see OpenRoundTrip). Unknown without the portfolio after it: the first
        // portfolio an order ends with gives it then, the fee of this BUY being the first change it undoes (see PendingEntry).
        entryEquity: isFiniteNumber(equity) ? addPrecise(equity, fee) : NaN,
        ...(!isFiniteNumber(equity) && { pendingEntry: { orderId: id, price, change: -fee } }),
        bought: amount,
        sold: 0,
        exitPrice: 0,
        maxAdverseExcursion: 0,
        excursionDeepenings: [],
      };
      // Heard in realtime after the buckets of minutes it already held: their candles count too (see countCandle)
      this.openRoundTrip = this.recentCandles.reduce(countCandle, opened);
      return;
    }
    // The round trip goes on: it keeps its entry date, its entry equity and its adverse excursion so far
    roundTrip.entryPrice = addToMeanPrice(roundTrip.entryPrice, roundTrip.bought, price, amount);
    roundTrip.bought += amount;
  }

  /**
   * A SELL reduces the position of the round trip, and ends the round trip once flat again (see DUST_TOLERANCE). What is left of the
   * position is what its BUYs bought and its SELLs have not sold back, but no more than the account still holds (`held`, unknown and
   * Infinity without a portfolio read). The amounts traded leave out what the account held before the round trip; the balance catches
   * a fill that went unseen (that of an order which ended in error, or a SELL made outside Gekko).
   */
  private registerSell(roundTrip: OpenRoundTrip, fill: Fill, held: number): void {
    roundTrip.exitPrice = addToMeanPrice(roundTrip.exitPrice, roundTrip.sold, fill.price, fill.amount);
    roundTrip.sold += fill.amount;
    const remaining = Math.min(roundTrip.bought - roundTrip.sold, held);
    if (remaining > DUST_TOLERANCE * roundTrip.bought) return;

    this.openRoundTrip = null;
    this.handleCompletedRoundtrip(roundTrip, fill);
  }

  /**
   * Records the round trip the SELL `fill` ended, and emits it. Its P&L is unknown when no portfolio read valued its entry or its exit
   * (see measureRoundTrip): it counts in the exposure and in the MAEs, which need none, not in the win rate nor in the ratios, which
   * would read it as a loss or divide by it.
   */
  private handleCompletedRoundtrip(roundTrip: OpenRoundTrip, { id: sellId, date: exitAt, equity: exitEquity }: Fill): void {
    const { entryAt, entryPrice, entryEquity, exitPrice, pendingEntry } = roundTrip;
    const roundtrip: RoundTrip = {
      id: this.nextRoundTripId++,

      entryAt,
      entryPrice,
      entryEquity,

      exitAt,
      exitPrice,
      exitEquity,

      ...measureRoundTrip(entryEquity, exitEquity),
      maxAdverseExcursion: measureAdverseExcursion(roundTrip, exitAt),

      duration: exitAt - entryAt,
    };

    if (!isFiniteNumber(roundtrip.pnl)) {
      const missing = pendingEntry
        ? `the Trader read no portfolio from BUY order ${pendingEntry.orderId}, which opened it, to SELL order ${sellId}, which closed it`
        : `no portfolio valued its entry or its exit (SELL order ${sellId})`;
      warning('roundtrip analyzer', `Round trip ${roundtrip.id} left out of the win rate and the ratios, its P&L unknown: ${missing}.`);
    }
    this.roundTrips.push(roundtrip);

    logRoundtrip(roundtrip, this.currency, this.enableConsoleTable);

    this.addDeferredEmit<RoundTrip>(ROUNDTRIP_COMPLETED_EVENT, roundtrip);
  }

  /**
   * The time spent in round trips during the period: in those closed, and in the one still open, until the end. Round trips never
   * overlap, so their times add up. Each one counts within the period alone: the warmup is left out already (see
   * leaveOutWarmupTrading), but in realtime a fill heard after the warmup can be dated before the start, and one heard last can be dated
   * after the close of the last bucket, the end.
   */
  private calculateExposureMs(): number {
    const { start, end } = this.dates;
    const timeInPeriod = (from: EpochTimeStamp, to: EpochTimeStamp) => Math.max(Math.min(to, end) - Math.max(from, start), 0);
    const closedMs = sumBy(this.roundTrips, ({ entryAt, exitAt }) => timeInPeriod(entryAt, exitAt));
    return this.openRoundTrip ? closedMs + timeInPeriod(this.openRoundTrip.entryAt, end) : closedMs;
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
    // The returns are relative to the start equity: a pair worth nothing when the period started has none
    if (!(this.start.equity > 0)) {
      warning('roundtrip analyzer', `Start equity of ${this.start.equity} ${this.currency}: no return to measure. Emitting empty report.`);
      return EMPTY_TRADING_REPORT;
    }

    // The round trips whose P&L is known: one valued without a portfolio is in the exposure and the MAEs alone (see
    // handleCompletedRoundtrip)
    const measured = this.roundTrips.filter(({ pnl }) => isFiniteNumber(pnl));
    const statistics = calculatePerformanceStatistics(
      {
        periodStartAt: this.dates.start,
        periodEndAt: this.dates.end,
        startEquity: this.start.equity,
        endEquity: this.currentEquity,
        // The profits of the round trips closed, in % of their entry equity: the one still open at the end is in none
        returns: measured.map(r => r.profit),
        marketReturnPct: calculateMarketReturnPct(this.endPrice, this.startPrice),
        exposureMs: this.calculateExposureMs(),
        riskFreeReturn: this.riskFreeReturn,
      },
      'roundtrip analyzer',
    );

    return {
      id: 'TRADING REPORT',
      ...statistics,
      startPrice: this.startPrice,
      endPrice: this.endPrice,
      startBalance: this.start.equity,
      finalBalance: this.currentEquity,
      // Rounded once, by the printers: rounded to 4 decimals here first, 40 wins of 103 (38.83495 %) were written 38.84 %
      winRate: calculateWinRate(measured.filter(({ pnl }) => pnl > 0).length, measured.length),
      topMAEs: extractTopMAEs(this.roundTrips.map(rt => rt.maxAdverseExcursion)),
      tradeCount: this.tradeCount,
    };
  }

  /**
   * A position still open at the end is in the final balance, at the last close, and in the exposure, but in no round trip: the win
   * rate, the ratios and the MAEs leave it out. Its P&L is measured as that of a round trip (see measureRoundTrip): the pair equity at
   * the last close less its entry equity, with the fees paid so far, without that of the SELL that would close it.
   */
  private logOpenRoundTrip({ entryAt, entryPrice, entryEquity }: OpenRoundTrip): void {
    const { pnl, profit } = measureRoundTrip(entryEquity, this.currentEquity);
    const unrealized = isFiniteNumber(pnl)
      ? `unrealized P&L of ${formatAmount(pnl)} ${this.currency} (${formatSignedPercent(profit)})`
      : 'unrealized P&L unknown, no portfolio having valued its entry';
    info(
      'roundtrip analyzer',
      [
        `Position still open at the end of the period, entered at ${formatAmount(entryPrice)} ${this.currency} on ${toISOString(entryAt)}:`,
        `${unrealized} at the last close,`,
        `${formatAmount(this.endPrice)} ${this.currency}. The final balance and the exposure include it; the win rate, the ratios`,
        'and the MAEs leave it out.',
      ].join(' '),
    );
  }
  // --- END INTERNALS ---

  // --------------------------------------------------------------------------
  //                           PLUGIN LIFECYCLE HOOKS
  // --------------------------------------------------------------------------

  protected processInit(): void {
    /* noop */
  }

  protected processOneMinuteBucket(bucket: CandleBucket): void {
    const candle = bucket.get(this.symbol);
    if (!candle) {
      warning('roundtrip analyzer', `Missing candle for ${this.symbol} in bucket.`);
      return;
    }
    this.lastPriceUpdate = candle.close;
    // In epoch milliseconds: date-fns' addMinutes built two Dates on every bucket for this sum
    this.currentTimestamp = candle.start + ONE_MINUTE;
    if (this.warmupCompleted) {
      this.dates.end = this.currentTimestamp;
      this.endPrice = candle.close;
      // Kept for a BUY that filled before this candle closed and is heard after it (see countCandle)
      this.recentCandles.push(candle);
      if (this.openRoundTrip) countCandle(this.openRoundTrip, candle);
    }
  }

  protected async processFinalize(failure?: Error): Promise<void> {
    // The end is marked to market too: the last bucket may have closed no timeframe candle, and orders may have filled since the last
    // close that did
    this.markToMarket();
    // A run stopped before its end (a crash, missing candles, the circuit breaker) gives the report of a partial period, and says why
    const report: TradingReport = { ...this.calculateReportStatistics(), ...(failure && { interruption: failure.message }) };
    if (this.enableConsoleTable) logFinalize(report, this.currency);
    else info('roundtrip analyzer', report);
    if (this.openRoundTrip) this.logOpenRoundTrip(this.openRoundTrip);

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
