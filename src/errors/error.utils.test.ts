import { describe, expect, it } from 'vitest';
import { ApplicationStopError } from './applicationStop.error';
import { describeError, toError } from './error.utils';
import { GekkoError } from './gekko.error';

const timeout = new GekkoError('exchange', 'Request timed out (10000 ms)');
const withoutPrototype = Object.assign(Object.create(null), { status: 503 });

describe('describeError', () => {
  // A GekkoError without its tag: the line that quotes it has one of its own. The message of any other Error is quoted whole, a word
  // in brackets at its start included, which the regular expression that cut the tag off cut too.
  it.each`
    kind                                           | error                                                                      | said
    ${'a GekkoError'}                              | ${timeout}                                                                 | ${'Request timed out (10000 ms)'}
    ${'a subclass of GekkoError'}                  | ${new ApplicationStopError('strategy', 'Circuit breaker tripped')}         | ${'Circuit breaker tripped'}
    ${'a GekkoError that has a cause'}             | ${new GekkoError('exchange', 'Market order not sent', { cause: timeout })} | ${'Market order not sent'}
    ${'an Error'}                                  | ${new Error('fetch failed')}                                               | ${'fetch failed'}
    ${'an Error starting with a word in brackets'} | ${new Error('[503] Service Unavailable')}                                  | ${'[503] Service Unavailable'}
    ${'an Error whose cause has no prototype'}     | ${new Error('fetch failed', { cause: withoutPrototype })}                  | ${'fetch failed'}
  `('describes $kind by its message: $said', ({ error, said }) => {
    expect(describeError(error)).toBe(said);
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
});

describe('toError', () => {
  it.each`
    kind              | error
    ${'an Error'}     | ${new Error('fetch failed')}
    ${'a GekkoError'} | ${timeout}
  `('returns $kind as it is', ({ error }) => {
    expect(toError(error)).toBe(error);
  });

  // Wrapped with String(), an object read [object Object], and one without a prototype threw from the catch meant to report it
  it.each`
    kind                               | value                  | message
    ${'a string'}                      | ${'boom'}              | ${'boom'}
    ${'a number'}                      | ${42}                  | ${'42'}
    ${'undefined'}                     | ${undefined}           | ${'undefined'}
    ${'an object'}                     | ${{ error_code: 403 }} | ${'{ error_code: 403 }'}
    ${'an object without a prototype'} | ${withoutPrototype}    | ${'[Object: null prototype] { status: 503 }'}
  `('wraps $kind in an Error with the message $message', ({ value, message }) => {
    expect(toError(value)).toEqual(new Error(message));
  });
});
