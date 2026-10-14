import type { MarketData } from '@services/exchange/exchange.types';
import { isFinitePositive } from '@utils/math/math.utils';
import { countDecimals, round, shiftDecimalPoint } from '@utils/math/round.utils';

/**
 * value on a multiple of step: the one at or below it ('down'), or the nearest one, a tie to the one above ('up'), as round puts a value
 * on a decimal (see round). Above 0, these are ccxt's decimalToPrecision in the TICK_SIZE mode of Binance and Hyperliquid: an amount
 * truncated to the step of the market (TRUNCATE), a price rounded to its tick (ROUND). Worked out on value as it is written (see round):
 * a binary quotient can fall a hair short of a multiple, 0.29 / 0.01 being 28.999999999999996. ccxt 4.5.39 rounds its remainder to 8
 * decimals before comparing it with half a step, so that it rounds a price up from a hair under the half on a step of 1e-5 to 1e-7
 * (from 0.45 of a step of 1e-7): there the two can be a step apart. A value that is not finite is left as it is, and so is any value
 * without a step that is a finite number above 0.
 * The simulator, GridBot and the PositionTracker each kept a copy, and two of them rounded an amount to the decimals of the step rather
 * than to the step: on a step of 0.5 or of 10, they kept 1.4 and 4705, which the exchange takes as 1 and 4700.
 */
export const roundToStep = (value: number, step: number | undefined, option: 'down' | 'up'): number => {
  if (!Number.isFinite(value) || !isFinitePositive(step)) return value;
  const decimals = countDecimals(step);
  // A step of one unit of its last decimal (0.01, 1e-8, 1), as Binance, Hyperliquid and a dummy-cex configuration state them
  if (shiftDecimalPoint(step, decimals) === 1) return round(value, decimals, option);
  // Any other step (0.05, 0.5, 5): its multiples, and the halfway points between them, are whole numbers of units of the decimal after
  // its last one. Floored to that decimal, value passes none of them, and the multiple is worked out on those integers.
  const places = decimals + 1;
  const scaledValue = shiftDecimalPoint(round(value, places, 'down'), places);
  const scaledStep = shiftDecimalPoint(step, places);
  // Past 2 ** 53 integers are no longer exact (a value of some 9e12 on a step of 0.05): in binary, as near as it gets
  if (!Number.isSafeInteger(scaledValue)) return (option === 'down' ? Math.floor : Math.round)(value / step) * step;
  // What lies above the multiple at or below the value, which % would give as a negative number below 0
  const remainder = ((scaledValue % scaledStep) + scaledStep) % scaledStep;
  const isRoundedUp = option === 'up' && 2 * remainder >= scaledStep;
  return shiftDecimalPoint(scaledValue - remainder + (isRoundedUp ? scaledStep : 0), -places);
};

/**
 * The exponent of the first significant digit of a number above 0 as String writes it: 4 for 61234.56, -3 for 0.0012345, -7 for
 * 1.5e-7. Read from Math.log10, it is one too many a hair under a power of ten: 999.9999999999999 gives 3.
 */
const getFirstDigitExponent = (value: number): number => {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [integer, fraction = ''] = mantissa.split('.');
  return (integer !== '0' ? integer.length - 1 : -(fraction.search(/[1-9]/) + 1)) + Number(exponent);
};

/**
 * The significant digits a price has at most on a market whose tick depends on the price (precision.priceSignificantDigits,
 * Hyperliquid's 5): a whole number above 0, undefined for any other value, which states no such rule
 */
export const getPriceSignificantDigits = (precision?: MarketData['precision']): number | undefined => {
  const digits = precision?.priceSignificantDigits;
  return digits !== undefined && Number.isInteger(digits) && digits > 0 ? digits : undefined;
};

/**
 * The tick of the market at a price: precision.price, or, where a price has at most precision.priceSignificantDigits significant
 * digits (see getPriceSignificantDigits), the coarser of it and one unit of the last of those digits, one unit at most, an integer part
 * of more digits being kept whole (see MarketData.precision.priceSignificantDigits): 1 from 10000 on, where precision.price may say
 * 0.1. precision.price at a price that is not a finite number above 0.
 */
export const getPriceTick = (price: number, precision?: MarketData['precision']): number | undefined => {
  const tick = precision?.price;
  const digits = getPriceSignificantDigits(precision);
  if (!digits || !isFinitePositive(price)) return tick;
  const significantTick = Number(`1e-${Math.max(digits - 1 - getFirstDigitExponent(price), 0)}`);
  return isFinitePositive(tick) ? Math.max(tick, significantTick) : significantTick;
};
