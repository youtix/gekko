import { describe, expect, it } from 'vitest';
import { GekkoError } from './gekko.error';

const MESSAGE = 'Cannot open the database /app/db/backtest.sql (unable to open database file).';

describe('GekkoError', () => {
  it.each`
    tag                  | message
    ${'storage'}         | ${`[STORAGE] ${MESSAGE}`}
    ${'trading advisor'} | ${`[TRADING ADVISOR] ${MESSAGE}`}
  `('prefixes its message with its tag, upper-cased in brackets: $message', ({ tag, message }) => {
    expect(new GekkoError(tag, MESSAGE).message).toBe(message);
  });

  it('keeps its tag', () => {
    expect(new GekkoError('storage', MESSAGE).tag).toBe('storage');
  });

  // For a line that quotes it under a tag of its own, which had to cut the tag off the message with a regular expression
  it('keeps its message without the tag', () => {
    expect(new GekkoError('storage', MESSAGE).untaggedMessage).toBe(MESSAGE);
  });

  // Its constructor took no options: the failure it wrapped was dropped, or set by hand afterwards
  it('keeps the failure it wraps as its cause, given in its options', () => {
    const cause = new Error('unable to open database file');
    expect(new GekkoError('storage', MESSAGE, { cause }).cause).toBe(cause);
  });

  it('has no cause without options', () => {
    expect(Object.hasOwn(new GekkoError('storage', MESSAGE), 'cause')).toBe(false);
  });

  it('is named GekkoError', () => {
    expect(new GekkoError('storage', MESSAGE).name).toBe('GekkoError');
  });

  it('is an Error', () => {
    expect(new GekkoError('storage', MESSAGE)).toBeInstanceOf(Error);
  });
});
