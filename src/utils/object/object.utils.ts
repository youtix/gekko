import { isNil } from 'lodash-es';
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
