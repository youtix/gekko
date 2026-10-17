import { DEFAULT_FEE_BUFFER } from '@constants/order.const';
import { GekkoError } from '@errors/gekko.error';
import { StrategyOrder } from '@models/advice.types';
import { TradingPair } from '@models/utility.types';
import { getAllocatedShare } from '@plugins/trader/trader.utils';
import { toBound } from '@utils/market/market.utils';
import { addPrecise, multiplyPrecise } from '@utils/math/math.utils';
import { round, shiftDecimalPoint } from '@utils/math/round.utils';
import { formatEveryDecimal } from '@utils/string/string.utils';
import { UUID } from 'node:crypto';
import { PositionTracker } from './positionTracker';
import {
  InitParams,
  OnCandleEventParams,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Tools,
} from './strategy.types';

/** The decimals the share of the currency a BUY is allocated, in percent, is rounded down to (see PositionBook.buy) */
const SHARE_DECIMALS = 6;
/** What a BUY sized from a budget costs of it before the amount step, the rest kept back for its fee (DEFAULT_FEE_BUFFER), in decimal */
const BUY_COST_SHARE = addPrecise(1, -DEFAULT_FEE_BUFFER);
/** The share DEFAULT_FEE_BUFFER keeps back for the fee, in %, as the lines of the Trader write it */
const FEE_BUFFER_PERCENT = shiftDecimalPoint(DEFAULT_FEE_BUFFER, 2);

/** A BUY as the book places it: the book sizes it, so it holds its pair, its type, and a price and a stop if any */
type BuyOrder = Omit<StrategyOrder, 'side' | 'amount' | 'cost' | 'allocation'>;
/** A SELL as the book places it, of all the asset free: its pair, its type, and a price if any */
type SellOrder = Omit<StrategyOrder, 'side' | 'trailing' | 'amount' | 'cost' | 'allocation'>;
/** What track reads of the params of init: the bucket, whose pairs it tracks, and the log */
type TrackParams = Pick<InitParams<unknown>, 'candle'> & { tools: Pick<Tools<unknown>, 'log'> };
/** What buy and sell read of the params of the candle hook that calls them: the portfolio as of the candle, and the tools */
type OrderParams = Pick<OnCandleEventParams<unknown>, 'portfolio'> & {
  tools: Pick<Tools<unknown>, 'createOrder' | 'log' | 'marketData'>;
};

/** Two pairs or more as a line lists them, 'BTC/USDT and ETH/USDT', 'BTC/USDT, ETH/USDT and SOL/USDT', and one pair as it is */
const listPairs = (pairs: readonly TradingPair[]) => (pairs.length > 1 ? `${pairs.slice(0, -1).join(', ')} and ${pairs.at(-1)}` : pairs[0]);

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
    this.trackedPairs = Object.freeze([...candle.keys()]);
    for (const pair of this.trackedPairs) this.trackers.set(pair, new PositionTracker());
    if (this.trackedPairs.length < 2) return;
    const rule = 'each BUY takes an equal share of the free currency among the pairs not invested, each SELL sells all of its asset';
    tools.log('info', `Trading ${listPairs(this.trackedPairs)}: ${rule}`);
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
   * undefined when the BUY is skipped, which a book of several pairs alone does (see isSkipped): nothing sent, nothing pending. `params`
   * are those of the candle hook it is called from, whole. A pair not tracked throws a GekkoError: the bot stops.
   *
   * It takes an equal share of the free currency among the n pairs not invested, sent as its allocation, 100 / n %, rounded down to
   * SHARE_DECIMALS decimals, which the Trader sizes from the currency free at its last synchronization:
   * - n counts every pair that is not long, flat with nothing pending or flat with a BUY pending, the pair asking among them (it buys
   *   once canBuy allows it, and counts even when long): n is 1 at least. A pair whose BUY is pending counts: two signals on one candle
   *   are both sized by the Trader from the same balance read, the second placed before any synchronization. Left out, the second would
   *   ask more than an equal share of that balance (all of it, on two pairs), which the Trader caps at what the first leaves, with a
   *   warning. Counted, the shares of one candle are exact. When a synchronization reads the balance after a pending BUY took its share
   *   (a STICKY order resting past a periodic read), the shares after it are smaller than equal, and the difference stays in the
   *   currency, for the last pair to buy. A pair whose SELL is pending is long: what that SELL brings in is the currency's once it fills.
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
    if (this.isSkipped(order.symbol, allocation, params)) return;
    this.warnedSkips.delete(order.symbol);
    return tracker.buy(params.tools.createOrder, allocation === undefined ? order : { ...order, allocation });
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
   * Settles an order that completed, on the tracker of its pair (see PositionTracker.onOrderCompleted); returns whether it was an order
   * of that tracker's own, false for an order of a pair not tracked
   */
  onOrderCompleted(params: OnOrderCompletedEventParams<unknown>): boolean {
    return this.trackers.get(params.order.symbol)?.onOrderCompleted(params) ?? false;
  }

  /**
   * Settles an order that was canceled, on the tracker of its pair (see PositionTracker.onOrderCanceled); returns whether it was an order
   * of that tracker's own, false for an order of a pair not tracked
   */
  onOrderCanceled(params: OnOrderCanceledEventParams<unknown>): boolean {
    return this.trackers.get(params.order.symbol)?.onOrderCanceled(params) ?? false;
  }

  /**
   * Settles an order that errored, on the tracker of its pair (see PositionTracker.onOrderErrored); returns whether it was an order of
   * that tracker's own, false for an order of a pair not tracked
   */
  onOrderErrored(params: OnOrderErroredEventParams<unknown>): boolean {
    return this.trackers.get(params.order.symbol)?.onOrderErrored(params) ?? false;
  }

  /** The tracker of `symbol`, to `action` (as the refusal names it): a pair not tracked throws a GekkoError */
  private getTracker(symbol: TradingPair, action: string): PositionTracker {
    const tracker = this.trackers.get(symbol);
    if (tracker) return tracker;
    const tracked = this.pairs.length > 0 ? listPairs(this.pairs) : 'no pair until init calls track';
    throw new GekkoError('strategy', `Impossible to ${action} on ${symbol}: the position book does not track it (it tracks ${tracked})`);
  }

  /** The allocation of a BUY of `symbol`, in % (see buy): 100 / n rounded down, n the pairs not invested, undefined when n is 1 */
  private getAllocation(symbol: TradingPair): number | undefined {
    const notInvested = [...this.trackers].filter(([pair, tracker]) => pair === symbol || !tracker.isLong).length;
    return notInvested > 1 ? round(100 / notInvested, SHARE_DECIMALS, 'down') : undefined;
  }

  /**
   * Whether the BUY of `symbol`, allocated `allocation` % of the free currency (all of it when undefined), is skipped, in a book that
   * tracks several pairs: when its cost, estimated from the portfolio the candle hook got, is below the minimum cost of the market (see
   * toBound). Sent, the exchange refuses it, each refusal counting towards the circuit breaker: a share of too little currency is
   * refused at every signal of its pair, and the refusals stop the bot once maxConsecutiveErrors of them follow one another, though the
   * currency would fund the BUYs of fewer pairs. Every BUY is checked then, that of the last pair not invested, all-in, included. The
   * estimate is the currency free in the portfolio, the share allocated of it (see getAllocatedShare), less the share DEFAULT_FEE_BUFFER
   * keeps back for the fee, all in decimal: the cost of a BUY sized from that budget before the amount step of the market, which can
   * take it lower, the Trader warning of it then. Without the currency in the portfolio (no balance read yet), or without a minimum cost
   * on the market, nothing is skipped: the Trader and the exchange say what they make of the BUY.
   *
   * A book that tracks one pair never skips: its all-in BUY is sent as a single-pair strategy always sent it, and refused when the
   * currency is too little. That refusal is how its tracker learns of a holding present at start-up, read from the portfolio after it
   * and sold at the next SELL signal (see PositionTracker), and how an account that can neither buy nor sell trips maxConsecutiveErrors,
   * which stops the bot. Skipped, the strategy would stay flat beside that holding, never selling it, and the bot would run on with
   * nothing to trade, every skip after the first logged at debug level. On several pairs, a pair whose BUYs are skipped learns of a
   * holding of its asset only once a BUY of it is sent.
   *
   * A skip is said through the strategy's log: at warn level for the first skip of a pair, then at debug level for its next skips,
   * until a BUY of that pair is placed. A strategy whose signal holds over many candles (TMA, EMARibbon) asks for its BUY again on each,
   * and the same warning would come on every candle until the currency or the pairs watched changed.
   */
  private isSkipped(symbol: TradingPair, allocation: number | undefined, { portfolio, tools }: OrderParams): boolean {
    if (this.pairs.length < 2) return false;
    const [, currency] = symbol.split('/');
    const free = portfolio.get(currency)?.free;
    if (free === undefined) return false;
    const minimum = toBound(tools.marketData.get(symbol)?.cost?.min);
    if (minimum === undefined) return false;
    const cost = multiplyPrecise(allocation === undefined ? free : getAllocatedShare(free, allocation), BUY_COST_SHARE);
    if (!(cost < minimum)) return false;

    const share = allocation === undefined ? `all of the ${free} ${currency} free` : `${allocation} % of the ${free} ${currency} free`;
    const remedy = allocation === undefined ? 'fund the account' : 'watch fewer pairs or fund the account';
    const estimate = `${formatEveryDecimal(cost)} ${currency} once ${FEE_BUFFER_PERCENT} % is kept back for the fee`;
    const below = `is below the minimum cost of ${formatEveryDecimal(minimum)} ${currency} of the market`;
    const line = `[${symbol}] BUY skipped: ${share}, ${estimate}, ${below}: ${remedy}`;
    if (this.warnedSkips.has(symbol)) {
      tools.log('debug', line);
      return true;
    }
    this.warnedSkips.add(symbol);
    tools.log('warn', `${line}; the next skips of this pair are logged at debug level until a BUY of it is placed`);
    return true;
  }
}
