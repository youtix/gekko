/** Adds a typical price's distance from the mean to the sum, as CCI always has. Made once: a closure over the mean is one per candle */
export const addDeviation = (sum: number, price: number, mean: number) => Math.abs(price - mean) + sum;
