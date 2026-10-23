export type Candle = {
  /**
   * The row of the candle in the SQLite database: set on the one-minute candles a backtest reads from it, which init and the plugins
   * get as they are, never on a candle from the exchange, made up by the gap filler or batched into a timeframe candle. Nothing reads
   * it: a candle is written by its start, which keeps the row of its minute.
   */
  id?: number;
  start: EpochTimeStamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Set on a candle made up by the gap filler for a minute the exchange did not deliver (flat at the last close, volume 0) */
  synthetic?: true;
};
