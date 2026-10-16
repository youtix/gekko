import { z } from 'zod';

// The strategy counts its candles from 0, the first candle after the warmup, as its siblings' wait does: an index below 0, or with a
// fraction, never matches one and its order is never sent
const candleIndex = z.number().int().nonnegative();
// A union whose options all fail only says "Invalid input": the message says what it expects
const candleIndexes = z.union([candleIndex, z.array(candleIndex)], {
  error: 'Invalid input: expected a candle index (a whole number, 0 for the first candle after the warmup) or a list of them',
});

export const debugBacktestStrategySchema = z.strictObject({
  buyCandleIndex: candleIndexes,
  sellCandleIndex: candleIndexes,
  // A MARKET BUY fills with the candle it is sent with: a LIMIT BUY below the market rests until a candle reaches its price, its cost
  // reserved meanwhile, for a backtest to show what a synchronization reads while an order is open
  /** The price of every BUY, sent as a LIMIT order; left out, the BUYs are MARKET orders */
  buyLimitPrice: z.number().positive().optional(),
});
