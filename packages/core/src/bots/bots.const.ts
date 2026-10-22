// After a failed check, each wait doubles, up to this many intervals (a minute with the default interval): a network that stays
// down is then tried, and its failure logged, about once a minute rather than at every interval.
export const MAX_BACKOFF_FACTOR = 60;
