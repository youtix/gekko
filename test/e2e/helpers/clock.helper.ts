import { ONE_MINUTE } from '@constants/time.const';

/**
 * A minute of the realtime flows, in milliseconds: mockRealtimeModules mocks ONE_MINUTE to it, so that a run of ten minutes lasts half a
 * second. The backtest and importer flows keep real minutes.
 */
export const FAST_MINUTE = 50;

/**
 * The start of the minute holding `timestamp`, on the clock of the flow: ONE_MINUTE is read when it is called, FAST_MINUTE in a realtime
 * flow. Worked out here rather than with startOfMinuteUTC, which the importer's clamp of daterange.end uses: the scenarios that check
 * the clamp must not share its floor.
 */
export const minuteOf = (timestamp: number) => timestamp - (timestamp % ONE_MINUTE);
