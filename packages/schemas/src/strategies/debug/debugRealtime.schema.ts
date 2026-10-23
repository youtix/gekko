import { z } from 'zod';

// No parameter: the strategy buys on its first candle and sells on its second, so a key in its block can only be a mistake
export const debugRealtimeStrategySchema = z.strictObject({});
