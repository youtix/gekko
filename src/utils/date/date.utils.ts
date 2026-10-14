import { ONE_MINUTE } from '@constants/time.const';
import { isValid } from 'date-fns';
import { isNil } from 'lodash-es';

/**
 * A timestamp in ISO 8601, for messages and reports, which must not throw: 'Unknown Date' without one, or for one that is not a
 * date (NaN, ±Infinity, beyond ±8.64e15 ms), on which Date.prototype.toISOString throws a RangeError.
 */
export const toISOString = (timestamp?: EpochTimeStamp): string => {
  if (isNil(timestamp)) return 'Unknown Date';
  const date = new Date(timestamp);
  return isValid(date) ? date.toISOString() : 'Unknown Date';
};

export const toTimestamp = (iso8601String?: string): EpochTimeStamp => new Date(iso8601String ?? 0).getTime();

/**
 * The start of the minute holding `timestamp`, on the UTC calendar. date-fns' startOfMinute floors in local time, where a wall-clock
 * time of the hour repeated when DST ends resolves to its first pass: every instant of the second pass came back an hour early, and a
 * live stream pushed nothing for that hour. A UTC minute has no such ambiguity.
 */
export const startOfMinuteUTC = (timestamp: EpochTimeStamp): EpochTimeStamp => Math.floor(timestamp / ONE_MINUTE) * ONE_MINUTE;

/**
 * Splits the minutes from the one holding `startDate` to the one holding `endDate`, both included, into chunks of `batchSize`
 * minutes, the last one with what is left. A chunk runs from the start of its first minute to the last millisecond of its last minute.
 */
export const splitIntervals = (startDate: EpochTimeStamp, endDate: EpochTimeStamp, batchSize = 1440) => {
  const firstMinute = startOfMinuteUTC(startDate);
  const totalMinutes = (startOfMinuteUTC(endDate) - firstMinute) / ONE_MINUTE + 1;
  const chunkCount = Math.ceil(totalMinutes / batchSize);

  return Array.from({ length: chunkCount }, (_, i) => {
    const start = firstMinute + i * batchSize * ONE_MINUTE;
    const minutesInChunk = Math.min(batchSize, totalMinutes - i * batchSize);
    return { start, end: start + minutesInChunk * ONE_MINUTE - 1 };
  });
};
