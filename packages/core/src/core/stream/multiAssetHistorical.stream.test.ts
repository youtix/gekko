import { TradingPair } from '@gekko/shared/models/utility.types';
import { synchronizeStreams } from '@gekko/shared/helpers/stream/stream.helper';
import { PassThrough, Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoricalCandleStream } from './historicalCandle/historicalCandle.stream';
import { MultiAssetStream } from './multiAsset.stream';
import { MultiAssetHistoricalStream } from './multiAssetHistorical.stream';

vi.mock('@gekko/shared/helpers/stream/stream.helper', () => ({ synchronizeStreams: vi.fn() }));
vi.mock('./historicalCandle/historicalCandle.stream', () => ({
  HistoricalCandleStream: vi.fn(function () {
    return new Readable({ objectMode: true, read() {} });
  }),
}));

const pairs: { symbol: TradingPair }[] = [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }];
const daterange = { start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 0, 2) };
const tickrate = 1000;

describe('MultiAssetHistoricalStream', () => {
  let stream: MultiAssetHistoricalStream;

  beforeEach(() => {
    vi.mocked(synchronizeStreams).mockReturnValue(new PassThrough({ objectMode: true }));
    stream = new MultiAssetHistoricalStream({ pairs, daterange, tickrate });
  });

  it.each`
    description                                                         | actual                                                | expected
    ${'build one history stream per pair, with the range and tickrate'} | ${() => vi.mocked(HistoricalCandleStream).mock.calls} | ${pairs.map(({ symbol }) => [{ daterange, tickrate, symbol }])}
    ${'be a MultiAssetStream'}                                          | ${() => stream instanceof MultiAssetStream}           | ${true}
  `('should $description', ({ actual, expected }) => {
    expect(actual()).toEqual(expected);
  });
});
