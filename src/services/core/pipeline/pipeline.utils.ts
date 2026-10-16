import { ONE_MINUTE } from '@constants/time.const';
import { TIMEFRAME_TO_MINUTES } from '@constants/timeframe.const';
import { Plugin } from '@plugins/plugin';
import { config } from '@services/configuration/configuration';
import { warning } from '@services/logger';
import { getCandleStart } from '@utils/candle/candle.utils';
import { startOfMinuteUTC, toISOString } from '@utils/date/date.utils';
import { synchronizeStreams } from '@utils/stream/stream.utils';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { MultiAssetBacktestStream } from '../stream/backtest/multiAssetBacktest.stream';
import { MultiAssetHistoricalStream } from '../stream/multiAssetHistorical.stream';
import { PluginsStream } from '../stream/plugins.stream';
import { RealtimeStream } from '../stream/realtime/realtime.stream';
import { FillCandleGapStream } from '../stream/validation/fillCandleGap.stream';
import { RejectDuplicateCandleStream } from '../stream/validation/rejectDuplicateCandle.stream';
import { RejectFutureCandleStream } from '../stream/validation/rejectFutureCandle.stream';

const buildRealtimePipeline = async (plugins: Plugin[]) => {
  const { pairs, timeframe, warmup } = config.getWatch();
  // The clock is read once: the live stream of every pair starts with the minute in progress and the warmup history ends with the
  // minute before, so that every pair starts on the same minute and the history meets the live candles without a gap or an overlap,
  // however slow start-up is
  const currentMinute = startOfMinuteUTC(Date.now());
  const liveStream = synchronizeStreams(pairs.map(p => new RealtimeStream(p.symbol, currentMinute)));
  // The warmup history holds `candleCount` whole candles, then the closed minutes of the candle in progress
  const start = getCandleStart(TIMEFRAME_TO_MINUTES[timeframe!], currentMinute, warmup.candleCount); // Timeframe will always defined in thanks to zod super refine
  const end = currentMinute - ONE_MINUTE;
  const history = new MultiAssetHistoricalStream({ daterange: { start, end }, tickrate: warmup.tickrate, pairs });

  const sink = new PluginsStream(plugins);
  await runPipeline(sink, () =>
    pipeline(
      mergeSequentialStreams(history, liveStream),
      new RejectFutureCandleStream(),
      new RejectDuplicateCandleStream(),
      // A pair listed after the start of the warmup has no candle in its first buckets: they are dropped rather than handed to
      // the plugins incomplete (the timeframe batcher refuses a bucket that misses a pair). For the same reason a pair whose
      // history ends early is filled, not left out, until its live stream delivers it again or gives up on it.
      new FillCandleGapStream(
        pairs.map(p => p.symbol),
        { dropIncompleteLeadingBuckets: true },
      ),
      sink,
    ),
  );
};

const buildBacktestPipeline = async (plugins: Plugin[]) => {
  const { daterange, pairs } = config.getWatch();
  if (!daterange) throw new Error('daterange is not set');

  warning('stream', 'BACKTESTING FEATURE NEEDS PROPER TESTING, ACT ON THESE NUMBERS AT YOUR OWN RISK!');
  const sink = new PluginsStream(plugins);
  await runPipeline(sink, () => pipeline(new MultiAssetBacktestStream({ daterange, pairs }), sink));
};

const buildImporterPipeline = async (plugins: Plugin[]) => {
  const { daterange, tickrate, pairs } = config.getWatch();
  if (!daterange) throw new Error('daterange is not set');

  // Closed minutes only: the exchange serves the minute in progress as an unfinished candle, which would stay in the database
  // until another import replaced it
  const lastClosedMinute = startOfMinuteUTC(Date.now()) - ONE_MINUTE;
  const isEndClosed = startOfMinuteUTC(daterange.end) <= lastClosedMinute;
  if (!isEndClosed)
    warning(
      'pipeline',
      `daterange.end ${toISOString(daterange.end)} is not a closed minute yet: importing up to the last closed minute, ${toISOString(lastClosedMinute)}.`,
    );
  const end = isEndClosed ? daterange.end : lastClosedMinute;

  const stream = new MultiAssetHistoricalStream({ daterange: { start: daterange.start, end }, tickrate, pairs });
  // A pair whose history ends early keeps its remaining minutes missing, as when it is imported alone, rather than getting them
  // made up flat to the end of the range
  const gapFiller = new FillCandleGapStream(
    pairs.map(p => p.symbol),
    { hasEndedBefore: (pair, minute) => stream.hasEndedBefore(pair, minute) },
  );
  const sink = new PluginsStream(plugins);
  await runPipeline(sink, () => pipeline(stream, new RejectFutureCandleStream(), gapFiller, sink));
};

/**
 * pipeline() rejects with the first error of the chain. When a bucket fails and a stream upstream fails too during the
 * finalisation that follows, that first error is the upstream one, but the bucket's error is the one main() has to see (an
 * ApplicationStopError is a graceful stop, not a crash): it wins.
 */
const runPipeline = async (sink: PluginsStream, run: () => Promise<void>) => {
  try {
    await run();
  } catch (error) {
    throw sink.failure ?? error;
  }
};

export const streamPipelines = {
  realtime: buildRealtimePipeline,
  backtest: buildBacktestPipeline,
  importer: buildImporterPipeline,
};

export const mergeSequentialStreams = (...streams: Readable[]) => {
  async function* concatGenerator() {
    for (const stream of streams) {
      for await (const chunk of stream) {
        yield chunk;
      }
    }
  }

  const merged = Readable.from(concatGenerator());

  // Ensure all underlying streams are destroyed when the merged stream is destroyed. They are destroyed without the error:
  // the merged stream reports it, and a stream not consumed yet has no 'error' listener, so it would raise an unhandled error.
  const originalDestroy = merged.destroy.bind(merged);
  merged.destroy = (error?: Error | null) => {
    for (const stream of streams) {
      if (!stream.destroyed) {
        stream.destroy();
      }
    }
    return originalDestroy(error ?? undefined);
  };

  // Relayed from the start, not only once the generator reads a stream: the live stream fails while the warmup history is
  // still read, and an 'error' event without a listener is an uncaught exception, which exits without finalising the plugins
  for (const stream of streams) stream.on('error', error => merged.destroy(error));

  return merged;
};
