import { ONE_MINUTE, ONE_SECOND } from '@gekko/shared/constants/time.const';
import type { GekkoPipelineOptions } from '@gekko/core/core/pipeline/pipeline.types';
import type { RunContext } from '@gekko/core/run/runContext.types';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MockCCXTExchange } from '../mocks/ccxt.mock';
import { MockFetcherService } from '../mocks/fetcher.mock';
import { clearLogs, logStore, MockWinston, type LoggedLine } from '../mocks/winston.mock';
import { advanceClock, fakeTimerCount, isFakeClock, REALTIME_START, startFakeClock, stopFakeClock } from './clock.helper';
import { paperExchange, type RawConfiguration } from './configuration.helper';
import {
  endRealtimeRun,
  mockRealtimeModules,
  realtimeRunContext,
  runRealtimeFor,
  runRealtimeUntil,
  runRealtimeUntilEnd,
  startRealtimeRun,
  useRealtimeConfiguration,
} from './realtimeRun.helper';

mockRealtimeModules();

/** The configuration of the runs, BTC on the paper exchange, which a test changes before the context of its run is built */
const realtimeOf = (assets: RawConfiguration['watch']['assets']): RawConfiguration => ({
  watch: { mode: 'realtime', assets, currency: 'USDT', timeframe: '1m' },
  exchange: paperExchange([{ assetName: 'USDT', balance: 1000 }]),
  plugins: [],
});
let configuration = realtimeOf(['BTC']);
useRealtimeConfiguration(() => configuration);

/**
 * The pipeline the helper runs, in place of gekkoPipeline: it never ends by itself unless `stopsAt` is set, and once its signal is
 * aborted it rejects with an AbortError `endsAfterAbort` ms later, as the plugins are finalised.
 */
const pipeline = {
  context: undefined as RunContext | undefined,
  signal: undefined as AbortSignal | undefined,
  startedAt: undefined as number | undefined,
  endedAt: undefined as number | undefined,
  stopsAt: undefined as number | undefined,
  stop: new Error('Max consecutive order errors reached (5)'),
  endsAfterAbort: 15 * ONE_SECOND,
  ignoresAbort: false,
  failsAsAborted: false,
};
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
// The registry the helper hands the pipeline, which the fake one never reads: the real one would load every plugin and strategy for nothing
mock.module('@gekko/plugins/index', () => ({}));
mock.module('@gekko/core/core/pipeline/pipeline', () => ({
  gekkoPipeline: ({ context, signal }: Pick<GekkoPipelineOptions, 'context' | 'signal'>) => {
    pipeline.context = context;
    pipeline.signal = signal;
    pipeline.startedAt = Date.now();
    return new Promise<void>((_resolve, reject) => {
      const end = (failure: Error) => {
        pipeline.endedAt = Date.now();
        reject(failure);
      };
      if (pipeline.stopsAt !== undefined) setTimeout(() => end(pipeline.stop), pipeline.stopsAt - Date.now());
      signal?.addEventListener('abort', () => {
        if (pipeline.ignoresAbort) return;
        setTimeout(() => end(pipeline.failsAsAborted ? new Error('A bucket failed') : abortError()), pipeline.endsAfterAbort);
      });
    });
  },
}));

/** What a promise rejected with, undefined when it resolved */
const rejectionOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

/** The message of what a promise rejected with, undefined when it resolved */
const rejectionMessageOf = async (promise: Promise<unknown>) => ((await rejectionOf(promise)) as Error | undefined)?.message;

describe('realtimeRun.helper', () => {
  beforeEach(() => {
    clearLogs();
    configuration = realtimeOf(['BTC']);
    Object.assign(pipeline, {
      context: undefined,
      signal: undefined,
      startedAt: undefined,
      endedAt: undefined,
      stopsAt: undefined,
      endsAfterAbort: 15 * ONE_SECOND,
      ignoresAbort: false,
      failsAsAborted: false,
    });
  });

  afterEach(async () => {
    // The end of a run a test left running, which the tests of endRealtimeRun check themselves
    await rejectionOf(endRealtimeRun());
    stopFakeClock();
  });

  describe('mockRealtimeModules', () => {
    it('should mock the logger, ccxt and the fetcher, and leave the clock real', async () => {
      const [winston, ccxt, { fetcher }, { ONE_SECOND: second, ONE_MINUTE: minute }] = await Promise.all([
        import('winston'),
        import('ccxt'),
        import('@gekko/core/fetcher/fetcher.service'),
        import('@gekko/shared/constants/time.const'),
      ]);
      expect<Record<string, unknown>>({
        createLogger: winston.createLogger,
        binance: ccxt.binance,
        isFetcherMocked: fetcher instanceof MockFetcherService,
        ONE_SECOND: second,
        ONE_MINUTE: minute,
      }).toEqual({
        createLogger: MockWinston.createLogger,
        binance: MockCCXTExchange,
        isFetcherMocked: true,
        ONE_SECOND: 1000,
        ONE_MINUTE: 60_000,
      });
    });

    it('should leave the Heart real: it ticks once pumped, then a grace period after each minute boundary', async () => {
      const { Heart } = await import('@gekko/core/core/heart/heart');
      startFakeClock();
      const heart = new Heart(ONE_MINUTE, { gracePeriod: 2 * ONE_SECOND });
      const ticks: string[] = [];
      heart.on('tick', () => ticks.push(new Date(Date.now()).toISOString()));
      heart.pump();
      await advanceClock(2 * ONE_MINUTE);
      heart.stop();
      expect(ticks).toEqual(['2024-01-01T12:00:30.001Z', '2024-01-01T12:01:02.000Z', '2024-01-01T12:02:02.000Z']);
    });
  });

  describe('startRealtimeRun', () => {
    beforeEach(() => startFakeClock());

    it('should start the pipeline at the instant the fake clock was set to', async () => {
      await startRealtimeRun();
      expect(pipeline.startedAt).toBe(REALTIME_START);
    });

    it('should hand the pipeline a signal', async () => {
      await startRealtimeRun();
      expect(pipeline.signal).toBeInstanceOf(AbortSignal);
    });

    it('should hand the pipeline a context built from the configuration as it reads when the run starts', async () => {
      configuration = realtimeOf(['ETH', 'BTC']);
      await startRealtimeRun();
      expect(pipeline.context?.configuration.getWatch().pairs).toEqual([{ symbol: 'ETH/USDT' }, { symbol: 'BTC/USDT' }]);
    });

    it('should go on the context realtimeRunContext built before the run started', async () => {
      const prepared = await realtimeRunContext();
      await startRealtimeRun();
      expect(pipeline.context).toBe(prepared);
    });

    it('should refuse to start a second run while one is in progress', async () => {
      await startRealtimeRun();
      expect(await rejectionMessageOf(startRealtimeRun())).toBe('A realtime run is in progress already: endRealtimeRun ends it');
    });

    it('should refuse to start a run on the real clock', async () => {
      stopFakeClock();
      expect(await rejectionMessageOf(startRealtimeRun())).toBe('A realtime run goes on the fake clock: call startFakeClock() first');
    });
  });

  describe('realtimeRunContext', () => {
    beforeEach(() => startFakeClock());

    it('should hand out the context of the run in progress', async () => {
      await startRealtimeRun();
      expect(await realtimeRunContext()).toBe(pipeline.context!);
    });

    it('should hand out the same context until the run starts', async () => {
      const prepared = await realtimeRunContext();
      configuration = realtimeOf(['ETH']);
      expect(await realtimeRunContext()).toBe(prepared);
    });

    it('should refuse a configuration the schema refuses, with its issues', async () => {
      configuration = realtimeOf(['btc']);
      const failure = await rejectionOf(realtimeRunContext());
      expect((failure as Error).message).toStartWith('[CONFIGURATION] Invalid configuration object:\n');
    });
  });

  describe('runRealtimeUntil', () => {
    beforeEach(() => startFakeClock());

    it('should start a run when none is in progress', async () => {
      await runRealtimeUntil(() => true, { maxMinutes: 1 });
      expect(pipeline.startedAt).toBe(REALTIME_START);
    });

    it('should return at the end of the first minute the condition holds at', async () => {
      await runRealtimeUntil(() => Date.now() >= REALTIME_START + 150 * ONE_SECOND, { maxMinutes: 5 });
      expect(Date.now() - REALTIME_START).toBe(3 * ONE_MINUTE);
    });

    it('should return once maxMinutes are over when the condition never holds', async () => {
      await runRealtimeUntil(() => false, { maxMinutes: 4 });
      expect(Date.now() - REALTIME_START).toBe(4 * ONE_MINUTE);
    });

    it('should throw what ended the run when it ends before the condition holds', async () => {
      pipeline.stopsAt = REALTIME_START + 90 * ONE_SECOND;
      expect(await rejectionOf(runRealtimeUntil(() => false, { maxMinutes: 5 }))).toBe(pipeline.stop);
    });

    it('should stop the clock at the end of the second the run ended in', async () => {
      pipeline.stopsAt = REALTIME_START + 90 * ONE_SECOND + 300;
      await rejectionOf(runRealtimeUntil(() => false, { maxMinutes: 5 }));
      expect(Date.now() - REALTIME_START).toBe(91 * ONE_SECOND);
    });
  });

  describe('runRealtimeFor', () => {
    beforeEach(() => startFakeClock());

    it('should run for the minutes given', async () => {
      await runRealtimeFor({ minutes: 3 });
      expect(Date.now() - REALTIME_START).toBe(3 * ONE_MINUTE);
    });

    it('should throw what ended the run when it ends meanwhile', async () => {
      pipeline.stopsAt = REALTIME_START + 2 * ONE_MINUTE;
      expect(await rejectionOf(runRealtimeFor({ minutes: 3 }))).toBe(pipeline.stop);
    });
  });

  describe('runRealtimeUntilEnd', () => {
    beforeEach(() => startFakeClock());

    it('should return what the run ended with', async () => {
      pipeline.stopsAt = REALTIME_START + 4 * ONE_MINUTE;
      expect(await runRealtimeUntilEnd({ maxMinutes: 10 })).toBe(pipeline.stop);
    });

    it('should return an Error saying the run did not end within maxMinutes', async () => {
      const outcome = (await runRealtimeUntilEnd({ maxMinutes: 2 })) as Error;
      expect(outcome.message).toBe('The realtime run did not end within 2 minutes');
    });
  });

  describe('endRealtimeRun', () => {
    describe('when a run is in progress', () => {
      beforeEach(async () => {
        startFakeClock();
        await runRealtimeFor({ minutes: 1 });
      });

      it('should abort the signal of the run', async () => {
        await endRealtimeRun();
        expect(pipeline.signal?.aborted).toBe(true);
      });

      it('should move the fake clock until the aborted run has ended, and no further', async () => {
        // Date reads the real clock once endRealtimeRun is over: a fake timer reads the fake one as it fires each second, its last
        // reading where the clock stopped
        let clockAtLastSecond = 0;
        setInterval(() => (clockAtLastSecond = Date.now()), ONE_SECOND);
        await endRealtimeRun();
        // The pipeline ends 15 s after its abort, made at the end of the beforeEach's minute
        expect(clockAtLastSecond - (REALTIME_START + ONE_MINUTE)).toBe(15 * ONE_SECOND);
      });

      it('should put the real timers back', async () => {
        await endRealtimeRun();
        expect(isFakeClock()).toBe(false);
      });

      it('should give the next run a context of its own', async () => {
        const ended = pipeline.context;
        await endRealtimeRun();
        expect(await realtimeRunContext()).not.toBe(ended!);
      });

      it('should drop the fake timers left, as the polls of the orders still open: none for a fake clock or on the real one', async () => {
        // Every 5 ms, so that the interval, were it kept on the real clock, would fire within the 30 ms waited below
        let polls = 0;
        setInterval(() => polls++, 5);
        await endRealtimeRun();
        const pollsAtEnd = polls;
        // A fake clock started again, as the next scenario starts it, would fire what it holds
        startFakeClock();
        const fakeTimersLeft = fakeTimerCount();
        stopFakeClock();
        await new Promise(resolve => setTimeout(resolve, 30));
        expect({ fakeTimersLeft, pollsAfterTheEnd: polls - pollsAtEnd }).toEqual({ fakeTimersLeft: 0, pollsAfterTheEnd: 0 });
      });

      it.each<[string, Partial<typeof pipeline>, string]>([
        [
          'should fail when the run does not end within 75 s of its abort',
          { ignoresAbort: true },
          'The realtime run did not end within 75 s of its abort',
        ],
        [
          'should fail when the run fails otherwise than with the AbortError as it is ended',
          { failsAsAborted: true },
          'The realtime run failed as it was ended: A bucket failed',
        ],
      ])('%s', async (_title, behaviour, failure) => {
        Object.assign(pipeline, behaviour);
        expect(await rejectionMessageOf(endRealtimeRun())).toBe(failure);
      });
    });

    it('should forget the context realtimeRunContext built for a run that never started', async () => {
      const prepared = await realtimeRunContext();
      await endRealtimeRun();
      expect(await realtimeRunContext()).not.toBe(prepared);
    });

    describe('when the run ended by itself', () => {
      beforeEach(() => {
        startFakeClock();
        pipeline.stopsAt = REALTIME_START + 90 * ONE_SECOND;
      });

      it('should fail when no runRealtime… call reported the end to the test', async () => {
        await startRealtimeRun();
        await advanceClock(2 * ONE_MINUTE);
        expect(await rejectionMessageOf(endRealtimeRun())).toBe(
          'The realtime run ended by itself, unseen by the test: Max consecutive order errors reached (5)',
        );
      });

      it('should end the test without a failure once runRealtimeUntilEnd returned the end', async () => {
        await runRealtimeUntilEnd({ maxMinutes: 5 });
        expect(await rejectionOf(endRealtimeRun())).toBeUndefined();
      });

      it('should not abort the signal of the run', async () => {
        await runRealtimeUntilEnd({ maxMinutes: 5 });
        await endRealtimeRun();
        expect(pipeline.signal?.aborted).toBe(false);
      });
    });

    it.each<[string, Pick<LoggedLine, 'level' | 'message'>, string | undefined]>([
      [
        'should fail after a failure to finalise logged as a warning',
        { level: 'warn', message: 'Finalization errors: boom' },
        'A plugin failed to finalise: Finalization errors: boom',
      ],
      [
        'should fail after a failure to finalise logged as an error',
        { level: 'error', message: 'Trader failed to finalize: boom; CandleWriter failed to finalize: locked' },
        'A plugin failed to finalise: Trader failed to finalize: boom; CandleWriter failed to finalize: locked',
      ],
      [
        'should not fail after a line on the finalisation at info level',
        { level: 'info', message: 'Finalization of the plugins' },
        undefined,
      ],
      [
        'should not fail after the line PluginsStream logs as an aborted run closes',
        {
          level: 'error',
          message: 'Gekko is closing the application due to an error: AbortError [ABORT_ERR]: The operation was aborted',
        },
        undefined,
      ],
      [
        'should not fail after another warning',
        { level: 'warn', message: 'Application stopped gracefully: [STRATEGY] Max consecutive order errors reached (5)' },
        undefined,
      ],
    ])('%s', async (_title, line, failure) => {
      logStore.push({ ...line, _tag: 'STREAM' });
      expect(await rejectionMessageOf(endRealtimeRun())).toBe(failure);
    });
  });
});
