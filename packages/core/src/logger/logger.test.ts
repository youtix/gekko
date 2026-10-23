import { LogLevel } from '@gekko/shared/models/logLevel.types';
import { pick, range } from 'lodash-es';
import { EOL } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Logger } from 'winston';

// The logger writes its lines to stdout with writeSync, which records them instead (see beforeEach): every copy of the logger the
// tests import writes through this one mock
const { writeSync } = vi.hoisted(() => ({ writeSync: vi.fn<(fd: number, bytes: Uint8Array, offset: number, length: number) => number>() }));
vi.mock('node:fs', async importOriginal => ({ ...(await importOriginal<typeof import('node:fs')>()), writeSync }));

type PrintedLine = { level: string; message: string };
/** A write of the logger: its descriptor and the text it was given */
type Write = { fd: number; text: string };
/** A line as the logger hands it to winston, which formats it before its level filter drops it */
type HandedLine = { level: string; message: string; _tag: string };
type WinstonLogger = { log: (line: HandedLine) => void };
type LogFunction = 'debug' | 'info' | 'warning' | 'error';

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

const notice = (value: string) =>
  `Invalid GEKKO_LOG_LEVEL '${value}', falling back to 'error'. Valid levels: error, warn, info, http, verbose, debug, silly.`;

describe('logger', () => {
  let writes: Write[];

  beforeEach(() => {
    writes = [];
    // Takes every byte it is given, as a pipe with room does
    writeSync.mockImplementation((fd, bytes, offset, length) => {
      writes.push({ fd, text: Buffer.from(bytes.subarray(offset, offset + length)).toString() });
      return length;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  /** What winston's level filter lets through, as the lines written to stdout give it: the level and the message of each */
  const printed = (): PrintedLine[] => writes.filter(({ fd }) => fd === 1).map(({ text }) => pick(JSON.parse(text), ['level', 'message']));

  // GEKKO_LOG_LEVEL is read when the module loads: every test imports a fresh copy
  const loadLogger = (logLevel: string | undefined) => {
    vi.stubEnv('GEKKO_LOG_LEVEL', logLevel);
    vi.resetModules();
    return import('./logger');
  };

  const logProbes = async (logLevel: string | undefined) => {
    const logger = await loadLogger(logLevel);
    logger.debug('gekko', 'probe');
    logger.info('gekko', 'probe');
    logger.warning('gekko', 'probe');
    logger.error('gekko', 'probe');
    // winston hands its first lines to the transport on a later tick
    await new Promise(resolve => setImmediate(resolve));
    return logger;
  };

  /** Logs each message through the logging function named, from a fresh copy of the module */
  const logWith = async (logLevel: string | undefined, logFunction: LogFunction, messages: unknown[]) => {
    const logger = await loadLogger(logLevel);
    messages.forEach(message => logger[logFunction]('gekko', message));
    // winston hands its first lines to the transport on a later tick
    await new Promise(resolve => setImmediate(resolve));
    return logger;
  };

  const isProbe = ({ message }: PrintedLine) => message === 'probe';

  it.each`
    logLevel     | levels
    ${undefined} | ${['error']}
    ${''}        | ${['error']}
    ${'error'}   | ${['error']}
    ${'warn'}    | ${['warn', 'error']}
    ${'WARN'}    | ${['warn', 'error']}
    ${'warning'} | ${['warn', 'error']}
    ${'WARNING'} | ${['warn', 'error']}
    ${'INFO'}    | ${['info', 'warn', 'error']}
    ${' info '}  | ${['info', 'warn', 'error']}
    ${'verbose'} | ${['info', 'warn', 'error']}
    ${'Debug'}   | ${['debug', 'info', 'warn', 'error']}
    ${'trace'}   | ${['error']}
  `('prints the $levels probes when GEKKO_LOG_LEVEL is $logLevel', async ({ logLevel, levels }) => {
    await logProbes(logLevel);
    expect(
      printed()
        .filter(isProbe)
        .map(({ level }) => level),
    ).toEqual(levels);
  });

  it.each`
    logLevel
    ${undefined}
    ${''}
    ${'WARN'}
    ${'warning'}
    ${' info '}
  `('prints no fallback notice when GEKKO_LOG_LEVEL is $logLevel', async ({ logLevel }) => {
    await logProbes(logLevel);
    expect(printed().filter(line => !isProbe(line))).toEqual([]);
  });

  it.each`
    logLevel
    ${'trace'}
    ${' Loud '}
  `('prints the fallback notice once, at error level, when GEKKO_LOG_LEVEL is $logLevel', async ({ logLevel }) => {
    await logProbes(logLevel);
    expect(printed().filter(line => !isProbe(line))).toEqual([{ level: 'error', message: notice(logLevel) }]);
  });

  // The levels winston prints, as the probes above show: a caller can skip a message below them, which winston formats only to drop it
  it.each`
    logLevel     | levels
    ${undefined} | ${['error']}
    ${'error'}   | ${['error']}
    ${'warning'} | ${['warn', 'error']}
    ${'WARN'}    | ${['warn', 'error']}
    ${' info '}  | ${['info', 'warn', 'error']}
    ${'http'}    | ${['info', 'warn', 'error']}
    ${'verbose'} | ${['info', 'warn', 'error']}
    ${'Debug'}   | ${['debug', 'info', 'warn', 'error']}
    ${'silly'}   | ${['debug', 'info', 'warn', 'error']}
    ${'trace'}   | ${['error']}
  `('enables the $levels levels when GEKKO_LOG_LEVEL is $logLevel', async ({ logLevel, levels }) => {
    const { isLevelEnabled } = await loadLogger(logLevel);
    expect(LOG_LEVELS.filter(level => isLevelEnabled(level))).toEqual(levels);
  });

  describe('stdout', () => {
    it('gets each line as JSON ending with a newline, written to descriptor 1', async () => {
      vi.useFakeTimers({ now: 1000, toFake: ['Date'] });
      await logWith(undefined, 'error', ['probe']);
      expect(writes).toEqual([
        { fd: 1, text: `{"_tag":"GEKKO","level":"error","message":"probe","timestamp":"1970-01-01T00:00:01.000Z"}${EOL}` },
      ]);
    });

    // Written before the call that logs it returns when the pipe takes it: a process.exit() right after it, as a worker of Fox makes
    // once it has posted its outcome, loses none of it (what the pipe does not take at once is written as the process exits)
    it.each`
      logFunction  | level
      ${'debug'}   | ${'debug'}
      ${'info'}    | ${'info'}
      ${'warning'} | ${'warn'}
      ${'error'}   | ${'error'}
    `('gets the $level line of $logFunction before the call returns', async ({ logFunction, level }) => {
      const logger = await logWith('debug', logFunction, []);
      logger[logFunction as LogFunction]('gekko', 'probe');
      expect(printed()).toEqual([{ level, message: 'probe' }]);
    });
  });

  // Fox's threads share stdout: each line written whole under one lock, so that no thread's line lands among the parts of another's
  describe('write lock', () => {
    /** The lock checked at each write, and whether it was held then */
    let lockView: BigInt64Array;
    let heldAtWrites: boolean[];

    beforeEach(() => {
      lockView = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
      heldAtWrites = [];
      writeSync.mockImplementation((_fd, _bytes, _offset, length) => {
        heldAtWrites.push(Atomics.load(lockView, 0) !== 0n);
        return length;
      });
    });

    it('shares the same lock of stdout at every call', async () => {
      const { shareWriteLock } = await loadLogger(undefined);
      expect(shareWriteLock()).toBe(shareWriteLock());
    });

    it('writes the lines logged once it shared its lock under that lock', async () => {
      const logger = await loadLogger(undefined);
      lockView = new BigInt64Array(logger.shareWriteLock());
      logger.error('gekko', 'probe');
      // winston hands its first lines to the transport on a later tick
      await new Promise(resolve => setImmediate(resolve));
      expect(heldAtWrites).toEqual([true]);
    });

    it('writes the lines logged under the lock another thread shares, once given it', async () => {
      const logger = await loadLogger(undefined);
      const lock = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
      lockView = new BigInt64Array(lock);
      logger.useWriteLock(lock);
      logger.error('gekko', 'probe');
      await new Promise(resolve => setImmediate(resolve));
      expect(heldAtWrites).toEqual([true]);
    });

    it('writes the lines logged without a lock while it neither shared nor was given one', async () => {
      await logWith(undefined, 'error', ['probe']);
      expect(heldAtWrites).toEqual([false]);
    });
  });

  describe('debug', () => {
    let handed: HandedLine[];
    let winstonLog: MockInstance<WinstonLogger['log']>;

    beforeEach(() => {
      handed = [];
      // Records what the logger hands to winston, instead of handing it on
      winstonLog = vi.spyOn(Logger.prototype as WinstonLogger, 'log').mockImplementation(({ level, message, _tag }) => {
        handed.push({ level, message, _tag });
      });
    });

    afterEach(() => {
      winstonLog.mockRestore();
    });

    // Below its level, a debug line went to winston, which formatted it only to drop it: the two lines the event emitter logs for every
    // deferred event took a fifth to a third of the time of a 1-minute backtest
    it.each`
      logLevel     | levels
      ${undefined} | ${[]}
      ${'info'}    | ${[]}
      ${'verbose'} | ${[]}
      ${'Debug'}   | ${['debug']}
      ${'silly'}   | ${['debug']}
    `('hands winston $levels when it logs with GEKKO_LOG_LEVEL $logLevel', async ({ logLevel, levels }) => {
      const { debug } = await loadLogger(logLevel);
      debug('gekko', 'probe');
      expect(handed.map(({ level }) => level)).toEqual(levels);
    });

    it('hands winston its line as it did, at its level, with its message and its tag upper-cased', async () => {
      const { debug } = await loadLogger('debug');
      debug('gekko', 'probe');
      expect(handed).toEqual([{ level: 'debug', message: 'probe', _tag: 'GEKKO' }]);
    });
  });

  it('keeps the fallback notice out of the ring buffer', async () => {
    const { getBufferedLogs } = await logProbes('trace');
    expect(getBufferedLogs().map(({ level, message }) => ({ level, message }))).toEqual([
      { level: 'warn', message: 'probe' },
      { level: 'error', message: 'probe' },
    ]);
  });

  describe('ring buffer', () => {
    // Only the levels the log monitoring forwards, whatever winston prints
    it.each`
      logLevel     | logFunction  | levels
      ${'debug'}   | ${'debug'}   | ${[]}
      ${'debug'}   | ${'info'}    | ${[]}
      ${'debug'}   | ${'warning'} | ${['warn']}
      ${'debug'}   | ${'error'}   | ${['error']}
      ${undefined} | ${'warning'} | ${['warn']}
    `('holds $levels once $logFunction has logged with GEKKO_LOG_LEVEL $logLevel', async ({ logLevel, logFunction, levels }) => {
      const { getBufferedLogs } = await logWith(logLevel, logFunction, ['probe']);
      expect(getBufferedLogs().map(({ level }) => level)).toEqual(levels);
    });

    it('holds the time, level, tag and message of a log', async () => {
      vi.useFakeTimers({ now: 1000, toFake: ['Date'] });
      const { getBufferedLogs } = await logWith(undefined, 'error', ['probe']);
      expect(getBufferedLogs()).toEqual([{ timestamp: 1000, level: 'error', tag: 'gekko', message: 'probe' }]);
    });

    it.each`
      message     | buffered
      ${'text'}   | ${'text'}
      ${{ a: 1 }} | ${'{"a":1}'}
    `('holds the message $message as $buffered', async ({ message, buffered }) => {
      const { getBufferedLogs } = await logWith(undefined, 'warning', [message]);
      expect(getBufferedLogs().map(log => log.message)).toEqual([buffered]);
    });

    it('keeps the newest 1000 logs, oldest first', async () => {
      const messages = range(1001).map(index => `w${index}`);
      const { getBufferedLogs } = await logWith(undefined, 'warning', messages);
      expect(getBufferedLogs().map(log => log.message)).toEqual(messages.slice(1));
    });

    it('returns the same entry objects to a later call', async () => {
      const { warning, getBufferedLogs } = await logWith(undefined, 'warning', ['w0']);
      const [entry] = getBufferedLogs();
      warning('gekko', 'w1');
      expect(getBufferedLogs()[0]).toBe(entry);
    });
  });
});
