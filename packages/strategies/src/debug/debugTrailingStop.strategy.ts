import { OnCandleEventParams, OnOrderCompletedEventParams, Strategy, Tools } from '../strategy.types';
import { TrailingStopState } from '../trailingStopManager.types';
import { UUID } from 'node:crypto';
import { debugTrailingStopStrategySchema } from '@gekko/schemas/strategies/debug/debugTrailingStop.schema';
import { DebugTrailingStopParams } from './debugTrailingStop.types';

/**
 * Debug strategy used exclusively in e2e tests to verify the trailing stop lifecycle. Places a single MARKET BUY of 1 unit on the first
 * watched pair, with a trailing stop, then logs each lifecycle event (each order completed, the stop activated, the stop triggered)
 * so that tests can assert on logStore entries.
 */
export class DebugTrailingStop implements Strategy<DebugTrailingStopParams> {
  static schema = debugTrailingStopStrategySchema;
  private index = 0;
  private orderPlaced = false;

  onTimeframeCandleAfterWarmup({ candle, tools }: OnCandleEventParams<DebugTrailingStopParams>, ..._indicators: unknown[]): void {
    const { strategyParams, log, createOrder } = tools;

    if (strategyParams.wait > this.index) {
      this.index++;
      return;
    }

    if (!this.orderPlaced) {
      const symbol = candle.keys().next().value!;
      log('debug', 'Trailing stop BUY order created');
      const order = {
        type: 'MARKET' as const,
        side: 'BUY' as const,
        amount: 1,
        symbol,
        trailing: { trigger: strategyParams.trigger, percentage: strategyParams.percentage },
      };
      createOrder(order);
      this.orderPlaced = true;
    }

    this.index++;
  }

  onOrderCompleted(params: OnOrderCompletedEventParams<DebugTrailingStopParams>, ..._indicators: unknown[]): void {
    params.tools.log('debug', `Trailing stop order completed: ${params.order.id}`);
  }

  // Both hooks did nothing, while their comments said they logged: the e2e flow could not tell whether the StrategyManager forwarded
  // them. They log through the tools the manager passes them last.
  onTrailingStopActivated(state: TrailingStopState, tools: Tools<DebugTrailingStopParams>): void {
    const { id, symbol, highestPeak, stopPrice } = state;
    tools.log('debug', `Trailing stop activated: BUY ${id} on ${symbol}, peak ${highestPeak}, stop price ${stopPrice}`);
  }

  onTrailingStopTriggered(orderId: UUID, state: TrailingStopState, tools: Tools<DebugTrailingStopParams>): void {
    const { id, symbol, amount, stopPrice } = state;
    tools.log(
      'debug',
      `Trailing stop triggered: BUY ${id} on ${symbol} at stop price ${stopPrice}, its MARKET SELL ${orderId} of ${amount} sent`,
    );
  }
}
