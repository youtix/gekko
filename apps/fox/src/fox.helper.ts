import { debug, error, info } from '@gekko/core/logger/logger';
import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { listInWords, pluralize } from '@gekko/shared/utils/string/string.utils';
import { isNil } from 'lodash-es';
import type { VariantResult } from './fox.types';

// "<name>: <message>", then the frames. A stack usually starts with that line, but not always: in Bun, a DOMException's stack (the
// DataCloneError of structuredClone, for one) is frames only.
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
 * How Fox reports a failure that stops it, as the executable does: a GekkoError is expected and its one-line message explains it (the
 * message at error level, the stack at debug level); anything else is unexpected (name, message and stack at error level). Causes,
 * whatever the failure, follow in full on the error-level line.
 */
export const logFailure = (failure: unknown, prefix = '') => {
  const isExpected = failure instanceof GekkoError;
  error('fox', [`${prefix}${isExpected ? failure.message : describeValue(failure)}`, ...describeCauses(failure)].join('\n'));
  if (isExpected) debug('fox', `${prefix}${describeStack(failure)}`);
};

/**
 * Logs how the variants went: `12 variants, 0 failed` at info level, or, when some failed, at error level with their numbers
 * (`12 variants, 2 failed: variants 3 and 7`). Says whether one failed, for Fox to exit with code 1.
 */
export const logSummary = (results: readonly VariantResult[]) => {
  const failed = results.filter(({ status }) => status === 'failed').map(({ variant }) => String(variant));
  const summary = `${results.length} ${pluralize('variant', results.length)}, ${failed.length} failed`;
  if (!failed.length) {
    info('fox', summary);
    return false;
  }
  error('fox', `${summary}: ${pluralize('variant', failed.length)} ${listInWords(failed)}`);
  return true;
};
