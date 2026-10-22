import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { describe, expect, it, vi } from 'vitest';
import { logFailure } from './failure.helper';
import { debug, error } from './logger';

vi.mock('./logger', () => ({ debug: vi.fn(), error: vi.fn() }));

/** An Error whose stack is what Bun gives a DOMException: frames only, without its "<name>: <message>" line */
const framesOnly = Object.assign(new Error('The object can not be cloned.'), { name: 'DataCloneError', stack: '    at structuredClone' });
const withoutStack = Object.assign(new Error('no frames'), { stack: undefined });

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
});
