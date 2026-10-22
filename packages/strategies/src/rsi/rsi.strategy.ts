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
import { rsiStrategySchema } from '@gekko/schemas/strategies/rsi.schema';
import { RSICurrentTrend, RSIStrategyParams } from './rsi.types';

/** Trades every watched pair, each with its own RSI, its own trend and its own position (see PositionBook) */
export class RSI implements Strategy<RSIStrategyParams> {
  static schema = rsiStrategySchema;

  // The trend of each pair, none at init
  private readonly trends = new Map<TradingPair, RSICurrentTrend>();
  // A trend starts again when the RSI crosses the other threshold, even for fewer candles than the persistence, and every order is
  // all-in, a BUY on its share of the currency while several pairs are not invested (see PositionBook.buy): on each pair, the strategy
  // buys only when flat and sells only when long, never while its order is pending there. A blip shorter than the persistence advised
  // the same side again, a BUY sized from what the previous one left, or a SELL with nothing left to sell. The trend of an order
  // canceled or errored stays adviced, as does that of a BUY the book skips: the next order waits for the next trend.
  private readonly book = new PositionBook();

  init(params: InitParams<RSIStrategyParams>): void {
    const { tools, addIndicator } = params;
    const { period, src } = tools.strategyParams;
    this.book.track(params);
    for (const pair of this.book.pairs) {
      this.trends.set(pair, { direction: 'none', duration: 0, adviced: false });
      addIndicator('RSI', pair, { period, src });
    }
  }

  onTimeframeCandleAfterWarmup(params: OnCandleEventParams<RSIStrategyParams>, ...indicators: IndicatorResults<number | null>[]): void {
    const bySymbol = indicatorsBySymbol(indicators);
    for (const pair of this.book.pairs) {
      const [rsi] = bySymbol.get(pair) ?? [];
      if (isFiniteNumber(rsi?.results)) this.followTrend(pair, rsi.results, params);
    }
  }

  onOrderCompleted(params: OnOrderCompletedEventParams<RSIStrategyParams>): void {
    this.book.onOrderCompleted(params);
  }

  onOrderCanceled(params: OnOrderCanceledEventParams<RSIStrategyParams>): void {
    this.book.onOrderCanceled(params);
  }

  onOrderErrored(params: OnOrderErroredEventParams<RSIStrategyParams>): void {
    this.book.onOrderErrored(params);
  }

  /** Follows the trend of `pair` on its RSI, advising its order once it has lasted the persistence, if the pair's position allows it */
  private followTrend(pair: TradingPair, rsi: number, params: OnCandleEventParams<RSIStrategyParams>): void {
    const { strategyParams, log } = params.tools;
    const { thresholds } = strategyParams;
    let trend = this.trends.get(pair)!;

    if (rsi > thresholds.high) {
      if (trend.direction !== 'high') {
        log('info', `[${pair}] RSI: high trend detected`);
        trend = { duration: 0, direction: 'high', adviced: false };
        this.trends.set(pair, trend);
      }
      trend.duration++;
      log('debug', `[${pair}] In high trend since ${trend.duration} ${pluralize('candle', trend.duration)}`);

      // Left unadviced while flat or while an order is pending: a BUY that fills during the trend is sold on its next candle
      if (trend.duration >= thresholds.persistence && !trend.adviced && this.book.canSell(pair)) {
        trend.adviced = true;
        this.book.sell({ type: 'STICKY', symbol: pair }, params);
      }
    } else if (rsi < thresholds.low) {
      if (trend.direction !== 'low') {
        log('info', `[${pair}] RSI: low trend detected`);
        trend = { duration: 0, direction: 'low', adviced: false };
        this.trends.set(pair, trend);
      }
      trend.duration++;
      log('debug', `[${pair}] In low trend since ${trend.duration} ${pluralize('candle', trend.duration)}`);

      if (trend.duration >= thresholds.persistence && !trend.adviced && this.book.canBuy(pair)) {
        trend.adviced = true;
        this.book.buy({ type: 'STICKY', symbol: pair }, params);
      }
    }
  }
}
