import type { OrderRecorder } from '@helpers/strategy/positionTracker/positionTracker.mock';
import type { CandleBucket } from '@models/event.types';
import type { TradingPair } from '@models/utility.types';
import type { Strategy, Tools } from '@strategies/strategy.types';
import { noop } from 'lodash-es';

/** Tools whose parameters are `strategyParams`, ordering through `tools.createOrder`: the other tools do nothing unless given */
export const toolsOf = <T>(strategyParams: T, tools: Pick<Tools<T>, 'createOrder'> & Partial<Tools<T>>): Tools<T> => ({
  strategyParams,
  marketData: new Map(),
  log: noop,
  cancelOrder: noop,
  cancelTrailingOrder: noop,
  ...tools,
});

/**
 * Plays `count` timeframe candles of `pairs`, after the warmup, through the strategy with `tools`, whose createOrder is that of
 * `orders`, and calls `afterCandle` after each. Returns what each candle ordered, separated by spaces: the side of each order created,
 * S or B, or '.' for none.
 */
export const playCandles = <T>(
  strategy: Pick<Strategy<T>, 'onTimeframeCandleAfterWarmup'>,
  tools: Tools<T>,
  orders: OrderRecorder,
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
