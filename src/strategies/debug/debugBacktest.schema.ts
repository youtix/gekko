import { compact } from 'lodash-es';
import { z } from 'zod';

// The strategy counts its candles from 0, the first candle after the warmup, as its siblings' wait does: an index below 0, or with a
// fraction, never matches one and its order is never sent
const candleIndex = z.number().int().nonnegative();
// A union whose options all fail only says "Invalid input": the message says what it expects
const candleIndexes = z.union([candleIndex, z.array(candleIndex)], {
  error: 'Invalid input: expected a candle index (a whole number, 0 for the first candle after the warmup) or a list of them',
});

export const debugBacktestStrategySchema = z
  .strictObject({
    buyCandleIndex: candleIndexes,
    sellCandleIndex: candleIndexes,
    // A MARKET BUY fills with the candle it is sent with: a LIMIT BUY below the market rests until a candle reaches its price, its cost
    // reserved meanwhile, for a backtest or a paper session to show what a synchronization reads while an order is open
    /** The price of every BUY, sent as a LIMIT order; left out, the BUYs are MARKET orders */
    buyLimitPrice: z.number().positive().optional(),
    // Every built-in strategy orders all-in, which an order of 1 never exercised: the Trader sizes such an order from the balance it
    // read last, less what the orders placed since take from it, and caps it at the most the market takes in one order
    /** Every order sent without an amount, all-in, for the Trader to size; left out, every order is of 1 unit */
    allIn: z.boolean().optional(),
    // No built-in strategy orders by cost or by allocation, so no run exercised the Trader's sizing from a budget: the amount worked out
    // at the price of the order, the budget of a BUY capped at what the BUYs placed since the last read leave, the warning of one below
    // the market's minimum cost. Both are bounded as createOrder checks them: out of bounds, createOrder would refuse the first order,
    // and stop the bot, only once the strategy placed it, where the schema refuses the block at start-up.
    /**
     * Every order sent with this cost in currency instead of an amount, for the Trader to size: what a BUY may spend, the 5 % kept back
     * for its fee included, the notional a SELL sells
     */
    cost: z.number().positive().optional(),
    /**
     * Every order sent with this share instead of an amount, in percent (25 for 25 %), for the Trader to size: a share of what its last
     * synchronization read, the currency for a BUY (100 is all-in), the asset for a SELL
     */
    allocation: z.number().positive().max(100).optional(),
  })
  // Each of the three sizes every order its own way: given together, the strategy would follow one and drop the others without a word.
  // allIn: false is none of them, the orders of 1 unit a block without allIn sends.
  .superRefine(({ allIn, cost, allocation }, ctx) => {
    const given = compact([allIn && 'allIn', cost !== undefined && 'cost', allocation !== undefined && 'allocation']);
    if (given.length < 2) return;
    const named = `${given.slice(0, -1).join(', ')} and ${given.at(-1)}`;
    ctx.addIssue({
      code: 'custom',
      path: [given[1]],
      message: `allIn, cost and allocation size the orders three ways: give at most one, got ${named}`,
    });
  });
