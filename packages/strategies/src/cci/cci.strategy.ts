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
import { cciStrategySchema } from '@gekko/schemas/strategies/cci.schema';
import { CCIStrategyParams, CCITrend } from './cci.types';

/** Trades every watched pair (watch.assets), each with its own CCI, trend and position (see PositionBook) */
export class CCI implements Strategy<CCIStrategyParams> {
  static schema = cciStrategySchema;

  /** The trend of each pair, which init starts without a direction */
  private readonly trends = new Map<TradingPair, CCITrend>();
  // A trend starts again each time the CCI comes back from between the thresholds, and every order is all-in, but the BUY of a pair
  // while other pairs are not invested, which takes a share of the currency: the strategy buys a pair only when flat there and sells it
  // only when long, never while its order there is pending. Advised on every new overbought (oversold) trend, each SELL (BUY) after the
  // first was sized from what the previous one left, then refused once nothing was left, until maxConsecutiveErrors stopped the bot.
  // The trend of an order canceled or errored stays adviced, and so does that of a BUY the book skips as too small for the market (see
  // PositionBook.buy): the next order waits for the next trend.
  private readonly book = new PositionBook();

  init(params: InitParams<CCIStrategyParams>): void {
    const { tools, addIndicator } = params;
    this.book.track(params);
    for (const pair of this.book.pairs) {
      this.trends.set(pair, { direction: 'nodirection', duration: 0, persisted: false, adviced: false });
      addIndicator('CCI', pair, { period: tools.strategyParams.period });
    }
  }

  onTimeframeCandleAfterWarmup(params: OnCandleEventParams<CCIStrategyParams>, ...indicators: IndicatorResults[]): void {
    const { strategyParams, log } = params.tools;
    const { up, down, persistence } = strategyParams.thresholds;
    const bySymbol = indicatorsBySymbol(indicators);

    for (const pair of this.book.pairs) {
      const [cci] = bySymbol.get(pair) ?? [];
      let trend = this.trends.get(pair);
      if (!isFiniteNumber(cci?.results) || !trend) continue;

      if (cci.results >= up) {
        if (trend.direction !== 'overbought') {
          log('info', `[${pair}] CCI: overbought trend detected`);
          trend = { direction: 'overbought', duration: 1, persisted: persistence === 0, adviced: false };
        } else {
          trend.duration++;
          if (trend.duration >= persistence) trend.persisted = true;
        }
        // Left unadviced while flat or while an order of the pair is pending: a BUY that fills during the trend is sold on its next candle
        if (trend.persisted && !trend.adviced && this.book.canSell(pair)) {
          trend.adviced = true;
          this.book.sell({ type: 'STICKY', symbol: pair }, params);
        }
      } else if (cci.results <= down) {
        if (trend.direction !== 'oversold') {
          log('info', `[${pair}] CCI: oversold trend detected`);
          trend = { direction: 'oversold', duration: 1, persisted: persistence === 0, adviced: false };
        } else {
          trend.duration++;
          if (trend.duration >= persistence) trend.persisted = true;
        }
        if (trend.persisted && !trend.adviced && this.book.canBuy(pair)) {
          trend.adviced = true;
          this.book.buy({ type: 'STICKY', symbol: pair }, params);
        }
      } else {
        // Counted from 1, as a trend's first candle is: reset to 0, the first neutral candle after a trend logged "nodirection for 0",
        // where the first of a run logs "for 1". Only the log reads it: a trend starts over on its first candle, whatever came before.
        if (trend.direction !== 'nodirection') {
          trend = { direction: 'nodirection', duration: 1, persisted: false, adviced: false };
        } else {
          trend.duration++;
        }
      }

      this.trends.set(pair, trend);
      log('debug', `[${pair}] Trend: ${trend.direction} for ${trend.duration}`);
    }
  }

  log({ tools }: OnCandleEventParams<CCIStrategyParams>, ...indicators: IndicatorResults[]): void {
    const bySymbol = indicatorsBySymbol(indicators);
    for (const pair of this.book.pairs) {
      const [cci] = bySymbol.get(pair) ?? [];
      if (isFiniteNumber(cci?.results)) tools.log('debug', `[${pair}] CCI: ${cci.results.toFixed(2)}`);
    }
  }

  onOrderCompleted(params: OnOrderCompletedEventParams<CCIStrategyParams>): void {
    this.book.onOrderCompleted(params);
  }

  onOrderCanceled(params: OnOrderCanceledEventParams<CCIStrategyParams>): void {
    this.book.onOrderCanceled(params);
  }

  onOrderErrored(params: OnOrderErroredEventParams<CCIStrategyParams>): void {
    this.book.onOrderErrored(params);
  }
}
