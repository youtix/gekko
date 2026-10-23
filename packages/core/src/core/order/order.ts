import {
  ORDER_CANCELED_EVENT,
  ORDER_COMPLETED_EVENT,
  ORDER_ERRORED_EVENT,
  ORDER_INVALID_EVENT,
  ORDER_PARTIALLY_FILLED_EVENT,
  ORDER_STATUS_CHANGED_EVENT,
} from '@gekko/shared/constants/event.const';
import { describeError, toError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { Watch } from '@gekko/schemas/configuration/configuration.types';
import { OrderSide, OrderState, OrderType } from '@gekko/shared/models/order.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { ExchangeNetworkError, OrderOutcomeUnknown } from '../../exchange/exchange.error';
import { Exchange, OrderSettledCallback } from '@gekko/shared/models/exchange.types';
import { debug, error, info, warning } from '../../logger/logger';
import type { RunContext } from '../../run/runContext.types';
import { toISOString } from '@gekko/shared/utils/date/date.utils';
import { addPrecise, isFiniteNumber } from '@gekko/shared/utils/math/math.utils';
import { isNil } from 'lodash-es';
import { UUID } from 'node:crypto';
import EventEmitter from 'node:events';
import { OrderCancelDetails, OrderCancelEventPayload, OrderErrorEventPayload, OrderStatus, OrderSummary, Transaction } from './order.types';
import { createOrderSummary, getWeightedAverage } from './order.helper';

/**
 * An order the Trader places, followed until it ends in one of the terminal events. Built with the context of its run, its last
 * parameter: the order is placed on the exchange of `context.services.exchange()`, settled by the simulator in a backtest and polled
 * in realtime (the mode of `context.configuration.getWatch()`), every orderSynchInterval of `context.configuration.getExchange()`.
 * The order reads them once, as it is built, and keeps no reference to the context.
 */
export abstract class Order extends EventEmitter {
  private status: OrderStatus;
  protected readonly transactions: Map<string, Transaction>;
  protected readonly exchange: Exchange;
  protected readonly type: OrderType;
  protected readonly side: OrderSide;
  protected readonly gekkoOrderId: UUID;
  protected readonly mode: Watch['mode'];
  /** How often the order is polled in realtime: the orderSynchInterval of the exchange section */
  protected readonly orderSynchInterval: number;
  protected readonly symbol: TradingPair;
  /** The amount ordered, in the asset: less what filled, what a canceled order left, and what a STICKY order places again after a move */
  protected readonly amount: number;
  // The id the exchange gave the order, known from its first state (see recordOrderUpdate). A STICKY order places one transaction
  // after the other: the id of the current one.
  protected id?: string;
  // Polls the order in realtime (see the subclasses), until it is over (see setStatus)
  protected interval?: Timer;

  constructor(symbol: TradingPair, gekkoOrderId: UUID, side: OrderSide, type: OrderType, amount: number, context: RunContext) {
    super();
    const { configuration, services } = context;
    this.exchange = services.exchange();
    this.status = 'initializing';
    this.transactions = new Map();
    this.type = type;
    this.side = side;
    this.gekkoOrderId = gekkoOrderId;
    this.mode = configuration.getWatch().mode;
    this.orderSynchInterval = configuration.getExchange().orderSynchInterval;
    this.symbol = symbol;
    this.amount = amount;
  }

  public getGekkoOrderId() {
    return this.gekkoOrderId;
  }

  /**
   * What the order has executed, as far as the exchange reported it: the cumulative fills of its transactions added up in decimal (a
   * STICKY order places one after the other; in binary, 0.02 and 0.07 made 0.09000000000000001). 0 while none is reported, and an
   * exchange may answer an order without its fill (see recordOrderUpdate). The Trader estimates the summary of a fill from it when
   * the exchange cannot give one.
   */
  public getFilledAmount() {
    return Array.from(this.transactions.values()).reduce((total, { filled }) => addPrecise(total, filled ?? 0), 0);
  }

  /**
   * The price of what the order has executed, as far as the exchange reported it: the price it reported for each transaction that
   * filled, weighted by that fill (see getWeightedAverage). A resting limit order fills at its own price, so does each transaction of
   * a STICKY order. Undefined when nothing filled, or when a transaction that filled has no price reported. The Trader estimates the
   * price of a fill from it when the exchange cannot give its trades: a STICKY order was estimated at the last market price, or at the
   * ticker of its creation, whatever its transactions filled at.
   */
  public getAverageFillPrice(): number | undefined {
    const fills = [...this.transactions.values()].filter(({ filled }) => (filled ?? 0) > 0);
    const prices = fills.map(({ price }) => price);
    if (!fills.length || !prices.every(isFiniteNumber)) return undefined;
    const price = getWeightedAverage(
      prices,
      fills.map(({ filled }) => filled ?? 0),
    );
    return isFiniteNumber(price) ? price : undefined;
  }

  /**
   * In backtest nothing polls the order: the simulated exchange settles it when a candle reaches its price, and reports the fill
   * through onSettled. A real exchange ignores it.
   */
  protected async createLimitOrder(side: OrderSide, amount: number, price: number, onSettled?: OrderSettledCallback) {
    try {
      info('order', `[${this.gekkoOrderId}] Creating ${side} limit order with amount: ${amount} and price ${price}`);
      const order = await this.exchange.createLimitOrder(this.symbol, side, amount, price, onSettled);
      await this.handleCreateOrderSuccess(order);
    } catch (error) {
      await this.handleCreateOrderError(error);
    }
  }

  protected async createMarketOrder(side: OrderSide, amount: number) {
    try {
      info('order', `[${this.gekkoOrderId}] Creating ${side} market order with amount: ${amount}`);
      const order = await this.exchange.createMarketOrder(this.symbol, side, amount);
      await this.handleCreateOrderSuccess(order);
    } catch (error) {
      await this.handleCreateOrderError(error);
    }
  }

  /**
   * Sends the cancelation, then hands the answer to handleCancelOrderSuccess, or the failure to handleCancelOrderError. An answer is
   * not the end of the order: the state it carries may be 'canceled', 'closed' (executed in full first), or still 'open', when the
   * exchange has not completed the cancelation yet (see Exchange.cancelOrder). Whether the order has ended is its status
   * (isOrderCompleted), which the handlers set.
   */
  protected async cancelOrder(id: string) {
    try {
      info('order', `[${this.gekkoOrderId}] Canceling ${this.side} ${this.type} order.`);
      const order = await this.exchange.cancelOrder(this.symbol, id);
      await this.handleCancelOrderSuccess(order);
    } catch (error) {
      await this.handleCancelOrderError(error);
    }
  }

  protected async fetchOrder(id: string) {
    try {
      info('order', `[${this.gekkoOrderId}] Fetching ${this.side} ${this.type} order`);
      const order = await this.exchange.fetchOrder(this.symbol, id);
      await this.handleFetchOrderSuccess(order);
    } catch (error) {
      await this.handleFetchOrderError(error);
    }
  }

  protected getStatus() {
    return this.status;
  }

  protected setStatus(status: OrderStatus, reason?: string) {
    this.status = status;
    // An order that is over is polled no more, whichever path ended it
    if (this.isOrderCompleted()) clearInterval(this.interval);
    this.emit(ORDER_STATUS_CHANGED_EVENT, { status, reason });
    if (reason) error('order', `[${this.gekkoOrderId}] ${this.side} ${this.type} order ${status}: ${reason}`);
    else debug('order', `[${this.gekkoOrderId}] ${this.side} ${this.type} order ${status}`);
  }

  protected orderCanceled({ filled, remaining, price, timestamp }: OrderCancelDetails) {
    this.setStatus('canceled');
    this.emit<OrderCancelEventPayload>(ORDER_CANCELED_EVENT, {
      status: this.status,
      ...(!isNil(filled) && { filled }),
      ...(!isNil(remaining) && { remaining }),
      ...(!isNil(price) && { price }),
      timestamp,
    });
  }

  protected orderRejected(reason: string) {
    this.setStatus('rejected', reason);
    // Whether it executed part of what it ordered before: the relaunch of a STICKY order is refused after fills (see StickyOrder)
    this.emit(ORDER_INVALID_EVENT, { status: this.status, filled: this.getFilledAmount() > 0, reason });
  }

  // The cumulative fill of the current transaction has grown (see recordOrderUpdate)
  protected orderPartiallyFilled(filled: number) {
    this.emit(ORDER_PARTIALLY_FILLED_EVENT, filled);
  }

  protected orderFilled() {
    this.setStatus('filled');
    this.emit(ORDER_COMPLETED_EVENT, { status: this.status, filled: true });
  }

  /**
   * Ends the order in error. Nobody awaits launch(), cancel() or checkOrder() (the Trader floats them, an interval runs checkOrder), so
   * an order reports a failure here and never throws: a thrown value that is not an Error is wrapped in one (see toError) rather than
   * dropped, so that the order still ends with ORDER_ERRORED_EVENT. Its reason is the failure as describeError writes it, a GekkoError
   * without its tag: the Trader's error line and the Telegram notification each have a tag of their own, and showed two.
   * `mayBeLive` tells the strategies whether it may still be live on the exchange, where nothing follows it any more, the Trader
   * forgetting an order once it errored: placed again, it may be doubled. GridBot could tell it only from the words of a creation lost on
   * the network, and placed again an order whose poll had failed for good while it was open. By default, whether the current
   * transaction was open as the exchange last reported it, as when a poll, a cancelation or the read-back of one fails for good. A
   * creation that failed says it itself (see orderErroredAtCreation), and a STICKY order whose relaunch failed before it was placed has
   * none open.
   */
  protected orderErrored(error: Error, mayBeLive = this.isTransactionOpen()) {
    const reason = describeError(error);
    this.setStatus('error', reason);
    this.emit<OrderErrorEventPayload>(ORDER_ERRORED_EVENT, { reason, mayBeLive });
  }

  /** Whether the current transaction of the order is open on the exchange, as its last state reported it: placed, and not over */
  private isTransactionOpen() {
    return !!this.id && this.transactions.get(this.id)?.status === 'open';
  }

  /**
   * Whether the order is over. 'error' is final too: an errored order is no longer polled, nor canceled, so that a failure is
   * neither sent again forever nor reported twice.
   */
  protected isOrderCompleted() {
    return ['rejected', 'canceled', 'filled', 'error'].includes(this.getStatus());
  }

  /**
   * Whether a state reported for the order arrives after its end, to be ignored: the simulated exchange settling it in backtest (the
   * onSettled callback of createLimitOrder), or the answer to a call sent before it ended. An order that is over stays so: such a
   * state would bring it back to 'open', or end it a second time (ORDER_COMPLETED_EVENT after ORDER_CANCELED_EVENT or
   * ORDER_ERRORED_EVENT). It is only logged, at debug level.
   */
  protected isLateUpdate({ id, status }: Pick<OrderState, 'id' | 'status'>) {
    if (!this.isOrderCompleted()) return false;
    const update = `transaction ${id} ${status}`;
    debug(
      'order',
      `[${this.gekkoOrderId}] ${this.side} ${this.type} order update ignored (${update}), the order is already ${this.getStatus()}`,
    );
    return true;
  }

  /**
   * Records a state the exchange reported for the order: the answer to its creation, to a poll or to a cancelation, or its settlement
   * by the simulated exchange in backtest. Nothing is recorded, and false returned, for a state without an id, which cannot be
   * followed, or arriving after the end of the order (see isLateUpdate).
   * The transaction keeps the first timestamp known: the trades of the order are fetched from there (createOrderSummary), and a later
   * state may carry the time of its last update, or no time at all, read as now (mapCcxtOrderToOrder): after the fills. Its fill is
   * cumulative: a state that reports none, or less than already recorded (the answer to a cancelation after a poll), leaves it as it
   * is, and it stays undefined until a state reports one, so that a fill never reported is not taken for nothing filled (see
   * getCancelationFill). ORDER_PARTIALLY_FILLED_EVENT is emitted when it grows. Its price is the last one a state reported above 0
   * (see getAverageFillPrice).
   */
  protected recordOrderUpdate(order: OrderState) {
    const { id, status, filled, remaining, price, timestamp } = order;
    if (!id || this.isLateUpdate(order)) return false;

    const details = `filled: ${filled}, remaining: ${remaining}, price: ${price}, at ${toISOString(timestamp)}`;
    debug('order', `[${this.gekkoOrderId}] ${this.side} ${this.type} order update: transaction ${id} ${status}, ${details}`);

    const transaction = this.transactions.get(id);
    const recordedFill = transaction?.filled;
    const reportedFill = isFiniteNumber(filled) ? filled : undefined;
    const isFillGrowing = reportedFill !== undefined && reportedFill > (recordedFill ?? 0);

    this.id = id;
    this.transactions.set(id, {
      id,
      timestamp: transaction?.timestamp ?? timestamp,
      filled: isFillGrowing ? reportedFill : (recordedFill ?? reportedFill),
      price: isFiniteNumber(price) && price > 0 ? price : transaction?.price,
      status,
    });
    if (isFillGrowing) this.orderPartiallyFilled(reportedFill);
    return true;
  }

  /**
   * Applies a state the exchange reported for the order, once recorded (see recordOrderUpdate): executed in full ('closed'), the order
   * is filled; canceled, see handleTransactionCanceled; open, the order is open, which is reported once per transaction. Those are the
   * only statuses a state carries (see processStatus in exchange.helper).
   */
  protected applyOrderUpdate(order: OrderState): void | Promise<void> {
    const previousStatus = this.transactions.get(order.id)?.status;
    if (!this.recordOrderUpdate(order)) return;

    const { status, price, timestamp } = order;
    switch (status) {
      case 'closed':
        return this.orderFilled();
      case 'canceled':
        return this.handleTransactionCanceled({ price, timestamp });
      case 'open':
        if (previousStatus !== 'open') this.setStatus('open');
    }
  }

  /**
   * The transaction reported canceled, its fill recorded: the order is canceled with it, whoever canceled it (the strategy, or the
   * exchange: expired, canceled from its interface...), with what it filled (see getCancelationFill). A STICKY order, which places
   * one transaction after the other, overrides it.
   */
  protected handleTransactionCanceled({ price, timestamp }: Pick<OrderCancelDetails, 'price' | 'timestamp'>): void | Promise<void> {
    this.orderCanceled({ ...this.getCancelationFill(), price, timestamp });
  }

  /**
   * What a canceled order executed: the fill of its transactions as the exchange reported them, the polls and the creation as much
   * as the answer to the cancelation (see recordOrderUpdate), added up over the transactions of a STICKY order, and what was left of
   * its amount, in decimal (2.5 - 2.2 is 0.3). A MARKET or LIMIT order relayed the answer to the cancelation alone, an amount it left
   * out as 0: a fill an earlier poll had reported was lost, and a cancelation answered without its fill read as 0 filled and 0
   * remaining. Neither is given while no state of the order reported a fill: unknown, which 0 would misstate.
   */
  private getCancelationFill(): Pick<OrderCancelDetails, 'filled' | 'remaining'> {
    const isFillReported = [...this.transactions.values()].some(({ filled }) => filled !== undefined);
    if (!isFillReported) return {};
    const filled = this.getFilledAmount();
    return { filled, remaining: Math.max(addPrecise(this.amount, -filled), 0) };
  }

  /**
   * Whether a poll or a cancelation failed in a way that leaves the order as it was. An ExchangeNetworkError is a transport failure
   * (timeout, 5xx, rate limit) that outlived the retries of a read, or hit a cancelation, which is never replayed: it says nothing of
   * the order, which may well be live. It is logged as a warning and the order keeps its status, for the next check to poll, or
   * cancel, again. Any other failure (the exchange no longer knows the order, refuses the credentials...) is final.
   */
  protected isTransientFailure(err: unknown, action: 'poll' | 'cancelation') {
    if (!(err instanceof ExchangeNetworkError)) return false;
    const status = this.getStatus();
    warning(
      'order',
      `[${this.gekkoOrderId}] ${this.side} ${this.type} order ${action} failed on the network, it stays ${status}: ${describeError(err)}`,
    );
    return true;
  }

  /**
   * Ends in error the order whose creation failed without being refused. A creation is sent once and never replayed: after an
   * ExchangeNetworkError its outcome is unknown, and so it is after an OrderOutcomeUnknown, the order created without anything to
   * follow it by. The order may be live on the exchange: strategies place an order again on ORDER_ERRORED_EVENT, and its reason and
   * mayBeLive warn them (see orderErrored). Any other failure is taken for one that placed nothing.
   */
  protected orderErroredAtCreation(err: unknown) {
    if (!(err instanceof ExchangeNetworkError || err instanceof OrderOutcomeUnknown)) return this.orderErrored(toError(err), false);
    const reason = `Outcome unknown: the order may be live on the exchange, check it before placing it again (${describeError(err)})`;
    this.orderErrored(new Error(reason, { cause: err }), true);
  }

  public async createSummary(): Promise<OrderSummary> {
    // An errored order is over too, but what it executed is unknown: there is nothing to summarize
    if (!this.isOrderCompleted() || this.getStatus() === 'error')
      throw new GekkoError('order', `[${this.gekkoOrderId}] ${this.side} ${this.type} order is not completed`);

    return createOrderSummary({
      id: this.gekkoOrderId,
      symbol: this.symbol,
      exchange: this.exchange,
      type: this.type,
      side: this.side,
      transactions: Array.from(this.transactions.values()),
    });
  }

  public abstract cancel(): Promise<void>;
  public abstract checkOrder(): Promise<void>;
  public abstract launch(): Promise<void>;

  protected abstract handleCancelOrderSuccess(order: OrderState): void;
  protected abstract handleCancelOrderError(error: unknown): void;
  protected abstract handleCreateOrderSuccess(order: OrderState): void;
  protected abstract handleCreateOrderError(error: unknown): void;
  protected abstract handleFetchOrderSuccess(order: OrderState): void;
  protected abstract handleFetchOrderError(error: unknown): void;
}
