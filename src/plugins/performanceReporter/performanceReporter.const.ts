import { PerformanceReport } from './performanceReporter.types';

/** Written at the start of a UTF-8 file by the spreadsheets that save it back on Windows (Excel, LibreOffice). */
export const BYTE_ORDER_MARK = '\uFEFF';

/** The value of the `report type` column, for each report this plugin writes. */
export const REPORT_TYPES: Record<PerformanceReport['id'], string> = {
  'PORTFOLIO PROFIT REPORT': 'Portfolio',
  'TRADING REPORT': 'Trading',
};
