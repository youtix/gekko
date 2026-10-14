import type { LogLevel } from '@models/logLevel.types';
import type { Tag } from '@models/tag.types';

/**
 * A line as the logger hands it to winston (`src/services/logger.ts`): its level, its message as it was logged, an object included (the
 * analyzers log their reports and round trips whole), and its tag upper-cased under `_tag` ('TRADING ADVISOR'). The mock typed a `tag`,
 * which reads undefined, and a string message, on which a flow could call a string method that a logged object does not have.
 */
export type LoggedLine = { level: LogLevel; message: unknown; _tag: Uppercase<Tag> };

/** A line whose message was logged as text */
export type TextLine = LoggedLine & { message: string };

export const logStore: LoggedLine[] = [];

/** Whether the line was logged as text, which a flow can search, rather than as an object */
export const isTextLine = (line: LoggedLine): line is TextLine => typeof line.message === 'string';

export const clearLogs = () => {
  logStore.length = 0;
};

export const MockWinstonLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  verbose: () => {},
  silly: () => {},
  log: (line: LoggedLine) => {
    logStore.push(line);
  },
  add: () => {},
  remove: () => {},
  clear: () => {},
  close: () => {},
  child: () => MockWinstonLogger,
};

export const MockWinstonTransport = class {
  constructor() {}
};

export const MockWinstonFormat = {
  combine: () => {},
  timestamp: () => {},
  label: () => {},
  json: () => {},
  printf: () => {},
  colorize: () => {},
  simple: () => {},
  splat: () => {},
  ms: () => {},
  metadata: () => {},
  padLevels: () => {},
  prettyPrint: () => {},
};

export const MockWinston = {
  createLogger: () => MockWinstonLogger,
  transports: {
    Console: MockWinstonTransport,
    File: MockWinstonTransport,
    Http: MockWinstonTransport,
    Stream: MockWinstonTransport,
  },
  format: MockWinstonFormat,
};
