import { PositionBook } from '@helpers/strategy/positionBook/positionBook';
import { indicatorsBySymbol } from '@helpers/strategy/strategy.helper';
import { TradingPair } from '@models/utility.types';
import {
  InitParams,
  OnCandleEventParams,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Strategy,
} from '@strategies/strategy.types';
import { compareWithTolerance } from '@utils/math/math.utils';
import { emaRibbonStrategySchema } from './emaRibbon.schema';
import type { EMARibbonStrategyParams, RibbonResults } from './emaRibbon.types';

/** Trades every watched pair, each with its own ribbon, its own spreads and its own position (see PositionBook) */
export class EMARibbon implements Strategy<EMARibbonStrategyParams> {
  static schema = emaRibbonStrategySchema;

  // The strategy buys a pair only when flat on it and sells it only when long, never while its order on that pair is pending. A SELL
  // is all-in, and so is a BUY on one pair; on several, a BUY takes an equal share of the free currency among the pairs not invested
  // (see PositionBook). An order canceled or errored is placed again by the next candle that signals it, unless what it executed before
  // it ended changed the position (see PositionTracker); a BUY the book skipped, its share below the minimum cost of the market, is
  // asked for again by that candle.
  private readonly book = new PositionBook();
  // The spreads of each pair's ribbon on the candle in progress and on the one before, recorded on every candle, the warmup included.
  // Recorded after the warmup only, the first candle after it had no spread to compare with: it bought a ribbon that was narrowing,
  // sold at the next.
  private readonly spreads = new Map<TradingPair, number | undefined>();
  private readonly previousSpreads = new Map<TradingPair, number | undefined>();

  init(params: InitParams<EMARibbonStrategyParams>): void {
    const { tools, addIndicator } = params;
    this.book.track(params);
    const { src, count, start, step } = tools.strategyParams;
    for (const pair of this.book.pairs) addIndicator('EMARibbon', pair, { src, count, start, step });
  }

  // Runs before onTimeframeCandleAfterWarmup on each candle: the spread it moves aside is the previous candle's
  onEachTimeframeCandle(_params: OnCandleEventParams<EMARibbonStrategyParams>, ...indicators: RibbonResults[]): void {
    const bySymbol = indicatorsBySymbol(indicators);
    for (const pair of this.book.pairs) {
      const [emaRibbon] = bySymbol.get(pair) ?? [];
      this.previousSpreads.set(pair, this.spreads.get(pair));
      this.spreads.set(pair, emaRibbon?.results?.spread);
    }
  }

  onTimeframeCandleAfterWarmup(params: OnCandleEventParams<EMARibbonStrategyParams>, ...indicators: RibbonResults[]): void {
    const { spreadCompressionThreshold } = params.tools.strategyParams;
    const bySymbol = indicatorsBySymbol(indicators);
    for (const pair of this.book.pairs) {
      const [emaRibbon] = bySymbol.get(pair) ?? [];
      if (emaRibbon?.results === undefined || emaRibbon.results === null) continue;
      const { results, spread } = emaRibbon.results;

      // Bullish: each EMA above the next, slower one. On a long flat stretch each EMA freezes a few ulps short of the price once its step
      // rounds away, the faster ones nearer: reached from below, the ribbon stayed in descending order by those residues alone, its spread
      // stopped narrowing, and it bought after some 600 flat candles. EMAs within the tolerance of each other are equal: not bullish.
      const isBullish = results.every((ema, index) => index === 0 || compareWithTolerance(results[index - 1], ema) > 0);
      const isSpreadCompressed = spread < spreadCompressionThreshold;
      // A ribbon moving in parallel, on a steady trend, keeps its spread in exact arithmetic, but the computed spread wobbles by ulps:
      // compared strictly, a wobble down narrowed it, a SELL then a BUY again. Within the tolerance the spread is unchanged, which is not
      // narrowing, nor is a spread with none before it (the ribbon's first candle).
      const previousSpread = this.previousSpreads.get(pair);
      const isSpreadNarrowing = previousSpread !== undefined && compareWithTolerance(spread, previousSpread) < 0;

      if (isBullish && isSpreadCompressed && !isSpreadNarrowing && this.book.canBuy(pair)) {
        this.book.buy({ type: 'STICKY', symbol: pair }, params);
      }

      if (isSpreadNarrowing && this.book.canSell(pair)) {
        this.book.sell({ type: 'STICKY', symbol: pair }, params);
      }
    }
  }

  log({ tools }: OnCandleEventParams<EMARibbonStrategyParams>, ...indicators: RibbonResults[]): void {
    const { log } = tools;
    const bySymbol = indicatorsBySymbol(indicators);
    for (const pair of this.book.pairs) {
      const [emaRibbon] = bySymbol.get(pair) ?? [];
      if (emaRibbon?.results === undefined || emaRibbon.results === null) continue;
      log('debug', `[${pair}] Ribbon results: [${emaRibbon.results.results.join(' / ')}]`);
      log('debug', `[${pair}] Ribbon Spread: ${emaRibbon.results.spread}`);
    }
  }

  onOrderCompleted(params: OnOrderCompletedEventParams<EMARibbonStrategyParams>): void {
    this.book.onOrderCompleted(params);
  }

  onOrderCanceled(params: OnOrderCanceledEventParams<EMARibbonStrategyParams>): void {
    this.book.onOrderCanceled(params);
  }

  onOrderErrored(params: OnOrderErroredEventParams<EMARibbonStrategyParams>): void {
    this.book.onOrderErrored(params);
  }
}
