import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { describe, expect, it, vi } from 'vitest';
import { describeFailure, logFailure } from './failure.helper';
import { debug, error } from './logger';

vi.mock('./logger', () => ({ debug: vi.fn(), error: vi.fn() }));

/** An Error whose stack is what Bun gives a DOMException: frames only, without its "<name>: <message>" line */
const framesOnly = Object.assign(new Error('The object can not be cloned.'), { name: 'DataCloneError', stack: '    at structuredClone' });
const withoutStack = Object.assign(new Error('no frames'), { stack: undefined });
/** An Error whose stack, a writable property, holds no string */
const oddStack = Object.assign(new Error('odd frames'), { stack: 42 });

const FILE = '/strategies/my.strategy.ts';

// Bun's ResolveMessage and BuildMessage, which the import of a strategy file that cannot be found or parsed rejects with, as Bun 1.4.4
// makes them: Errors whose name, message and position are getters of their class, a ResolveMessage's stack its "<name>: <message>"
// line alone, and a BuildMessage without a stack, its position the only place its file is named
class ResolveMessage extends Error {
  readonly #message: string;

  constructor(message: string) {
    super();
    this.#message = message;
    this.stack = `ResolveMessage: ${message}`;
  }

  override get name() {
    return 'ResolveMessage';
  }

  override get message() {
    return this.#message;
  }

  get position() {
    return null;
  }
}

class BuildMessage extends Error {
  readonly #message: string;
  readonly #position: object;

  constructor(message: string, position: object) {
    super();
    this.#message = message;
    this.#position = position;
    this.stack = undefined;
  }

  override get name() {
    return 'BuildMessage';
  }

  override get message() {
    return this.#message;
  }

  get position() {
    return this.#position;
  }
}

// A BuildMessage as Bun 1.3.14 made it: not an Error, every field a getter of its class. Named by its key: esbuild, which vitest
// transforms the suite with, renames a class expression named as the class above (BuildMessage2), so that it shadows none
const bun13 = {
  BuildMessage: class {
    readonly #message: string;
    readonly #position: object;

    constructor(message: string, position: object) {
      this.#message = message;
      this.#position = position;
    }

    get message() {
      return this.#message;
    }

    get position() {
      return this.#position;
    }
  },
};

const positionIn = (line: number, column: number) => ({ file: FILE, namespace: 'file', line, column, length: 1 });
const syntaxError = new BuildMessage('Expected ")" but found ";"', positionIn(3, 21));
const missingPackage = new ResolveMessage(`Cannot find package 'zod' imported from ${FILE}`);
const syntaxErrorOfBun13 = new bun13.BuildMessage('Expected ")" but found ";"', positionIn(3, 21));
// Bun's AggregateError of two syntax errors, without a stack too when Gekko runs from source
const twoSyntaxErrors = Object.assign(
  new AggregateError([syntaxError, new BuildMessage('Expected "]" but found ";"', positionIn(4, 20))], `2 errors building "${FILE}"`),
  { stack: undefined },
);

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
    ${'an Error whose stack is no string'}   | ${oddStack}                                            | ${/^Error: odd frames$/}
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

  // As describeError writes them, wherever they stand. String() leaves out a Bun 1.4.4 BuildMessage's position, and it has no stack:
  // the Caused by line of a broken strategy file named no line of it, and main()'s report of a broken strategy of custom/, which is the
  // BuildMessage itself, named no file at all
  describe("of Bun's loader messages", () => {
    /** The failure of the import of a strategy file, as the StrategyManager throws it, caused by what Bun rejected the import with */
    const importFailure = (cause: unknown) => new GekkoError('trading advisor', `Cannot import the strategy file ${FILE}`, { cause });
    const opening = `[TRADING ADVISOR] Cannot import the strategy file ${FILE}`;

    it.each`
      description                                              | failure                           | lines
      ${'a BuildMessage of Bun 1.4.4, at its position'}        | ${syntaxError}                    | ${[`BuildMessage: Expected ")" but found ";" at ${FILE}:3:21`]}
      ${'a ResolveMessage of Bun 1.4.4, by its stack'}         | ${missingPackage}                 | ${[`ResolveMessage: Cannot find package 'zod' imported from ${FILE}`]}
      ${'a BuildMessage of Bun 1.3.14, not an Error, as ever'} | ${syntaxErrorOfBun13}             | ${[`BuildMessage: Expected ")" but found ";" at ${FILE}:3:21`]}
      ${'the BuildMessage a failure was caused by'}            | ${importFailure(syntaxError)}     | ${[opening, `Caused by: BuildMessage: Expected ")" but found ";" at ${FILE}:3:21`]}
      ${'each BuildMessage of an AggregateError'}              | ${importFailure(twoSyntaxErrors)} | ${[opening, `Caused by: AggregateError: 2 errors building "${FILE}"`, `Error 1 of 2: BuildMessage: Expected ")" but found ";" at ${FILE}:3:21`, `Error 2 of 2: BuildMessage: Expected "]" but found ";" at ${FILE}:4:20`]}
    `('should log $description', ({ failure, lines }) => {
      logFailure('gekko', failure);

      expect(String(vi.mocked(error).mock.calls[0][1]).split('\n')).toStrictEqual(lines);
    });
  });
});

// What a Fox worker posts of a failure, for Fox to log under the variant's line: what the bot's main() logs of it
describe('describeFailure', () => {
  it.each`
    description                            | failure
    ${'a GekkoError, its message alone'}   | ${new GekkoError('core', 'the run failed')}
    ${'an Error, in full'}                 | ${thrownAt(new TypeError('x is undefined'), 'onTimeframeCandle (my.strategy.ts:5:20)')}
    ${'a GekkoError and its cause'}        | ${new GekkoError('stream', 'TradingAdvisor failed to finalize: x', { cause: thrownAt(new TypeError('x'), 'end (s.ts:13:39)') })}
    ${'a value that is not an Error'}      | ${'a plain text'}
    ${'a chain of five, down to its root'} | ${new Error('level 1', { cause: new Error('level 2', { cause: new Error('level 3', { cause: new Error('level 4', { cause: 'root' }) }) }) })}
  `('should write $description as logFailure logs it at error level', ({ failure }) => {
    logFailure('gekko', failure);

    expect(describeFailure(failure)).toBe(vi.mocked(error).mock.calls[0][1]);
  });

  it('should write every link of a chain, where util.inspect cuts it after two causes', () => {
    const chain = new Error('level 1', { cause: new Error('level 2', { cause: new Error('level 3', { cause: new Error('root') }) }) });

    expect(describeFailure(chain)).toMatch(/\nCaused by: Error: root\n/);
  });
});
