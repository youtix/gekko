import { OnCandleEventParams, Strategy } from '../strategy.types';
import { debugRealtimeStrategySchema } from '@gekko/schemas/strategies/debug/debugRealtime.schema';
import { DebugRealtimeParams } from './debugRealtime.types';

/**
 * Debug strategy used in the realtime e2e tests, so be careful when modifying it: a MARKET BUY of 1 unit on every watched pair on the
 * first candle after the warmup, a MARKET SELL on the second, then nothing. It tracks no position: its SELL does not wait for the BUY.
 */
export class DebugRealtime implements Strategy<DebugRealtimeParams> {
  static schema = debugRealtimeStrategySchema;
  private index = 0;

  onTimeframeCandleAfterWarmup({ candle, tools }: OnCandleEventParams<DebugRealtimeParams>, ..._indicators: unknown[]): void {
    const { log, createOrder } = tools;

    for (const pair of candle.keys()) {
      log('debug', `Iteration: ${this.index} for ${pair}`);
      if (this.index === 0) {
        log('debug', `Trigger BUY for ${pair}`);
        createOrder({ type: 'MARKET', side: 'BUY', amount: 1, symbol: pair });
      } else if (this.index === 1) {
        log('debug', `Trigger SELL for ${pair}`);
        createOrder({ type: 'MARKET', side: 'SELL', amount: 1, symbol: pair });
      }
    }

    this.index++;
  }
}
