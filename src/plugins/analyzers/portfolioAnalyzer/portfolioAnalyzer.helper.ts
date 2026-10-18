import { formatDurationUTC, toISOString } from '@utils/date/date.utils';
import { formatAmount, formatPercent, formatRatio } from '@utils/string/string.utils';
import { PERCENT_ROUNDING } from '../analyzer.const';
import { PortfolioReport } from './portfolioAnalyzer.types';

/**
 * Prints the report as a table, under the reason the run stopped before its end when it did. The table replaces the info line of the
 * report, so it gives every figure the CSV row gives: it left out the bounds of the period and the longest drawdown, which the line gave.
 * Its percentages, ratios and deviations are written as the CSV writes them (see PERCENT_ROUNDING and formatRatio). Rounded to nearest by
 * toFixed, a total return of -5.001 % read -5.00 % here and -5.01 % in the CSV, and a Sharpe ratio of 1.23456 read 1.2346 and 1.23.
 */
export const logPortfolioReport = (report: PortfolioReport, currency: string): void => {
  // A run stopped before its end (a crash, missing candles, the circuit breaker) reports a partial period, which its table showed as a
  // complete one. Said above the table rather than in a row: a reason as long as its error makes it would widen every row to its length,
  // and Bun prints a line break in it as it is, through the borders.
  if (report.interruption !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`Run interrupted, the report below covers a partial period. Reason: ${report.interruption}`);
  }
  // eslint-disable-next-line no-console
  console.table({
    'Net Profit': `${formatAmount(report.netProfit)} ${currency}`,
    'Annualized Net Profit': `${formatAmount(report.annualizedNetProfit)} ${currency}`,
    'Total Return %': formatPercent(report.totalReturnPct, PERCENT_ROUNDING.totalReturnPct),
    'Annualized Return %': formatPercent(report.annualizedReturnPct, PERCENT_ROUNDING.annualizedReturnPct),
    'Market Return %': formatPercent(report.marketReturnPct, PERCENT_ROUNDING.marketReturnPct),
    'Max Drawdown %': formatPercent(report.maxDrawdownPct, PERCENT_ROUNDING.maxDrawdownPct),
    // As the CSV writes it: counted from the epoch on the UTC calendar (see formatDurationUTC), and 0 rather than nothing without one
    'Longest Drawdown': report.longestDrawdownMs > 0 ? formatDurationUTC(0, report.longestDrawdownMs) : '0',
    // Percentage points, the total return less the market return: written without '%', it read as a ratio beside them
    Alpha: formatPercent(report.alpha, PERCENT_ROUNDING.alpha),
    'Sharpe Ratio': formatRatio(report.sharpeRatio),
    'Sortino Ratio': formatRatio(report.sortinoRatio),
    Volatility: formatRatio(report.volatility),
    'Downside Deviation': formatRatio(report.downsideDeviation),
    'Start Equity': `${formatAmount(report.startEquity)} ${currency}`,
    'End Equity': `${formatAmount(report.endEquity)} ${currency}`,
    'Start Price': `${formatAmount(report.startPrice)} ${currency}`,
    'End Price': `${formatAmount(report.endPrice)} ${currency}`,
    Benchmark: report.benchmarkAsset,
    Changes: report.portfolioChangeCount,
    'Period Start': toISOString(report.periodStartAt),
    'Period End': toISOString(report.periodEndAt),
    Duration: report.formattedDuration,
    'Exposure %': formatPercent(report.exposurePct, PERCENT_ROUNDING.exposurePct),
  });
};
