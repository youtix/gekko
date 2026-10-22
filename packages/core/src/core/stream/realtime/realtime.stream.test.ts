import {
  REALTIME_GRACE_PERIOD,
  REALTIME_MAX_CANDLES_PER_FETCH,
  REALTIME_MAX_TICKS_WITHOUT_CANDLE,
} from '@gekko/shared/constants/realtime.const';
import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { Candle } from '@gekko/shared/models/candle.types';
import { inject } from '../../../injecter/injecter';
import { debug, warning } from '../../../logger/logger';
import { useTimeZone } from '@gekko/shared/utils/date/date.mock';
import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { RealtimeStream } from './realtime.stream';

vi.mock('../../../logger/logger', () => ({ debug: vi.fn(), warning: vi.fn() }));
vi.mock('../../../injecter/injecter', () => ({ inject: { exchange: vi.fn() } }));

describe('RealtimeStream', () => {
  /** Start of the nth minute after 2024-01-01T00:00Z (the stream starts with minute 0, the one in progress when it is built) */
  const minute = (n: number) => Date.UTC(2024, 0, 1, 0, n);
  const iso = (n: number) => new Date(minute(n)).toISOString();
  const candle = (n: number): Candle => ({ start: minute(n), open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 + n });
  /** When the heart ticks for the nth time after its first tick: a grace period after the end of minute n - 1 */
  const tickTime = (n: number) => minute(n) + REALTIME_GRACE_PERIOD;

  const fetchOHLCV = vi.fn();
  const getExchangeName = vi.fn();
  const onError = vi.fn();
  const onUnhandledRejection = vi.fn();
  let stream: RealtimeStream;

  /** Runs the clock up to the nth tick, then lets the fetches it started settle */
  const runUntilTick = async (n: number) => {
    await vi.advanceTimersByTimeAsync(tickTime(n) - Date.now());
    await new Promise(resolve => setImmediate(resolve));
  };
  const readAll = () => {
    const chunks: unknown[] = [];
    for (let chunk = stream.read(); chunk !== null; chunk = stream.read()) chunks.push(chunk);
    return chunks;
  };
  /** A fetch that settles when the test says so */
  const deferredFetch = () => {
    const deferred: { resolve: (candles: Candle[]) => void; reject: (reason: unknown) => void } = { resolve: () => {}, reject: () => {} };
    fetchOHLCV.mockReturnValueOnce(
      new Promise<Candle[]>((resolve, reject) => {
        Object.assign(deferred, { resolve, reject });
      }),
    );
    return deferred;
  };

  beforeEach(() => {
    // setImmediate stays real, to let promises settle and unhandled rejections surface
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(minute(0) + 500); // Just after a minute boundary
    getExchangeName.mockReturnValue('binance');
    fetchOHLCV.mockResolvedValue([]);
    (inject.exchange as Mock).mockReturnValue({ fetchOHLCV, getExchangeName });
    process.on('unhandledRejection', onUnhandledRejection);
    stream = new RealtimeStream('BTC/USDT', minute(0));
    stream.on('error', onError);
  });

  afterEach(() => {
    stream.destroy();
    process.off('unhandledRejection', onUnhandledRejection);
    vi.useRealTimers();
  });

  describe('first fetch', () => {
    it('should fetch nothing on the tick that follows its construction', async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchOHLCV).not.toHaveBeenCalled();
    });

    it.each`
      time               | calls
      ${tickTime(1) - 1} | ${0}
      ${tickTime(1)}     | ${1}
      ${tickTime(2) - 1} | ${1}
      ${tickTime(2)}     | ${2}
    `('should have fetched $calls time(s) at $time', async ({ time, calls }) => {
      await vi.advanceTimersByTimeAsync(time - Date.now());
      expect(fetchOHLCV).toHaveBeenCalledTimes(calls);
    });

    it('should ask for its start minute once it is closed', async () => {
      await runUntilTick(1);
      expect(fetchOHLCV).toHaveBeenCalledExactlyOnceWith('BTC/USDT', { from: minute(0), limit: 1 });
    });

    it('should push the fetched candle with its symbol', async () => {
      fetchOHLCV.mockResolvedValue([candle(0)]);
      await runUntilTick(1);
      expect(readAll()).toEqual([{ symbol: 'BTC/USDT', candle: candle(0) }]);
    });

    it('should log the pushed candle at debug level', async () => {
      fetchOHLCV.mockResolvedValue([candle(0)]);
      await runUntilTick(1);
      expect(debug).toHaveBeenCalledWith('stream', `1m candle from binance for BTC/USDT @ ${iso(0)}  O:1 H:2 L:0.5 C:1.5 V:100`);
    });

    it('should ask for the next minute on the next tick', async () => {
      fetchOHLCV.mockResolvedValueOnce([candle(0)]).mockResolvedValueOnce([candle(1)]);
      await runUntilTick(2);
      expect(fetchOHLCV).toHaveBeenLastCalledWith('BTC/USDT', { from: minute(1), limit: 1 });
    });
  });

  describe('when built just before a minute boundary', () => {
    let lateStream: RealtimeStream;

    beforeEach(() => {
      stream.destroy();
      vi.setSystemTime(minute(0) - 1);
      lateStream = new RealtimeStream('BTC/USDT', minute(-1));
    });

    afterEach(() => {
      lateStream.destroy();
    });

    // The first tick comes right after pump(): the minute that has just closed is fetched only a grace period after its end
    it.each`
      firstTick                            | calls
      ${minute(0) + 1}                     | ${0}
      ${minute(0) + REALTIME_GRACE_PERIOD} | ${1}
    `('should have fetched $calls time(s) when its first tick comes at $firstTick', async ({ firstTick, calls }) => {
      vi.setSystemTime(firstTick);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchOHLCV).toHaveBeenCalledTimes(calls);
    });
  });

  // On 2026-10-25 Paris goes from 03:00 CEST back to 02:00 CET: the hour from 01:00Z to 02:00Z is the second pass of 02:00-03:00.
  // Floored in local time, its minutes came back an hour early: no tick of that hour fetched anything, then one pushed 61 minutes.
  describe('on a host in Europe/Paris, around the hour repeated when DST ends', () => {
    let dstStream: RealtimeStream;

    useTimeZone('Europe/Paris');

    afterEach(() => {
      dstStream?.destroy();
    });

    // Built just after the boundary of `startMinute`, the minute in progress, which the tick a grace period after its end asks for
    it.each`
      startMinute               | nextMinute
      ${'2026-10-25T00:59:00Z'} | ${'2026-10-25T01:00:00Z'}
      ${'2026-10-25T01:09:00Z'} | ${'2026-10-25T01:10:00Z'}
      ${'2026-10-25T01:59:00Z'} | ${'2026-10-25T02:00:00Z'}
    `(
      'should ask a grace period after $nextMinute for the minute of $startMinute, the last one closed',
      async ({ startMinute, nextMinute }) => {
        stream.destroy();
        vi.setSystemTime(Date.parse(startMinute) + 500);
        dstStream = new RealtimeStream('BTC/USDT', Date.parse(startMinute));
        await vi.advanceTimersByTimeAsync(Date.parse(nextMinute) + REALTIME_GRACE_PERIOD - Date.now());
        expect(fetchOHLCV).toHaveBeenCalledExactlyOnceWith('BTC/USDT', { from: Date.parse(startMinute), limit: 1 });
      },
    );
  });

  // The pipeline reads the clock once for every pair: a stream built after a slow start-up still starts with the minute it is given
  describe('when built after its start minute has closed', () => {
    let lateStream: RealtimeStream;

    beforeEach(() => {
      stream.destroy();
      vi.setSystemTime(tickTime(2) + 500); // Minutes 0 and 1 have closed, the grace period included
      lateStream = new RealtimeStream('BTC/USDT', minute(0));
    });

    afterEach(() => {
      lateStream.destroy();
    });

    it('should ask on its first tick for every minute closed since its start minute', async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchOHLCV).toHaveBeenCalledExactlyOnceWith('BTC/USDT', { from: minute(0), limit: 2 });
    });
  });

  describe('when a fetch fails', () => {
    beforeEach(async () => {
      fetchOHLCV.mockRejectedValueOnce(new Error('Request timed out'));
      await runUntilTick(1);
    });

    it('should warn with the pair and the minute', () => {
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        'stream',
        `Failed to fetch the 1m candles of BTC/USDT from ${iso(0)}, retrying on the next tick: Request timed out`,
      );
    });

    it('should not leave an unhandled rejection', () => {
      expect(onUnhandledRejection).not.toHaveBeenCalled();
    });

    it('should not fail the stream', () => {
      expect(onError).not.toHaveBeenCalled();
    });

    it('should ask again for the missed minute, with the one closed since, on the next tick', async () => {
      await runUntilTick(2);
      expect(fetchOHLCV).toHaveBeenLastCalledWith('BTC/USDT', { from: minute(0), limit: 2 });
    });
  });

  // Quoted under the stream's tag: a GekkoError without its own, which showed two tags, a string as it is, and a value without a
  // prototype as util.inspect writes it: String() threw for it, from the catch meant to warn, and the tick rejected unhandled
  it.each`
    failure                          | rejection                                                                     | reason
    ${'a GekkoError'}                | ${new GekkoError('exchange', 'binance GET /api/v3/klines request timed out')} | ${'binance GET /api/v3/klines request timed out'}
    ${'a string'}                    | ${'socket hang up'}                                                           | ${'socket hang up'}
    ${'a value without a prototype'} | ${Object.assign(Object.create(null), { status: 503 })}                        | ${'[Object: null prototype] { status: 503 }'}
  `('should warn with the reason of a fetch rejected with $failure: $reason', async ({ rejection, reason }) => {
    fetchOHLCV.mockRejectedValueOnce(rejection);
    await runUntilTick(1);
    expect(warning).toHaveBeenCalledWith(
      'stream',
      `Failed to fetch the 1m candles of BTC/USDT from ${iso(0)}, retrying on the next tick: ${reason}`,
    );
  });

  describe('when two minutes were missed', () => {
    beforeEach(async () => {
      fetchOHLCV.mockRejectedValueOnce(new Error('Request timed out')).mockResolvedValueOnce([]);
      // Unordered, as an exchange could serve them
      fetchOHLCV.mockResolvedValueOnce([candle(2), candle(0), candle(1)]);
      await runUntilTick(3);
    });

    it('should ask for every closed minute not pushed yet', () => {
      expect(fetchOHLCV).toHaveBeenLastCalledWith('BTC/USDT', { from: minute(0), limit: 3 });
    });

    it('should push the missed minutes, then the last one, in order', () => {
      expect(readAll()).toEqual([0, 1, 2].map(n => ({ symbol: 'BTC/USDT', candle: candle(n) })));
    });
  });

  it(`should ask for at most ${REALTIME_MAX_CANDLES_PER_FETCH} minutes at once`, async () => {
    // The first tick comes after a blocked event loop: thousands of minutes have closed since the stream was built
    vi.setSystemTime(tickTime(2 * REALTIME_MAX_CANDLES_PER_FETCH));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchOHLCV).toHaveBeenCalledExactlyOnceWith('BTC/USDT', { from: minute(0), limit: REALTIME_MAX_CANDLES_PER_FETCH });
  });

  describe('when the exchange serves the minute in progress instead of the closed one', () => {
    beforeEach(async () => {
      fetchOHLCV.mockResolvedValue([candle(1)]);
      await runUntilTick(1);
    });

    it('should not push it', () => {
      expect(readAll()).toEqual([]);
    });

    it('should log that it ignored it at debug level', () => {
      expect(debug).toHaveBeenCalledWith('stream', `Ignored the unfinished 1m candle of BTC/USDT @ ${iso(1)}`);
    });

    it('should warn that it received no candle for the pair and the minute', () => {
      expect(warning).toHaveBeenCalledExactlyOnceWith('stream', `Received undefined candle for BTC/USDT @ ${iso(0)}`);
    });
  });

  describe('when the exchange serves a minute already pushed', () => {
    beforeEach(async () => {
      fetchOHLCV.mockResolvedValue([candle(-1), candle(0)]);
      await runUntilTick(1);
    });

    it('should push only the new minute', () => {
      expect(readAll()).toEqual([{ symbol: 'BTC/USDT', candle: candle(0) }]);
    });

    it('should warn that it ignored the duplicate', () => {
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        'stream',
        `Ignored a duplicate 1m candle of BTC/USDT @ ${iso(-1)}: already delivered`,
      );
    });
  });

  describe('when the pair no longer delivers', () => {
    const failure = new GekkoError(
      'stream',
      `No 1m candle received for BTC/USDT for ${REALTIME_MAX_TICKS_WITHOUT_CANDLE} minutes (last one @ ${iso(-1)}): the pair no longer delivers.`,
    );

    it.each`
      outcome            | fetch
      ${'empty answers'} | ${() => fetchOHLCV.mockResolvedValue([])}
      ${'rejections'}    | ${() => fetchOHLCV.mockRejectedValue(new Error('binance {"code":-1121,"msg":"Invalid symbol."}'))}
    `('should fail with a GekkoError after $outcome on consecutive ticks', async ({ fetch }) => {
      fetch();
      await runUntilTick(REALTIME_MAX_TICKS_WITHOUT_CANDLE);
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    });

    it('should not fail one tick before', async () => {
      await runUntilTick(REALTIME_MAX_TICKS_WITHOUT_CANDLE - 1);
      expect(onError).not.toHaveBeenCalled();
    });

    it('should count again from zero after a pushed candle', async () => {
      fetchOHLCV.mockResolvedValue([]);
      for (let n = 1; n < REALTIME_MAX_TICKS_WITHOUT_CANDLE; n++) fetchOHLCV.mockResolvedValueOnce([]);
      fetchOHLCV.mockResolvedValueOnce([0, 1, 2, 3, 4].map(candle));
      await runUntilTick(2 * REALTIME_MAX_TICKS_WITHOUT_CANDLE - 1);
      expect(onError).not.toHaveBeenCalled();
    });

    it('should stop ticking once failed', async () => {
      await runUntilTick(REALTIME_MAX_TICKS_WITHOUT_CANDLE + 3);
      expect(fetchOHLCV).toHaveBeenCalledTimes(REALTIME_MAX_TICKS_WITHOUT_CANDLE);
    });
  });

  describe('when a fetch takes longer than a minute', () => {
    let fetch: ReturnType<typeof deferredFetch>;

    beforeEach(async () => {
      fetch = deferredFetch();
      await runUntilTick(2);
    });

    it('should not fetch again while it is in flight', () => {
      expect(fetchOHLCV).toHaveBeenCalledOnce();
    });

    it('should push what it brings back', async () => {
      fetch.resolve([candle(0)]);
      await new Promise(resolve => setImmediate(resolve));
      expect(readAll()).toEqual([{ symbol: 'BTC/USDT', candle: candle(0) }]);
    });

    it('should ask on the next tick for the minutes closed since', async () => {
      fetch.resolve([candle(0)]);
      await runUntilTick(3);
      expect(fetchOHLCV).toHaveBeenLastCalledWith('BTC/USDT', { from: minute(1), limit: 2 });
    });

    it('should count the ticks it spans towards the failure of the pair', async () => {
      await runUntilTick(REALTIME_MAX_TICKS_WITHOUT_CANDLE + 1);
      expect(onError).toHaveBeenCalledOnce();
    });
  });

  describe('when destroyed while a fetch is in flight', () => {
    let fetch: ReturnType<typeof deferredFetch>;

    beforeEach(async () => {
      fetch = deferredFetch();
      await runUntilTick(1);
      stream.destroy();
    });

    it.each`
      outcome       | settle
      ${'resolves'} | ${() => fetch.resolve([candle(0)])}
      ${'rejects'}  | ${() => fetch.reject(new Error('Request timed out'))}
    `('should not fail when the fetch $outcome', async ({ settle }) => {
      settle();
      await new Promise(resolve => setImmediate(resolve));
      expect(onError).not.toHaveBeenCalled();
    });

    it.each`
      outcome       | settle
      ${'resolves'} | ${() => fetch.resolve([])}
      ${'rejects'}  | ${() => fetch.reject(new Error('Request timed out'))}
    `('should not warn when the fetch $outcome', async ({ settle }) => {
      settle();
      await new Promise(resolve => setImmediate(resolve));
      expect(warning).not.toHaveBeenCalled();
    });

    it('should not push what the fetch brings back', async () => {
      const push = vi.spyOn(stream, 'push');
      fetch.resolve([candle(0)]);
      await new Promise(resolve => setImmediate(resolve));
      expect(push).not.toHaveBeenCalled();
    });
  });

  it('should stop ticking once destroyed', async () => {
    stream.destroy();
    await runUntilTick(3);
    expect(fetchOHLCV).not.toHaveBeenCalled();
  });

  it('should fail with the error of its heart when a tick comes too late', async () => {
    await runUntilTick(1);
    vi.setSystemTime(Date.now() + 4 * ONE_MINUTE); // The machine slept: the next tick comes four minutes late
    await runUntilTick(7);
    expect(onError).toHaveBeenCalledExactlyOnceWith(new GekkoError('core', 'Failed to tick in time'));
  });

  it('should fail with an unexpected error thrown while handling a tick', async () => {
    const unexpected = new Error('getExchangeName is not a function');
    getExchangeName.mockImplementation(() => {
      throw unexpected;
    });
    fetchOHLCV.mockResolvedValue([candle(0)]);
    await runUntilTick(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(unexpected);
  });
});
