import { assetSchema } from '../configuration/pairConfig.schema';
import { z } from 'zod';

export const analyzerSchema = z.strictObject({
  name: z.string(),
  // 0 is a legitimate risk-free rate (cash that earns nothing): the Sharpe and Sortino ratios then weigh the bare return against its risk
  riskFreeReturn: z.number().nonnegative().default(5),
  enableConsoleTable: z.boolean().default(false),
  /**
   * The asset whose price gives the market return of the report: one of watch.assets. This schema only checks how it is written:
   * configurationSchema refuses one that is not watched, at plugins[i].benchmarkAsset, as the loader reads the file and as Fox checks its
   * variants, and the analyzer checks it again as it is built (a GekkoError naming the watched assets), for an entry no configuration
   * was parsed with. Left out, BTC when it is watched, else the first asset of watch.assets.
   */
  benchmarkAsset: assetSchema.optional(),
});
