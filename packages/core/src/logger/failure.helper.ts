import { describeError, isLoaderMessage } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { Tag } from '@gekko/shared/models/tag.types';
import { isNil, isString } from 'lodash-es';
import { debug, error } from './logger';

// "<name>: <message>", then the frames. A stack usually starts with that line, but not always: in Bun, a DOMException's stack
// (the DataCloneError of structuredClone, for one) is frames only. Bun's ResolveMessage and BuildMessage open with what describeError
// writes of them: String() leaves out a BuildMessage's position, which no stack holds either (under Bun 1.4.4, where it is an Error, a
// BuildMessage has none). A stack that is not a string (a writable property, which may hold anything) is left out, rather than make
// the report throw.
const describeStack = (e: Error) => {
  const opening = String(e);
  const header = isLoaderMessage(e) ? describeError(e) : opening;
  const stack = isString(e.stack) ? e.stack : '';
  return stack.startsWith(opening) ? header + stack.slice(opening.length) : [header, stack].filter(Boolean).join('\n');
};

// An Error in full, any other value as describeError writes it
const describeValue = (value: unknown) => (value instanceof Error ? describeStack(value) : describeError(value));

/**
 * What caused `failure`, each failure in full on lines of its own, down to the root cause (inspect() cuts a chain after two causes):
 * the cause of an Error (`Caused by: …`), and the errors an AggregateError holds (`Error 1 of 2: …`), each followed by what caused
 * it in turn. PluginsStream rejects a run whose plugins failed to finalize with the AggregateError of their failures as its cause: one
 * line of messages, which said nothing of where each was thrown. An Error already listed is not listed again: a chain can loop, and
 * an AggregateError can hold itself.
 */
const describeLinks = (failure: unknown, listed: unknown[]): string[] => {
  const lines: string[] = [];
  const list = (label: string, link: unknown) => {
    if (link instanceof Error) {
      if (listed.includes(link)) return;
      listed.push(link);
    }
    lines.push(`${label}: ${describeValue(link)}`, ...describeLinks(link, listed));
  };
  // Writable, so it may hold anything: what is not a list is ignored, rather than make the report of the failure throw
  if (failure instanceof AggregateError && Array.isArray(failure.errors))
    failure.errors.forEach((inner: unknown, index, errors) => list(`Error ${index + 1} of ${errors.length}`, inner));
  if (failure instanceof Error && !isNil(failure.cause)) list('Caused by', failure.cause);
  return lines;
};

/**
 * A failure as logFailure reports it at error level, without a prefix: a GekkoError's one-line message, anything else in full (an
 * Error's name, message and stack), followed by what caused it, in full too (see describeLinks). A Fox worker posts it for a failure
 * whose message does not say where it came from, which Fox's main thread logs at debug level under the variant's line.
 */
export const describeFailure = (failure: unknown): string =>
  [failure instanceof GekkoError ? failure.message : describeValue(failure), ...describeLinks(failure, [failure])].join('\n');

/**
 * How an app reports a failure that stops it, under its tag: the bot's main() and its process handlers, Fox's. A GekkoError is
 * expected and its one-line message explains it: the message at error level, the stack at debug level. Anything else is unexpected:
 * name, message and stack at error level. What caused the failure, whatever it is, follows in full on the error-level line (see
 * describeFailure). `prefix` starts both lines (`Could not close the storage: `, `Uncaught exception: `).
 */
export const logFailure = (tag: Tag, failure: unknown, prefix = '') => {
  error(tag, `${prefix}${describeFailure(failure)}`);
  if (failure instanceof GekkoError) debug(tag, `${prefix}${describeStack(failure)}`);
};
