import type { TradingPair } from '@models/utility.types';
import type { OnCandleEventParams, Strategy } from '@strategies/strategy.types';
import { z } from 'zod';

const orderStepsSchema = z.strictObject({
  steps: z.array(
    z.strictObject({
      /** The candle the order is created on, counted from 0, the first candle after the warmup */
      candle: z.number().int().nonnegative(),
      symbol: z.string(),
      side: z.enum(['BUY', 'SELL']),
      type: z.enum(['MARKET', 'LIMIT', 'STICKY']),
      price: z.number().positive().optional(),
      allocation: z.number().positive().max(100).optional(),
    }),
  ),
});

type OrderStepsParams = z.infer<typeof orderStepsSchema>;

/**
 * The strategy of the backtest flows that place orders of several pairs on candles of their own, which DebugBacktest, ordering on every
 * pair at once, cannot: on each candle after the warmup, counted from 0, it creates the orders its steps list for that candle, each on
 * the pair it names and as the step gives it. Loaded through strategyPath, as a strategy file of the user's is, it imports only types
 * from Gekko, and zod.
 */
export class OrderSteps implements Strategy<OrderStepsParams> {
  static schema = orderStepsSchema;
  private index = 0;

  onTimeframeCandleAfterWarmup({ tools }: OnCandleEventParams<OrderStepsParams>, ..._indicators: unknown[]): void {
    for (const { candle, symbol, ...order } of tools.strategyParams.steps) {
      if (candle === this.index) tools.createOrder({ ...order, symbol: symbol as TradingPair });
    }
    this.index++;
  }
}
