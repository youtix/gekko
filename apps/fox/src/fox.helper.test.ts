import { debug, error, info } from '@gekko/core/logger/logger';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { describe, expect, it, vi } from 'vitest';
import { logFailure, logSummary } from './fox.helper';
import type { VariantResult } from './fox.types';

vi.mock('@gekko/core/logger/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));

/** An Error whose stack is what Bun gives a DOMException: frames only, without its "<name>: <message>" line */
const framesOnly = Object.assign(new Error('The object can not be cloned.'), { name: 'DataCloneError', stack: '    at structuredClone' });
const withoutStack = Object.assign(new Error('no frames'), { stack: undefined });

describe('logFailure', () => {
  describe('of a GekkoError', () => {
    const failure = new GekkoError('fox', 'Variant 2 is invalid');

    it('should log its message at error level', () => {
      logFailure(failure);

      expect(error).toHaveBeenCalledExactlyOnceWith('fox', '[FOX] Variant 2 is invalid');
    });

    it('should log its stack at debug level', () => {
      logFailure(failure);

      expect(debug).toHaveBeenCalledExactlyOnceWith('fox', expect.stringMatching(/^GekkoError: \[FOX\] Variant 2 is invalid\n\s+at /));
    });

    it('should start both lines with the prefix', () => {
      logFailure(failure, 'Uncaught exception: ');

      expect(vi.mocked(debug).mock.calls[0][1]).toMatch(/^Uncaught exception: GekkoError: /);
    });
  });

  it.each`
    description                              | failure                                               | expected
    ${'an Error, with its stack'}            | ${new TypeError('x is undefined')}                    | ${/^TypeError: x is undefined\n\s+at /}
    ${'an Error whose stack is frames only'} | ${framesOnly}                                         | ${/^DataCloneError: The object can not be cloned\.\n {4}at structuredClone$/}
    ${'an Error without a stack'}            | ${withoutStack}                                       | ${/^Error: no frames$/}
    ${'a value that is not an Error'}        | ${'a plain text'}                                     | ${/^a plain text$/}
    ${'a GekkoError with its causes'}        | ${new GekkoError('fox', 'outer', { cause: 'inner' })} | ${/^\[FOX\] outer\nCaused by: inner$/}
  `('should log $description at error level', ({ failure, expected }) => {
    logFailure(failure);

    expect(vi.mocked(error).mock.calls[0][1]).toMatch(expected);
  });

  it('should log the cause of a cause', () => {
    logFailure(new GekkoError('fox', 'outer', { cause: new GekkoError('core', 'middle', { cause: 'root' }) }));

    expect(vi.mocked(error).mock.calls[0][1]).toMatch(/^\[FOX\] outer\nCaused by: GekkoError: \[CORE\] middle\n[\s\S]+\nCaused by: root$/);
  });

  it('should stop at a cause already listed', () => {
    const looping = new Error('looping');
    looping.cause = looping;
    logFailure(new GekkoError('fox', 'outer', { cause: looping }));

    expect(String(vi.mocked(error).mock.calls[0][1]).match(/Caused by: /g)).toHaveLength(1);
  });

  it('should log nothing at debug level for a failure that is not a GekkoError', () => {
    logFailure(new Error('boom'));

    expect(debug).not.toHaveBeenCalled();
  });
});

describe('logSummary', () => {
  const done = (variant: number): VariantResult => ({ variant, status: 'done', durationMs: 1000 });
  const failed = (variant: number): VariantResult => ({ variant, status: 'failed', error: 'boom', durationMs: 1000 });

  it.each`
    description             | results                        | expected
    ${'one variant'}        | ${[done(1)]}                   | ${'1 variant, 0 failed'}
    ${'every variant done'} | ${[done(1), done(2), done(3)]} | ${'3 variants, 0 failed'}
  `('should log $description at info level', ({ results, expected }) => {
    logSummary(results);

    expect(info).toHaveBeenCalledExactlyOnceWith('fox', expected);
  });

  it.each`
    description              | results                                     | expected
    ${'one variant failed'}  | ${[done(1), failed(2), done(3)]}            | ${'3 variants, 1 failed: variant 2'}
    ${'two variants failed'} | ${[done(1), failed(2), done(3), failed(4)]} | ${'4 variants, 2 failed: variants 2 and 4'}
  `('should log $description at error level, naming them', ({ results, expected }) => {
    logSummary(results);

    expect(error).toHaveBeenCalledExactlyOnceWith('fox', expected);
  });

  it.each`
    description             | results                 | expected
    ${'every variant done'} | ${[done(1), done(2)]}   | ${false}
    ${'a variant failed'}   | ${[done(1), failed(2)]} | ${true}
  `('should say whether a variant failed when $description', ({ results, expected }) => {
    expect(logSummary(results)).toBe(expected);
  });
});
