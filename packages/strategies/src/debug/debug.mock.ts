import type { StrategyOrder } from '@gekko/shared/models/advice.types';
import type { CandleBucket } from '@gekko/shared/models/event.types';
import type { TradingPair } from '@gekko/shared/models/utility.types';
import { fakeTools } from '../strategy.mock';
import type { Strategy, Tools } from '../strategy.types';
import { noop } from 'lodash-es';

/**
 * Tools whose parameters are `strategyParams`, for a debug strategy that orders through `tools.createOrder`: the tools given, and those
 * of fakeTools for the others, tools.positions among them, scripted positions of BTC/USDT that such a strategy never reads
 */
export const toolsOf = <T>(strategyParams: T, tools: Pick<Tools<T>, 'createOrder'> & Partial<Tools<T>>): Tools<T> => ({
  ...fakeTools(strategyParams).tools,
  ...tools,
});

/**
 * Plays `count` timeframe candles of `pairs`, after the warmup, through the strategy with `tools`, and calls `afterCandle` after each.
 * `orders` records the orders the strategy asks for: an OrderRecorder for those it creates through tools.createOrder, the
 * ScriptedPositions of tools.positions for those it places through it. Returns what each candle ordered, separated by spaces: the side
 * of each order asked, S or B, or '.' for none.
 */
export const playCandles = <T>(
  strategy: Pick<Strategy<T>, 'onTimeframeCandleAfterWarmup'>,
  tools: Tools<T>,
  orders: { readonly advices: readonly Pick<StrategyOrder, 'side'>[] },
  count: number,
  pairs: TradingPair[],
  afterCandle = noop,
): string => {
  const candle: CandleBucket = new Map(pairs.map(pair => [pair, { start: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
  const calendar: string[] = [];
  for (let played = 0; played < count; played++) {
    const created = orders.advices.length;
    strategy.onTimeframeCandleAfterWarmup?.({ candle, portfolio: new Map(), tools });
    const sides = orders.advices.slice(created).map(({ side }) => side[0]);
    calendar.push(sides.join('') || '.');
    afterCandle();
  }
  return calendar.join(' ');
};
