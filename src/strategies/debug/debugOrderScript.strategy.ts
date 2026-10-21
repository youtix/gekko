import {
  OnCandleEventParams,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Strategy,
} from '@strategies/strategy.types';
import { toISOString } from '@utils/date/date.utils';
import { isNil } from 'lodash-es';
import { UUID } from 'node:crypto';
import { debugOrderScriptStrategySchema } from './debugOrderScript.schema';
import { DebugOrderScriptParams } from './debugOrderScript.types';

/**
 * Debug strategy used in the live trader e2e flow, which reads its lines, so be careful when modifying it. On the candles its block
 * lists, counted from 0 for the first candle after the warmup, it creates an order on the first watched pair, of the side, the type,
 * the amount (1 by default) and the price the block gives it, and cancels it `cancelAfter` candles later unless it has ended by then.
 * It logs at info each order it creates or cancels and what each order hook receives, under the number of the order in the block
 * (from 0), so that a flow can tell what reached the strategy. It tracks no position.
 */
export class DebugOrderScript implements Strategy<DebugOrderScriptParams> {
  static schema = debugOrderScriptStrategySchema;
  private index = 0;
  /**
   * The orders created, by id, until each ends: its number in the block, and the candle that cancels it when the block gives it a
   * cancelAfter, until it is canceled
   */
  private readonly orders = new Map<UUID, { number: number; cancelAt?: number }>();

  onTimeframeCandleAfterWarmup({ candle, tools }: OnCandleEventParams<DebugOrderScriptParams>, ..._indicators: unknown[]): void {
    const { strategyParams, log, createOrder, cancelOrder } = tools;

    for (const [id, order] of this.orders) {
      if (isNil(order.cancelAt) || this.index < order.cancelAt) continue;
      log('info', `Order ${order.number} canceled by the strategy on candle ${this.index}`);
      cancelOrder(id);
      delete order.cancelAt;
    }

    const symbol = candle.keys().next().value!;
    strategyParams.orders.forEach(({ candle: at, side, type, amount, price, cancelAfter }, number) => {
      if (at !== this.index) return;
      const id = createOrder({ symbol, side, type, amount, ...(!isNil(price) && { price }) });
      this.orders.set(id, isNil(cancelAfter) ? { number } : { number, cancelAt: this.index + cancelAfter });
      const atPrice = isNil(price) ? '' : ` at ${price}`;
      log('info', `Order ${number} created on candle ${this.index}: ${side} ${type} of ${amount} on ${symbol}${atPrice}`);
    });

    this.index++;
  }

  onOrderCompleted({ order, tools }: OnOrderCompletedEventParams<DebugOrderScriptParams>, ..._indicators: unknown[]): void {
    const { id, amount, price, fee, feePercent, effectivePrice, orderExecutionDate } = order;
    const figures = `${amount} at ${price}, fee ${fee} (${feePercent} %), effective price ${effectivePrice}`;
    tools.log('info', `Order ${this.releaseOrder(id)} completed: ${figures}, executed at ${toISOString(orderExecutionDate)}`);
  }

  onOrderCanceled({ order, tools }: OnOrderCanceledEventParams<DebugOrderScriptParams>, ..._indicators: unknown[]): void {
    const { id, filled, remaining } = order;
    // Both are left out when no answer of the exchange reported a fill: unknown, not 0
    const fill = isNil(filled) ? 'no fill reported' : `filled ${filled}, remaining ${remaining}`;
    tools.log('info', `Order ${this.releaseOrder(id)} canceled: ${fill}`);
  }

  onOrderErrored({ order, tools }: OnOrderErroredEventParams<DebugOrderScriptParams>, ..._indicators: unknown[]): void {
    const { id, filled, mayBeLive, reason } = order;
    const live = mayBeLive ? 'may be live on the exchange' : 'not live on the exchange';
    tools.log('info', `Order ${this.releaseOrder(id)} errored: filled ${filled}, ${live}: ${reason}`);
  }

  /**
   * The number of an order that has ended, which is canceled no more: `unknown` for an order the strategy did not create. Not named
   * end, which is the hook the StrategyManager calls at the end of the run.
   */
  private releaseOrder(id: UUID) {
    const order = this.orders.get(id);
    this.orders.delete(id);
    return order?.number ?? 'unknown';
  }
}
