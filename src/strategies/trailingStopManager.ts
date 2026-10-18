import { TRAILING_STOP_ACTIVATED, TRAILING_STOP_TRIGGERED } from '@constants/event.const';
import { Candle } from '@models/candle.types';
import { CandleBucket } from '@models/event.types';
import { info, warning } from '@services/logger';
import { addPrecise } from '@utils/math/math.utils';
import { isNil } from 'lodash-es';
import { UUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyState } from './trailingStopManager.helper';
import { AddOrderParams, TrailingStopState, TriggerHold } from './trailingStopManager.types';

export class TrailingStopManager extends EventEmitter {
  private orders = new Map<UUID, TrailingStopState>();
  /** Asked before a stop triggers (see TriggerHold): nothing is held back by default */
  private readonly isTriggerHeld: TriggerHold;

  constructor(isTriggerHeld: TriggerHold = () => false) {
    super();
    this.isTriggerHeld = isTriggerHeld;
  }

  public addOrder({ id, symbol, amount, trailing, createdAt }: AddOrderParams): void {
    if (!trailing) return;
    if (!Number.isFinite(amount) || amount <= 0) {
      warning('trailing stop', `Cannot create trailing stop without a valid amount, current order amount: ${amount}`);
      return;
    }
    // Checked for what it must be rather than against what it must not be: NaN, or a percentage left undefined (a strategy parameter
    // misspelt), failed both comparisons and passed, arming a stop whose price was NaN, which never triggered.
    if (!(trailing.percentage > 0 && trailing.percentage < 100)) {
      warning('trailing stop', `Invalid trailing percentage: ${trailing.percentage}%. Must be between 0 and 100 exclusive.`);
      return;
    }
    // Leaving the trigger out asks for a stop active at once. A trigger given must be a price: 0 and NaN, falsy, passed as if left
    // out, and Infinity armed a stop that never activated.
    if (!isNil(trailing.trigger) && !(Number.isFinite(trailing.trigger) && trailing.trigger > 0)) {
      warning('trailing stop', `Invalid trigger price: ${trailing.trigger}. Must be positive.`);
      return;
    }

    const activationPrice = trailing.trigger;
    const isDirectlyActive = isNil(activationPrice);
    const order: TrailingStopState = {
      id,
      symbol,
      amount,
      // Copied: kept by reference, the strategy's object moved the stop whenever the strategy changed it after the checks above, and a
      // percentage of 150 or NaN made a stop price that never triggered
      config: { ...trailing },
      status: isDirectlyActive ? 'active' : 'dormant',
      highestPeak: 0,
      stopPrice: 0,
      activationPrice,
      createdAt,
    };
    this.orders.set(id, order);

    // Without a trigger the stop is active as soon as it is armed: its activation is announced now, as a stop with a trigger has its
    // own when the price reaches it (see processDormant), else the strategy never hears of it. It trails from the next candle on, from
    // that candle's open: its peak and stop price are still 0.
    if (isDirectlyActive) this.emit<TrailingStopState>(TRAILING_STOP_ACTIVATED, copyState(order));
  }

  public update(bucket: CandleBucket): void {
    for (const order of this.orders.values()) {
      const candle = bucket.get(order.symbol);
      if (!candle) continue;

      if (order.status === 'dormant') this.processDormant(order, candle);
      else if (order.status === 'active') this.trail(order, [candle.open, candle.low, candle.high, candle.close]);
      // A stop selling trails no more: its SELL is sent, and how that SELL ends decides what follows (see resumeSellingStop)
    }
  }

  public removeOrder(id: UUID): boolean {
    return this.orders.delete(id);
  }

  /**
   * Records the SELL sent for the stop `id`, which triggered (see trail): the stop sells until that SELL ends. Returns a copy of the
   * stop, or undefined when it is not selling (removed since its trigger).
   */
  public setSellOrderId(id: UUID, sellOrderId: UUID): TrailingStopState | undefined {
    const order = this.orders.get(id);
    if (order?.status !== 'selling') return;
    order.sellOrderId = sellOrderId;
    return copyState(order);
  }

  /**
   * Removes the stop whose SELL completed, nothing being left to protect: that SELL sold all the stop sells, or left a rest too little
   * to sell, or a portfolio with too little of the asset free (see StrategyManager.settleCompletedStopSell). Returns whether a stop was
   * selling through that SELL.
   */
  public removeSellingStop(sellOrderId: UUID): boolean {
    const order = this.findSellingStop(sellOrderId);
    return order ? this.orders.delete(order.id) : false;
  }

  /**
   * Makes the stop whose SELL sold less than the stop sells (completed for less, errored, canceled) active again, for its amount less
   * what that SELL sold (`sold`), with the peak and the stop price it triggered at: the first price at or below that stop price
   * triggers it again, the open of the next candle included. Removed at its trigger, a stop whose SELL failed (refused, an exchange
   * error) left the position held without any stop, and the strategy could not arm another one: only a BUY carries a trailing. A stop
   * with nothing left to sell is removed. Returns a copy of the stop active again, or undefined: no stop sells through that SELL
   * (removed while it sold), or nothing is left.
   */
  public resumeSellingStop(sellOrderId: UUID, sold: number): TrailingStopState | undefined {
    const order = this.findSellingStop(sellOrderId);
    if (!order) return;
    const left = sold > 0 ? addPrecise(order.amount, -sold) : order.amount;
    if (!(left > 0)) {
      this.orders.delete(order.id);
      info('trailing stop', `Trailing stop of BUY ${order.id} over: its SELL ${sellOrderId} sold ${sold}, all of its ${order.amount}`);
      return;
    }
    order.status = 'active';
    order.amount = left;
    delete order.sellOrderId;
    return copyState(order);
  }

  public getOrders(): ReadonlyMap<UUID, TrailingStopState> {
    return this.orders;
  }

  private processDormant(order: TrailingStopState, { open, high, low, close }: Candle): void {
    // Only a stop with a trigger is dormant: armed without one, a stop is active at once
    const trigger = order.activationPrice ?? 0;
    if (high < trigger) return;

    order.status = 'active';
    // Reached at the open, the trigger activated the stop before the rest of the candle, which the stop then trails. Reached later, it
    // may have been reached after the low: the stop takes the high as its peak and only meets the close, which comes after the high.
    // Trailed whole, that candle triggered the stop whenever it had opened the trailing percentage below its high, even when it closed
    // at its high.
    const isActiveAtOpen = open >= trigger;
    this.raisePeak(order, isActiveAtOpen ? open : high);
    this.emit<TrailingStopState>(TRAILING_STOP_ACTIVATED, copyState(order));
    // The strategy hears of the activation at once, and may cancel the stop then (tools.cancelTrailingOrder): a stop no longer listed
    // is over, and must not send the SELL of a stop the strategy has just canceled
    if (this.orders.has(order.id)) this.trail(order, isActiveAtOpen ? [low, high, close] : [close]);
  }

  /**
   * Meets prices of a candle in the order they traded, testing each against the stop price before it raises the peak. The open comes
   * first and the close last; the order of the low and the high is unknown, and the low is met first: the stop only triggers on a price
   * the candle reached after the peak it trails. Raised to the high before the low was tested, the peak made a candle that rose more
   * than the trailing percentage from its open trigger the stop on its own low.
   */
  private trail(order: TrailingStopState, prices: number[]): void {
    for (const price of prices) {
      if (price <= order.stopPrice) {
        // Held back, the stop meets the rest of the candle as if that price had not reached it: below its peak, it raises nothing
        if (this.isTriggerHeld(copyState(order), price)) continue;
        // Kept, selling, until its SELL ends (see setSellOrderId and resumeSellingStop): deleted here, the stop was gone before its
        // SELL went through, or did not
        order.status = 'selling';
        this.emit<TrailingStopState>(TRAILING_STOP_TRIGGERED, copyState(order));
        return;
      }
      this.raisePeak(order, price);
    }
  }

  private raisePeak(order: TrailingStopState, price: number): void {
    order.highestPeak = Math.max(order.highestPeak, price);
    order.stopPrice = order.highestPeak * (1 - order.config.percentage / 100);
  }

  /** The stop selling through the SELL `sellOrderId`, if any */
  private findSellingStop(sellOrderId: UUID): TrailingStopState | undefined {
    for (const order of this.orders.values()) if (order.status === 'selling' && order.sellOrderId === sellOrderId) return order;
  }
}
