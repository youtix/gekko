import { FEE_BUFFER_PERCENT } from '@gekko/shared/constants/order.const';
import { TIMEFRAME_TO_MINUTES } from '@gekko/shared/constants/timeframe.const';
import { AdviceOrder } from '@gekko/shared/models/advice.types';
import { Timeframe } from '@gekko/schemas/configuration/configuration.types';
import { OrderSide } from '@gekko/shared/models/order.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { addPrecise, isFiniteNumber, multiplyPrecise, toSignificantDigits } from '@gekko/shared/utils/math/math.utils';
import { shiftDecimalPoint } from '@gekko/shared/utils/math/round.utils';
import { formatEveryDecimal } from '@gekko/shared/utils/string/string.utils';
import { FreeBalanceLeft } from './trader.types';

type OrderPricing = {
  /** The price plus the fee over the amount for a BUY, less it for a SELL: per unit, the fee in */
  effectivePrice: number;
  /** amount × price */
  base: number;
  /** The fee in currency: the fees of the trades when given, else base × the rate; 0 without a rate, or for a fee below 0 */
  fee: number;
  /** BUY: base + fee, SELL: base − fee */
  total: number;
};

type ComputeOrderPricingFn = (
  side: OrderSide,
  price: number,
  amount: number,
  /** in % */
  feePercent?: number,
  /** in currency: the fees of the trades of the order added up (see OrderSummary.fee) */
  tradesFee?: number,
) => OrderPricing;

/**
 * The figures of a filled order, worked out in decimal (see multiplyPrecise and addPrecise). Its fee is `tradesFee`, the fees of its
 * trades added up exactly, when it is a finite number, else its cost times `feePercent`, for a summary without it; none without a rate
 * (the exchange gave no fee information, as the Trader warns), nor below 0. The effective price is the price plus or minus the fee over
 * the amount, that one quotient to 15 significant digits (see toSignificantDigits): in binary, and as the total over the amount, a BUY of
 * 4.99825 at 100.01 with a fee of 0.04 % came out at 100.05000400000002, where it is 100.050004.
 *
 * Worked back from the rate, a quotient rounded to 15 significant digits (see OrderSummary.feePercent), the fee missed the fees of the
 * trades: 0.050010000000000006 for 0.5 at 100 and 0.5 at 100.02 that paid 0.05001, the first in BNB. The effective price follows the
 * fee, not the rate: once a trade that says nothing of its fee is left out of both, the price times the rate misses the fee over the
 * amount (108.0375 for 1 at 100, its fee unknown, and 3 at 110 at 0.5 %, as if they paid 2.15, where their fee of 1.65 makes 107.9125).
 */
export const computeOrderPricing: ComputeOrderPricingFn = (side, price, amount, feePercent, tradesFee) => {
  // Invalid price or amount due to exchange returning invalid data or order not filled correctly
  if (Number.isNaN(price) || Number.isNaN(amount) || !(price > 0) || !(amount > 0))
    return { effectivePrice: NaN, base: NaN, fee: NaN, total: NaN };

  const base = multiplyPrecise(amount, price);
  // Exchange did not provide fee information, assuming no fees.
  if (!isFiniteNumber(feePercent)) return { effectivePrice: price, base, fee: 0, total: base };

  const fee = Math.max(0, isFiniteNumber(tradesFee) ? tradesFee : multiplyPrecise(base, shiftDecimalPoint(feePercent, -2)));
  // A BUY pays its fee on top of the price, a SELL has it taken off
  const sign = side === 'BUY' ? 1 : side === 'SELL' ? -1 : 0;
  const total = addPrecise(base, sign * fee);
  const effectivePrice = addPrecise(price, sign * toSignificantDigits(fee / amount));
  return { effectivePrice, base, fee, total };
};

/**
 * The minutes between two synchronizations of a backtest: a timeframe candle, 10 at least to avoid excessive synchronization. The
 * configuration requires a timeframe in backtest (see watchSchema): the 1m it fell back to without one was only ever reached by a test
 * whose mocked configuration had none.
 */
export const getBacktestModeIntervalSyncTime = (timeframe: Timeframe): number => Math.max(TIMEFRAME_TO_MINUTES[timeframe!], 10);

/**
 * What the BUYs placed since the last synchronization take from the currency it read, as a warning of a BUY sized from what they leave
 * says it: what each may spend, the share DEFAULT_FEE_BUFFER keeps back for its fee included (see getBuyBudget), each figure written with
 * every decimal, without an exponent (see formatEveryDecimal)
 */
export const describeBuysPlacedSince = ({ read, taken }: FreeBalanceLeft, currencyName: string) => {
  const placed = `less ${formatEveryDecimal(taken)} ${currencyName} for the BUYs placed since`;
  const feeBuffer = `the ${FEE_BUFFER_PERCENT} % kept back for their fee included`;
  return `${formatEveryDecimal(read)} ${currencyName} free at the last synchronization, ${placed}, ${feeBuffer}`;
};

/**
 * The most the market takes in one order of the type of `order`, `maximum` of its asset (see Trader.getMaximumAmount), as the warning of
 * an order capped at it says it was sent, a SELL's or a BUY's, the maximum written with every decimal (see formatEveryDecimal)
 */
export const describeMaximumSent = ({ type, symbol }: Pick<AdviceOrder, 'type' | 'symbol'>, maximum: number) => {
  const [assetName] = symbol.split('/');
  return `the maximum amount of a ${type} order on ${symbol}: ${formatEveryDecimal(maximum)} ${assetName} sent`;
};

/**
 * What an order sized by its allocation is a share of, as the lines that name its sizing write it: the balance of `unit` the last
 * synchronization read, and, for a BUY whose currency the Trader's own BUYs open at that read held some of (`held`), the two added up,
 * then each (see Trader.getBudget), written with every decimal, without an exponent (see formatEveryDecimal)
 */
export const describeAllocationBase = (read: number, held: number, unit: string) => {
  if (!(held > 0)) return `${formatEveryDecimal(read)} ${unit}`;
  const free = `${formatEveryDecimal(read)} ${unit} free at the last synchronization`;
  const open = `${formatEveryDecimal(held)} ${unit} held by the BUYs open then`;
  return `${formatEveryDecimal(addPrecise(read, held))} ${unit}: ${free}, plus ${open}`;
};

/**
 * A figure of an order the exchange may leave unknown, as the lines of its end quote it: with every decimal, without an exponent (see
 * formatEveryDecimal), and an unknown one as it was always written, undefined (a fee rate none of its trades gave, see
 * createOrderSummary). Not formatEveryDecimal alone, which reads the 'e' of 'undefined' as an exponent and writes 'und'.
 */
export const formatFigure = (value: number | undefined) => (value === undefined ? 'undefined' : formatEveryDecimal(value));

/* -------------------------------------------------------------------------- */
/*                      PORTFOLIO EMISSION FILTERING                          */
/* -------------------------------------------------------------------------- */

export type PortfolioUpdatesConfig = {
  /** Percentage change required to emit (e.g., 1 for 1%) */
  threshold: number;
  /** Value in quote currency below which an asset is ignored */
  dust: number;
};

export type ShouldEmitPortfolioParams = {
  current: Portfolio;
  lastEmitted: Portfolio | null;
  prices: Map<TradingPair, number>;
  pairs: TradingPair[];
  portfolioConfig: PortfolioUpdatesConfig;
};

/**
 * Determines whether a portfolio change is significant enough to warrant emitting a `PORTFOLIO_CHANGE_EVENT`.
 *
 * Every asset of either portfolio is compared: the exchanges, and the backtest simulator, keep a sold-out asset in the balance with a
 * total of 0, and an asset missing from one side counts as 0 there. Both sides are valued at the current prices (total * price), so
 * that a price move alone is never a change. The quote currency of the pairs is valued at 1, and an asset without a known price
 * (outside the pairs, or no ticker) at 0: below any dust above 0, its changes are never emitted.
 *
 * Algorithm:
 * 1. First sync (lastEmitted is null) → always emit.
 * 2. For each asset of current or lastEmitted, it is dust on a side when its value there is below `dust`, or its quantity is 0:
 *    a. Dust on one side only (a buy-in, or a sell-out to 0 or to dust) → emit.
 *    b. Dust on both sides → ignore it.
 *    c. Otherwise, if its quantity changed by more than `threshold` % since lastEmitted → emit.
 * 3. Otherwise → do not emit.
 */
export const shouldEmitPortfolio = ({ current, lastEmitted, prices, pairs, portfolioConfig }: ShouldEmitPortfolioParams): boolean => {
  // First sync → always emit
  if (!lastEmitted) return true;

  // Build asset → price lookup from trading pairs
  // Quote currency (e.g. USDT in BTC/USDT) implicitly has price = 1
  const assetPrices = new Map<string, number>();
  for (const pair of pairs) {
    const [asset, quote] = pair.split('/');
    const price = prices.get(pair);
    if (price !== undefined) assetPrices.set(asset, price);
    if (!assetPrices.has(quote)) assetPrices.set(quote, 1);
  }

  const thresholdFraction = portfolioConfig.threshold / 100;
  // A quantity of 0 is never held, even with a dust of 0: a sell-out then crosses the boundary, where a 100% change would not pass a
  // threshold of 100 or more
  const isHeld = (quantity: number, price: number) => quantity > 0 && quantity * price >= portfolioConfig.dust;

  for (const asset of new Set([...current.keys(), ...lastEmitted.keys()])) {
    const price = assetPrices.get(asset) ?? 0;
    const previousQty = lastEmitted.get(asset)?.total ?? 0;
    const currentQty = current.get(asset)?.total ?? 0;
    const wasHeld = isHeld(previousQty, price);

    // Crossing the dust boundary, either way
    if (wasHeld !== isHeld(currentQty, price)) return true;
    // Dust on both sides: noise
    if (!wasHeld) continue;

    // Held on both sides, so previousQty > 0: |current - previous| / previous > threshold
    if (Math.abs(currentQty - previousQty) / previousQty > thresholdFraction) return true;
  }

  return false;
};
