import { DEFAULT_FEE_BUFFER } from '@constants/order.const';
import { TIMEFRAME_TO_MINUTES } from '@constants/timeframe.const';
import { Timeframe } from '@models/configuration.types';
import { OrderSide } from '@models/order.types';
import { Portfolio } from '@models/portfolio.types';
import { TradingPair } from '@models/utility.types';
import { addPrecise, multiplyPrecise, toSignificantDigits } from '@utils/math/math.utils';
import { shiftDecimalPoint } from '@utils/math/round.utils';
import { isNil } from 'lodash-es';
import { FreeBalanceLeft } from './trader.types';

/** The share of the currency an all-in BUY spends, the rest kept back for the fee (DEFAULT_FEE_BUFFER), worked out in decimal */
const ALL_IN_BUY_SHARE = addPrecise(1, -DEFAULT_FEE_BUFFER);

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
 * The currency a BUY of `amount` at `price` may spend: the currency an all-in BUY of that amount is sized from, its cost at that price
 * (worked out in decimal, see multiplyPrecise) and the share DEFAULT_FEE_BUFFER keeps back for the fee. Counted at its cost alone, a
 * BUY would leave the BUYs after it nothing for its fee when the exchange takes it in the currency, as the simulated exchange does,
 * nor for a price above the one it was sized at (a MARKET order executes at the market, a STICKY order follows it up): together they
 * would spend more than is held.
 */
export const getBuyBudget = (amount: number, price: number): number => multiplyPrecise(amount, price) / ALL_IN_BUY_SHARE;

/**
 * The amount an all-in BUY spending `currency` places at `price`: what the currency buys at that price, less the share
 * DEFAULT_FEE_BUFFER keeps back for the fee (see getBuyBudget, its inverse). Worked out in decimal: the product exactly (see
 * multiplyPrecise), the one division to 15 significant digits (see toSignificantDigits). In binary it came out an ulp short of a whole
 * number of steps, which an exchange that truncates the amount to its step (ccxt, the simulated exchange) placed one step short: 600
 * USDT at 100 gave 5.699999999999999 BTC, placed as 5.69999. The exact product alone is not enough: divided in binary, 17 USDT at 0.01
 * give 1614.9999999999998. Rounded to the nearest, the amount can come out above the quotient, by a few parts in 10^15 at most, which
 * the 5 % kept back for the fee covers many times over.
 */
export const getAllInBuyAmount = (currency: number, price: number): number =>
  toSignificantDigits(multiplyPrecise(currency, ALL_IN_BUY_SHARE) / price);

/**
 * `allocation` % of `balance` (25 for 25 %): the currency a BUY sized by its allocation may spend, or the amount of the asset a SELL so
 * sized sells. Worked out in decimal, the percentage moved two places (see shiftDecimalPoint), then the product exactly (see
 * multiplyPrecise): in binary, 33.3 % of 3 BTC comes out at 0.9989999999999999, which an exchange that truncates the amount to its step
 * places one step short (0.998 on a step of 0.001).
 */
export const getAllocatedShare = (balance: number, allocation: number): number =>
  multiplyPrecise(balance, shiftDecimalPoint(allocation, -2));

/**
 * The amount a SELL of a notional `cost` places at `price`: the cost over the price, nothing kept back for the fee, which the exchange
 * takes from what the SELL brings in. The one division is given to 15 significant digits (see toSignificantDigits): in binary, 0.3 at
 * 0.1 comes out at 2.9999999999999996, placed one step short of 3 by an exchange that truncates the amount to its step.
 */
export const getSellAmountOfCost = (cost: number, price: number): number => toSignificantDigits(cost / price);

/**
 * The minutes between two synchronizations of a backtest: a timeframe candle, 10 at least to avoid excessive synchronization. The
 * configuration requires a timeframe in backtest (see watchSchema): the 1m it fell back to without one was only ever reached by a test
 * whose mocked configuration had none.
 */
export const getBacktestModeIntervalSyncTime = (timeframe: Timeframe): number => Math.max(TIMEFRAME_TO_MINUTES[timeframe!], 10);

/**
 * What the BUYs placed since the last synchronization take from the currency it read, as a warning of a BUY sized from what they leave
 * says it: what each may spend, the share DEFAULT_FEE_BUFFER keeps back for its fee included (see getBuyBudget)
 */
export const describeBuysPlacedSince = ({ read, taken }: FreeBalanceLeft, currencyName: string) => {
  const placed = `less ${taken} ${currencyName} for the BUYs placed since`;
  const feeBuffer = `the ${shiftDecimalPoint(DEFAULT_FEE_BUFFER, 2)} % kept back for their fee included`;
  return `${read} ${currencyName} free at the last synchronization, ${placed}, ${feeBuffer}`;
};

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
