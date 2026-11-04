import { PortfolioReport } from '../analyzers/portfolioAnalyzer/portfolioAnalyzer.types';
import { TradingReport } from '../analyzers/roundTripAnalyzer/roundTrip.types';
import { z } from 'zod';
import type { performanceReporterSchema } from '@gekko/schemas/plugins/performanceReporter.schema';

export type PerformanceReporterConfig = z.infer<typeof performanceReporterSchema>;

/** The reports written to the CSV file: the PortfolioAnalyzer's and the RoundTripAnalyzer's. */
export type PerformanceReport = PortfolioReport | TradingReport;

/** One column of the CSV file: its header, and its value in the row of a report ('' when the report type has no such metric). */
export type CsvColumn = {
  header: string;
  value: (report: PerformanceReport) => string | number;
};
