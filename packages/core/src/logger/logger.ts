import { LogLevel } from '@gekko/shared/models/logLevel.types';
import { Tag } from '@gekko/shared/models/tag.types';
import { RingBuffer } from '@gekko/shared/helpers/collection/ringBuffer';
import { isString, upperCase } from 'lodash-es';
import { createLogger, format, transports } from 'winston';
import { BufferedLog } from '@gekko/shared/models/log.types';
import { createSyncWriteStream } from './logger.helper';
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

const logger = createLogger({
  level: logLevel,
  format: combine(timestamp(), json()),
  // Each line is written to stdout before the call that logs it returns (createSyncWriteStream), so that a process.exit() loses none:
  // winston's Console transport handed its lines to process.stdout, which Bun queues when a pipe is read slower than the process
  // writes, and the exit dropped what was queued (a worker of Fox exiting once its outcome is posted lost its last lines, Fox its
  // summary). A reader that stalls stalls the process in turn, as a pipe does under Node.
  transports: [new transports.Stream({ stream: createSyncWriteStream(STDOUT) })],
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
