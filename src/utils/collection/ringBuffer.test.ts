import { GekkoError } from '@errors/gekko.error';
import { describe, expect, it, vi } from 'vitest';
import { RingBuffer } from './ringBuffer';

const filled = <T>(size: number, values: T[]) => {
  const rb = new RingBuffer<T>(size);
  values.forEach(value => rb.push(value));
  return rb;
};

/**
 * The keys a read looks up on the items held, sorted, length aside: the slot of every item it reads, once each, when it reads them in
 * place. A copy also looks up the method or the iterator that makes it (slice, concat, Symbol.iterator…).
 */
const lookupsOf = (rb: RingBuffer<number>, read: (rb: RingBuffer<number>) => unknown) => {
  const keys: string[] = [];
  rb['buffer'] = new Proxy(rb['buffer'], {
    get: (items, key, receiver) => {
      if (key !== 'length') keys.push(String(key));
      return Reflect.get(items, key, receiver);
    },
  });
  read(rb);
  return keys.sort();
};

describe('RingBuffer', () => {
  describe('constructor', () => {
    // Such a size gave reads that contradicted each other: isFull() true while empty for 0, first set while toArray was empty
    it.each`
      size        | shown
      ${0}        | ${'0'}
      ${-1}       | ${'-1'}
      ${1.5}      | ${'1.5'}
      ${NaN}      | ${'NaN'}
      ${Infinity} | ${'Infinity'}
      ${'3'}      | ${'"3"'}
    `('should refuse a size of $size', ({ size, shown }) => {
      expect(() => new RingBuffer(size)).toThrow(
        new GekkoError('utils', `RingBuffer size must be a whole number, at least 1, got ${shown}`),
      );
    });
  });

  describe('push and toArray', () => {
    it.each`
      size | values                             | expected
      ${3} | ${[]}                              | ${[]}
      ${5} | ${[1, 2, 3]}                       | ${[1, 2, 3]}
      ${3} | ${[10, 20, 30]}                    | ${[10, 20, 30]}
      ${4} | ${[1, 2, 3, 4, 5, 6]}              | ${[3, 4, 5, 6]}
      ${3} | ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]} | ${[8, 9, 10]}
      ${1} | ${['A']}                           | ${['A']}
      ${1} | ${['A', 'B']}                      | ${['B']}
    `('should return $expected from toArray() after pushing $values into a buffer of $size', ({ size, values, expected }) => {
      expect(filled(size, values).toArray()).toEqual(expected);
    });

    it.each`
      size | pushes                  | expected
      ${4} | ${[[1, 2, 3, 4, 5, 6]]} | ${[3, 4, 5, 6]}
      ${3} | ${[[1, 2], [3, 4]]}     | ${[2, 3, 4]}
      ${2} | ${[[], [1]]}            | ${[1]}
    `('should return $expected from toArray() after the pushes of $pushes into a buffer of $size', ({ size, pushes, expected }) => {
      const rb = new RingBuffer<number>(size);
      pushes.forEach((items: number[]) => rb.push(...items));

      expect(rb.toArray()).toEqual(expected);
    });

    it('should return a copy from toArray(), so that a write to it leaves the buffer holding [7]', () => {
      const rb = filled(2, [7]);
      const snapshot = rb.toArray();
      snapshot[0] = 999;

      expect(rb.toArray()).toEqual([7]);
    });
  });

  describe('isFull', () => {
    it.each`
      size | values                | expected
      ${1} | ${[]}                 | ${false}
      ${1} | ${['A']}              | ${true}
      ${5} | ${[1, 2, 3]}          | ${false}
      ${3} | ${[10, 20, 30]}       | ${true}
      ${4} | ${[1, 2, 3, 4, 5, 6]} | ${true}
    `('should return $expected from isFull() after pushing $values into a buffer of $size', ({ size, values, expected }) => {
      expect(filled(size, values).isFull()).toBe(expected);
    });
  });

  describe('length', () => {
    it.each`
      size | values             | expected
      ${3} | ${[]}              | ${0}
      ${3} | ${[1, 2]}          | ${2}
      ${3} | ${[1, 2, 3, 4, 5]} | ${3}
    `('should hold $expected items after pushing $values into a buffer of $size', ({ size, values, expected }) => {
      expect(filled(size, values).length).toBe(expected);
    });
  });

  describe('first', () => {
    // Full, the oldest item is in the slot the next push overwrites: slot 0 after 3 pushes into 3 slots, 1 after 4, 2 after 5
    it.each`
      size | values                   | expected
      ${3} | ${[]}                    | ${undefined}
      ${3} | ${[1, 2]}                | ${1}
      ${3} | ${[1, 2, 3]}             | ${1}
      ${3} | ${[1, 2, 3, 4]}          | ${2}
      ${3} | ${[1, 2, 3, 4, 5]}       | ${3}
      ${3} | ${[1, 2, 3, 4, 5, 6, 7]} | ${5}
      ${1} | ${[1, 2]}                | ${2}
    `('should return $expected from first() after pushing $values into a buffer of $size', ({ size, values, expected }) => {
      expect(filled<number>(size, values).first()).toBe(expected);
    });
  });

  describe('max and min', () => {
    // As Math.max and Math.min of the items held: NaN wins, 0 is above -0 whatever their order, and an item pushed out counts no more
    it.each`
      read     | size | values                | expected
      ${'max'} | ${3} | ${[]}                 | ${-Infinity}
      ${'min'} | ${3} | ${[]}                 | ${Infinity}
      ${'max'} | ${5} | ${[4, 1, 7]}          | ${7}
      ${'min'} | ${5} | ${[4, 1, 7]}          | ${1}
      ${'max'} | ${3} | ${[-15, 11, 9, 2, 8]} | ${9}
      ${'min'} | ${3} | ${[-15, 11, 9, 2, 8]} | ${2}
      ${'max'} | ${1} | ${[3, -5]}            | ${-5}
      ${'min'} | ${1} | ${[-5, 3]}            | ${3}
      ${'max'} | ${3} | ${[-0, 0, -0]}        | ${0}
      ${'min'} | ${3} | ${[0, -0, 0]}         | ${-0}
      ${'max'} | ${2} | ${[-0, -0]}           | ${-0}
      ${'max'} | ${3} | ${[1, NaN, 3]}        | ${NaN}
      ${'min'} | ${3} | ${[1, NaN, 3]}        | ${NaN}
      ${'max'} | ${3} | ${[NaN, 1, 2, 3]}     | ${3}
      ${'min'} | ${3} | ${[NaN, 1, 2, 3]}     | ${1}
    `('should return $expected as the $read after pushing $values into a buffer of $size', ({ read, size, values, expected }) => {
      expect(filled<number>(size, values)[read as 'max' | 'min']()).toBe(expected);
    });
  });

  describe('sum', () => {
    // 1e16 + 1 rounds back to 1e16, so these sums tell the orders apart: the physical order of the first row gives 1, and so does the
    // newest-first order of the second. A sum from 0 rather than from the oldest item turns the -0 of the third and fourth into 0.
    it.each`
      size | values                 | expected
      ${3} | ${[5, 1e16, 1, -1e16]} | ${0}
      ${3} | ${[7, 1, 1e16, -1e16]} | ${0}
      ${2} | ${[-0, -0]}            | ${-0}
      ${2} | ${[5, -0, -0]}         | ${-0}
      ${3} | ${[]}                  | ${0}
      ${3} | ${[1, 2]}              | ${3}
      ${1} | ${[4, 6]}              | ${6}
      ${3} | ${[1, NaN, 2]}         | ${NaN}
    `('should return $expected as the sum after pushing $values into a buffer of $size', ({ size, values, expected }) => {
      expect(filled<number>(size, values).sum()).toBe(expected);
    });
  });

  describe('reduce', () => {
    it.each`
      size | values                | expected
      ${3} | ${[]}                 | ${[]}
      ${3} | ${[1, 2]}             | ${[1, 2]}
      ${3} | ${[1, 2, 3, 4, 5]}    | ${[3, 4, 5]}
      ${3} | ${[1, 2, 3, 4, 5, 6]} | ${[4, 5, 6]}
    `('should fold $expected oldest first after pushing $values into a buffer of $size', ({ size, values, expected }) => {
      const rb = filled<number>(size, values);

      expect(rb.reduce<number[]>((items, item) => [...items, item], [])).toEqual(expected);
    });

    it('should call back with 2, 3 and 4, oldest first, each time with the argument itself rather than a copy', () => {
      const argument = { mean: 3 };
      const rb = filled(3, [1, 2, 3, 4]);

      const calls = rb.reduce(
        (log: { item: number; isArgument: boolean }[], item: number, given: { mean: number }) => [
          ...log,
          { item, isArgument: given === argument },
        ],
        [],
        argument,
      );

      expect(calls).toEqual([
        { item: 2, isArgument: true },
        { item: 3, isArgument: true },
        { item: 4, isArgument: true },
      ]);
    });
  });

  describe('reading in place', () => {
    // The indicators read their window on every candle: first used to copy it through toArray on every call, and max and min to spread
    // it into Math.max and Math.min. 4 pushes into 3 slots leave 4 in slot 0 and the oldest item, 2, in slot 1.
    it.each`
      read        | call                                                                   | expected
      ${'first'}  | ${(rb: RingBuffer<number>) => rb.first()}                              | ${['1']}
      ${'max'}    | ${(rb: RingBuffer<number>) => rb.max()}                                | ${['0', '1', '2']}
      ${'min'}    | ${(rb: RingBuffer<number>) => rb.min()}                                | ${['0', '1', '2']}
      ${'sum'}    | ${(rb: RingBuffer<number>) => rb.sum()}                                | ${['0', '1', '2']}
      ${'reduce'} | ${(rb: RingBuffer<number>) => rb.reduce((sum, item) => sum + item, 0)} | ${['0', '1', '2']}
    `('should look up nothing but the slots $expected for $read', ({ call, expected }) => {
      expect(lookupsOf(filled(3, [1, 2, 3, 4]), call)).toEqual(expected);
    });

    it.each`
      read        | call
      ${'first'}  | ${(rb: RingBuffer<number>) => rb.first()}
      ${'max'}    | ${(rb: RingBuffer<number>) => rb.max()}
      ${'min'}    | ${(rb: RingBuffer<number>) => rb.min()}
      ${'sum'}    | ${(rb: RingBuffer<number>) => rb.sum()}
      ${'reduce'} | ${(rb: RingBuffer<number>) => rb.reduce((sum, item) => sum + item, 0)}
    `('should read $read in place, without calling toArray', ({ call }) => {
      const rb = filled(3, [1, 2, 3, 4]);
      const toArray = vi.spyOn(rb, 'toArray');

      call(rb);

      expect(toArray).not.toHaveBeenCalled();
    });
  });
});
