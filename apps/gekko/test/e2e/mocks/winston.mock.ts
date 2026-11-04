import type { RoundTrip } from '@gekko/shared/models/event.types';
import type { LogLevel } from '@gekko/shared/models/logLevel.types';
import type { Tag } from '@gekko/shared/models/tag.types';

/**
 * A line as the logger hands it to winston (`packages/core/src/logger/logger.ts`): its level, its message as it was logged, an object included (the
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

/** An order id as the StrategyManager draws it, a random UUID, which the log lines and the Telegram posts of the orders quote */
export const ORDER_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * The messages with each order id replaced by the name `label` gives its rank, numbered from 1 in the order the ids first appear,
 * `order <rank>` by default: the lines of one order keep one name, from run to run
 */
export const withOrderNumbers = (messages: string[], label = (rank: number) => `order ${rank}`) => {
  const ranks = new Map<string, number>();
  const rankOf = (id: string) => ranks.get(id) ?? ranks.set(id, ranks.size + 1).size;
  return messages.map(message => message.replace(ORDER_ID, id => label(rankOf(id))));
};

/**
 * The lines logged as text, oldest first, each order named by its rank among the orders of the log, in the order the log first names
 * them (see withOrderNumbers): an order keeps its name whatever lines a test keeps of the log
 */
export const numberedTextLines = (label?: (rank: number) => string): TextLine[] => {
  const lines = logStore.filter(isTextLine);
  const messages = withOrderNumbers(
    lines.map(({ message }) => message),
    label,
  );
  return lines.map((line, index) => ({ ...line, message: messages[index] }));
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

/** The report an analyzer logged as the plugins were finalised: the PortfolioAnalyzer logs the length of its equity curve, not the curve */
export const loggedReport = (id: 'TRADING REPORT' | 'PORTFOLIO PROFIT REPORT') => findLoggedObject(message => message.id === id);

/**
 * The round trips the RoundTripAnalyzer logged as they closed, oldest first: the objects logged with a number for id, from 0, where a
 * report is named by its id
 */
export const loggedRoundTrips = () =>
  logStore
    .map(({ message }) => message)
    .filter(message => typeof message === 'object' && message !== null && typeof (message as RoundTrip).id === 'number');

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

/** The transport the logger builds its winston logger with, a Stream over stdout, which the mock's logger never writes to */
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
  transports: { Stream: MockWinstonTransport },
  format: MockWinstonFormat,
};
