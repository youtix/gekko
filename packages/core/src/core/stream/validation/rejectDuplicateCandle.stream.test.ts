import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { warning } from '../../../logger/logger';
import { toISOString } from '@gekko/shared/utils/date/date.utils';
import { describe, expect, it, vi } from 'vitest';
import { RejectDuplicateCandleStream } from './rejectDuplicateCandle.stream';

vi.mock('../../../logger/logger', () => ({ warning: vi.fn() }));

const T0 = Date.UTC(2024, 0, 1);
const at = (minute: number) => T0 + minute * ONE_MINUTE;

const bucketAt = (minute: number): CandleBucket =>
  new Map([['BTC/USDT', { start: at(minute), open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }]]);

/** Writes the buckets and returns the minutes of those let through */
const run = async (buckets: CandleBucket[]) => {
  const stream = new RejectDuplicateCandleStream();
  for (const bucket of buckets) stream.write(bucket);
  stream.end();
  const output = (await stream.toArray()) as CandleBucket[];
  return output.map(bucket => (bucket.get('BTC/USDT')!.start - T0) / ONE_MINUTE);
};

const throwUnreadable = () => {
  throw new Error('unreadable');
};

describe('RejectDuplicateCandleStream', () => {
  it.each`
    input           | expected
    ${[0, 1, 2]}    | ${[0, 1, 2]}
    ${[0, 0, 1]}    | ${[0, 1]}
    ${[0, 2, 1, 3]} | ${[0, 2, 3]}
    ${[0, 3]}       | ${[0, 3]}
  `('should let the buckets of minutes $expected through out of $input', async ({ input, expected }) => {
    expect(await run(input.map(bucketAt))).toEqual(expected);
  });

  it('should let the bucket itself through', async () => {
    const bucket = bucketAt(0);
    const stream = new RejectDuplicateCandleStream();
    stream.end(bucket);
    expect(await stream.toArray()).toEqual([bucket]);
  });

  it('should drop an empty bucket', async () => {
    const stream = new RejectDuplicateCandleStream();
    stream.end(new Map());
    expect(await stream.toArray()).toEqual([]);
  });

  it.each`
    case              | input        | message
    ${'duplicate'}    | ${[0, 1, 1]} | ${`Duplicate bucket detected @ ${toISOString(at(1))}. Ignoring.`}
    ${'out-of-order'} | ${[0, 2, 1]} | ${`Out-of-order bucket detected @ ${toISOString(at(1))}, after ${toISOString(at(2))}. Ignoring.`}
  `('should warn about a $case bucket', async ({ input, message }) => {
    await run(input.map(bucketAt));
    expect(warning).toHaveBeenCalledExactlyOnceWith('stream', message);
  });

  it('should forward an error thrown while reading a bucket', async () => {
    const unreadable: CandleBucket = new Map([
      ['BTC/USDT', Object.defineProperty(bucketAt(0).get('BTC/USDT')!, 'start', { get: throwUnreadable })],
    ]);
    await expect(run([unreadable])).rejects.toThrow('unreadable');
  });
});
