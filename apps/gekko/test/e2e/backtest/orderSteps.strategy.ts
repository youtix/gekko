import type { TradingPair } from '@gekko/shared/models/utility.types';
import type { OnCandleEventParams, Strategy } from '@gekko/strategies/strategy.types';
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
      // At most one of the three, which createOrder checks: none, the order is all-in
      amount: z.number().positive().optional(),
      cost: z.number().positive().optional(),
      allocation: z.number().positive().max(100).optional(),
    }),
  ),
});

export type OrderStepsParams = z.infer<typeof orderStepsSchema>;

/**
 * The strategy of the backtest flows that place orders of several pairs on candles of their own, or orders sized several ways on one
 * candle, which DebugBacktest, ordering on every pair at once and every order alike, cannot: on each candle after the warmup, counted
 * from 0, it creates the orders its steps list for that candle, in their order, each on the pair it names and as the step gives it, of
 * an amount, a cost or an allocation, or all-in without any. Loaded through strategyPath, as a strategy file of the user's is, it imports
 * only types from Gekko, and zod.
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
