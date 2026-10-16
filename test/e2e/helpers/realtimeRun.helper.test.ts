import { afterEach, describe, expect, it } from 'bun:test';
import { Readable, Writable } from 'node:stream';
import { MockCCXTExchange } from '../mocks/ccxt.mock';
import { MockFetcherService } from '../mocks/fetcher.mock';
import { MockHeart } from '../mocks/heart.mock';
import { clearLogs, logStore, MockWinston, type LoggedLine } from '../mocks/winston.mock';
import { FAST_MINUTE } from './clock.helper';
import { endRealtimeRun, mockRealtimeModules } from './realtimeRun.helper';

mockRealtimeModules();

describe('realtimeRun.helper', () => {
  afterEach(() => clearLogs());

  it('should mock the modules of a realtime flow: the logger, the clock, the Heart, ccxt and the fetcher', async () => {
    const [winston, { ONE_SECOND, ONE_MINUTE }, { Heart }, ccxt, { fetcher }] = await Promise.all([
      import('winston'),
      import('@constants/time.const'),
      import('@services/core/heart/heart'),
      import('ccxt'),
      import('@services/fetcher/fetcher.service'),
    ]);
    expect<Record<string, unknown>>({
      createLogger: winston.createLogger,
      ONE_SECOND,
      ONE_MINUTE,
      Heart,
      binance: ccxt.binance,
      isFetcherMocked: fetcher instanceof MockFetcherService,
    }).toEqual({
      createLogger: MockWinston.createLogger,
      ONE_SECOND: 1,
      ONE_MINUTE: FAST_MINUTE,
      Heart: MockHeart,
      binance: MockCCXTExchange,
      isFetcherMocked: true,
    });
  });

  /**
   * A stream pipeline as gekkoPipeline() runs it in realtime: from a source that never ends into a sink. Given a delay, the sink
   * calls back that much later when it is destroyed, as PluginsStream does once the plugins are finalised.
   */
  const startRun = async (destroyDelay?: number) => {
    const { pipeline } = await import('stream/promises');
    const sink = new Writable({ objectMode: true, write: (_chunk, _encoding, done) => done() });
    if (destroyDelay !== undefined) sink._destroy = (error, callback) => void setTimeout(() => callback(error), destroyDelay);
    let isSettled = false;
    pipeline(new Readable({ objectMode: true, read() {} }), sink).catch(() => (isSettled = true));
    return { sink, isSettled: () => isSettled };
  };

  it('should destroy the last stream of the run in progress', async () => {
    const { sink } = await startRun();
    await endRealtimeRun();
    expect(sink.destroyed).toBe(true);
  });

  it.each([
    ['at once', undefined],
    ['30 ms later', 30],
  ])('should return once the run is over, its last stream destroyed %s', async (_when, destroyDelay) => {
    const { isSettled } = await startRun(destroyDelay);
    await endRealtimeRun();
    expect(isSettled()).toBe(true);
  });

  it('should clear the intervals created since the previous run ended', async () => {
    let ticks = 0;
    setInterval(() => ticks++, 1);
    await endRealtimeRun();
    const ticksAtEnd = ticks;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ticks).toBe(ticksAtEnd);
  });

  it('should stop the hearts', async () => {
    const heart = new MockHeart(1);
    heart.pump();
    await endRealtimeRun();
    expect(heart.isHeartBeating()).toBe(false);
  });

  it.each<[string, Pick<LoggedLine, 'level' | 'message'>, string | undefined]>([
    [
      'should fail after a failure to finalise logged as a warning',
      { level: 'warn', message: 'Finalization errors: boom' },
      'A plugin failed to finalise: Finalization errors: boom',
    ],
    [
      'should fail after a failure to finalise logged as an error',
      { level: 'error', message: 'Finalization failed for Trader: boom' },
      'A plugin failed to finalise: Finalization failed for Trader: boom',
    ],
    [
      'should not fail after a line on the finalisation at info level',
      { level: 'info', message: 'Finalization of the plugins' },
      undefined,
    ],
    [
      'should not fail after another warning',
      { level: 'warn', message: 'Application stopped gracefully: [STRATEGY] Max consecutive order errors reached (5)' },
      undefined,
    ],
  ])('%s', async (_title, line, failure) => {
    logStore.push({ ...line, _tag: 'STREAM' });
    const thrown = await endRealtimeRun().then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(thrown).toBe(failure);
  });
});
