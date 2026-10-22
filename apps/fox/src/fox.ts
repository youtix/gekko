/*

  Fox backtests the variants of a Gekko configuration template, several at a time, each in a worker thread of its own: the values its
  command line gives some keys of the template, in lists and ranges, make one variant of each combination. The PerformanceReporter of
  the template writes the figures of each variant as a row of its CSV file.

*/

import { info } from '@gekko/core/logger/logger';
import { logVersion } from '@gekko/shared/utils/process/process.utils';
import { pluralize } from '@gekko/shared/utils/string/string.utils';
import { parseCommandLine } from './cli/cli.helper';
import { logFailure } from '@gekko/core/logger/failure.helper';
import { logSummary } from './fox.helper';

export const main = async () => {
  try {
    const options = parseCommandLine(process.argv.slice(2), process.env);
    // undefined: commander printed the help
    if (options) {
      const { templatePath, maxWorkers, overrides } = options;
      info('fox', logVersion());
      // Not imported statically, and neither is the worker helper: the registries of the strategies and of the plugins load every
      // strategy, a private one of custom/ included, whose import can throw (a path that moved), as the module is evaluated. From a
      // static import, that error would be thrown before the process handlers are registered and printed raw by Bun, instead of being
      // reported below like any other failure.
      const { generateVariants, loadTemplate, validateVariants } = await import('./configuration/variants.helper');
      const { runWorkers } = await import('./worker/worker.helper');
      const variants = generateVariants(loadTemplate(templatePath), overrides);
      validateVariants(variants);
      const count = `${variants.length} ${pluralize('variant', variants.length)}`;
      info('fox', `Backtesting ${count} of ${templatePath}, ${Math.min(maxWorkers, variants.length)} at a time`);
      if (logSummary(await runWorkers(variants, maxWorkers))) process.exitCode = 1;
    }
  } catch (e) {
    logFailure('fox', e);
    process.exitCode = 1;
  }
  // Explicitly, once every worker is over: whatever a module loaded for the checks left behind cannot keep Fox alive. With the code set
  // above, or by onUnhandledRejection: 0 when it is unset
  process.exit();
};

const onUncaughtException = (e: unknown) => {
  logFailure('fox', e, 'Uncaught exception: ');
  process.exit(1);
};

// Not fatal, as for the executable: the exit code reports it once the variants are over
const onUnhandledRejection = (reason: unknown) => {
  logFailure('fox', reason, 'Unhandled rejection: ');
  process.exitCode = 1;
};

// Without them, while `await main()` is pending, Bun only prints these errors on stderr and the process keeps running
process.on('uncaughtException', onUncaughtException);
process.on('unhandledRejection', onUnhandledRejection);

await main();
