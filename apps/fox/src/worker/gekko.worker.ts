import { gekkoPipeline } from '@gekko/core/core/pipeline/pipeline';
import { createRunContext } from '@gekko/core/run/runContext.helper';
import type { RunContext } from '@gekko/core/run/runContext.types';
import * as plugins from '@gekko/plugins/index';
import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { inspect } from 'node:util';
import type { VariantRequest, VariantResult } from '../fox.types';

declare let self: Worker;

/**
 * Backtests a variant as the executable runs a configuration file: its context built from the configuration (createRunContext, which
 * checks it again), the pipeline run with every plugin of the registry, then the storage closed, whatever the run did. Settles with
 * the outcome, failed when the run or the close of the storage failed, each failure as describeError writes it, with the stack and
 * causes of one that is not a GekkoError (an exception in a strategy), as util.inspect writes them. Never rejects.
 */
const backtest = async ({ variant, configuration }: VariantRequest): Promise<VariantResult> => {
  const start = Date.now();
  const failures: string[] = [];
  const stacks: string[] = [];
  const fail = (err: unknown, prefix = '') => {
    failures.push(`${prefix}${describeError(err)}`);
    if (err instanceof Error && !(err instanceof GekkoError)) stacks.push(`${prefix}${inspect(err)}`);
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
// exits once its outcome is posted: a timer left by the run would keep it alive.
self.onmessage = ({ data }: MessageEvent<VariantRequest>) => {
  void backtest(data).then(result => {
    postMessage(result);
    process.exit();
  });
};
