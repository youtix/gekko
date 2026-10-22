import { ONE_MINUTE } from '../../constants/time.const';
import { formatDuration, intervalToDuration, isValid } from 'date-fns';
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
 * A Date whose local fields are its UTC fields (getHours is getUTCHours, setDate setUTCDate…) and whose offset is 0: date-fns, which
 * reads and writes local fields, computes on the UTC calendar through it, whatever the zone of the machine. The TZDate of @date-fns/tz
 * for 'UTC' goes through the machine's zone, and on a machine with daylight saving time a date whose UTC wall-clock time that zone
 * skips at its spring change moves by the change: 2023-03-25T02:30Z to 2023-03-26T02:30Z read "1 day -1 hours" in Paris.
 */
class UTCDate extends Date {
  getTimezoneOffset() {
    return 0;
  }
}
for (const method of Object.getOwnPropertyNames(Date.prototype)) {
  const match = /^(get|set)(?!UTC)(.*)$/.exec(method);
  const utcMethod = match && Reflect.get(Date.prototype, `${match[1]}UTC${match[2]}`);
  if (utcMethod) Reflect.set(UTCDate.prototype, method, utcMethod);
}

/**
 * The duration from `start` to `end` in words, counted on the UTC calendar, the same on every machine: "3 months 2 days", '' for none.
 * Counted on the machine's calendar, as intervalToDuration does, a period across a change of daylight saving time came out an hour off
 * (2024-10-01 to 2024-11-01 read "30 days 23 hours" in Paris), and so did a duration from the epoch on a machine whose zone had it in
 * 1970 (120 days read "3 months 30 days 1 hour" in New York).
 */
export const formatDurationUTC = (start: EpochTimeStamp, end: EpochTimeStamp): string =>
  formatDuration(intervalToDuration({ start, end }, { in: value => new UTCDate(value) }));

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
