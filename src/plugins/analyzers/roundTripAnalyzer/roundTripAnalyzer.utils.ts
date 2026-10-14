import { tz } from '@date-fns/tz';
import { RoundTrip } from '@models/event.types';
import { info } from '@services/logger';
import { toISOString } from '@utils/date/date.utils';
import { isFiniteNumber } from '@utils/math/math.utils';
import { round } from '@utils/math/round.utils';
import { formatAmount, formatRatio } from '@utils/string/string.utils';
import { formatDuration, intervalToDuration } from 'date-fns';
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
      exposedDuration: formatDuration(intervalToDuration({ start: 0, end: roundTrip.duration }, { in: tz('UTC') })),
      // A round trip that no portfolio read valued has neither (see RoundTrip): written NaN, they read as a figure
      'P&L': isFiniteNumber(pnl) ? `${formatAmount(pnl)} ${currency}` : 'unknown',
      profit: isFiniteNumber(profit) ? `${round(profit, 2, 'down')}%` : 'unknown',
      MAE: `${round(roundTrip.maxAdverseExcursion, 2, 'down')}%`,
    });
  }
  info('roundtrip analyzer', roundTrip);
};

export const logFinalize = (report: TradingReport, currency: string) => {
  // eslint-disable-next-line no-console
  console.table({
    label: 'PROFIT REPORT',
    periodStartAt: toISOString(report.periodStartAt),
    periodEndAt: toISOString(report.periodEndAt),
    duration: report.formattedDuration,
    exposurePct: `${round(report.exposurePct, 2, 'halfEven')}% of time exposed`,
    startPrice: `${formatAmount(report.startPrice)} ${currency}`,
    endPrice: `${formatAmount(report.endPrice)} ${currency}`,
    marketReturnPct: `${round(report.marketReturnPct, 2, 'down')}%`,
    alpha: `${round(report.alpha, 2, 'down')}%`,
    annualizedNetProfit: `${formatAmount(report.annualizedNetProfit)} ${currency} (${round(report.annualizedReturnPct, 2, 'down')}%)`,
    tradeCount: report.tradeCount,
    startBalance: `${formatAmount(report.startBalance)} ${currency}`,
    finalBalance: `${formatAmount(report.finalBalance)} ${currency}`,
    sharpeRatio: formatRatio(report.sharpeRatio),
    sortinoRatio: formatRatio(report.sortinoRatio),
    volatility: formatRatio(report.volatility),
    downsideDeviation: `${round(report.downsideDeviation, 2, 'down')}%`,
    winRate: report.winRate === null ? 'N/A' : `${round(report.winRate, 2)}%`,
    topMAEs: report.topMAEs.map(mae => `${round(mae, 2, 'down')}%`).join(', '),
  });
};
