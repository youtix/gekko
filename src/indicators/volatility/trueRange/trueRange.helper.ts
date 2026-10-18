import { Candle } from '@models/candle.types';

/**
 * The true range of a candle: the largest of its own range and of its high's and low's distances from the previous close, so that a
 * gap counts. TrueRange and the directional movement both compute it here.
 */
export const getTrueRange = (previous: Candle, candle: Candle): number => {
  const range = candle.high - candle.low;
  const fromHigh = Math.abs(candle.high - previous.close);
  const fromLow = Math.abs(candle.low - previous.close);

  // The comparisons of TA-Lib's TRUE_RANGE, which Math.max would not match on a NaN distance
  let greatest = range;
  if (fromHigh > greatest) greatest = fromHigh;
  if (fromLow > greatest) greatest = fromLow;
  return greatest;
};
