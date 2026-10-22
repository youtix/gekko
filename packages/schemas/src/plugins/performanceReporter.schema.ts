import { z } from 'zod';

export const performanceReporterSchema = z.strictObject({
  name: z.string(),
  filePath: z.string().default(process.cwd()),
  // An empty name would make the path that of the directory, which no report can be written to.
  fileName: z.string().min(1, 'File name must not be empty').default('performance_reports.csv'),
  // Written after the id of each row, in parentheses: it tells apart the runs of one strategy block, such as the variants Fox makes of
  // a fee or a balance, each of which Fox labels with its values. No default: without it, the id is the strategy block's alone.
  label: z.string().min(1, 'Label must not be empty').optional(),
});
