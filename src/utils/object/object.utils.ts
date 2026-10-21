import { isNil } from 'lodash-es';
import { inspect } from 'node:util';
import { PlainObject } from './object.types';

export const shallowObjectDiff = <T extends PlainObject, U extends PlainObject>(a: T, b: U): Partial<T & U> => {
  if (isNil(a) || isNil(b)) throw new TypeError('shallowObjectDiff expects two defined objects');

  const result: PlainObject = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]); // merge and remove duplicate keys

  keys.forEach(key => {
    if (!Object.is(a[key], b[key])) {
      // The value of `b` when it has the key, else that of `a`. Its own keys only: `in` also found those of Object.prototype, and
      // { toString: 1 } against {} gave Object.prototype.toString
      result[key] = Object.hasOwn(b, key) ? b[key] : a[key];
    }
  });

  return result as Partial<T & U>;
};

/**
 * A value as a refusal names it: a string quoted, so that '3' does not read as the number 3, anything else as util.inspect writes it,
 * two levels deep and on one line (`compact`, or util.inspect writes an array of more than six items in rows). String(value) wrote an
 * array of one number, a bigint or a boxed number as that number, an object as [object Object], and threw for an object without a
 * prototype, from the very refusal meant to name it.
 */
export const showValue = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value) : inspect(value, { depth: 2, breakLength: Infinity, compact: true });
