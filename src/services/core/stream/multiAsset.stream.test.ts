import { TradingPair } from '@models/utility.types';
import { synchronizeStreams } from '@helpers/stream/stream.helper';
import { PassThrough, Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MultiAssetStream } from './multiAsset.stream';

vi.mock('@helpers/stream/stream.helper', () => ({ synchronizeStreams: vi.fn() }));

const pairs: { symbol: TradingPair }[] = [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }];
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('MultiAssetStream', () => {
  let synchronized: PassThrough;
  let createStream: ReturnType<typeof vi.fn<(symbol: TradingPair) => Readable>>;
  let stream: MultiAssetStream;

  beforeEach(() => {
    synchronized = new PassThrough({ objectMode: true });
    vi.mocked(synchronizeStreams).mockReturnValue(synchronized);
    createStream = vi.fn((symbol: TradingPair) => Readable.from([symbol]));
    stream = new MultiAssetStream(pairs, createStream);
  });

  it('should create one stream per pair', () => {
    expect(createStream.mock.calls).toEqual([['BTC/USDT'], ['ETH/USDT']]);
  });

  it('should synchronise the streams created', () => {
    const created = createStream.mock.results.map(({ value }) => value);
    expect(vi.mocked(synchronizeStreams).mock.calls[0][0].every((synchronizedSource, i) => synchronizedSource === created[i])).toBe(true);
  });

  it('should emit the buckets of the synchronised stream, in order, then end', async () => {
    synchronized.write('bucket 1');
    synchronized.end('bucket 2');
    expect(await stream.toArray()).toEqual(['bucket 1', 'bucket 2']);
  });

  describe('back-pressure', () => {
    beforeEach(async () => {
      // More buckets than the 16 objects this stream buffers, and nobody reads
      for (let i = 0; i < 20; i++) synchronized.write(`bucket ${i}`);
      await settle();
    });

    it('should pause the synchronised stream once its buffer is full', () => {
      expect(synchronized.isPaused()).toBe(true);
    });

    it('should resume the synchronised stream when read again', () => {
      stream.read();
      expect(synchronized.isPaused()).toBe(false);
    });

    it('should deliver every bucket once read', async () => {
      synchronized.end();
      expect(await stream.toArray()).toHaveLength(20);
    });
  });

  describe('when the synchronised stream fails', () => {
    const failure = new Error('pair failed');
    let emitted: unknown;

    beforeEach(async () => {
      const errorEmitted = new Promise(resolve => stream.once('error', resolve));
      synchronized.destroy(failure);
      emitted = await errorEmitted;
    });

    it.each`
      description         | actual                    | expected
      ${'emit its error'} | ${() => emitted}          | ${failure}
      ${'be destroyed'}   | ${() => stream.destroyed} | ${true}
    `('should $description', ({ actual, expected }) => {
      expect(actual()).toBe(expected);
    });
  });

  describe('pairs whose stream ended', () => {
    const minute = (n: number) => Date.UTC(2024, 0, 1, 0, n);

    beforeEach(() => {
      // BTC's stream ended with its candle of minute 3, as the synchronised stream reports it
      vi.mocked(synchronizeStreams).mock.calls[0][1]!.onPairEnd!('BTC/USDT', minute(3));
    });

    it.each`
      pair          | at   | expected
      ${'BTC/USDT'} | ${4} | ${true}
      ${'BTC/USDT'} | ${3} | ${false}
      ${'ETH/USDT'} | ${4} | ${false}
    `('should tell that the stream of $pair ended before minute $at: $expected', ({ pair, at, expected }) => {
      expect(stream.hasEndedBefore(pair, minute(at))).toBe(expected);
    });
  });

  describe('when destroyed', () => {
    it.each`
      error                   | description
      ${new Error('stopped')} | ${'with an error'}
      ${undefined}            | ${'without an error'}
    `('should destroy the synchronised stream $description', async ({ error }) => {
      stream.on('error', () => {});
      synchronized.on('error', () => {});
      stream.destroy(error);
      await settle();
      expect(synchronized.destroyed).toBe(true);
    });

    it('should pass its error to the synchronised stream', async () => {
      const error = new Error('stopped');
      const received = new Promise(resolve => synchronized.once('error', resolve));
      stream.on('error', () => {});
      stream.destroy(error);
      expect(await received).toBe(error);
    });
  });
});
