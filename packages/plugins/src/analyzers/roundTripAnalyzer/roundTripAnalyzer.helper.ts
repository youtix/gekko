import { BOOKED_CURRENCY_UNIT } from '@gekko/shared/constants/order.const';
import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { OrderCanceledEvent, RoundTrip } from '@gekko/shared/models/event.types';
import { info } from '@gekko/core/logger/logger';
import { formatDurationUTC, toISOString } from '@gekko/shared/utils/date/date.utils';
import {
  addPrecise,
  compareWithTolerance,
  isFiniteNumber,
  isFinitePositive,
  toSignificantDigits,
} from '@gekko/shared/utils/math/math.utils';
import { shiftDecimalPoint } from '@gekko/shared/utils/math/round.utils';
import { formatAmount, formatPercent, formatRatio } from '@gekko/shared/utils/string/string.utils';
import { PERCENT_ROUNDING } from '../analyzer.const';
import { DateRange, ExcursionCandle, OpenRoundTrip, TradingReport } from './roundTrip.types';
import { LATE_FILL_CANDLES } from './roundTripAnalyzer.const';

/** A mean price weighted by amounts, once one more price is added with its amount */
export const addToMeanPrice = (meanPrice: number, amount: number, price: number, addedAmount: number) =>
  (meanPrice * amount + price * addedAmount) / (amount + addedAmount);

/**
 * The price the part a canceled order filled counts at, and where it comes from: the mean price of its fills, which the Trader relays
 * as the exchange reported them (see OrderCanceledEvent); without it, the price of a LIMIT order, a limit it reached or beat, else the
 * last close of its pair. Not the price of a MARKET or a STICKY order, which fills at the market: that is the price the strategy sized
 * it from (a BUY by cost or allocation, a SELL by cost), and the round trip took it for the price of the fill, its cost and its P&L off
 * by the amount filled times the gap.
 */
export const priceCanceledFill = (
  { type, price, fillPrice }: Pick<OrderCanceledEvent['order'], 'type' | 'price' | 'fillPrice'>,
  lastClose: number,
) => {
  if (isFinitePositive(fillPrice)) return { price: fillPrice, source: 'the prices of its fills, as the exchange reported them' };
  if (type === 'LIMIT' && isFinitePositive(price)) return { price, source: 'its limit price' };
  return { price: lastClose, source: 'the last close' };
};

/**
 * The P&L and the profit of a round trip, from its own fills: what its SELLs brought in, less what its BUYs cost and the fees of all of
 * them (but a BUY fee taken in the asset bought, which the smaller amount sold carries: see RoundTrip.fees), in decimal (see
 * RoundTrip.pnl), so that an asset held before it, or the fills of another pair, count in none of it; the profit is that P&L in % of its
 * entry equity, to 15 significant digits, as the total return of a report is worked out (see calculateTotalReturnPct). Measured from the
 * pair equity before its BUY to the pair equity after its SELL, a round trip on a pair whose asset the account already held made what the
 * price did to the whole holding: 1,009.79 for a BUY of 1 BTC at 100 sold at 110, 100 BTC held, where its fills made 9.79; and on several
 * pairs, those equities would count the fills of the other pairs, which share the currency.
 *
 * A P&L less than BOOKED_CURRENCY_UNIT from 0, or proceeds equal to the cost and the fees together within compareWithTolerance, once past
 * what the decimal helpers keep exact, is a break-even: P&L 0 and profit 0, no win. The profit is unknown (NaN) without an entry equity
 * above 0, whatever the P&L: no portfolio read valued the base it is a share of (see RoundTrip.entryEquity).
 */
export const measureRoundTrip = (
  { cost, proceeds, fees }: Pick<OpenRoundTrip, 'cost' | 'proceeds' | 'fees'>,
  entryEquity: number,
): Pick<RoundTrip, 'pnl' | 'profit'> => {
  const spent = addPrecise(cost, fees);
  const change = addPrecise(proceeds, -spent);
  const pnl = Math.abs(change) < BOOKED_CURRENCY_UNIT || compareWithTolerance(proceeds, spent) === 0 ? 0 : change;
  if (!(entryEquity > 0)) return { pnl, profit: NaN };
  // The P&L moved two places in decimal, divided once and rid of the noise of that division, as calculateTotalReturnPct works out the
  // change of two equities: through it, the P&L added to the entry equity and taken off again lost its digits past the 15th
  return { pnl, profit: pnl === 0 ? 0 : toSignificantDigits(shiftDecimalPoint(pnl, 2) / entryEquity) };
};

/**
 * The time of the period covered by at least one of `intervals`, each clipped to the period: the exposure of round trips that can
 * overlap, those of two pairs held at once counting the time they share once. Added up, two pairs held through the whole period made
 * an exposure of 200 %. Each interval counts within the period alone: in realtime a fill heard after the warmup can be dated before its
 * start, and one heard last after the close of the last bucket, its end.
 */
export const measureCoveredMs = (intervals: readonly DateRange[], { start, end }: DateRange): number => {
  const clipped = intervals
    .map(interval => ({ start: Math.max(interval.start, start), end: Math.min(interval.end, end) }))
    .filter(interval => interval.end > interval.start)
    .sort((left, right) => left.start - right.start);
  let covered = 0;
  // The end of the intervals counted so far, which follow one another from the start: an interval counts from there on
  let coveredUntil = start;
  for (const interval of clipped) {
    if (interval.end <= coveredUntil) continue;
    covered += interval.end - Math.max(interval.start, coveredUntil);
    coveredUntil = interval.end;
  }
  return covered;
};

/**
 * Counts a one-minute candle in the adverse excursion of a round trip if it closed after the first BUY of the round trip filled: its
 * low, measured from the entry price the round trip has then. A candle that deepens the excursion is noted (see ExcursionDeepening),
 * for a SELL heard after it to take it back (see measureAdverseExcursion). Returns the round trip, as RingBuffer.reduce hands it on.
 *
 * A round trip reads the candles that close while its position is held: after its first BUY fills, and by the time the SELL that ends
 * it fills. Opened by a fill dated inside minute m, its first millisecond included, and ended by one dated inside minute n, it reads
 * the candles of minutes m to n - 1, in every mode. A backtest and paper trading date a fill at the close of the last candle the
 * simulated exchange processed, the start of the next minute: the round trip of a strategy that buys on the candle of minute a and
 * sells on that of minute b fills at the start of minutes a + 1 and b + 1, and reads the candles of minutes a + 1 to b. Live, the same
 * orders fill a few seconds into minutes a + 1 and b + 1: the same candles, that of minute a + 1 held from the BUY on, that of minute
 * b + 1, held for the seconds before the SELL, left out.
 *
 * The same candles whenever the end of an order is heard. A backtest delivers it with the bucket the order filled in, once the
 * analyzers have read that bucket; realtime, paper trading included, with the first bucket flushed after the Trader has reported it,
 * most often a later one. A candle that closed after a BUY before the BUY was heard is counted when it is (see the recent candles of
 * RoundTripTracker), and one counted that closed after a SELL before the SELL was heard is taken back when it is. Counted as each bucket
 * arrived, a round trip of paper or live trading skipped the first minute it held and read the minute after its SELL: the same candles
 * gave another adverse excursion than in a backtest. Up to LATE_FILL_CANDLES minutes late: a BUY heard later counts the candles of the
 * last LATE_FILL_CANDLES minutes alone, and a SELL heard later may keep candles that closed after it.
 */
export const countCandle = (roundTrip: OpenRoundTrip, { start, low }: ExcursionCandle): OpenRoundTrip => {
  const closeAt = start + ONE_MINUTE;
  // Closed by the time the BUY filled: read before the BUY was heard, or after it by a live stream catching up on minutes it fell behind on
  if (closeAt <= roundTrip.entryAt) return roundTrip;
  const excursion = ((roundTrip.entryPrice - low) / roundTrip.entryPrice) * 100;
  // An excursion that is not a number deepens nothing
  if (!(excursion > roundTrip.maxAdverseExcursion)) return roundTrip;
  const deepenings = roundTrip.excursionDeepenings;
  deepenings.push({ closeAt, previous: roundTrip.maxAdverseExcursion });
  if (deepenings.length > LATE_FILL_CANDLES) deepenings.shift();
  roundTrip.maxAdverseExcursion = excursion;
  return roundTrip;
};

/**
 * The adverse excursion a round trip ends with, its SELL filled at `exitAt`: that of the candles counted that closed by then (see
 * countCandle). One that closed after it, read before the SELL was heard, took nothing from the position: the round trip ends with the
 * deepest excursion before the first of them that deepened it, or with the deepest of all when none did.
 */
export const measureAdverseExcursion = ({ maxAdverseExcursion, excursionDeepenings }: OpenRoundTrip, exitAt: EpochTimeStamp) =>
  excursionDeepenings.find(({ closeAt }) => closeAt > exitAt)?.previous ?? maxAdverseExcursion;

/**
 * Logs a round trip at info level, and prints it as a table with `enableConsoleTable`, a first row naming its pair when `namesPair`: a
 * run that watches several pairs prints the round trips of all of them, one after the other
 */
export const logRoundtrip = (roundTrip: RoundTrip, currency: string, enableConsoleTable: boolean, namesPair: boolean) => {
  if (enableConsoleTable) {
    const { pnl, profit } = roundTrip;
    // eslint-disable-next-line no-console
    console.table({
      ...(namesPair ? { pair: roundTrip.symbol } : {}),
      entryDateUTC: toISOString(roundTrip.entryAt),
      exitDateUTC: toISOString(roundTrip.exitAt),
      // Counted on the UTC calendar from epoch 0: on the host's, a round trip of 200 days read "6 months 19 days 1 hour" in New York,
      // which moved its clocks in 1970
      exposedDuration: formatDurationUTC(0, roundTrip.duration),
      // A round trip whose entry no portfolio read valued has no profit (see RoundTrip): written NaN, it read as a figure
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
 *
 * On several pairs, a second table follows, a row per pair: the breakdown of the report (see TradingReport.pairs), which the CSV row,
 * one per run, leaves out. On one pair, it would repeat the first.
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
    // The asset of those prices, which the market return is that of: on several pairs, they were the prices of an asset the table did
    // not name
    benchmark: report.benchmarkAsset,
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
  if (report.pairs.length < 2) return;
  // eslint-disable-next-line no-console
  console.table(
    Object.fromEntries(
      report.pairs.map(pair => [
        pair.symbol,
        {
          roundTrips: pair.roundTripCount,
          wins: pair.winCount,
          winRate: pair.winRate === null ? 'N/A' : formatPercent(pair.winRate, PERCENT_ROUNDING.winRate),
          tradeCount: pair.tradeCount,
          'P&L': `${formatAmount(pair.pnl)} ${currency}`,
          exposurePct: formatPercent(pair.exposurePct, PERCENT_ROUNDING.exposurePct),
          deepestMAE: formatPercent(pair.maxAdverseExcursion, PERCENT_ROUNDING.maxAdverseExcursion),
        },
      ]),
    ),
  );
};
