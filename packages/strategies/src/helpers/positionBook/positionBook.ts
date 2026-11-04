import { BUY_COST_SHARE } from '@gekko/shared/constants/order.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { getAllocatedShare } from '@gekko/shared/helpers/order/sizing.helper';
import { PositionTracker } from '../positionTracker/positionTracker';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { OnOrderCanceledEventParams, OnOrderCompletedEventParams, OnOrderErroredEventParams } from '../../strategy.types';
import { addPrecise, isFinitePositive, multiplyPrecise } from '@gekko/shared/utils/math/math.utils';
import { round } from '@gekko/shared/utils/math/round.utils';
import { formatEveryDecimal, listInWords } from '@gekko/shared/utils/string/string.utils';
import { UUID } from 'node:crypto';
import { SHARE_DECIMALS } from './positionBook.const';
import { describeShare, getBuyRefusal, isSameRead } from './positionBook.helper';
import { BuyEstimate, BuyOrder, CurrencyRead, OrderParams, PendingBuy, SellOrder, TrackParams } from './positionBook.types';

/**
 * The positions of a strategy that trades every pair it watches: one PositionTracker per pair, flat or long, with its own orders whose
 * outcome has not come yet (see PositionTracker), and the share of the currency each BUY takes. The strategy tracks the pairs of the
 * bucket its init gets, in the order of watch.assets (see track), places its orders on a pair through buy and sell once canBuy or
 * canSell allows it there, handing them the params of its candle hook, and hands the params of its three order hooks to the book's,
 * whole: an outcome settles the tracker of its order's pair, and leaves the others as they were.
 *
 * Each BUY takes an equal share of the free currency among the pairs not invested, which the Trader sizes as an allocation (see buy),
 * and each SELL sells all of its asset, as on one pair. All-in on every pair, the first BUY would spend all the currency, and the BUYs
 * of the other pairs would be sized from nothing and refused, each refusal counting towards the circuit breaker. Every pair has an
 * asset of its own, and all share the currency of watch.currency: what a SELL brings in, the BUYs of every pair may spend.
 */
export class PositionBook {
  /** The tracker of each pair tracked */
  private readonly trackers = new Map<TradingPair, PositionTracker>();
  /** The pairs tracked, in the order of the bucket track got: undefined until it is called */
  private trackedPairs?: readonly TradingPair[];
  /** The pairs whose BUY was skipped with a warning, none of their BUYs placed since: their next skips are logged at debug level */
  private readonly warnedSkips = new Set<TradingPair>();
  /**
   * The BUYs of the book's own whose outcome has not come yet, by id, each with what the Trader holds of the currency for it and the read
   * of the currency it was sized from (see getHeldByOpenBuys): those a book of several pairs placed from a portfolio that lists the
   * currency, holding some of it (see buy), each forgotten once its outcome comes
   */
  private readonly pendingBuys = new Map<UUID, PendingBuy>();

  /** The pairs tracked, in the order of watch.assets: none before track */
  get pairs(): readonly TradingPair[] {
    return this.trackedPairs ?? [];
  }

  /**
   * Tracks every pair of the bucket init gets (`params.candle`, a candle of every watched pair in the order of watch.assets), each flat
   * with nothing pending: called once, from init, with its params. When it tracks several pairs, it says so once, at info level,
   * through the strategy's log, with the rule of their orders; on one pair it says nothing. Called again, it throws a GekkoError: the
   * bot stops.
   */
  track({ candle, tools }: TrackParams): void {
    if (this.trackedPairs) throw new GekkoError('strategy', 'The position book tracks its pairs already: track is called once, from init');
    // A plain copy, readonly by its type alone: Bun walks a frozen array some ten times slower, and frozen, the pairs the hooks loop over
    // on every candle cost a backtest on 1m candles up to 9 % of its time
    this.trackedPairs = [...candle.keys()];
    for (const pair of this.trackedPairs) this.trackers.set(pair, new PositionTracker());
    if (this.trackedPairs.length < 2) return;
    const rule = 'each BUY takes an equal share of the free currency among the pairs not invested, each SELL sells all of its asset';
    tools.log('info', `Trading ${listInWords(this.trackedPairs)}: ${rule}`);
  }

  /**
   * Whether the strategy holds enough of the asset of `pair` to sell, as far as the outcomes of its orders tell; false for a pair not
   * tracked
   */
  isLong(pair: TradingPair): boolean {
    return this.trackers.get(pair)?.isLong ?? false;
  }

  /** Whether an order of the strategy's own on `pair` still waits for its outcome; false for a pair not tracked */
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
   * long if the portfolio holds enough of its asset to sell. `params` are those of the candle hook it is called from, whole. A pair not
   * tracked throws a GekkoError: the bot stops.
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
   * - n = 1, the last pair not invested or the one pair watched, buys all-in, without an allocation. On one pair, it is the order the
   *   strategy sent before it traded several, its lines, warnings and notifications unchanged; on several, the last pair spends what the
   *   shares before it left of the currency, the rests of their rounding included.
   */
  buy(order: BuyOrder, params: OrderParams): UUID | undefined {
    const tracker = this.getTracker(order.symbol, `place the BUY ${order.type} order`);
    const allocation = this.getAllocation(order.symbol);
    const estimate = this.estimateBuy(order.symbol, allocation, params.portfolio);
    if (estimate && this.isSkipped(tracker, order, allocation, estimate, params)) return;
    this.warnedSkips.delete(order.symbol);
    const id = tracker.buy(params.tools.createOrder, allocation === undefined ? order : { ...order, allocation });
    if (estimate) {
      // What the Trader holds for it at the reads after it, its amount at the price it was created with: its budget less the share
      // DEFAULT_FEE_BUFFER keeps back for the fee, to 15 significant digits (see getAllInBuyAmount). Nothing for a BUY sized from no
      // currency, nor from a balance that is no number, as the Trader counts none (see Trader.readHeldByOpenBuys).
      const held = multiplyPrecise(estimate.budget, BUY_COST_SHARE);
      if (isFinitePositive(held)) this.pendingBuys.set(id, { held, sizedFrom: estimate.read });
    }
    return id;
  }

  /**
   * Places an all-in SELL of `order.symbol` through the tracker of that pair, as PositionTracker.sell does on one pair: without an
   * amount, a cost or an allocation, the Trader sells all of the asset free; returns its id. `params` are those of the candle hook it is
   * called from, whole. A pair not tracked throws a GekkoError: the bot stops.
   */
  sell(order: SellOrder, { tools }: OrderParams): UUID {
    return this.getTracker(order.symbol, `place the SELL ${order.type} order`).sell(tools.createOrder, order);
  }

  /**
   * Adopts, as the tracker of `symbol` does (see PositionTracker.adoptSell), the SELL a trailing stop sends when it triggers: from
   * onTrailingStopTriggered(orderId, state, tools), `symbol` being state.symbol. A pair not tracked throws a GekkoError: the bot stops.
   */
  adoptSell(orderId: UUID, symbol: TradingPair): void {
    this.getTracker(symbol, `adopt the SELL ${orderId}`).adoptSell(orderId);
  }

  /**
   * Settles an order that completed, on the tracker of its pair (see PositionTracker.onOrderCompleted), and forgets what a BUY of the
   * book's own held (see getHeldByOpenBuys); returns whether it was an order of that tracker's own, false for an order of a pair not
   * tracked
   */
  onOrderCompleted(params: OnOrderCompletedEventParams<unknown>): boolean {
    this.pendingBuys.delete(params.order.id);
    return this.trackers.get(params.order.symbol)?.onOrderCompleted(params) ?? false;
  }

  /**
   * Settles an order that was canceled, on the tracker of its pair (see PositionTracker.onOrderCanceled), and forgets what a BUY of the
   * book's own held (see getHeldByOpenBuys); returns whether it was an order of that tracker's own, false for an order of a pair not
   * tracked
   */
  onOrderCanceled(params: OnOrderCanceledEventParams<unknown>): boolean {
    this.pendingBuys.delete(params.order.id);
    return this.trackers.get(params.order.symbol)?.onOrderCanceled(params) ?? false;
  }

  /**
   * Settles an order that errored, on the tracker of its pair (see PositionTracker.onOrderErrored), and forgets what a BUY of the book's
   * own held (see getHeldByOpenBuys); returns whether it was an order of that tracker's own, false for an order of a pair not tracked
   */
  onOrderErrored(params: OnOrderErroredEventParams<unknown>): boolean {
    this.pendingBuys.delete(params.order.id);
    return this.trackers.get(params.order.symbol)?.onOrderErrored(params) ?? false;
  }

  /** The tracker of `symbol`, to `action` (as the refusal names it): a pair not tracked throws a GekkoError */
  private getTracker(symbol: TradingPair, action: string): PositionTracker {
    const tracker = this.trackers.get(symbol);
    if (tracker) return tracker;
    const tracked = this.pairs.length > 0 ? listInWords(this.pairs) : 'no pair until init calls track';
    throw new GekkoError('strategy', `Impossible to ${action} on ${symbol}: the position book does not track it (it tracks ${tracked})`);
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
   * balance of the currency in `portfolio`, that of the hook. Undefined in a book that tracks one pair, which never skips, and when the
   * portfolio does not list the currency (no balance read yet): the Trader and the exchange then say what they make of the BUY.
   */
  private estimateBuy(symbol: TradingPair, allocation: number | undefined, portfolio: Portfolio): BuyEstimate | undefined {
    if (this.pairs.length < 2) return;
    const [, currency] = symbol.split('/');
    const balance = portfolio.get(currency);
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
   * portfolio of the hook, the share allocated (see getAllocatedShare), and the close of its pair in the candle of the hook. Sent, the
   * exchange refuses it, each refusal counting towards the circuit breaker: a share of too little currency is refused at every signal of
   * its pair, and the refusals stop the bot once maxConsecutiveErrors of them follow one another, though the currency would fund the
   * BUYs of fewer pairs. Every BUY is checked then, that of the last pair not invested, all-in, included. Without the currency in the
   * portfolio (no balance read yet), or without a minimum cost or amount on the market, nothing is skipped: the Trader and the exchange
   * say what they make of the BUY (see estimateBuy).
   *
   * A share is estimated from the currency free, plus what the Trader adds back to it for its own BUYs open at its read (see buy). The
   * book records with each BUY it places what the Trader holds for it, its budget less the share DEFAULT_FEE_BUFFER keeps back for the
   * fee: what the Trader counts, its amount at the price it was created with, to 15 significant digits (see getAllInBuyAmount). It adds
   * that of each BUY still pending that was sized from another read of the currency, one before the read of the hook, which shows it,
   * reserved or spent on its fills (see getHeldByOpenBuys); not that of a BUY sized from the read of the hook, placed after it, which the
   * Trader does not add back either: two BUYs of one candle are sized from one read. Estimated from the currency free alone, a share
   * depended on whether a synchronization fell between the two BUYs, and was skipped though the Trader sized it above the minimum: on 30
   * USDT, BTC's BUY of 50 % resting across a read of 15.75 USDT free and 14.25 USDT held, ETH's came out at 7.48125 USDT, under a minimum
   * cost of 10, where the Trader sized it at 14.25. Estimated from what the exchange holds for the orders open at the read (`used`), it
   * went by another figure than the Trader's: less once that BUY had partly filled, or once the exchange had truncated its amount to the
   * amount step, more by the maker fee the simulator holds with it, by the move of a STICKY BUY above the price it was created at, or by
   * the orders Gekko did not place. The book skipped a BUY the Trader sized above the minimum of the market (BTC's BUY half filled, ETH's
   * share came out at 10.865625 USDT, under a minimum cost of 12, where the Trader sized it at 14.25), or sent one the Trader sized under
   * it, which the market refused, a refusal counting towards the circuit breaker.
   *
   * The figure still differs from the Trader's where the Trader caps the budget of a BUY, at what the BUYs it placed since its read leave
   * of the currency or at the most the market takes in one order, and for a BUY the strategy canceled before the read, of which the Trader
   * counts what it had filled: the Trader sizes a BUY once the book has placed it, from its own read, and the strategy hears nothing of
   * that sizing before the outcome of the BUY, while a cancelation goes to the Trader through tools.cancelOrder, which the book does not
   * see. It differs too when the read is not the Trader's last: the portfolio of the hook is the last one the Trader sent, which its
   * portfolioUpdates filter may hold back, and a read taken after a BUY that does not show it yet, its creation not on the exchange by
   * then, is taken for the read the BUY was sized from. An all-in BUY is estimated from the currency free alone, as the Trader sizes it
   * from what is left of it.
   *
   * A book that tracks one pair never skips: its all-in BUY is sent as a single-pair strategy always sent it, and refused when the
   * currency is too little, the Trader warning of it first when it is below a minimum of the market (see Trader.warnOfMarketMinimums).
   * That refusal is how its tracker learns of a holding present at start-up, read from the portfolio after it and sold at the next SELL
   * signal (see PositionTracker), and how an account that can neither buy nor sell trips maxConsecutiveErrors, which stops the bot:
   * skipped, the bot would run on with nothing to trade, every skip after the first logged at debug level.
   *
   * On several pairs a skip teaches the tracker what that refusal would have: the asset free in the portfolio of the hook, when it is
   * enough to sell at the close, is the position (see PositionTracker.adoptHolding), said at info level, and the strategy sells it at its
   * next SELL signal. Skipped without a word of it, a holding present at start-up was never sold: after a restart long on every pair
   * with little currency left, every BUY was skipped, the strategy stayed flat beside the holdings, ignoring its SELL signals, and the
   * warning advised to fund the account.
   *
   * Any other skip is said through the strategy's log: at warn level for the first skip of a pair, then at debug level for its next
   * skips, until a BUY of that pair is placed. A strategy whose signal holds over many candles (TMA, EMARibbon) asks for its BUY again on
   * each, and the same warning would come on every candle until the currency or the pairs watched changed.
   */
  private isSkipped(
    tracker: PositionTracker,
    order: BuyOrder,
    allocation: number | undefined,
    { currency, read, held, budget }: BuyEstimate,
    { candle, portfolio, tools }: OrderParams,
  ): boolean {
    const { symbol, type } = order;
    const [asset] = symbol.split('/');
    const marketData = tools.marketData.get(symbol);
    const close = candle.get(symbol)?.close;
    const refusal = getBuyRefusal(order, budget, close, marketData);
    if (refusal === undefined) return false;

    const share = describeShare(allocation, read.free, held, currency);
    const assetFree = portfolio.get(asset)?.free;
    if (assetFree !== undefined && isFinitePositive(close) && tracker.adoptHolding(assetFree, close, type, marketData)) {
      const holding = `${formatEveryDecimal(assetFree)} ${asset} is free in the portfolio, enough to sell`;
      tools.log('info', `[${symbol}] BUY skipped: ${share}, ${refusal}, but ${holding}: the strategy is long`);
      return true;
    }
    const remedy = allocation === undefined ? 'fund the account' : 'watch fewer pairs or fund the account';
    const line = `[${symbol}] BUY skipped: ${share}, ${refusal}: ${remedy}`;
    if (this.warnedSkips.has(symbol)) {
      tools.log('debug', line);
      return true;
    }
    this.warnedSkips.add(symbol);
    tools.log('warn', `${line}; the next skips of this pair are logged at debug level until a BUY of it is placed`);
    return true;
  }
}
