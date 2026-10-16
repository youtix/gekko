import { TradingPair } from '@models/utility.types';
import { synchronizeStreams } from '@utils/stream/stream.utils';
import { Readable } from 'stream';

/**
 * Builds one candle stream per pair with `createStream` and emits their candles as `CandleBucket`s, synchronised by
 * timestamp. Back-pressure is relayed to the synchronised stream, and an error of any pair destroys this stream with it.
 */
export class MultiAssetStream extends Readable {
  private readonly synchronizedStream: Readable;
  /** The start of the last candle of each pair whose stream has ended */
  private readonly lastCandleOfEndedPairs = new Map<TradingPair, EpochTimeStamp>();

  constructor(pairs: { symbol: TradingPair }[], createStream: (symbol: TradingPair) => Readable) {
    super({ objectMode: true });
    this.synchronizedStream = synchronizeStreams(
      pairs.map(({ symbol }) => createStream(symbol)),
      { onPairEnd: (pair, lastCandleStart) => this.lastCandleOfEndedPairs.set(pair, lastCandleStart) },
    );

    this.synchronizedStream.on('data', chunk => {
      if (!this.push(chunk)) this.synchronizedStream.pause();
    });
    this.synchronizedStream.on('end', () => this.push(null));
    this.synchronizedStream.on('error', error => this.destroy(error));
  }

  /**
   * Tells whether the stream of `pair` ended before `minute`, so that the pair has no candle from that minute on. The end is known
   * as soon as the pair's last candle is read, buckets ahead of the one a consumer holds: it is compared with the minute asked about,
   * so that a pair missing from a bucket and back for its last candles a few minutes later is not taken for gone.
   */
  hasEndedBefore(pair: TradingPair, minute: EpochTimeStamp): boolean {
    const lastCandleStart = this.lastCandleOfEndedPairs.get(pair);
    return lastCandleStart !== undefined && lastCandleStart < minute;
  }

  _read() {
    this.synchronizedStream.resume();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.synchronizedStream.destroy(error ?? undefined);
    callback(error);
  }
}
