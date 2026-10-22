import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { Candle } from '@gekko/shared/models/candle.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import type { Storage } from '../../../storage/storage';
import { toISOString } from '@gekko/shared/utils/date/date.utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingCandlesError } from './backtest.error';
import { BacktestStream } from './backtest.stream';

vi.mock('../../../logger/logger', () => ({ debug: vi.fn() }));

const storage = { getCandles: vi.fn(), getCandleDateranges: vi.fn() };

const symbol: TradingPair = 'BTC/USDT';
const START = Date.UTC(2024, 0, 1);
const minute = (n: number) => START + n * ONE_MINUTE;
const candleAt = (start: number): Candle => ({ start, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
/** The stored candles of an interval, every minute of it */
const storedCandles = (_symbol: TradingPair, { start, end }: { start: number; end: number }) => {
  const candles: Candle[] = [];
  for (let time = start; time <= end; time += ONE_MINUTE) candles.push(candleAt(time));
  return candles;
};
// Five minutes, read in batches of two
const daterange = { start: minute(0), end: minute(4) };

/** The stream of BTC/USDT over `daterange`, for a run whose watch section sets `batchSize`, or leaves it out */
const createStream = (batchSize?: number) => new BacktestStream({ daterange, symbol, batchSize, storage: storage as unknown as Storage });
const readAll = async (stream: BacktestStream) => ((await stream.toArray()) as { candle: Candle }[]).map(({ candle }) => candle.start);

describe('BacktestStream', () => {
  beforeEach(() => {
    storage.getCandles.mockImplementation(storedCandles);
  });

  describe('when every minute is stored', () => {
    let stream: BacktestStream;
    let starts: number[];

    beforeEach(async () => {
      stream = createStream(2);
      starts = await readAll(stream);
    });

    it.each`
      description                                   | actual                                                                 | expected
      ${'push every candle of the range, in order'} | ${() => starts}                                                        | ${[0, 1, 2, 3, 4].map(minute)}
      ${'read the database batch by batch'}         | ${() => storage.getCandles.mock.calls.map(([, interval]) => interval)} | ${[{ start: minute(0), end: minute(2) - 1 }, { start: minute(2), end: minute(4) - 1 }, { start: minute(4), end: minute(5) - 1 }]}
      ${'end the stream'}                           | ${() => stream.readableEnded}                                          | ${true}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toEqual(expected);
    });

    it('should push the end again, without failing, when read after the end', () => {
      expect(() => stream._read(0)).not.toThrow();
    });
  });

  it('should read the range in batches of 1440 minutes when no batch size is set', async () => {
    await readAll(createStream());
    expect(storage.getCandles).toHaveBeenCalledOnce();
  });

  describe('when a batch has fewer candles than its minutes', () => {
    let starts: number[];
    let failure: unknown;
    let stream: BacktestStream;

    beforeEach(async () => {
      // The second batch lost its last minute after the date range check
      storage.getCandles.mockImplementation((pair: TradingPair, interval: { start: number; end: number }) =>
        storedCandles(pair, interval).filter(({ start }) => start !== minute(3)),
      );
      storage.getCandleDateranges.mockReturnValue([
        { daterange_start: minute(0), daterange_end: minute(2) },
        { daterange_start: minute(4), daterange_end: minute(4) },
      ]);
      stream = createStream(2);
      starts = [];
      stream.on('data', ({ candle }) => starts.push(candle.start));
      failure = await new Promise(resolve => stream.on('error', resolve));
    });

    it.each`
      description                                           | actual                                          | expected
      ${'fail with a MissingCandlesError'}                  | ${() => failure instanceof MissingCandlesError} | ${true}
      ${'name the batch, the counts and the stored ranges'} | ${() => (failure as Error).message}             | ${`[STREAM] Missing candles in database: BTC/USDT batch ${toISOString(minute(2))} -> ${toISOString(minute(4) - 1)}: expected 2 candles, received 1 (the database may have changed since the date range was checked), Available date ranges: [${toISOString(minute(0))} - ${toISOString(minute(2))}], [${toISOString(minute(4))} - ${toISOString(minute(4))}]`}
      ${'push the candles of the batches before it'}        | ${() => starts}                                 | ${[0, 1].map(minute)}
      ${'be destroyed'}                                     | ${() => stream.destroyed}                       | ${true}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toEqual(expected);
    });
  });
});
