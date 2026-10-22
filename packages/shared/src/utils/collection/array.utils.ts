/**
 * The values `values` holds more than once, each listed once, in the order they first repeat: [B, A, A, B] gives [A, B]. Values
 * compare as a Set compares them (SameValueZero, case-sensitive for strings). One pass over two Sets, where the lodash xor of
 * singletons it replaced took seconds on a few thousand values.
 */
export const keepDuplicates = <T>(values: readonly T[]): T[] => {
  const seen = new Set<T>();
  const repeated = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    else seen.add(value);
  }
  return [...repeated];
};
