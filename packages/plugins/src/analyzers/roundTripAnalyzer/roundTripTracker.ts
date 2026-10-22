import { RingBuffer } from '@gekko/shared/helpers/collection/ringBuffer';
import { calculateExposurePct, calculateWinRate } from '@gekko/shared/helpers/finance/stats.helper';
import { getAssetBalance, isFetchedPortfolio } from '@gekko/shared/helpers/portfolio/portfolio.helper';
import { Candle } from '@gekko/shared/models/candle.types';
import { OrderCanceledEvent, OrderCompletedEvent, RoundTrip } from '@gekko/shared/models/event.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { Asset, TradingPair } from '@gekko/shared/models/utility.types';
import { debug, info, warning } from '@gekko/core/logger/logger';
import { toISOString } from '@gekko/shared/utils/date/date.utils';
import { addPrecise, isFiniteNumber, multiplyPrecise } from '@gekko/shared/utils/math/math.utils';
import { formatAmount, formatEveryDecimal, formatSignedPercent } from '@gekko/shared/utils/string/string.utils';
import { isNil } from 'lodash-es';
import { UUID } from 'node:crypto';
import { DUST_TOLERANCE } from '../analyzer.const';
import { DateRange, ExcursionCandle, Fill, OpenRoundTrip, OrderFill, PairTradingSummary, RoundTripTrackerSetup } from './roundTrip.types';
import { LATE_FILL_CANDLES } from './roundTripAnalyzer.const';
import {
  addToMeanPrice,
  countCandle,
  measureAdverseExcursion,
  measureCoveredMs,
  measureRoundTrip,
  priceCanceledFill,
} from './roundTripAnalyzer.helper';

/**
 * The round trips of one watched pair: the one in progress, from the BUY that opens a position while flat to the SELL that leaves it
 * flat again, and those closed during the period, each with its P&L from its own fills (see measureRoundTrip). The RoundTripAnalyzer
 * keeps one per pair, as the PositionBook keeps a PositionTracker per pair, and holds what the pairs share: the portfolio, the last
 * close of every pair, the period, the benchmark, the report and the numbering of the round trips.
 *
 * The analyzer hands it the one-minute candles of its pair (readCandle), the fills of the orders of its pair (registerCompleted,
 * registerCanceled) and the start of the period (startPeriod); it returns each round trip it closes, which the analyzer logs and emits.
 * The report reads its round trips (closedRoundTrips, tradeCount, exposureIntervals, summarize), and the end of the run its position
 * still open (logOpenPosition). It values no portfolio itself: the entry equity of a round trip is the whole portfolio's value, which
 * the analyzer works out from the prices of every pair (see RoundTripTrackerSetup), and the ids of the round trips follow one another
 * across the pairs.
 */
export class RoundTripTracker {
  readonly symbol: TradingPair;
  readonly asset: Asset;
  private readonly currency: Asset;
  private readonly valuePortfolio: RoundTripTrackerSetup['valuePortfolio'];
  private readonly nextRoundTripId: RoundTripTrackerSetup['nextRoundTripId'];
  /**
   * The close of the last one-minute candle of its pair, 0 before any: the price of the part a canceled order filled, when nothing else
   * prices it (see priceCanceledFill), the price its position still open at the end is valued at (see logOpenPosition), and its start
   * price when the warmup completes (see startPeriod)
   */
  private lastClose = 0;
  /** The round trip in progress, null while flat */
  private openRoundTrip: OpenRoundTrip | null = null;
  /**
   * The one-minute candles of the last LATE_FILL_CANDLES minutes of the period, oldest first: those that closed after the BUY that
   * opens a round trip, read before that BUY was heard, count in its adverse excursion once it is (see countCandle)
   */
  private readonly recentCandles = new RingBuffer<ExcursionCandle>(LATE_FILL_CANDLES);
  /** The fills counted as trades: during the warmup, then from the start of the period (see startPeriod) */
  private trades = 0;
  /** The round trips closed during the period, in the order they closed */
  private roundTrips: RoundTrip[] = [];

  constructor({ symbol, asset, currency, valuePortfolio, nextRoundTripId }: RoundTripTrackerSetup) {
    this.symbol = symbol;
    this.asset = asset;
    this.currency = currency;
    this.valuePortfolio = valuePortfolio;
    this.nextRoundTripId = nextRoundTripId;
  }

  /** The round trips closed during the period, in the order they closed */
  get closedRoundTrips(): readonly RoundTrip[] {
    return this.roundTrips;
  }

  /** The trades counted: during the warmup until the period starts, then those of the period (see startPeriod) */
  get tradeCount(): number {
    return this.trades;
  }

  /**
   * Reads a one-minute candle of its pair: its close is the last price (see lastClose). Once the period has started (`inPeriod`), the
   * candle counts in the adverse excursion of the round trip in progress, and is kept for a BUY that filled before it closed and is
   * heard after it (see countCandle).
   */
  readCandle(candle: Candle, inPeriod: boolean): void {
    this.lastClose = candle.close;
    if (!inPeriod) return;
    this.recentCandles.push(candle);
    if (this.openRoundTrip) countCandle(this.openRoundTrip, candle);
  }

  /**
   * Starts the period, at `start.at`: the close of the timeframe candle that completed the warmup, whose bucket gave the last close read
   * (see readCandle), the start price. The report describes the period alone: a trade counted before it starts is left out of it. None
   * is any more: createOrder refuses an order until the warmup is over, init's too, and the warmup event reaches the analyzers before the
   * end of any order created after it. Should one be counted all the same, the round trips closed by then are dropped, with their
   * exposure and the trades counted so far (the analyzer says how many, every pair together), and a round trip still open is rebased at
   * the start of the period: entered then, at the start price, with the start equity (`start.equity`, 0 when none was taken, which
   * leaves its profit unknown), for the cost of the position it holds then at that price, without proceeds or fees, so that its P&L, its
   * exposure and its adverse excursion (tracked in the period only) measure the period. Its amounts are kept, and with them the mean
   * price of the SELLs it made: the rule that ends it needs them (see registerSell). The rebasing is logged.
   */
  startPeriod(start: { at: EpochTimeStamp; equity: number }): void {
    this.roundTrips = [];
    this.trades = 0;

    const roundTrip = this.openRoundTrip;
    if (!roundTrip) return;
    const startPrice = this.lastClose;
    const { entryPrice, entryAt } = roundTrip;
    info(
      'roundtrip analyzer',
      [
        `Position on ${this.symbol} opened during the warmup at ${formatAmount(entryPrice)} ${this.currency} on ${toISOString(entryAt)}:`,
        `its round trip counts from the start of the period, at the start price of ${formatAmount(startPrice)} ${this.currency}`,
        `and with the start equity of ${formatAmount(start.equity)} ${this.currency}.`,
      ].join(' '),
    );
    roundTrip.entryAt = start.at;
    roundTrip.entryPrice = startPrice;
    roundTrip.entryEquity = start.equity;
    roundTrip.cost = multiplyPrecise(addPrecise(roundTrip.bought, -roundTrip.sold), startPrice);
    roundTrip.proceeds = 0;
    roundTrip.fees = 0;
  }

  /**
   * Counts the fill of an order of its pair that completed, with the portfolio the Trader read after it (see registerTrade); returns the
   * round trip it closed, if any
   */
  registerCompleted({ id, side, price, amount, fee, feeAsset, orderExecutionDate }: OrderCompletedEvent['order'], portfolio: Portfolio) {
    return this.registerTrade({ id, side, date: orderExecutionDate, price, amount, fee, feeAsset }, portfolio);
  }

  /**
   * Counts the part an order of its pair canceled after a partial fill filled, `filled` (above 0), as an order completed with that amount
   * would: without it, the position it bought would be in no round trip, and the SELL of that position would come while flat. The fill
   * is dated at the cancelation and priced at the mean price of its fills, as the exchange reported them, else at the price of a LIMIT
   * order, else at the last close (see priceCanceledFill); its fee is unknown, and counts as 0 (see registerRoundtripPart). Returns the
   * round trip it closed, if any.
   */
  registerCanceled(order: OrderCanceledEvent['order'], filled: number, portfolio: Portfolio) {
    const { id, side, orderCancelationDate } = order;
    const { price, source } = priceCanceledFill(order, this.lastClose);
    const counted = `its ${formatEveryDecimal(filled)} filled count at ${formatEveryDecimal(price)} (${source})`;
    debug('roundtrip analyzer', `${side} order ${id} canceled after a partial fill: ${counted}, fee unknown.`);
    return this.registerTrade({ id, side, date: orderCancelationDate, price, amount: filled, fee: NaN }, portfolio);
  }

  /**
   * The spans of its round trips: from the entry to the exit of each one closed, and from the entry of the one still open to `end`, the
   * end of the period (see measureCoveredMs)
   */
  exposureIntervals(end: EpochTimeStamp): DateRange[] {
    const intervals = this.roundTrips.map(({ entryAt, exitAt }) => ({ start: entryAt, end: exitAt }));
    if (this.openRoundTrip) intervals.push({ start: this.openRoundTrip.entryAt, end });
    return intervals;
  }

  /** Its round trips over `period`, as the breakdown of the report gives them (see TradingReport.pairs) */
  summarize(period: DateRange): PairTradingSummary {
    const { roundTrips } = this;
    const winCount = roundTrips.filter(({ pnl }) => pnl > 0).length;
    const periodMs = period.end - period.start;
    return {
      symbol: this.symbol,
      roundTripCount: roundTrips.length,
      winCount,
      winRate: calculateWinRate(winCount, roundTrips.length),
      tradeCount: this.trades,
      pnl: roundTrips.reduce((total, { pnl }) => addPrecise(total, pnl), 0),
      // A run that ends with the bucket that completed the warmup has a period of 0 ms, and nothing exposed in it
      exposurePct: periodMs > 0 ? calculateExposurePct(measureCoveredMs(this.exposureIntervals(period.end), period), periodMs) : 0,
      maxAdverseExcursion: roundTrips.reduce((deepest, { maxAdverseExcursion }) => Math.max(deepest, maxAdverseExcursion), 0),
    };
  }

  /**
   * Logs its position still open at the end of the period, if any. It is in the final balance, at the last close, and in the exposure,
   * but in no round trip: the win rate, the ratios and the MAEs leave it out. Its P&L is measured as that of a round trip (see
   * measureRoundTrip), what it still holds valued at the last close as the SELL that would close it would sell it, without the fee of
   * that SELL; its profit, unknown without an entry equity, is written so, the P&L kept.
   */
  logOpenPosition(): void {
    const roundTrip = this.openRoundTrip;
    if (!roundTrip) return;
    const { entryAt, entryPrice, entryEquity, bought, sold, proceeds } = roundTrip;
    const held = multiplyPrecise(addPrecise(bought, -sold), this.lastClose);
    const { pnl, profit } = measureRoundTrip({ ...roundTrip, proceeds: addPrecise(proceeds, held) }, entryEquity);
    const unrealized = isFiniteNumber(profit)
      ? `unrealized P&L of ${formatAmount(pnl)} ${this.currency} (${formatSignedPercent(profit)})`
      : `unrealized P&L of ${formatAmount(pnl)} ${this.currency} (profit unknown, no portfolio having valued its entry)`;
    info(
      'roundtrip analyzer',
      [
        `Position still open on ${this.symbol} at the end of the period, entered at ${formatAmount(entryPrice)} ${this.currency} on`,
        `${toISOString(entryAt)}: ${unrealized} at the last close, ${formatAmount(this.lastClose)} ${this.currency}. The final balance`,
        'and the exposure include it; the win rate, the ratios and the MAEs leave it out.',
      ].join(' '),
    );
  }

  /** Counts a fill as a trade, and in the round trips (see registerRoundtripPart), with the portfolio after it */
  private registerTrade(orderFill: OrderFill, portfolio: Portfolio): RoundTrip | undefined {
    // A SELL while flat before the first trade sells a position held before, which no round trip bought: skip it, not the batch. Not a
    // SELL of the round trip the warmup left open: it is a trade of the period, which can reduce or end it (see startPeriod).
    if (orderFill.side === 'SELL' && this.trades === 0 && !this.openRoundTrip) return;
    this.trades++;
    return this.registerRoundtripPart(orderFill, portfolio);
  }

  /**
   * A round trip goes from flat to a position and back to flat: see registerBuy and registerSell. The portfolio is the one the event of
   * the fill carries, which the Trader read after it: what the account holds once a SELL filled (see registerSell), and the base of the
   * profit of a round trip a BUY opens (see registerBuy).
   */
  private registerRoundtripPart({ id, side, date, price, amount, fee, feeAsset }: OrderFill, portfolio: Portfolio): RoundTrip | undefined {
    // The Trader sets the price and the amount of every fill it reports, estimating those of an order whose trades it cannot read: what
    // is skipped here is a fill priced at the last close before any bucket (0), or a price the event type leaves optional
    if (isNil(price) || !(price > 0) || !(amount > 0)) {
      warning('roundtrip analyzer', `Order ${id} filled without a valid price or amount. Skipping roundtrip update.`);
      return;
    }

    // An unknown fee counts as 0, as the Trader reports it when the exchange gives no fee rate, for a fee taken in a third asset (BNB)
    // too, which no rate converts: the P&L is then too high by the fee the order paid. A fee that is not a number would make the round
    // trip NaN.
    const fill: Fill = { id, date, price, amount, fee: Number.isFinite(fee) ? fee : 0, feeAsset };
    if (side === 'BUY') {
      this.registerBuy(fill, portfolio);
      return;
    }
    // A SELL after a round trip has ended, or after a BUY skipped for its price, sells nothing a round trip bought
    if (!this.openRoundTrip) {
      debug('roundtrip analyzer', `SELL order ${id} filled while no round trip is open: skipped.`);
      return;
    }
    // The empty portfolio of a Trader that had read none yet holds none of the account's balances (see isFetchedPortfolio): taken for
    // what the account holds, it ended the round trip at any SELL
    const held = isFetchedPortfolio(portfolio) ? getAssetBalance(portfolio, this.asset).total : Infinity;
    return this.registerSell(this.openRoundTrip, fill, held);
  }

  /**
   * A BUY opens a round trip while flat, and adds to the position of the open one otherwise (scale-in): its amount, its cost and its fee,
   * but a fee taken in the asset of the pair, which the SELLs carry (see countBuyFee). The round trip it opens enters with the whole
   * portfolio's value before it: the portfolio the Trader read after it, its pair valued at its price, plus its fee, whatever the asset
   * it was taken in, which the BUY took from the portfolio (see RoundTrip.entryEquity). Unknown (NaN) when the Trader had read no
   * portfolio yet: valued, its empty one made the entry equity the fee alone, 0.1 for a BUY of 1 BTC at 100, and its round trip, sold at
   * 110, +9,790 %.
   */
  private registerBuy({ id, date, price, amount, fee, feeAsset }: Fill, portfolio: Portfolio): void {
    const cost = multiplyPrecise(amount, price);
    const countedFee = this.countBuyFee(id, fee, feeAsset);
    const roundTrip = this.openRoundTrip;
    if (!roundTrip) {
      const opened: OpenRoundTrip = {
        entryOrderId: id,
        entryAt: date,
        entryPrice: price,
        entryEquity: isFetchedPortfolio(portfolio) ? addPrecise(this.valuePortfolio(portfolio, price), fee) : NaN,
        bought: amount,
        sold: 0,
        cost,
        proceeds: 0,
        fees: countedFee,
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
    roundTrip.bought = addPrecise(roundTrip.bought, amount);
    roundTrip.cost = addPrecise(roundTrip.cost, cost);
    roundTrip.fees = addPrecise(roundTrip.fees, countedFee);
  }

  /**
   * What of the fee of a BUY counts in the fees of its round trip: the fee, in currency as the Trader reports it, unless the exchange took
   * it in the asset of the pair, out of the amount bought, as Binance does unless the fees are paid in BNB. The SELLs then sell that much
   * less, and the smaller proceeds carry it already: added here too, it counted twice, and the P&L was understated by it (see
   * RoundTrip.fees). The entry equity counts it all the same, whatever the asset: the BUY took it from the portfolio.
   */
  private countBuyFee(id: UUID, fee: number, feeAsset: Asset | undefined): number {
    if (feeAsset !== this.asset) return fee;
    const taken = `its fee of ${formatEveryDecimal(fee)} ${this.currency} was taken in ${this.asset}, out of the amount bought`;
    debug('roundtrip analyzer', `BUY order ${id}: ${taken}: left out of the fees, its SELLs selling that much less.`);
    return 0;
  }

  /**
   * A SELL reduces the position of the round trip, and ends the round trip once flat again (see DUST_TOLERANCE). What is left of the
   * position is what its BUYs bought and its SELLs have not sold back, but no more than the account still holds (`held`, unknown and
   * Infinity without a portfolio read). The amounts traded leave out what the account held before the round trip; the balance catches
   * a fill that went unseen (that of an order which ended in error, or a SELL made outside Gekko).
   */
  private registerSell(roundTrip: OpenRoundTrip, { date, price, amount, fee }: Fill, held: number): RoundTrip | undefined {
    roundTrip.exitPrice = addToMeanPrice(roundTrip.exitPrice, roundTrip.sold, price, amount);
    roundTrip.sold = addPrecise(roundTrip.sold, amount);
    roundTrip.proceeds = addPrecise(roundTrip.proceeds, multiplyPrecise(amount, price));
    roundTrip.fees = addPrecise(roundTrip.fees, fee);
    const remaining = Math.min(addPrecise(roundTrip.bought, -roundTrip.sold), held);
    if (remaining > DUST_TOLERANCE * roundTrip.bought) return;

    this.openRoundTrip = null;
    return this.closeRoundTrip(roundTrip, date);
  }

  /**
   * Records the round trip that the SELL which filled at `exitAt` ended, and returns it. Its profit is unknown when no portfolio read
   * valued its entry (see measureRoundTrip): it counts in the win rate, its P&L being known from its fills, and in the exposure and the
   * MAEs, not in the returns, which the ratios are worked out from; a warning names the BUY that opened it.
   */
  private closeRoundTrip(roundTrip: OpenRoundTrip, exitAt: EpochTimeStamp): RoundTrip {
    const { entryOrderId, entryAt, entryPrice, entryEquity, exitPrice, cost, proceeds, fees } = roundTrip;
    const { pnl, profit } = measureRoundTrip(roundTrip, entryEquity);
    const closed: RoundTrip = {
      id: this.nextRoundTripId(),
      symbol: this.symbol,
      entryAt,
      entryPrice,
      entryEquity,
      exitAt,
      exitPrice,
      cost,
      proceeds,
      fees,
      duration: exitAt - entryAt,
      maxAdverseExcursion: measureAdverseExcursion(roundTrip, exitAt),
      profit,
      pnl,
    };
    if (!isFiniteNumber(profit)) {
      const reason = `the Trader had read no portfolio when BUY order ${entryOrderId} opened it`;
      warning('roundtrip analyzer', `Round trip ${closed.id} on ${this.symbol} left out of the returns, its profit unknown: ${reason}.`);
    }
    this.roundTrips.push(closed);
    return closed;
  }
}
