import { GekkoError } from '../../errors/gekko.error';
import { showValue } from '../../utils/object/object.utils';
import { addFromFirst } from './ringBuffer.helper';

/**
 * The last `size` items pushed, read oldest first. The indicators read their window on every candle, so every read works on the items
 * in place: first reads one slot, and max, min, sum and reduce walk the items once, without the arrays toArray makes.
 */
export class RingBuffer<T> {
  private size: number;
  private index: number = 0;
  private buffer: T[];

  constructor(size: number) {
    // Each item takes the slot of an array index: a size of 0 or NaN wrote the items after the first to a "NaN" property, a fraction to
    // fractional ones, and the reads contradicted each other (isFull() true while empty, first set while toArray was empty)
    if (!Number.isInteger(size) || size < 1)
      throw new GekkoError('core', `RingBuffer size must be a whole number, at least 1, got ${showValue(size)}`);
    this.buffer = [];
    this.size = size;
  }

  /** The items held: the pushes so far, at most size */
  get length() {
    return this.buffer.length;
  }

  /** The largest item, as Math.max of them all gives it: NaN if one is NaN, 0 above -0, -Infinity while empty */
  max(this: RingBuffer<number>) {
    return this.extreme(Math.max, -Infinity);
  }

  /** The smallest item, as Math.min of them all gives it: NaN if one is NaN, -0 below 0, Infinity while empty */
  min(this: RingBuffer<number>) {
    return this.extreme(Math.min, Infinity);
  }

  /** The items added oldest first, as lodash's sum of toArray() adds them (see addFromFirst). 0 while empty */
  sum(this: RingBuffer<number>) {
    return this.reduce<number | undefined>(addFromFirst, undefined) ?? 0;
  }

  /**
   * Folds the items oldest first, as toArray().reduce(callback, initial) would, without copying them. `argument` goes to every call, so
   * that a callback needing a value of its caller can be a function made once: a closure over the value is made on every call
   */
  reduce<U>(callback: (accumulator: U, item: T) => U, initial: U): U;
  reduce<U, A>(callback: (accumulator: U, item: T, argument: A) => U, initial: U, argument: A): U;
  reduce<U, A>(callback: (accumulator: U, item: T, argument?: A) => U, initial: U, argument?: A): U {
    const buffer = this.buffer;
    const start = this.oldest();
    let accumulator = initial;
    for (let i = start; i < buffer.length; i++) accumulator = callback(accumulator, buffer[i], argument);
    for (let i = 0; i < start; i++) accumulator = callback(accumulator, buffer[i], argument);
    return accumulator;
  }

  /** The oldest item, undefined while empty */
  first(): T | undefined {
    return this.buffer[this.oldest()];
  }

  push(...items: T[]) {
    // A plain loop: forEach would make a closure on every push
    for (let i = 0; i < items.length; i++) {
      this.buffer[this.index] = items[i];
      this.index = (this.index + 1) % this.size;
    }
  }

  isFull() {
    return this.buffer.length === this.size;
  }

  toArray() {
    if (!this.isFull()) return this.buffer.slice(0, this.index);
    return [...this.buffer.slice(this.index), ...this.buffer.slice(0, this.index)];
  }

  /** The slot of the oldest item: 0 until the buffer is full, then the one the next push overwrites */
  private oldest() {
    return this.isFull() ? this.index : 0;
  }

  /**
   * Math.max or Math.min of the items, in the order they are stored: either gives the same in any order, NaN and -0 included. A loop of
   * its own: through reduce, max and min took up to half as long again on every candle
   */
  private extreme(this: RingBuffer<number>, pick: (a: number, b: number) => number, initial: number) {
    const buffer = this.buffer;
    let result = initial;
    for (let i = 0; i < buffer.length; i++) result = pick(result, buffer[i]);
    return result;
  }
}
