import { ONE_MINUTE, ONE_SECOND } from '@gekko/shared/constants/time.const';
import { describeError } from '@gekko/shared/errors/error.helper';
import { LAST_FLUSH_TIMEOUT } from '@gekko/core/bots/telegram/telegram.const';
import { jest, mock, setDefaultTimeout } from 'bun:test';
import { createCcxtModuleMock } from '../mocks/ccxt.mock';
import { MockFetcherService } from '../mocks/fetcher.mock';
import { isTextLine, logStore, MockWinston, type LoggedLine, type TextLine } from '../mocks/winston.mock';
import { advanceClock, yieldToEventLoop } from './clock.helper';

/**
 * The realtime runs of the e2e flows, on real minutes under the fake clock of clock.helper. A realtime run never ends by itself: the bot
 * runs until its process exits. A test starts one, then moves the fake clock until what it waits for has happened (runRealtimeUntil),
 * and ends it with endRealtimeRun before the next test starts: left running, a run would go on through the next tests, its orders
 * polling and moving, its Telegram bots posting into the shared fetcher mock.
 */

type RealtimeRun = {
  controller: AbortController;
  hasEnded: boolean;
  /** What the run ended with: the error it rejected with, the AbortError of endRealtimeRun included */
  failure?: unknown;
  /** Whether the test was told how the run ended (runRealtimeUntil threw it, runRealtimeUntilEnd returned it) */
  isEndReported: boolean;
};

let run: RealtimeRun | undefined;

/**
 * How long, in fake time, endRealtimeRun waits for an aborted run to end: the plugins are finalised then, the last flush of the Telegram
 * bots included, which waits up to LAST_FLUSH_TIMEOUT for the messages still to go out
 */
const END_OF_RUN_TIMEOUT = LAST_FLUSH_TIMEOUT + ONE_MINUTE;

/**
 * What the lines PluginsStream logs when a plugin fails to finalise hold: `<plugin> failed to finalize: <what it threw>` at error level
 * (several plugins joined by '; '), and `Finalization errors: …` at warn level when the logger itself threw. Matched on those words
 * alone, so that a rewording of the rest of the line still fails the test.
 */
const FINALIZATION_FAILURE = /failed to finalize|finalization errors/i;

const isFinalizationFailure = (line: LoggedLine): line is TextLine =>
  isTextLine(line) && (line.level === 'warn' || line.level === 'error') && FINALIZATION_FAILURE.test(line.message);

/**
 * The wall clock a test or a hook of a realtime flow may take. A scenario takes about 50 ms, the first of a file 200 ms, as it imports
 * the pipeline, but up to 10 s, its hooks included, on a machine whose CPU twelve busy loops took: Bun's default of 5 s would then fail
 * it with a timeout rather than with what it asserts.
 */
const REALTIME_TEST_TIMEOUT = 30 * ONE_SECOND;

/** Whether the run ended with the AbortError of its signal, as gekkoPipeline rejects once aborted */
const isAbortError = (failure: unknown) => failure instanceof Error && failure.name === 'AbortError';

/**
 * Mocks what every realtime flow mocks, to be called at the top of the file, before anything imports the pipeline: winston, whose lines
 * the flows read; ccxt, whose mock serves the candles; and the fetcher of the Telegram bots, so that no request leaves the test. Not the
 * clock: the flows run on real minutes, with the real Heart, under the fake timers of startFakeClock. They shrank ONE_MINUTE to 50 ms
 * and mocked the Heart, which made src carry literals for the durations that had to stay real, and every scenario race 500 ms of wall
 * clock. Also gives the tests and hooks of the file REALTIME_TEST_TIMEOUT. Under fake timers, Bun checks that timeout only as it
 * advances them: a test that awaits a promise that never settles, the clock still, hangs whatever its timeout, so a flow waits on a run
 * through the functions below, whose every wait is bounded in fake time.
 */
export const mockRealtimeModules = () => {
  mock.module('winston', () => MockWinston);
  mock.module('ccxt', () => createCcxtModuleMock());
  mock.module('@gekko/core/fetcher/fetcher.service', () => ({ fetcher: new MockFetcherService() }));
  setDefaultTimeout(REALTIME_TEST_TIMEOUT);
};

/** Starts the run, unless one is in progress: the one a test waits on, or ends */
const currentRun = async () => {
  if (!run) await startRealtimeRun();
  return run!;
};

/**
 * Starts the realtime pipeline of the configuration, with the signal endRealtimeRun aborts, and lets the event loop build it and
 * initialise its plugins before the clock moves: the pipeline reads the minute in progress where the test set the fake clock. Its
 * outcome is held at once, a run that fails while nothing awaits it being an unhandled rejection. The runRealtime… functions start it
 * when no run is in progress: called alone, it lets a test look at the run before its first minute.
 */
export const startRealtimeRun = async () => {
  if (run) throw new Error('A realtime run is in progress already: endRealtimeRun ends it');
  if (!jest.isFakeTimers()) throw new Error('A realtime run goes on the fake clock: call startFakeClock() first');
  const { gekkoPipeline } = await import('@gekko/core/core/pipeline/pipeline');
  const plugins = await import('@gekko/plugins/index');
  const controller = new AbortController();
  const started: RealtimeRun = { controller, hasEnded: false, isEndReported: false };
  const end = (failure: unknown) => Object.assign(started, { hasEnded: true, failure });
  gekkoPipeline({ plugins, signal: controller.signal }).then(
    () => end(new Error('The realtime run completed, as only a run whose candles end does')),
    end,
  );
  run = started;
  await yieldToEventLoop();
};

/** Advances the fake clock minute by minute, `minutes` at most, until `condition` holds; throws what ended the run if it ends first */
const runMinutes = async (minutes: number, condition?: () => boolean) => {
  const current = await currentRun();
  for (let minute = 0; minute < minutes; minute++) {
    await advanceClock(ONE_MINUTE, { until: () => current.hasEnded });
    if (current.hasEnded) {
      current.isEndReported = true;
      throw current.failure;
    }
    if (condition?.()) return;
  }
};

/**
 * Runs the realtime pipeline until `condition` holds: starts it unless a run is in progress, then advances the fake clock minute by
 * minute, checking `condition` at the end of each minute, so that the work of the minute's tick is over, `maxMinutes` at most. Returns
 * once it holds, or once `maxMinutes` are over without it, so that the assertions that follow, which assert what it waits for, say what
 * is missing. Throws what ended the run if it ends first: a failure fails the test with its own error, not with the assertions it kept
 * from holding.
 */
export const runRealtimeUntil = (condition: () => boolean, { maxMinutes }: { maxMinutes: number }) => runMinutes(maxMinutes, condition);

/**
 * Runs the realtime pipeline for `minutes` minutes, for a test that asserts what a fixed span produces, or does not: starts it unless a
 * run is in progress, then advances the fake clock. Throws what ended the run if it ends meanwhile.
 */
export const runRealtimeFor = ({ minutes }: { minutes: number }) => runMinutes(minutes);

/**
 * Runs the realtime pipeline until it ends by itself (a stop, a failure): starts it unless a run is in progress, then advances the fake
 * clock, `maxMinutes` at most. Returns what the run ended with, for the test to assert: the error it rejected with, or an Error saying
 * that it did not end.
 */
export const runRealtimeUntilEnd = async ({ maxMinutes }: { maxMinutes: number }) => {
  const current = await currentRun();
  await advanceClock(maxMinutes * ONE_MINUTE, { until: () => current.hasEnded });
  if (!current.hasEnded) return new Error(`The realtime run did not end within ${maxMinutes} minutes`);
  current.isEndReported = true;
  return current.failure;
};

/**
 * Ends the run in progress through the signal of gekkoPipeline, as nothing else ends a realtime run but a failure or the circuit
 * breaker: every stream is destroyed, the bucket in progress is finished, and the plugins are finalised with the AbortError as the
 * failure that stopped the run, which the analyzers report as their interruption and a strategy's end() receives. In production SIGINT
 * and SIGTERM exit without finalising the plugins. The fake clock moves until the run is over, up to END_OF_RUN_TIMEOUT, the Telegram
 * bots' last flush included, then the real timers are back: the fake timers left are dropped, the polls of the orders still open among
 * them, which the Trader leaves running when it is finalised, as such orders stay on the exchange when Gekko stops. Nothing to abort when
 * the run ended already (a stop, a failure).
 *
 * Then fails the test when the run did not end, when it ended by itself without a runRealtime… call reporting it (a test that only
 * advanced the clock), when it failed otherwise than with the AbortError as it was ended, or when a plugin failed to finalise:
 * PluginsStream logs such a failure of an aborted run and goes on, and the end comes after the assertions.
 */
export const endRealtimeRun = async () => {
  const ending = run;
  run = undefined;
  const wasRunning = !!ending && !ending.hasEnded;
  if (ending && wasRunning) {
    ending.controller.abort();
    await yieldToEventLoop();
    if (jest.isFakeTimers()) await advanceClock(END_OF_RUN_TIMEOUT, { until: () => ending.hasEnded });
  }
  jest.useRealTimers();

  if (ending && !ending.hasEnded) throw new Error(`The realtime run did not end within ${END_OF_RUN_TIMEOUT / ONE_SECOND} s of its abort`);
  if (ending && !ending.isEndReported) {
    const { failure } = ending;
    if (!wasRunning) throw new Error(`The realtime run ended by itself, unseen by the test: ${describeError(failure)}`, { cause: failure });
    if (!isAbortError(failure)) throw new Error(`The realtime run failed as it was ended: ${describeError(failure)}`, { cause: failure });
  }
  const failures = logStore.filter(isFinalizationFailure);
  if (failures.length) throw new Error(`A plugin failed to finalise: ${failures.map(({ message }) => message).join(' | ')}`);
};
