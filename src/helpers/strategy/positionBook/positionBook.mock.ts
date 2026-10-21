import { LoggedLine, playInit } from '@helpers/strategy/positionTracker/positionTracker.mock';
import { CandleBucket } from '@models/event.types';
import { TradingPair } from '@models/utility.types';
import { IndicatorResults, Strategy } from '@strategies/strategy.types';

/** What track logs, through tools.log, on a bucket of BTC/USDT then ETH/USDT: the pairs traded, and the rule of their orders */
export const BTC_ETH_TRADED_INFO: LoggedLine = {
  level: 'info',
  message:
    'Trading BTC/USDT and ETH/USDT: each BUY takes an equal share of the free currency among the pairs not invested, each SELL sells all of its asset',
};

/**
 * The indicator arguments of a hook, as the StrategyManager passes them to a strategy that adds the same indicators on every pair,
 * pair by pair: the results given for each pair, in the order of its addIndicator calls, the pairs in the order given (that of
 * watch.assets). `indicatorArguments({ 'BTC/USDT': [1, 2], 'ETH/USDT': [3, 4] })` is DEMA's dema and sma of BTC/USDT, then of ETH/USDT.
 */
export const indicatorArguments = <T>(resultsByPair: Record<TradingPair, readonly T[]>): IndicatorResults<T>[] =>
  Object.entries(resultsByPair).flatMap(([symbol, results]) => results.map(result => ({ results: result, symbol: symbol as TradingPair })));

/**
 * A bucket holding a flat candle of each pair at the close given (open, high, low and close alike), the pairs in the order given (that
 * of watch.assets), each candle starting at `start`, a real minute, the first of 2024 (UTC) unless given: `flatBucket({ 'BTC/USDT':
 * 110, 'ETH/USDT': 90 })`. Every candle used to start at 0, the epoch, so that a suite could not play buckets one minute after another.
 */
export const flatBucket = (closeByPair: Record<TradingPair, number>, start = Date.UTC(2024, 0, 1)): CandleBucket =>
  new Map(
    Object.entries(closeByPair).map(([pair, close]) => [
      pair as TradingPair,
      { start, open: close, high: close, low: close, close, volume: 1 },
    ]),
  );

/**
 * Plays init as the StrategyManager does, on the first one-minute bucket: a candle of each of `pairs`, in their order (that of
 * watch.assets), with the strategy's parameters (see playInit); returns its addIndicator calls, in order
 */
export const indicatorsAtInit = <T>(strategy: Pick<Strategy<T>, 'init'>, pairs: TradingPair[], strategyParams: T) =>
  playInit(strategy, pairs, strategyParams).indicators;
