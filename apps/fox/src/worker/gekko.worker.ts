import { gekkoPipeline } from '@gekko/core/core/pipeline/pipeline';
import { createRunContext } from '@gekko/core/run/runContext.helper';
import type { RunContext } from '@gekko/core/run/runContext.types';
import { describeFailure, logFailure } from '@gekko/core/logger/failure.helper';
import { useWriteLock } from '@gekko/core/logger/logger';
import * as plugins from '@gekko/plugins/index';
import { ApplicationStopError } from '@gekko/shared/errors/applicationStop.error';
import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { isNil } from 'lodash-es';
import type { VariantOutcome, VariantRequest, VariantResult } from '../fox.types';

declare let self: Worker;

/**
 * Whether a failure has more to tell than its message: where an Error that is not a GekkoError was thrown (an exception in a strategy's
 * hook), and what caused any Error, a GekkoError included (a strategy's exception in end(), which the pipeline wraps in the GekkoError
 * of the TradingAdvisor that failed to finalize). A GekkoError without a cause, a refusal, says it all, and a value that is no Error
 * has nothing more than describeError writes.
 */
const hasMoreToTell = (err: unknown) => err instanceof Error && (!(err instanceof GekkoError) || !isNil(err.cause));

/**
 * One turn of the event loop, the end of the current task included: a timer of 0 ms, which fires after the timers already due, once Bun
 * has reported the rejections nobody handled. A backtest yields to the event loop only as it ends, at the PerformanceReporter's
 * setImmediate, which Bun runs before the timers, and without one not at all: the worker, which exits as it posts its outcome, posted
 * a variant whose strategy threw in a timer, or left a rejection unhandled without a PerformanceReporter, as done, where the bot exits 1.
 */
const turnEventLoop = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * Backtests a variant as the executable runs a configuration file, then posts its outcome and exits: its context built from the
 * configuration (createRunContext, which checks it again), the pipeline run with every plugin of the registry, then the storage closed,
 * whatever the run did. As the bot's process handlers do, a rejection left unhandled is logged as it surfaces, the backtest going on to
 * its end, its row written, and an uncaught exception (a throw in a timer, which a backtest gives its turn only as it ends, its row then
 * written unless it waits for the lock of its file) is logged, the storage closed and the variant posted at once: the first fails a
 * variant that did not stop, the second any variant. Before it posts the outcome of a run that settled, the worker lets the event loop
 * turn, for what the run left due to surface (see turnEventLoop).
 *
 * Posted as the bot's main() ends: stopped when the run rejected with an ApplicationStopError (the circuit breaker) and no exception went
 * uncaught, as the bot stops in good order and exits 0 whatever rejection it left unhandled and whatever close of its storage failed,
 * the reason the stop's message, with its tag, as the bot logs it, followed by those other failures; failed when an exception went
 * uncaught, the stop among the failures or not, as the bot exits 1 at once, and otherwise when the run failed, the storage could not be
 * closed or a rejection was left unhandled. Each failure is written as describeError writes it, in that order (the stop first, the
 * rejections after what ended the run, the first named and the others counted), a failed one followed, for one that has more to tell,
 * by what the bot's main() would log of it (describeFailure): its stack, and its causes down to the root.
 */
const backtest = ({ variant, configuration }: Omit<VariantRequest, 'writeLock'>) => {
  const start = Date.now();
  const failures: string[] = [];
  const stacks: string[] = [];
  let context: RunContext | undefined;
  // The stop the run rejected with, the circuit breaker's, kept apart from the other failures, which its reason lists after it
  let stop: ApplicationStopError | undefined;
  let isUncaught = false;
  let rejectionCount = 0;
  let firstRejection: unknown;
  let isPosted = false;

  const fail = (err: unknown, prefix = '', suffix = '') => {
    failures.push(`${prefix}${describeError(err)}${suffix}`);
    if (hasMoreToTell(err)) stacks.push(`${prefix}${describeFailure(err)}`);
  };

  const closeStorage = () => {
    try {
      context?.services.closeStorage();
    } catch (err) {
      fail(err, 'Could not close the storage: ');
    }
  };

  /**
   * How the backtest ended, as the bot's main() decides its code: stopped after the stop, but for an uncaught exception, the other
   * failures in its reason, the worker having logged a rejection with its stack as it surfaced; done without a failure; failed otherwise
   */
  const outcomeOf = (): VariantOutcome => {
    if (stop && !isUncaught) return { status: 'stopped', reason: [stop.message, ...failures].join('; ') };
    const all = stop ? [describeError(stop), ...failures] : failures;
    if (!all.length) return { status: 'done' };
    return { status: 'failed', error: all.join('; '), ...(stacks.length ? { stack: stacks.join('\n') } : {}) };
  };

  // Once: in the worker, process.exit() ends the thread at once, but an uncaught exception can come while the run goes on
  const post = () => {
    if (isPosted) return;
    isPosted = true;
    if (rejectionCount) fail(firstRejection, 'Unhandled rejection: ', rejectionCount > 1 ? ` (and ${rejectionCount - 1} more)` : '');
    const result: VariantResult = { variant, ...outcomeOf(), durationMs: Date.now() - start };
    postMessage(result);
    process.exit();
  };

  // As the bot does, which logs it, goes on to the end of its run (a timer-driven task of a live run floats promises that reject on a
  // network blip) and exits 1, but 0 after a stop: the variant fails once its backtest is over, its row written, or stays stopped
  const onUnhandledRejection = (reason: unknown) => {
    logFailure('gekko', reason, 'Unhandled rejection: ');
    if (!rejectionCount) firstRejection = reason;
    rejectionCount += 1;
  };

  // As the bot does, which logs it, closes its storage and exits 1 at once, its plugins not finalised
  const onUncaughtException = (err: unknown) => {
    logFailure('gekko', err, 'Uncaught exception: ');
    isUncaught = true;
    fail(err, 'Uncaught exception: ');
    closeStorage();
    post();
  };

  const run = async () => {
    try {
      context = createRunContext(configuration, `variant ${variant}`);
      await gekkoPipeline({ context, plugins });
    } catch (err) {
      // Kept apart (see outcomeOf): an ApplicationStopError takes no cause, so it has no stack to post
      if (err instanceof ApplicationStopError) stop = err;
      else fail(err);
    } finally {
      closeStorage();
    }
    await turnEventLoop();
    post();
  };

  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
  void run();
};

// One variant per worker, so that each backtest starts from modules of its own. A sync handler, which costs nothing: Bun 1.3.14
// aborted the whole process (SIGABRT, every worker with it) when the promise an async onmessage handler returns rejected, though
// only when the main thread had no error listener on the Worker, and Bun 1.4.4 drops such a rejection. The worker's own process
// handlers (see backtest) take what the run leaves unhandled; whatever still escapes them, a module that cannot be loaded, is the
// worker's error event, which runWorker listens to. The worker exits once its outcome is posted: a timer left by the run would keep it
// alive. Its lines are written under the lock of stdout Fox's main thread shares, each whole before the call that logs it returns: none
// is cut by another thread's, none is left to write as the worker exits, which Fox's terminate() would cut short.
self.onmessage = ({ data: { writeLock, ...request } }: MessageEvent<VariantRequest>) => {
  useWriteLock(writeLock);
  backtest(request);
};
