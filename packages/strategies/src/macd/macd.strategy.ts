import { PositionBook } from '../helpers/positionBook/positionBook';
import { TradingPair } from '@gekko/shared/models/utility.types';
import {
  IndicatorResults,
  InitParams,
  OnCandleEventParams,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Strategy,
} from '../strategy.types';
import { indicatorsBySymbol } from '../helpers/strategy.helper';
import { isFiniteNumber } from '@gekko/shared/utils/math/math.utils';
import { pluralize } from '@gekko/shared/utils/string/string.utils';
import { isObject } from 'lodash-es';
import { macdStrategySchema } from '@gekko/schemas/strategies/macd.schema';
import { MACDResult, MACDStrategyParams, MACDTrend } from './macd.types';

/** Trades every watched pair, each with its own MACD, its own trend and its own position (see PositionBook) */
export class MACD implements Strategy<MACDStrategyParams> {
  static schema = macdStrategySchema;

  // The trend of each watched pair, followed on the MACD of that pair alone: no trend at init
  private readonly trends = new Map<TradingPair, MACDTrend>();
  // A trend starts again when the MACD crosses back, even for fewer candles than the persistence, and every order is sized from what
  // the account holds, a SELL all of its asset, a BUY all the currency or its share of it (see PositionBook): the strategy buys a pair
  // only when flat there and sells it only when long, never while its order on that pair is pending. A blip shorter than the
  // persistence advised the same side again, a BUY sized from what the previous one left, or a SELL with nothing left to sell. The trend
  // of an order canceled or errored stays adviced, as does that of a BUY the book skips: the next order waits for the next trend.
  private readonly book = new PositionBook();

  init(params: InitParams<MACDStrategyParams>): void {
    const { tools, addIndicator } = params;
    const { strategyParams } = tools;
    this.book.track(params);
    for (const pair of this.book.pairs) {
      addIndicator('MACD', pair, { short: strategyParams.short, long: strategyParams.long, signal: strategyParams.signal });
      this.trends.set(pair, { direction: 'none', duration: 0, persisted: false, adviced: false });
    }
  }

  onTimeframeCandleAfterWarmup(
    params: OnCandleEventParams<MACDStrategyParams>,
    ...indicators: IndicatorResults<MACDResult | null>[]
  ): void {
    const { strategyParams, log } = params.tools;
    const { macdSrc } = strategyParams;
    const bySymbol = indicatorsBySymbol(indicators);

    for (const pair of this.book.pairs) {
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
        if (trend.persisted && !trend.adviced && this.book.canBuy(pair)) {
          trend.adviced = true;
          this.book.buy({ type: 'STICKY', symbol: pair }, params);
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

        if (trend.persisted && !trend.adviced && this.book.canSell(pair)) {
          trend.adviced = true;
          this.book.sell({ type: 'STICKY', symbol: pair }, params);
        }
      } else {
        log('debug', `[${pair}] MACD: no trend detected`);
      }
    }
  }

  log({ tools }: OnCandleEventParams<MACDStrategyParams>, ...indicators: IndicatorResults<MACDResult | null>[]): void {
    const { log } = tools;
    const bySymbol = indicatorsBySymbol(indicators);

    for (const pair of this.book.pairs) {
      const [macd] = bySymbol.get(pair) ?? [];
      if (!this.isMacd(macd?.results)) continue;

      log('debug', `[${pair}] macd: ${macd.results.macd.toFixed(8)}`);
      log('debug', `[${pair}] signal: ${macd.results.signal.toFixed(8)}`);
      log('debug', `[${pair}] hist: ${macd.results.hist.toFixed(8)}`);
    }
  }

  onOrderCompleted(params: OnOrderCompletedEventParams<MACDStrategyParams>): void {
    this.book.onOrderCompleted(params);
  }

  onOrderCanceled(params: OnOrderCanceledEventParams<MACDStrategyParams>): void {
    this.book.onOrderCanceled(params);
  }

  onOrderErrored(params: OnOrderErroredEventParams<MACDStrategyParams>): void {
    this.book.onOrderErrored(params);
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
