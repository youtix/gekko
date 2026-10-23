import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { Candle } from '@gekko/shared/models/candle.types';
import { Exchange } from '@gekko/shared/models/exchange.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { info, warning } from '../../../logger/logger';
import { useTimeZone } from '@gekko/shared/utils/date/date.mock';
import { toISOString } from '@gekko/shared/utils/date/date.utils';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { MAX_GAP_FILL_MINUTES } from '../validation/fillCandleGap.const';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FIRST_PAGE_RETRIES } from './historicalCandle.const';
import { HistoricalCandleError } from './historicalCandle.error';
import { HistoricalCandleStream } from './historicalCandle.stream';

vi.mock('../../../logger/logger', () => ({ info: vi.fn(), warning: vi.fn() }));

const fetchOHLCV = vi.fn();
/** The run's exchange, as the pipeline hands it to the stream: only its candles are read */
const exchange = { fetchOHLCV } as unknown as Exchange;
const symbol: TradingPair = 'BTC/USDT';
const START = Date.UTC(2023, 0, 1);
const minute = (n: number) => START + n * ONE_MINUTE;
const candleAt = (start: number): Candle => ({ start, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });

/**
 * An exchange holding the minutes `0` to `lastMinute`, but those of `gap` (first and last minutes missing), and serving `pageSize`
 * candles from the first minute it holds at or after `from`, as Binance does
 */
const serve =
  (lastMinute: number, pageSize: number, gap?: [number, number]) =>
  async (_symbol: TradingPair, { from }: { from: number }): Promise<Candle[]> => {
    const candles: Candle[] = [];
    for (
      let start = Math.ceil(from / ONE_MINUTE) * ONE_MINUTE;
      start <= minute(lastMinute) && candles.length < pageSize;
      start += ONE_MINUTE
    )
      if (!gap || start < minute(gap[0]) || start > minute(gap[1])) candles.push(candleAt(start));
    return candles;
  };

const createStream = (lastMinuteOfRange: number, tickrate = 0) =>
  new HistoricalCandleStream({ exchange, daterange: { start: minute(0), end: minute(lastMinuteOfRange) }, tickrate, symbol });

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

  // On the UTC calendar: on the host's, October 2024 read "30 days 23 hours" in Paris, which leaves summer time on the 27th, and
  // "1 month 1 day" in New York, where it starts on September 30 at 20:00
  describe.each`
    timeZone
    ${'UTC'}
    ${'Europe/Paris'}
    ${'America/New_York'}
  `('on a host in $timeZone', ({ timeZone }) => {
    useTimeZone(timeZone);

    it('should log the length of the minutes of October 2024 as 1 month', () => {
      const daterange = { start: Date.UTC(2024, 9, 1), end: Date.UTC(2024, 9, 31, 23, 59) };
      new HistoricalCandleStream({ exchange, daterange, tickrate: 0, symbol });
      expect(info).toHaveBeenCalledWith(
        'stream',
        '[BTC/USDT] Fetching historical data from 2024-10-01T00:00:00.000Z to 2024-10-31T23:59:00.000Z (1 month)',
      );
    });
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
      starts = await readAll(new HistoricalCandleStream({ exchange, daterange, tickrate: 0, symbol }));
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
      ${'not warn'}                                                     | ${() => vi.mocked(warning).mock.calls}                     | ${[]}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toEqual(expected);
    });
  });

  // The candles after the range were dropped and the minutes the exchange skipped before them with them, without a word: a
  // re-import of the range never got them, and a backtest of it was refused for want of them
  describe.each`
    pageSize | pages
    ${10}    | ${'one page'}
    ${2}     | ${'two pages'}
  `('when the exchange skips the last minutes of the range, but has later ones, read in $pages', ({ pageSize }) => {
    let stream: HistoricalCandleStream;
    let starts: number[];

    beforeEach(async () => {
      // The exchange skips the minutes 3 to 7, and the range ends at 5
      fetchOHLCV.mockImplementation(serve(20, pageSize, [3, 7]));
      stream = createStream(5);
      starts = await readAll(stream);
    });

    it.each`
      description                                                              | actual                                 | expected
      ${'push the candles of the range received'}                              | ${() => starts}                        | ${[0, 1, 2].map(minute)}
      ${'end the stream'}                                                      | ${() => stream.readableEnded}          | ${true}
      ${'warn with the minutes it skipped, the next one and what is left out'} | ${() => vi.mocked(warning).mock.calls} | ${[['stream', `[BTC/USDT] The exchange has no candle from ${toISOString(minute(3))} to ${toISOString(minute(5))}, the end of the range, its next one being at ${toISOString(minute(8))}: ending the history of this pair early, without its last 3 minutes.`]]}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toEqual(expected);
    });
  });

  it.each`
    gap       | lastMinuteOfRange | from | missing
    ${[3, 7]} | ${3}              | ${3} | ${'1 minute'}
    ${[4, 7]} | ${5}              | ${4} | ${'2 minutes'}
  `(
    'should warn that the history ends without its last $missing when the exchange skips the minutes $gap and the range ends at $lastMinuteOfRange',
    async ({ gap, lastMinuteOfRange, from, missing }) => {
      fetchOHLCV.mockImplementation(serve(20, 10, gap));
      await readAll(createStream(lastMinuteOfRange));
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        'stream',
        [
          `[BTC/USDT] The exchange has no candle from ${toISOString(minute(from))} to ${toISOString(minute(lastMinuteOfRange))}, the end of the range,`,
          `its next one being at ${toISOString(minute(8))}: ending the history of this pair early, without its last ${missing}.`,
        ].join(' '),
      );
    },
  );

  // Nothing compared the first candle with the start of the range: an import of a pair listed during the range ended without its first
  // minutes, without a word, and a backtest of the range was then refused for want of them
  describe.each`
    pageSize | pages
    ${10}    | ${'one page'}
    ${2}     | ${'two pages'}
  `('when the exchange has no candle for the first minutes of the range, read in $pages', ({ pageSize }) => {
    let stream: HistoricalCandleStream;
    let starts: number[];

    beforeEach(async () => {
      // The exchange's first candle is at minute 3, and the range ends at 5
      fetchOHLCV.mockImplementation(serve(20, pageSize, [0, 2]));
      stream = createStream(5);
      starts = await readAll(stream);
    });

    it.each`
      description                                                                       | actual                                 | expected
      ${'push the candles of the range from the first one'}                             | ${() => starts}                        | ${[3, 4, 5].map(minute)}
      ${'end the stream'}                                                               | ${() => stream.readableEnded}          | ${true}
      ${'warn once with the minutes it skipped, its first candle and what is left out'} | ${() => vi.mocked(warning).mock.calls} | ${[['stream', `[BTC/USDT] The exchange has no candle from ${toISOString(minute(0))}, the start of the range, to ${toISOString(minute(2))}, its first one being at ${toISOString(minute(3))}: starting the history of this pair late, without its first 3 minutes.`]]}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toEqual(expected);
    });
  });

  // A first candle after the whole range was warned about as the end of a history that never started: "ending the history of this pair
  // early, without its last 6 minutes"
  it.each`
    gap       | first | to                                                   | starting
    ${[0, 0]} | ${1}  | ${toISOString(minute(0))}                            | ${'late, without its first 1 minute'}
    ${[0, 7]} | ${8}  | ${`${toISOString(minute(5))}, the end of the range`} | ${'after the range, without any of its 6 minutes'}
  `(
    'should warn that the history starts $starting when the exchange skips the minutes $gap and the range ends at 5',
    async ({ gap, first, to, starting }) => {
      fetchOHLCV.mockImplementation(serve(20, 10, gap));
      await readAll(createStream(5));
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        'stream',
        [
          `[BTC/USDT] The exchange has no candle from ${toISOString(minute(0))}, the start of the range, to ${to},`,
          `its first one being at ${toISOString(minute(first))}: starting the history of this pair ${starting}.`,
        ].join(' '),
      );
    },
  );

  // The earliest candle of the page, not its first: a page holding a later candle first started the history after the range
  it('should not warn of a late start when the first page holds its earliest candle, at the start of the range, after a later one', async () => {
    fetchOHLCV.mockResolvedValueOnce([8, 0, 1, 2, 3, 4, 5].map(n => candleAt(minute(n))));
    await readAll(createStream(5));
    expect(warning).not.toHaveBeenCalled();
  });

  // Downstream, the gap of one pair among several shows only minute after minute: the gap filler filled it to its end however long
  // it was, and an import stored weeks of flat candles
  describe.each`
    pageSize | pages
    ${10}    | ${'one page'}
    ${1}     | ${'two pages'}
  `(`when the exchange skips more than ${MAX_GAP_FILL_MINUTES} minutes of the range, read in $pages`, ({ pageSize }) => {
    let stream: HistoricalCandleStream;
    let failure: unknown;

    beforeEach(async () => {
      // The exchange skips the minutes 1 to MAX_GAP_FILL_MINUTES + 1
      fetchOHLCV.mockImplementation(serve(MAX_GAP_FILL_MINUTES + 20, pageSize, [1, MAX_GAP_FILL_MINUTES + 1]));
      stream = createStream(MAX_GAP_FILL_MINUTES + 10);
      failure = await readAll(stream).catch(error => error);
    });

    it.each`
      description                                     | actual                                 | expected
      ${'fail with a GekkoError'}                     | ${() => failure instanceof GekkoError} | ${true}
      ${'name the pair, the gap and the bound'}       | ${() => (failure as Error).message}    | ${`[STREAM] The exchange has no BTC/USDT candle from ${toISOString(minute(1))} to ${toISOString(minute(MAX_GAP_FILL_MINUTES + 1))} (${MAX_GAP_FILL_MINUTES + 1} minutes): refusing to fill more than ${MAX_GAP_FILL_MINUTES} minutes with empty candles.`}
      ${'not end the stream as if it were complete'}  | ${() => stream.readableEnded}          | ${false}
      ${'request no page after the one with the gap'} | ${() => fetchOHLCV.mock.calls.length}  | ${pageSize === 1 ? 2 : 1}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toEqual(expected);
    });
  });

  it(`should push the candles around a gap of ${MAX_GAP_FILL_MINUTES} minutes, which the gap filler fills`, async () => {
    fetchOHLCV.mockImplementation(serve(MAX_GAP_FILL_MINUTES + 20, 10, [1, MAX_GAP_FILL_MINUTES]));
    expect(await readAll(createStream(MAX_GAP_FILL_MINUTES + 2))).toEqual(
      [0, MAX_GAP_FILL_MINUTES + 1, MAX_GAP_FILL_MINUTES + 2].map(minute),
    );
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
      ${'warn with the last minute received and the end'} | ${() => vi.mocked(warning).mock.lastCall} | ${['stream', `[BTC/USDT] The exchange returned no candle after ${toISOString(minute(2))}, the last minute received, although the range ends at ${toISOString(minute(4))}: ending the history of this pair early, without its last 2 minutes.`]}
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
