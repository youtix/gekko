import { ONE_MINUTE, ONE_SECOND } from '@constants/time.const';

export const FETCHER_MAX_RETRIES = 3;

/**
 * How long an attempt may wait for Telegram's answer, its reading included, before it is aborted as a network failure. Without a
 * timeout, an attempt that gets no answer (a black-holed network) waits for the runtime's own, about 300 s in Bun. A long poll
 * waits this long on top of its own `timeout`.
 */
export const FETCHER_TIMEOUT = 30 * ONE_SECOND;

/**
 * The longest retry_after of Telegram's flood control (in a 429) that a request waits out before it is sent again: a 429 that asks
 * for more is thrown at once. The callers await the fetcher where it holds the bot up (an alert sent from a deferred event handler
 * holds the next 1-minute bucket, the reply to a command holds the polling), and a message that Telegram refuses for longer than
 * this is stale by the time it could go out.
 */
export const FETCHER_MAX_RETRY_AFTER = ONE_MINUTE;
