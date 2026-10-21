import { BOOKED_CURRENCY_UNIT } from '@constants/order.const';
import { ONE_MINUTE } from '@constants/time.const';
import { calculateTotalReturnPct } from '@helpers/finance/stats.helper';
import { OrderCanceledEvent, RoundTrip } from '@models/event.types';
import { OrderSide } from '@models/order.types';
import { info } from '@services/logger';
import { formatDurationUTC, toISOString } from '@utils/date/date.utils';
import { addPrecise, compareWithTolerance, isFiniteNumber, isFinitePositive, multiplyPrecise } from '@utils/math/math.utils';
import { formatAmount, formatPercent, formatRatio } from '@utils/string/string.utils';
import { PERCENT_ROUNDING } from '../analyzer.const';
import { ExcursionCandle, Fill, OpenRoundTrip, TradingReport } from './roundTrip.types';
import { LATE_FILL_CANDLES } from './roundTripAnalyzer.const';

/** A mean price weighted by amounts, once one more price is added with its amount */
export const addToMeanPrice = (meanPrice: number, amount: number, price: number, addedAmount: number) =>
  (meanPrice * amount + price * addedAmount) / (amount + addedAmount);

/**
 * The price the part a canceled order filled counts at, and where it comes from: the mean price of its fills, which the Trader relays
 * as the exchange reported them (see OrderCanceledEvent); without it, the price of a LIMIT order, a limit it reached or beat, else the
 * last close. Not the price of a MARKET or a STICKY order, which fills at the market: that is the price the strategy sized it from (a
 * BUY by cost or allocation, a SELL by cost), and the round trip took it for the price of the fill, its entry equity and its P&L off by
 * the amount filled times the gap.
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
 * What a fill changes the pair equity by, valued at `price`, in currency: the asset it moves valued at that price, less the currency it
 * moves for it at its own price, less its fee (see PendingEntry). Worked out in decimal, as the pair equity it is taken off is (see
 * valueEntryEquity).
 */
export const getEquityChange = (side: OrderSide, { price: fillPrice, amount, fee }: Fill, price: number) =>
  addPrecise(multiplyPrecise(side === 'BUY' ? amount : -amount, addPrecise(price, -fillPrice)), -fee);

/**
 * The P&L and the profit of a round trip, from its entry equity to its exit equity, in decimal: the profit as the total return of a
 * report is computed (see calculateTotalReturnPct), where (100 * exit) / entry - 100 left ±1.42e-14 on a round trip that made nothing.
 * Two equities less than BOOKED_CURRENCY_UNIT apart, or equal within compareWithTolerance once past what the decimal helpers keep
 * exact, broke even: P&L and profit 0, no win. Unknown (NaN) without an entry equity above 0 or without an exit equity: valued with the
 * empty portfolio of a Trader that had read none, a BUY of 1 BTC at 100 entered at its fee, 0.1 USDT, and its round trip made
 * +1,009,690 % (see PendingEntry).
 */
export const measureRoundTrip = (entryEquity: number, exitEquity: number): Pick<RoundTrip, 'pnl' | 'profit'> => {
  if (!(entryEquity > 0) || !isFiniteNumber(exitEquity)) return { pnl: NaN, profit: NaN };
  const pnl = addPrecise(exitEquity, -entryEquity);
  if (Math.abs(pnl) < BOOKED_CURRENCY_UNIT || compareWithTolerance(exitEquity, entryEquity) === 0) return { pnl: 0, profit: 0 };
  return { pnl, profit: calculateTotalReturnPct(exitEquity, entryEquity) };
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
 * most often a later one. A candle that closed after a BUY before the BUY was heard is counted when it is (see recentCandles), and one
 * counted that closed after a SELL before the SELL was heard is taken back when it is. Counted as each bucket arrived, a round trip of
 * paper or live trading skipped the first minute it held and read the minute after its SELL: the same candles gave another adverse
 * excursion than in a backtest. Up to LATE_FILL_CANDLES minutes late: a BUY heard later counts the candles of the last LATE_FILL_CANDLES
 * minutes alone, and a SELL heard later may keep candles that closed after it.
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
