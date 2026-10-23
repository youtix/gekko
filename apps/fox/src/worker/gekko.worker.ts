import { gekkoPipeline } from '@gekko/core/core/pipeline/pipeline';
import { createRunContext } from '@gekko/core/run/runContext.helper';
import type { RunContext } from '@gekko/core/run/runContext.types';
import { describeFailure } from '@gekko/core/logger/failure.helper';
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
 * Backtests a variant as the executable runs a configuration file: its context built from the configuration (createRunContext, which
 * checks it again), the pipeline run with every plugin of the registry, then the storage closed, whatever the run did. Settles with
 * the outcome, failed when the run or the close of the storage failed, each failure as describeError writes it, followed, for one that
 * has more to tell, by what the bot's main() would log of it (describeFailure): its stack, and its causes down to the root. Never
 * rejects.
 */
const backtest = async ({ variant, configuration }: Omit<VariantRequest, 'writeLock'>): Promise<VariantResult> => {
  const start = Date.now();
  const failures: string[] = [];
  const stacks: string[] = [];
  const fail = (err: unknown, prefix = '') => {
    failures.push(`${prefix}${describeError(err)}`);
    if (hasMoreToTell(err)) stacks.push(`${prefix}${describeFailure(err)}`);
  };
  let context: RunContext | undefined;
  try {
    context = createRunContext(configuration, `variant ${variant}`);
    await gekkoPipeline({ context, plugins });
  } catch (err) {
    fail(err);
  } finally {
    try {
      context?.services.closeStorage();
    } catch (err) {
      fail(err, 'Could not close the storage: ');
    }
  }
  const durationMs = Date.now() - start;
  if (!failures.length) return { variant, status: 'done', durationMs };
  return { variant, status: 'failed', error: failures.join('; '), ...(stacks.length ? { stack: stacks.join('\n') } : {}), durationMs };
};

// One variant per worker, so that each backtest starts from modules of its own. A sync handler, which costs nothing: Bun 1.3.14
// aborted the whole process (SIGABRT, every worker with it) when the promise an async onmessage handler returns rejected, though
// only when the main thread had no error listener on the Worker, and Bun 1.4.4 drops such a rejection. runWorker listens, and a
// listened rejection is the worker's error event under both, as is that of a promise a sync handler leaves floating. The worker
// exits once its outcome is posted: a timer left by the run would keep it alive. Its lines are written under the lock of stdout Fox's
// main thread shares, each whole before the call that logs it returns: none is cut by another thread's, none is left to write as the
// worker exits, which Fox's terminate() would cut short.
self.onmessage = ({ data: { writeLock, ...request } }: MessageEvent<VariantRequest>) => {
  useWriteLock(writeLock);
  void backtest(request).then(result => {
    postMessage(result);
    process.exit();
  });
};
