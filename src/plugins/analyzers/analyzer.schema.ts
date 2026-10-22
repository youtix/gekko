import { assetSchema } from '@models/schema/pairConfig.schema';
import { z } from 'zod';

export const analyzerSchema = z.strictObject({
  name: z.string(),
  // 0 is a legitimate risk-free rate (cash that earns nothing): the Sharpe and Sortino ratios then weigh the bare return against its risk
  riskFreeReturn: z.number().nonnegative().default(5),
  enableConsoleTable: z.boolean().default(false),
  /**
   * The asset whose price gives the market return of the report: one of watch.assets, which the analyzer checks as it is built (a
   * GekkoError naming the watched assets stops the run otherwise). Left out, BTC when it is watched, else the first asset of watch.assets.
   */
  benchmarkAsset: assetSchema.optional(),
});
