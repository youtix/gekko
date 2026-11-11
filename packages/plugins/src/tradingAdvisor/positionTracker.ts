import { StrategyOrder } from '@gekko/shared/models/advice.types';
import { OrderCanceledEvent, OrderCompletedEvent, OrderErroredEvent } from '@gekko/shared/models/event.types';
import { OrderSide, OrderType } from '@gekko/shared/models/order.types';
import { MarketData } from '@gekko/shared/models/exchange.types';
import { isFiniteNumber } from '@gekko/shared/utils/math/math.utils';
import { formatEveryDecimal } from '@gekko/shared/utils/string/string.utils';
import { UUID } from 'node:crypto';
import {
  coversAmountAsked,
  describeUnfinishedEnd,
  getHolding,
  getUnreadHolding,
  isReadBeforeEnd,
  isSellable,
} from './positionTracker.helper';
import { Fill, OrderEnd, PendingOrder, TrackerContext, UnfinishedOrderEnd, UnfinishedOutcome } from './positionTracker.types';

/**
 * The position of a strategy that trades all-in, on one pair: flat or long, and its own orders whose outcome has not come yet. Gekko
 * relays every advice, so a strategy advising on every candle of a trend placed an all-in order sized from what the previous one left,
 * then had it refused until maxConsecutiveErrors stopped the bot: the strategy buys only when flat and sells only when long, never
 * while an order of its own is pending, and this is the bookkeeping that tells it which. It follows one pair: the PositionBook, which
 * the StrategyManager keeps for the strategy (tools.positions), holds one per pair it tracks, and shares the currency among their BUYs.
 *
 * - It starts flat: a holding present at start-up is sold only by its first SELL, which follows a BUY that completed, or one that
 *   ended without completing while the account held it (see settleUnfinished), or, in a PositionBook of several pairs, a BUY the book
 *   skipped while the portfolio showed the holding (see adoptHolding).
 * - A completed BUY makes it long, a completed SELL flat, unless it sold less than it asked for, all of the asset free for an all-in
 *   SELL: the position is then read from the portfolio after it (see settleCompletedSell).
 * - A canceled or errored order may have executed all the same, in part or in full: the position is read from what its event
 *   reports, long when what the order leaves held is enough to sell (see settleUnfinished and getHolding). Nothing reported, it stays
 *   as it was.
 * - The portfolio of an event whose balances the Trader read before the order ended (see isReadBeforeEnd) is not read as the state
 *   after it: the order's own figures settle the position when they can, and otherwise it stays as it was, with a warning (see
 *   settleCompletedSell, settleUnfinished and keepPosition).
 * - The outcome of an order that is not its own changes nothing, and an order counts once: its first outcome settles it.
 *
 * The book places its orders through buy and sell once canBuy or canSell allows the strategy to, and hands it the end of each order as
 * the StrategyManager hears of it, before the strategy's order hook runs: the order, and the exchange event, with the portfolio after
 * the order and whether the Trader read it after the order ended. The market data of its pair and the strategy's log come from the
 * context the book builds it with (see TrackerContext), never from the params of a hook.
 */
export class PositionTracker {
  /** What it reads of the run, from the PositionBook that builds it: createOrder, the strategy's log and the market data */
  private readonly context: TrackerContext;
  private long = false;
  // Not one id per side: the SELL of a trailing stop (adoptSell) can pend beside a SELL of the strategy's own
  private readonly pendingOrders = new Map<UUID, PendingOrder>();

  constructor(context: TrackerContext) {
    this.context = context;
  }

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
  buy(order: Omit<StrategyOrder, 'side'>): UUID {
    const id = this.context.createOrder({ ...order, side: 'BUY' });
    this.pendingOrders.set(id, { side: 'BUY' });
    return id;
  }

  /**
   * Creates the order as a SELL through createOrder and keeps it pending until its outcome, with the amount it asks for, left out
   * for an all-in SELL and for one sized by a cost or an allocation (see coversAmountAsked); returns its id
   */
  sell(order: Omit<StrategyOrder, 'side' | 'trailing'>): UUID {
    const id = this.context.createOrder({ ...order, side: 'SELL' });
    this.pendingOrders.set(id, { side: 'SELL', amount: order.amount });
    return id;
  }

  /**
   * Keeps pending, as sell does, a SELL it did not create itself: the one a trailing stop sends when it triggers, which the PositionBook
   * adopts when the stop's BUY was one of its own (see PositionBook.adoptStopSell), before the strategy's onTrailingStopTriggered runs.
   * Left out, the stop's SELL is not its own and its outcome changes nothing: once the stop has sold everything, the strategy stays long
   * until the SELL it advises next is refused, nothing left to sell. The amount it asks for is not known here: completed, or canceled
   * after a fill, it is read as an all-in SELL is (see coversAmountAsked).
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
  onOrderCompleted(event: OrderEnd<OrderCompletedEvent>): boolean {
    const pending = this.pendingOrders.get(event.order.id);
    if (!pending) return false;
    this.pendingOrders.delete(event.order.id);
    if (pending.side === 'BUY') this.long = true;
    else this.settleCompletedSell(event, pending.amount);
    return true;
  }

  /** Settles its own order that was canceled, after what it filled (see settleUnfinished); returns whether the order was its own */
  onOrderCanceled(event: OrderEnd<OrderCanceledEvent>): boolean {
    const { filled, remaining } = event.order;
    // A cancelation missing either amount reports no fill: the order leaves both out when no answer of the exchange reported one. 0
    // filled and 0 remaining used to mean the same, the order relaying the amounts its last answer left out as 0: it is a fact now.
    const fill = isFiniteNumber(filled) && isFiniteNumber(remaining) ? { filled, remaining } : undefined;
    return this.settleUnfinished('canceled', event, fill);
  }

  /** Settles its own order that errored, after what it executed (see settleUnfinished); returns whether the order was its own */
  onOrderErrored(event: OrderEnd<OrderErroredEvent>): boolean {
    return this.settleUnfinished('errored', event);
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
   * When the Trader read the balances of the event before the order ended (see isReadBeforeEnd), they are not the state after it: the
   * position is read from the order's own figures (see getUnreadHolding), and when those tell nothing, or only a least holding that is
   * too little to sell, it stays as it was, said at warn level (see keepPosition).
   */
  private settleUnfinished(outcome: UnfinishedOutcome, event: UnfinishedOrderEnd, fill?: Fill) {
    const { order, exchange } = event;
    const pending = this.pendingOrders.get(order.id);
    if (!pending) return false;
    this.pendingOrders.delete(order.id);

    const { side } = pending;
    const unread = isReadBeforeEnd(exchange);
    const holding = unread ? getUnreadHolding(outcome, pending, event, fill) : getHolding(pending, event, fill);
    const isLong = !!holding && isSellable(holding.held, exchange.price, order.type, this.context.getMarketData(order.symbol));
    if (!holding || (!isLong && holding.least)) {
      if (unread) this.keepPosition(order.id, side, describeUnfinishedEnd(outcome, event, fill));
      return true;
    }

    if (isLong !== this.long) {
      const [asset] = order.symbol.split('/');
      const position = isLong ? 'enough to sell: the strategy is long' : 'too little to sell: the strategy is flat';
      this.context.log(
        'info',
        `[${order.id}] ${side} order ${outcome}: ${formatEveryDecimal(holding.held)} ${asset} ${holding.fact}, ${position}`,
      );
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
   * free after them is what they left. Read long, the position is logged at info level, through the strategy's log.
   * Unless the Trader read that portfolio before the SELL ended (see isReadBeforeEnd): read before the SELL was placed, it still shows
   * free what the SELL sold, and read while the SELL rested, it shows the order's part as used and the rest of the asset free, and
   * nothing says which. What is left of the asset is then unknown: the position stays as it was, said at warn level (see keepPosition).
   */
  private settleCompletedSell({ order, exchange }: OrderEnd<OrderCompletedEvent>, asked?: number) {
    if (coversAmountAsked(asked, order.amount)) {
      this.long = false;
      return;
    }
    const [asset] = order.symbol.split('/');
    const sold = formatEveryDecimal(order.amount);
    const sale = isFiniteNumber(asked) ? `${sold} of the ${formatEveryDecimal(asked)} ${asset} it asked for` : `${sold} ${asset}`;
    if (isReadBeforeEnd(exchange)) {
      this.keepPosition(order.id, 'SELL', `completed after selling ${sale}`);
      return;
    }
    const free = exchange.portfolio.get(asset)?.free;
    if (free === undefined || !isSellable(free, exchange.price, order.type, this.context.getMarketData(order.symbol))) {
      this.long = false;
      return;
    }
    this.long = true;
    this.context.log(
      'info',
      `[${order.id}] SELL order completed after selling ${sale}: ${formatEveryDecimal(free)} ${asset} free in the portfolio after it, enough to sell: the strategy is long`,
    );
  }

  /**
   * Keeps the position as it was after its own order whose end does not settle it: the Trader read the balances of its event before the
   * order ended (see isReadBeforeEnd), and the order's own figures tell nothing of what is held (see settleCompletedSell and
   * settleUnfinished). Said at warn level, through the strategy's log, with how the order ended (`ended`). The end of its next order
   * reads the position again: kept long after a SELL that sold everything, the strategy sells at its next SELL signal, which the Trader
   * sizes from a later read, and that SELL, refused for lack of anything to sell, reads it flat; kept flat after a BUY that bought, its
   * next BUY makes it long, and its SELL then sells all of the asset. Read as the state after the order, those balances told the position
   * as it was when they were read, whatever the order did: a SELL's asset still free before it was placed, its asset used while it
   * rested, a BUY's coins missing before it filled.
   */
  private keepPosition(id: UUID, side: OrderSide, ended: string) {
    const position = this.long ? 'long' : 'flat';
    this.context.log(
      'warn',
      `[${id}] ${side} order ${ended}, and the Trader could not read the balances after it: the strategy stays ${position} until the end of its next order`,
    );
  }
}
