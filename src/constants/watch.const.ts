/**
 * The most assets a run watches. Each pair costs a realtime run one fetch a minute (the live stream of every pair asks for its closed
 * minute at each tick) and the storage a table, and a signal strategy's BUY takes 1/n of the free currency among the pairs not invested
 * (see PositionBook), a share the market minimums refuse on a small account long before twenty. Five, the former bound, refused a
 * portfolio backtest of ten pairs at the configuration while nothing in the code depended on that number.
 */
export const MAX_WATCHED_ASSETS = 20;
