import { RingBuffer } from '@gekko/shared/helpers/collection/ringBuffer';
import { calculateWinRate, extractTopMAEs } from '@gekko/shared/helpers/finance/stats.helper';
import { getAssetBalance, isFetchedPortfolio } from '@gekko/shared/helpers/portfolio/portfolio.helper';
import { Candle } from '@gekko/shared/models/candle.types';
import {
  OrderCanceledEvent,
  OrderCompletedEvent,
  OrderErroredEvent,
  OrderInitiatedEvent,
  RoundTrip,
} from '@gekko/shared/models/event.types';
import { Asset, TradingPair } from '@gekko/shared/models/utility.types';
import { debug, info, warning } from '@gekko/core/logger/logger';
import { toISOString } from '@gekko/shared/utils/date/date.utils';
import { addPrecise, isFiniteNumber, isFinitePositive, multiplyPrecise, toSignificantDigits } from '@gekko/shared/utils/math/math.utils';
import { formatAmount, formatEveryDecimal, formatPercent } from '@gekko/shared/utils/string/string.utils';
import { isNil } from 'lodash-es';
import { UUID } from 'node:crypto';
import { DUST_TOLERANCE, PERCENT_ROUNDING } from '../analyzer.const';
import { calculatePeriodExposurePct } from '../analyzer.helper';
import {
  BalanceRead,
  DateRange,
  ExcursionCandle,
  Fill,
  OpenRoundTrip,
  OrderFill,
  PairTradingSummary,
  RoundTripTrackerSetup,
} from './roundTrip.types';
import { LATE_FILL_CANDLES } from './roundTripAnalyzer.const';
import {
  addToMeanPrice,
  countCandle,
  measureAdverseExcursion,
  measureCoveredMs,
  measureRoundTrip,
  priceUncompletedFill,
} from './roundTripAnalyzer.helper';

/**
 * The round trips of one watched pair: the one in progress, from the BUY that opens a position while flat to the SELL that leaves it
 * flat again, and those closed during the period, each with its P&L from its own fills (see measureRoundTrip). The RoundTripAnalyzer
 * keeps one per pair, as the PositionBook keeps a PositionTracker per pair, and holds what the pairs share: the portfolio, the last
 * close of every pair, the period, the benchmark, the report and the numbering of the round trips.
 *
 * The analyzer hands it the one-minute candles of its pair (readCandle), the orders of its pair as they are initiated
 * (registerInitiated) and as they end (registerCompleted, registerCanceled, registerErrored), and the start of the period
 * (startPeriod); it returns each round trip it closes, which the analyzer logs and emits. The report reads its round trips
 * (closedRoundTrips, tradeCount, exposureIntervals, summarize), and the end of the run its position still open (logOpenPosition). It
 * values no portfolio itself: the entry equity of a round trip is the whole portfolio's value, which the analyzer works out from the
 * prices of every pair (see RoundTripTrackerSetup), and the ids of the round trips follow one another across the pairs.
 */
export class RoundTripTracker {
  readonly symbol: TradingPair;
  readonly asset: Asset;
  private readonly currency: Asset;
  private readonly valuePortfolio: RoundTripTrackerSetup['valuePortfolio'];
  private readonly nextRoundTripId: RoundTripTrackerSetup['nextRoundTripId'];
  /**
   * The close of the last one-minute candle of its pair, 0 before any: the price of the part an order that did not complete filled,
   * when nothing else prices it (see priceUncompletedFill), and of a fill no event reported (see reconcileWithBalance), the price its
   * position still open at the end is valued at (see logOpenPosition), and its start price when the warmup completes (see startPeriod)
   */
  private lastClose = 0;
  /** The round trip in progress, null while flat */
  private openRoundTrip: OpenRoundTrip | null = null;
  /**
   * The SELLs of its pair the Trader initiated and whose end has not been heard yet: while one is, the balance an event carries may
   * already show its fill, and tells nothing of what the round trip still holds (see heldAfter)
   */
  private readonly pendingSells = new Set<UUID>();
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
   * leaves its profit unknown), for the cost of the position it holds then at that price (see OpenRoundTrip.position), without proceeds
   * or fees, so that its P&L, its exposure and its adverse excursion (tracked in the period only) measure the period. Its amounts are
   * kept, and with them the mean price of the SELLs it made: the rules that count its SELLs and end it need them (see registerSell). The
   * rebasing is logged.
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
    roundTrip.cost = multiplyPrecise(roundTrip.position, startPrice);
    roundTrip.proceeds = 0;
    roundTrip.fees = 0;
  }

  /**
   * Hears that the Trader initiated an order of its pair: a SELL is pending until its end is heard (see pendingSells). Not a BUY: the
   * fill of a BUY adds to what the account holds, and hides no SELL from the balance.
   */
  registerInitiated({ id, side }: Pick<OrderInitiatedEvent['order'], 'id' | 'side'>): void {
    if (side === 'SELL') this.pendingSells.add(id);
  }

  /**
   * Counts the fill of an order of its pair that completed, with the balances the Trader read after it (see registerTrade); returns the
   * round trip it closed, if any
   */
  registerCompleted(order: OrderCompletedEvent['order'], read: BalanceRead): RoundTrip | undefined {
    const { id, side, price, amount, fee, feeAsset, orderExecutionDate } = order;
    this.pendingSells.delete(id);
    return this.registerTrade({ id, side, date: orderExecutionDate, price, amount, fee, feeAsset }, read);
  }

  /** Counts an order of its pair canceled, and what it filled before, if anything (see registerUncompleted) */
  registerCanceled(order: OrderCanceledEvent['order'], read: BalanceRead): RoundTrip | undefined {
    return this.registerUncompleted(order, order.filled, order.orderCancelationDate, 'canceled after a partial fill', read);
  }

  /**
   * Counts an order of its pair that ended in error, and what it filled before, if anything (see registerUncompleted): a STICKY order
   * whose relaunch failed, an order whose poll or cancelation failed for good, after fills the exchange reported. Left out, the coins a
   * SELL had sold were booked as lost when the balance ended its round trip, and those a BUY had bought were in no round trip, its SELL
   * coming while flat.
   */
  registerErrored(order: OrderErroredEvent['order'], read: BalanceRead): RoundTrip | undefined {
    return this.registerUncompleted(order, order.filled, order.orderErrorDate, 'ended in error after a fill', read);
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

  /**
   * Its round trips over `period`, as the breakdown of the report gives them (see TradingReport.pairs). The report adds up the wins, the
   * round trips and the trades of the pairs rather than counting them again, so that a win, a round trip whose P&L is above 0, is
   * decided here alone. The exposure of a period of 0 ms is 0, as the report's (see calculatePeriodExposurePct), and the deepest
   * adverse excursion is the first of those the report lists (see extractTopMAEs).
   */
  summarize(period: DateRange): PairTradingSummary {
    const { roundTrips } = this;
    const winCount = roundTrips.filter(({ pnl }) => pnl > 0).length;
    const coveredMs = measureCoveredMs(this.exposureIntervals(period.end), period);
    return {
      symbol: this.symbol,
      roundTripCount: roundTrips.length,
      winCount,
      winRate: calculateWinRate(winCount, roundTrips.length),
      tradeCount: this.trades,
      pnl: roundTrips.reduce((total, { pnl }) => addPrecise(total, pnl), 0),
      exposurePct: calculatePeriodExposurePct(coveredMs, period.end - period.start),
      maxAdverseExcursion: extractTopMAEs(roundTrips.map(({ maxAdverseExcursion }) => maxAdverseExcursion))[0] ?? 0,
    };
  }

  /**
   * Logs its position still open at the end of the period, if any. It is in the final balance, at the last close, and in the exposure,
   * but in no round trip: the win rate, the ratios and the MAEs leave it out. Its P&L is measured as that of a round trip (see
   * measureRoundTrip), what it still holds (its position, net of the BUY fees taken in the asset: see OpenRoundTrip.position) valued at
   * the last close as the SELL that would close it would sell it, without the fee of that SELL; its profit, unknown without an entry
   * equity, is written so, the P&L kept, and is rounded as the profit of a round trip is wherever it is written (see PERCENT_ROUNDING).
   */
  logOpenPosition(): void {
    const roundTrip = this.openRoundTrip;
    if (!roundTrip) return;
    const { entryAt, entryPrice, entryEquity, position, proceeds } = roundTrip;
    const held = multiplyPrecise(position, this.lastClose);
    const { pnl, profit } = measureRoundTrip({ ...roundTrip, proceeds: addPrecise(proceeds, held) }, entryEquity);
    const unrealized = isFiniteNumber(profit)
      ? `unrealized P&L of ${formatAmount(pnl)} ${this.currency} (${formatPercent(profit, PERCENT_ROUNDING.profit)})`
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

  /**
   * An order of its pair that did not complete, canceled or ended in error. The part it filled before, as far as the exchange reported
   * it (`filled`, above 0), counts as an order completed with that amount would: without it, the position a BUY bought would be in no
   * round trip, and the SELL of that position would come while flat. The fill is dated at the end of the order, and priced at the mean
   * price of its fills, as the exchange reported them, else at the price of a LIMIT order, else at the last close (see
   * priceUncompletedFill); its fee is unknown, and counts as 0 (see registerRoundtripPart). A SELL that reported no fill may have sold
   * all the same, its creation's outcome unknown or its fill unreported: the balance after it tells (see reconcileWithBalance). Returns
   * the round trip it closed, if any.
   */
  private registerUncompleted(
    order: Pick<OrderCanceledEvent['order'], 'id' | 'side' | 'type' | 'price' | 'fillPrice'>,
    filled: number | undefined,
    date: EpochTimeStamp,
    ending: string,
    read: BalanceRead,
  ): RoundTrip | undefined {
    const { id, side } = order;
    this.pendingSells.delete(id);
    if (isFinitePositive(filled)) {
      const { price, source } = priceUncompletedFill(order, this.lastClose);
      const counted = `its ${formatEveryDecimal(filled)} filled count at ${formatEveryDecimal(price)} (${source})`;
      debug('roundtrip analyzer', `${side} order ${id} ${ending}: ${counted}, fee unknown.`);
      return this.registerTrade({ id, side, date, price, amount: filled, fee: NaN }, read);
    }
    if (side === 'SELL' && this.openRoundTrip) {
      return this.reconcileWithBalance(this.openRoundTrip, this.heldAfter(read, date), { id, side, date });
    }
  }

  /** Counts a fill as a trade, and in the round trips (see registerRoundtripPart), with the balances read after it */
  private registerTrade(orderFill: OrderFill, read: BalanceRead): RoundTrip | undefined {
    // A SELL while flat before the first trade sells a position held before, which no round trip bought: skip it, not the batch. Not a
    // SELL of the round trip the warmup left open: it is a trade of the period, which can reduce or end it (see startPeriod).
    if (orderFill.side === 'SELL' && this.trades === 0 && !this.openRoundTrip) return;
    this.trades++;
    return this.registerRoundtripPart(orderFill, read);
  }

  /**
   * A round trip goes from flat to a position and back to flat: see registerBuy and registerSell. The balances are those the event of
   * the fill carries, which the Trader read after it: what the account holds once the fill is in (see heldAfter), and the base of the
   * profit of a round trip a BUY opens (see registerBuy).
   */
  private registerRoundtripPart(orderFill: OrderFill, read: BalanceRead): RoundTrip | undefined {
    const { id, side, date, price, amount, fee, feeAsset } = orderFill;
    // The Trader sets the price and the amount of every fill it reports, estimating those of an order whose trades it cannot read: what
    // is skipped here is a fill priced at the last close before any bucket (0), a price the event type leaves optional, or a figure that
    // is not a finite number, which would make the round trip Infinity or NaN
    if (!isFinitePositive(price) || !isFinitePositive(amount)) {
      warning('roundtrip analyzer', `Order ${id} filled without a valid price or amount. Skipping roundtrip update.`);
      return;
    }

    // An unknown fee counts as 0, as the Trader reports it when the exchange gives no fee rate, for a fee taken in a third asset (BNB)
    // too, which no rate converts: the P&L is then too high by the fee the order paid. A fee that is not a number would make the round
    // trip NaN.
    const fill: Fill = { id, date, price, amount, fee: isFiniteNumber(fee) ? fee : 0, feeAsset };
    const held = this.heldAfter(read, date);
    if (side === 'BUY') return this.registerBuy(fill, read, held);
    // A SELL after a round trip has ended, or after a BUY skipped for its price, sells nothing a round trip bought
    if (!this.openRoundTrip) {
      debug('roundtrip analyzer', `SELL order ${id} filled while no round trip is open: skipped.`);
      return;
    }
    return this.registerSell(this.openRoundTrip, fill, held);
  }

  /**
   * What the account holds of the asset of its pair after a fill dated `date`, as the event of the fill carries it, or Infinity when
   * that read cannot tell: the empty portfolio of a Trader that had read none yet (see isFetchedPortfolio), which ended the round trip
   * at any SELL; a read the Trader dates before the fill, its synchronization after the fill having failed, the event carrying the read
   * before; or a read that may already show the fill of another SELL of its pair, initiated and not yet heard to end (see
   * pendingSells). Two SELLs of one candle share the read after both: taken for what the account held after the first, it ended the
   * round trip with the proceeds of the first alone, and the second was skipped as sold while flat.
   */
  private heldAfter({ portfolio, portfolioReadAt }: BalanceRead, date: EpochTimeStamp): number {
    if (!isFetchedPortfolio(portfolio) || this.pendingSells.size > 0) return Infinity;
    if (!isNil(portfolioReadAt) && portfolioReadAt < date) return Infinity;
    return getAssetBalance(portfolio, this.asset).total;
  }

  /**
   * A BUY opens a round trip while flat, and adds to the position of the open one otherwise (scale-in): its amount, its cost and its fee,
   * but a fee taken in the asset of the pair, which the position carries (see countBuyFee and assetTakenByFee). The round trip it opens
   * enters with the whole portfolio's value before it: the portfolio the Trader read after it, its pair valued at its price, plus its
   * fee, whatever the asset it was taken in, which the BUY took from the portfolio (see RoundTrip.entryEquity). Unknown (NaN) when the
   * Trader had read no portfolio yet: valued, its empty one made the entry equity the fee alone, 0.1 for a BUY of 1 BTC at 100, and its
   * round trip, sold at 110, +9,790 %.
   *
   * Before a BUY adds to the round trip in progress, what the account held besides it (`held`, less what the BUY added) must hold the
   * position of that round trip: what it lacks was sold by a fill no event reported, and a round trip left with no more than dust is
   * over (see reconcileWithBalance), the BUY opening the next one. Merged into it, two round trips made one, the coins of the first that
   * an order ended in error had sold booked as lost. Returns the round trip it closed so, if any.
   */
  private registerBuy(fill: Fill, { portfolio }: BalanceRead, held: number): RoundTrip | undefined {
    const { id, date, price, amount, fee } = fill;
    const cost = multiplyPrecise(amount, price);
    const takenInAsset = this.assetTakenByFee(fill);
    const countedFee = this.countBuyFee(fill, takenInAsset);
    const position = addPrecise(amount, -takenInAsset);
    const before = this.openRoundTrip;
    const heldBefore = Number.isFinite(held) ? addPrecise(held, -position) : held;
    const closed = before ? this.reconcileWithBalance(before, heldBefore, { id, side: 'BUY', date }) : undefined;
    const roundTrip = this.openRoundTrip;
    if (!roundTrip) {
      const opened: OpenRoundTrip = {
        entryOrderId: id,
        entryAt: date,
        entryPrice: price,
        entryEquity: isFetchedPortfolio(portfolio) ? addPrecise(this.valuePortfolio(portfolio, price), fee) : NaN,
        bought: amount,
        sold: 0,
        position,
        cost,
        proceeds: 0,
        fees: countedFee,
        exitPrice: 0,
        maxAdverseExcursion: 0,
        excursionDeepenings: [],
      };
      // Heard in realtime after the buckets of minutes it already held: their candles count too (see countCandle)
      this.openRoundTrip = this.recentCandles.reduce(countCandle, opened);
      return closed;
    }
    // The round trip goes on: it keeps its entry date, its entry equity and its adverse excursion so far
    roundTrip.entryPrice = addToMeanPrice(roundTrip.entryPrice, roundTrip.bought, price, amount);
    roundTrip.bought = addPrecise(roundTrip.bought, amount);
    roundTrip.position = addPrecise(roundTrip.position, position);
    roundTrip.cost = addPrecise(roundTrip.cost, cost);
    roundTrip.fees = addPrecise(roundTrip.fees, countedFee);
  }

  /**
   * The part of the amount a BUY bought that its fee took, in the asset of the pair: its fee over its price, to 15 significant digits
   * (see toSignificantDigits), when the exchange took the fee in that asset, 0 otherwise. The Trader reports the fee in currency,
   * converted at the price of the BUY through the fee rate (see computeOrderPricing), which this works back: 0.001 BTC for a fee of 0.1
   * USDT on a BUY of 1 BTC at 100, at Binance's 0.1 %.
   */
  private assetTakenByFee({ price, fee, feeAsset }: Fill): number {
    return feeAsset === this.asset ? toSignificantDigits(fee / price) : 0;
  }

  /**
   * What of the fee of a BUY counts in the fees of its round trip: the fee, in currency as the Trader reports it, unless the exchange took
   * it in the asset of the pair, out of the amount bought, as Binance does unless the fees are paid in BNB. The round trip then holds
   * that much less of the asset (`takenInAsset`, see assetTakenByFee), its SELLs count that much less, and the smaller proceeds carry it
   * already: added here too, it counted twice, and the P&L was understated by it (see RoundTrip.fees). The entry equity counts it all the
   * same, whatever the asset: the BUY took it from the portfolio.
   */
  private countBuyFee({ id, fee, feeAsset }: Fill, takenInAsset: number): number {
    if (feeAsset !== this.asset) return fee;
    const fromAmount = `${formatEveryDecimal(takenInAsset)} ${this.asset} out of the amount bought`;
    const taken = `its fee of ${formatEveryDecimal(fee)} ${this.currency} was taken in ${this.asset}, ${fromAmount}`;
    debug('roundtrip analyzer', `BUY order ${id}: ${taken}: left out of the fees, its round trip holding that much less.`);
    return 0;
  }

  /**
   * A SELL reduces the position of the round trip (see OpenRoundTrip.position), and ends the round trip once flat again. It counts for no
   * more than that position: what it sold beyond is an asset held before the round trip, which an all-in SELL, or a SELL of the amount a
   * BUY whose fee the exchange took in the asset bought, sells too, and counts in no round trip, its share of the proceeds and of the fee
   * left out with it. Counted whole, the sale of that holding was booked as the profit of the round trip, at no cost. Then the balance
   * after it tells of a fill no event reported, and ends the round trip once the account holds no more than dust of its position (see
   * reconcileWithBalance).
   */
  private registerSell(roundTrip: OpenRoundTrip, { id, date, price, amount, fee }: Fill, held: number): RoundTrip | undefined {
    const counted = Math.min(amount, roundTrip.position);
    if (counted < amount) {
      const excess = `${formatEveryDecimal(addPrecise(amount, -counted))} of the ${formatEveryDecimal(amount)} ${this.asset} it sold`;
      const position = `its round trip on ${this.symbol} holding ${formatEveryDecimal(counted)}`;
      debug(
        'roundtrip analyzer',
        `SELL order ${id}: ${excess} were held before, ${position}: left out of it, with their share of the fee.`,
      );
    }
    const countedFee = counted === amount ? fee : toSignificantDigits(multiplyPrecise(fee, counted) / amount);
    this.countSale(roundTrip, counted, price, countedFee);
    return this.reconcileWithBalance(roundTrip, held, { id, side: 'SELL', date });
  }

  /**
   * Holds the round trip to what the account holds of its asset, `held`, after an order of its pair: all of it after a SELL, an asset
   * held before the round trip being in it too; what it held besides the BUY before the BUY adds to the round trip (see registerBuy).
   * Infinity when unknown (see heldAfter): the round trip then ends on its own amounts alone.
   *
   * What the account lacks of its position was sold by a fill no event reported: an order ended in error after fills it did not report
   * or whose creation's outcome was unknown, a sale made outside Gekko. Above DUST_TOLERANCE of the amount it bought, it counts as sold
   * at the last close of its pair, without a fee (unknown), with a warning naming the pair and the amount: the round trip ended without
   * it, and its cost, booked whole, made the coins sold unseen a loss of their whole value. Less is the gap left by a fee taken in the
   * asset that its BUYs did not report so, or by an amount rounded to the step of the exchange, which no SELL can sell.
   *
   * The round trip ends once what is left of its position, but no more than the account holds, is dust: at most DUST_TOLERANCE of the
   * amount its BUYs bought. It is dated at the order that ended it. Returns the round trip it ended, if any.
   */
  private reconcileWithBalance(
    roundTrip: OpenRoundTrip,
    held: number,
    order: { id: UUID; side: OrderFill['side']; date: EpochTimeStamp },
  ): RoundTrip | undefined {
    const dust = DUST_TOLERANCE * roundTrip.bought;
    const missing = Number.isFinite(held) ? Math.min(roundTrip.position, addPrecise(roundTrip.position, -held)) : 0;
    if (missing > dust) {
      const price = this.lastClose;
      warning(
        'roundtrip analyzer',
        [
          `${formatEveryDecimal(missing)} ${this.asset} of the round trip in progress on ${this.symbol} are no longer in the account, as`,
          `the balance read after ${order.side} order ${order.id} shows: sold by a fill no event reported (an order ended in error, a`,
          `sale made outside Gekko), they count as sold at the last close, ${formatEveryDecimal(price)} ${this.currency}, without a fee.`,
        ].join(' '),
      );
      this.countSale(roundTrip, missing, price, 0);
    }
    if (Math.min(roundTrip.position, held) > dust) return;

    this.openRoundTrip = null;
    return this.closeRoundTrip(roundTrip, order.date);
  }

  /** Counts `amount` of the position of the round trip as sold at `price`, for `fee` in currency */
  private countSale(roundTrip: OpenRoundTrip, amount: number, price: number, fee: number): void {
    roundTrip.exitPrice = addToMeanPrice(roundTrip.exitPrice, roundTrip.sold, price, amount);
    roundTrip.sold = addPrecise(roundTrip.sold, amount);
    roundTrip.position = addPrecise(roundTrip.position, -amount);
    roundTrip.proceeds = addPrecise(roundTrip.proceeds, multiplyPrecise(amount, price));
    roundTrip.fees = addPrecise(roundTrip.fees, fee);
  }

  /**
   * Records the round trip that the order dated `exitAt` ended, and returns it. Its profit is unknown when no portfolio read valued its
   * entry (see measureRoundTrip): it counts in the win rate, its P&L being known from its fills, and in the exposure and the MAEs, not in
   * the returns, which the ratios are worked out from; a warning names the BUY that opened it.
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
