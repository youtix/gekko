import { describeError, toError } from '@gekko/shared/errors/error.helper';
import { OrderOutOfRangeError } from '@gekko/shared/errors/orderOutOfRange.error';
import { OrderSide, OrderState } from '@gekko/shared/models/order.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { InvalidOrder, OrderNotFound } from '../../../exchange/exchange.error';
import { debug, error } from '../../../logger/logger';
import type { RunContext } from '../../../run/runContext.types';
import { bindAll } from 'lodash-es';
import { UUID } from 'node:crypto';
import { Order } from '../order';

/**
 * An order at the price the strategy asked for. Receives its pair, its id, its side, its amount and its price, then the context of
 * its run (see Order): in realtime it is polled every orderSynchInterval from its creation, in a backtest the simulator settles it.
 * Nobody awaits launch(), cancel() or checkOrder() (the Trader floats them, an interval runs checkOrder), so a handler reports a
 * failure through orderErrored and never throws: a thrown error would be an unhandled rejection.
 * One exchange call at a time: a cancelation sent twice in parallel would be answered OrderNotFound the second time, an order the
 * exchange no longer knows.
 */
export class LimitOrder extends Order {
  private readonly price: number;
  // A poll or a cancelation of the order is in flight: neither another poll nor a cancelation is sent until it has answered
  private isChecking: boolean;
  // The cancelation was asked and the order has not ended yet: it is sent as soon as the order has an id and no other call is in
  // flight, then again at each check, until the order ends (see cancel)
  private isCanceling: boolean;

  constructor(symbol: TradingPair, gekkoOrderId: UUID, side: OrderSide, amount: number, price: number, context: RunContext) {
    super(symbol, gekkoOrderId, side, 'LIMIT', amount, context);
    this.price = price;
    this.isChecking = false;
    this.isCanceling = false;

    bindAll(this, [this.checkOrder.name]);

    if (this.mode === 'realtime') this.interval = setInterval(this.checkOrder, this.orderSynchInterval);
  }

  public async launch(): Promise<void> {
    // Nothing polls the order in backtest: the simulated exchange reports its fill through the callback
    const onSettled = this.mode === 'backtest' ? (order: OrderState) => this.applyOrderUpdate(order) : undefined;
    await this.createLimitOrder(this.side, this.amount, this.price, onSettled);

    // A cancelation asked during the creation is sent now that the order has an id, rather than at the next check (there is none in
    // backtest)
    if (this.isCanceling && !this.isOrderCompleted()) await this.cancel();
  }

  public async cancel() {
    if (this.isOrderCompleted()) {
      clearInterval(this.interval);
      return;
    }

    this.isCanceling = true;
    // Asked during the creation or a poll, the cancelation is sent once it has answered (see launch and checkOrder)
    if (!this.id || this.getStatus() === 'initializing' || this.isChecking) return;

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
      if (this.isOrderCompleted()) clearInterval(this.interval);
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

      // A cancelation asked during the poll is sent now, rather than at the next check
      if (this.isCanceling && !this.isOrderCompleted()) await this.cancel();
    } catch (err) {
      error('order', `[${this.gekkoOrderId}] ${this.side} ${this.type} order check failed: ${describeError(err)}`);
    }
  }

  protected handleCreateOrderSuccess(order: OrderState) {
    return this.applyOrderUpdate(order);
  }

  protected handleCreateOrderError(error: unknown) {
    if (error instanceof InvalidOrder || error instanceof OrderOutOfRangeError) return this.orderRejected(describeError(error));

    this.orderErroredAtCreation(error);
  }

  protected handleCancelOrderSuccess(order: OrderState) {
    return this.applyOrderUpdate(order);
  }

  protected handleCancelOrderError(error: unknown) {
    if (this.isTransientFailure(error, 'cancelation')) return;

    // A real exchange answers OrderNotFound for an order it no longer knows: executed, or already canceled (by a cancelation sent
    // before, by the exchange itself, or expired). Which one is read back: the poll handlers apply the state found, and a read-back
    // that fails for good ends the order in error.
    if (error instanceof OrderNotFound && this.id) return this.fetchOrder(this.id);

    this.orderErrored(toError(error));
  }

  protected handleFetchOrderSuccess(order: OrderState) {
    return this.applyOrderUpdate(order);
  }

  protected handleFetchOrderError(error: unknown) {
    if (this.isTransientFailure(error, 'poll')) return;

    this.orderErrored(toError(error));
  }
}
