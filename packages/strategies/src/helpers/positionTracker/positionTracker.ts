import { StrategyOrder } from '@gekko/shared/models/advice.types';
import { OrderType } from '@gekko/shared/models/order.types';
import { MarketData } from '@gekko/shared/models/exchange.types';
import { OnOrderCanceledEventParams, OnOrderCompletedEventParams, OnOrderErroredEventParams, Tools } from '../../strategy.types';
import { isFiniteNumber } from '@gekko/shared/utils/math/math.utils';
import { UUID } from 'node:crypto';
import { coversAmountAsked, getHolding, isSellable } from './positionTracker.helper';
import { Fill, PendingOrder, UnfinishedOrderParams } from './positionTracker.types';

/**
 * The position of a strategy that trades all-in: flat or long, and its own orders whose outcome has not come yet. Gekko relays
 * every advice, so a strategy advising on every candle of a trend placed an all-in order sized from what the previous one left,
 * then had it refused until maxConsecutiveErrors stopped the bot: the strategy buys only when flat and sells only when long, never
 * while an order of its own is pending, and this is the bookkeeping that tells it which. It follows one pair: a strategy that trades
 * several keeps one per pair in a PositionBook, which also shares the currency among their BUYs.
 *
 * - It starts flat: a holding present at start-up is sold only by its first SELL, which follows a BUY that completed, or one that
 *   ended without completing while the account held it (see settleUnfinished), or, in a PositionBook of several pairs, a BUY the book
 *   skipped while the portfolio showed the holding (see adoptHolding).
 * - A completed BUY makes it long, a completed SELL flat, unless it sold less than it asked for, all of the asset free for an all-in
 *   SELL: the position is then read from the portfolio after it (see settleCompletedSell).
 * - A canceled or errored order may have executed all the same, in part or in full: the position is read from what its event
 *   reports, long when what the order leaves held is enough to sell (see settleUnfinished and getHolding). Nothing reported, it stays
 *   as it was.
 * - The outcome of an order that is not its own changes nothing, and an order counts once: its first outcome settles it.
 *
 * The strategy places its orders through buy and sell once canBuy or canSell allows it, and hands the params of its three order
 * hooks over as it gets them, whole: the event, with the portfolio after the order, and the tools, with the market data and the log.
 */
export class PositionTracker {
  private long = false;
  // Not one id per side: the SELL of a trailing stop (adoptSell) can pend beside a SELL of the strategy's own
  private readonly pendingOrders = new Map<UUID, PendingOrder>();

  /** Whether it holds enough to sell, as far as the outcomes of its orders tell */
  get isLong(): boolean {
    return this.long;
  }

  /** Whether an order of its own still waits for its outcome */
  get isPendingOrder(): boolean {
    return this.pendingOrders.size > 0;
  }

  /** Flat, and nothing pending */
  canBuy(): boolean {
    return !this.long && !this.isPendingOrder;
  }

  /** Long, and nothing pending */
  canSell(): boolean {
    return this.long && !this.isPendingOrder;
  }

  /** Creates the order as a BUY through createOrder and keeps it pending until its outcome; returns its id */
  buy(createOrder: Tools<unknown>['createOrder'], order: Omit<StrategyOrder, 'side'>): UUID {
    const id = createOrder({ ...order, side: 'BUY' });
    this.pendingOrders.set(id, { side: 'BUY' });
    return id;
  }

  /**
   * Creates the order as a SELL through createOrder and keeps it pending until its outcome, with the amount it asks for, left out
   * for an all-in SELL and for one sized by a cost or an allocation (see coversAmountAsked); returns its id
   */
  sell(createOrder: Tools<unknown>['createOrder'], order: Omit<StrategyOrder, 'side' | 'trailing'>): UUID {
    const id = createOrder({ ...order, side: 'SELL' });
    this.pendingOrders.set(id, { side: 'SELL', amount: order.amount });
    return id;
  }

  /**
   * Keeps pending, as sell does, a SELL the strategy did not create itself: the one a trailing stop sends when it triggers. A
   * strategy whose BUYs carry a stop adopts it from `onTrailingStopTriggered(orderId, …)`; left out, the stop's SELL is not its own
   * and its outcome changes nothing: once the stop has sold everything, the strategy stays long until the SELL it advises next is
   * refused, nothing left to sell. The amount it asks for is not known here: completed, or canceled after a fill, it is read as an
   * all-in SELL is (see coversAmountAsked).
   */
  adoptSell(orderId: UUID): void {
    this.pendingOrders.set(orderId, { side: 'SELL' });
  }

  /**
   * Takes a holding of its asset that no order of its own brought for the position: long when it is flat with nothing pending and
   * `held` is enough to sell at `price` (see isSellable); returns whether it went long. Long already, or with an order pending, whose
   * outcome tells the position, it takes nothing. A PositionBook of several pairs calls it for a BUY it skips, never sent, the market
   * refusing its share as too small (see PositionBook.buy): sent, that BUY was refused, and its outcome read the position from the
   * portfolio after it (see settleUnfinished), which is how a strategy learnt of a holding present at start-up. Skipped, it taught
   * nothing: after a restart long on every pair with little currency left, every BUY was skipped, the strategy stayed flat beside the
   * holdings and ignored its SELL signals, and nothing was ever sold. The caller says it, through the strategy's log, with the BUY it
   * skipped.
   */
  adoptHolding(held: number, price: number, type: OrderType, marketData?: MarketData): boolean {
    if (!this.canBuy() || !isSellable(held, price, type, marketData)) return false;
    this.long = true;
    return true;
  }

  /**
   * Settles its own order that completed, a fill: a BUY makes it long, a SELL flat unless it sold less than it asked for (see
   * settleCompletedSell); returns whether the order was its own
   */
  onOrderCompleted(params: OnOrderCompletedEventParams<unknown>): boolean {
    const pending = this.pendingOrders.get(params.order.id);
    if (!pending) return false;
    this.pendingOrders.delete(params.order.id);
    if (pending.side === 'BUY') this.long = true;
    else this.settleCompletedSell(params, pending.amount);
    return true;
  }

  /** Settles its own order that was canceled, after what it filled (see settleUnfinished); returns whether the order was its own */
  onOrderCanceled(params: OnOrderCanceledEventParams<unknown>): boolean {
    const { filled, remaining } = params.order;
    // A cancelation missing either amount reports no fill: the order leaves both out when no answer of the exchange reported one. 0
    // filled and 0 remaining used to mean the same, the order relaying the amounts its last answer left out as 0: it is a fact now.
    const fill = isFiniteNumber(filled) && isFiniteNumber(remaining) ? { filled, remaining } : undefined;
    return this.settleUnfinished('canceled', params, fill);
  }

  /** Settles its own order that errored, after what it executed (see settleUnfinished); returns whether the order was its own */
  onOrderErrored(params: OnOrderErroredEventParams<unknown>): boolean {
    return this.settleUnfinished('errored', params);
  }

  /**
   * Settles its own order that ended without completing. Read as "nothing executed", a SELL errored after it had sold everything
   * left the strategy long with nothing to sell, every SELL it advised refused until maxConsecutiveErrors stopped the bot, and a BUY
   * canceled once it had filled 90 % left it flat, holding the coins, its SELL signals ignored. Neither outcome means that nothing
   * executed: a cancelation comes after the fills it reports (expired with what the book allowed, canceled from the exchange's
   * interface), and an error may follow fills (a STICKY order reports what it had already filled) or a creation whose outcome is
   * unknown.
   * So the strategy is long when what the order leaves held of its asset is enough to sell (see getHolding and isSellable), and
   * stays as it was when nothing tells. A position read from the facts that differs from the one held before is logged, at info
   * level, through the strategy's log.
   */
  private settleUnfinished(outcome: 'canceled' | 'errored', params: UnfinishedOrderParams, fill?: Fill) {
    const { order, exchange, tools } = params;
    const pending = this.pendingOrders.get(order.id);
    if (!pending) return false;
    this.pendingOrders.delete(order.id);

    const { side } = pending;
    const holding = getHolding(pending, params, fill);
    if (!holding) return true;

    const isLong = isSellable(holding.held, exchange.price, order.type, tools.marketData.get(order.symbol));
    if (isLong !== this.long) {
      const [asset] = order.symbol.split('/');
      const position = isLong ? 'enough to sell: the strategy is long' : 'too little to sell: the strategy is flat';
      tools.log('info', `[${order.id}] ${side} order ${outcome}: ${holding.held} ${asset} ${holding.fact}, ${position}`);
    }
    this.long = isLong;
    return true;
  }

  /**
   * Settles its own SELL that completed: flat once it sold all it asked for. The Trader caps a SELL to the free balance and to the
   * most the market takes in one order (its maximum amount, that of a market order for a MARKET one): a position above that maximum,
   * bought by a STICKY or a LIMIT BUY, read flat once its first SELL had completed, the rest held while the strategy ignored its SELL
   * signals and followed its BUY signals. A SELL that sold less than it asked for is read from the portfolio after it, as one that was
   * canceled after a fill (see coversAmountAsked and getHolding): long when the asset free there is enough to sell (see isSellable),
   * flat when it is not, or when the portfolio does not list the asset. So is an all-in SELL, which asks for all of the asset free, one
   * sized by a cost or an allocation, whose amount the Trader works out, and an adopted one, whose amount is not known here: what is
   * free after them is what they left. When the Trader could not read the portfolio again after the fill, it is the one known before,
   * which may still show the asset free: read long, the position is settled by the next SELL, refused for lack of anything to sell.
   * Read long, the position is logged at info level, through the strategy's log.
   */
  private settleCompletedSell({ order, exchange, tools }: OnOrderCompletedEventParams<unknown>, asked?: number) {
    this.long = false;
    if (coversAmountAsked(asked, order.amount)) return;
    const [asset] = order.symbol.split('/');
    const free = exchange.portfolio.get(asset)?.free;
    if (free === undefined || !isSellable(free, exchange.price, order.type, tools.marketData.get(order.symbol))) return;
    this.long = true;
    const sale = isFiniteNumber(asked) ? `${order.amount} of the ${asked} ${asset} it asked for` : `${order.amount} ${asset}`;
    tools.log(
      'info',
      `[${order.id}] SELL order completed after selling ${sale}: ${free} ${asset} free in the portfolio after it, enough to sell: the strategy is long`,
    );
  }
}
