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
  /** The number of each order in the block, by id, until it ends */
  private readonly numbers = new Map<UUID, number>();
  /** The candle that cancels each order given a cancelAfter, by id, until it ends */
  private readonly cancelAt = new Map<UUID, number>();

  onTimeframeCandleAfterWarmup({ candle, tools }: OnCandleEventParams<DebugOrderScriptParams>, ..._indicators: unknown[]): void {
    const { strategyParams, log, createOrder, cancelOrder } = tools;

    for (const [id, at] of this.cancelAt) {
      if (this.index < at) continue;
      log('info', `Order ${this.numbers.get(id)} canceled by the strategy on candle ${this.index}`);
      cancelOrder(id);
      this.cancelAt.delete(id);
    }

    const symbol = candle.keys().next().value!;
    strategyParams.orders.forEach(({ candle: at, side, type, amount, price, cancelAfter }, number) => {
      if (at !== this.index) return;
      const id = createOrder({ symbol, side, type, amount, ...(!isNil(price) && { price }) });
      this.numbers.set(id, number);
      if (!isNil(cancelAfter)) this.cancelAt.set(id, this.index + cancelAfter);
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
    const number = this.numbers.get(id);
    this.numbers.delete(id);
    this.cancelAt.delete(id);
    return number ?? 'unknown';
  }
}
