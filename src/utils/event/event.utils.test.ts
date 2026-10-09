import { noop } from 'lodash-es';
import { describe, expect, it, vi } from 'vitest';
import { copyPayload } from './event.utils';

const createPortfolio = () =>
  new Map([
    ['BTC', { free: 1, used: 0, total: 1 }],
    ['USDT', { free: 100, used: 0, total: 100 }],
  ]);

const createOrderEvent = () => ({
  order: { id: 'order', side: 'BUY', amount: 1, price: 100, fee: NaN, filled: undefined, reason: null },
  exchange: { price: 100, portfolio: createPortfolio() },
});

const createSparseArray = () => {
  const array = [1, 2, 3];
  delete array[1];
  return array;
};

/** Two references to one object, which structuredClone keeps as one */
const createSharingPayload = () => {
  const shared = { free: 1 };
  return { first: shared, second: shared };
};

/** An object that refers to itself, which structuredClone keeps as a cycle */
const createCyclicPayload = () => {
  const payload: { name: string; self?: unknown } = { name: 'root' };
  payload.self = payload;
  return payload;
};

class Point {
  x = 1;
}

describe('copyPayload', () => {
  it.each`
    kind                                 | payload
    ${'a primitive'}                     | ${42}
    ${'null'}                            | ${null}
    ${'a portfolio'}                     | ${createPortfolio()}
    ${'a timeframe bucket'}              | ${new Map([['BTC/USDT', { start: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }]])}
    ${'an order event'}                  | ${createOrderEvent()}
    ${'an array of payloads'}            | ${[createPortfolio(), createOrderEvent()]}
    ${'an array with a hole'}            | ${createSparseArray()}
    ${'an array with a property'}        | ${Object.assign([1, 2], { note: 'kept' })}
    ${'a Map keyed by objects'}          | ${new Map([[{ pair: 'BTC/USDT' }, 1]])}
    ${'a Date in a Map'}                 | ${new Map([['at', new Date(0)]])}
    ${'a Set'}                           | ${new Set([1, 2])}
    ${'an Error'}                        | ${new Error('boom')}
    ${'a typed array'}                   | ${new Uint8Array([1, 2])}
    ${'an object with an own __proto__'} | ${JSON.parse('{"__proto__": {"polluted": true}, "free": 1}')}
    ${'a class instance in an object'}   | ${{ at: new Point() }}
    ${'an object without a prototype'}   | ${Object.assign(Object.create(null), { free: 1 })}
    ${'an enumerable getter'}            | ${Object.defineProperty({}, 'free', { enumerable: true, get: () => 1 })}
    ${'a function under a symbol key'}   | ${{ free: 1, [Symbol('hidden')]: noop }}
    ${'a non-enumerable function'}       | ${Object.defineProperty({ free: 1 }, 'hidden', { value: noop })}
  `('should copy $kind as structuredClone does', ({ payload }) => {
    expect(copyPayload(payload)).toStrictEqual(structuredClone(payload));
  });

  // Queued with structuredClone, such a payload threw: copied by reference, it would have reached the listeners
  it.each`
    kind                         | payload
    ${'a function'}              | ${noop}
    ${'a symbol'}                | ${Symbol('tag')}
    ${'a function in an object'} | ${{ order: { id: 'order', notify: noop } }}
    ${'a symbol in an array'}    | ${[1, Symbol('tag')]}
    ${'a function in a Map'}     | ${new Map([['notify', noop]])}
    ${'a symbol keying a Map'}   | ${new Map([[Symbol('tag'), 1]])}
  `('should refuse $kind with a DataCloneError, as structuredClone does', ({ payload }) => {
    expect(() => copyPayload(payload)).toThrow(expect.objectContaining({ name: 'DataCloneError' }));
  });

  it.each`
    written                         | write
    ${'a balance of the portfolio'} | ${(copy: ReturnType<typeof createOrderEvent>) => (copy.exchange.portfolio.get('BTC')!.free = 0)}
    ${'an entry of the portfolio'}  | ${(copy: ReturnType<typeof createOrderEvent>) => copy.exchange.portfolio.delete('BTC')}
    ${'a field of the order'}       | ${(copy: ReturnType<typeof createOrderEvent>) => (copy.order.amount = 99)}
  `('should leave the payload as it was when the copy has $written changed', ({ write }) => {
    const payload = createOrderEvent();
    write(copyPayload(payload));

    expect(payload).toStrictEqual(createOrderEvent());
  });

  // The copy by hand is the point: one that threw would still be right, by structuredClone, but no faster
  it.each`
    kind                             | create                                   | copier                  | calls
    ${'a portfolio'}                 | ${createPortfolio}                       | ${'by hand'}            | ${0}
    ${'an order event'}              | ${createOrderEvent}                      | ${'by hand'}            | ${0}
    ${'an array with a hole'}        | ${createSparseArray}                     | ${'by hand'}            | ${0}
    ${'two references to an object'} | ${createSharingPayload}                  | ${'by hand'}            | ${0}
    ${'a cycle'}                     | ${createCyclicPayload}                   | ${'by hand'}            | ${0}
    ${'a Set'}                       | ${() => new Set([1])}                    | ${'by structuredClone'} | ${1}
    ${'a Date in an order event'}    | ${() => ({ order: { at: new Date() } })} | ${'by structuredClone'} | ${1}
  `('should copy $kind $copier', ({ create, calls }) => {
    const payload = create();
    const clone = vi.spyOn(globalThis, 'structuredClone');

    copyPayload(payload);

    expect(clone).toHaveBeenCalledTimes(calls);
  });

  it('should leave the key of a Map as it was when the copy has its key changed', () => {
    const payload = new Map([[{ pair: 'BTC/USDT' }, 1]]);
    const [key] = copyPayload(payload).keys();
    key.pair = 'ETH/USDT';

    expect(Array.from(payload.keys())).toEqual([{ pair: 'BTC/USDT' }]);
  });

  it('should keep two references to one object as one', () => {
    const copy = copyPayload(createSharingPayload());
    expect(copy.first).toBe(copy.second);
  });

  it('should keep a cycle', () => {
    const copy = copyPayload(createCyclicPayload());
    expect(copy.self).toBe(copy);
  });

  it('should keep an own __proto__ as a property, not as the prototype', () => {
    const copy = copyPayload(JSON.parse('{"__proto__": {"polluted": true}}'));
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
  });
});
