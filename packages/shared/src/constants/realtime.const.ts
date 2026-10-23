import { ONE_SECOND } from './time.const';

/**
 * How long after a minute boundary a live stream fetches the minute that just closed. It covers the drift of the local clock
 * against the exchange's and the exchange's own delay in publishing the closed candle: fetched a few ms after the boundary, the
 * "closed" minute may still be open on the exchange, and a realtime run never replaces a stored minute that traded.
 */
export const REALTIME_GRACE_PERIOD = 2 * ONE_SECOND;

/** At most this many candles per fetch when a live stream catches up on missed minutes (Binance serves 1 000 klines a call) */
export const REALTIME_MAX_CANDLES_PER_FETCH = 1000;

/** A live stream fails once this many consecutive ticks have pushed no candle: the pair no longer delivers */
export const REALTIME_MAX_TICKS_WITHOUT_CANDLE = 5;
