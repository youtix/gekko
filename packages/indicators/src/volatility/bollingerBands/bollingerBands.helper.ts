/** Adds a close's squared distance from the mean to the sum, as stdev() does. Made once: a closure over the mean is one per candle */
export const addSquare = (sum: number, close: number, mean: number) => sum + Math.pow(close - mean, 2);
