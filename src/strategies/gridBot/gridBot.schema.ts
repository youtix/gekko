import { z } from 'zod';
import {
  DEFAULT_ATR_PERIOD,
  DEFAULT_RESET_CONFIRM_CANDLES,
  DEFAULT_RESET_COOLDOWN_CANDLES,
  DEFAULT_RESET_MODE,
  DEFAULT_RETRY_LIMIT,
} from './gridBot.const';

// The strategy block, without name, as the StrategyManager parses it before the strategy is created. It used to reach GridBot
// unchecked: a misspelt buyLevel built a grid of SELLs only, buyLevels: 2.5 placed BUYs off the prices they were sized on, and a
// quoted logarithmic spacingValue ('0.01') was concatenated into a multiplier of 10.01.
export const gridBotStrategySchema = z
  .strictObject({
    /**
     * Number of buy levels below the center price. The lowest must stay above 0: a grid whose lowest BUY would be at or below 0 stops
     * the run, when it starts or is reset, and again around the price a rebalance ended at
     */
    buyLevels: z.int().min(0),
    /** Number of sell levels above the center price */
    sellLevels: z.int().min(0),
    /**
     * How the levels are spaced apart: by spacingValue as it is for percent, fixed and logarithmic, by spacingValue × the ATR of the
     * pair on the last timeframe candle when the grid is built for atr (see spacingValue and atrPeriod)
     */
    spacingType: z.enum(['percent', 'fixed', 'logarithmic', 'atr']),
    /**
     * Distance between adjacent prices of the grid:
     * - percent: a percentage of the center price (1 === 1 %), the same between any two adjacent prices, as fixed spacing is: 10
     *   around 100 puts the prices at 50, 60, … 150, so that 50 to 60 is +20 % and 140 to 150 +7 %
     * - fixed: price units
     * - logarithmic: the ratio between adjacent prices, less 1 (0.01 === each price 1 % above the one below it)
     * - atr: a multiple of the ATR of atrPeriod timeframe candles (1.5 === 1.5 × ATR), a fixed step in price units once the grid is
     *   built: the product rounded to the price tick, and raised to the minimum step at which every level breaks even on the maker
     *   fee, one tick at least, with a warning (see resolveSpacing and getMinimumStep), and one above it checked on the prices as the
     *   orders are placed, raised to a whole number of the tick at the top of the grid while a level loses money there, with a warning
     *   of its own. Resolved again at each reset (see resetMode), from the ATR of the last timeframe candle
     * Checked against the market around the center price: a spacing that rounds two adjacent prices of the grid to the same price tick
     * (the tick at that price, on a market whose tick depends on the price) stops the run, when the grid starts or is reset, before a
     * failed rebalance is placed again and once it is rebalanced, and one under the round-trip fee, two maker fees, is warned of each
     * time the grid starts or is reset.
     */
    spacingValue: z.number().positive(),
    /**
     * Retries of a refused or canceled order before the strategy gives up on it: a grid order is then left out with a warning, the
     * rest of the grid trading on until no level holds an order, and a rebalance stops the run. An order whose outcome is unknown,
     * which may be live on the exchange, is never retried: the run stops once more grid orders than this are in that case. At least
     * 1: the strategy used to raise a 0 to 1 without a word.
     */
    retryOnError: z.int().min(1).default(DEFAULT_RETRY_LIMIT),
    /**
     * Period of the ATR an atr spacing reads, in timeframe candles, at least 1 (the true range of the last candle); read with atr
     * spacing only. The ATR has its first value on the atrPeriod + 1-th timeframe candle, so the first candle after the warmup, which
     * builds the grid, needs a warmup.candleCount of atrPeriod or more: a run whose warmup.candleCount is under atrPeriod stops on that
     * candle, before any order.
     */
    atrPeriod: z.int().min(1).default(DEFAULT_ATR_PERIOD),
    /**
     * When the grid is reset around the price: never ('none': the grid stays in place, and a close out of its range is warned of
     * once), on a close above its highest price ('up'), below its lowest ('down'), or either way ('both'). A reset cancels the grid's
     * orders, then rebalances the free balances and builds a new grid around the price once they have ended, as at the start, which
     * realizes the loss of the breakout (see resetConfirmCandles and resetCooldownCandles). An order whose outcome is unknown, which may
     * be live on the exchange without GridBot tracking it, stops the run where the new grid would be built.
     */
    resetMode: z.enum(['none', 'up', 'down', 'both']).default(DEFAULT_RESET_MODE),
    /**
     * Consecutive timeframe candles closing out of the grid, on a side resetMode arms, before the reset, at least 1: a close back in
     * the range, or out on the other side, starts the count again, so that from 2 on a single close out of the range, a spike, does not
     * reset the grid. The closes of the cooldown are not counted (see resetCooldownCandles). Read with a resetMode other than 'none'
     * only.
     */
    resetConfirmCandles: z.int().min(1).default(DEFAULT_RESET_CONFIRM_CANDLES),
    /**
     * Timeframe candles after a reset's new grid during which a close out of its range is not counted towards another reset, 0 for
     * none: a bound on the resets a trend chains. Read with a resetMode other than 'none' only.
     */
    resetCooldownCandles: z.int().min(0).default(DEFAULT_RESET_COOLDOWN_CANDLES),
  })
  .refine(({ buyLevels, sellLevels }) => buyLevels + sellLevels > 0, {
    message: 'buyLevels and sellLevels cannot both be 0: the grid needs at least one level',
  });
