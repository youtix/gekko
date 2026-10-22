import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { describe, expect, it } from 'vitest';
import { ExchangeNetworkError, InvalidOrder, OrderNotFound, OrderOutcomeUnknown } from './exchange.error';

const MESSAGE = 'binance {"code":-2010,"msg":"Account has insufficient balance for requested action."}';
const cause = new Error(MESSAGE);

describe.each`
  ErrorClass
  ${InvalidOrder}
  ${OrderNotFound}
  ${ExchangeNetworkError}
  ${OrderOutcomeUnknown}
`('$ErrorClass.name', ({ ErrorClass }) => {
  it(`is named ${ErrorClass.name}`, () => {
    expect(new ErrorClass(MESSAGE).name).toBe(ErrorClass.name);
  });

  it('prefixes its message with the tag of the exchange', () => {
    expect(new ErrorClass(MESSAGE).message).toBe(`[EXCHANGE] ${MESSAGE}`);
  });

  it('keeps the failure it wraps as its cause, given in its options', () => {
    expect(new ErrorClass(MESSAGE, { cause }).cause).toBe(cause);
  });

  // As Error sets it: each class set its cause by hand, as a property of its own that toEqual compared and util.inspect listed
  it('keeps its cause apart from its enumerable properties', () => {
    expect(Object.keys(new ErrorClass(MESSAGE, { cause }))).not.toContain('cause');
  });

  it('is a GekkoError', () => {
    expect(new ErrorClass(MESSAGE)).toBeInstanceOf(GekkoError);
  });
});
