/**
 * The issues zod reports on a strategy block, which the StrategyManager lists at start-up, each with its path, before it stops the run
 * (see "Parameters Are Checked at Start-up" in documentation/built-in-strategies.md): the tests of the strategy schemas pin them.
 */

/** A key the block does not declare: a misspelling, or a parameter of another strategy (src on CCI) */
export const unknownKey = (key: string) => `Unrecognized key: "${key}"`;

/** A required parameter left out, `expected` what it takes: a number, or an object for a thresholds block */
export const missing = (expected: 'number' | 'object') => `Invalid input: expected ${expected}, received undefined`;

/**
 * The two issues of a misspelt parameter, in the order zod reports them: the parameter at `path`, missing, then the misspelling `key`,
 * unknown to the object that holds it
 */
export const misspeltIssues = (path: PropertyKey[], key: string, expected: 'number' | 'object' = 'number') => [
  { code: 'invalid_type', path, message: missing(expected) },
  { code: 'unrecognized_keys', path: path.slice(0, -1), keys: [key], message: unknownKey(key) },
];

/** A number written in quotes */
export const QUOTED_NUMBER = 'Invalid input: expected number, received string';

/** A fraction where a whole number is expected (a period, a count, a persistence) */
export const FRACTIONAL_NUMBER = 'Invalid input: expected int, received number';

/** Infinity or -Infinity, which YAML writes .inf and -.inf: a number that is not finite, which zod words as received number */
export const INFINITE_NUMBER = 'Invalid input: expected number, received number';

/** NaN, which YAML writes .nan */
export const NAN_NUMBER = 'Invalid input: expected number, received NaN';

/** The bounds without a message of their own: above 0 (positive()), at least 0 (nonnegative(), min(0)) and at least 1 (min(1)) */
export const ABOVE_ZERO = 'Too small: expected number to be >0';
export const AT_LEAST_ZERO = 'Too small: expected number to be >=0';
export const AT_LEAST_ONE = 'Too small: expected number to be >=1';

/** A price source that is not one of INPUT_SOURCES, which the refusal lists in their order */
export const UNKNOWN_SOURCE = 'Invalid option: expected one of "open"|"high"|"low"|"close"|"hl2"|"hlc3"|"ohlc4"';
