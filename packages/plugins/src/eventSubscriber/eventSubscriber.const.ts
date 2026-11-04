/**
 * The most notifications waiting for their turn, the one being sent aside. With Telegram unreachable, each send takes every attempt
 * of the fetcher, about two minutes, and they would pile up for as long as the outage lasts: past this many, each new one drops the
 * oldest, the least worth reading once Telegram answers again. A burst must fit while Telegram answers, since no send ends while a
 * flush queues notifications (no handler waits on the network): a grid strategy placing N orders in one loop queues N strat_create,
 * N order_init and its logs in one flush. Their texts are short, so a full queue costs little memory.
 */
export const MAX_PENDING_NOTIFICATIONS = 1000;
