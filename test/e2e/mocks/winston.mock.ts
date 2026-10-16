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

/** The lines logged as text that include `text`, at `level` when one is given, oldest first */
export const findTextLines = (text: string, level?: LogLevel): TextLine[] =>
  logStore.filter(isTextLine).filter(line => line.message.includes(text) && (level === undefined || line.level === level));

/** The first line logged as text that includes `text`, at `level` when one is given */
export const findTextLine = (text: string, level?: LogLevel): TextLine | undefined => findTextLines(text, level).at(0);

/** The first message logged as an object (a report, a round trip) that `matches` accepts */
export const findLoggedObject = (matches: (message: Record<string, any>) => boolean): Record<string, any> | undefined =>
  logStore
    .map(({ message }) => message)
    .find((message): message is Record<string, any> => typeof message === 'object' && message !== null && matches(message));

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

/** The formats the logger builds its winston logger with */
export const MockWinstonFormat = {
  combine: () => {},
  timestamp: () => {},
  json: () => {},
};

export const MockWinston = {
  createLogger: () => MockWinstonLogger,
  transports: { Console: MockWinstonTransport },
  format: MockWinstonFormat,
};
