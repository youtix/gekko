import { CandleBucket } from '@gekko/shared/models/event.types';
import { warning } from '../../../logger/logger';
import { toISOString } from '@gekko/shared/utils/date/date.utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RejectFutureCandleStream } from './rejectFutureCandle.stream';

vi.mock('../../../logger/logger', () => ({ warning: vi.fn() }));

const NOW = Date.UTC(2024, 0, 1, 12, 0, 30);

const bucketStarting = (start: EpochTimeStamp): CandleBucket =>
  new Map([['BTC/USDT', { start, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }]]);

const run = async (bucket: CandleBucket) => {
  const stream = new RejectFutureCandleStream();
  stream.end(bucket);
  return (await stream.toArray()) as CandleBucket[];
};

const throwUnreadable = () => {
  throw new Error('unreadable');
};

describe('RejectFutureCandleStream', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each`
    case                        | start            | expected
    ${'closed long ago'}        | ${NOW - 600_000} | ${1}
    ${'closed right now'}       | ${NOW - 60_000}  | ${1}
    ${'closing in 1 ms'}        | ${NOW - 59_999}  | ${0}
    ${'in progress'}            | ${NOW - 30_000}  | ${0}
    ${'starting in the future'} | ${NOW + 60_000}  | ${0}
  `('should let through $expected bucket of a candle $case', async ({ start, expected }) => {
    expect(await run(bucketStarting(start))).toHaveLength(expected);
  });

  it('should let the bucket itself through', async () => {
    const bucket = bucketStarting(NOW - 60_000);
    expect(await run(bucket)).toEqual([bucket]);
  });

  it('should warn about a rejected bucket', async () => {
    await run(bucketStarting(NOW - 30_000));
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'stream',
      `Rejecting future bucket: candle end time ${toISOString(NOW + 30_000)} is in the future.`,
    );
  });

  it('should not warn about a bucket let through', async () => {
    await run(bucketStarting(NOW - 60_000));
    expect(warning).not.toHaveBeenCalled();
  });

  it('should drop an empty bucket', async () => {
    expect(await run(new Map())).toEqual([]);
  });

  it('should forward an error thrown while reading a bucket', async () => {
    const unreadable: CandleBucket = new Map([
      ['BTC/USDT', Object.defineProperty(bucketStarting(NOW).get('BTC/USDT')!, 'start', { get: throwUnreadable })],
    ]);
    await expect(run(unreadable)).rejects.toThrow('unreadable');
  });
});
