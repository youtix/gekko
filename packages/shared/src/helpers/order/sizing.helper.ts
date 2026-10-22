import { BUY_COST_SHARE } from '../../constants/order.const';
import { multiplyPrecise, toSignificantDigits } from '../../utils/math/math.utils';
import { shiftDecimalPoint } from '../../utils/math/round.utils';

/**
 * The currency a BUY of `amount` at `price` may spend: the currency an all-in BUY of that amount is sized from, its cost at that price
 * (worked out in decimal, see multiplyPrecise) and the share DEFAULT_FEE_BUFFER keeps back for the fee. Counted at its cost alone, a
 * BUY would leave the BUYs after it nothing for its fee when the exchange takes it in the currency, as the simulated exchange does,
 * nor for a price above the one it was sized at (a MARKET order executes at the market, a STICKY order follows it up): together they
 * would spend more than is held.
 */
export const getBuyBudget = (amount: number, price: number): number => multiplyPrecise(amount, price) / BUY_COST_SHARE;

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
  toSignificantDigits(multiplyPrecise(currency, BUY_COST_SHARE) / price);

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
