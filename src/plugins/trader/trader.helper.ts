import { FEE_BUFFER_PERCENT } from '@constants/order.const';
import { TIMEFRAME_TO_MINUTES } from '@constants/timeframe.const';
import { AdviceOrder } from '@models/advice.types';
import { Timeframe } from '@models/configuration.types';
import { OrderSide } from '@models/order.types';
import { Portfolio } from '@models/portfolio.types';
import { TradingPair } from '@models/utility.types';
import { addPrecise, multiplyPrecise } from '@utils/math/math.utils';
import { shiftDecimalPoint } from '@utils/math/round.utils';
import { formatEveryDecimal } from '@utils/string/string.utils';
import { isNil } from 'lodash-es';
import { FreeBalanceLeft } from './trader.types';

type OrderPricing = {
  /** per unit, post-fee */
  effectivePrice: number;
  /** amount * price */
  base: number;
  /** base * feeRate */
  fee: number;
  /** BUY: base+fee, SELL: base-fee */
  total: number;
};

type ComputeOrderPricingFn = (
  side: OrderSide,
  price: number,
  amount: number,
  /** in % */
  feePercent?: number,
) => OrderPricing;

/**
 * Worked out in decimal (see multiplyPrecise and addPrecise), the effective price as the price plus or minus its share of the fee: in
 * binary, and as the total over the amount, a BUY of 4.99825 at 100.01 with a fee of 0.04 % came out at 100.05000400000002, where it
 * is 100.050004.
 */
export const computeOrderPricing: ComputeOrderPricingFn = (side, price, amount, feePercent) => {
  // Invalid price or amount due to exchange returning invalid data or order not filled correctly
  if (Number.isNaN(price) || Number.isNaN(amount) || !(price > 0) || !(amount > 0))
    return { effectivePrice: NaN, base: NaN, fee: NaN, total: NaN };

  const base = multiplyPrecise(amount, price);

  if (!isNil(feePercent) && Number.isFinite(feePercent)) {
    const feeRate = shiftDecimalPoint(Math.max(0, feePercent), -2);
    const fee = multiplyPrecise(base, feeRate);
    // A BUY pays its fee on top of the price, a SELL has it taken off
    const sign = side === 'BUY' ? 1 : side === 'SELL' ? -1 : 0;
    const total = addPrecise(base, sign * fee);
    const effectivePrice = addPrecise(price, sign * multiplyPrecise(price, feeRate));
    return { effectivePrice, base, fee, total };
  }

  // Exchange did not provide fee information, assuming no fees.
  return { effectivePrice: price, base, fee: 0, total: base };
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
