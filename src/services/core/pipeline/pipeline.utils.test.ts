import { ONE_MINUTE } from '@constants/time.const';
import { TIMEFRAME_TO_MINUTES } from '@constants/timeframe.const';
import { CandleBucket } from '@models/event.types';
import { TradingPair } from '@models/utility.types';
import { Plugin } from '@plugins/plugin';
import { config } from '@services/configuration/configuration';
import { inject } from '@services/injecter/injecter';
import { warning } from '@services/logger';
import { useTimeZone } from '@utils/date/date.mock';
import { startOfMinuteUTC } from '@utils/date/date.utils';
import { synchronizeStreams } from '@utils/stream/stream.utils';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { afterEach, beforeEach, describe, expect, it, Mock, MockInstance, vi } from 'vitest';
import { MultiAssetBacktestStream } from '../stream/backtest/multiAssetBacktest.stream';
import { MultiAssetHistoricalStream } from '../stream/multiAssetHistorical.stream';
import { PluginsStream } from '../stream/plugins.stream';
import { RealtimeStream } from '../stream/realtime/realtime.stream';
import { FillCandleGapStream } from '../stream/validation/fillCandleGap.stream';
import { RejectDuplicateCandleStream } from '../stream/validation/rejectDuplicateCandle.stream';
import { RejectFutureCandleStream } from '../stream/validation/rejectFutureCandle.stream';
import { mergeSequentialStreams, streamPipelines } from './pipeline.utils';

// Mocks
vi.mock('@services/configuration/configuration', () => ({
  config: {
    getWatch: vi.fn(),
  },
}));

vi.mock('@services/injecter/injecter', () => ({
  inject: { exchange: vi.fn() },
}));

vi.mock('@utils/stream/stream.utils', () => ({
  synchronizeStreams: vi.fn(),
}));

vi.mock('@services/logger', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock('stream/promises', () => ({
  pipeline: vi.fn(),
}));

// Mock Stream Classes
vi.mock('../stream/backtest/multiAssetBacktest.stream', () => ({
  MultiAssetBacktestStream: vi.fn(),
}));
vi.mock('../stream/validation/rejectDuplicateCandle.stream', () => ({
  RejectDuplicateCandleStream: vi.fn(),
}));

vi.mock('../stream/multiAssetHistorical.stream', () => ({
  MultiAssetHistoricalStream: vi.fn(),
}));

vi.mock('../stream/plugins.stream', () => ({
  PluginsStream: vi.fn(),
}));
vi.mock('../stream/realtime/realtime.stream', () => ({
  RealtimeStream: vi.fn(),
}));

// What every mode reads from the watch section: the pair, a past range, the timeframe and the warmup
const EVERY_MODE_WATCH = {
  pairs: [{ symbol: 'BTC/USDT' }],
  timeframe: '1h',
  warmup: { candleCount: 1, tickrate: 1000 },
  daterange: { start: new Date('2023-01-01').getTime(), end: new Date('2023-01-02').getTime() },
  tickrate: 500,
};

describe('Pipeline Utils', () => {
  describe('mergeSequentialStreams', () => {
    it.each`
      values1   | values2 | expected
      ${[1, 2]} | ${[3]}  | ${[1, 2, 3]}
      ${[]}     | ${[1]}  | ${[1]}
      ${[1]}    | ${[]}   | ${[1]}
      ${[]}     | ${[]}   | ${[]}
    `('should merge streams with $values1 and $values2 to $expected', async ({ values1, values2, expected }) => {
      const s1 = Readable.from(values1);
      const s2 = Readable.from(values2);
      const merged = mergeSequentialStreams(s1, s2);

      const result: unknown[] = [];
      for await (const chunk of merged) {
        result.push(chunk);
      }

      expect(result).toEqual(expected);
    });

    describe('when the merged stream is destroyed with an error while the second stream is not consumed yet', () => {
      const error = new Error('test error');
      let s1: Readable;
      let s2: Readable;
      let onMergedError: Mock;
      let onUncaughtException: Mock;

      beforeEach(async () => {
        onUncaughtException = vi.fn();
        process.on('uncaughtException', onUncaughtException);

        s1 = new Readable({ objectMode: true, read() {} });
        s1.push(1);
        s2 = Readable.from([2]);
        const merged = mergeSequentialStreams(s1, s2);
        onMergedError = vi.fn();
        merged.on('error', onMergedError);
        // Once the first chunk is out, the merge is consuming s1 and s2 still has no 'error' listener
        await new Promise(resolve => merged.once('readable', resolve));

        merged.destroy(error);
        await new Promise(resolve => merged.once('close', resolve));
      });

      afterEach(() => {
        process.off('uncaughtException', onUncaughtException);
      });

      it.each`
        position    | getStream
        ${'first'}  | ${() => s1}
        ${'second'} | ${() => s2}
      `('should destroy the $position underlying stream', ({ getStream }) => {
        expect(getStream().destroyed).toBe(true);
      });

      it('should not raise an unhandled error from the underlying streams', () => {
        expect(onUncaughtException).not.toHaveBeenCalled();
      });

      it('should report the error through the merged stream', () => {
        expect(onMergedError).toHaveBeenCalledWith(error);
      });
    });

    describe('when the second stream fails while the first one is still read', () => {
      const error = new Error('live stream failed');
      let s1: Readable;
      let onUncaughtException: Mock;
      let outcome: unknown;

      beforeEach(async () => {
        onUncaughtException = vi.fn();
        process.on('uncaughtException', onUncaughtException);
        const { pipeline: actualPipeline } = await vi.importActual<typeof import('stream/promises')>('stream/promises');

        // Never ends, as a warmup history still downloading: the merge has not started reading s2
        s1 = new Readable({ objectMode: true, read() {} });
        s1.push(1);
        const s2 = new Readable({ objectMode: true, read() {} });
        const sink = new Writable({ objectMode: true, write: (_chunk, _encoding, callback) => callback() });
        const settled = actualPipeline(mergeSequentialStreams(s1, s2), sink).then(
          () => 'resolved',
          (reason: unknown) => reason,
        );
        await new Promise(resolve => setImmediate(resolve));

        s2.destroy(error);
        outcome = await Promise.race([settled, new Promise(resolve => setTimeout(() => resolve('still pending'), 100))]);
      });

      afterEach(() => {
        process.off('uncaughtException', onUncaughtException);
      });

      it('should make the pipeline reject with the error', () => {
        expect(outcome).toBe(error);
      });

      it('should not raise an uncaught exception', () => {
        expect(onUncaughtException).not.toHaveBeenCalled();
      });

      it('should destroy the first stream', () => {
        expect(s1.destroyed).toBe(true);
      });
    });

    it('should not destroy an already destroyed underlying stream', () => {
      const s1 = Readable.from([1]);
      const s2 = Readable.from([2]);
      s1.destroy();
      const merged = mergeSequentialStreams(s1, s2);

      const spy1 = vi.spyOn(s1, 'destroy');

      merged.destroy();

      expect(spy1).not.toHaveBeenCalled();
    });
  });

  describe('streamPipelines', () => {
    const mockPlugins = [] as any;

    // Writes one bucket per list of symbols, a minute apart from 0, each holding a candle of each symbol in order, into the gap
    // filler and returns the symbols of each bucket it emits: a gap filler emits only the pairs it was built with, in its own order
    const passThroughGapFiller = async (gapFiller: FillCandleGapStream, ...bucketsSymbols: string[][]) => {
      for (const [minute, symbols] of bucketsSymbols.entries()) {
        const candle = { start: minute * ONE_MINUTE, open: 1, high: 1, low: 1, close: 1, volume: 1 };
        gapFiller.write(new Map(symbols.map(symbol => [symbol, candle])));
      }
      gapFiller.end();
      const buckets: CandleBucket[] = await gapFiller.toArray();
      return buckets.map(bucket => [...bucket.keys()]);
    };

    describe('realtime', () => {
      type Timeframe = keyof typeof TIMEFRAME_TO_MINUTES;
      const symbol = 'BTC/USDT';
      const pairs = [{ symbol }];
      const at = (iso: string) => new Date(iso).getTime();

      // Builds the realtime pipeline and returns the warmup history range it asked for
      const launchRealtime = async (timeframe: Timeframe, candleCount: number, watchedPairs = pairs) => {
        (config.getWatch as Mock).mockReturnValue({ pairs: watchedPairs, timeframe, warmup: { candleCount, tickrate: 1000 } });
        await streamPipelines.realtime(mockPlugins);
        return vi.mocked(MultiAssetHistoricalStream).mock.lastCall![0].daterange;
      };

      // A stream that never ends: the merge of the history and the live stream subscribes to the errors of both
      const pendingStream = () => new Readable({ objectMode: true, read() {} });

      beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(at('2024-03-15T10:20:30.500Z'));
        vi.mocked(MultiAssetHistoricalStream).mockImplementation(function () {
          return pendingStream() as MultiAssetHistoricalStream;
        });
        vi.mocked(synchronizeStreams).mockReturnValue(pendingStream());
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('should build a live stream for each pair, starting with the minute in progress', async () => {
        await launchRealtime('1h', 2);
        expect(vi.mocked(RealtimeStream).mock.calls).toEqual([[symbol, at('2024-03-15T10:20:00.000Z')]]);
      });

      it('should start the live streams of all the pairs with the same minute when building them crosses a minute boundary', async () => {
        vi.mocked(RealtimeStream).mockImplementation(function (this: RealtimeStream) {
          vi.setSystemTime(Date.now() + ONE_MINUTE);
          return this;
        });
        await launchRealtime('1h', 2, [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }]);
        expect(vi.mocked(RealtimeStream).mock.calls).toEqual([
          ['BTC/USDT', at('2024-03-15T10:20:00.000Z')],
          ['ETH/USDT', at('2024-03-15T10:20:00.000Z')],
        ]);
      });

      it('should synchronize the live streams', async () => {
        await launchRealtime('1h', 2);
        expect(synchronizeStreams).toHaveBeenCalledWith(vi.mocked(RealtimeStream).mock.instances);
      });

      it('should hand the plugins to the plugins stream', async () => {
        await launchRealtime('1h', 2);
        expect(PluginsStream).toHaveBeenCalledWith(mockPlugins);
      });

      it('should pipe the source through the future candle filter, the duplicate filter, then the gap filler, into the plugins', async () => {
        await launchRealtime('1h', 2);
        // The source is merged inside the builder: the next test checks what it reads
        expect(vi.mocked(pipeline).mock.lastCall).toEqual([
          expect.any(Readable),
          expect.any(RejectFutureCandleStream),
          expect.any(RejectDuplicateCandleStream),
          expect.any(FillCandleGapStream),
          expect.any(PluginsStream),
        ]);
      });

      it('should read the whole warmup history, then the live stream, as the source', async () => {
        vi.mocked(MultiAssetHistoricalStream).mockImplementation(function () {
          return Readable.from(['history 1', 'history 2']) as MultiAssetHistoricalStream;
        });
        vi.mocked(synchronizeStreams).mockReturnValue(Readable.from(['live 1', 'live 2']));
        await launchRealtime('1h', 2);
        const source = vi.mocked(pipeline).mock.lastCall![0] as Readable;
        expect(await source.toArray()).toEqual(['history 1', 'history 2', 'live 1', 'live 2']);
      });

      it('should hand every watched pair, in order, to the gap filler', async () => {
        const watchedPairs = [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }];
        await launchRealtime('1h', 2, watchedPairs);
        const gapFiller = vi.mocked(pipeline).mock.lastCall![3] as FillCandleGapStream;
        const symbols = watchedPairs.map(({ symbol }) => symbol);
        expect(await passThroughGapFiller(gapFiller, symbols)).toEqual([symbols]);
      });

      it('should drop a leading bucket that misses a pair never seen instead of handing it incomplete to the plugins', async () => {
        const watchedPairs = [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }];
        await launchRealtime('1h', 2, watchedPairs);
        const gapFiller = vi.mocked(pipeline).mock.lastCall![3] as FillCandleGapStream;
        expect(await passThroughGapFiller(gapFiller, ['BTC/USDT'])).toEqual([]);
      });

      // Left out, the pair would make the timeframe batcher refuse the bucket: the live stream of the pair takes over from its history
      it('should have the gap filler fill a pair whose warmup history has ended rather than leave it out', async () => {
        vi.mocked(MultiAssetHistoricalStream).mockImplementation(function () {
          const history = pendingStream() as MultiAssetHistoricalStream;
          history.hasEndedBefore = () => true;
          return history;
        });
        await launchRealtime('1h', 2, [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }]);
        const gapFiller = vi.mocked(pipeline).mock.lastCall![3] as FillCandleGapStream;
        expect(await passThroughGapFiller(gapFiller, ['BTC/USDT', 'ETH/USDT'], ['BTC/USDT'])).toEqual([
          ['BTC/USDT', 'ETH/USDT'],
          ['BTC/USDT', 'ETH/USDT'],
        ]);
      });

      // From the start of the candle `candleCount` candles before the one in progress to the last closed minute. The window
      // itself is swept over many dates in candle.utils.test.ts (getCandleStart).
      it.each`
        timeframe | candleCount | clock                         | start                     | end
        ${'1m'}   | ${3}        | ${'2024-03-15T10:20:30.500Z'} | ${'2024-03-15T10:17:00Z'} | ${'2024-03-15T10:19:00Z'}
        ${'4h'}   | ${2}        | ${'2024-03-15T10:20:30.500Z'} | ${'2024-03-15T00:00:00Z'} | ${'2024-03-15T10:19:00Z'}
        ${'1w'}   | ${1}        | ${'2024-03-15T10:20:30.500Z'} | ${'2024-03-04T00:00:00Z'} | ${'2024-03-15T10:19:00Z'}
        ${'1M'}   | ${1}        | ${'2024-03-15T10:20:30.500Z'} | ${'2024-02-01T00:00:00Z'} | ${'2024-03-15T10:19:00Z'}
        ${'3M'}   | ${1}        | ${'2024-03-15T10:20:30.500Z'} | ${'2023-10-01T00:00:00Z'} | ${'2024-03-15T10:19:00Z'}
        ${'6M'}   | ${1}        | ${'2024-03-15T10:20:30.500Z'} | ${'2023-07-01T00:00:00Z'} | ${'2024-03-15T10:19:00Z'}
        ${'1y'}   | ${1}        | ${'2024-03-15T10:20:30.500Z'} | ${'2023-01-01T00:00:00Z'} | ${'2024-03-15T10:19:00Z'}
        ${'1h'}   | ${0}        | ${'2024-03-15T10:00:30.500Z'} | ${'2024-03-15T10:00:00Z'} | ${'2024-03-15T09:59:00Z'}
        ${'1h'}   | ${0}        | ${'2024-03-15T10:01:30.500Z'} | ${'2024-03-15T10:00:00Z'} | ${'2024-03-15T10:00:00Z'}
      `(
        'should download the warmup history of $candleCount $timeframe candles from $start to $end at $clock',
        async ({ timeframe, candleCount, clock, start, end }) => {
          vi.setSystemTime(at(clock));
          await launchRealtime(timeframe, candleCount);
          expect(MultiAssetHistoricalStream).toHaveBeenCalledWith({ daterange: { start: at(start), end: at(end) }, tickrate: 1000, pairs });
        },
      );

      // On 2026-10-25 Paris goes from 03:00 CEST back to 02:00 CET: the hour from 01:00Z to 02:00Z is the second pass of 02:00-03:00.
      // Floored in local time, a start-up in it began an hour back: every live candle came an hour late until 02:00Z, then 61 at once.
      describe('on a host in Europe/Paris, started in the hour repeated when DST ends', () => {
        useTimeZone('Europe/Paris');

        beforeEach(() => {
          vi.setSystemTime(at('2026-10-25T01:30:30.500Z'));
        });

        it('should start the live stream with the minute in progress, 01:30Z', async () => {
          await launchRealtime('1h', 1);
          expect(vi.mocked(RealtimeStream).mock.calls).toEqual([[symbol, at('2026-10-25T01:30:00.000Z')]]);
        });

        it('should end the warmup history with the minute before, 01:29Z', async () => {
          const { end } = await launchRealtime('1h', 1);
          expect(end).toBe(at('2026-10-25T01:29:00.000Z'));
        });
      });

      describe('junction between the warmup history and the live stream', () => {
        const fetchOHLCV = vi.fn();
        let ActualRealtimeStream: typeof RealtimeStream;
        let liveStreams: Readable[];
        let uptime: MockInstance;

        // Moves the clock just past the next minute boundary
        const crossMinuteBoundary = () => vi.setSystemTime(startOfMinuteUTC(Date.now()) + ONE_MINUTE + 1);

        beforeEach(async () => {
          ({ RealtimeStream: ActualRealtimeStream } = await vi.importActual<typeof import('../stream/realtime/realtime.stream')>(
            '../stream/realtime/realtime.stream',
          ));
          liveStreams = [];
          vi.setSystemTime(at('2024-03-15T10:20:59.999Z'));
          uptime = vi.spyOn(process, 'uptime');
          fetchOHLCV.mockResolvedValue([]);
          (inject.exchange as Mock).mockReturnValue({ fetchOHLCV });
        });

        afterEach(() => {
          for (const stream of liveStreams) stream.destroy();
          uptime.mockRestore();
        });

        // 0 would be a closed minute fetched twice (the second copy dropped), 1 is contiguous, 2 or more a gap
        it.each`
          slowStep                                | minutesAfterHistory
          ${'nothing'}                            | ${1}
          ${'the process start-up'}               | ${1}
          ${'building the live stream'}           | ${1}
          ${'building the warmup history stream'} | ${1}
        `(
          'should fetch the first live minute $minutesAfterHistory minute(s) after the last history minute when $slowStep crosses a minute boundary',
          async ({ slowStep, minutesAfterHistory }) => {
            if (slowStep === 'the process start-up') uptime.mockReturnValue(120);
            vi.mocked(RealtimeStream).mockImplementation(function (pair: TradingPair, startMinute: EpochTimeStamp) {
              const stream = new ActualRealtimeStream(pair, startMinute);
              liveStreams.push(stream);
              if (slowStep === 'building the live stream') crossMinuteBoundary();
              return stream;
            });
            vi.mocked(MultiAssetHistoricalStream).mockImplementation(function () {
              if (slowStep === 'building the warmup history stream') crossMinuteBoundary();
              return pendingStream() as MultiAssetHistoricalStream;
            });

            const { end } = await launchRealtime('1h', 2);
            vi.advanceTimersByTime(ONE_MINUTE + 10);

            expect((fetchOHLCV.mock.calls[0][1].from - end) / ONE_MINUTE).toBe(minutesAfterHistory);
          },
        );
      });
    });

    describe('when the pipeline rejects', () => {
      const upstreamError = new Error('a stream upstream failed');
      const bucketError = new Error('a bucket failed');
      const modes = Object.keys(streamPipelines) as (keyof typeof streamPipelines)[];

      // Launches the pipeline of a mode with a plugins stream whose last bucket failed with `failure`, if any
      const launchFailing = (mode: keyof typeof streamPipelines, failure?: Error) => {
        (config.getWatch as Mock).mockReturnValue({
          pairs: [{ symbol: 'BTC/USDT' }],
          timeframe: '1h',
          warmup: { candleCount: 1, tickrate: 1000 },
          daterange: { start: new Date('2023-01-01').getTime(), end: new Date('2023-01-02').getTime() },
          tickrate: 500,
        });
        vi.mocked(PluginsStream).mockImplementation(function () {
          return { failure } as PluginsStream;
        });
        vi.mocked(pipeline).mockRejectedValue(upstreamError);
        return streamPipelines[mode](mockPlugins);
      };

      beforeEach(() => {
        const pendingStream = () => new Readable({ objectMode: true, read() {} });
        vi.mocked(MultiAssetHistoricalStream).mockImplementation(function () {
          return pendingStream() as MultiAssetHistoricalStream;
        });
        vi.mocked(synchronizeStreams).mockReturnValue(pendingStream());
      });

      it.each(modes)('should reject the %s pipeline with the error of the failed bucket rather than the upstream one', async mode => {
        await expect(launchFailing(mode, bucketError)).rejects.toBe(bucketError);
      });

      it.each(modes)('should reject the %s pipeline with the upstream error when no bucket failed', async mode => {
        await expect(launchFailing(mode)).rejects.toBe(upstreamError);
      });
    });

    describe('with a signal', () => {
      const modes = Object.keys(streamPipelines) as (keyof typeof streamPipelines)[];
      const { signal } = new AbortController();
      // The options pipeline() got after the streams, if any: its last argument
      const lastArgument = () => vi.mocked(pipeline).mock.lastCall?.at(-1) as unknown;

      beforeEach(() => {
        (config.getWatch as Mock).mockReturnValue(EVERY_MODE_WATCH);
        const pendingStream = () => new Readable({ objectMode: true, read() {} });
        vi.mocked(MultiAssetHistoricalStream).mockImplementation(function () {
          return pendingStream() as MultiAssetHistoricalStream;
        });
        vi.mocked(synchronizeStreams).mockReturnValue(pendingStream());
      });

      it.each(modes)('should hand pipeline() the signal after the streams in %s mode', async mode => {
        await streamPipelines[mode](mockPlugins, signal);
        expect((lastArgument() as { signal?: AbortSignal }).signal).toBe(signal);
      });

      it.each(modes)('should hand pipeline() the streams alone, the plugins stream last, without a signal in %s mode', async mode => {
        await streamPipelines[mode](mockPlugins);
        expect(lastArgument()).toBeInstanceOf(PluginsStream);
      });
    });

    // On the real stream pipeline and plugins stream, from a source that never ends, as the live stream of a realtime run, or a backtest
    // or an import still reading
    describe.each(Object.keys(streamPipelines) as (keyof typeof streamPipelines)[])('when the %s run is aborted', mode => {
      const reason = new Error('the run is over');
      const bucketFailure = new Error('a bucket failed');
      const bucket: CandleBucket = new Map([['BTC/USDT', { start: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]]);
      let source: Readable;
      let controller: AbortController;
      let plugin: Plugin;
      let initialized: PromiseWithResolvers<void>;
      let bucketStarted: PromiseWithResolvers<void>;
      let bucketProcessed: PromiseWithResolvers<void>;
      let failure: unknown;

      // Starts the run, then waits until its plugin is initialised: an abort before would finalise no plugin. `settled` resolves to
      // what the run rejected with.
      const startRun = async () => {
        const settled = streamPipelines[mode]([plugin], controller.signal).then(
          () => 'resolved',
          (rejection: unknown) => rejection,
        );
        await initialized.promise;
        return { settled };
      };

      beforeEach(async () => {
        const { pipeline: actualPipeline } = await vi.importActual<typeof import('stream/promises')>('stream/promises');
        const { PluginsStream: ActualPluginsStream } =
          await vi.importActual<typeof import('../stream/plugins.stream')>('../stream/plugins.stream');
        const { RejectDuplicateCandleStream: ActualRejectDuplicateCandleStream } = await vi.importActual<
          typeof import('../stream/validation/rejectDuplicateCandle.stream')
        >('../stream/validation/rejectDuplicateCandle.stream');
        vi.mocked(pipeline).mockImplementation(actualPipeline);
        vi.mocked(PluginsStream).mockImplementation(function (plugins: Plugin[]) {
          return new ActualPluginsStream(plugins);
        });
        vi.mocked(RejectDuplicateCandleStream).mockImplementation(function () {
          return new ActualRejectDuplicateCandleStream();
        });
        source = new Readable({ objectMode: true, read() {} });
        vi.mocked(MultiAssetHistoricalStream).mockImplementation(function () {
          return source as MultiAssetHistoricalStream;
        });
        vi.mocked(MultiAssetBacktestStream).mockImplementation(function () {
          return source as MultiAssetBacktestStream;
        });
        vi.mocked(synchronizeStreams).mockReturnValue(new Readable({ objectMode: true, read() {} }));
        (config.getWatch as Mock).mockReturnValue(EVERY_MODE_WATCH);

        controller = new AbortController();
        initialized = Promise.withResolvers();
        bucketStarted = Promise.withResolvers();
        bucketProcessed = Promise.withResolvers();
        plugin = {
          emitterName: 'Stub',
          processInitStream: vi.fn(async () => initialized.resolve()),
          processInputStream: vi.fn(async () => {
            bucketStarted.resolve();
            await bucketProcessed.promise;
          }),
          processCloseStream: vi.fn(async () => undefined),
          hasDeferredEvents: vi.fn(() => false),
          broadcastDeferredEmit: vi.fn(async () => false),
          countUndeliveredPayloads: vi.fn(() => new Map()),
        } as unknown as Plugin;
      });

      describe('between two buckets', () => {
        beforeEach(async () => {
          const { settled } = await startRun();
          controller.abort(reason);
          failure = await settled;
        });

        it('should reject with an AbortError caused by the reason of the abort', () => {
          expect(failure).toEqual(expect.objectContaining({ name: 'AbortError', cause: reason }));
        });

        it('should finalise the plugins with that AbortError as the failure', () => {
          expect(plugin.processCloseStream).toHaveBeenCalledExactlyOnceWith(failure);
        });
      });

      describe('while a bucket in progress fails', () => {
        beforeEach(async () => {
          const { settled } = await startRun();
          source.push(bucket);
          await bucketStarted.promise;
          controller.abort(reason);
          bucketProcessed.reject(bucketFailure);
          failure = await settled;
        });

        it('should reject with the error of the bucket rather than the AbortError', () => {
          expect(failure).toBe(bucketFailure);
        });

        it('should finalise the plugins with the error of the bucket as the failure', () => {
          expect(plugin.processCloseStream).toHaveBeenCalledExactlyOnceWith(bucketFailure);
        });
      });
    });

    describe('backtest', () => {
      const daterange = { start: new Date('2023-01-01').getTime(), end: new Date('2023-01-02').getTime() };
      const pairs = [{ symbol: 'BTC/USDT' }];

      // Builds the backtest pipeline for the configured range
      const launchBacktest = async () => {
        (config.getWatch as Mock).mockReturnValue({ daterange, pairs });
        await streamPipelines.backtest(mockPlugins);
      };

      it('should pipe the stored candles straight into the plugins', async () => {
        await launchBacktest();
        expect(vi.mocked(pipeline).mock.lastCall).toEqual([expect.any(MultiAssetBacktestStream), expect.any(PluginsStream)]);
      });

      it('should read the stored candles of the watched pairs over daterange', async () => {
        await launchBacktest();
        expect(MultiAssetBacktestStream).toHaveBeenCalledWith({ daterange, pairs });
      });

      it('should hand the plugins to the plugins stream', async () => {
        await launchBacktest();
        expect(PluginsStream).toHaveBeenCalledWith(mockPlugins);
      });

      it('should warn once that the backtest needs proper testing', async () => {
        await launchBacktest();
        expect(vi.mocked(warning).mock.calls).toEqual([
          ['stream', 'BACKTESTING FEATURE NEEDS PROPER TESTING, ACT ON THESE NUMBERS AT YOUR OWN RISK!'],
        ]);
      });

      it('should throw an error if daterange is not set in config', async () => {
        (config.getWatch as Mock).mockReturnValue({ daterange: undefined, pairs: [] });
        await expect(streamPipelines.backtest(mockPlugins)).rejects.toThrow('daterange is not set');
      });
    });

    describe('importer', () => {
      const pairs = [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }];
      const tickrate = 500;
      const at = (iso: string) => new Date(iso).getTime();
      const pastStart = '2024-03-15T08:00:00.000Z';
      const lastClosedMinute = '2024-03-15T10:19:00.000Z';

      // Builds the importer pipeline for the configured range
      const launchImporter = async (end: string, start = pastStart) => {
        (config.getWatch as Mock).mockReturnValue({ daterange: { start: at(start), end: at(end) }, tickrate, pairs });
        await streamPipelines.importer(mockPlugins);
      };

      beforeEach(() => {
        vi.useFakeTimers();
        // The minute in progress started at 10:20
        vi.setSystemTime(at('2024-03-15T10:20:30.500Z'));
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('should pipe the history through the future candle filter, then the gap filler, into the plugins', async () => {
        await launchImporter('2024-03-15T09:00:00.000Z');
        expect(vi.mocked(pipeline).mock.lastCall).toEqual([
          expect.any(MultiAssetHistoricalStream),
          expect.any(RejectFutureCandleStream),
          expect.any(FillCandleGapStream),
          expect.any(PluginsStream),
        ]);
      });

      it('should hand every watched pair, in order, to the gap filler', async () => {
        await launchImporter('2024-03-15T09:00:00.000Z');
        const gapFiller = vi.mocked(pipeline).mock.lastCall![2] as FillCandleGapStream;
        const symbols = pairs.map(({ symbol }) => symbol);
        expect(await passThroughGapFiller(gapFiller, symbols)).toEqual([symbols]);
      });

      // A pair listed after the start of the range has no candle there, and the others are imported meanwhile
      it('should have the gap filler let out a bucket lacking a pair that has had no candle yet', async () => {
        await launchImporter('2024-03-15T09:00:00.000Z');
        const gapFiller = vi.mocked(pipeline).mock.lastCall![2] as FillCandleGapStream;
        expect(await passThroughGapFiller(gapFiller, ['BTC/USDT'])).toEqual([['BTC/USDT']]);
      });

      // A pair whose history ended early was filled with flat candles to the end of the range, which a backtest then traded on
      it('should have the gap filler leave out a pair from the minute the history says it ended before', async () => {
        vi.mocked(MultiAssetHistoricalStream).mockImplementation(function () {
          return {
            hasEndedBefore: (pair: TradingPair, minute: EpochTimeStamp) => pair === 'ETH/USDT' && minute > 0,
          } as MultiAssetHistoricalStream;
        });
        await launchImporter('2024-03-15T09:00:00.000Z');
        const gapFiller = vi.mocked(pipeline).mock.lastCall![2] as FillCandleGapStream;
        expect(await passThroughGapFiller(gapFiller, ['BTC/USDT', 'ETH/USDT'], ['BTC/USDT'])).toEqual([
          ['BTC/USDT', 'ETH/USDT'],
          ['BTC/USDT'],
        ]);
      });

      it('should hand the plugins to the plugins stream', async () => {
        await launchImporter('2024-03-15T09:00:00.000Z');
        expect(PluginsStream).toHaveBeenCalledWith(mockPlugins);
      });

      describe.each`
        position                                    | end
        ${'in the future'}                          | ${'2024-03-15T12:00:00.000Z'}
        ${'later in the minute in progress'}        | ${'2024-03-15T10:20:45.000Z'}
        ${'earlier in the minute in progress'}      | ${'2024-03-15T10:20:10.000Z'}
        ${'at the start of the minute in progress'} | ${'2024-03-15T10:20:00.000Z'}
      `('when daterange.end is $position', ({ end }) => {
        beforeEach(() => launchImporter(end));

        it('should import up to the last closed minute', () => {
          expect(MultiAssetHistoricalStream).toHaveBeenCalledWith({
            daterange: { start: at(pastStart), end: at(lastClosedMinute) },
            tickrate,
            pairs,
          });
        });

        it('should warn once, with both dates', () => {
          expect(vi.mocked(warning).mock.calls).toEqual([
            ['pipeline', `daterange.end ${end} is not a closed minute yet: importing up to the last closed minute, ${lastClosedMinute}.`],
          ]);
        });
      });

      describe.each`
        position                                    | end
        ${'later in the last closed minute'}        | ${'2024-03-15T10:19:59.999Z'}
        ${'at the start of the last closed minute'} | ${'2024-03-15T10:19:00.000Z'}
        ${'in the past'}                            | ${'2024-03-15T09:00:00.000Z'}
      `('when daterange.end is $position', ({ end }) => {
        beforeEach(() => launchImporter(end));

        it('should import up to daterange.end', () => {
          expect(MultiAssetHistoricalStream).toHaveBeenCalledWith({ daterange: { start: at(pastStart), end: at(end) }, tickrate, pairs });
        });

        it('should not warn', () => {
          expect(warning).not.toHaveBeenCalled();
        });
      });

      // On 2026-10-25 Paris goes from 03:00 CEST back to 02:00 CET: the hour from 01:00Z to 02:00Z is the second pass of 02:00-03:00.
      // Floored in local time, an import run in it took the minute closed an hour ago for the last one: it stopped an hour early,
      // and refused a closed minute as one in progress.
      describe('on a host in Europe/Paris, run in the hour repeated when DST ends', () => {
        useTimeZone('Europe/Paris');

        beforeEach(() => {
          vi.setSystemTime(at('2026-10-25T01:30:30.500Z'));
        });

        it.each`
          position                              | end                           | importedEnd
          ${'a closed minute before that hour'} | ${'2026-10-25T00:45:00.000Z'} | ${'2026-10-25T00:45:00.000Z'}
          ${'the last closed minute'}           | ${'2026-10-25T01:29:00.000Z'} | ${'2026-10-25T01:29:00.000Z'}
          ${'in the minute in progress'}        | ${'2026-10-25T01:30:10.000Z'} | ${'2026-10-25T01:29:00.000Z'}
        `('should import up to $importedEnd when daterange.end is $position', async ({ end, importedEnd }) => {
          await launchImporter(end);
          expect(MultiAssetHistoricalStream).toHaveBeenCalledWith({
            daterange: { start: at(pastStart), end: at(importedEnd) },
            tickrate,
            pairs,
          });
        });

        it('should not warn when daterange.end is a closed minute before that hour', async () => {
          await launchImporter('2026-10-25T00:45:00.000Z');
          expect(warning).not.toHaveBeenCalled();
        });
      });

      // The historical stream ends without fetching anything when its range starts after its end
      it('should hand the history a range starting after its end when daterange.start is in the minute in progress', async () => {
        await launchImporter('2024-03-15T12:00:00.000Z', '2024-03-15T10:20:10.000Z');
        expect(MultiAssetHistoricalStream).toHaveBeenCalledWith({
          daterange: { start: at('2024-03-15T10:20:10.000Z'), end: at(lastClosedMinute) },
          tickrate,
          pairs,
        });
      });

      it('should throw an error if daterange is not set in config', async () => {
        (config.getWatch as Mock).mockReturnValue({ daterange: undefined, pairs: [] });
        await expect(streamPipelines.importer(mockPlugins)).rejects.toThrow('daterange is not set');
      });
    });
  });
});
