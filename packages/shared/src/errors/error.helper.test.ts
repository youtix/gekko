import { describe, expect, it } from 'vitest';
import { ApplicationStopError } from './applicationStop.error';
import { describeError, toError } from './error.helper';
import { GekkoError } from './gekko.error';

const timeout = new GekkoError('exchange', 'Request timed out (10000 ms)');
const withoutPrototype = Object.assign(Object.create(null), { status: 503 });

// Bun's ResolveMessage and BuildMessage, which the import of a strategy file that cannot be found or parsed rejects with, as Bun 1.4.4
// makes them: Errors without a property of their own, their name, message and position getters of their class
class ResolveMessage extends Error {
  readonly #message: string;

  constructor(message: string) {
    super();
    this.#message = message;
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

// As Bun 1.3.14 made them: not Errors, but objects of classes of those names, every field a getter, so that util.inspect wrote
// 'ResolveMessage {}'. Each class takes its name from its key: esbuild, which vitest transforms the suite with, renames a class
// expression named as a class above (ResolveMessage2), so that it shadows none
const bun13 = {
  ResolveMessage: class {
    readonly #message: string;

    constructor(message: string) {
      this.#message = message;
    }

    get message() {
      return this.#message;
    }

    get position() {
      return null;
    }
  },
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

const file = '/strategies/my.strategy.ts';
const importer = '/gekko/packages/plugins/src/tradingAdvisor/strategyManager.ts';
const positionIn = (line: number, column: number) => ({ file, namespace: 'file', line, column, length: 1 });
// In the words of Bun 1.4.4
const missingFile = new ResolveMessage(`Cannot find module '${file}' imported from ${importer}`);
const missingPackage = new ResolveMessage(`Cannot find package 'zod' imported from ${file}`);
const syntaxError = new BuildMessage('Expected ")" but found ";"', positionIn(3, 21));
const unplacedSyntaxError = new BuildMessage('Expected ")" but found ";"', { file });
const twoSyntaxErrors = new AggregateError(
  [syntaxError, new BuildMessage('Expected "]" but found ";"', positionIn(4, 20))],
  `2 errors building "${file}"`,
);
// In those of Bun 1.3.14
const missingFileOfBun13 = new bun13.ResolveMessage(`Cannot find module '${file}' from '${importer}'`);
const missingPackageOfBun13 = new bun13.ResolveMessage(`Cannot find package 'zod' from '${file}'`);
const syntaxErrorOfBun13 = new bun13.BuildMessage('Expected ")" but found ";"', positionIn(3, 21));
const twoSyntaxErrorsOfBun13 = new AggregateError(
  [syntaxErrorOfBun13, new bun13.BuildMessage('Expected "]" but found ";"', positionIn(4, 20))],
  `2 errors building "${file}"`,
);

// An error-like value without a class name: an instance of an anonymous class, an object whose prototype has no constructor
const anonymous = new (class {
  get message() {
    return 'connection lost';
  }
})();
const withoutConstructor = Object.create(Object.create(null, { message: { get: () => 'connection lost' } }));

const tooManyRequests = { message: 'Too Many Requests', status: 429 };

class NumericMessage {
  get message() {
    return 503;
  }
}

class UnreadableMessage {
  get message(): string {
    throw new TypeError('The message getter can only be used on instances of UnreadableMessage');
  }
}

const refused = new AggregateError([new Error('connect ECONNREFUSED ::1:443'), new Error('connect ECONNREFUSED 127.0.0.1:443')]);
const nested = new AggregateError(
  [new AggregateError([new Error('fetch failed'), 'socket hang up'], 'Binance failed'), new Error('Kraken down')],
  'Every exchange failed',
);
const selfListed = new AggregateError([new Error('fetch failed')], 'Every exchange failed');
selfListed.errors.push(selfListed);
const innerListed = new AggregateError([new Error('fetch failed')], 'Binance failed');
const outerListed = new AggregateError([innerListed], 'Every exchange failed');
innerListed.errors.push(outerListed);
const notAList = Object.assign(new AggregateError([new Error('fetch failed')], 'Every exchange failed'), { errors: 'fetch failed' });

describe('describeError', () => {
  // A GekkoError without its tag: the line that quotes it has one of its own. The message of any other Error is quoted whole, a word
  // in brackets at its start included, which the regular expression that cut the tag off cut too.
  it.each`
    kind                                           | error                                                                      | said
    ${'a GekkoError'}                              | ${timeout}                                                                 | ${'Request timed out (10000 ms)'}
    ${'a subclass of GekkoError'}                  | ${new ApplicationStopError('strategy', 'Circuit breaker tripped')}         | ${'Circuit breaker tripped'}
    ${'a GekkoError that has a cause'}             | ${new GekkoError('exchange', 'Market order not sent', { cause: timeout })} | ${'Market order not sent'}
    ${'an Error'}                                  | ${new Error('fetch failed')}                                               | ${'fetch failed'}
    ${'a TypeError'}                               | ${new TypeError('fetch failed')}                                           | ${'fetch failed'}
    ${'an Error starting with a word in brackets'} | ${new Error('[503] Service Unavailable')}                                  | ${'[503] Service Unavailable'}
    ${'an Error whose cause has no prototype'}     | ${new Error('fetch failed', { cause: withoutPrototype })}                  | ${'fetch failed'}
  `('describes $kind by its message: $said', ({ error, said }) => {
    expect(describeError(error)).toBe(said);
  });

  // The message of an AggregateError names none of its errors: they follow it, but for an AggregateError among its own errors, which
  // would be listed forever
  it.each`
    kind                                                          | error                                                                       | said
    ${'an AggregateError without a message'}                      | ${refused}                                                                  | ${'connect ECONNREFUSED ::1:443; connect ECONNREFUSED 127.0.0.1:443'}
    ${'an AggregateError without errors'}                         | ${new AggregateError([], 'All promises were rejected')}                     | ${'All promises were rejected'}
    ${'an AggregateError of a GekkoError and a string'}           | ${new AggregateError([timeout, 'socket hang up'], 'Every exchange failed')} | ${'Every exchange failed: Request timed out (10000 ms); socket hang up'}
    ${'nested AggregateErrors'}                                   | ${nested}                                                                   | ${'Every exchange failed: Binance failed: fetch failed; socket hang up; Kraken down'}
    ${'an AggregateError among its own errors'}                   | ${selfListed}                                                               | ${'Every exchange failed: fetch failed'}
    ${'an AggregateError among the errors of one of its errors'}  | ${outerListed}                                                              | ${'Every exchange failed: Binance failed: fetch failed'}
    ${'an AggregateError whose errors were replaced by a string'} | ${notAList}                                                                 | ${'Every exchange failed'}
  `('describes $kind by its message, then its errors: $said', ({ error, said }) => {
    expect(describeError(error)).toBe(said);
  });

  // Bun reports two syntax errors in a strategy file as an AggregateError whose message names the file, but neither error
  it.each`
    version     | error
    ${'1.4.4'}  | ${twoSyntaxErrors}
    ${'1.3.14'} | ${twoSyntaxErrorsOfBun13}
  `('describes two syntax errors of Bun $version by the message of their AggregateError, then each at its position', ({ error }) => {
    expect(describeError(error)).toBe(
      `2 errors building "${file}": BuildMessage: Expected ")" but found ";" at ${file}:3:21; ` +
        `BuildMessage: Expected "]" but found ";" at ${file}:4:20`,
    );
  });

  // Bun 1.4.4's loader messages are Errors: quoted by their message alone, as any other Error, a strategyPath that leads nowhere, a
  // missing package or a syntax error stopped Gekko without the class that says what failed, and a syntax error without its file
  it.each`
    kind                                       | value                  | said
    ${'a ResolveMessage of a missing file'}    | ${missingFile}         | ${`ResolveMessage: Cannot find module '${file}' imported from ${importer}`}
    ${'a ResolveMessage of a missing package'} | ${missingPackage}      | ${`ResolveMessage: Cannot find package 'zod' imported from ${file}`}
    ${'a BuildMessage, at its position'}       | ${syntaxError}         | ${`BuildMessage: Expected ")" but found ";" at ${file}:3:21`}
    ${'a BuildMessage placed on no line'}      | ${unplacedSyntaxError} | ${'BuildMessage: Expected ")" but found ";"'}
  `('describes $kind of Bun 1.4.4, an Error, by its class and message: $said', ({ value, said }) => {
    expect(describeError(value)).toBe(said);
  });

  // util.inspect wrote Bun 1.3.14's loader messages, which are not Errors, as 'ResolveMessage {}': a strategyPath that leads nowhere, a
  // missing package or a syntax error stopped Gekko without the file, or what was wrong with it
  it.each`
    kind                                                      | value                    | said
    ${'a ResolveMessage of Bun 1.3.14, of a missing file'}    | ${missingFileOfBun13}    | ${`ResolveMessage: Cannot find module '${file}' from '${importer}'`}
    ${'a ResolveMessage of Bun 1.3.14, of a missing package'} | ${missingPackageOfBun13} | ${`ResolveMessage: Cannot find package 'zod' from '${file}'`}
    ${'a BuildMessage of Bun 1.3.14, at its position'}        | ${syntaxErrorOfBun13}    | ${`BuildMessage: Expected ")" but found ";" at ${file}:3:21`}
    ${'an instance of an anonymous class'}                    | ${anonymous}             | ${'connection lost'}
    ${'an object without a constructor'}                      | ${withoutConstructor}    | ${'connection lost'}
  `('describes $kind, whose message util.inspect does not show, as $said', ({ value, said }) => {
    expect(describeError(value)).toBe(said);
  });

  // String() writes an object as [object Object], and throws for one without a prototype, as a template literal does for a symbol
  it.each`
    kind                               | value                  | said
    ${'a string'}                      | ${'socket hang up'}    | ${'socket hang up'}
    ${'an empty string'}               | ${''}                  | ${''}
    ${'a number'}                      | ${42}                  | ${'42'}
    ${'undefined'}                     | ${undefined}           | ${'undefined'}
    ${'null'}                          | ${null}                | ${'null'}
    ${'a symbol'}                      | ${Symbol('timeout')}   | ${'Symbol(timeout)'}
    ${'an object'}                     | ${{ error_code: 403 }} | ${'{ error_code: 403 }'}
    ${'an object without a prototype'} | ${withoutPrototype}    | ${'[Object: null prototype] { status: 503 }'}
  `('describes $kind, which is not an Error, as $said', ({ value, said }) => {
    expect(describeError(value)).toBe(said);
  });

  // A message util.inspect shows stays as it writes it, the rest of the object with it, and so does a message that is no string or
  // cannot be read: inspect calls no getter, and describeError must not throw from the catch that reports the failure
  it.each`
    kind                                         | value                      | said
    ${'an object with a message of its own'}     | ${tooManyRequests}         | ${`{ message: '${tooManyRequests.message}', status: 429 }`}
    ${'an object whose message is not a string'} | ${new NumericMessage()}    | ${'NumericMessage {}'}
    ${'an object whose message getter throws'}   | ${new UnreadableMessage()} | ${'UnreadableMessage {}'}
  `('describes $kind as util.inspect writes it: $said', ({ value, said }) => {
    expect(describeError(value)).toBe(said);
  });
});

describe('toError', () => {
  it.each`
    kind                                         | error
    ${'an Error'}                                | ${new Error('fetch failed')}
    ${'a GekkoError'}                            | ${timeout}
    ${'a ResolveMessage of Bun 1.4.4, an Error'} | ${missingFile}
  `('returns $kind as it is', ({ error }) => {
    expect(toError(error)).toBe(error);
  });

  // Wrapped with String(), an object read [object Object], and one without a prototype threw from the catch meant to report it
  it.each`
    kind                                | value                  | message
    ${'a string'}                       | ${'boom'}              | ${'boom'}
    ${'a number'}                       | ${42}                  | ${'42'}
    ${'undefined'}                      | ${undefined}           | ${'undefined'}
    ${'an object'}                      | ${{ error_code: 403 }} | ${'{ error_code: 403 }'}
    ${'an object without a prototype'}  | ${withoutPrototype}    | ${'[Object: null prototype] { status: 503 }'}
    ${'a ResolveMessage of Bun 1.3.14'} | ${missingFileOfBun13}  | ${`ResolveMessage: Cannot find module '${file}' from '${importer}'`}
  `('wraps $kind in an Error with the message $message', ({ value, message }) => {
    expect(toError(value)).toEqual(new Error(message));
  });
});
