import { OrderSide } from '@models/order.types';
import { BalanceDetail, Portfolio } from '@models/portfolio.types';
import { MarketData } from '@services/exchange/exchange.types';
import { checkOrderPrice, toBound } from '@helpers/market/market.helper';
import { getPriceSignificantDigits, getPriceTick, roundToStep } from '@helpers/market/precision.helper';
import { addPrecise, isFiniteNumber, isFinitePositive, multiplyPrecise, toSignificantDigits } from '@utils/math/math.utils';
import { countDecimals, round } from '@utils/math/round.utils';
import { getAssetBalance } from '@helpers/portfolio/portfolio.helper';
import { minBy } from 'lodash-es';
import { DEFAULT_AMOUNT_PRECISION, DEFAULT_PRICE_PRECISION } from './gridBot.const';
import {
  GridBotStrategyParams,
  GridBounds,
  GridLayout,
  GridResetMode,
  GridSize,
  GridSpacing,
  GridSpacingType,
  OutOfRangeSide,
  RebalancePlan,
} from './gridBot.types';

/** The balances of the traded asset and of its currency, a balance of 0 for either the portfolio lacks (see getAssetBalance) */
export const getPortfolioContent = (
  portfolio: Portfolio,
  base: string,
  quote: string,
): { asset: BalanceDetail; currency: BalanceDetail } => ({
  asset: getAssetBalance(portfolio, base),
  currency: getAssetBalance(portfolio, quote),
});

/**
 * The maker fee of the market, a fraction (0.001 is 0.1 %), which a LIMIT order pays: the grid's orders and the STICKY rebalance's.
 * The simulator of backtests and paper trading charges it in currency, on top of a BUY (DummyCentralizedExchange.getLimitBuyCost) and
 * out of a SELL's proceeds: a BUY of `amount` at `price` needs amount × price × (1 + fee) of free currency, a SELL only its amount of
 * the asset. A live exchange that takes a BUY's fee from the asset bought, as Binance does, leaves what is set aside for it free. A
 * market that states no maker fee is taken to charge none, as the simulator takes it.
 */
export const getMakerFee = (marketData: MarketData): number => marketData.fee?.maker ?? 0;

/**
 * The price the rebalance order, planned at `price`, is placed at: GridBot places it as a STICKY order, which StickyOrder prices one
 * minimum price (price.min) above the bid for a BUY, below the ask for a SELL, the bid and the ask being that price here. Worked out in
 * decimal: added in binary, 101.2 + 0.01 was 101.21000000000001, and 61234.56 - 0.01 was 61234.549999999996.
 */
export const getRebalanceOrderPrice = (side: OrderSide, price: number, marketData: MarketData): number => {
  const minimumPrice = marketData.price?.min ?? 0;
  return addPrecise(price, side === 'BUY' ? minimumPrice : -minimumPrice);
};

/**
 * What a rebalance BUY of `amount`, planned at `price`, takes from the free currency: its STICKY order's price (see
 * getRebalanceOrderPrice), and the maker fee on top (see getMakerFee). Worked out in decimal, as the simulator books it and the
 * exchange charges it, the product rounded to the decimals of its factors, as computeLevelPrice rounds a percent step: exact while it
 * has about 15 significant digits or fewer. In binary, 0.27 at 100.01 cost 27.002700000000004: a sell-only grid holding 27.0027 USDT
 * planned a BUY of 0.27, then left it out for insufficient currency, and stopped for an insufficient portfolio.
 */
export const getRebalanceBuyCost = (amount: number, price: number, marketData: MarketData): number => {
  const orderPrice = getRebalanceOrderPrice('BUY', price, marketData);
  const withFee = addPrecise(1, getMakerFee(marketData));
  return round(amount * orderPrice * withFee, getDecimals(amount) + getDecimals(orderPrice) + getDecimals(withFee));
};

/**
 * The step of numbers rounded to `decimals` decimals, one unit of the last: 1e-8 for 8. The step of the amounts when the market states
 * none (see inferAmountPrecision), and of the prices (see inferPricePrecision)
 */
const getDecimalStep = (decimals: number): number => Number(`1e-${decimals}`);

/**
 * The decimals of a number as String writes it, as round reads them (see countDecimals): 2 for 0.01 and for 0.25, 8 for 1e-8, 0 for 1,
 * for 10, where countDecimals counts -1, and for a number that is not finite. A count of its own, the third in the code, gave a number
 * that is not finite 8 decimals.
 */
const getDecimals = (value: number): number => (Number.isFinite(value) ? Math.max(countDecimals(value), 0) : 0);

/**
 * The smallest amount of an order at `price` that the market takes: one amount step at least, amount.min and cost.min / price,
 * rounded up to the amount step (see inferAmountPrecision). The order layer works the cost out in decimal (see
 * assertOrderWithinLimits): 0.00007 is the minimum for a cost of 7 at 100000, though 0.00007 × 100000 is 6.999999999999999 in binary.
 * The quotient is binary, and can come out an ulp above a whole number of steps, rounded up to a step more than the cost needs:
 * 0.0001 / 0.000001 is 100.00000000000001, 101 DOGE where 100 cost the 0.0001 BTC that Binance takes at least on its pairs quoted in
 * BTC. The step under is taken when its cost is enough.
 */
export const getMinimumAmount = (price: number, marketData: MarketData): number => {
  const step = inferAmountPrecision(marketData);
  // Rounded up as -(the negated value rounded down): roundToStep has no ceiling
  const roundUp = (value: number) => -roundToStep(-value, step, 'down');
  const atLeast = Math.max(step, roundUp(toBound(marketData.amount?.min) ?? 0));
  const minimumCost = toBound(marketData.cost?.min);
  if (!minimumCost || !(price > 0)) return atLeast;
  const minimum = Math.max(atLeast, roundUp(minimumCost / price));
  const less = addPrecise(minimum, -step);
  return less >= atLeast && multiplyPrecise(less, price) >= minimumCost ? less : minimum;
};

/**
 * The largest amount of an order at `price` that the market takes: amount.max and cost.max / price, rounded down to the amount step.
 * Infinity when the market sets neither. The order layer works the cost out in decimal (see assertOrderWithinLimits): 0.00001 is the
 * maximum for a cost of 3 at 300000, though 0.00001 × 300000 is 3.0000000000000004 in binary.
 */
export const getMaximumAmount = (price: number, marketData: MarketData): number => {
  const maximumCost = toBound(marketData.cost?.max);
  const atCost = maximumCost && price > 0 ? maximumCost / price : Infinity;
  const limit = Math.min(toBound(marketData.amount?.max) ?? Infinity, atCost);
  if (!Number.isFinite(limit)) return Infinity;
  return roundAmount(limit, inferAmountPrecision(marketData));
};

/**
 * The precision of the market's prices: its tick (precision.price) and the decimals of that tick. A market that states no tick has its
 * prices rounded to DEFAULT_PRICE_PRECISION decimals, without a step, which the strategy warns of. The decimals used to be read from
 * the close then: a close of 100 put the prices of a grid spaced by 0.5 % at whole units, 99, 99, 100, 100, 101 and 101.
 * With the significant digits of a market whose tick depends on the price (precision.priceSignificantDigits, Hyperliquid's), which
 * roundPrice rounds each price with.
 */
export const inferPricePrecision = (
  marketData: MarketData,
): { priceDecimals: number; priceStep?: number; priceSignificantDigits?: number } => {
  const priceStep = toBound(marketData.precision?.price);
  const priceSignificantDigits = getPriceSignificantDigits(marketData.precision);
  const precision = priceStep ? { priceDecimals: getDecimals(priceStep), priceStep } : { priceDecimals: DEFAULT_PRICE_PRECISION };
  return priceSignificantDigits ? { ...precision, priceSignificantDigits } : precision;
};

/**
 * The step of the market's amounts (precision.amount), which the amounts are rounded down to, as the exchange truncates them (see
 * roundAmount): one unit of the DEFAULT_AMOUNT_PRECISION-th decimal for a market that states no step. The amounts were rounded down to
 * the decimals of the step, and stayed off a step that is not one unit of a decimal: on a step of 10, a quantity of 4705, which the
 * exchange takes as 4700, and a minimum of 5, which it takes as 0.
 */
export const inferAmountPrecision = (marketData: MarketData): number =>
  toBound(marketData.precision?.amount) ?? getDecimalStep(DEFAULT_AMOUNT_PRECISION);

/**
 * Rounds a price to the tick of the market at that price, the nearest multiple, a tie to the one above (see roundToStep): the price
 * step, or one unit of the `priceDecimals`-th decimal without a step. On a market that takes `priceSignificantDigits` significant digits
 * in a price, the tick at that price where it is coarser than the step (see getPriceTick), as the exchange rounds it: rounded to the
 * step alone, as precision.price states it at the price the markets were loaded at, two prices a step apart above the next power of ten
 * were sent at one price, 10000.5 and 10001 both at 10001 on Hyperliquid loaded at 9990, a step of 0.1. The price is rounded as it is
 * written: divided by the step in binary, a tie went the other way, 1.005 to 1 at a step of 0.01, 1.005 / 0.01 being
 * 100.49999999999999. A price at or below 0, which only a grid configured below 0 reaches, is rounded to the step; one that is not a
 * finite number is 0.
 */
export const roundPrice = (value: number, priceDecimals: number, priceStep?: number, priceSignificantDigits?: number): number => {
  if (!Number.isFinite(value)) return 0;
  const step = toBound(priceStep) ?? getDecimalStep(priceDecimals);
  return roundToStep(value, getPriceTick(value, { price: step, priceSignificantDigits }), 'up');
};

/** Rounds an amount down to the amount step (see inferAmountPrecision and roundToStep): 0 for one that is not a finite number above 0 */
export const roundAmount = (value: number, amountStep: number): number =>
  isFinitePositive(value) ? roundToStep(value, amountStep, 'down') : 0;

/**
 * Compute the price of the grid `levelIndex` steps away from the center price, based on spacing type: steps × spacingValue away for
 * fixed spacing, steps × spacingValue % of the center price away for percent spacing, arithmetic as fixed spacing is, and multiplied
 * or divided by (1 + spacingValue) once a step for logarithmic spacing, the one whose prices are a constant ratio apart.
 * @param centerPrice - The center price of the grid
 * @param levelIndex - Steps from the center price: negative below it, positive above, 0 for the center price itself
 * @param priceDecimals - Number of decimal places for rounding
 * @param spacingType - Type of spacing calculation
 * @param spacingValue - Spacing parameter value
 * @param priceStep - Optional price step for tick rounding
 * @param priceSignificantDigits - Optional significant digits of a market whose tick depends on the price (see roundPrice)
 */
export const computeLevelPrice = (
  centerPrice: number,
  levelIndex: number,
  priceDecimals: number,
  spacingType: GridSpacingType,
  spacingValue: number,
  priceStep?: number,
  priceSignificantDigits?: number,
): number => {
  if (levelIndex === 0) return centerPrice;

  const steps = Math.abs(levelIndex);
  const direction = levelIndex > 0 ? 1 : -1;
  let price: number;

  // A fixed or percent price is computed in decimal, for roundPrice to round the price as it is written. Computed in binary, 100.1 +
  // 0.005 was 100.10499999999999 and 61235 × 1.005 was 61541.174999999996, rounded to 100.1 and 61541.17 where 100.105 and 61541.175
  // round to 100.11 and 61541.18. Each product is rounded to the decimals its exact value has at most, those of its factors and 2
  // more for a percent, then added in decimal.
  switch (spacingType) {
    case 'fixed':
      price = addPrecise(centerPrice, direction * round(spacingValue * steps, getDecimals(spacingValue)));
      break;
    case 'percent': {
      const decimals = getDecimals(centerPrice) + getDecimals(spacingValue) + 2;
      price = addPrecise(centerPrice, direction * round((centerPrice * spacingValue * steps) / 100, decimals));
      break;
    }
    // In binary: a power of the multiplier soon has more decimals than a number holds, and a division by it has no end of them
    case 'logarithmic': {
      const multiplier = 1 + spacingValue;
      if (multiplier <= 0) return 0;
      price = direction > 0 ? centerPrice * multiplier ** steps : centerPrice / multiplier ** steps;
      break;
    }
  }

  return roundPrice(price, priceDecimals, priceStep, priceSignificantDigits);
};

/**
 * The prices of the grid the parameters configure around the center price, rounded as its orders are (see computeLevelPrice): from
 * its lowest BUY to its highest SELL, the center price included. A level trades between two adjacent ones (see LevelState).
 */
export const computeGridPrices = (
  centerPrice: number,
  params: GridLayout,
  priceDecimals: number,
  priceStep?: number,
  priceSignificantDigits?: number,
): number[] => {
  const { buyLevels, sellLevels, spacingType, spacingValue } = params;
  return Array.from({ length: buyLevels + sellLevels + 1 }, (_, i) =>
    computeLevelPrice(centerPrice, i - buyLevels, priceDecimals, spacingType, spacingValue, priceStep, priceSignificantDigits),
  );
};

/**
 * Compute grid bounds (min and max prices) for the given configuration.
 */
export const computeGridBounds = (
  centerPrice: number,
  buyLevels: number,
  sellLevels: number,
  priceDecimals: number,
  spacingType: GridSpacingType,
  spacingValue: number,
  priceStep?: number,
  priceSignificantDigits?: number,
): GridBounds | null => {
  if (buyLevels <= 0 && sellLevels <= 0) return null;

  const priceAt = (steps: number) =>
    computeLevelPrice(centerPrice, steps, priceDecimals, spacingType, spacingValue, priceStep, priceSignificantDigits);
  const min = buyLevels > 0 ? priceAt(-buyLevels) : centerPrice;
  const max = sellLevels > 0 ? priceAt(sellLevels) : centerPrice;

  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return null;

  return { min, max };
};

/**
 * The side of the grid a price is out on, below its lowest price or above its highest, null in range, the bounds included. Out on a
 * side, the price stays out on it until it is back at the grid's price next to that bound, `reentryPrices[side]`, where the grid trades
 * again once its orders beyond the bound have filled: counted back at the bound itself, a price hovering on it would be out and back
 * in at every other candle.
 */
export const getOutOfRangeSide = (
  price: number,
  bounds: GridBounds,
  reentryPrices: Record<OutOfRangeSide, number>,
  previous: OutOfRangeSide | null,
): OutOfRangeSide | null => {
  if (price < bounds.min) return 'below';
  if (price > bounds.max) return 'above';
  if (previous === 'below' && price < reentryPrices.below) return 'below';
  if (previous === 'above' && price > reentryPrices.above) return 'above';
  return null;
};

/** Whether `resetMode` arms a reset of the grid on `side`: 'both' on either, 'up' above the grid, 'down' below it, 'none' never */
export const isResetSide = (resetMode: GridResetMode, side: OutOfRangeSide): boolean =>
  resetMode === 'both' || (resetMode === 'up' && side === 'above') || (resetMode === 'down' && side === 'below');

/**
 * How a message names a spacing: `spacingValue 1 (percent)`, the parameters as the configuration gives them, or the description the
 * spacing carries, an atr step naming the step and what it was resolved from (see resolveSpacing)
 */
export const describeSpacing = ({ spacingType, spacingValue, description }: GridSpacing): string =>
  description ?? `spacingValue ${spacingValue} (${spacingType})`;

/**
 * Validate grid configuration against the center price, its lowest BUY included (see checkLowestBuyPrice), the exchange limits and
 * the price tick. The parameters themselves were checked by the schema (gridBot.schema.ts) before the strategy was created.
 * Returns an error message if invalid, null if valid.
 */
export const validateConfig = (params: GridLayout, centerPrice: number, marketData: MarketData): string | null => {
  if (centerPrice <= 0) return 'Center price must be positive';

  const { priceDecimals, priceStep, priceSignificantDigits } = inferPricePrecision(marketData);

  const lowestBuyError = checkLowestBuyPrice(params, centerPrice, priceDecimals, priceStep, priceSignificantDigits);
  if (lowestBuyError) return lowestBuyError;

  // Against the exchange price limits, read as the order layer reads them for every order (see checkOrderPrice)
  const priceLimits = checkOrderPrice(centerPrice, marketData);
  if (!priceLimits.isValid) {
    const { min, max } = priceLimits;
    if (min !== undefined && centerPrice < min) return `Center price ${centerPrice} is below exchange minimum ${min}`;
    return `Center price ${centerPrice} is above exchange maximum ${max}`;
  }

  // Last, so that a configuration refused before keeps its message
  return checkPriceTick(params, centerPrice, priceDecimals, priceStep, priceSignificantDigits);
};

/**
 * Checks the lowest BUY of the grid the parameters configure around the center price, rounded as its order is (see
 * computeLevelPrice). The strategy refuses a grid whose lowest BUY is at or below 0 when it starts (see validateConfig), and again
 * around the price a rebalance ended at, where the grid is planned again or built. Only the start's center price used to be checked:
 * a fixed grid started with its lowest BUY a few ticks above 0, then rebalanced lower, was built without that level, with a warning
 * that blamed the free balances, or planned again without it, without a word. Percent and logarithmic BUYs, which scale with the
 * price, reach 0 only once rounded to the tick, after a far larger fall.
 * Returns an error message when the lowest BUY is at or below 0, null otherwise.
 */
export const checkLowestBuyPrice = (
  params: Omit<GridLayout, 'sellLevels'>,
  centerPrice: number,
  priceDecimals: number,
  priceStep?: number,
  priceSignificantDigits?: number,
): string | null => {
  const { buyLevels, spacingType, spacingValue } = params;
  if (buyLevels <= 0) return null;
  const lowestBuyPrice = computeLevelPrice(
    centerPrice,
    -buyLevels,
    priceDecimals,
    spacingType,
    spacingValue,
    priceStep,
    priceSignificantDigits,
  );
  if (lowestBuyPrice > 0) return null;
  return `Grid configuration would result in non-positive buy prices: the lowest of buyLevels ${buyLevels}, spaced by ${describeSpacing(params)} below the center price ${centerPrice}, would be at ${lowestBuyPrice}`;
};

/**
 * Checks the prices of a grid against the price tick. Two adjacent ones that round to the same tick make a level that buys and sells at
 * that one price: two fees a round trip for nothing, and live, its SELL can meet a BUY of the grid at that price, which self-trade
 * prevention expires. A spacing under the tick used to be accepted: percent 0.001 at 100 put every price of a 3/3 grid at 100.
 * On a market whose tick depends on the price (see roundPrice), the prices are those its rule rounds, and the message names the rule
 * where its tick, coarser than the step, merged them: a step of 0.1 kept 10000.5 and 10001 apart, which Hyperliquid takes as 10001 both.
 * Returns an error message when two adjacent prices of the grid round to the same tick, null otherwise.
 */
export const checkPriceTick = (
  params: GridLayout,
  centerPrice: number,
  priceDecimals: number,
  priceStep?: number,
  priceSignificantDigits?: number,
): string | null => {
  const prices = computeGridPrices(centerPrice, params, priceDecimals, priceStep, priceSignificantDigits);
  const collision = prices.findIndex((price, i) => i > 0 && price <= prices[i - 1]);
  if (collision <= 0) return null;

  const spaced = `spaced by ${describeSpacing(params)} around the center price ${centerPrice}`;
  const step = priceStep ?? getDecimalStep(priceDecimals);
  const tick = getPriceTick(prices[collision], { price: step, priceSignificantDigits }) ?? step;
  const rule = `the market taking ${priceSignificantDigits} significant digits in a price (precision.priceSignificantDigits)`;
  const tickNamed = tick > step ? `${tick}, ${rule}` : step;
  return `Grid configuration would result in a level buying and selling at the same price: ${spaced}, two adjacent prices of the grid would both round to ${prices[collision]} at the price tick ${tickNamed}`;
};

/**
 * A ratio as a percentage of four significant digits, for a message: 0.00016655 as 0.01666 %. With three, the round trip of a maker fee
 * of 0.04 %, 0.08003 %, read 0.08 %, and a warning of percent spacing 0.08 read as if 0.08 were under 0.08.
 */
const toPercent = (ratio: number): string => `${Number((ratio * 100).toPrecision(4))} %`;

/**
 * Checks the spacing against the round-trip fee. The round trip of a level, a BUY at its lower price then a SELL at its upper one,
 * pays the maker fee on both (see getMakerFee): it loses money when sellPrice × (1 - fee) < buyPrice × (1 + fee), a SELL less than
 * 2 × fee / (1 - fee) above its BUY. Such a grid is a bad one, not an impossible one as a grid with two prices at one tick is (see
 * checkPriceTick): it is warned of, not refused.
 * Returns a warning message when a level of the grid the parameters configure loses money at each round trip, null otherwise.
 */
export const checkRoundTripFee = (params: GridLayout, centerPrice: number, marketData: MarketData): string | null => {
  const fee = getMakerFee(marketData);
  const { priceDecimals, priceStep, priceSignificantDigits } = inferPricePrecision(marketData);
  const prices = computeGridPrices(centerPrice, params, priceDecimals, priceStep, priceSignificantDigits);
  const levels = prices.slice(1).map((sellPrice, i) => ({ buyPrice: prices[i], sellPrice }));
  // A spacing under the round-trip fee used to be accepted without a word: at a maker fee of 0.0004, fixed 10 at 60000, 0.0167 % a
  // level, lost 0.038 USDT at each round trip of 0.001 BTC, and the more the grid traded, the more it lost
  const losing = levels.filter(({ buyPrice, sellPrice }) => sellPrice * (1 - fee) < buyPrice * (1 + fee));
  const narrowest = minBy(losing, ({ buyPrice, sellPrice }) => sellPrice / buyPrice);
  if (!narrowest) return null;

  const { buyPrice, sellPrice } = narrowest;
  const levelsUnder = `a level that sells less than ${toPercent((2 * fee) / (1 - fee))} above its buy`;
  const paying = `paying the maker fee of ${fee} (fee.maker) on its BUY and on its SELL`;
  const count = `${losing.length} out of ${levels.length} here`;
  const example = `the narrowest selling at ${sellPrice}, ${toPercent(sellPrice / buyPrice - 1)} above its buy at ${buyPrice}`;
  return `${describeSpacing(params)} is under the round-trip fee: ${levelsUnder}, ${paying}, loses money at each round trip, ${count}, ${example}`;
};

/**
 * The tick of the market at `price` (see getPriceTick): precision.price, or one unit of the DEFAULT_PRICE_PRECISION-th decimal on a
 * market that states none (see inferPricePrecision), or on a market whose tick depends on the price the coarser tick at that price
 */
const getTickAt = (price: number, marketData: MarketData): number => {
  const { priceDecimals, priceStep, priceSignificantDigits } = inferPricePrecision(marketData);
  const step = priceStep ?? getDecimalStep(priceDecimals);
  return getPriceTick(price, { price: step, priceSignificantDigits }) ?? step;
};

/**
 * How far the level of a fixed grid that comes the nearest to losing money at each round trip falls short of breaking even on the maker
 * fee (see getMakerFee), on a unit of its quantity: buyPrice × (1 + fee) − sellPrice × (1 − fee), the products checkRoundTripFee
 * compares, above 0 for a level it finds losing, at or below 0 when every level breaks even. The grid of `sellLevels` sell levels spaced
 * by `step` around `centerPrice`, its prices rounded as its orders are (see computeGridPrices): its buy levels are left out, as they earn
 * more for the step than its highest level (see getMinimumStep), but for the one next to the center price of a grid without a sell
 * level. With the highest price of the grid, whose tick the step is raised by.
 */
const getBreakEvenShortfall = (
  centerPrice: number,
  sellLevels: number,
  step: number,
  marketData: MarketData,
): { shortfall: number; highestPrice: number } => {
  const fee = getMakerFee(marketData);
  const { priceDecimals, priceStep, priceSignificantDigits } = inferPricePrecision(marketData);
  const grid: GridLayout = { buyLevels: sellLevels > 0 ? 0 : 1, sellLevels, spacingType: 'fixed', spacingValue: step };
  const prices = computeGridPrices(centerPrice, grid, priceDecimals, priceStep, priceSignificantDigits);
  const shortfall = prices
    .slice(1)
    .reduce((largest, sellPrice, i) => Math.max(largest, prices[i] * (1 + fee) - sellPrice * (1 - fee)), -Infinity);
  return { shortfall, highestPrice: prices[prices.length - 1] };
};

/**
 * The smallest fixed step at which every level of a grid of `sellLevels` sell levels around `centerPrice` breaks even on the maker fee
 * (see getMakerFee): a level loses money when it sells less than r = 2 × fee / (1 − fee) above its buy (see checkRoundTripFee), and at a
 * fixed step the highest level, whose buy price is the largest, earns the least for it. That level buys at centerPrice + (sellLevels − 1)
 * × step, or at centerPrice − step without a sell level, so step ≥ centerPrice × r / (1 − (sellLevels − 1) × r), or centerPrice × r /
 * (1 + r): 121.09 for 5 sell levels at 60000 on a maker fee of 0.1 % and a tick of 0.01, 119.89 without a sell level. Rounded up to the
 * tick of the market at the center price, and one tick at least, the step of a market without a fee: a step under a tick rounds two
 * adjacent prices to one (see checkPriceTick). One tick too for a grid of so many sell levels that no step breaks even ((sellLevels − 1)
 * × r at 1 or more, from 501 sell levels at 0.1 %), which checkRoundTripFee warns of as for any grid. The step is then checked on the
 * prices of the grid as its orders are placed, as checkRoundTripFee checks them, and raised to the next whole number of the tick at the
 * highest price of the grid until every level breaks even there: a level exactly at its break-even can read as a loss in binary (3.3 for
 * a sell level around 4123.35 at 0.04 %, raised to 3.31), and on a market whose tick depends on the price, the prices above the next
 * power of ten are rounded to a coarser tick, which the step is then a whole number of (9 for 2 sell levels around 9999 on 5 significant
 * digits, a tick of 1 from 10000 on, where 8.1 lost money). An atr spacing is raised to it (see resolveSpacing).
 */
export const getMinimumStep = (centerPrice: number, sellLevels: number, marketData: MarketData): number => {
  const tick = getTickAt(centerPrice, marketData);
  const fee = getMakerFee(marketData);
  const ratio = (2 * fee) / (1 - fee);
  const divisor = sellLevels > 0 ? 1 - (sellLevels - 1) * ratio : 1 + ratio;
  // Without a fee every step breaks even, at a divisor at or below 0 none does, and a center price that is not a number above 0 makes no
  // grid: one tick
  if (!isFinitePositive(centerPrice) || !isFinitePositive(ratio) || !(divisor > 0)) return tick;

  // Rounded up as -(the negated value rounded down): roundToStep has no ceiling (see getMinimumAmount)
  let step = Math.max(tick, -roundToStep(-toSignificantDigits((centerPrice * ratio) / divisor), tick, 'down'));
  // Worked out on the prices as they are spaced, while each order is placed at its price rounded to the tick there (see
  // computeLevelPrice), coarser above the next power of ten on a market whose tick depends on the price: 8.1 around 9999 on 5
  // significant digits put the highest SELL of 2 at 10015, 8 above its BUY at 10007 (10015.2 and 10007.1 on the tick of 1 from 10000
  // on), under the fee of 0.04 %, warned of by checkRoundTripFee right after this step was said to break even. Raised to whole numbers of
  // that tick, which space the prices above that power of ten evenly, until no level loses money as checkRoundTripFee reckons it.
  let { shortfall, highestPrice } = getBreakEvenShortfall(centerPrice, sellLevels, step, marketData);
  while (shortfall > 0) {
    const coarseTick = getTickAt(highestPrice, marketData);
    const raised = addPrecise(roundToStep(step, coarseTick, 'down'), coarseTick);
    // A center price near the largest number puts the prices of the grid beyond it, and the step no longer grows: left as it is
    if (!(raised > step)) break;
    step = raised;
    ({ shortfall, highestPrice } = getBreakEvenShortfall(centerPrice, sellLevels, step, marketData));
  }
  return step;
};

/**
 * The spacing the grid is built with around `centerPrice` (see GridSpacing): the configured one as it is, or for atr spacing the fixed
 * step of spacingValue × `atr`, the ATR of the pair on the last timeframe candle, rounded to the tick of the market at the center price
 * (the nearest, a tie upwards, as the prices are: see roundPrice), and raised to the minimum step when it is under it (see
 * getMinimumStep), the warning saying so: a lull in the volatility would otherwise space the grid under the round-trip fee, its levels
 * losing money at each round trip, or under the tick, which stops the run where the grid is checked (see checkPriceTick). An `atr` that
 * is not a finite number counts as 0. The description names the step and what it was resolved from, for the messages of the checks
 * (see describeSpacing).
 */
export const resolveSpacing = (
  params: Pick<GridBotStrategyParams, 'sellLevels' | 'spacingType' | 'spacingValue'>,
  centerPrice: number,
  marketData: MarketData,
  atr?: number | null,
): { spacing: GridSpacing; warning?: string } => {
  const { sellLevels, spacingType, spacingValue } = params;
  if (spacingType !== 'atr') return { spacing: { spacingType, spacingValue } };

  const tick = getTickAt(centerPrice, marketData);
  const atrValue = isFiniteNumber(atr) ? atr : 0;
  const atrStep = roundToStep(toSignificantDigits(spacingValue * atrValue), tick, 'up');
  const origin = `spacingValue ${spacingValue} × ATR ${Number(atrValue.toPrecision(6))}`;
  const minimumStep = getMinimumStep(centerPrice, sellLevels, marketData);
  if (atrStep >= minimumStep) {
    return { spacing: { spacingType: 'fixed', spacingValue: atrStep, description: `a step of ${atrStep} (${origin}, atr)` } };
  }

  const fee = getMakerFee(marketData);
  const breakEven = `the minimum step at which every level of the grid breaks even on the maker fee of ${fee} (fee.maker)`;
  const under =
    fee > 0
      ? `under ${minimumStep}, ${breakEven}: the grid is spaced by ${minimumStep} instead`
      : `under the price tick: the grid is spaced by one tick, ${tick}, instead`;
  return {
    spacing: {
      spacingType: 'fixed',
      spacingValue: minimumStep,
      description: `a step of ${minimumStep} (the minimum step, ${origin} giving ${atrStep}, atr)`,
    },
    warning: `ATR spacing: ${origin} is a step of ${atrStep} on the price tick ${tick}, ${under}`,
  };
};

/**
 * The sums of the BUY prices of the grid from the center price down, one more level each, the first 0 for none: as far as the prices
 * are positive. The strategy plans and builds no grid with a BUY at or below 0 (see checkLowestBuyPrice), so it never reaches one.
 * Added with `add`: in binary, as the rebalance splits the value (see getGridFunding), or in decimal, as a quantity's need is checked
 * against the free currency (see deriveLevelQuantity).
 */
const getBuyPriceSums = (
  priceAt: (steps: number) => number,
  buyLevels: number,
  add: (sum: number, price: number) => number = (sum, price) => sum + price,
): number[] => {
  const buyPriceSums = [0];
  for (let i = 1; i <= buyLevels; i++) {
    const price = priceAt(-i);
    if (price <= 0) break;
    buyPriceSums.push(add(buyPriceSums[i - 1], price));
  }
  return buyPriceSums;
};

/**
 * What the grid the parameters configure takes on each side for one unit of the quantity every level trades, around the center
 * price: a unit of the asset for each sell level, and the price of each buy level in currency, the maker fee on top (see getMakerFee).
 * The grid the free balances fund is sized on these (see deriveLevelQuantity), and the rebalance aims at them (see
 * computeRebalancePlan).
 */
export const getGridFunding = (centerPrice: number, params: GridLayout, marketData: MarketData): { asset: number; currency: number } => {
  const { buyLevels, sellLevels, spacingType, spacingValue } = params;
  const { priceDecimals, priceStep, priceSignificantDigits } = inferPricePrecision(marketData);
  const priceAt = (steps: number) =>
    computeLevelPrice(centerPrice, steps, priceDecimals, spacingType, spacingValue, priceStep, priceSignificantDigits);
  const buyPriceSum = getBuyPriceSums(priceAt, buyLevels).at(-1)!;
  return { asset: Math.max(sellLevels, 0), currency: buyPriceSum * (1 + getMakerFee(marketData)) };
};

/**
 * The largest amount on the amount step whose need, worked out in decimal by `needOf`, is at most `free`. `estimate` is the binary
 * quotient of `free` by the need of a unit, which can fall an ulp either side of a whole number of steps where `free` funds exactly that
 * many: rounded down as it was, 7.0007 USDT for a BUY at 100.01 was 0.06999999999999999, 0.06 where 0.07 costs 7.0007, and 0.3 BTC
 * over three SELLs 0.09999999999999999, 0.09 a SELL. So one step more or less is taken, as the need says.
 */
const getFundedAmount = (estimate: number, free: number, needOf: (amount: number) => number, step: number): number => {
  const amount = roundAmount(estimate, step);
  const more = addPrecise(amount, step);
  if (needOf(more) <= free) return more;
  return amount > 0 && needOf(amount) > free ? addPrecise(amount, -step) : amount;
};

/**
 * The amount of a rebalance BUY planned at `price` that `currency` pays: the largest on the amount step whose cost, worked out in
 * decimal (see getRebalanceBuyCost), is at most `currency` (see getFundedAmount), from `estimate`, the binary quotient of the currency
 * by the cost of a unit
 */
const getRebalanceBuyAmount = (estimate: number, currency: number, price: number, marketData: MarketData): number =>
  getFundedAmount(estimate, currency, amount => getRebalanceBuyCost(amount, price, marketData), inferAmountPrecision(marketData));

/**
 * Plans the rebalance after which the balances given, the free ones the grid is sized on, fund every level of the grid with the same
 * quantity: the split of getGridFunding, reached once the rebalance's STICKY order has traded at its own price, paying its fee (see
 * getRebalanceOrderPrice and getMakerFee). A portfolio on which the grid would leave less than 1 % of the value idle, what it holds of
 * one side beyond what the other side funds, is not rebalanced.
 * An order is at most the market's maximum (see getMaximumAmount). An amount under the market's minimum is left as it is (see
 * getMinimumAmount), for the strategy not to send it.
 * Returns null if the portfolio needs no rebalance.
 */
export const computeRebalancePlan = (
  centerPrice: number,
  assetFree: number,
  currencyFree: number,
  params: GridLayout,
  marketData: MarketData,
): RebalancePlan | null => {
  if (centerPrice <= 0) return null;
  const totalValue = assetFree * centerPrice + currencyFree;
  if (totalValue <= 0) return null;

  // The rebalance used to aim at sellLevels / (buyLevels + sellLevels) of the value in the asset, 50/50 for a symmetric grid. The
  // BUYs, below the center price, cost less than the SELLs are worth, and the grid is sized on the scarcer side: from 3 % of the
  // currency for 5/5 levels spaced by 1 % to 21 % for 20/20 spaced by 2 % stayed idle for the whole run.
  const funding = getGridFunding(centerPrice, params, marketData);
  // Above 0, the currency funds more of the quantity than the asset does: currency / funding.currency > asset / funding.asset
  const imbalance = funding.asset * currencyFree - funding.currency * assetFree;
  if (imbalance === 0) return null;
  const side: OrderSide = imbalance > 0 ? 'BUY' : 'SELL';

  // What the grid would leave idle on the portfolio as it is: the currency its BUYs do not need, or the asset its SELLs do not.
  // Measured on the amount the rebalance trades, as it used to be, the 1 % tolerance let a lopsided grid idle many times more: 5 %
  // of the value on 9/1 levels, for a BUY of 0.5 %.
  const idleValue = side === 'BUY' ? imbalance / funding.asset : (-imbalance / funding.currency) * centerPrice;
  if (idleValue < 0.01 * totalValue) return null;

  // The quantity both sides fund once the rebalance has traded at the price of its STICKY order, paying its fee, and the amount that
  // takes. A BUY is reckoned on the currency it spends and a SELL on the asset it sells, so that a sell-only grid buys all the currency
  // pays and no more (see getRebalanceBuyAmount), and a buy-only grid sells its whole asset, not a step less. A sell-only grid's BUY
  // of the whole currency at the center price used to be refused at every attempt, its order placed one minimum price above the bid
  // and the fee on top, and the run stopped before any grid was built.
  const sellProceeds = getRebalanceOrderPrice('SELL', centerPrice, marketData) * (1 - getMakerFee(marketData));
  const unitValue = side === 'BUY' ? getRebalanceBuyCost(1, centerPrice, marketData) : sellProceeds;
  const quantity = (currencyFree + assetFree * unitValue) / (funding.currency + funding.asset * unitValue);
  // What the BUY may spend: the currency the grid's BUYs leave
  const spendable = currencyFree - funding.currency * quantity;
  const gap = side === 'BUY' ? spendable / unitValue : assetFree - funding.asset * quantity;

  // Rounded down to the amount step, at most the market's maximum. An amount under amount.min used to be raised to it, beyond what the
  // gap called for and what the balances paid: a rebalance under the market's minimum is no order to send
  const orderPrice = getRebalanceOrderPrice(side, centerPrice, marketData);
  const rounded =
    side === 'BUY' ? getRebalanceBuyAmount(gap, spendable, centerPrice, marketData) : roundAmount(gap, inferAmountPrecision(marketData));
  const amount = Math.min(rounded, getMaximumAmount(orderPrice, marketData));

  if (amount <= 0) return null;

  return {
    side,
    amount,
    estimatedNotional: amount * centerPrice,
    centerPrice,
  };
};

/**
 * Sizes the grid on the free balances: the quantity every order of the grid trades, and the levels it funds, the nearest to the
 * center price. Every order is placed at or above the lowest price of the grid, so a quantity of at least the market's minimum there
 * (see getMinimumAmount) is one the market takes for every order. A side whose free balance cannot fund each of its levels with that
 * minimum keeps the levels it funds and leaves out the farthest: none at all for a side that funds no level.
 * - A SELL needs its amount of the asset: the sell levels share the free asset.
 * - A BUY needs its cost with the maker fee on top (see getMakerFee): the buy levels share the free currency in proportion to their
 *   prices. Sized on the prices alone, the BUYs needed the whole free currency before their fees: the simulator refused the last one
 *   placed, the highest, at every attempt.
 * Each share is the largest amount on the amount step that its free balance funds, its need worked out in decimal (see
 * getFundedAmount). The quantity is the smaller of the two, at most the market's maximum at the highest price of the grid (see
 * getMaximumAmount): 0, with no level, when the free balances fund none. What the larger share holds beyond it stays idle, which the
 * rebalance avoids (see computeRebalancePlan).
 */
export const deriveLevelQuantity = (
  centerPrice: number,
  assetFree: number,
  currencyFree: number,
  buyLevels: number,
  sellLevels: number,
  priceDecimals: number,
  spacingType: GridSpacingType,
  spacingValue: number,
  marketData: MarketData,
  priceStep?: number,
  priceSignificantDigits?: number,
): GridSize => {
  const priceAt = (steps: number) =>
    computeLevelPrice(centerPrice, steps, priceDecimals, spacingType, spacingValue, priceStep, priceSignificantDigits);
  const step = inferAmountPrecision(marketData);

  // What a unit of the quantity needs on `levels` levels, in decimal: of the currency, the BUY prices with the maker fee on top, of the
  // asset, one unit a SELL. Divided in binary and rounded down, a share fell a step short of what the free balance funds exactly
  const buyPriceSums = getBuyPriceSums(priceAt, buyLevels, addPrecise);
  const withFee = addPrecise(1, getMakerFee(marketData));
  const currencyShare = (levels: number) => {
    if (levels <= 0) return Infinity;
    const unitCost = multiplyPrecise(buyPriceSums[levels], withFee);
    return getFundedAmount(currencyFree / unitCost, currencyFree, amount => multiplyPrecise(amount, unitCost), step);
  };
  const assetShare = (levels: number) =>
    levels > 0 ? getFundedAmount(assetFree / levels, assetFree, amount => multiplyPrecise(amount, levels), step) : Infinity;
  // The market minimum at the lowest price of a grid of `levels` buy levels: its lowest BUY, or without any the center price, where
  // the first sell level buys once it has sold
  const minimumAt = (levels: number) => getMinimumAmount(levels > 0 ? priceAt(-levels) : centerPrice, marketData);

  // The quantity used to be raised to amount.min, or to cost.min at the lowest price, beyond what the balances funded, and left
  // unrounded: the last orders placed were refused for want of funds, and CCXTExchange truncated the others to the amount step,
  // under cost.min again, so that a small account had most of its levels refused at every attempt
  let fundedBuyLevels = buyPriceSums.length - 1;
  while (fundedBuyLevels > 0 && currencyShare(fundedBuyLevels) < minimumAt(fundedBuyLevels)) fundedBuyLevels--;
  const minimumAmount = minimumAt(fundedBuyLevels);
  let fundedSellLevels = Math.max(sellLevels, 0);
  while (fundedSellLevels > 0 && assetShare(fundedSellLevels) < minimumAmount) fundedSellLevels--;

  if (fundedBuyLevels === 0 && fundedSellLevels === 0) return { quantity: 0, buyLevels: 0, sellLevels: 0, minimumAmount };

  const share = Math.min(assetShare(fundedSellLevels), currencyShare(fundedBuyLevels));
  // At most the market maximum at the highest price of the grid: its highest SELL, or without any the center price, where the first
  // buy level sells once it has bought
  const quantity = Math.min(share, getMaximumAmount(priceAt(fundedSellLevels), marketData));
  return { quantity, buyLevels: fundedBuyLevels, sellLevels: fundedSellLevels, minimumAmount };
};

/**
 * Check if only one side has active orders (for warning purposes). It reads the side of each level holding an order, which is the
 * side of that order: fills change it.
 */
export const hasOnlyOneSide = (levels: Array<{ side: 'BUY' | 'SELL'; orderId?: string }>): boolean => {
  let hasBuy = false;
  let hasSell = false;

  for (const level of levels) {
    if (!level.orderId) continue;
    if (level.side === 'BUY') hasBuy = true;
    else hasSell = true;
    if (hasBuy && hasSell) return false;
  }

  return hasBuy || hasSell;
};
