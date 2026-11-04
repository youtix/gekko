import { z } from 'zod';

// 0 passed and stopped the run at the first errored order, as 1 does, where -1 is the only value that disables the circuit breaker
const MAX_CONSECUTIVE_ERRORS_MESSAGE = 'maxConsecutiveErrors must be an integer of at least 1, or -1 to disable the circuit breaker';

// Strict, like every plugin schema: a misspelt option must be refused, not dropped in favour of its default (maxConsecutiveError: -1
// would leave the circuit breaker at 5 errors)
export const tradingAdvisorSchema = z.strictObject({
  name: z.string(),
  strategyName: z.string(),
  strategyPath: z.string().optional(),
  maxConsecutiveErrors: z
    .number(MAX_CONSECUTIVE_ERRORS_MESSAGE)
    .int(MAX_CONSECUTIVE_ERRORS_MESSAGE)
    .refine(count => count === -1 || count >= 1, MAX_CONSECUTIVE_ERRORS_MESSAGE)
    .default(5),
});
