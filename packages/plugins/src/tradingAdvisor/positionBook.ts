import { BUY_COST_SHARE } from '@gekko/shared/constants/order.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { getAllocatedShare } from '@gekko/shared/helpers/order/sizing.helper';
import { OrderCanceledEvent, OrderCompletedEvent, OrderErroredEvent } from '@gekko/shared/models/event.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { addPrecise, isFinitePositive, multiplyPrecise } from '@gekko/shared/utils/math/math.utils';
import { round } from '@gekko/shared/utils/math/round.utils';
import { formatEveryDecimal, listInWords } from '@gekko/shared/utils/string/string.utils';
import { PositionBuyOrder, PositionSellOrder } from '@gekko/strategies/strategy.types';
import { TrailingStopState } from '@gekko/strategies/trailingStopManager.types';
import { UUID } from 'node:crypto';
import { SHARE_DECIMALS } from './positionBook.const';
import { describeShare, getBuyRefusal, isSameRead } from './positionBook.helper';
import { BuyEstimate, CurrencyRead, PendingBuy, PositionBookContext } from './positionBook.types';
import { PositionTracker } from './positionTracker';
import { OrderEnd } from './positionTracker.types';

/**
 * The positions of a strategy, which the StrategyManager keeps for it and exposes as tools.positions (see Positions): one
 * PositionTracker per pair it tracks, flat or long, with its own orders whose outcome has not come yet (see PositionTracker), and the
 * share of the currency each BUY takes. The strategy has it track its pairs from init (see track) and places its orders on a pair
 * through buy and sell once canBuy or canSell allows it there; the StrategyManager hands the book the end of every order before the
 * strategy's order hook runs: an outcome settles the tracker of its order's pair, and leaves the others as they were. No strategy holds
 * a book or a tracker, nor hands them anything: what the book reads of the run comes from the context the manager builds it with (see
 * PositionBookContext).
 *
 * Each BUY takes an equal share of the free currency among the pairs not invested, which the Trader sizes as an allocation (see buy),
 * and each SELL sells all of its asset, as on one pair. All-in on every pair, the first BUY would spend all the currency, and the BUYs
 * of the other pairs would be sized from nothing and refused, each refusal counting towards the circuit breaker. Every pair has an
 * asset of its own, and all share the currency of watch.currency: what a SELL brings in, the BUYs of every pair may spend.
 */
export class PositionBook {
  /** What it reads of the run, from the StrategyManager that builds it (see PositionBookContext) */
  private readonly context: PositionBookContext;
  /**
   * The tracker of each pair tracked, in the order track got them: what the book goes by, how many pairs it tracks and which, never the
   * array it hands out (see trackedPairs)
   */
  private readonly trackers = new Map<TradingPair, PositionTracker>();
  /**
   * The pairs tracked, in the order track got them, undefined until it is called: the array the book hands out (see pairs), which no
   * decision of the book reads. An untyped strategy can write to it, its type alone readonly: read for the number of pairs, a pair pushed
   * made a book of one pair estimate and skip its all-in BUY, and an array emptied made a book of several pairs send every BUY the market
   * refuses, each refusal counting towards the circuit breaker.
   */
  private trackedPairs?: readonly TradingPair[];
  /** The pairs whose BUY was skipped with a warning, none of their BUYs placed since: their next skips are logged at debug level */
  private readonly warnedSkips = new Set<TradingPair>();
  /**
   * The BUYs of the book's own whose outcome has not come yet, by id, each with what the Trader holds of the currency for it and the read
   * of the currency it was sized from (see getHeldByOpenBuys): those a book of several pairs placed from a portfolio that lists the
   * currency, holding some of it (see buy), each forgotten once its outcome comes
   */
  private readonly pendingBuys = new Map<UUID, PendingBuy>();
  /**
   * The BUYs of the book's own that asked for a trailing stop, by id, a stop's id being its BUY's: the SELL such a stop sends is the
   * book's to adopt (see adoptStopSell). Kept past the end of the BUY, since the stop is armed only then and may trigger long after, and
   * forgotten once the stop is no longer alive, as the next BUY with a trailing finds (see rememberStop): the memory holds the stops
   * still pending or armed, never the whole history of a run.
   */
  private readonly stopBuyIds = new Set<UUID>();

  constructor(context: PositionBookContext) {
    this.context = context;
  }

  /**
   * The pairs tracked, in the order track got them: none before track. The book's own array, neither copied nor frozen, which the
   * strategy walks on every candle (see track): written to, it changes what the strategy walks, and nothing the book decides.
   */
  get pairs(): readonly TradingPair[] {
    return this.trackedPairs ?? [];
  }

  /**
   * Tracks `pairs`, in the order given, each flat with nothing pending: called once, from init (tools.positions.track), the
   * StrategyManager having resolved and checked them (every watched pair unless the strategy names some, each watched and named once).
   * When it tracks several pairs, it says so once, at info level, through the strategy's log, with the rule of their orders; on one
   * pair it says nothing. Called again, it throws a GekkoError: the bot stops.
   */
  track(pairs: readonly TradingPair[]): void {
    if (this.trackedPairs) throw new GekkoError('strategy', 'The position book tracks its pairs already: track is called once, from init');
    // A plain copy, readonly by its type alone: Bun walks a frozen array some ten times slower, and frozen, the pairs the hooks loop over
    // on every candle cost a backtest on 1m candles up to 9 % of its time
    this.trackedPairs = [...pairs];
    for (const pair of this.trackedPairs) this.trackers.set(pair, new PositionTracker(this.context));
    if (this.trackers.size < 2) return;
    const rule = 'each BUY takes an equal share of the free currency among the pairs not invested, each SELL sells all of its asset';
    this.context.log('info', `Trading ${listInWords([...this.trackers.keys()])}: ${rule}`);
  }

  /**
   * Whether the strategy holds enough of the asset of `pair` to sell, as far as the outcomes of its orders tell; false for a pair not
   * tracked
   */
  isLong(pair: TradingPair): boolean {
    return this.trackers.get(pair)?.isLong ?? false;
  }

  /** Whether an order of the book's own on `pair` still waits for its outcome; false for a pair not tracked */
  isPendingOrder(pair: TradingPair): boolean {
    return this.trackers.get(pair)?.isPendingOrder ?? false;
  }

  /** Flat on `pair`, and nothing pending there; false for a pair not tracked */
  canBuy(pair: TradingPair): boolean {
    return this.trackers.get(pair)?.canBuy() ?? false;
  }

  /** Long on `pair`, and nothing pending there; false for a pair not tracked */
  canSell(pair: TradingPair): boolean {
    return this.trackers.get(pair)?.canSell() ?? false;
  }

  /**
   * Places a BUY of `order.symbol` through the tracker of that pair, which keeps it pending until its outcome; returns its id, or
   * undefined when the BUY is skipped, which a book of several pairs alone does (see isSkipped): nothing sent, nothing pending, the pair
   * long if the portfolio holds enough of its asset to sell. A pair not tracked throws a GekkoError: the bot stops. A BUY placed with a
   * trailing is remembered as the book's, so that the SELL its stop sends is adopted (see adoptStopSell).
   *
   * It takes an equal share of the free currency among the n pairs not invested, sent as its allocation, 100 / n %, rounded down to
   * SHARE_DECIMALS decimals, of the currency the Trader sizes an allocation from: the currency free at its last synchronization, plus
   * what its own BUYs still open at that read held of it, the part they had filled included (see the allocation of Tools.createOrder):
   * - n counts every pair that is not long, flat with nothing pending or flat with a BUY pending, the pair asking among them (it buys
   *   once canBuy allows it, and counts even when long): n is 1 at least. A pair whose BUY is pending counts: two signals on one candle
   *   are both sized by the Trader from the same balance read, the second placed before any synchronization. Left out, the second would
   *   ask more than an equal share of that balance (all of it, on two pairs), which the Trader caps at what the first leaves, with a
   *   warning. Counted, the shares of one candle are equal. So are those of BUYs a synchronization falls between, while the first rests
   *   (a STICKY order resting past a periodic read): that read shows the currency less what the resting BUY holds of it, which the
   *   Trader adds back, so that the BUY counted among the n is counted in the currency shared too. Shared from the free currency alone,
   *   the share after such a read was smaller than equal, and on two pairs the rest stayed idle once both were long, no pair left to buy
   *   with it. A pair whose SELL is pending is long: what that SELL brings in is the currency's once it fills.
   * - Rounded down: 100 / 3 is 33.333333333333336 as a double, and three BUYs of it on one candle asked for more than 100 % of the
   *   balance read, the third capped by the Trader at what the first two left, with a warning. Rounded down, n shares sum to 100 % less
   *   under n millionths of a percent, a rest below the dust of any order.
   * - n = 1, the last pair not invested or the one pair tracked, buys all-in, without an allocation. On one pair, it is the order the
   *   strategy sent before it traded several, its lines, warnings and notifications unchanged; on several, the last pair spends what the
   *   shares before it left of the currency, the rests of their rounding included.
   */
  buy(order: PositionBuyOrder): UUID | undefined {
    const tracker = this.getTracker(order.symbol, `place the BUY ${order.type} order`);
    const allocation = this.getAllocation(order.symbol);
    const estimate = this.estimateBuy(order.symbol, allocation);
    if (estimate && this.isSkipped(tracker, order, allocation, estimate)) return;
    this.warnedSkips.delete(order.symbol);
    const id = tracker.buy(allocation === undefined ? order : { ...order, allocation });
    if (estimate) {
      // What the Trader holds for it at the reads after it, its amount at the price it was created with: its budget less the share
      // DEFAULT_FEE_BUFFER keeps back for the fee, to 15 significant digits (see getAllInBuyAmount). Nothing for a BUY sized from no
      // currency, nor from a balance that is no number, as the Trader counts none (see Trader.readHeldByOpenBuys).
      const held = multiplyPrecise(estimate.budget, BUY_COST_SHARE);
      if (isFinitePositive(held)) this.pendingBuys.set(id, { held, sizedFrom: estimate.read });
    }
    if (order.trailing) this.rememberStop(id);
    return id;
  }

  /**
   * Places an all-in SELL of `order.symbol` through the tracker of that pair, as PositionTracker.sell does on one pair: without an
   * amount, a cost or an allocation, the Trader sells all of the asset free; returns its id. A pair not tracked throws a GekkoError: the
   * bot stops.
   */
  sell(order: PositionSellOrder): UUID {
    return this.getTracker(order.symbol, `place the SELL ${order.type} order`).sell(order);
  }

  /**
   * Adopts the SELL `sellId` a trailing stop sent as it triggered, on the tracker of the stop's pair (see PositionTracker.adoptSell),
   * when the stop's BUY was one of the book's own that asked for it (see buy); returns whether it did. The StrategyManager calls it as
   * the stop triggers, before the strategy's onTrailingStopTriggered: the SELL is then pending on the pair, and its outcome settles the
   * position as that of any SELL of the book. Unadopted, a stop that sold everything left the strategy long, and the SELL it advised
   * next was refused, nothing left to sell. A stop made active again once its SELL ended keeps its id: its next SELL is adopted too.
   * The SELL of a stop whose BUY was not the book's, created with tools.createOrder, is no more the book's than that BUY was: nothing is
   * adopted. The pair of a stop is that of its BUY, which the book tracks: any other throws a GekkoError, as buy does.
   */
  adoptStopSell(sellId: UUID, stop: Pick<TrailingStopState, 'id' | 'symbol'>): boolean {
    if (!this.stopBuyIds.has(stop.id)) return false;
    this.getTracker(stop.symbol, `adopt the SELL ${sellId}`).adoptSell(sellId);
    return true;
  }

  /**
   * Settles an order that completed, on the tracker of its pair (see PositionTracker.onOrderCompleted), and forgets what a BUY of the
   * book's own held (see getHeldByOpenBuys); returns whether it was an order of that tracker's own, false for an order of a pair not
   * tracked. The StrategyManager hands it the end of every order as it hears of it, before the strategy's order hook runs.
   */
  onOrderCompleted(event: OrderEnd<OrderCompletedEvent>): boolean {
    this.pendingBuys.delete(event.order.id);
    return this.trackers.get(event.order.symbol)?.onOrderCompleted(event) ?? false;
  }

  /**
   * Settles an order that was canceled, on the tracker of its pair (see PositionTracker.onOrderCanceled), and forgets what a BUY of the
   * book's own held (see getHeldByOpenBuys); returns whether it was an order of that tracker's own, false for an order of a pair not
   * tracked
   */
  onOrderCanceled(event: OrderEnd<OrderCanceledEvent>): boolean {
    this.pendingBuys.delete(event.order.id);
    return this.trackers.get(event.order.symbol)?.onOrderCanceled(event) ?? false;
  }

  /**
   * Settles an order that errored, on the tracker of its pair (see PositionTracker.onOrderErrored), and forgets what a BUY of the book's
   * own held (see getHeldByOpenBuys); returns whether it was an order of that tracker's own, false for an order of a pair not tracked
   */
  onOrderErrored(event: OrderEnd<OrderErroredEvent>): boolean {
    this.pendingBuys.delete(event.order.id);
    return this.trackers.get(event.order.symbol)?.onOrderErrored(event) ?? false;
  }

  /** The tracker of `symbol`, to `action` (as the refusal names it): a pair not tracked throws a GekkoError */
  private getTracker(symbol: TradingPair, action: string): PositionTracker {
    const tracker = this.trackers.get(symbol);
    if (tracker) return tracker;
    const tracked = this.trackers.size > 0 ? listInWords([...this.trackers.keys()]) : 'no pair until init calls track';
    throw new GekkoError('strategy', `Impossible to ${action} on ${symbol}: the position book does not track it (it tracks ${tracked})`);
  }

  /**
   * Remembers the BUY `buyId`, placed by the book with a trailing (see stopBuyIds), once it has forgotten those whose stop is no longer
   * alive (see PositionBookContext.isStopAlive): over, canceled with its BUY or by the strategy
   */
  private rememberStop(buyId: UUID) {
    for (const id of this.stopBuyIds) if (!this.context.isStopAlive(id)) this.stopBuyIds.delete(id);
    this.stopBuyIds.add(buyId);
  }

  /**
   * What the Trader adds back to the currency free of `read` for its own BUYs open at that read, as the book estimates it (see
   * isSkipped): what each BUY of the book's own still pending holds (see buy), but those sized from that very read, placed after it,
   * which the Trader leaves out too. A BUY sized from another read was placed before this one, which shows it: the currency it reserves
   * moved to used, or spent on its fills.
   */
  private getHeldByOpenBuys(read: CurrencyRead): number {
    return [...this.pendingBuys.values()]
      .filter(({ sizedFrom }) => !isSameRead(sizedFrom, read))
      .reduce((sum, { held }) => addPrecise(sum, held), 0);
  }

  /**
   * What a BUY of `symbol`, allocated `allocation` % of the currency (all-in when undefined), is estimated from (see isSkipped), from the
   * balance of the currency in the last portfolio the StrategyManager received, of which the candle hooks get a copy (see
   * PositionBookContext.getPortfolio). Undefined in a book that tracks one pair, which never skips, its pairs counted by its trackers,
   * whatever the strategy wrote to the array it walks (see trackedPairs), and when the portfolio does not list the currency (no balance
   * read yet): the Trader and the exchange then say what they make of the BUY.
   */
  private estimateBuy(symbol: TradingPair, allocation: number | undefined): BuyEstimate | undefined {
    if (this.trackers.size < 2) return;
    const [, currency] = symbol.split('/');
    const balance = this.context.getPortfolio().get(currency);
    if (!balance) return;
    const read = { free: balance.free, used: balance.used };
    if (allocation === undefined) return { currency, read, held: 0, budget: read.free };
    const held = this.getHeldByOpenBuys(read);
    return { currency, read, held, budget: getAllocatedShare(held > 0 ? addPrecise(read.free, held) : read.free, allocation) };
  }

  /**
   * The allocation of a BUY of `symbol`, in % (see buy): 100 / n rounded down to SHARE_DECIMALS decimals, n the pairs not long, those
   * whose BUY is pending among them, and `symbol` itself; undefined when n is 1, the BUY all-in
   */
  private getAllocation(symbol: TradingPair): number | undefined {
    const notInvested = [...this.trackers].filter(([pair, tracker]) => pair === symbol || !tracker.isLong).length;
    return notInvested > 1 ? round(100 / notInvested, SHARE_DECIMALS, 'down') : undefined;
  }

  /**
   * Whether the BUY `order`, allocated `allocation` % of the currency (all of the currency free when undefined), is skipped, in a book
   * that tracks several pairs: when the market would refuse it for its cost or its amount (see getBuyRefusal), as estimated from the
   * last portfolio the StrategyManager received, the share allocated (see getAllocatedShare), and the close of the last timeframe candle
   * of its pair (see PositionBookContext). Sent, the exchange refuses it, each refusal counting towards the circuit breaker: a share of
   * too little currency is refused at every signal of its pair, and the refusals stop the bot once maxConsecutiveErrors of them follow
   * one another, though the currency would fund the BUYs of fewer pairs. Every BUY is checked then, that of the last pair not invested,
   * all-in, included. Without the currency in the portfolio (no balance read yet), or without a minimum cost or amount on the market,
   * nothing is skipped: the Trader and the exchange say what they make of the BUY (see estimateBuy).
   *
   * A share is estimated from the currency free, plus what the Trader adds back to it for its own BUYs open at its read (see buy). The
   * book records with each BUY it places what the Trader holds for it, its budget less the share DEFAULT_FEE_BUFFER keeps back for the
   * fee: what the Trader counts, its amount at the price it was created with, to 15 significant digits (see getAllInBuyAmount). It adds
   * that of each BUY still pending that was sized from another read of the currency, one before the read the BUY is estimated from,
   * which shows it, reserved or spent on its fills (see getHeldByOpenBuys); not that of a BUY sized from that very read, placed after it,
   * which the Trader does not add back either: two BUYs of one candle are sized from one read. Estimated from the currency free alone, a
   * share depended on whether a synchronization fell between the two BUYs, and was skipped though the Trader sized it above the minimum:
   * on 30 USDT, BTC's BUY of 50 % resting across a read of 15.75 USDT free and 14.25 USDT held, ETH's came out at 7.48125 USDT, under a
   * minimum cost of 10, where the Trader sized it at 14.25. Estimated from what the exchange holds for the orders open at the read
   * (`used`), it went by another figure than the Trader's: less once that BUY had partly filled, or once the exchange had truncated its
   * amount to the amount step, more by the maker fee the simulator holds with it, by the move of a STICKY BUY above the price it was
   * created at, or by the orders Gekko did not place. The book skipped a BUY the Trader sized above the minimum of the market (BTC's BUY
   * half filled, ETH's share came out at 10.865625 USDT, under a minimum cost of 12, where the Trader sized it at 14.25), or sent one the
   * Trader sized under it, which the market refused, a refusal counting towards the circuit breaker.
   *
   * The figure still differs from the Trader's where the Trader caps the budget of a BUY, at what the BUYs it placed since its read leave
   * of the currency or at the most the market takes in one order, and for a BUY the strategy canceled before the read, of which the Trader
   * counts what it had filled: the Trader sizes a BUY once the book has placed it, from its own read, and the strategy hears nothing of
   * that sizing before the outcome of the BUY, while a cancelation goes to the Trader through tools.cancelOrder, which the book does not
   * see. So it does for the BUYs the strategy created with tools.createOrder that were open at the read: the Trader adds back what they
   * hold, as it does for every BUY of its own (see Trader.readHeldByOpenBuys), while the book, which does not see them, adds back its own
   * alone (see getHeldByOpenBuys), so that a strategy that places BUYs both ways on one currency can have one skipped that the Trader
   * would size above the minimum of the market. It differs too when the read is not the Trader's last: the portfolio the book reads is
   * the last one the Trader sent, which its portfolioUpdates filter may hold back, and a read taken after a BUY that does not show it
   * yet, its creation not on the exchange by then, is taken for the read the BUY was sized from. An all-in BUY is estimated from the
   * currency free alone, as the Trader sizes it from what is left of it.
   *
   * A book that tracks one pair never skips: its all-in BUY is sent as a single-pair strategy always sent it, and refused when the
   * currency is too little, the Trader warning of it first when it is below a minimum of the market (see Trader.warnOfMarketMinimums).
   * That refusal is how its tracker learns of a holding present at start-up, read from the portfolio after it and sold at the next SELL
   * signal (see PositionTracker), and how an account that can neither buy nor sell trips maxConsecutiveErrors, which stops the bot:
   * skipped, the bot would run on with nothing to trade, every skip after the first logged at debug level.
   *
   * On several pairs a skip teaches the tracker what that refusal would have: the asset free in the portfolio, when it is enough to sell
   * at the close, is the position (see PositionTracker.adoptHolding), said at info level, and the strategy sells it at its next SELL
   * signal. Skipped without a word of it, a holding present at start-up was never sold: after a restart long on every pair with little
   * currency left, every BUY was skipped, the strategy stayed flat beside the holdings, ignoring its SELL signals, and the warning
   * advised to fund the account.
   *
   * Any other skip is said through the strategy's log: at warn level for the first skip of a pair, then at debug level for its next
   * skips, until a BUY of that pair is placed. A strategy whose signal holds over many candles (TMA, EMARibbon) asks for its BUY again on
   * each, and the same warning would come on every candle until the currency or the pairs tracked changed.
   */
  private isSkipped(
    tracker: PositionTracker,
    order: PositionBuyOrder,
    allocation: number | undefined,
    { currency, read, held, budget }: BuyEstimate,
  ): boolean {
    const { symbol, type } = order;
    const [asset] = symbol.split('/');
    const marketData = this.context.getMarketData(symbol);
    const close = this.context.getClose(symbol);
    const refusal = getBuyRefusal(order, budget, close, marketData);
    if (refusal === undefined) return false;

    const share = describeShare(allocation, read.free, held, currency);
    const assetFree = this.context.getPortfolio().get(asset)?.free;
    if (assetFree !== undefined && isFinitePositive(close) && tracker.adoptHolding(assetFree, close, type, marketData)) {
      const holding = `${formatEveryDecimal(assetFree)} ${asset} is free in the portfolio, enough to sell`;
      this.context.log('info', `[${symbol}] BUY skipped: ${share}, ${refusal}, but ${holding}: the strategy is long`);
      return true;
    }
    const remedy = allocation === undefined ? 'fund the account' : 'watch fewer pairs or fund the account';
    const line = `[${symbol}] BUY skipped: ${share}, ${refusal}: ${remedy}`;
    if (this.warnedSkips.has(symbol)) {
      this.context.log('debug', line);
      return true;
    }
    this.warnedSkips.add(symbol);
    this.context.log('warn', `${line}; the next skips of this pair are logged at debug level until a BUY of it is placed`);
    return true;
  }
}
