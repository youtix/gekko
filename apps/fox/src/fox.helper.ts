import { error, info } from '@gekko/core/logger/logger';
import { listInWords, pluralize } from '@gekko/shared/utils/string/string.utils';
import type { VariantResult } from './fox.types';

/** The variants that ended so, as a summary names them: `2 failed: variants 3 and 7`, or nothing when none did */
const describeEnded = (results: readonly VariantResult[], status: 'stopped' | 'failed') => {
  const variants = results.filter(result => result.status === status).map(({ variant }) => String(variant));
  return variants.length ? [`${variants.length} ${status}: ${pluralize('variant', variants.length)} ${listInWords(variants)}`] : [];
};

/**
 * Logs how the variants went: `12 variants, 0 failed` at info level when every one is done, else at error level, naming the failed
 * variants, then the stopped ones (the circuit breaker's stop), apart: `12 variants, 2 failed: variants 3 and 7; 1 stopped: variant 5`.
 * Says whether one failed, for Fox to exit with code 1: a stopped variant, as the bot's stop, leaves the code at 0.
 */
export const logSummary = (results: readonly VariantResult[]) => {
  const count = `${results.length} ${pluralize('variant', results.length)}`;
  const ended = [...describeEnded(results, 'failed'), ...describeEnded(results, 'stopped')];
  if (!ended.length) info('fox', `${count}, 0 failed`);
  else error('fox', `${count}, ${ended.join('; ')}`);
  return results.some(({ status }) => status === 'failed');
};
