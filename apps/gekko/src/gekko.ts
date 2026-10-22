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
import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { debug, error, info, warning } from '@gekko/core/logger/logger';
import { logVersion } from '@gekko/shared/utils/process/process.utils';
import { isNil } from 'lodash-es';

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

/** Closes the storage if one was created. A no-op until main() has loaded the injecter, before which none can be. */
let closeStorage = () => {};

export const main = async () => {
  let exitCode: number | undefined; // undefined: the run ended normally
  try {
    // Not imported statically, and neither are the injecter and the pipeline, which import it: `config` is built when its module
    // is evaluated and throws on an invalid configuration file. From a static import, that error would be thrown before the
    // process handlers are registered and printed raw by Bun, instead of being reported below like any other failure.
    const { config } = await import('@gekko/core/configuration/configuration');
    // eslint-disable-next-line no-console
    if (config.showLogo()) console.log(LOGO);
    info('gekko', logVersion());
    const { inject } = await import('@gekko/core/injecter/injecter');
    closeStorage = () => inject.closeStorage();
    const { gekkoPipeline } = await import('@gekko/core/core/pipeline/pipeline');
    const plugins = await import('@gekko/plugins/index');
    await gekkoPipeline({ plugins }); // Launch bot
  } catch (e) {
    if (e instanceof ApplicationStopError) {
      // An orderly stop (circuit breaker) is not a crash: exit 0 so that a restart-on-failure supervisor leaves it stopped
      error('gekko', `Application stopped: ${e.message}`);
      // 0 even if onUnhandledRejection set process.exitCode to 1: a floated timer-driven task (a Telegram send, an order poll) may
      // have rejected along the way, and exit 1 would get the bot restarted by a restart-on-failure supervisor, its counter reset
      exitCode = 0;
    } else {
      logFailure(e);
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

// "<name>: <message>", then the frames. A stack usually starts with that line, but not always: in Bun, a DOMException's stack
// (the DataCloneError of structuredClone, for one) is frames only.
const describeStack = (e: Error) => {
  const header = String(e);
  return e.stack?.startsWith(header) ? e.stack : [header, e.stack].filter(Boolean).join('\n');
};

// An Error in full, any other value as describeError writes it
const describeValue = (value: unknown) => (value instanceof Error ? describeStack(value) : describeError(value));

// Down to the root cause (inspect() cuts a chain after two causes), stopping at a cause already listed: a chain can loop
const describeCauses = (failure: unknown) => {
  const chain = [failure];
  let link = failure;
  while (link instanceof Error && !isNil(link.cause) && !chain.includes(link.cause)) {
    link = link.cause;
    chain.push(link);
  }
  return chain.slice(1).map(cause => `Caused by: ${describeValue(cause)}`);
};

/**
 * How main() and the process handlers report a failure. A GekkoError is expected and its one-line message explains it: the
 * message at error level, the stack at debug level. Anything else is unexpected: name, message and stack at error level. Causes,
 * whatever the failure, follow in full on the error-level line.
 */
const logFailure = (failure: unknown, prefix = '') => {
  const isExpected = failure instanceof GekkoError;
  error('gekko', [`${prefix}${isExpected ? failure.message : describeValue(failure)}`, ...describeCauses(failure)].join('\n'));
  if (isExpected) debug('gekko', `${prefix}${describeStack(failure)}`);
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
    logFailure(e, 'Could not close the storage: ');
    return false;
  }
};

const onUncaughtException = (e: unknown) => {
  logFailure(e, 'Uncaught exception: ');
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
  logFailure(reason, 'Unhandled rejection: ');
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
