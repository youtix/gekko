import { ONE_MINUTE } from '@constants/time.const';
import { CandleBucket } from '@models/event.types';
import { warning } from '@services/logger';
import { getBucketTimestamp } from '@helpers/candle/candle.helper';
import { toISOString } from '@utils/date/date.utils';
import { Transform, TransformCallback } from 'node:stream';

export class RejectFutureCandleStream extends Transform {
  constructor() {
    super({ objectMode: true });
  }

  _transform(bucket: CandleBucket, _: BufferEncoding, next: TransformCallback) {
    try {
      const bucketTimestamp = getBucketTimestamp(bucket);
      if (bucketTimestamp === undefined) return next();

      const candleEndTime = bucketTimestamp + ONE_MINUTE;
      if (candleEndTime > Date.now()) {
        warning('stream', `Rejecting future bucket: candle end time ${toISOString(candleEndTime)} is in the future.`);
        return next();
      }

      this.push(bucket);
      next();
    } catch (error) {
      next(error as Error);
    }
  }
}
