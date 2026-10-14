import { isString } from 'lodash-es';
import { inspect } from 'node:util';
import { GekkoError } from './gekko.error';

/**
 * The message of a failure, for a line that quotes it: a log line or the message of another error, each with a tag of its own. A
 * GekkoError gives its message without its tag (see GekkoError.untaggedMessage), any other Error its message, a string itself, and any
 * other value what util.inspect writes. Not String(), which a template literal calls too: it writes an object as "[object Object]" and
 * throws for one without a prototype, from the very catch meant to report the failure.
 */
export const describeError = (value: unknown): string => {
  if (value instanceof GekkoError) return value.untaggedMessage;
  if (value instanceof Error) return value.message;
  return isString(value) ? value : inspect(value);
};

/**
 * A failure as an Error: an Error as it is, any other thrown value wrapped in an Error whose message describes it (see describeError),
 * so that it can be reported, or rejected with, as an Error.
 */
export const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(describeError(value)));
