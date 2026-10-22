import { gekkoPipeline } from '@gekko/core/core/pipeline/pipeline';
import { createRunContext } from '@gekko/core/run/runContext.helper';
import type { RunContext } from '@gekko/core/run/runContext.types';
import * as plugins from '@gekko/plugins/index';
import { describeError } from '@gekko/shared/errors/error.helper';
import type { VariantRequest, VariantResult } from '../fox.types';

declare let self: Worker;

/**
 * Backtests a variant as the executable runs a configuration file: its context built from the configuration (createRunContext, which
 * checks it again), the pipeline run with every plugin of the registry, then the storage closed, whatever the run did. Settles with
 * the outcome, failed when the run or the close of the storage failed, each failure as describeError writes it. Never rejects.
 */
const backtest = async ({ variant, configuration }: VariantRequest): Promise<VariantResult> => {
  const start = Date.now();
  const failures: string[] = [];
  let context: RunContext | undefined;
  try {
    context = createRunContext(configuration, `variant ${variant}`);
    await gekkoPipeline({ context, plugins });
  } catch (err) {
    failures.push(describeError(err));
  } finally {
    try {
      context?.services.closeStorage();
    } catch (err) {
      failures.push(`Could not close the storage: ${describeError(err)}`);
    }
  }
  const durationMs = Date.now() - start;
  return failures.length ? { variant, status: 'failed', error: failures.join('; '), durationMs } : { variant, status: 'done', durationMs };
};

// One variant per worker, so that each backtest starts from modules of its own. Not an async handler: Bun 1.3.14 aborts the whole
// process (SIGABRT, every worker with it) when the promise an onmessage handler returns rejects, where a promise of the handler's
// that rejects reaches the main thread as the worker's error event. The worker exits once its outcome is posted: a timer left by the
// run would keep it alive.
self.onmessage = ({ data }: MessageEvent<VariantRequest>) => {
  void backtest(data).then(result => {
    postMessage(result);
    process.exit();
  });
};
