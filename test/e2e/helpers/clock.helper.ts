import { ONE_MINUTE, ONE_SECOND } from '@constants/time.const';
import { jest } from 'bun:test';

/**
 * The instant the realtime flows start at, on the fake clock: 30 s into a minute, as a start-up can be, on a fixed day, so that a run
 * meets the same minutes wherever and whenever the test runs. The pipeline reads 12:00 as the minute in progress, the first its live
 * streams deliver: the Heart ticks once pumped, then at 12:01:02, the grace period after the boundary, and that tick fetches 12:00, the
 * next one 12:01, and so on.
 */
export const REALTIME_START = Date.UTC(2024, 0, 1, 12, 0, 30);

/** The fake time advanceClock moves before it lets the event loop run: what a timer starts down the streams runs at most this late */
const CLOCK_STEP = ONE_SECOND;

/**
 * The turns of the event loop after each step of the fake clock. A candle a timer pushed reaches the plugins in one, its nextTick and
 * promise callbacks run to the last: the others leave room for a stream that would defer with setImmediate.
 */
const TURNS_PER_STEP = 10;

/**
 * The start of the minute holding `timestamp`. Worked out here rather than with startOfMinuteUTC, which the importer's clamp of
 * daterange.end uses: the scenarios that check the clamp must not share its floor.
 */
export const minuteOf = (timestamp: number) => timestamp - (timestamp % ONE_MINUTE);

/**
 * Fakes the timers and Date from `now` on, for the realtime flows: the clock moves only as advanceClock moves it, so that a run on real
 * minutes, with the real Heart, lasts what the test lets it, and meets the same minutes at every run. To be called before the run is
 * started (beforeEach), so that the pipeline reads `now` as the time of its start; endRealtimeRun puts the real timers back.
 */
export const startFakeClock = (now = REALTIME_START) => {
  jest.useFakeTimers({ now });
};

/**
 * Lets the event loop run `turns` times without moving the fake clock: what a timer started, the callbacks of process.nextTick
 * included, which Bun does not run while it advances its fake timers.
 */
export const yieldToEventLoop = async (turns = TURNS_PER_STEP) => {
  for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve));
};

/**
 * Advances the fake clock by `ms`, a second at a time, letting the event loop run after each second. Bun has no
 * advanceTimersByTimeAsync and runs no process.nextTick callback during an advance: a minute advanced at once would fire the Heart and
 * leave the candle it fetched halfway down the streams until the advance is over, read by the plugins on the clock of its end. Stops at
 * the end of the second in which `until` comes to hold, if given.
 *
 * Every timer fires on its way, so that a run never meets the Heart's late tick (a machine that slept): heart.test.ts plays it, and
 * realtime.stream.test.ts the end of a live stream on it.
 */
export const advanceClock = async (ms: number, { until }: { until?: () => boolean } = {}) => {
  if (!jest.isFakeTimers()) throw new Error('advanceClock moves the fake clock: call startFakeClock() first');
  for (let elapsed = 0; elapsed < ms && !until?.(); elapsed += CLOCK_STEP) {
    jest.advanceTimersByTime(Math.min(CLOCK_STEP, ms - elapsed));
    await yieldToEventLoop();
  }
};
