import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { describe, expect, it, vi } from 'vitest';
import { logFailure } from './failure.helper';
import { debug, error } from './logger';

vi.mock('./logger', () => ({ debug: vi.fn(), error: vi.fn() }));

/** An Error whose stack is what Bun gives a DOMException: frames only, without its "<name>: <message>" line */
const framesOnly = Object.assign(new Error('The object can not be cloned.'), { name: 'DataCloneError', stack: '    at structuredClone' });
const withoutStack = Object.assign(new Error('no frames'), { stack: undefined });

/** `error`, thrown at `frame` alone: its stack is its "<name>: <message>" line, then that frame, for a test to write it out whole */
const thrownAt = <E extends Error>(error: E, frame: string): E => Object.assign(error, { stack: `${String(error)}\n    at ${frame}` });

describe('logFailure', () => {
  describe('of a GekkoError', () => {
    const failure = new GekkoError('core', 'the run failed');

    it('should log its message at error level', () => {
      logFailure('gekko', failure);

      expect(error).toHaveBeenCalledExactlyOnceWith('gekko', '[CORE] the run failed');
    });

    it('should log its stack at debug level', () => {
      logFailure('gekko', failure);

      expect(debug).toHaveBeenCalledExactlyOnceWith('gekko', expect.stringMatching(/^GekkoError: \[CORE\] the run failed\n\s+at /));
    });

    it('should start both lines with the prefix', () => {
      logFailure('gekko', failure, 'Uncaught exception: ');

      expect(vi.mocked(debug).mock.calls[0][1]).toMatch(/^Uncaught exception: GekkoError: /);
    });
  });

  it.each`
    description                              | failure                                                | expected
    ${'an Error, with its stack'}            | ${new TypeError('x is undefined')}                     | ${/^TypeError: x is undefined\n\s+at /}
    ${'an Error whose stack is frames only'} | ${framesOnly}                                          | ${/^DataCloneError: The object can not be cloned\.\n {4}at structuredClone$/}
    ${'an Error without a stack'}            | ${withoutStack}                                        | ${/^Error: no frames$/}
    ${'a value that is not an Error'}        | ${'a plain text'}                                      | ${/^a plain text$/}
    ${'a GekkoError with its causes'}        | ${new GekkoError('core', 'outer', { cause: 'inner' })} | ${/^\[CORE\] outer\nCaused by: inner$/}
  `('should log $description at error level', ({ failure, expected }) => {
    logFailure('gekko', failure);

    expect(vi.mocked(error).mock.calls[0][1]).toMatch(expected);
  });

  it('should log the cause of a cause', () => {
    logFailure('gekko', new GekkoError('core', 'outer', { cause: new GekkoError('core', 'middle', { cause: 'root' }) }));

    expect(vi.mocked(error).mock.calls[0][1]).toMatch(/^\[CORE\] outer\nCaused by: GekkoError: \[CORE\] middle\n[\s\S]+\nCaused by: root$/);
  });

  it('should stop at a cause already listed', () => {
    const looping = new Error('looping');
    looping.cause = looping;
    logFailure('gekko', new GekkoError('core', 'outer', { cause: looping }));

    expect(String(vi.mocked(error).mock.calls[0][1]).match(/Caused by: /g)).toHaveLength(1);
  });

  it('should log nothing at debug level for a failure that is not a GekkoError', () => {
    logFailure('gekko', new Error('boom'));

    expect(debug).not.toHaveBeenCalled();
  });

  // As PluginsStream rejects a run whose plugins failed to finalize: the message of each failure, then their AggregateError as the
  // cause, whose own frames are those of the stream. The frames of the failures, which say where each was thrown, were logged nowhere
  describe('of a failure caused by an AggregateError', () => {
    const analyzerFailure = thrownAt(new TypeError('report is undefined'), 'analyzerFinalize (portfolioAnalyzer.ts:120:7)');
    const reporterFailure = thrownAt(new RangeError('Invalid array length'), 'reporterFinalize (performanceReporter.ts:88:3)');
    /** The run's failure, caused by the AggregateError of `errors` */
    const failureOf = (errors: unknown[]) =>
      new GekkoError('stream', 'two plugins failed to finalize', {
        cause: thrownAt(
          new AggregateError(errors, `${errors.length} plugins failed to finalize`),
          'finalizePlugins (plugins.stream.ts:259:21)',
        ),
      });
    /** The lines that open the error-level line of failureOf, for `count` errors */
    const opening = (count: number) => [
      '[STREAM] two plugins failed to finalize',
      `Caused by: AggregateError: ${count} plugins failed to finalize`,
      '    at finalizePlugins (plugins.stream.ts:259:21)',
    ];
    const selfHolding = new AggregateError([], 'holds itself');
    selfHolding.errors.push(selfHolding, analyzerFailure);

    it.each`
      description                                          | failure                                                                                                  | lines
      ${'each error it holds, in full'}                    | ${failureOf([analyzerFailure, reporterFailure])}                                                         | ${[...opening(2), 'Error 1 of 2: TypeError: report is undefined', '    at analyzerFinalize (portfolioAnalyzer.ts:120:7)', 'Error 2 of 2: RangeError: Invalid array length', '    at reporterFinalize (performanceReporter.ts:88:3)']}
      ${'what caused an error it holds, after that error'} | ${failureOf([thrownAt(new Error('outer', { cause: 'inner' }), 'end (my.strategy.ts:13:39)'), 'a text'])} | ${[...opening(2), 'Error 1 of 2: Error: outer', '    at end (my.strategy.ts:13:39)', 'Caused by: inner', 'Error 2 of 2: a text']}
      ${'an error it holds twice, once'}                   | ${failureOf([reporterFailure, reporterFailure])}                                                         | ${[...opening(2), 'Error 1 of 2: RangeError: Invalid array length', '    at reporterFinalize (performanceReporter.ts:88:3)']}
      ${'its errors, not itself, when it holds itself'}    | ${thrownAt(selfHolding, 'any (promise.ts:1:1)')}                                                         | ${['AggregateError: holds itself', '    at any (promise.ts:1:1)', 'Error 2 of 2: TypeError: report is undefined', '    at analyzerFinalize (portfolioAnalyzer.ts:120:7)']}
      ${'no error when its errors are no list'}            | ${Object.assign(thrownAt(new AggregateError([], 'none'), 'any (promise.ts:1:1)'), { errors: 'x' })}      | ${['AggregateError: none', '    at any (promise.ts:1:1)']}
    `('should log $description', ({ failure, lines }) => {
      logFailure('gekko', failure);

      expect(String(vi.mocked(error).mock.calls[0][1]).split('\n')).toStrictEqual(lines);
    });
  });
});
