import { GekkoError } from '@errors/gekko.error';
import { Candle } from '@models/candle.types';
import { CandleBucket } from '@models/event.types';
import { TradingPair } from '@models/utility.types';
import { toISOString } from '@utils/date/date.utils';
import { isFiniteNumber } from '@utils/math/math.utils';
import { Readable } from 'node:stream';

type TradingPairCandle = { symbol: TradingPair; candle: Candle };

export type SynchronizeStreamsOptions = {
  /**
   * Called when the stream of a pair ends, with the start of the last candle it delivered: the pair has no candle after it. A stream
   * that ends before its first candle names no pair and is not reported. The call comes as soon as that candle is read, which can be
   * well before the buckets downstream get to it: a consumer compares the start with the minute of the bucket it holds, so as not to
   * take a pair missing from that bucket for gone for good when its last candles come after it.
   */
  onPairEnd?: (pair: TradingPair, lastCandleStart: EpochTimeStamp) => void;
};

/**
 * Synchronizes the candle streams of several pairs by timestamp. It waits until every stream still going has a candle, then emits
 * the earliest minute as a CandleBucket holding the candle of each stream at that minute, in the order of the streams: the callers
 * pass them in the order of `watch.assets`: the signal strategies trade every pair of the bucket (see PositionBook), GridBot the first.
 *
 * A stream that ends lets the others go on, and is reported to `onPairEnd`. A stream that fails fails the output with its error, and
 * one that closes without ending (destroyed without an error) or delivers a candle whose start is not a finite number fails it with
 * a GekkoError, rather than leave its pair out of every later bucket, or the buckets waiting for it, without a word. Destroying the
 * output destroys every stream.
 */
export const synchronizeStreams = (streams: Readable[], { onPairEnd }: SynchronizeStreamsOptions = {}): Readable => {
  if (streams.length === 0) return Readable.from([]);

  let reading = false;
  let streamsEnded = 0;
  const numStreams = streams.length;
  const buffers: (TradingPairCandle | null)[] = new Array(numStreams).fill(null);
  const ended: boolean[] = new Array(numStreams).fill(false);
  /** The last candle read from each stream, to name its pair if the stream closes early */
  const lastRead: (TradingPairCandle | undefined)[] = new Array(numStreams).fill(undefined);

  const out = new Readable({
    objectMode: true,
    read() {
      reading = true;
      tryProcess();
    },
    destroy(err, cb) {
      for (const s of streams) {
        if (!s.destroyed) s.destroy(err || undefined);
      }
      cb(err);
    },
  });

  const tryProcess = () => {
    if (!reading) return;

    while (reading) {
      let needsWait = false;

      // 1. Ensure all active streams have a value in the buffer
      for (let i = 0; i < numStreams; i++) {
        if (!ended[i] && buffers[i] === null) {
          const chunk = streams[i].read() as TradingPairCandle | null;
          if (chunk === null) {
            needsWait = true;
          } else if (!isFiniteNumber(chunk.candle.start)) {
            // A start that is not a finite number is no minute. A NaN start, neither before nor at any other, never left its slot:
            // its pair was missing from every later bucket while the others went on, then the output waited for it forever
            out.destroy(
              new GekkoError(
                'stream',
                `Received a candle of ${chunk.symbol} whose start is ${chunk.candle.start}, not a timestamp: it cannot be synchronised with the other pairs.`,
              ),
            );
            return;
          } else {
            buffers[i] = chunk;
            lastRead[i] = chunk;
          }
        }
      }

      // 2. Check if we have any data left to process
      if (streamsEnded === numStreams && buffers.every(b => b === null)) {
        out.push(null);
        reading = false;
        return;
      }

      // If any active stream is starved and returned null on .read(), we must pause synchronous processing
      if (needsWait) {
        return;
      }

      // 3. Find the earliest start among the buffered candles: every stream still going has one (step 1), and some stream has one
      // since the output has not ended (step 2), so the minimum is the start of a buffered candle, finite as step 1 checked
      let minTimestamp = Infinity;
      for (const buf of buffers) {
        if (buf !== null && buf.candle.start < minTimestamp) minTimestamp = buf.candle.start;
      }

      // 4. Aggregate the candles at minTimestamp into a CandleBucket, in the order of the streams
      const bucket: CandleBucket = new Map();
      for (let i = 0; i < numStreams; i++) {
        const buf = buffers[i];
        if (buf !== null && buf.candle.start === minTimestamp) {
          bucket.set(buf.symbol, buf.candle);
          buffers[i] = null; // consume
        }
      }

      // 5. Yield the bucket and update backpressure state
      reading = out.push(bucket);
    }
  };

  /** Why the output fails when stream i closes before its end, naming its pair once it has delivered a candle */
  const describeEarlyClose = (i: number) => {
    const last = lastRead[i];
    return last
      ? `The candle stream of ${last.symbol} closed before its end (last candle @ ${toISOString(last.candle.start)}): the pair no longer delivers.`
      : `Candle stream ${i + 1} of ${numStreams} closed before its end and before its first candle: its pair never delivered.`;
  };

  // Attach listeners to handle internal node stream events synchronously
  for (let i = 0; i < numStreams; i++) {
    const s = streams[i];
    s.on('readable', tryProcess);
    s.on('end', () => {
      ended[i] = true;
      streamsEnded++;
      // 'end' comes once every candle of the stream has been read: the last one read is its last
      const last = lastRead[i];
      if (last) onPairEnd?.(last.symbol, last.candle.start);
      tryProcess();
    });
    s.on('error', err => {
      out.destroy(err);
    });
    // A stream destroyed without an error emits 'close' alone. Unheard, it left the output waiting for its next candle forever;
    // taken for an end, its pair would drop out of the buckets while the others go on, and in realtime the gap filler would fill
    // it with flat candles for as long as the bot runs. A stream closing because the output was destroyed is not a failure.
    s.on('close', () => {
      if (!ended[i] && !out.destroyed) out.destroy(new GekkoError('stream', describeEarlyClose(i)));
    });
  }

  return out;
};
