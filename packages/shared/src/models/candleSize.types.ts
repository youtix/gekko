import { TIMEFRAME_TO_MINUTES } from '../constants/timeframe.const';

/** A timeframe in minutes: the values of TIMEFRAME_TO_MINUTES, the one list of timeframes */
export type CandleSize = (typeof TIMEFRAME_TO_MINUTES)[keyof typeof TIMEFRAME_TO_MINUTES];
