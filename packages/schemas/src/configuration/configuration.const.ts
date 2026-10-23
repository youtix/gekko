import { TIMEFRAME_TO_MINUTES } from '@gekko/shared/constants/timeframe.const';

type Timeframe = keyof typeof TIMEFRAME_TO_MINUTES;

/** The timeframes a config can watch: the keys of TIMEFRAME_TO_MINUTES, in its order (z.enum needs a non-empty tuple) */
export const TIMEFRAMES = Object.keys(TIMEFRAME_TO_MINUTES) as [Timeframe, ...Timeframe[]];
