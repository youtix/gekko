import { CandleBucket } from '@models/event.types';
import { warning } from '@services/logger';
import { getBucketTimestamp } from '@helpers/candle/candle.helper';
import { toISOString } from '@utils/date/date.utils';
import { Transform, TransformCallback } from 'node:stream';

export class RejectDuplicateCandleStream extends Transform {
  private lastBucketTimestamp?: EpochTimeStamp;

  constructor() {
    super({ objectMode: true });
  }

  _transform(bucket: CandleBucket, _: BufferEncoding, next: TransformCallback) {
    try {
      const bucketTimestamp = getBucketTimestamp(bucket);
      if (bucketTimestamp === undefined) return next();

      if (this.lastBucketTimestamp !== undefined && bucketTimestamp <= this.lastBucketTimestamp) {
        warning(
          'stream',
          bucketTimestamp === this.lastBucketTimestamp
            ? `Duplicate bucket detected @ ${toISOString(bucketTimestamp)}. Ignoring.`
            : `Out-of-order bucket detected @ ${toISOString(bucketTimestamp)}, after ${toISOString(this.lastBucketTimestamp)}. Ignoring.`,
        );
        return next();
      }

      this.lastBucketTimestamp = bucketTimestamp;
      this.push(bucket);
      next();
    } catch (error) {
      next(error as Error);
    }
  }
}
