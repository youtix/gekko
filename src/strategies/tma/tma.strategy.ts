import { TradingPair } from '@models/utility.types';
import { PositionBook } from '@strategies/positionBook';
import {
  IndicatorResults,
  InitParams,
  OnCandleEventParams,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Strategy,
} from '@strategies/strategy.types';
import { indicatorsBySymbol } from '@strategies/strategy.utils';
import { compareWithTolerance, isFiniteNumber } from '@utils/math/math.utils';
import { tmaStrategySchema } from './tma.schema';
import { TMAStrategyParams } from './tma.types';

/** Trades every watched pair, each with its own short, medium and long SMAs and its own position (see PositionBook) */
export class TMA implements Strategy<TMAStrategyParams> {
  static schema = tmaStrategySchema;

  // An alignment holds for many candles in a row, and every order is all-in or, for a BUY, an equal share of the currency among the
  // pairs not invested (see PositionBook.buy): on each pair, the strategy buys once when flat and sells once when long, never while an
  // order of that pair is pending. Advised on every candle, each order after the first was sized from what the previous one left, then
  // refused once nothing was left, until maxConsecutiveErrors stopped the bot. An order canceled or errored is placed again by the next
  // candle of its signal, unless what it executed before it ended changed the position (see PositionTracker), and a BUY the book
  // skipped, its share below the minimum cost of the market, is asked for again on the next one.
  private readonly book = new PositionBook();

  init(params: InitParams<TMAStrategyParams>): void {
    const { tools, addIndicator } = params;
    const { long, medium, short, src } = tools.strategyParams;
    this.book.track(params);
    for (const pair of this.book.pairs) {
      addIndicator('SMA', pair, { period: short, src });
      addIndicator('SMA', pair, { period: medium, src });
      addIndicator('SMA', pair, { period: long, src });
    }
  }

  onTimeframeCandleAfterWarmup(params: OnCandleEventParams<TMAStrategyParams>, ...indicators: IndicatorResults<number | null>[]): void {
    const bySymbol = indicatorsBySymbol(indicators);
    for (const pair of this.book.pairs) {
      const indicatorsOfPair = bySymbol.get(pair);
      if (indicatorsOfPair) this.adviseOn(pair, params, indicatorsOfPair);
    }
  }

  onOrderCompleted(params: OnOrderCompletedEventParams<TMAStrategyParams>): void {
    this.book.onOrderCompleted(params);
  }

  onOrderCanceled(params: OnOrderCanceledEventParams<TMAStrategyParams>): void {
    this.book.onOrderCanceled(params);
  }

  onOrderErrored(params: OnOrderErroredEventParams<TMAStrategyParams>): void {
    this.book.onOrderErrored(params);
  }

  /** Advises on `pair` from its short, medium and long SMAs (`indicators`, in the order init added them), once all three are ready */
  private adviseOn(pair: TradingPair, params: OnCandleEventParams<TMAStrategyParams>, indicators: IndicatorResults<number | null>[]): void {
    const { log } = params.tools;
    const [short, medium, long] = indicators;
    if (!isFiniteNumber(short.results) || !isFiniteNumber(medium.results) || !isFiniteNumber(long.results)) return;

    const smas = `${short.results}/${medium.results}/${long.results}`;
    // On a flat stretch the SMAs that hold only its price are equal in exact arithmetic, but their running sums leave them a few ulps
    // apart, on either side: compared strictly, that noise made trends, several round trips of fees on a market that had not moved.
    // Within the tolerance two SMAs are equal, neither above nor below each other: a medium SMA equal to either other one is no trend.
    const shortToMedium = compareWithTolerance(short.results, medium.results);
    const mediumToLong = compareWithTolerance(medium.results, long.results);
    const isUptrend = shortToMedium > 0 && mediumToLong > 0;
    // A mixed alignment: the medium SMA above both others, or below both. A fully bearish one (short < medium < long) gives no signal.
    const isDowntrend = (shortToMedium < 0 && mediumToLong > 0) || (shortToMedium > 0 && mediumToLong < 0);

    if (isUptrend && this.book.canBuy(pair)) {
      log('info', `[${pair}] Executing long advice due to detected uptrend: ${smas}`);
      this.book.buy({ type: 'STICKY', symbol: pair }, params);
    } else if (isDowntrend && this.book.canSell(pair)) {
      log('info', `[${pair}] Executing short advice due to detected downtrend: ${smas}`);
      this.book.sell({ type: 'STICKY', symbol: pair }, params);
    } else if (!isUptrend && !isDowntrend) {
      log('debug', `[${pair}] No clear trend detected: ${smas}`);
    }
  }
}
