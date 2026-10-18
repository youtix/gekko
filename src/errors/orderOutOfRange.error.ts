import { Tag } from '@models/tag.types';
import { describeRefusal } from './error.helper';
import { Rounding } from './error.types';
import { GekkoError } from './gekko.error';

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
