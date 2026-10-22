import { error, info } from '@gekko/core/logger/logger';
import { listInWords, pluralize } from '@gekko/shared/utils/string/string.utils';
import type { VariantResult } from './fox.types';

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
