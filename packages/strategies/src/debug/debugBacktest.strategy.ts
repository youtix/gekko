import { OnCandleEventParams, Strategy } from '../strategy.types';
import { castArray, isNil } from 'lodash-es';
import { getSizing } from './debugBacktest.helper';
import { debugBacktestStrategySchema } from '@gekko/schemas/strategies/debug/debugBacktest.schema';
import { DebugBacktestParams } from './debugBacktest.types';

/**
 * Debug strategy used in the backtest e2e tests and in Scenario C of the paper flow, which check its PnL to the unit, so be careful when
 * modifying it. On the candles listed by buyCandleIndex and sellCandleIndex, counted from 0 for the first candle after the warmup, it
 * sends a BUY, then a MARKET SELL, on every watched pair: a MARKET BUY, or a LIMIT BUY at buyLimitPrice when it is set. Every order is
 * of 1 unit, or sized by the Trader as the block says: all-in with allIn, from a cost in currency with cost, from a share of the
 * balance with allocation. It tracks no position.
 */
export class DebugBacktest implements Strategy<DebugBacktestParams> {
  static schema = debugBacktestStrategySchema;
  // From 0, the first candle after the warmup, as its siblings count: counted from 1, buyCandleIndex 0 never bought
  private index = 0;

  onTimeframeCandleAfterWarmup({ candle, tools }: OnCandleEventParams<DebugBacktestParams>, ..._indicators: unknown[]): void {
    const { strategyParams, createOrder } = tools;
    const { buyLimitPrice } = strategyParams;
    const buyIndexes = castArray(strategyParams.buyCandleIndex);
    const sellIndexes = castArray(strategyParams.sellCandleIndex);
    const sizing = getSizing(strategyParams);

    for (const symbol of candle.keys()) {
      if (buyIndexes.includes(this.index)) {
        if (isNil(buyLimitPrice)) createOrder({ type: 'MARKET', side: 'BUY', ...sizing, symbol });
        else createOrder({ type: 'LIMIT', side: 'BUY', ...sizing, price: buyLimitPrice, symbol });
      }
      if (sellIndexes.includes(this.index)) createOrder({ type: 'MARKET', side: 'SELL', ...sizing, symbol });
    }

    this.index++;
  }
}
