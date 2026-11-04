import { gekkoPipeline } from '@gekko/core/core/pipeline/pipeline';
import { createRunContext } from '@gekko/core/run/runContext.helper';
import type { RunContext } from '@gekko/core/run/runContext.types';
import { describeFailure, logFailure } from '@gekko/core/logger/failure.helper';
import { useWriteLock } from '@gekko/core/logger/logger';
import * as plugins from '@gekko/plugins/index';
import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { isNil } from 'lodash-es';
import type { VariantRequest, VariantResult } from '../fox.types';

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
 * its end, its row written, and an uncaught exception (a throw in a timer) is logged and ends the backtest at once, the storage closed:
 * either fails the variant. Before it posts the outcome of a run that settled, the worker lets the event loop turn, for what the run
 * left due to surface (see turnEventLoop).
 *
 * Posted failed when the run failed, the storage could not be closed, a rejection was left unhandled or an exception was not caught,
 * each failure as describeError writes it, in that order (the rejections after what ended the run, the first named and the others
 * counted), followed, for one that has more to tell, by what the bot's main() would log of it (describeFailure): its stack, and its
 * causes down to the root.
 */
const backtest = ({ variant, configuration }: Omit<VariantRequest, 'writeLock'>) => {
  const start = Date.now();
  const failures: string[] = [];
  const stacks: string[] = [];
  let context: RunContext | undefined;
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

  // Once: in the worker, process.exit() ends the thread at once, but an uncaught exception can come while the run goes on
  const post = () => {
    if (isPosted) return;
    isPosted = true;
    if (rejectionCount) fail(firstRejection, 'Unhandled rejection: ', rejectionCount > 1 ? ` (and ${rejectionCount - 1} more)` : '');
    const durationMs = Date.now() - start;
    const result: VariantResult = failures.length
      ? { variant, status: 'failed', error: failures.join('; '), ...(stacks.length ? { stack: stacks.join('\n') } : {}), durationMs }
      : { variant, status: 'done', durationMs };
    postMessage(result);
    process.exit();
  };

  // As the bot does, which logs it, goes on to the end of its run (a timer-driven task of a live run floats promises that reject on a
  // network blip) and exits 1: the variant fails once its backtest is over, its row written
  const onUnhandledRejection = (reason: unknown) => {
    logFailure('gekko', reason, 'Unhandled rejection: ');
    if (!rejectionCount) firstRejection = reason;
    rejectionCount += 1;
  };

  // As the bot does, which logs it, closes its storage and exits 1 at once, its plugins not finalised
  const onUncaughtException = (err: unknown) => {
    logFailure('gekko', err, 'Uncaught exception: ');
    fail(err, 'Uncaught exception: ');
    closeStorage();
    post();
  };

  const run = async () => {
    try {
      context = createRunContext(configuration, `variant ${variant}`);
      await gekkoPipeline({ context, plugins });
    } catch (err) {
      fail(err);
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
