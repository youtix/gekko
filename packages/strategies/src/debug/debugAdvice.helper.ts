import { OrderSide } from '@gekko/shared/models/order.types';

/**
 * The side of the advice `elapsed` candles after the first one, or undefined on a candle between two: every `each` candles, a SELL
 * first, then a BUY, and so on. The side used to follow the remainder of the candle index by `each`, with the BUY at `each / 2`,
 * which no remainder equals when `each` is odd: such a strategy only ever sold.
 */
export const getAdviceSide = (elapsed: number, each: number): OrderSide | undefined => {
  if (elapsed % each !== 0) return;
  return (elapsed / each) % 2 === 0 ? 'SELL' : 'BUY';
};
