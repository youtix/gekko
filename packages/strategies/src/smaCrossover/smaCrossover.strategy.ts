import { PositionBook } from '../helpers/positionBook/positionBook';
import { indicatorsBySymbol } from '../helpers/strategy.helper';
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
import { compareWithTolerance, isFiniteNumber } from '@gekko/shared/utils/math/math.utils';
import { smaCrossoverStrategySchema } from '@gekko/schemas/strategies/smaCrossover.schema';
import { PriceSide, SMACrossoverStrategyParams } from './smaCrossover.types';

/**
 * Simple Moving Average Crossover Strategy
 *
 * Trades every watched pair, each with its own SMA and its own position:
 * - When MA crosses UP the market price => SELL (market order, all in), when long
 * - When MA crosses DOWN the market price => BUY (market order, an equal share of the free currency among the pairs not invested, all
 *   in on one pair: see PositionBook.buy), when flat
 *
 * The market price is the close of the candle, whatever source (`src`) the SMA averages. A crossover is detected by comparing the
 * previous relative position of the price vs the SMA to the current one. A price within the tolerance of the SMA (see
 * compareWithTolerance) is on it, neither above nor below, and keeps the previous position: the price crosses once it leaves the SMA
 * on the other side.
 */
export class SMACrossover implements Strategy<SMACrossoverStrategyParams> {
  static schema = smaCrossoverStrategySchema;

  // The side of the price of each pair, set at init for every pair of the book, in its order. Both are recorded on every candle, the
  // warmup included: recorded after the warmup only, the side of the last warmup candle was unknown and the first candle after it only
  // recorded where the price was, so a crossover between the two was missed.
  private readonly sides = new Map<TradingPair, PriceSide>();
  // A position per pair: the strategy buys a pair only when flat there and sells it only when long, never while an order of that pair
  // is pending. A crossover the position does not allow is skipped: advised anyway, a first SELL had nothing to sell and was refused. An
  // order canceled or errored, or a BUY the book skips, is not placed again: the next one waits for the next crossover of its pair.
  private readonly book = new PositionBook();

  init(params: InitParams<SMACrossoverStrategyParams>): void {
    const { tools, addIndicator } = params;
    const { period, src } = tools.strategyParams;
    this.book.track(params);
    for (const pair of this.book.pairs) {
      this.sides.set(pair, { wasPriceAboveSMA: null, isPriceAboveSMA: null });
      addIndicator('SMA', pair, { period, src });
    }
  }

  // Runs before onTimeframeCandleAfterWarmup on each candle, the warmup included: the side it moves aside is the previous candle's
  onEachTimeframeCandle(
    { candle, tools }: OnCandleEventParams<SMACrossoverStrategyParams>,
    ...indicators: IndicatorResults<number | null>[]
  ): void {
    const bySymbol = indicatorsBySymbol(indicators);
    for (const [pair, side] of this.sides) {
      // init adds an SMA on every pair: a pair whose SMA the hooks do not get is skipped, as one whose SMA is not ready, here and in the
      // other hooks
      const sma = bySymbol.get(pair)?.[0];
      side.wasPriceAboveSMA = side.isPriceAboveSMA;
      const price = candle.get(pair)?.close;
      if (!isFiniteNumber(price) || !isFiniteNumber(sma?.results)) continue;

      // On a flat window the SMA is the price in exact arithmetic, but its running sum leaves it a few ulps off, on either side:
      // compared strictly, that noise crossed the price on about half the flat windows, a round trip of fees on a market that had not
      // moved, and an exact tie counted as below, a SELL. Within the tolerance the price is on the SMA: no crossover, the side it was on
      // is kept, and the first side it takes is the initial state.
      const priceToSMA = compareWithTolerance(price, sma.results);
      if (priceToSMA === 0) continue;
      side.isPriceAboveSMA = priceToSMA > 0;
      if (side.wasPriceAboveSMA === null)
        tools.log('info', `[${pair}] Initial state: price ${side.isPriceAboveSMA ? 'above' : 'below'} SMA`);
    }
  }

  onTimeframeCandleAfterWarmup(
    params: OnCandleEventParams<SMACrossoverStrategyParams>,
    ...indicators: IndicatorResults<number | null>[]
  ): void {
    const { candle, tools } = params;
    const { log } = tools;
    const bySymbol = indicatorsBySymbol(indicators);

    for (const [pair, side] of this.sides) {
      const sma = bySymbol.get(pair)?.[0];
      const currentCandle = candle.get(pair);
      if (!currentCandle) continue;
      const price = currentCandle.close;

      if (!isFiniteNumber(sma?.results)) continue;

      // Detect crossovers: the price on the other side of the SMA than before this candle. None while the side before is unknown (the
      // first candle off a ready SMA only records it), nor while the price stays on its side or on the SMA.
      if (side.wasPriceAboveSMA === null || side.wasPriceAboveSMA === side.isPriceAboveSMA) continue;
      if (side.wasPriceAboveSMA && this.book.canSell(pair)) {
        // Price crossed below SMA => SMA crossed UP the price => SELL
        log('info', `[${pair}] SMA crossed UP price (${sma.results.toFixed(5)} > ${price.toFixed(5)}) => SELL`);
        this.book.sell({ type: 'MARKET', symbol: pair }, params);
      } else if (!side.wasPriceAboveSMA && this.book.canBuy(pair)) {
        // Price crossed above SMA => SMA crossed DOWN the price => BUY, logged once placed: a BUY the book skips as too small for the
        // market (see PositionBook.buy) is told by the book's own line alone. Logged before it, this line, relayed to the strat_info
        // subscribers, announced a BUY that was never sent.
        const id = this.book.buy({ type: 'MARKET', symbol: pair }, params);
        if (id) log('info', `[${pair}] SMA crossed DOWN price (${sma.results.toFixed(5)} < ${price.toFixed(5)}) => BUY`);
      }
    }
  }

  log({ candle, tools }: OnCandleEventParams<SMACrossoverStrategyParams>, ...indicators: IndicatorResults<number | null>[]): void {
    const { log } = tools;
    const bySymbol = indicatorsBySymbol(indicators);

    for (const pair of this.book.pairs) {
      const sma = bySymbol.get(pair)?.[0];
      const currentCandle = candle.get(pair);
      if (!currentCandle) continue;

      if (!isFiniteNumber(sma?.results)) continue;

      log('debug', `[${pair}] SMA: ${sma.results.toFixed(5)} | Price: ${currentCandle.close.toFixed(5)}`);
    }
  }

  onOrderCompleted(params: OnOrderCompletedEventParams<SMACrossoverStrategyParams>): void {
    this.book.onOrderCompleted(params);
  }

  onOrderCanceled(params: OnOrderCanceledEventParams<SMACrossoverStrategyParams>): void {
    this.book.onOrderCanceled(params);
  }

  onOrderErrored(params: OnOrderErroredEventParams<SMACrossoverStrategyParams>): void {
    this.book.onOrderErrored(params);
  }
}
