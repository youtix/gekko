import { TradingPair } from '@models/utility.types';
import { IndicatorResults } from './strategy.types';

/**
 * The indicator arguments of a hook grouped by pair: the results of each pair in the order of its addIndicator calls, the pairs in the
 * order of their first indicator. A strategy that adds the same indicators on every pair, pair by pair, reads those of a pair as it
 * read the flat arguments on one pair (`const [dema, sma] = bySymbol.get(pair) ?? []`). Built once per hook call, from the arguments
 * of that call: the results change on every candle.
 */
export const indicatorsBySymbol = <T>(indicators: readonly IndicatorResults<T>[]): Map<TradingPair, IndicatorResults<T>[]> => {
  const bySymbol = new Map<TradingPair, IndicatorResults<T>[]>();
  for (const indicator of indicators) {
    const ofSymbol = bySymbol.get(indicator.symbol);
    if (ofSymbol) ofSymbol.push(indicator);
    else bySymbol.set(indicator.symbol, [indicator]);
  }
  return bySymbol;
};
