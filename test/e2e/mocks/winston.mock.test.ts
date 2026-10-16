import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MockWinston, clearLogs, findLoggedObject, findTextLine, findTextLines, logStore, type LoggedLine } from './winston.mock';

mock.module('winston', () => MockWinston);

describe('MockWinston', () => {
  // The flows read the stored lines through LoggedLine: a line the logger hands winston in another shape fails here, rather than in a
  // flow reading a field that no line has
  it('stores each line as the logger hands it to winston, its message as logged and its tag upper-cased under _tag', async () => {
    const { error, info, warning } = await import('@services/logger');
    clearLogs(); // Loaded with an invalid GEKKO_LOG_LEVEL, the logger hands its notice first
    const report = { id: 'TRADING REPORT', netProfit: 1 };
    info('roundtrip analyzer', report);
    warning('stream', 'probe');
    error('trading advisor', 'probe');
    expect(logStore).toStrictEqual([
      { level: 'info', message: report, _tag: 'ROUNDTRIP ANALYZER' },
      { level: 'warn', message: 'probe', _tag: 'STREAM' },
      { level: 'error', message: 'probe', _tag: 'TRADING ADVISOR' },
    ]);
  });
});

describe('the finders of the logged lines', () => {
  const report = { id: 'TRADING REPORT', netProfit: 1 };
  const roundtrip = { id: 0, entryAt: 1, exitAt: 2, profit: 3 };
  const lines: LoggedLine[] = [
    { level: 'info', message: 'Trigger BUY for BTC/USDT', _tag: 'STRATEGY' },
    { level: 'info', message: roundtrip, _tag: 'ROUNDTRIP ANALYZER' },
    { level: 'warn', message: 'Ignored a duplicate 1m candle of BTC/USDT', _tag: 'STREAM' },
    { level: 'debug', message: 'Trigger SELL for BTC/USDT', _tag: 'STRATEGY' },
    { level: 'warn', message: 'Ignored a duplicate 1m candle of ETH/USDT', _tag: 'STREAM' },
    { level: 'info', message: report, _tag: 'ROUNDTRIP ANALYZER' },
  ];

  beforeEach(() => {
    clearLogs();
    logStore.push(...lines);
  });

  it.each<[string, Parameters<typeof findTextLines>, LoggedLine[]]>([
    ['the lines that include the text, oldest first', ['Ignored a duplicate'], [lines[2], lines[4]]],
    ['the lines of any level when none is given', ['Trigger'], [lines[0], lines[3]]],
    ['only the lines of the level given', ['Trigger', 'debug'], [lines[3]]],
    ['no line when none includes the text', ['Trigger BUY for ETH/USDT'], []],
  ])('findTextLines should give %s', (_title, [text, level], expected) => {
    expect<LoggedLine[]>(findTextLines(text, level)).toEqual(expected);
  });

  it.each<[string, Parameters<typeof findTextLine>, LoggedLine | undefined]>([
    ['the first line that includes the text', ['Ignored a duplicate'], lines[2]],
    ['the first line of the level given', ['Ignored a duplicate', 'warn'], lines[2]],
    ['undefined when no line of that level includes it', ['Ignored a duplicate', 'error'], undefined],
  ])('findTextLine should give %s', (_title, [text, level], expected) => {
    expect<LoggedLine | undefined>(findTextLine(text, level)).toEqual(expected);
  });

  it.each<[string, Parameters<typeof findLoggedObject>[0], object | undefined]>([
    ['the first object the predicate accepts', message => message.id === 'TRADING REPORT', report],
    ['an object, not a line of text', message => 'entryAt' in message, roundtrip],
    ['undefined when it accepts none', message => message.id === 'PORTFOLIO PROFIT REPORT', undefined],
  ])('findLoggedObject should give %s', (_title, matches, expected) => {
    expect(findLoggedObject(matches)).toBe(expected);
  });
});
