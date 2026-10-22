/*

  Gekko is a modular crypto trading bot framework supporting backtesting, real-time trading, and custom strategies.

  Disclaimer:

  USE AT YOUR OWN RISK!

  The author of this project is NOT responsible for any damage or loss caused 
  by this software. There can be bugs and the bot may not perform as expected 
  or specified. Please consider testing it first with paper trading and/or 
  backtesting on historical data. Also look at the code to see what how 
  it is working.

*/

import { ApplicationStopError } from '@gekko/shared/errors/applicationStop.error';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { logFailure } from '@gekko/core/logger/failure.helper';
import { error, info, warning } from '@gekko/core/logger/logger';
import { logVersion } from '@gekko/shared/utils/process/process.utils';

const LOGO = `
  ______   ________  __    __  __    __   ______
 /      \\ /        |/  |  /  |/  |  /  | /      \\
/$$$$$$  |$$$$$$$$/ $$ | /$$/ $$ | /$$/ /$$$$$$  |
$$ | _$$/ $$ |__    $$ |/$$/  $$ |/$$/  $$ |  $$ |
$$ |/    |$$    |   $$  $$<   $$  $$<   $$ |  $$ |
$$ |$$$$ |$$$$$/    $$$$$  \\  $$$$$  \\  $$ |  $$ |
$$ \\__$$ |$$ |_____ $$ |$$  \\ $$ |$$  \\ $$ \\__$$ |
$$    $$/ $$       |$$ | $$  |$$ | $$  |$$    $$/
 $$$$$$/  $$$$$$$$/ $$/   $$/ $$/   $$/  $$$$$$/
`;

/** Closes the storage if one was created. A no-op until main() has built the context of the run, before which none can be. */
let closeStorage = () => {};

export const main = async () => {
  let exitCode: number | undefined; // undefined: the run ended normally
  try {
    const path = process.env['GEKKO_CONFIG_FILE_PATH'];
    if (!path) throw new GekkoError('configuration', 'Missing GEKKO_CONFIG_FILE_PATH environment variable');
    // Imported here rather than statically, as the pipeline and the plugins are below: a module that throws as it is evaluated (a strategy
    // of custom/ importing a path that moved, which the plugins load with the built-in ones) would throw before the process handlers are
    // registered, printed raw by Bun, instead of being reported below like any other failure.
    const { loadConfigurationFile } = await import('@gekko/core/configuration/configuration.helper');
    const { createRunContext } = await import('@gekko/core/run/runContext.helper');
    // The configuration and the services of the run, which the pipeline hands to every plugin: the file read and checked by the schema
    const context = createRunContext(loadConfigurationFile(path), `file ${path}`);
    // eslint-disable-next-line no-console
    if (context.configuration.showLogo()) console.log(LOGO);
    info('gekko', logVersion());
    closeStorage = () => context.services.closeStorage();
    const { gekkoPipeline } = await import('@gekko/core/core/pipeline/pipeline');
    const plugins = await import('@gekko/plugins/index');
    await gekkoPipeline({ context, plugins }); // Launch bot
  } catch (e) {
    if (e instanceof ApplicationStopError) {
      // An orderly stop (circuit breaker) is not a crash: exit 0 so that a restart-on-failure supervisor leaves it stopped
      error('gekko', `Application stopped: ${e.message}`);
      // 0 even if onUnhandledRejection set process.exitCode to 1: a floated timer-driven task (a Telegram send, an order poll) may
      // have rejected along the way, and exit 1 would get the bot restarted by a restart-on-failure supervisor, its counter reset
      exitCode = 0;
    } else {
      logFailure('gekko', e);
      exitCode = 1;
    }
  } finally {
    // A close that fails can leave buffered minutes out of the database: a run that had ended normally then ends with code 1, by
    // itself as it would have (as after an unhandled rejection), and a stopped or failed run keeps its code. Thrown from here, the
    // failure skipped the exit below, and Bun handed the rejected `await main()` to onUncaughtException, which reported an uncaught
    // exception and exited 1 whatever the run's code
    if (!closeStorageLoggingFailure() && exitCode === undefined) process.exitCode = 1;
  }
  // A stopped or failed run exits explicitly, after the cleanup: in realtime mode, timers (order polling, hearts) would keep it alive
  if (exitCode !== undefined) process.exit(exitCode);
};

/**
 * Closes the storage and logs its failure: when its last insert fails, the one that names the buffered minutes the database did not
 * get, for an import of their range to write them (SQLiteStorage.close). False when the close failed.
 */
const closeStorageLoggingFailure = () => {
  try {
    closeStorage();
    return true;
  } catch (e) {
    logFailure('gekko', e, 'Could not close the storage: ');
    return false;
  }
};

const onUncaughtException = (e: unknown) => {
  logFailure('gekko', e, 'Uncaught exception: ');
  try {
    closeStorageLoggingFailure(); // Its failure, which can name minutes the database did not get, was swallowed without a line
  } catch {
    // Nothing may keep the process from exiting, not even the logger failing on that line
  }
  process.exit(1);
};

// Not fatal: timer-driven tasks (realtime candle fetch, Trader sync, order polling, Telegram sends) float promises that
// reject on transient network failures, and a network blip must not kill a live bot. The exit code still reports it.
const onUnhandledRejection = (reason: unknown) => {
  logFailure('gekko', reason, 'Unhandled rejection: ');
  process.exitCode = 1;
};

// Ctrl-C, or a supervisor stopping the bot. The plugins are not finalised, but the storage is closed so that the candles it
// buffers are written. The exit code is 128 + the signal number, as a shell reports a process the signal killed.
const onSignal = (signal: 'SIGINT' | 'SIGTERM', exitCode: number) => () => {
  warning('gekko', `Received ${signal}: closing the storage and exiting without finalising the plugins`);
  closeStorageLoggingFailure();
  process.exit(exitCode);
};

// Without them, while `await main()` is pending, Bun only prints these errors on stderr and the process keeps running
process.on('uncaughtException', onUncaughtException);
process.on('unhandledRejection', onUnhandledRejection);
process.on('SIGINT', onSignal('SIGINT', 130));
process.on('SIGTERM', onSignal('SIGTERM', 143));

await main();
