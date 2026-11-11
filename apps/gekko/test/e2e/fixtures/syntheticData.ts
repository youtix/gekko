import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { Candle } from '@gekko/shared/models/candle.types';

const SYNTHETIC_START_PRICE = 10000;
const SYNTHETIC_VOLUME = 50;

/**
 * The price of a pair at a time: a sine of amplitude 100 around 10,000, about an hour long (2π × 10 minutes), shifted by the char codes
 * of the symbol so that the pairs trade at different prices. It moves by less than 10 in a minute.
 */
export const syntheticPrice = (symbol: string, timestamp: number) => {
  const offset = symbol.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return SYNTHETIC_START_PRICE + Math.sin((timestamp / ONE_MINUTE + offset) / 10) * 100;
};

/**
 * The deterministic candle of a pair for the minute starting at `timestamp`, as an exchange could serve it: it opens at the price of its
 * start and closes halfway to the next minute's open, less than 5 away, so that its high and its low, 5 above and below the open, hold
 * both. It closed at the next minute's open, up to 10 away, outside its high and its low on two candles out of three, and a minute the
 * gap filler made up, flat at the previous close, had the open of the minute it stood for: a check of the opens could not tell them apart.
 */
export const generateSyntheticCandle = (symbol: string, timestamp: number): Candle => {
  const open = syntheticPrice(symbol, timestamp);
  return {
    start: timestamp,
    open,
    high: open + 5,
    low: open - 5,
    close: (open + syntheticPrice(symbol, timestamp + ONE_MINUTE)) / 2,
    volume: SYNTHETIC_VOLUME + Math.cos(timestamp / ONE_MINUTE) * 10,
  };
};
