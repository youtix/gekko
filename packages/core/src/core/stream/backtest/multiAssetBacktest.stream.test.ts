import { TradingPair } from '@gekko/shared/models/utility.types';
import { synchronizeStreams } from '@gekko/shared/helpers/stream/stream.helper';
import type { Storage } from '../../../storage/storage';
import { PassThrough, Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MultiAssetStream } from '../multiAsset.stream';
import { BacktestStream } from './backtest.stream';
import { MultiAssetBacktestStream } from './multiAssetBacktest.stream';

vi.mock('@gekko/shared/helpers/stream/stream.helper', () => ({ synchronizeStreams: vi.fn() }));
vi.mock('./backtest.stream', () => ({
  BacktestStream: vi.fn(function () {
    return new Readable({ objectMode: true, read() {} });
  }),
}));

const pairs: { symbol: TradingPair }[] = [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }];
const daterange = { start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 0, 2) };
const batchSize = 60;
const strategy = { name: 'DEMA' };
const storage = { getCandles: vi.fn() } as unknown as Storage;

describe('MultiAssetBacktestStream', () => {
  let stream: MultiAssetBacktestStream;

  beforeEach(() => {
    vi.mocked(synchronizeStreams).mockReturnValue(new PassThrough({ objectMode: true }));
    stream = new MultiAssetBacktestStream({ pairs, daterange, batchSize, strategy, storage });
  });

  it.each`
    description                                                                                                 | actual                                        | expected
    ${'build one backtest stream per pair, with the range, the batch size, the strategy block and the storage'} | ${() => vi.mocked(BacktestStream).mock.calls} | ${pairs.map(({ symbol }) => [{ daterange, batchSize, strategy, storage, symbol }])}
    ${'be a MultiAssetStream'}                                                                                  | ${() => stream instanceof MultiAssetStream}   | ${true}
  `('should $description', ({ actual, expected }) => {
    expect(actual()).toEqual(expected);
  });
});
