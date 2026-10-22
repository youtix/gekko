import { debug, error, info, shareWriteLock } from '@gekko/core/logger/logger';
import { formatDurationUTC } from '@gekko/shared/utils/date/date.utils';
import { times } from 'lodash-es';
import type { Template, Variant, VariantRequest, VariantResult } from '../fox.types';

/** A line of the code frame Bun writes above an uncaught error: a numbered line of source (`5 |   throw …`) or the caret under it */
const CODE_FRAME_LINE = /^\s*(\d+ \|.*|\^)$/;

/**
 * The message of the `error` event of a worker that failed outside of its backtest (a timer of a plugin throwing, a module that could
 * not be loaded), without the lines of source Bun writes above the error: the error and its frames are left.
 */
export const describeWorkerError = (message: string) =>
  message
    .split('\n')
    .filter(line => !CODE_FRAME_LINE.test(line))
    .join('\n')
    .trim();

/**
 * Backtests one variant in a worker of its own, which runs `workerModule` (the URL of gekko.worker.ts, as fox.ts resolves it), and
 * settles with its result: the one the worker posts, or a failure when the worker fails before it posts one (its `error` event) or ends
 * without posting one (its `close` event). The worker is terminated once the result is in: a worker left running keeps Fox alive. Never
 * rejects but for a worker that cannot be created.
 */
export const runWorker = (variant: number, configuration: Template, workerModule: string): Promise<VariantResult> =>
  new Promise(resolve => {
    const start = Date.now();
    const worker = new Worker(workerModule);
    let isSettled = false;
    const settle = (result: VariantResult) => {
      if (isSettled) return;
      isSettled = true;
      worker.terminate();
      resolve(result);
    };
    const fail = (reason: string) => settle({ variant, status: 'failed', error: reason, durationMs: Date.now() - start });
    worker.addEventListener('message', ({ data }: MessageEvent<VariantResult>) => settle(data));
    worker.addEventListener('error', ({ message }) => fail(describeWorkerError(message)));
    worker.addEventListener('close', ({ code }) => fail(`its worker ended with code ${code} without reporting an outcome`));
    // The lock of stdout this thread writes under from now on, under which the worker writes its lines too
    const request: VariantRequest = { variant, configuration, writeLock: shareWriteLock() };
    worker.postMessage(request);
  });

/** A duration for a person to read: "2 minutes 5 seconds" */
const formatDuration = (durationMs: number) => formatDurationUTC(0, durationMs) || 'less than a second';

/**
 * Backtests the variants, `maxWorkers` at a time, each in a worker of its own, which runs `workerModule` (see runWorker): the next one
 * starts as soon as one ends. Logs a line as each starts and as each ends, at info level, a failed one's at error level with its reason,
 * followed at debug level by what its worker posted of a failure whose message does not say where it came from (see
 * VariantResult.stack). Settles once every variant is over, with their results in the order of the variants, failed ones included.
 */
export const runWorkers = async (variants: readonly Variant[], maxWorkers: number, workerModule: string): Promise<VariantResult[]> => {
  const results: VariantResult[] = [];
  let next = 0;
  const runNextVariants = async () => {
    for (let index = next++; index < variants.length; index = next++) {
      const { variant, label, configuration } = variants[index];
      const name = `Variant ${variant} of ${variants.length}${label ? ` (${label})` : ''}`;
      info('fox', `${name} started`);
      const result = await runWorker(variant, configuration, workerModule);
      if (result.status === 'done') info('fox', `${name} done in ${formatDuration(result.durationMs)}`);
      else error('fox', `${name} failed after ${formatDuration(result.durationMs)}: ${result.error}`);
      if (result.stack) debug('fox', `${name}: ${result.stack}`);
      results[index] = result;
    }
  };
  await Promise.all(times(Math.min(maxWorkers, variants.length), runNextVariants));
  return results;
};
