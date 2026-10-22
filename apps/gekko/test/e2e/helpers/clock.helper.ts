import { ONE_MINUTE, ONE_SECOND } from '@gekko/shared/constants/time.const';
import { setSystemTime } from 'bun:test';

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

/** The longest delay of setTimeout and setInterval: a delay outside 1 ms to this, or no number, is 1 ms, as Bun and Node take it */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/**
 * A timer armed on the fake clock: due at `due`, armed `order`th among those due then, again every `delay` for an interval, its callback
 * called with its handle as `this`, as Bun calls a timer's. Cleared (clearTimeout, clearInterval, its handle's close), it is armed no
 * more, its handle's refresh included.
 */
type FakeTimer = {
  id: number;
  delay: number;
  due: number;
  order: number;
  repeats: boolean;
  callback: (...args: unknown[]) => void;
  args: unknown[];
  handle: object;
  isCleared: boolean;
};

type TimerFunctions = Pick<typeof globalThis, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'>;

/** The fake clock while it runs: its time, its timers by id, the count of timers armed, which orders them, and the real functions */
type FakeClock = { now: number; timers: Map<number, FakeTimer>; armed: number; real: TimerFunctions };

let clock: FakeClock | undefined;

/** The number of the last timer armed on a fake clock, negative and never reused, so that it is neither a real timer's nor an earlier one's */
let lastTimerId = 0;

/** The clock and the timer of each handle setTimeout and setInterval gave on a fake clock, which clearTimeout tells from real ones */
const fakeHandles = new WeakMap<object, { owner: FakeClock; timer: FakeTimer }>();

/**
 * The start of the minute holding `timestamp`. Worked out here rather than with startOfMinuteUTC, which the importer's clamp of
 * daterange.end uses: the scenarios that check the clamp must not share its floor.
 */
export const minuteOf = (timestamp: number) => timestamp - (timestamp % ONE_MINUTE);

const delayOf = (delay: unknown) => {
  const ms = Number(delay);
  return ms >= 1 && ms <= MAX_TIMER_DELAY ? Math.trunc(ms) : 1;
};

/** Arms `timer` on `current`, due at `due`, after the timers armed before it: Bun fires the timers due at one instant in that order */
const schedule = (current: FakeClock, timer: FakeTimer, due: number) => {
  Object.assign(timer, { due, order: ++current.armed });
  current.timers.set(timer.id, timer);
};

/** The fake timer of a handle, or of the number of a timer armed on the fake clock that runs, with its clock: none for a real timer */
const fakeTimerOf = (handle: unknown) => {
  if (typeof handle === 'object' && handle !== null) return fakeHandles.get(handle);
  const timer = typeof handle === 'number' ? clock?.timers.get(handle) : undefined;
  return clock && timer ? { owner: clock, timer } : undefined;
};

/** clearTimeout and clearInterval while the fake clock runs: a fake timer, by its handle or its number, or else a real one */
const disarm = (handle: unknown) => {
  const fake = fakeTimerOf(handle);
  if (fake) {
    fake.owner.timers.delete(fake.timer.id);
    fake.timer.isCleared = true;
  }
  // A real timer, armed before the fake clock started, or a call through a reference kept from a fake session that is over
  else (clock?.real.clearTimeout ?? clearTimeout)(handle as Parameters<typeof clearTimeout>[0]);
};

/**
 * A handle as setTimeout gives one: clearTimeout and clearInterval take it, or its number. As Bun's, hasRef says whether ref or unref was
 * called last, and refresh arms its timer again from the fake now, also once it fired, but not once it was cleared.
 */
const handleOf = (id: number) => {
  let isReferenced = true;
  const handle = {
    ref: () => {
      isReferenced = true;
      return handle;
    },
    unref: () => {
      isReferenced = false;
      return handle;
    },
    hasRef: () => isReferenced,
    refresh: () => {
      const fake = fakeHandles.get(handle);
      if (fake && !fake.timer.isCleared) schedule(fake.owner, fake.timer, fake.owner.now + fake.timer.delay);
      return handle;
    },
    close: () => {
      disarm(handle);
      return handle;
    },
    [Symbol.toPrimitive]: () => id,
  };
  return handle;
};

const arm =
  (repeats: boolean) =>
  (callback: unknown, delay?: unknown, ...args: unknown[]): unknown => {
    const current = clock;
    // Called through a reference kept from a fake session that is over: the real timer
    if (!current) return (repeats ? setInterval : setTimeout)(callback as () => void, delay as number, ...args);
    if (typeof callback !== 'function')
      throw new TypeError(`The "callback" argument must be of type function. Received ${typeof callback}`);
    const id = --lastTimerId;
    const handle = handleOf(id);
    const timer: FakeTimer = {
      id,
      delay: delayOf(delay),
      due: current.now,
      order: 0,
      repeats,
      callback: callback as FakeTimer['callback'],
      args,
      handle,
      isCleared: false,
    };
    fakeHandles.set(handle, { owner: current, timer });
    schedule(current, timer, current.now + timer.delay);
    return handle;
  };

/** The timer due first by `until`, the first armed of those due at the same instant, as Bun fires them */
const nextTimer = (current: FakeClock, until: number) => {
  let next: FakeTimer | undefined;
  for (const timer of current.timers.values())
    if (timer.due <= until && (!next || timer.due < next.due || (timer.due === next.due && timer.order < next.order))) next = timer;
  return next;
};

/**
 * Moves the fake clock by `ms` at once, firing on its way the timers due by then, each with Date at its instant: an interval again every
 * period, a timer a callback arms if it is due by then too. An interval is armed again once its callback has returned, as Bun arms it: a
 * timer the callback armed for the instant of its next run fires first. Their process.nextTick and promise callbacks run once the advance
 * is over, as for any synchronous code: advanceClock lets the event loop run after it. A callback that throws ends the advance with its
 * error, the clock at its instant. A callback that stops the fake clock ends it too, Date left real.
 */
const advanceFakeClock = (current: FakeClock, ms: number) => {
  const until = current.now + ms;
  for (let timer = nextTimer(current, until); timer && clock === current; timer = nextTimer(current, until)) {
    current.now = timer.due;
    setSystemTime(new Date(timer.due));
    const nextRun = timer.due + timer.delay;
    if (!timer.repeats) current.timers.delete(timer.id);
    try {
      timer.callback.apply(timer.handle, timer.args);
    } finally {
      if (timer.repeats && !timer.isCleared) schedule(current, timer, nextRun);
    }
  }
  if (clock !== current) return;
  current.now = until;
  setSystemTime(new Date(until));
};

/**
 * Puts the real timers and Date back, the fake timers left dropped: those of a run still open, as the polls of its orders. Nothing to do
 * when the fake clock does not run.
 */
export const stopFakeClock = () => {
  if (!clock) return;
  Object.assign(globalThis, clock.real);
  clock = undefined;
  setSystemTime();
};

/**
 * Fakes the timers and Date from `now` on, for the realtime flows: the clock moves only as advanceClock moves it, so that a run on real
 * minutes, with the real Heart, lasts what the test lets it, and meets the same minutes at every run. To be called before the run is
 * started (beforeEach), so that the pipeline reads `now` as the time of its start; endRealtimeRun puts the real timers back
 * (stopFakeClock), and a fake clock started again starts afresh.
 *
 * The harness's own clock rather than Bun's fake timers: setTimeout, setInterval and their clear functions are replaced on globalThis,
 * where the code under test looks them up as it calls them, and Date is set with setSystemTime, which moves nothing else. Bun 1.3.14's
 * jest.useFakeTimers() also mocks the monotonic clock it compares its real timers with, a test's timeout and JSC's timers among them,
 * from 0 at each call (fixed in Bun 1.4.0): a fake session longer than the machine's uptime, which one booted minutes before has (a CI
 * runner), made them look overdue, and Bun spun on them, no JS run, until their real deadline: tests timed out after 30 s, others took
 * seconds to minutes. Bun's own clock is left real here, so that a test's timeout counts real time, the fake clock running or not.
 */
export const startFakeClock = (now = REALTIME_START) => {
  stopFakeClock();
  const real = { setTimeout, clearTimeout, setInterval, clearInterval };
  clock = { now, timers: new Map(), armed: 0, real };
  setSystemTime(new Date(now));
  Object.assign(globalThis, { setTimeout: arm(false), setInterval: arm(true), clearTimeout: disarm, clearInterval: disarm });
};

/** Whether the fake clock runs: startFakeClock started it, and stopFakeClock has not stopped it since */
export const isFakeClock = () => clock !== undefined;

/** The timers armed on the fake clock and not fired, nor cleared, yet: none when it does not run */
export const fakeTimerCount = () => clock?.timers.size ?? 0;

/**
 * Lets the event loop run `turns` times without moving the fake clock: what a timer started runs then, the process.nextTick and promise
 * callbacks it queued included, which run only once the advance that fired it is over.
 */
export const yieldToEventLoop = async (turns = TURNS_PER_STEP) => {
  for (let turn = 0; turn < turns; turn++) await new Promise(resolve => setImmediate(resolve));
};

/**
 * Advances the fake clock by `ms`, a second at a time, letting the event loop run after each second: a minute advanced at once would fire
 * the Heart and leave the candle it fetched halfway down the streams until the advance is over, read by the plugins on the clock of its
 * end. Stops at the end of the second in which `until` comes to hold, if given. The event loop runs once before the first second, so
 * that what the test started before it has run. Throws when the fake clock it moves is stopped meanwhile, as an afterEach does once the
 * test timed out: the test's code, which goes on, then moves no clock of the next test.
 *
 * Every timer fires on its way, so that a run never meets the Heart's late tick (a machine that slept): heart.test.ts plays it, and
 * realtime.stream.test.ts the end of a live stream on it.
 */
export const advanceClock = async (ms: number, { until }: { until?: () => boolean } = {}) => {
  const current = clock;
  if (!current) throw new Error('advanceClock moves the fake clock: call startFakeClock() first');
  const checkClock = () => {
    if (clock !== current) throw new Error('advanceClock moved a fake clock that was stopped meanwhile');
  };
  await yieldToEventLoop(1);
  for (let elapsed = 0; elapsed < ms; elapsed += CLOCK_STEP) {
    checkClock();
    if (until?.()) return;
    advanceFakeClock(current, Math.min(CLOCK_STEP, ms - elapsed));
    await yieldToEventLoop();
  }
  checkClock();
};
