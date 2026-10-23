import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { PositionBook } from '../helpers/positionBook/positionBook';
import { OrderSide } from '@gekko/shared/models/order.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import {
  InitParams,
  OnCandleEventParams,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Strategy,
} from '../strategy.types';
import { debugPositionBookStrategySchema } from '@gekko/schemas/strategies/debug/debugPositionBook.schema';
import { DebugPositionBookParams } from './debugPositionBook.types';

/**
 * Debug strategy used in the position book e2e flow, which reads its orders and its lines, so be careful when modifying it. It trades
 * through a PositionBook, as the signal strategies do, a position per watched pair, where the other debug strategies track none. On
 * the candles its block lists, counted from 0 for the first candle after the warmup, it plays each step, those of a candle in the
 * order of the block, on each pair the step names, every watched pair when it names none: a MARKET BUY sized by the book (an equal
 * share of the free currency among the pairs not invested, all-in for the last of them, skipped when the market would refuse it as
 * too small, the asset of the pair held then taken for the position when it is enough to sell: see PositionBook.buy), or an all-in
 * MARKET SELL. A step the position of a pair does not allow, a BUY while long, a SELL while flat, either while an order of the pair is
 * pending, is skipped on that pair, said at info level.
 */
export class DebugPositionBook implements Strategy<DebugPositionBookParams> {
  static schema = debugPositionBookStrategySchema;
  private readonly book = new PositionBook();
  // From 0, the first candle after the warmup, as its siblings count
  private index = 0;

  init(params: InitParams<DebugPositionBookParams>): void {
    // Played as it was, a step on a pair that is not watched would be refused by the book only on its candle, which stops the bot then
    const watched = [...params.candle.keys()];
    for (const { candle, side, symbols = [] } of params.tools.strategyParams.steps) {
      const unwatched = symbols.find(symbol => !watched.includes(symbol));
      if (!unwatched) continue;
      const problem = `symbol must be one of the watched pairs (${watched.join(', ')})`;
      throw new GekkoError('strategy', `Impossible to play the ${side} step of candle ${candle} on ${unwatched}: ${problem}`);
    }
    this.book.track(params);
  }

  onTimeframeCandleAfterWarmup(params: OnCandleEventParams<DebugPositionBookParams>, ..._indicators: unknown[]): void {
    for (const { candle, side, symbols = this.book.pairs } of params.tools.strategyParams.steps) {
      if (candle !== this.index) continue;
      for (const symbol of symbols) this.playStep(side, symbol, params);
    }
    this.index++;
  }

  onOrderCompleted(params: OnOrderCompletedEventParams<DebugPositionBookParams>, ..._indicators: unknown[]): void {
    this.book.onOrderCompleted(params);
  }

  onOrderCanceled(params: OnOrderCanceledEventParams<DebugPositionBookParams>, ..._indicators: unknown[]): void {
    this.book.onOrderCanceled(params);
  }

  onOrderErrored(params: OnOrderErroredEventParams<DebugPositionBookParams>, ..._indicators: unknown[]): void {
    this.book.onOrderErrored(params);
  }

  /** Places the order of a step on `symbol` through the book when the position there allows it, and says why when it does not */
  private playStep(side: OrderSide, symbol: TradingPair, params: OnCandleEventParams<DebugPositionBookParams>) {
    if (side === 'BUY' && this.book.canBuy(symbol)) this.book.buy({ type: 'MARKET', symbol }, params);
    else if (side === 'SELL' && this.book.canSell(symbol)) this.book.sell({ type: 'MARKET', symbol }, params);
    else params.tools.log('info', `[${symbol}] ${side} step of candle ${this.index} skipped: ${this.getSkipReason(side, symbol)}`);
  }

  /** Why the position on `symbol` does not allow a step of `side`: an order of the pair pending, or the position itself */
  private getSkipReason(side: OrderSide, symbol: TradingPair) {
    if (this.book.isPendingOrder(symbol)) return 'an order is pending';
    return side === 'BUY' ? 'the strategy is long' : 'the strategy is flat';
  }
}
