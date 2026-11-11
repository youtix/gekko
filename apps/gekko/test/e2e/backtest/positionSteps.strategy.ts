import type { OrderSide } from '@gekko/shared/models/order.types';
import type { TradingPair } from '@gekko/shared/models/utility.types';
import type {
  IndicatorResults,
  InitParams,
  OnCandleEventParams,
  OnOrderCompletedEventParams,
  Positions,
  Strategy,
  Tools,
} from '@gekko/strategies/strategy.types';
import type { TrailingStopState } from '@gekko/strategies/trailingStopManager.types';
import type { UUID } from 'node:crypto';
import { z } from 'zod';

/** A pair as the configuration writes it, around one slash */
const pairSchema = z.templateLiteral([z.string(), '/', z.string()]);

/** What a step of either side gives */
const stepFields = {
  /** The candle the step is played on, counted from 0, the first candle after the warmup */
  candle: z.number().int().nonnegative(),
  /** The pairs the step trades, in this order: every pair tracked when left out */
  symbols: z.array(pairSchema).optional(),
  type: z.enum(['MARKET', 'LIMIT', 'STICKY']),
  price: z.number().positive().optional(),
  /**
   * Placed whatever canBuy or canSell answers, which tools.positions.buy and sell do not check: a step on a pair the book does not
   * track has it refuse the order, which stops the run
   */
  force: z.boolean().optional(),
};

const positionStepsSchema = z.strictObject({
  /** The pairs init has tools.positions track, in this order: every watched pair, in the order of watch.assets, when left out */
  track: z.array(pairSchema).optional(),
  /** The period of the SMA init adds on each pair tracked, which each step it places names: no indicator when left out */
  sma: z.number().int().positive().optional(),
  steps: z.array(
    z.discriminatedUnion('side', [
      // A trailing stop is a BUY's alone, as tools.positions.buy takes it: its SELL is adopted by the book once it triggers
      z.strictObject({
        ...stepFields,
        side: z.literal('BUY'),
        trailing: z.strictObject({ percentage: z.number(), trigger: z.number().optional() }).optional(),
      }),
      z.strictObject({ ...stepFields, side: z.literal('SELL') }),
    ]),
  ),
});

export type PositionStepsParams = z.infer<typeof positionStepsSchema>;

/**
 * The strategy of the backtest flow of tools.positions, which trades several pairs through the position book the StrategyManager keeps
 * for every strategy. Loaded through strategyPath, as a strategy file of the user's is, it imports only types from Gekko, and zod: the
 * book is a tool, not a module it would import. init has the book track the pairs its block names, every watched pair when it names
 * none, and adds an SMA on each of them when its block sets one. On each candle after the warmup, counted from 0, it plays the steps its
 * block lists for that candle, in their order, on each pair a step names, every pair tracked when it names none: a BUY or a SELL through
 * tools.positions.buy or sell, of the type, the price and the trailing stop the step gives, once canBuy or canSell allows it there, a
 * forced step asking neither.
 *
 * It says at info level what each step did: the order it placed, with the SMA of its pair as tools.indicatorsBySymbol groups the
 * indicators of the hook, the BUY the book skipped, or why the position does not allow the step. And what its order hooks and its
 * trailing stop hooks read of the position of their pair, which the book has settled, or adopted the SELL of the stop for, before they
 * run: no hook of it relays anything to the book.
 */
export class PositionSteps implements Strategy<PositionStepsParams> {
  static schema = positionStepsSchema;
  private index = 0;

  init({ tools, addIndicator }: InitParams<PositionStepsParams>): void {
    const { track, sma } = tools.strategyParams;
    tools.positions.track(track);
    if (sma === undefined) return;
    for (const pair of tools.positions.pairs) addIndicator('SMA', pair, { period: sma });
  }

  onTimeframeCandleAfterWarmup(
    { tools }: OnCandleEventParams<PositionStepsParams>,
    ...indicators: IndicatorResults<number | null>[]
  ): void {
    const indicatorsOf = tools.indicatorsBySymbol(indicators);
    for (const step of tools.strategyParams.steps) {
      if (step.candle !== this.index) continue;
      for (const symbol of step.symbols ?? tools.positions.pairs) {
        const [sma] = indicatorsOf.get(symbol) ?? [];
        this.playStep(step, symbol, tools, sma?.results);
      }
    }
    this.index++;
  }

  onOrderCompleted({ order, tools }: OnOrderCompletedEventParams<PositionStepsParams>, ..._indicators: unknown[]): void {
    const { id, symbol, side } = order;
    tools.log('info', `[${symbol}] ${side} ${id} completed: ${this.describePosition(symbol, tools.positions)}`);
  }

  onTrailingStopActivated({ id, symbol }: TrailingStopState, tools: Tools<PositionStepsParams>): void {
    tools.log('info', `[${symbol}] Trailing stop of BUY ${id} activated: ${this.describePosition(symbol, tools.positions)}`);
  }

  onTrailingStopTriggered(orderId: UUID, { id, symbol, stopPrice }: TrailingStopState, tools: Tools<PositionStepsParams>): void {
    const triggered = `triggered at its stop price of ${stopPrice}, its SELL ${orderId} sent`;
    tools.log('info', `[${symbol}] Trailing stop of BUY ${id} ${triggered}: ${this.describePosition(symbol, tools.positions)}`);
  }

  /** Plays a step on `symbol`, given the result of the SMA of that pair, if any, and says what it did */
  private playStep(
    step: PositionStepsParams['steps'][number],
    symbol: TradingPair,
    { positions, log }: Tools<PositionStepsParams>,
    sma: number | null | undefined,
  ) {
    const played = `[${symbol}] ${step.side} step of candle ${this.index}`;
    const isAllowed = step.side === 'BUY' ? positions.canBuy(symbol) : positions.canSell(symbol);
    if (!isAllowed && !step.force) {
      log('info', `${played} skipped: ${this.getSkipReason(step.side, symbol, positions)}`);
      return;
    }
    const order = { symbol, type: step.type, ...(step.price !== undefined && { price: step.price }) };
    const id = step.side === 'BUY' ? positions.buy({ ...order, ...(step.trailing && { trailing: step.trailing }) }) : positions.sell(order);
    if (id === undefined) log('info', `${played}: nothing placed, the position book skipped the BUY`);
    else log('info', `${played}: ${id} placed${sma === undefined ? '' : ` (SMA ${sma})`}`);
  }

  /** Why the position on `symbol` does not allow a step of `side`: the pair not tracked, an order of it pending, or the position itself */
  private getSkipReason(side: OrderSide, symbol: TradingPair, positions: Positions) {
    if (!positions.pairs.includes(symbol)) return 'the pair is not tracked';
    if (positions.isPendingOrder(symbol)) return 'an order is pending';
    return side === 'BUY' ? 'the strategy is long' : 'the strategy is flat';
  }

  /** The position of `pair` as tools.positions reads it */
  private describePosition(pair: TradingPair, positions: Positions) {
    return `isLong ${positions.isLong(pair)}, isPendingOrder ${positions.isPendingOrder(pair)}`;
  }
}
