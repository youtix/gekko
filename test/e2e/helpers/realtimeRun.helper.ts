import { mock } from 'bun:test';
import type { Writable } from 'node:stream';
import * as streamPromises from 'stream/promises';
import { createCcxtModuleMock } from '../mocks/ccxt.mock';
import { MockFetcherService } from '../mocks/fetcher.mock';
import { MockHeart } from '../mocks/heart.mock';
import { isTextLine, logStore, MockWinston, type LoggedLine, type TextLine } from '../mocks/winston.mock';
import { FAST_MINUTE } from './clock.helper';

/**
 * Ends the realtime runs of the e2e flows. A realtime run never ends by itself: the bot runs until its process exits, which drops
 * whatever the run left scheduled. The tests share one process, so each one ends its run here before the next one starts. Left
 * running, a run would go on through the next tests: its orders polling and moving, its Telegram bots posting into the shared
 * fetcher mock, and the prototype patch of one test reaching the orders of another.
 */

// Taken before trackRealtimeRuns mocks the module: the mock patches this very namespace
const { pipeline: runPipeline, ...otherStreamPromises } = streamPromises;
const setIntervalOfProcess = globalThis.setInterval;

let run: { sink: Writable; ended: Promise<unknown> } | undefined;
/** The intervals created since the last run ended */
const intervals = new Set<ReturnType<typeof setInterval>>();
let isTrackingIntervals = false;

/**
 * What the line PluginsStream logs when a plugin fails to finalise holds, at warn or error level. Matched on that word alone, so that
 * a rewording of the line, which names the plugins that failed, still fails the test.
 */
const FINALIZATION_FAILURE = /inalization/i;

const isFinalizationFailure = (line: LoggedLine): line is TextLine =>
  isTextLine(line) && (line.level === 'warn' || line.level === 'error') && FINALIZATION_FAILURE.test(line.message);

/**
 * Mocks what every realtime flow mocks, to be called at the top of the file, before anything imports the pipeline: winston, whose lines
 * the flows read; the clock, ONE_MINUTE at FAST_MINUTE and ONE_SECOND at 1 ms, with a Heart that ticks at once then every tick rate,
 * so that a run of ten minutes lasts half a second; ccxt, whose mock serves the candles; the fetcher of the Telegram bots, so that no
 * request leaves the test; and the tracking that lets endRealtimeRun end a run.
 */
export const mockRealtimeModules = () => {
  mock.module('winston', () => MockWinston);
  mock.module('@constants/time.const', () => ({ ONE_SECOND: 1, ONE_MINUTE: FAST_MINUTE }));
  mock.module('@services/core/heart/heart', () => ({ Heart: MockHeart }));
  mock.module('ccxt', () => createCcxtModuleMock());
  mock.module('@services/fetcher/fetcher.service', () => ({ fetcher: new MockFetcherService() }));
  trackRealtimeRuns();
};

/**
 * Lets endRealtimeRun end the run a test starts: stream/promises is mocked by a copy whose pipeline() keeps hold of the stream
 * pipeline it starts, the one gekkoPipeline() runs, and every interval created from now on is recorded. To be called next to the
 * other mocks of the test file, before the pipeline is imported. Both last as long as the global of the file: to the end of the
 * file under `bun test --isolate`, as test:e2e runs, to the end of the process without it.
 */
export const trackRealtimeRuns = () => {
  mock.module('stream/promises', () => ({
    ...otherStreamPromises,
    pipeline: (...streams: any[]) => {
      const ended = (runPipeline as (...args: any[]) => Promise<unknown>)(...streams);
      run = { sink: streams.at(-1), ended };
      return ended;
    },
  }));

  if (isTrackingIntervals) return;
  isTrackingIntervals = true;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const interval = setIntervalOfProcess(...args);
    intervals.add(interval);
    return interval;
  }) as typeof setInterval;
};

/**
 * Ends the run in progress and waits until it is over. Its last stream, the PluginsStream, is destroyed without an error: the stream
 * pipeline is torn down and the plugins are finalised as at the end of a completed run, an end no realtime run has in production
 * (SIGINT and SIGTERM exit without finalising the plugins, a stop or a failure finalises them with its error). Then the intervals
 * created since the previous run are cleared, among them the polls of the orders still open: the Trader leaves them open when it is
 * finalised, as they stay on the exchange when Gekko stops. Nothing to destroy when the run has ended already (a stop).
 *
 * Fails, once the run is over, when a plugin failed to finalise during the test: PluginsStream logs the failure and goes on, and the
 * end comes after the assertions, so a plugin throwing from processFinalize passed every realtime flow.
 */
export const endRealtimeRun = async () => {
  const ending = run;
  run = undefined;
  if (ending) {
    ending.sink.destroy();
    await ending.ended.catch(() => undefined); // Rejected with the premature close, or with what ended the run
  }
  for (const interval of intervals) clearInterval(interval);
  intervals.clear();
  MockHeart.stopAll();
  const failures = logStore.filter(isFinalizationFailure);
  if (failures.length) throw new Error(`A plugin failed to finalise: ${failures.map(({ message }) => message).join(' | ')}`);
};
