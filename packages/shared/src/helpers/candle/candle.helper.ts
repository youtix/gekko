import { ONE_MINUTE } from '../../constants/time.const';
import { MONTHS_PER_CANDLE } from '../../constants/timeframe.const';
import { GekkoError } from '../../errors/gekko.error';
import { Candle } from '../../models/candle.types';
import { CandleBucket } from '../../models/event.types';
import { CandleSize } from '../../models/candleSize.types';

export const hl2 = (candle: Candle): number => (candle.high + candle.low) / 2;
export const hlc3 = (candle: Candle): number => (candle.high + candle.low + candle.close) / 3;
export const ohlc4 = (candle: Candle): number => (candle.open + candle.high + candle.low + candle.close) / 4;

/** The minute after `lastCandle`, made up for want of a real one: flat at its close, volume 0, marked synthetic and without `id`. */
export const createEmptyCandle = (lastCandle: Candle): Candle => ({
  start: lastCandle.start + ONE_MINUTE,
  open: lastCandle.close,
  high: lastCandle.close,
  low: lastCandle.close,
  close: lastCandle.close,
  volume: 0,
  synthetic: true,
});

/** The sizes of the candles that span whole UTC months: the keys of MONTHS_PER_CANDLE */
type CalendarCandleSize = keyof typeof MONTHS_PER_CANDLE;

// Checked on every minute the TradingAdvisor batches: a Set finds a number two to five times faster under Bun than `in` or Object.hasOwn
const CALENDAR_CANDLE_SIZES: ReadonlySet<number> = new Set(Object.keys(MONTHS_PER_CANDLE).map(Number));

const isCalendarCandleSize = (candleSize: CandleSize): candleSize is CalendarCandleSize => CALENDAR_CANDLE_SIZES.has(candleSize);

/** Minutes from the start of the timeframe candle of `candleSize` minutes holding `start` (0 on a timeframe boundary). */
export const getCandleTimeOffset = (candleSize: CandleSize, start: EpochTimeStamp): number => {
  const date = new Date(start);
  if (isCalendarCandleSize(candleSize)) {
    // The candles start on the first of a month, every MONTHS_PER_CANDLE months from January
    const month = date.getUTCMonth();
    const candleStart = Date.UTC(date.getUTCFullYear(), month - (month % MONTHS_PER_CANDLE[candleSize]), 1);
    return Math.floor((start - candleStart) / ONE_MINUTE);
  }

  const minutesSinceMidnight = date.getUTCHours() * 60 + date.getUTCMinutes();
  switch (candleSize) {
    case 1:
    case 2:
    case 3:
    case 5:
    case 10:
    case 15:
    case 30:
      return date.getUTCMinutes() % candleSize;
    case 60:
    case 120:
    case 240:
    case 360:
    case 480:
    case 720:
      return minutesSinceMidnight % candleSize;
    case 1440:
      return minutesSinceMidnight;
    case 10080:
      return ((date.getUTCDay() + 6) % 7) * 1440 + minutesSinceMidnight; // Weeks start on Monday
    default: {
      // A size added to TIMEFRAME_TO_MINUTES without a case here, or its months in MONTHS_PER_CANDLE, fails to compile
      const unsupported: never = candleSize;
      throw new GekkoError('core', `Unsupported candle size: ${unsupported} minutes`);
    }
  }
};

/** Start of the candle `count` candles before the one holding `minute` (a minute start), on the candle batcher's boundaries. */
export const getCandleStart = (candleSize: CandleSize, minute: EpochTimeStamp, count: number) => {
  const candleStart = minute - getCandleTimeOffset(candleSize, minute) * ONE_MINUTE;
  if (!isCalendarCandleSize(candleSize)) return candleStart - count * candleSize * ONE_MINUTE;

  // Whole months, whose length varies: stepped on the calendar
  const date = new Date(candleStart);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - count * MONTHS_PER_CANDLE[candleSize], 1);
};

const peekCandle = (bucket: CandleBucket): Candle | undefined => bucket.values().next().value;

/** The minute of a bucket (all its candles share it), or undefined for an empty bucket */
export const getBucketTimestamp = (bucket: CandleBucket): EpochTimeStamp | undefined => peekCandle(bucket)?.start;

export const getFirstCandleFromBucket = (bucket: CandleBucket) => {
  const firstCandle = peekCandle(bucket);
  if (!firstCandle) throw new GekkoError('core', 'Impossible to get first candle from bucket: Empty candle bucket');
  return firstCandle;
};
