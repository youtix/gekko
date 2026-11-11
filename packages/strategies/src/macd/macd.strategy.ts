import { TradingPair } from '@gekko/shared/models/utility.types';
import { IndicatorResults, InitParams, OnCandleEventParams, Strategy } from '../strategy.types';
import { isFiniteNumber } from '@gekko/shared/utils/math/math.utils';
import { pluralize } from '@gekko/shared/utils/string/string.utils';
import { isObject } from 'lodash-es';
import { macdStrategySchema } from '@gekko/schemas/strategies/macd.schema';
import { MACDResult, MACDStrategyParams, MACDTrend } from './macd.types';

/** Trades every watched pair, each with its own MACD, its own trend and its own position (see Positions) */
export class MACD implements Strategy<MACDStrategyParams> {
  static schema = macdStrategySchema;

  // The trend of each watched pair, followed on the MACD of that pair alone: no trend at init. A trend starts again when the MACD
  // crosses back, even for fewer candles than the persistence, and every order is sized from what the account holds, a SELL all of its
  // asset, a BUY all the currency or its share of it (see Positions): the strategy buys a pair only when flat there and sells it only
  // when long, never while its order on that pair is pending. A blip shorter than the persistence advised the same side again, a BUY
  // sized from what the previous one left, or a SELL with nothing left to sell. The trend of an order canceled or errored stays
  // adviced, as does that of a BUY the position book skips: the next order waits for the next trend.
  private readonly trends = new Map<TradingPair, MACDTrend>();

  init({ tools, addIndicator }: InitParams<MACDStrategyParams>): void {
    const { strategyParams, positions } = tools;
    positions.track();
    for (const pair of positions.pairs) {
      addIndicator('MACD', pair, { short: strategyParams.short, long: strategyParams.long, signal: strategyParams.signal });
      this.trends.set(pair, { direction: 'none', duration: 0, persisted: false, adviced: false });
    }
  }

  onTimeframeCandleAfterWarmup(
    { tools }: OnCandleEventParams<MACDStrategyParams>,
    ...indicators: IndicatorResults<MACDResult | null>[]
  ): void {
    const { strategyParams, log, positions } = tools;
    const { macdSrc } = strategyParams;
    const bySymbol = tools.indicatorsBySymbol(indicators);

    for (const pair of positions.pairs) {
      const [macd] = bySymbol.get(pair) ?? [];
      if (!this.isMacd(macd?.results)) continue;

      let trend = this.trends.get(pair);
      if (macd.results[macdSrc] > strategyParams.thresholds.up) {
        if (trend?.direction !== 'up') {
          log('info', `[${pair}] MACD: up trend detected`);
          trend = { duration: 0, persisted: false, direction: 'up', adviced: false };
          this.trends.set(pair, trend);
        }
        trend.duration++;
        log('debug', `[${pair}] In uptrend since ${trend.duration} ${pluralize('candle', trend.duration)}`);

        if (trend.duration >= strategyParams.thresholds.persistence) trend.persisted = true;

        // Left unadviced while long or while an order is pending: a SELL that fills during the trend is bought back on its next candle
        if (trend.persisted && !trend.adviced && positions.canBuy(pair)) {
          trend.adviced = true;
          positions.buy({ type: 'STICKY', symbol: pair });
        }
      } else if (macd.results[macdSrc] < strategyParams.thresholds.down) {
        if (trend?.direction !== 'down') {
          log('info', `[${pair}] MACD: down trend detected`);
          trend = { duration: 0, persisted: false, direction: 'down', adviced: false };
          this.trends.set(pair, trend);
        }
        trend.duration++;
        log('debug', `[${pair}] In downtrend since ${trend.duration} ${pluralize('candle', trend.duration)}`);

        if (trend.duration >= strategyParams.thresholds.persistence) trend.persisted = true;

        if (trend.persisted && !trend.adviced && positions.canSell(pair)) {
          trend.adviced = true;
          positions.sell({ type: 'STICKY', symbol: pair });
        }
      } else {
        log('debug', `[${pair}] MACD: no trend detected`);
      }
    }
  }

  log({ tools }: OnCandleEventParams<MACDStrategyParams>, ...indicators: IndicatorResults<MACDResult | null>[]): void {
    const { log, positions } = tools;
    const bySymbol = tools.indicatorsBySymbol(indicators);

    for (const pair of positions.pairs) {
      const [macd] = bySymbol.get(pair) ?? [];
      if (!this.isMacd(macd?.results)) continue;

      log('debug', `[${pair}] macd: ${macd.results.macd.toFixed(8)}`);
      log('debug', `[${pair}] signal: ${macd.results.signal.toFixed(8)}`);
      log('debug', `[${pair}] hist: ${macd.results.hist.toFixed(8)}`);
    }
  }

  private isMacd(data: unknown): data is MACDResult {
    return (
      isObject(data) &&
      'macd' in data &&
      'signal' in data &&
      'hist' in data &&
      isFiniteNumber(data.macd) &&
      isFiniteNumber(data.signal) &&
      isFiniteNumber(data.hist)
    );
  }
}
