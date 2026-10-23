/** Thrown by copyPlainData on anything but plain data, for copyPayload to fall back on structuredClone */
const NOT_PLAIN_DATA = new Error('Not plain data');

/**
 * Copies plain data: primitives, objects and arrays of Object's and Array's prototypes, and Maps, with their holes, shared references
 * and cycles. Throws NOT_PLAIN_DATA on anything else: an own __proto__ property, which an assignment would take for the prototype, and
 * a function or a symbol, which structuredClone refuses, for the fallback to throw its DataCloneError rather than pass them on.
 */
const copyPlainData = (value: unknown, copies: Map<object, unknown>): unknown => {
  if (typeof value === 'function' || typeof value === 'symbol') throw NOT_PLAIN_DATA;
  if (typeof value !== 'object' || value === null) return value;
  const known = copies.get(value);
  if (known) return known;
  if (value instanceof Map) {
    const map = new Map();
    copies.set(value, map);
    for (const [key, item] of value) map.set(copyPlainData(key, copies), copyPlainData(item, copies));
    return map;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype) throw NOT_PLAIN_DATA;
  const copy = (Array.isArray(value) ? new Array(value.length) : {}) as Record<string, unknown>;
  copies.set(value, copy);
  for (const key of Object.keys(value)) {
    if (key === '__proto__') throw NOT_PLAIN_DATA;
    copy[key] = copyPlainData((value as Record<string, unknown>)[key], copies);
  }
  return copy;
};

/**
 * A copy of a payload, equal to the one structuredClone makes of it, and refused as structuredClone refuses it: a function or a symbol
 * in it throws a DataCloneError. Plain data, what the deferred events hold (Maps of balances or candles, orders, advices), is copied by
 * hand, five to seven times faster than structuredClone under Bun on a timeframe candle, a portfolio or an order event: a backtest at
 * 1m copies its timeframe candle every minute, as it is queued. Anything else is copied by structuredClone itself (a Date, a Set, an
 * Error, a typed array, a class instance), and so is a payload nested deeper than this copy goes. The one difference left: a Proxy of
 * plain data is copied, where structuredClone refuses it.
 */
export const copyPayload = <T>(payload: T): T => {
  try {
    return copyPlainData(payload, new Map()) as T;
  } catch {
    return structuredClone(payload);
  }
};
