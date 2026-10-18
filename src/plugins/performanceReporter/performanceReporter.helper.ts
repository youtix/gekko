import { PortfolioReport } from '@plugins/analyzers/portfolioAnalyzer/portfolioAnalyzer.types';
import { TradingReport } from '@plugins/analyzers/roundTripAnalyzer/roundTrip.types';
import { PerformanceReport } from './performanceReporter.types';

export const depthFirstSearch = (node: unknown, callback: (value: string | number | boolean) => void): void => {
  if (isNative(node)) return callback(node);
  if (typeof node !== 'object' || node === null) return;
  // An array is an object too: this one loop visits its items in index order, as it visits the values of an object, so
  // that every primitive is reached exactly once.
  for (const child of Object.values(node)) depthFirstSearch(child, callback);
};

export const collectPrimitives = (value: unknown): string[] => {
  const pieces: string[] = [];
  depthFirstSearch(value, v => pieces.push(String(v)));
  return pieces;
};

export const generateStrategyId = (input: unknown): string => {
  return collectPrimitives(input).join('-');
};

export const isNative = (node: unknown): node is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof node);

/**
 * Writes a value as a cell of the CSV file. A value holding the ';' separator, a double quote or a line break (a strategy
 * parameter, for example) would split or break its row, so it is enclosed in double quotes, its own double quotes doubled.
 */
export const toCsvCell = (value: string | number): string => {
  const cell = String(value);
  return /[;"\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
};

export const portfolioOnly =
  (value: (report: PortfolioReport) => string | number) =>
  (report: PerformanceReport): string | number =>
    report.id === 'PORTFOLIO PROFIT REPORT' ? value(report) : '';

export const tradingOnly =
  (value: (report: TradingReport) => string | number) =>
  (report: PerformanceReport): string | number =>
    report.id === 'TRADING REPORT' ? value(report) : '';
