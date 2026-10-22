import { LogLevel } from '@gekko/shared/models/logLevel.types';
import { Tag } from '@gekko/shared/models/tag.types';
import { RingBuffer } from '@gekko/shared/helpers/collection/ringBuffer';
import { isString, upperCase } from 'lodash-es';
import { createLogger, format, transports } from 'winston';
import { BufferedLog } from '@gekko/shared/models/log.types';
import { LineWriter } from './lineWriter';
import { LogInput } from './logger.types';
const { combine, timestamp, json } = format;

/** The standard output's descriptor, which every line is written to, whatever its level */
const STDOUT = 1;

/**
 * The levels kept in the buffer: the ones the log monitoring of Supervision, which the buffer is for, forwards to Telegram, whatever
 * GEKKO_LOG_LEVEL is (it only decides what winston prints). Buffered too, the info and debug logs of the order polls, a few per poll
 * of each open order (about 1080 a minute for 30 orders polled every 5 s), evicted the warnings and errors before the monitoring
 * read them.
 */
const BUFFERED_LEVELS: LogLevel[] = ['warn', 'error'];

/**
 * The last warnings and errors, oldest first, the oldest evicted first. 1000 of them is an hour of warnings at one every 3.6 s,
 * far more than pile up between two checks of the log monitoring (a minute apart by default).
 */
const logBuffer = new RingBuffer<BufferedLog>(1000);

const DEFAULT_LOG_LEVEL = 'error';
// winston's npm levels. Not read from winston's `config`, which the e2e winston mock does not provide.
const LOG_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];

// winston accepts any level, and with an unknown one it silently drops every message
const resolveLogLevel = (value: string | undefined) => {
  if (!value) return { level: DEFAULT_LOG_LEVEL };
  const normalized = value.trim().toLowerCase();
  const level = normalized === 'warning' ? 'warn' : normalized;
  return LOG_LEVELS.includes(level) ? { level } : { level: DEFAULT_LOG_LEVEL, rejected: value };
};

const { level: logLevel, rejected: rejectedLogLevel } = resolveLogLevel(process.env.GEKKO_LOG_LEVEL);

/** The levels winston prints: from the most severe down to GEKKO_LOG_LEVEL */
const enabledLevels = new Set(LOG_LEVELS.slice(0, LOG_LEVELS.indexOf(logLevel) + 1));

/**
 * Whether winston prints the messages of `level`, as GEKKO_LOG_LEVEL decides it (`warning` read as `warn`, an unknown value as
 * `error`). winston formats a message before its level filter drops it: `debug` skips its messages below their level itself, and an
 * info message that is only ever printed, and costs that format on every candle, can be skipped below it. Not a warning or an error,
 * which the buffer keeps whatever GEKKO_LOG_LEVEL.
 */
export const isLevelEnabled = (level: LogLevel) => enabledLevels.has(level);

/**
 * The lines of this thread, written to stdout in order, none lost to a process.exit(): winston's Console transport handed them to
 * process.stdout, which Bun queues when a pipe is read slower than the process writes, and the exit dropped what was queued (a worker
 * of Fox exiting once its outcome is posted lost its last lines, Fox its summary). What the pipe does not take at once waits in a queue,
 * written as the reader makes room, at the latest as the process exits, the event loop running meanwhile; the threads of Fox, which
 * share the pipe (shareWriteLock, useWriteLock), write each line whole under a lock before the call that logs it returns (see
 * LineWriter).
 */
const stdout = new LineWriter(STDOUT);

const logger = createLogger({
  level: logLevel,
  format: combine(timestamp(), json()),
  transports: [new transports.Stream({ stream: stdout })],
});

if (rejectedLogLevel !== undefined) {
  logger.log({
    level: 'error',
    message: `Invalid GEKKO_LOG_LEVEL '${rejectedLogLevel}', falling back to '${logLevel}'. Valid levels: ${LOG_LEVELS.join(', ')}.`,
    _tag: 'CONFIGURATION',
  });
}

const log = ({ tag, message, level }: LogInput) => {
  if (BUFFERED_LEVELS.includes(level))
    logBuffer.push({ timestamp: Date.now(), level, tag, message: isString(message) ? message : JSON.stringify(message) });
  logger.log({ level, message: message as string, _tag: upperCase(tag) });
};

export const debug = (tag: Tag, message: unknown) => {
  // Below its level, a debug line went to winston, which formatted it only to drop it: the two lines the event emitter logs for every
  // deferred event took a fifth to a third of the time of a 1-minute backtest
  if (isLevelEnabled('debug')) log({ tag, message, level: 'debug' });
};

export const info = (tag: Tag, message: unknown) => {
  log({ tag, message, level: 'info' });
};

export const warning = (tag: Tag, message: unknown) => {
  log({ tag, message, level: 'warn' });
};

export const error = (tag: Tag, message: unknown) => {
  log({ tag, message, level: 'error' });
};

/** The buffered warnings and errors, oldest first: the same entry objects on every call, so that a reader can find where it left off */
export const getBufferedLogs = () => logBuffer.toArray();

/**
 * The lock of stdout, under which the lines of this thread are written from now on, created at the first call, for the workers this
 * thread starts, which write theirs under it too (useWriteLock): no thread's line lands among the parts of another's that a pipe takes
 * in several writes (above 4096 bytes). Fox's main thread hands it to each worker.
 */
export const shareWriteLock = (): SharedArrayBuffer => stdout.shareLock();

/** Writes the lines of this thread under the lock of stdout another thread shares (shareWriteLock) from now on: a worker of Fox's */
export const useWriteLock = (lock: SharedArrayBuffer) => stdout.useLock(lock);
