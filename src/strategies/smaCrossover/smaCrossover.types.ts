import { z } from 'zod';
import type { smaCrossoverStrategySchema } from './smaCrossover.schema';

export type SMACrossoverStrategyParams = z.infer<typeof smaCrossoverStrategySchema>;

/**
 * Whether the price of a pair was above its SMA before the candle in progress, and whether it is at that candle: null until it is first
 * off a ready SMA
 */
export type PriceSide = { wasPriceAboveSMA: boolean | null; isPriceAboveSMA: boolean | null };
