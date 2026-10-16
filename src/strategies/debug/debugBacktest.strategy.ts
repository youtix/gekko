import { OnCandleEventParams, Strategy } from '@strategies/strategy.types';
import { castArray, isNil } from 'lodash-es';
import { debugBacktestStrategySchema } from './debugBacktest.schema';
import { DebugBacktestParams } from './debugBacktest.types';

/**
 * Debug strategy used in the backtest e2e tests, which check its PnL to the unit, so be careful when modifying it. On the candles
 * listed by buyCandleIndex and sellCandleIndex, counted from 0 for the first candle after the warmup, it sends a BUY, then a MARKET
 * SELL, of 1 unit on every watched pair: a MARKET BUY, or a LIMIT BUY at buyLimitPrice when it is set. It tracks no position.
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

    for (const symbol of candle.keys()) {
      // Fixed amounts, for a predictable PnL: the SELL closes the position the BUY opened
      if (buyIndexes.includes(this.index)) {
        if (isNil(buyLimitPrice)) createOrder({ type: 'MARKET', side: 'BUY', amount: 1, symbol });
        else createOrder({ type: 'LIMIT', side: 'BUY', amount: 1, price: buyLimitPrice, symbol });
      }
      if (sellIndexes.includes(this.index)) createOrder({ type: 'MARKET', side: 'SELL', amount: 1, symbol });
    }

    this.index++;
  }
}
