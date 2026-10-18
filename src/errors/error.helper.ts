import { isFinitePositive } from '@utils/math/math.utils';
import { formatEveryDecimal } from '@utils/string/string.utils';
import { isString } from 'lodash-es';
import { inspect } from 'node:util';
import { Rounding } from './error.types';
import { GekkoError } from './gekko.error';

/**
 * The message of a failure, for a line that quotes it: a log line or the message of another error, each with a tag of its own. A
 * GekkoError gives its message without its tag (see GekkoError.untaggedMessage), an AggregateError its message then its errors, any
 * other Error its message, a string itself, an object with a message util.inspect does not show (Bun's ResolveMessage and BuildMessage)
 * its class and message, and any other value what util.inspect writes. Not String(), which a template literal calls too: it writes an
 * object as "[object Object]" and throws for one without a prototype, from the very catch meant to report the failure.
 */
export const describeError = (value: unknown): string => describeListed(value, []);

/** describeError within `listing`, the AggregateErrors whose errors are being listed, the outermost first */
const describeListed = (value: unknown, listing: readonly unknown[]): string => {
  if (value instanceof GekkoError) return value.untaggedMessage;
  if (value instanceof AggregateError) return describeAggregateError(value, listing);
  if (value instanceof Error) return value.message;
  if (isString(value)) return value;
  return describeErrorLike(value) ?? inspect(value);
};

/**
 * Its message names none of its errors: Bun reports two syntax errors in a strategy file as '2 errors building "<file>"', whose errors
 * say what is wrong and where. They follow the message, each described as describeError does, separated by semicolons. An
 * AggregateError among its own errors, at any depth, is not listed again: the line would never end.
 */
const describeAggregateError = (error: AggregateError, listing: readonly unknown[]) => {
  const ancestors = [...listing, error];
  // Writable, so it may hold anything: what is not a list is ignored, rather than make the catch that reports the failure throw
  const errors: unknown[] = Array.isArray(error.errors) ? error.errors : [];
  const described = errors.filter(inner => !ancestors.includes(inner)).map(inner => describeListed(inner, ancestors));
  return [error.message, described.join('; ')].filter(Boolean).join(': ');
};

/**
 * util.inspect writes an object's own enumerable properties, so it wrote Bun's ResolveMessage and BuildMessage, which the import of a
 * strategy file that cannot be found or parsed rejects with, as 'ResolveMessage {}': they are not Errors, and their message is a getter
 * of their class. An object with a string message that is not one of those properties is written "<its class>: <message>", followed by
 * its position when it has one, as a BuildMessage does: its message names no file ('Expected ")" but found ";"'). Undefined for any
 * other value, and when a getter throws: inspect, which calls none, never threw on such an object.
 */
const describeErrorLike = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const message: unknown = Reflect.get(value, 'message');
    if (!isString(message) || Object.prototype.propertyIsEnumerable.call(value, 'message')) return undefined;
    const constructor: unknown = Reflect.get(value, 'constructor');
    const className = typeof constructor === 'function' ? constructor.name : '';
    return [className, message].filter(Boolean).join(': ') + describePosition(Reflect.get(value, 'position'));
  } catch {
    return undefined;
  }
};

/** " at <file>:<line>:<column>", where a BuildMessage's position puts its syntax error: Bun counts both from 1, as an editor does */
const describePosition = (position: unknown) => {
  if (typeof position !== 'object' || position === null) return '';
  const { file, line, column } = position as Record<string, unknown>;
  return isString(file) && Number.isInteger(line) && Number.isInteger(column) ? ` at ${file}:${line}:${column}` : '';
};

/**
 * A failure as an Error: an Error as it is, any other thrown value wrapped in an Error whose message describes it (see describeError),
 * so that it can be reported, or rejected with, as an Error.
 */
export const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(describeError(value)));

/** What the market allows: the range between its two bounds, the one bound it sets, or nothing without any */
const describeBounds = (min?: number, max?: number): string => {
  if (min !== undefined && max !== undefined) return ` Expected a value between ${formatEveryDecimal(min)} and ${formatEveryDecimal(max)}.`;
  if (min !== undefined) return ` Minimum allowed is ${formatEveryDecimal(min)}.`;
  return max !== undefined ? ` Maximum allowed is ${formatEveryDecimal(max)}.` : '';
};

/** Why the value is refused, and what the market allows */
export const describeRefusal = (property: string, current: number, min?: number, max?: number, rounding?: Rounding): string => {
  // Rounded to nothing by the step of the market: reported as 0, an amount of 0.0000099 BTC on a step of 0.00001 would read "value 0 is
  // invalid", what the order asked for, the step and the minimum all unsaid
  if (current === 0 && isFinitePositive(rounding?.requested)) {
    const step = rounding.step !== undefined ? ` ${formatEveryDecimal(rounding.step)}` : '';
    return `${formatEveryDecimal(rounding.requested)} rounds to 0 on the ${property} step${step} of the market.${describeBounds(min, max)}`;
  }
  // NaN, ±Infinity, zero or a negative number is refused whatever the limits: "too low"/"too high" would be wrong for it
  if (!isFinitePositive(current)) return `${formatEveryDecimal(current)} is invalid. Expected a finite number greater than 0.`;
  if (min !== undefined && max !== undefined) return `${formatEveryDecimal(current)} is out of range.${describeBounds(min, max)}`;
  return `${formatEveryDecimal(current)} ${min !== undefined ? 'is too low' : 'is too high'}.${describeBounds(min, max)}`;
};
