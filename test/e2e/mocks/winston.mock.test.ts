import { describe, expect, it, mock } from 'bun:test';
import { MockWinston, clearLogs, logStore } from './winston.mock';

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
