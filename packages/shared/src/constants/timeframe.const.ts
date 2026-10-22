/**
 * The timeframes, the one list of them (TIMEFRAMES and CandleSize derive from it), with their length in minutes: a nominal one for
 * the timeframes counted in months or years, at 30 days a month, whose candles span whole UTC months (see MONTHS_PER_CANDLE).
 */
export const TIMEFRAME_TO_MINUTES = {
  '1m': 1,
  '2m': 2,
  '3m': 3,
  '5m': 5,
  '10m': 10,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '6h': 360,
  '8h': 480,
  '12h': 720,
  '1d': 1440,
  '1w': 10080,
  '1M': 43200,
  '3M': 129600,
  '6M': 259200,
  '1y': 518400,
} as const;

/** The timeframes counted in months or years: all but those counted in minutes, hours, days or weeks */
type CalendarTimeframe = Exclude<keyof typeof TIMEFRAME_TO_MINUTES, `${number}${'m' | 'h' | 'd' | 'w'}`>;

/** A number of months that divides a year, so that every year starts on a candle boundary */
type MonthsPerCandle = 1 | 2 | 3 | 4 | 6 | 12;

/**
 * How many UTC months a candle of each timeframe counted in months or years spans, by its size in minutes. Such a candle starts on the
 * first of a month and lasts as long as its months do, so getCandleTimeOffset and getCandleStart place it on the calendar from this
 * count, never from its nominal length. A timeframe counted in months or years does not compile until it is listed here: in the partial
 * table this replaces, a 2M timeframe left out compiled, and getCandleStart then stepped back by its nominal 60 days, inside a candle.
 */
export const MONTHS_PER_CANDLE = {
  [TIMEFRAME_TO_MINUTES['1M']]: 1,
  [TIMEFRAME_TO_MINUTES['3M']]: 3,
  [TIMEFRAME_TO_MINUTES['6M']]: 6,
  [TIMEFRAME_TO_MINUTES['1y']]: 12,
} as const satisfies Record<(typeof TIMEFRAME_TO_MINUTES)[CalendarTimeframe], MonthsPerCandle>;
