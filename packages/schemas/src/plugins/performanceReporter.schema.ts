import { z } from 'zod';

export const performanceReporterSchema = z.strictObject({
  name: z.string(),
  filePath: z.string().default(process.cwd()),
  // An empty name would make the path that of the directory, which no report can be written to.
  fileName: z.string().min(1, 'File name must not be empty').default('performance_reports.csv'),
});
