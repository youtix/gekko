import { RoundTrip } from '@models/event.types';
import { info } from '@services/logger';
import { formatDurationUTC, toISOString } from '@utils/date/date.utils';
import { isFiniteNumber } from '@utils/math/math.utils';
import { formatAmount, formatPercent, formatRatio } from '@utils/string/string.utils';
import { PERCENT_ROUNDING } from '../analyzer.const';
import { TradingReport } from './roundTrip.types';

export const logRoundtrip = (roundTrip: RoundTrip, currency: string, enableConsoleTable: boolean) => {
  if (enableConsoleTable) {
    const { pnl, profit } = roundTrip;
    // eslint-disable-next-line no-console
    console.table({
      entryDateUTC: toISOString(roundTrip.entryAt),
      exitDateUTC: toISOString(roundTrip.exitAt),
      // Counted on the UTC calendar from epoch 0: on the host's, a round trip of 200 days read "6 months 19 days 1 hour" in New York,
      // which moved its clocks in 1970
      exposedDuration: formatDurationUTC(0, roundTrip.duration),
      // A round trip that no portfolio read valued has neither (see RoundTrip): written NaN, they read as a figure
      'P&L': isFiniteNumber(pnl) ? `${formatAmount(pnl)} ${currency}` : 'unknown',
      profit: isFiniteNumber(profit) ? formatPercent(profit, PERCENT_ROUNDING.profit) : 'unknown',
      MAE: formatPercent(roundTrip.maxAdverseExcursion, PERCENT_ROUNDING.maxAdverseExcursion),
    });
  }
  info('roundtrip analyzer', roundTrip);
};

/**
 * Prints the report as a table, under the reason the run stopped before its end when it did. The table replaces the info line of the
 * report, so it gives every figure the CSV row gives: without the net profit and the total return, it showed the alpha without the
 * return it is worked out from, and the profit only as the gap between two balances. Its percentages, ratios and deviations are written
 * as the CSV writes them (see PERCENT_ROUNDING and formatRatio). Rounded half up, a win rate of 3.125 % read 3.13 % here and 3.12 % in
 * the CSV; and the downside deviation, a ratio there as the volatility is here, read 1.23 % for the 1.24 of the CSV.
 */
export const logFinalize = (report: TradingReport, currency: string) => {
  // A run stopped before its end (a crash, missing candles, the circuit breaker) reports a partial period, which its table showed as a
  // complete one. Said above the table rather than in a row: a reason as long as its error makes it would widen every row to its length,
  // and Bun prints a line break in it as it is, through the borders.
  if (report.interruption !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`Run interrupted, the report below covers a partial period. Reason: ${report.interruption}`);
  }
  const yearlyReturn = formatPercent(report.annualizedReturnPct, PERCENT_ROUNDING.annualizedReturnPct);
  // eslint-disable-next-line no-console
  console.table({
    label: 'PROFIT REPORT',
    periodStartAt: toISOString(report.periodStartAt),
    periodEndAt: toISOString(report.periodEndAt),
    duration: report.formattedDuration,
    exposurePct: `${formatPercent(report.exposurePct, PERCENT_ROUNDING.exposurePct)} of time exposed`,
    startPrice: `${formatAmount(report.startPrice)} ${currency}`,
    endPrice: `${formatAmount(report.endPrice)} ${currency}`,
    netProfit: `${formatAmount(report.netProfit)} ${currency}`,
    totalReturnPct: formatPercent(report.totalReturnPct, PERCENT_ROUNDING.totalReturnPct),
    marketReturnPct: formatPercent(report.marketReturnPct, PERCENT_ROUNDING.marketReturnPct),
    alpha: formatPercent(report.alpha, PERCENT_ROUNDING.alpha),
    annualizedNetProfit: `${formatAmount(report.annualizedNetProfit)} ${currency} (${yearlyReturn})`,
    tradeCount: report.tradeCount,
    startBalance: `${formatAmount(report.startBalance)} ${currency}`,
    finalBalance: `${formatAmount(report.finalBalance)} ${currency}`,
    sharpeRatio: formatRatio(report.sharpeRatio),
    sortinoRatio: formatRatio(report.sortinoRatio),
    volatility: formatRatio(report.volatility),
    downsideDeviation: formatRatio(report.downsideDeviation),
    winRate: report.winRate === null ? 'N/A' : formatPercent(report.winRate, PERCENT_ROUNDING.winRate),
    topMAEs: report.topMAEs.map(mae => formatPercent(mae, PERCENT_ROUNDING.maxAdverseExcursion)).join(', '),
  });
};
