import { ONE_MINUTE, ONE_SECOND } from '@gekko/shared/constants/time.const';
import { jest, setDefaultTimeout } from 'bun:test';

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
 * Turns Bun's test timeout off for the tests and hooks the file declares after the call, to be called at the top of a file whose tests
 * move the fake clock. Bun 1.3.14 checks the timeout against the fake clock: under fake timers it compares the deadline of a test, the
 * machine's monotonic clock plus the timeout, with the fake monotonic time, which startFakeClock sets back to 0. On a machine up for days
 * the timeout never fires while the clock is fake; on one booted minutes before, as a CI runner is, a session that moves the fake clock
 * past the uptime plus the timeout makes it look due, and Bun re-arms it at the same deadline in a loop that holds the event loop until
 * real time reaches that deadline, then fails the test with a timeout (Bun 1.4.0 compares it with the real clock, PR #33896). Without a
 * timeout, a test that awaits a promise that never settles hangs, as it did already while the clock was fake: the runRealtime…
 * functions bound every wait in fake time, and the CI step's timeout bounds the run.
 */
export const disableTestTimeouts = () => {
  setDefaultTimeout(0);
};

/**
 * Lets the event loop run `turns` times without moving the fake clock: what a timer started runs then, the process.nextTick and promise
 * callbacks it queued included, which Bun runs only once an advance of its fake timers made from inside its event loop is over.
 */
export const yieldToEventLoop = async (turns = TURNS_PER_STEP) => {
  for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve));
};

/**
 * Advances the fake clock by `ms`, a second at a time, letting the event loop run after each second. Bun has no
 * advanceTimersByTimeAsync, and an advance made from inside its event loop runs none of the process.nextTick and promise callbacks of the
 * timers it fires before it is over: a minute advanced at once would fire the Heart and leave the candle it fetched halfway down the
 * streams until the advance is over, read by the plugins on the clock of its end. Stops at the end of the second in which `until` comes to
 * hold, if given.
 *
 * Made outside the event loop, an advance runs those callbacks after each timer instead, at its instant. The test runner calls a test
 * outside it until a test or a hook of its file has waited on it (awaited a setImmediate, a timer), and a test stays outside it until it
 * waits on it itself: a first second advanced before then ran them at their instant when the test ran alone or first, at the end of the
 * second after a test that had waited on the event loop. So the event loop runs once before the first second, which advanceClock then
 * advances from inside it, as every other.
 *
 * Every timer fires on its way, so that a run never meets the Heart's late tick (a machine that slept): heart.test.ts plays it, and
 * realtime.stream.test.ts the end of a live stream on it.
 */
export const advanceClock = async (ms: number, { until }: { until?: () => boolean } = {}) => {
  if (!jest.isFakeTimers()) throw new Error('advanceClock moves the fake clock: call startFakeClock() first');
  // Inside the event loop from the first second on, whatever the test awaited before
  await yieldToEventLoop(1);
  for (let elapsed = 0; elapsed < ms && !until?.(); elapsed += CLOCK_STEP) {
    jest.advanceTimersByTime(Math.min(CLOCK_STEP, ms - elapsed));
    await yieldToEventLoop();
  }
};
