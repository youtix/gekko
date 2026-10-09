import { ONE_MINUTE } from '@constants/time.const';
import { Candle } from '@models/candle.types';
import { TradingPair } from '@models/utility.types';
import { info, warning } from '@services/logger';
import { useTimeZone } from '@utils/date/date.mock';
import { toISOString } from '@utils/date/date.utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FIRST_PAGE_RETRIES } from './historicalCandle.const';
import { HistoricalCandleError } from './historicalCandle.error';
import { HistoricalCandleStream } from './historicalCandle.stream';

const { fetchOHLCV } = vi.hoisted(() => ({ fetchOHLCV: vi.fn() }));

vi.mock('@services/logger', () => ({ info: vi.fn(), warning: vi.fn() }));
vi.mock('@services/injecter/injecter', () => ({ inject: { exchange: vi.fn(() => ({ fetchOHLCV })) } }));

const symbol: TradingPair = 'BTC/USDT';
const START = Date.UTC(2023, 0, 1);
const minute = (n: number) => START + n * ONE_MINUTE;
const candleAt = (start: number): Candle => ({ start, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });

/** An exchange holding the minutes `0` to `lastMinute` and serving `pageSize` candles from the first minute at or after `from` */
const serve =
  (lastMinute: number, pageSize: number) =>
  async (_symbol: TradingPair, { from }: { from: number }): Promise<Candle[]> => {
    const candles: Candle[] = [];
    for (
      let start = Math.ceil(from / ONE_MINUTE) * ONE_MINUTE;
      start <= minute(lastMinute) && candles.length < pageSize;
      start += ONE_MINUTE
    )
      candles.push(candleAt(start));
    return candles;
  };

const createStream = (lastMinuteOfRange: number, tickrate = 0) =>
  new HistoricalCandleStream({ daterange: { start: minute(0), end: minute(lastMinuteOfRange) }, tickrate, symbol });

const readAll = async (stream: HistoricalCandleStream) =>
  ((await stream.toArray()) as { candle: Candle }[]).map(({ candle }) => candle.start);
const settle = () => new Promise(resolve => setImmediate(resolve));
const progressLogs = () =>
  vi
    .mocked(info)
    .mock.calls.map(([, message]) => String(message))
    .filter(message => message.includes('Importing'));

describe('HistoricalCandleStream', () => {
  describe('with an empty range (start after end)', () => {
    let stream: HistoricalCandleStream;
    let starts: number[];

    beforeEach(async () => {
      fetchOHLCV.mockImplementation(serve(10, 10));
      stream = createStream(-1);
      starts = await readAll(stream);
    });

    it.each`
      description                   | actual                                 | expected
      ${'ends without any candle'}  | ${() => starts}                        | ${[]}
      ${'requests nothing'}         | ${() => fetchOHLCV.mock.calls.length}  | ${0}
      ${'logs that nothing is due'} | ${() => vi.mocked(info).mock.lastCall} | ${['stream', '[BTC/USDT] No historical data to download']}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toEqual(expected);
    });
  });

  it('should log the length of a one-minute range', () => {
    createStream(0);
    expect(info).toHaveBeenCalledWith(
      'stream',
      '[BTC/USDT] Fetching historical data from 2023-01-01T00:00:00.000Z to 2023-01-01T00:00:00.000Z (1 minute)',
    );
  });

  // On 2026-10-25 Paris goes from 03:00 CEST back to 02:00 CET: the hour from 01:00Z to 02:00Z is the second pass of 02:00-03:00.
  // Floored in local time, a range starting in it was fetched from an hour earlier: a warmup got an hour of candles too many.
  describe('on a host in Europe/Paris, with a range in the hour repeated when DST ends', () => {
    let starts: number[];

    useTimeZone('Europe/Paris');

    beforeEach(async () => {
      // Every minute up to the end of that hour, in pages of 10 candles
      fetchOHLCV.mockImplementation(async (_symbol: TradingPair, { from }: { from: number }) =>
        Array.from({ length: 10 }, (_, n) => Math.ceil(from / ONE_MINUTE) * ONE_MINUTE + n * ONE_MINUTE)
          .filter(start => start < Date.UTC(2026, 9, 25, 2))
          .map(candleAt),
      );
      const daterange = { start: Date.UTC(2026, 9, 25, 1, 30, 20), end: Date.UTC(2026, 9, 25, 1, 32, 40) };
      starts = await readAll(new HistoricalCandleStream({ daterange, tickrate: 0, symbol }));
    });

    it.each`
      description                             | actual                                    | expected
      ${'request the first page from 01:30Z'} | ${() => fetchOHLCV.mock.calls[0][1].from} | ${Date.UTC(2026, 9, 25, 1, 30)}
      ${'push the minutes 01:30Z to 01:32Z'}  | ${() => starts}                           | ${[30, 31, 32].map(n => Date.UTC(2026, 9, 25, 1, n))}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toEqual(expected);
    });
  });

  describe('when the range spans several pages', () => {
    let stream: HistoricalCandleStream;
    let starts: number[];

    beforeEach(async () => {
      // Pages of 2 candles, and the exchange also holds the minutes after the range
      fetchOHLCV.mockImplementation(serve(10, 2));
      stream = createStream(4);
      starts = await readAll(stream);
    });

    it.each`
      description                                                       | actual                                                     | expected
      ${'push every minute of the range, and none after it'}            | ${() => starts}                                            | ${[0, 1, 2, 3, 4].map(minute)}
      ${'request each page from the millisecond after the last candle'} | ${() => fetchOHLCV.mock.calls.map(([, { from }]) => from)} | ${[minute(0), minute(1) + 1, minute(3) + 1]}
      ${'end the stream'}                                               | ${() => stream.readableEnded}                              | ${true}
      ${'log the number of candles pushed when done'}                   | ${() => vi.mocked(info).mock.lastCall}                     | ${['stream', '[BTC/USDT] Fetched 5 candles']}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toEqual(expected);
    });
  });

  describe('progress', () => {
    it.each`
      lastMinuteOfRange | expected
      ${4}              | ${[1, 2, 3, 4].map(n => `[BTC/USDT] Importing: ${n * 25}% (${toISOString(minute(n))})`)}
      ${0}              | ${[`[BTC/USDT] Importing: 100% (${toISOString(minute(0))})`]}
    `(
      'should log every percent reached by the candles pushed, up to 100%, for a range of $lastMinuteOfRange minutes',
      async ({ lastMinuteOfRange, expected }) => {
        fetchOHLCV.mockImplementation(serve(10, 2));
        await readAll(createStream(lastMinuteOfRange));
        expect(progressLogs()).toEqual(expected);
      },
    );
  });

  describe('when the exchange has no more candle before the end of the range', () => {
    let stream: HistoricalCandleStream;
    let starts: number[];

    beforeEach(async () => {
      fetchOHLCV.mockImplementation(serve(2, 2));
      stream = createStream(4);
      starts = await readAll(stream);
    });

    it.each`
      description                                         | actual                                    | expected
      ${'push the candles received'}                      | ${() => starts}                           | ${[0, 1, 2].map(minute)}
      ${'end the stream'}                                 | ${() => stream.readableEnded}             | ${true}
      ${'warn with the last minute received and the end'} | ${() => vi.mocked(warning).mock.lastCall} | ${['stream', `[BTC/USDT] The exchange returned no candle after ${toISOString(minute(2))}, the last minute received, although the range ends at ${toISOString(minute(4))}: ending the history of this pair early.`]}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toEqual(expected);
    });
  });

  describe('when the exchange never returns any candle', () => {
    let failure: unknown;

    beforeEach(async () => {
      fetchOHLCV.mockResolvedValue([]);
      failure = await readAll(createStream(4)).catch(error => error);
    });

    it.each`
      description                                              | actual                                            | expected
      ${'fail with a HistoricalCandleError'}                   | ${() => failure instanceof HistoricalCandleError} | ${true}
      ${'name the symbol and the range in the error'}          | ${() => (failure as Error).message}               | ${`[STREAM] The exchange returned no BTC/USDT candle from ${toISOString(minute(0))} to ${toISOString(minute(4))} (${EMPTY_FIRST_PAGE_RETRIES + 1} attempts).`}
      ${'retry EMPTY_FIRST_PAGE_RETRIES times before failing'} | ${() => fetchOHLCV.mock.calls.length}             | ${EMPTY_FIRST_PAGE_RETRIES + 1}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toEqual(expected);
    });
  });

  it('should push the candles of a retry that follows an empty first page', async () => {
    const exchange = serve(10, 10);
    fetchOHLCV.mockResolvedValueOnce([]).mockImplementation(exchange);
    expect(await readAll(createStream(2))).toEqual([0, 1, 2].map(minute));
  });

  describe('when a request fails', () => {
    const fetchError = new Error('Network error');
    let stream: HistoricalCandleStream;
    let failure: unknown;

    beforeEach(async () => {
      fetchOHLCV.mockRejectedValue(fetchError);
      stream = createStream(4);
      failure = await readAll(stream).catch(error => error);
    });

    it.each`
      description                   | actual                    | expected
      ${'fail with the same error'} | ${() => failure}          | ${fetchError}
      ${'be destroyed'}             | ${() => stream.destroyed} | ${true}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toBe(expected);
    });
  });

  describe('tickrate', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      fetchOHLCV.mockImplementation(serve(100, 1));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each`
      elapsed | requests
      ${0}    | ${1}
      ${999}  | ${1}
      ${1000} | ${2}
      ${2000} | ${3}
    `('should have sent $requests requests $elapsed ms after the first one, with a tickrate of 1000 ms', async ({ elapsed, requests }) => {
      createStream(100, 1000).resume();
      await vi.advanceTimersByTimeAsync(elapsed);
      expect(fetchOHLCV).toHaveBeenCalledTimes(requests);
    });

    it('should cancel the pending request when destroyed', async () => {
      const stream = createStream(100, 1000);
      stream.resume();
      await vi.advanceTimersByTimeAsync(500);
      stream.destroy();
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchOHLCV).toHaveBeenCalledOnce();
    });
  });

  it('should ignore a page received after being destroyed', async () => {
    let resolvePage: (candles: Candle[]) => void = () => {};
    fetchOHLCV.mockReturnValue(new Promise(resolve => (resolvePage = resolve)));
    const stream = createStream(0);
    stream.resume();
    await settle();
    stream.destroy();
    resolvePage([candleAt(minute(0))]);
    await settle();
    // Only the start of the fetch was logged: no progress, no summary
    expect(info).toHaveBeenCalledOnce();
  });

  describe('back-pressure', () => {
    let stream: HistoricalCandleStream;

    beforeEach(async () => {
      // One page of 40 candles, more than the 16 objects the stream buffers
      fetchOHLCV.mockImplementation(serve(99, 40));
      stream = createStream(99);
      stream.read(0);
      await settle();
    });

    it.each`
      description                                                       | actual                                | expected
      ${'stop pushing once the buffer is full while nobody reads'}      | ${() => stream.readableLength}        | ${16}
      ${'not request the next page before the current one is consumed'} | ${() => fetchOHLCV.mock.calls.length} | ${1}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toBe(expected);
    });

    it('should deliver every candle in order once read', async () => {
      expect(await readAll(stream)).toEqual(Array.from({ length: 100 }, (_, n) => minute(n)));
    });
  });
});
