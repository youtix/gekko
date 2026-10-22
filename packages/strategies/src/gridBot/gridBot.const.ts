/** Decimals of the amount step of a market that states none (precision.amount): its amounts are rounded down to 1e-8 */
export const DEFAULT_AMOUNT_PRECISION = 8;

/**
 * Decimals of the prices on a market that states no price tick (precision.price), as DEFAULT_AMOUNT_PRECISION for amounts: the strategy
 * warns of it when the grid starts
 */
export const DEFAULT_PRICE_PRECISION = 8;
