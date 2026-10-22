/** Default retryOnError: the retries of a failed order before GridBot gives up on it */
export const DEFAULT_RETRY_LIMIT = 3;

/** Decimals of the amount step of a market that states none (precision.amount): its amounts are rounded down to 1e-8 */
export const DEFAULT_AMOUNT_PRECISION = 8;

/**
 * Decimals of the prices on a market that states no price tick (precision.price), as DEFAULT_AMOUNT_PRECISION for amounts: the strategy
 * warns of it when the grid starts
 */
export const DEFAULT_PRICE_PRECISION = 8;

/** Default atrPeriod: the period of the ATR an atr spacing reads, in timeframe candles, Wilder's 14 (the ATR indicator has no default) */
export const DEFAULT_ATR_PERIOD = 14;

/** Default resetMode: the grid stays in place when the price leaves its range */
export const DEFAULT_RESET_MODE = 'none';

/** Default resetConfirmCandles: one timeframe candle closing out of the grid on a side resetMode arms resets it */
export const DEFAULT_RESET_CONFIRM_CANDLES = 1;

/** Default resetCooldownCandles: a reset can follow the one before it at once */
export const DEFAULT_RESET_COOLDOWN_CANDLES = 0;
