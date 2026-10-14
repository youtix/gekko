import { Tag } from '@models/tag.types';
import { countDecimals } from '@utils/math/round.utils';
import { GekkoError } from './gekko.error';

/** The value an order asked for, before the order layer rounded it to the step of the market, and that step when the market has one */
type Rounding = { requested: number; step?: number };

const isFinitePositive = (value?: number): value is number => value !== undefined && Number.isFinite(value) && value > 0;

/**
 * A number with every decimal String gives it, without an exponent: 0.0000001, which String writes 1e-7. Rounded to eight decimals, as
 * toPlainNumber writes a number, a value could read as the bound it missed: a cost of 0.000099997 BTC as 0.0001, "too low" for a
 * minimum of 0.0001. NaN, ±Infinity and a number of more than 100 decimals are written as String writes them.
 */
const write = (value: number): string => {
  const decimals = countDecimals(value);
  return Number.isFinite(value) && decimals <= 100 ? value.toFixed(Math.max(decimals, 0)) : String(value);
};

/** What the market allows: the range between its two bounds, the one bound it sets, or nothing without any */
const describeBounds = (min?: number, max?: number): string => {
  if (min !== undefined && max !== undefined) return ` Expected a value between ${write(min)} and ${write(max)}.`;
  if (min !== undefined) return ` Minimum allowed is ${write(min)}.`;
  return max !== undefined ? ` Maximum allowed is ${write(max)}.` : '';
};

/** Why the value is refused, and what the market allows */
const describeRefusal = (property: string, current: number, min?: number, max?: number, rounding?: Rounding): string => {
  // Rounded to nothing by the step of the market: reported as 0, an amount of 0.0000099 BTC on a step of 0.00001 would read "value 0 is
  // invalid", what the order asked for, the step and the minimum all unsaid
  if (current === 0 && isFinitePositive(rounding?.requested)) {
    const step = rounding.step !== undefined ? ` ${write(rounding.step)}` : '';
    return `${write(rounding.requested)} rounds to 0 on the ${property} step${step} of the market.${describeBounds(min, max)}`;
  }
  // NaN, ±Infinity, zero or a negative number is refused whatever the limits: "too low"/"too high" would be wrong for it
  if (!isFinitePositive(current)) return `${write(current)} is invalid. Expected a finite number greater than 0.`;
  if (min !== undefined && max !== undefined) return `${write(current)} is out of range.${describeBounds(min, max)}`;
  return `${write(current)} ${min !== undefined ? 'is too low' : 'is too high'}.${describeBounds(min, max)}`;
};

/**
 * An order refused before it is sent, its price, its amount or its cost out of the limits of the market (see assertOrderWithinLimits):
 * `current` is the value checked, rounded to the step of the market as the exchange is to receive it, `min` and `max` the bounds the
 * market sets for it, and `rounding` what the order asked for before that rounding.
 */
export class OrderOutOfRangeError extends GekkoError {
  constructor(tag: Tag, property: string, current: number, min?: number, max?: number, rounding?: Rounding) {
    super(tag, `Order '${property}' with value ${describeRefusal(property, current, min, max, rounding)}`);
    this.name = 'OrderOutOfRangeError';
  }
}
