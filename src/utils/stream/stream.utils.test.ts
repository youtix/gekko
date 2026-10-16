import { GekkoError } from '@errors/gekko.error';
import { Candle } from '@models/candle.types';
import { CandleBucket } from '@models/event.types';
import { TradingPair } from '@models/utility.types';
import { sortBy } from 'lodash-es';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { synchronizeStreams } from './stream.utils';

type TradingPairCandle = { symbol: TradingPair; candle: Candle };

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';

/** Start of the nth minute after 2024-01-01T00:00Z */
const minute = (n: number) => Date.UTC(2024, 0, 1, 0, n);
const candleOf = (symbol: TradingPair, start: number): TradingPairCandle => ({
  symbol,
  candle: { start, open: 1, high: 1, low: 1, close: 1, volume: 1 },
});

/** A stream that delivers the given minutes of a pair, then ends */
const finiteStream = (symbol: TradingPair, minutes: number[]) => Readable.from(minutes.map(n => candleOf(symbol, minute(n))));
/** A stream the test feeds, as a live pair's: it holds what is pushed into it and never ends by itself */
const liveStream = () => new Readable({ objectMode: true, read() {} });

/** Each bucket as its candles, in the bucket's own order: base asset and minute, e.g. 'ETH0 BTC0' */
const describeBuckets = (buckets: CandleBucket[]) =>
  buckets.map(bucket => [...bucket].map(([symbol, { start }]) => `${symbol.split('/')[0]}${new Date(start).getUTCMinutes()}`).join(' '));

/** Lets the streams deliver what they were given */
const settle = () => new Promise(resolve => setImmediate(resolve));

/**
 * How the output settles: the buckets it emitted, as describeBuckets writes them, once it ends; its error once it fails; 'pending'
 * when it does neither within a second, a stall
 */
const outcomeOf = async (out: Readable): Promise<unknown> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise(resolve => {
    timer = setTimeout(() => resolve('pending'), 1000);
  });
  try {
    return await Promise.race([out.toArray().then(describeBuckets, (error: unknown) => error), stalled]);
  } finally {
    clearTimeout(timer);
  }
};

describe('synchronizeStreams', () => {
  describe('buckets', () => {
    it.each`
      description                                   | btc       | eth          | expected
      ${'one bucket per minute, in time order'}     | ${[0, 2]} | ${[0, 1, 2]} | ${['BTC0 ETH0', 'ETH1', 'BTC2 ETH2']}
      ${'the other stream going on when BTC ends'}  | ${[0]}    | ${[0, 1]}    | ${['BTC0 ETH0', 'ETH1']}
      ${'the first stream starting a minute later'} | ${[1]}    | ${[0]}       | ${['ETH0', 'BTC1']}
    `('should emit $expected, $description', async ({ btc, eth, expected }) => {
      const out = synchronizeStreams([finiteStream(BTC, btc), finiteStream(ETH, eth)]);
      expect(await outcomeOf(out)).toEqual(expected);
    });

    it('should hold the candles of each bucket in the order of the streams, ETH then BTC, not in the order of their symbols', async () => {
      const buckets: CandleBucket[] = await synchronizeStreams([finiteStream(ETH, [0, 1]), finiteStream(BTC, [0, 1])]).toArray();
      expect(buckets.map(bucket => [...bucket.keys()])).toEqual([
        [ETH, BTC],
        [ETH, BTC],
      ]);
    });

    it('should hold the candles of a bucket in the order of the streams, ETH then BTC, when the BTC candle comes first', async () => {
      const eth = liveStream();
      const btc = liveStream();
      const emitted = synchronizeStreams([eth, btc]).toArray();
      btc.push(candleOf(BTC, minute(0)));
      btc.push(null);
      await settle();
      eth.push(candleOf(ETH, minute(0)));
      eth.push(null);
      const buckets: CandleBucket[] = await emitted;
      expect(buckets.map(bucket => [...bucket.keys()])).toEqual([[ETH, BTC]]);
    });

    it('should end at once, without a bucket, when given no stream', async () => {
      expect(await outcomeOf(synchronizeStreams([]))).toEqual([]);
    });
  });

  // The gap filler could not tell a pair whose stream had ended from one missing for a while: a two-pair import filled the pair whose
  // history ended early with flat candles to the end of the range
  describe('ends', () => {
    it.each`
      description                                                        | btc       | eth             | expected
      ${'the start of the last candle of each stream that ends'}         | ${[0, 1]} | ${[0, 1, 2]}    | ${[[BTC, minute(1)], [ETH, minute(2)]]}
      ${'the start of the last candle of a stream, which follows a gap'} | ${[0, 5]} | ${[0, 1, 2, 3]} | ${[[BTC, minute(5)], [ETH, minute(3)]]}
      ${'no stream that ends before its first candle'}                   | ${[]}     | ${[0]}          | ${[[ETH, minute(0)]]}
    `('should report $description', async ({ btc, eth, expected }) => {
      const onPairEnd = vi.fn();
      await synchronizeStreams([finiteStream(BTC, btc), finiteStream(ETH, eth)], { onPairEnd }).toArray();
      expect(sortBy(onPairEnd.mock.calls, ([pair]) => pair)).toEqual(expected);
    });

    it('should not report the end of a stream that fails', async () => {
      const onPairEnd = vi.fn();
      const failing = liveStream();
      const settled = outcomeOf(synchronizeStreams([failing, finiteStream(ETH, [0, 1])], { onPairEnd }));
      failing.push(candleOf(BTC, minute(0)));
      await settle();
      failing.destroy(new Error('failed'));
      await settled;
      expect(onPairEnd).not.toHaveBeenCalledWith(BTC, expect.anything());
    });
  });

  describe('back-pressure', () => {
    // More minutes than the 16 buckets the output buffers
    const MINUTES = 40;
    let out: Readable;

    beforeEach(() => {
      const streams = [BTC, ETH].map(symbol => {
        const stream = liveStream();
        for (let n = 0; n < MINUTES; n++) stream.push(candleOf(symbol, minute(n)));
        stream.push(null);
        return stream;
      });
      out = synchronizeStreams(streams);
      // Asks for buckets once, then reads none
      out.read(0);
    });

    it('should stop reading the streams once the buckets fill the output up to its high-water mark', () => {
      expect(out.readableLength).toBe(out.readableHighWaterMark);
    });

    it(`should deliver the ${MINUTES} buckets once read again`, async () => {
      expect(await outcomeOf(out)).toHaveLength(MINUTES);
    });
  });

  describe('when a stream fails', () => {
    const failure = new Error('No 1m candle received for BTC/USDT for 5 minutes');
    let other: Readable;
    let errors: unknown[];
    let outcome: unknown;

    beforeEach(async () => {
      const failing = liveStream();
      other = liveStream();
      const out = synchronizeStreams([failing, other]);
      errors = [];
      out.on('error', error => errors.push(error));
      const settled = outcomeOf(out);
      failing.push(candleOf(BTC, minute(0)));
      other.push(candleOf(ETH, minute(0)));
      other.push(candleOf(ETH, minute(1)));
      await settle();
      failing.destroy(failure);
      outcome = await settled;
    });

    it('should fail the output with the error of the stream, not end it nor go on without the pair', () => {
      expect(outcome).toBe(failure);
    });

    it('should emit that error once', () => {
      expect(errors).toHaveLength(1);
    });

    it('should destroy the other streams', () => {
      expect(other.destroyed).toBe(true);
    });
  });

  describe('when a stream closes without ending', () => {
    let other: Readable;
    let outcome: unknown;

    beforeEach(async () => {
      const closing = liveStream();
      other = liveStream();
      const settled = outcomeOf(synchronizeStreams([closing, other]));
      closing.push(candleOf(BTC, minute(0)));
      other.push(candleOf(ETH, minute(0)));
      other.push(candleOf(ETH, minute(1)));
      await settle();
      // Destroyed without an error: the stream emits 'close' alone
      closing.destroy();
      outcome = await settled;
    });

    it('should fail the output with a GekkoError', () => {
      expect(outcome).toBeInstanceOf(GekkoError);
    });

    it('should name the pair and its last candle in the error', () => {
      expect((outcome as Error).message).toBe(
        '[STREAM] The candle stream of BTC/USDT closed before its end (last candle @ 2024-01-01T00:00:00.000Z): the pair no longer delivers.',
      );
    });

    it('should destroy the other streams', () => {
      expect(other.destroyed).toBe(true);
    });

    it('should name the position of a stream that closes before its first candle', async () => {
      const closing = liveStream();
      const settled = outcomeOf(synchronizeStreams([liveStream(), closing]));
      closing.destroy();
      expect(((await settled) as Error).message).toBe(
        '[STREAM] Candle stream 2 of 2 closed before its end and before its first candle: its pair never delivered.',
      );
    });
  });

  describe('when the output is destroyed', () => {
    it.each`
      description           | error
      ${'without an error'} | ${undefined}
      ${'with an error'}    | ${new Error('stopped')}
    `('should destroy every stream when destroyed $description', ({ error }) => {
      const streams = [liveStream(), liveStream()];
      const out = synchronizeStreams(streams);
      out.on('error', () => {});
      out.destroy(error);
      expect(streams.map(stream => stream.destroyed)).toEqual([true, true]);
    });

    it('should emit no error as its streams close when destroyed without one', async () => {
      const out = synchronizeStreams([liveStream(), liveStream()]);
      const onError = vi.fn();
      out.on('error', onError);
      out.destroy();
      await settle();
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('when a candle has a start that is not a finite number', () => {
    it.each`
      start
      ${NaN}
      ${Infinity}
      ${-Infinity}
      ${undefined}
    `('should fail the output with an error naming the pair and the start $start', async ({ start }) => {
      const eth = Readable.from([candleOf(ETH, minute(0)), candleOf(ETH, start)]);
      const outcome = await outcomeOf(synchronizeStreams([finiteStream(BTC, [0, 1]), eth]));
      expect((outcome as Error).message).toBe(
        `[STREAM] Received a candle of ETH/USDT whose start is ${start}, not a timestamp: it cannot be synchronised with the other pairs.`,
      );
    });

    it('should fail the output with a GekkoError', async () => {
      const out = synchronizeStreams([finiteStream(BTC, [0]), Readable.from([candleOf(ETH, NaN)])]);
      expect(await outcomeOf(out)).toBeInstanceOf(GekkoError);
    });

    it('should fail the output, not end it without a bucket, when every stream starts with one', async () => {
      const out = synchronizeStreams([Readable.from([candleOf(BTC, NaN)]), Readable.from([candleOf(ETH, NaN)])]);
      expect(await outcomeOf(out)).toBeInstanceOf(GekkoError);
    });
  });
});
