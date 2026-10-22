import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { Plugin } from '../../plugin/plugin';
import { PluginFailure } from './plugins.types';

/** Whether a plugin failed: its processing of the bucket, or its finalisation, rejected */
export const isRejected = (result: PromiseSettledResult<void>): result is PromiseRejectedResult => result.status === 'rejected';

/** The plugins whose call rejected, each with what it threw, in the order of `plugins`, which `results` follows */
export const collectFailures = (plugins: Plugin[], results: PromiseSettledResult<void>[]): PluginFailure[] =>
  results.flatMap((result, index) => (isRejected(result) ? [{ plugin: plugins[index], reason: result.reason }] : []));

/**
 * A failure in one line, as main() starts reporting it: a GekkoError's message explains it, any other error is named, and any other
 * value is written as describeError writes it. Not String() for a value that is not an error, which gives '[object Object]' for an
 * object and throws for one without a prototype; nor util.inspect, which wrote Bun's ResolveMessage, the rejection of a dynamic
 * import() of a file that cannot be found, as 'ResolveMessage {}'.
 */
export const describeReason = (reason: unknown) => {
  if (reason instanceof GekkoError) return reason.message;
  if (reason instanceof Error) return String(reason); // "<name>: <message>"
  return describeError(reason);
};
