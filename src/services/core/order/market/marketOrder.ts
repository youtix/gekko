import { describeError, toError } from '@errors/error.utils';
import { OrderOutOfRangeError } from '@errors/orderOutOfRange.error';
import { OrderSide, OrderState } from '@models/order.types';
import { TradingPair } from '@models/utility.types';
import { config } from '@services/configuration/configuration';
import { InvalidOrder, OrderNotFound } from '@services/exchange/exchange.error';
import { debug, error, warning } from '@services/logger';
import { bindAll } from 'lodash-es';
import { UUID } from 'node:crypto';
import { Order } from '../order';

// Nobody awaits launch(), cancel() or checkOrder() (the Trader floats them, an interval runs checkOrder), so a handler reports a
// failure through orderErrored and never throws: a thrown error would be an unhandled rejection.
// One exchange call at a time: a cancelation sent twice in parallel would be answered OrderNotFound the second time, an order
// the exchange no longer knows.
export class MarketOrder extends Order {
  // A poll or a cancelation of the order is in flight: neither another poll nor a cancelation is sent until it has answered
  private isChecking: boolean;
  // The cancelation was asked and the order has not ended yet: it is sent as soon as the order has an id and no other call is in
  // flight, then again at each check, until the order ends (see cancel)
  private isCanceling: boolean;

  constructor(symbol: TradingPair, gekkoOrderId: UUID, side: OrderSide, amount: number, _price?: number) {
    super(symbol, gekkoOrderId, side, 'MARKET', amount);
    this.isChecking = false;
    this.isCanceling = false;

    bindAll(this, [this.checkOrder.name]);
  }

  public async launch(): Promise<void> {
    await this.createMarketOrder(this.side, this.amount);

    // A cancelation asked during the creation is sent now that the order has an id, rather than at the next check (there is none in
    // backtest, nor for an order executed at its creation)
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
    // an order already over, it is answered OrderNotFound, and the order is read back (see handleCancelOrderError).
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
    this.applyOrderUpdate(order);
    if (this.getStatus() !== 'open') return;

    // A market order is executed at its creation, in full or as far as the book allows, the rest expiring (canceled), and the
    // simulated exchange of a backtest always executes it in full. One still open is unexpected: the exchange has not matched it, or
    // not reported its fill, yet, or answered a status Gekko does not know (see processStatus). In realtime it is polled until it
    // ends, as a limit order is: the strategy waits for its end, and a cancelation that failed on the network is sent again. That is
    // the only interval of a market order.
    warning('order', `[${this.gekkoOrderId}] ${this.side} ${this.type} order still open after its creation, unexpected for a market order`);
    if (this.mode === 'realtime') this.interval = setInterval(this.checkOrder, config.getExchange().orderSynchInterval);
  }

  protected handleCreateOrderError(error: unknown) {
    // Both exchanges throw OrderOutOfRangeError, before sending the order, for an amount, price or cost that is invalid or out of the
    // market limits, and InvalidOrder when they refuse it otherwise (the simulated exchange: unknown pair, no ticker, insufficient
    // balance; a real exchange: what ccxt reports as InvalidOrder, InsufficientFunds or BadRequest). Both mean the order is refused,
    // not that it failed.
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
