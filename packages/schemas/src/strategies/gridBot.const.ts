// The defaults of GridBot's schema (see gridBot.schema.ts). The decimals the strategy falls back on for a market that states no amount
// step or no price tick are in @gekko/strategies/gridBot/gridBot.const.

/** Default retryOnError: the retries of a failed order before GridBot gives up on it */
export const DEFAULT_RETRY_LIMIT = 3;

/** Default atrPeriod: the period of the ATR an atr spacing reads, in timeframe candles, Wilder's 14 (the ATR indicator has no default) */
export const DEFAULT_ATR_PERIOD = 14;

/** Default resetMode: the grid stays in place when the price leaves its range */
export const DEFAULT_RESET_MODE = 'none';

/** Default resetConfirmCandles: one timeframe candle closing out of the grid on a side resetMode arms resets it */
export const DEFAULT_RESET_CONFIRM_CANDLES = 1;

/** Default resetCooldownCandles: a reset can follow the one before it at once */
export const DEFAULT_RESET_COOLDOWN_CANDLES = 0;
