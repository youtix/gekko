import { TradingPair } from '@models/utility.types';

/** Two pairs or more as a line lists them, 'BTC/USDT and ETH/USDT', 'BTC/USDT, ETH/USDT and SOL/USDT', and one pair as it is */
export const listPairs = (pairs: readonly TradingPair[]) =>
  pairs.length > 1 ? `${pairs.slice(0, -1).join(', ')} and ${pairs.at(-1)}` : pairs[0];
