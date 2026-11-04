import { TradingPair } from '@gekko/shared/models/utility.types';

export type FillCandleGapOptions = {
  /**
   * Drop the leading buckets until every pair has had a candle, instead of pushing them without the pairs never seen so far (a
   * missing pair is filled from its last candle, which such a pair lacks, and a later candle cannot fill an earlier minute).
   * The realtime pipeline needs it (the TradingAdvisor batcher refuses an incomplete bucket); the importer does not (each pair
   * is stored on its own, so its leading minutes are worth keeping).
   */
  dropIncompleteLeadingBuckets?: boolean;
  /**
   * Tells whether the candle stream of a pair ended before a minute, so that the pair has no candle from that minute on: such a
   * pair is left out of the buckets rather than filled. The importer passes it: a pair whose history ended early used to be filled
   * with flat candles to the end of the range, weeks of them for a delisted pair, which a later backtest traded on; its remaining
   * minutes now stay missing, and a backtest of them is refused. The realtime pipeline does not: its live streams take over from
   * the warmup history, so a pair whose history ended early is filled until it delivers again or its live stream gives up on it.
   */
  hasEndedBefore?: (pair: TradingPair, minute: EpochTimeStamp) => boolean;
};
