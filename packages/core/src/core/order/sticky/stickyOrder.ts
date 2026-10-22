import { describeError, toError } from '@gekko/shared/errors/error.helper';
import { OrderOutOfRangeError } from '@gekko/shared/errors/orderOutOfRange.error';
import { OrderSide, OrderState } from '@gekko/shared/models/order.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { config } from '../../../configuration/configuration';
import { InvalidOrder, OrderNotFound } from '../../../exchange/exchange.error';
import { Ticker } from '@gekko/shared/models/exchange.types';
import { debug, error, warning } from '../../../logger/logger';
import { addPrecise } from '@gekko/shared/utils/math/math.utils';
import { bindAll } from 'lodash-es';
import { UUID } from 'node:crypto';
import { Order } from '../order';
import { OrderCancelDetails } from '../order.types';

// One exchange call at a time: a cancelation sent twice in parallel would be answered OrderNotFound the second time, an order the
// exchange no longer knows.
export class StickyOrder extends Order {
  // The cancelation was asked and the order has not ended yet: it is sent as soon as the order has an id and no other call is in
  // flight, then again at each check, until the order ends (see cancel). No move starts meanwhile.
  private isCanceling: boolean;
  // move() is running: the cancelation of the current transaction, then the placing of what is left. Neither the answer to that
  // cancelation nor its read-back prices the order again, which would start a move within the move.
  private isMoving: boolean;
  // A move has sent the cancelation of the current transaction, and nothing says yet whether it went through: its answer is awaited,
  // or it failed on the network, or it was answered OrderNotFound while the transaction read back is still open. The next poll tells:
  // the transaction canceled, the move canceled it; still open, it did not, and the order is priced again, which may move it again.
  private isMoveOutcomeUnknown: boolean;
  // The exchange has accepted the cancelation of the current transaction by a move without completing it yet (answered 'open'): the
  // transaction is still live, until it is seen canceled. The order is polled meanwhile, not priced again: a new move would cancel
  // the transaction a second time.
  private isMovePending: boolean;
  // A poll, which may move the order, or a cancelation is in flight: neither another poll nor a cancelation is sent until it has
  // answered
  private isChecking: boolean;

  constructor(symbol: TradingPair, gekkoOrderId: UUID, action: OrderSide, amount: number, _price?: number) {
    super(symbol, gekkoOrderId, action, 'STICKY', amount);
    const orderSync = config.getExchange().orderSynchInterval;
    this.isCanceling = false;
    this.isMoving = false;
    this.isMoveOutcomeUnknown = false;
    this.isMovePending = false;
    this.isChecking = false;

    bindAll(this, [this.checkOrder.name]);

    if (this.mode === 'realtime') this.interval = setInterval(this.checkOrder, orderSync);
  }

  public async launch(): Promise<void> {
    // The ticker is fetched outside of the order handlers and nobody awaits launch() (the Trader floats it, move() runs from the
    // interval): a failure there must end the order, which would otherwise stay 'initializing' without id, out of reach of a
    // cancel, while its interval runs forever. Nothing is placed then: at the first launch, or at the relaunch of a move, whose
    // cancelation has just succeeded, in which case the reason reports what is already filled (see orderErrored)
    let price: number;
    let amount: number;
    try {
      price = await this.processStickyPrice();
      // What is left, in decimal. In binary, 2.5 - 2.2 was 0.2999999999999998, which the exchange truncates to its step: 0.29 was
      // placed, one step short, and a remainder of exactly the market's minimum was refused, the order then taken for filled without it
      // (see handleCreateOrderError)
      amount = addPrecise(this.amount, -this.getFilledAmount());
    } catch (err) {
      return this.orderErrored(toError(err));
    }

    // Creating initial order. Nothing polls the order in backtest: the simulated exchange reports its fill through the callback
    const onSettled = this.mode === 'backtest' ? (order: OrderState) => this.applyOrderUpdate(order) : undefined;
    await this.createLimitOrder(this.side, amount, price, onSettled);

    // A cancelation asked during the creation is sent now that the order has an id, rather than at the next check (there is none in
    // backtest). During the relaunch of a move, the poll that started it is still in flight: cancel() waits, and checkOrder sends it.
    if (this.isCanceling && !this.isOrderCompleted()) await this.cancel();
  }

  public async cancel() {
    if (this.isOrderCompleted()) return;
    this.isCanceling = true;
    // Asked during the creation, a poll or a move, the cancelation is sent once it has answered (see launch and checkOrder)
    if (!this.id || this.isChecking || this.getStatus() === 'initializing') return;

    this.isChecking = true;
    try {
      await this.cancelOrder(this.id);
    } finally {
      this.isChecking = false;
    }

    // The cancelation is over once the order is. The exchange may have accepted it without completing it yet, the order still open,
    // or it may have failed on the network: the order then stays canceling, and the next check sends the cancelation again. Sent for
    // an order already canceled, it is answered OrderNotFound, and the order is read back (see handleCancelOrderError).
    if (this.isOrderCompleted()) {
      clearInterval(this.interval);
      this.isCanceling = false;
    }
  }

  public async checkOrder() {
    // Run by an interval, which ignores the returned promise: whatever escapes from here would be an unhandled rejection
    try {
      // No check once the order is over, before it has an id, or while a poll, a move or a cancelation is in flight
      if (this.isOrderCompleted() || !this.id || this.getStatus() === 'initializing' || this.isChecking) return;
      debug('order', `[${this.gekkoOrderId}] Starting checking ${this.side} ${this.type} order status`);

      // If canceling execute cancel().
      if (this.isCanceling) return await this.cancel();

      this.isChecking = true;
      try {
        await this.fetchOrder(this.id);
      } finally {
        this.isChecking = false;
      }

      // A cancelation asked during the poll, or during the move it started, is sent now, rather than at the next check
      if (this.isCanceling && !this.isOrderCompleted()) await this.cancel();
    } catch (err) {
      error('order', `[${this.gekkoOrderId}] ${this.side} ${this.type} order check failed: ${describeError(err)}`);
    }
  }

  private async move() {
    debug('order', `[${this.gekkoOrderId}] Starting moving ${this.side} ${this.type} order`);

    // Ignoring move if cancel order has been given during checking
    if (this.isCanceling || !this.id) return;
    this.isMoving = true;
    // Unknown until the exchange answers (see handleCancelOrderSuccess). What is left is placed again only once the transaction is
    // seen canceled (see handleTransactionCanceled): placed beside a transaction still live, it could double the exposure
    this.isMoveOutcomeUnknown = true;
    try {
      await this.cancelOrder(this.id);
    } finally {
      this.isMoving = false;
    }
  }

  // One price.min beyond the best bid (ask), worked out in decimal. In binary, 130.01 + 0.01 was 130.01999999999998: the simulated
  // exchange took the order at that price, so a candle down to 130.02 did not fill it, and the order was moved instead
  private async processStickyPrice() {
    const { bid, ask } = await this.exchange.fetchTicker(this.symbol);
    const marketData = this.exchange.getMarketData(this.symbol);
    const minimalPrice = marketData?.price?.min ?? 0;
    return this.side === 'BUY' ? addPrecise(bid, minimalPrice) : addPrecise(ask, -minimalPrice);
  }

  /**
   * Whether the market has gone past the order, which is then moved. Placed at bid + price.min (ask - price.min for a SELL), the
   * order rests in the book as its best bid (ask): the bid of the ticker is then its own price, and bid + price.min one step beyond
   * it, whatever the market does. Compared with the price of the order, that new price would move it at every poll, only to place
   * it again at the same price: a cancelation and a creation every orderSynchInterval, its priority in the queue lost each time,
   * and the order out of the book in between. So it moves only once it is no longer the best: a higher bid for a BUY, a lower ask
   * for a SELL. A lower bid (higher ask) leaves it where it is. The price compared is the one the exchange reports for the order,
   * rounded to its tick, never a sum computed here. The simulated exchange quotes the close as both bid and ask: a BUY moves once the
   * close is above its price.
   */
  private isOutpriced(price: number, { bid, ask }: Ticker) {
    return this.side === 'BUY' ? bid > price : ask < price;
  }

  private isOrderPartiallyFilled() {
    return !this.isOrderCompleted() && this.getFilledAmount() > 0;
  }

  /**
   * The current transaction reported canceled, in the answer to a cancelation or by a poll, its fill recorded. A move whose
   * cancelation is pending, or of unknown outcome, canceled it: what is left is placed again, at the new price. Unless the cancelation
   * of the order was asked meanwhile, or no move was waiting (the strategy canceled it, or the exchange did: expired, dead man's
   * switch...): the order is then canceled, with what all its transactions filled (see Order.handleTransactionCanceled).
   */
  protected async handleTransactionCanceled(cancelation: Pick<OrderCancelDetails, 'price' | 'timestamp'>) {
    const isCanceledByMove = this.isMovePending || this.isMoveOutcomeUnknown;
    this.endMove();
    if (isCanceledByMove && !this.isCanceling) return this.launch();

    this.isCanceling = false;
    return super.handleTransactionCanceled(cancelation);
  }

  // No move waits any more: what is left is placed again, or the order is over (see orderFilled and orderErrored too). A creation,
  // which may end the order as well, never runs while a move waits: it is the first one, or the relaunch of a move, after this.
  private endMove() {
    this.isMoveOutcomeUnknown = false;
    this.isMovePending = false;
  }

  // Overrided functions
  protected handleCreateOrderSuccess(order: OrderState) {
    return this.applyOrderUpdate(order);
  }

  protected handleCreateOrderError(error: unknown) {
    if (error instanceof OrderOutOfRangeError && this.isOrderPartiallyFilled()) return Promise.resolve(this.orderFilled());

    if (error instanceof InvalidOrder || error instanceof OrderOutOfRangeError)
      return Promise.resolve(this.orderRejected(describeError(error)));

    return Promise.resolve(this.orderErroredAtCreation(error));
  }

  protected handleCancelOrderSuccess(order: OrderState) {
    // The response carries the cumulative fill of the canceled transaction, which a poll may already have recorded on it: it is
    // recorded first (the larger value wins), then the transactions are added up once, so that a partial fill is not counted twice
    if (!this.recordOrderUpdate(order)) return;

    const { status, remaining, price, timestamp } = order;
    if (status === 'closed' || remaining === 0 || this.getFilledAmount() >= this.amount) return this.orderFilled();

    // Accepted, but not completed yet: the transaction is still live, neither canceled nor to be placed again. The order stays
    // canceling, or the move waits for the transaction to be seen canceled (see isMovePending), and the next check carries on.
    if (status !== 'canceled') {
      if (this.isMoving) {
        this.isMoveOutcomeUnknown = false;
        this.isMovePending = true;
      }
      return;
    }
    return this.handleTransactionCanceled({ price, timestamp });
  }

  protected handleCancelOrderError(error: unknown) {
    if (this.isTransientFailure(error, 'cancelation')) return Promise.resolve();

    // A real exchange answers OrderNotFound for an order it no longer knows: executed, or already canceled (by a cancelation sent
    // before, by the exchange itself, or expired). Which one is read back: the poll handlers apply the state found, and a read-back
    // that fails for good ends the order in error.
    if (error instanceof OrderNotFound && this.id) return this.fetchOrder(this.id);

    return Promise.resolve(this.orderErrored(toError(error)));
  }

  protected async handleFetchOrderSuccess(order: OrderState) {
    await this.applyOrderUpdate(order);

    // Only a transaction still open may move. A move or a cancelation in progress sends its own requests: this read, which may be
    // the read-back of one of them, only records the fill
    const { status, price } = order;
    if (status !== 'open' || this.isOrderCompleted() || this.isMoving || this.isCanceling) return;
    // The exchange has accepted the cancelation of the move: the transaction ends canceled, then what is left is placed again
    if (this.isMovePending) {
      return debug('order', `[${this.gekkoOrderId}] ${this.side} ${this.type} order not moved, the cancelation of its move is pending`);
    }
    // Still open: the cancelation of a move whose outcome was unknown did not go through. The order is live, and priced again
    this.isMoveOutcomeUnknown = false;
    // Whether the order moves is decided on the price the exchange reports for it (see isOutpriced): without one, it stays
    if (!price) return debug('order', `[${this.gekkoOrderId}] ${this.side} ${this.type} order not moved, its price is not reported`);
    let ticker: Ticker;
    try {
      ticker = await this.exchange.fetchTicker(this.symbol);
    } catch (err) {
      // The order is live and placed: a ticker out of reach for now, whether the network failed or the data came back incomplete,
      // must not end it. It stays at its price, and the next check prices it again.
      const reason = describeError(err);
      return warning('order', `[${this.gekkoOrderId}] ${this.side} ${this.type} order not moved, its new price is unknown: ${reason}`);
    }
    if (this.isOutpriced(price, ticker)) {
      const market = `bid: ${ticker.bid}, ask: ${ticker.ask}`;
      debug(
        'order',
        `[${this.gekkoOrderId}] Moving ${this.side} ${this.type} order from price ${price}, the market went past it (${market})`,
      );
      await this.move();
    }
  }

  protected handleFetchOrderError(error: unknown) {
    if (this.isTransientFailure(error, 'poll')) return Promise.resolve();

    return Promise.resolve(this.orderErrored(toError(error)));
  }

  // Executed in full, whichever path saw it so (a poll, the answer to a cancelation, the creation): no move waits any more
  protected orderFilled() {
    this.endMove();
    super.orderFilled();
  }

  // 'error' is final: no move waits any more. The reason reports the part already filled, as the polls and the cancelations of the
  // moves saw it: that part is executed.
  protected orderErrored(error: Error, mayBeLive?: boolean) {
    this.endMove();
    const filled = this.getFilledAmount();
    const reported =
      filled > 0 ? new Error(`${describeError(error)} (${filled} of ${this.amount} already filled)`, { cause: error }) : error;
    super.orderErrored(reported, mayBeLive);
  }
}
