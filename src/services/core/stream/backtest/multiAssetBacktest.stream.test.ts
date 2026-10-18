import { TradingPair } from '@models/utility.types';
import { synchronizeStreams } from '@helpers/stream/stream.helper';
import { PassThrough, Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MultiAssetStream } from '../multiAsset.stream';
import { BacktestStream } from './backtest.stream';
import { MultiAssetBacktestStream } from './multiAssetBacktest.stream';

vi.mock('@helpers/stream/stream.helper', () => ({ synchronizeStreams: vi.fn() }));
vi.mock('./backtest.stream', () => ({
  BacktestStream: vi.fn(function () {
    return new Readable({ objectMode: true, read() {} });
  }),
}));

const pairs: { symbol: TradingPair }[] = [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }];
const daterange = { start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 0, 2) };

describe('MultiAssetBacktestStream', () => {
  let stream: MultiAssetBacktestStream;

  beforeEach(() => {
    vi.mocked(synchronizeStreams).mockReturnValue(new PassThrough({ objectMode: true }));
    stream = new MultiAssetBacktestStream({ pairs, daterange });
  });

  it.each`
    description                                             | actual                                        | expected
    ${'build one backtest stream per pair, with the range'} | ${() => vi.mocked(BacktestStream).mock.calls} | ${pairs.map(({ symbol }) => [{ daterange, symbol }])}
    ${'be a MultiAssetStream'}                              | ${() => stream instanceof MultiAssetStream}   | ${true}
  `('should $description', ({ actual, expected }) => {
    expect(actual()).toEqual(expected);
  });
});
