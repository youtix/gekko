import { OrderOutOfRangeError } from '@errors/orderOutOfRange.error';
import { Tag } from '@models/tag.types';
import { MarketData, MarketValidationResult } from '@services/exchange/exchange.types';
import { multiplyPrecise } from '@utils/math/math.utils';
import { isNil, max, min } from 'lodash-es';

/** What an order is checked on: its price, its amount, then its cost, the two multiplied */
type OrderValue = 'price' | 'amount' | 'cost';

/** A value refused: which one, its value as checked, and the bounds of the market for it, as toBound reads them */
type Refusal = { isValid: false; reason: OrderValue; value: number; min?: number; max?: number };

/** NaN, ±Infinity, zero and negative numbers are never a valid order price, amount or cost, whatever the market limits */
const isFinitePositive = (value?: number): value is number => value !== undefined && Number.isFinite(value) && value > 0;

/**
 * A market limit that is not a finite number above 0 sets no bound. Binance disables a filter bound by setting it to 0, and ccxt
 * copies the PRICE_FILTER maxPrice of 0 into limits.price.max, where it would refuse every price. A minimum of 0 or below bounds
 * nothing anyway, since the value itself must be above 0. The refusals report these normalized bounds.
 */
const toBound = (limit?: number) => (isFinitePositive(limit) ? limit : undefined);

/** Checks that a value is a finite number above 0, within the range of the market for it */
const checkWithinRange = (
  reason: OrderValue,
  value: number,
  range?: { min?: number; max?: number },
): { isValid: true; value: number } | Refusal => {
  const minimum = toBound(range?.min);
  const maximum = toBound(range?.max);
  const isValid = isFinitePositive(value) && !(minimum !== undefined && value < minimum) && !(maximum !== undefined && value > maximum);
  return isValid ? { isValid: true, value } : { isValid: false, reason, value, min: minimum, max: maximum };
};

/** Checks if the order price is a finite positive number within the market data */
export const checkOrderPrice = (price: number, marketData: MarketData): MarketValidationResult<number> =>
  checkWithinRange('price', price, marketData.price);

/**
 * Checks the price, then the amount, then the cost of an order against the market limits, the cost from the price and the amount
 * validated. The cost is worked out in decimal, as the exchange works it out (see multiplyPrecise). Multiplied in binary, an order
 * costing exactly a bound can come out an ulp past it, and be refused: 0.00007 × 100000 is 6.999999999999999, under a minimum cost of 7,
 * and 31 % of the orders costing exactly 0.0001 BTC, the minimum of Binance's pairs quoted in BTC, come out under it (100 DOGE at
 * 0.000001 BTC is 0.00009999999999999999).
 */
const checkOrder = (
  amount: number,
  price: number,
  marketData: MarketData,
): { isValid: true; amount: number; price: number; cost: number } | Refusal => {
  const priceCheck = checkWithinRange('price', price, marketData.price);
  if (!priceCheck.isValid) return priceCheck;
  const amountCheck = checkWithinRange('amount', amount, marketData.amount);
  if (!amountCheck.isValid) return amountCheck;
  const costCheck = checkWithinRange('cost', multiplyPrecise(amount, price), marketData.cost);
  return costCheck.isValid ? { isValid: true, amount, price, cost: costCheck.value } : costCheck;
};

/**
 * The limits a market order is checked against. Binance applies two lot size filters to a MARKET order: LOT_SIZE, which ccxt maps to
 * limits.amount, and MARKET_LOT_SIZE, mapped to limits.market, whose maximum is far lower on a liquid pair (tens of BTC on BTCUSDT,
 * against 9000). Checked against the amount range alone, an order between the two maxima would be sent, to be refused by Binance with
 * a misleading "order amount should be evenly divisible by lot size" (-1013), and filled by the simulator of paper trading.
 * The amount range is narrowed to the higher of the two minimums and the lower of the two maximums (lodash's max and min skip the
 * bounds left undefined), a bound that is not a finite number above 0 setting nothing, as in toBound: the MARKET_LOT_SIZE minQty of
 * 0 on BTCUSDT. Market data without a market range, a dummy-cex configuration for one, is returned as it is.
 */
export const getMarketOrderLimits = (marketData: MarketData): MarketData => {
  const { amount, market } = marketData;
  if (isNil(market)) return marketData;
  return {
    ...marketData,
    amount: { min: max([toBound(amount?.min), toBound(market.min)]), max: min([toBound(amount?.max), toBound(market.max)]) },
  };
};

/**
 * Checks the price, then the amount, then the cost of an order against the market limits (see checkOrder).
 * Throws an OrderOutOfRangeError for the first invalid value, returns the validated values otherwise, with the cost.
 * The callers round the amount and the price to the steps of the market before they check them, as the exchange is to receive them:
 * given what the order asked for (`requested`), an amount or a price rounded to nothing is refused as asked, with the step that
 * rounded it, rather than as an invalid 0 (0.0000099 BTC on a step of 0.00001).
 */
export const assertOrderWithinLimits = ({
  tag,
  amount,
  price,
  marketData,
  requested,
}: {
  tag: Tag;
  amount: number;
  price: number;
  marketData: MarketData;
  requested?: { amount: number; price: number };
}): { amount: number; price: number; cost: number } => {
  const check = checkOrder(amount, price, marketData);
  if (check.isValid) return { amount: check.amount, price: check.price, cost: check.cost };

  const { reason, value, min: minimum, max: maximum } = check;
  // A cost is never rounded: it is worked out from the price and the amount as they are sent
  const rounding =
    requested && reason !== 'cost' ? { requested: requested[reason], step: toBound(marketData.precision?.[reason]) } : undefined;
  throw new OrderOutOfRangeError(tag, reason, value, minimum, maximum, rounding);
};
