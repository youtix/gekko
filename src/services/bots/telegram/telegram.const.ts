import { ONE_SECOND } from '@constants/time.const';

/**
 * How long the finalisation of the plugins waits for the messages still to go out to Telegram, and so holds the exit: the pending
 * notifications of the EventSubscriber and the last logs of Supervision, which are finalised together, so the exit waits that long at
 * most for both. Telegram unreachable without an answer (a black-holed network) would hold them for every attempt of the fetcher, each
 * up to its own timeout. Each plugin declared its own, and a comment asked to keep the two equal.
 */
export const LAST_FLUSH_TIMEOUT = 15 * ONE_SECOND;
