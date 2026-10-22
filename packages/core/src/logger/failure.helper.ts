import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { Tag } from '@gekko/shared/models/tag.types';
import { isNil } from 'lodash-es';
import { debug, error } from './logger';

// "<name>: <message>", then the frames. A stack usually starts with that line, but not always: in Bun, a DOMException's stack
// (the DataCloneError of structuredClone, for one) is frames only.
const describeStack = (e: Error) => {
  const header = String(e);
  return e.stack?.startsWith(header) ? e.stack : [header, e.stack].filter(Boolean).join('\n');
};

// An Error in full, any other value as describeError writes it
const describeValue = (value: unknown) => (value instanceof Error ? describeStack(value) : describeError(value));

// Down to the root cause (inspect() cuts a chain after two causes), stopping at a cause already listed: a chain can loop
const describeCauses = (failure: unknown) => {
  const chain = [failure];
  let link = failure;
  while (link instanceof Error && !isNil(link.cause) && !chain.includes(link.cause)) {
    link = link.cause;
    chain.push(link);
  }
  return chain.slice(1).map(cause => `Caused by: ${describeValue(cause)}`);
};

/**
 * How an app reports a failure that stops it, under its tag: the bot's main() and its process handlers, Fox's. A GekkoError is
 * expected and its one-line message explains it: the message at error level, the stack at debug level. Anything else is unexpected:
 * name, message and stack at error level. Causes, whatever the failure, follow in full on the error-level line. `prefix` starts both
 * lines (`Could not close the storage: `, `Uncaught exception: `).
 */
export const logFailure = (tag: Tag, failure: unknown, prefix = '') => {
  const isExpected = failure instanceof GekkoError;
  error(tag, [`${prefix}${isExpected ? failure.message : describeValue(failure)}`, ...describeCauses(failure)].join('\n'));
  if (isExpected) debug(tag, `${prefix}${describeStack(failure)}`);
};
