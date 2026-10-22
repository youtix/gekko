import { GekkoError } from '@errors/gekko.error';
import { pickTradedPair } from '@helpers/strategy/positionTracker/positionTracker.helper';
import type { ExchangeEvent } from '@models/event.types';
import type { LogLevel } from '@models/logLevel.types';
import type { OrderSide } from '@models/order.types';
import type { BalanceDetail, Portfolio } from '@models/portfolio.types';
import { TradingPair } from '@models/utility.types';
import type { MarketData, OpenOrder } from '@services/exchange/exchange.types';
import {
  IndicatorResults,
  InitParams,
  OnCandleEventParams,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Strategy,
  Tools,
} from '@strategies/strategy.types';
import { addPrecise, isFiniteNumber } from '@utils/math/math.utils';
import { pluralize } from '@utils/string/string.utils';
import type { UUID } from 'node:crypto';
import { DEFAULT_RETRY_LIMIT } from './gridBot.const';
import { gridBotStrategySchema } from './gridBot.schema';
import type {
  GridBotStrategyParams,
  GridBounds,
  GridLayout,
  GridSpacing,
  LevelState,
  OutOfRangeCount,
  OutOfRangeSide,
  RebalancePlan,
} from './gridBot.types';
import {
  checkLowestBuyPrice,
  checkPriceTick,
  checkRoundTripFee,
  computeGridBounds,
  computeLevelPrice,
  computeRebalancePlan,
  deriveLevelQuantity,
  getMinimumAmount,
  getOutOfRangeSide,
  getPortfolioContent,
  getRebalanceBuyCost,
  getRebalanceOrderPrice,
  hasOnlyOneSide,
  inferPricePrecision,
  isResetSide,
  resolveSpacing,
  roundPrice,
  validateConfig,
} from './gridBot.helper';

/**
 * GridBot Strategy
 *
 * Places a grid of LIMIT orders around the current price.
 * - It trades the first pair watched (watch.assets), and warns once, at init, of the other pairs it ignores
 * - It keeps its grid in memory and follows only the orders it places: it refuses to start, at init, while orders are open on its
 *   pair, a previous run's grid for instance, naming each one for the user to cancel it on the exchange
 * - The grid is placed on the first timeframe candle after the warmup, centred on its close
 * - Buy levels are placed below the center price
 * - Sell levels are placed above the center price
 * - Spacing between adjacent prices is configurable: fixed (in price units), percent (of the center price, the same between any two
 *   adjacent prices, as fixed spacing) or logarithmic (a ratio between adjacent prices). One under the round-trip fee, two maker fees,
 *   is warned of when the grid starts or is reset
 * - With atr spacing, the step is spacingValue × the ATR of atrPeriod timeframe candles on the candle the grid is built around, a fixed
 *   step from then on, until a reset resolves it again from the ATR of the last candle: rounded to the tick, and raised to the smallest
 *   step at which every level breaks even on the maker fee, one tick at least, with a warning (see resolveSpacing). On a market whose
 *   tick depends on the price, a step above it is raised to a whole number of the coarser tick at the top of the grid where a level
 *   would lose money there, with a warning of its own. The run stops on the first candle after the warmup when the ATR has no value
 *   yet: warmup.candleCount must be at least atrPeriod
 * - A grid whose lowest BUY would be at or below 0, or whose spacing rounds two adjacent prices to the same tick, stops the run: around
 *   the close it starts on, or the price it is reset around, and again around the price a rebalance ended at, before it is placed
 *   again and when the grid is built
 * - Prices are rounded to the tick of the market (precision.price) as they are written, in decimal, a tie upwards, or to the tick at the
 *   price where it is coarser, on a market whose tick depends on the price (precision.priceSignificantDigits, Hyperliquid's). A market
 *   that states no tick has them rounded to 8 decimals, with a warning
 * - Each level trades back and forth between two adjacent prices of the grid: once its BUY fills it sells one step above, once its
 *   SELL fills it buys one step below
 * - Every level trades the same quantity, and the portfolio is first rebalanced to the split that funds them all with it: a unit of
 *   the asset for each sell level, and each buy level's price in currency, the maker fee on top. Not 50/50: the BUYs, below the
 *   center price, cost less than the SELLs are worth. A portfolio on which less than 1 % of the value would stay idle is not rebalanced
 * - The rebalance and the grid use the free balances, and every order is one the market takes, of at least its minimum amount and
 *   cost: a rebalance under them is not sent, and a side that cannot fund all its levels with them leaves out the farthest
 * - A refused or canceled order is placed again up to retryOnError times, a canceled grid order for what is left of it. A grid order
 *   is then left out with a warning, the rest of the grid trading on until no level holds an order, and a rebalance stops the run. A
 *   failed rebalance is planned again on the balances it left, warned of with what follows: placed again, the grid built, or a stop
 * - An order that errored while it may be live on the exchange (its creation lost on the network, its poll failed for good) is never
 *   placed again: a grid order is left out with a warning, the run stopping once more than retryOnError orders are in that case or no
 *   level holds an order, and a rebalance stops the run
 * - The grid stays in place when the price leaves its range, unless resetMode arms a reset on that side: a timeframe candle that
 *   closes out of the range is warned of once, unless it starts a reset, which says so in its own line, until one closes back at the
 *   grid's price next to the bound it left, where the grid trades again, logged once at info, or out on the other side. A fill that
 *   leaves orders on one side of the grid only is warned of once, until a fill gives it both sides again
 * - With resetMode 'up', 'down' or 'both', resetConfirmCandles timeframe candles closing in a row beyond the grid on a side it arms
 *   reset the grid: its open orders are canceled, and once the last has ended the grid is placed again around the price of that last
 *   event, on its portfolio, as at the start: the free balances rebalanced first, which realizes what the breakout lost, and an atr
 *   step resolved again. A portfolio the Trader read before the reset, its read after the cancels having failed, is built on all the
 *   same, with a warning (see rebuildOnceEnded). Meanwhile a fill turns no level and a canceled or refused order is not placed again:
 *   the new grid replaces every level. An order that may be live untracked, from before the reset or during it, stops the run where
 *   the new grid would be built over it, which the line that starts the reset says of one from before it. The resetCooldownCandles
 *   timeframe candles of the new grid are not counted towards another reset
 */
export class GridBot implements Strategy<GridBotStrategyParams> {
  /** Parses the strategy block before the strategy is created: tools.strategyParams is its output */
  static schema = gridBotStrategySchema;

  /** Base asset */
  private base: string = '';
  /** Quote asset */
  private quote: string = '';
  /** Trading pair */
  private pair: TradingPair = '/';
  /** All grid levels with their state */
  private levels: LevelState[] = [];
  /** Grid price boundaries */
  private gridBounds?: GridBounds;
  /**
   * The grid's prices next to its bounds, inside them: where the grid trades again once its orders beyond a bound have filled, the
   * bottom level's SELL below, the top level's BUY above, and where a price that left the range is back in it
   */
  private reentryPrices?: Record<OutOfRangeSide, number>;
  /** Quantity per level */
  private quantity = 0;
  /** The spacing the grid is built with, resolved when it starts or is reset (see resolveSpacing): undefined until it starts */
  private spacing?: GridSpacing;
  /** With atr spacing, the ATR of the last timeframe candle: null until the indicator has its period, and without atr spacing */
  private atr: number | null = null;
  /** Retry limit for order operations */
  private retryLimit = DEFAULT_RETRY_LIMIT;
  /** Failed attempts per level index, refusals and cancels, counted until the level fills */
  private retryCount = new Map<number, number>();
  /** Orders that ended with an unknown outcome, as `SIDE amount at price`: they may be live on the exchange, untracked */
  private untrackedOrders: string[] = [];
  /** Reverse lookup: order ID to level index */
  private orderToLevel = new Map<UUID, number>();
  /** Set by the first candle after the warmup, which starts the grid: it is started once, whatever the outcome */
  private isGridStarted = false;
  /** The side of the grid the price is out on, null in range (see getOutOfRangeSide): logged at each change only */
  private outOfRangeSide: OutOfRangeSide | null = null;
  /** Whether the last fill left orders on one side of the grid only: warned of once, until a fill gives the grid both sides again */
  private isOneSided = false;

  // Rebalance state
  private awaitingRebalance = false;
  private pendingRebalance?: RebalancePlan;
  private rebalanceOrderId?: UUID;
  private rebalanceRetryCount = 0;

  // Reset state (see resetMode)
  /** Whether a reset waits for the orders it canceled to end: the new grid is placed once the last has ended (see rebuildOnceEnded) */
  private awaitingReset = false;
  /** The closes beyond the grid counted towards a reset, in a row on a side resetMode arms: null while none is (see countTowardsReset) */
  private outOfRange: OutOfRangeCount | null = null;
  /** Timeframe candles left of the cooldown of the grid a reset built, not counted towards another reset (see resetCooldownCandles) */
  private cooldownLeft = 0;
  /** The resets started in the run: the number of the last one, which its lines name */
  private resetCount = 0;
  /**
   * When the last reset started, on the wall clock the Trader dates its reads of the balances with (see ExchangeEvent.portfolioReadAt),
   * in a backtest too: a read dated before it may still count as used what the orders the reset canceled reserved (see rebuildOnceEnded)
   */
  private resetStartedAt = 0;

  // Cached price precision
  private priceDecimals = 2;
  private priceStep?: number;
  private priceSignificantDigits?: number;

  /**
   * Reads the pair and the parameters, and refuses to start while orders are open on the pair (see refuseOpenOrders): the grid is
   * started by the first candle after the warmup
   */
  init({ candle, tools, openOrders, addIndicator }: InitParams<GridBotStrategyParams>): void {
    // The first pair watched: the others used to be ignored without a word, while their candles are still required every minute
    this.pair = pickTradedPair(candle, tools);
    const [base, quote] = this.pair.split('/');
    this.base = base;
    this.quote = quote;
    this.reset();
    this.retryLimit = tools.strategyParams.retryOnError;
    // The step of an atr grid is resolved from the ATR of the pair when the grid is built, and again at each reset
    if (tools.strategyParams.spacingType === 'atr') addIndicator('ATR', this.pair, { period: tools.strategyParams.atrPeriod });

    // The grid lives in memory only. Restarted against an exchange that kept the grid of its previous run, GridBot built a second grid
    // beside it, whose fills never reached it, or, the old grid holding the funds, stopped for an insufficient portfolio, again at
    // every restart under a supervisor. Those orders are not adopted: the Trader follows the orders of this run only.
    const open = openOrders?.get(this.pair) ?? [];
    if (open.length) this.refuseOpenOrders(open, tools);
  }

  /**
   * Reads the ATR of an atr grid, then, once the grid is in place, counts the close towards a reset (see countTowardsReset), starts the
   * reset on the close that completes the count (see startReset), and otherwise warns of a close out of the range, once per side
   */
  onEachTimeframeCandle({ candle, portfolio, tools }: OnCandleEventParams<GridBotStrategyParams>, ...indicators: IndicatorResults[]): void {
    // The ATR of the last candle, read on every candle, the warmup included: a grid built or rebuilt between two candles takes it from
    // the candle before
    if (tools.strategyParams.spacingType === 'atr') {
      const results = indicators[0]?.results;
      this.atr = isFiniteNumber(results) ? results : null;
    }
    // No grid in place: not built yet, waiting for its rebalance, or for the orders a reset canceled to end
    if (!this.gridBounds || !this.reentryPrices || this.awaitingRebalance || this.awaitingReset) return;
    const close = candle.get(this.pair)!.close;
    const range = `grid range [${this.gridBounds.min}, ${this.gridBounds.max}]`;

    // The reset says why in its own line, in place of the warning below
    if (this.countTowardsReset(close, range, tools)) return this.startReset(close, range, portfolio, tools);

    // Logged once each time the side of the grid the price is out on changes, back in range at the grid's price next to the bound it
    // left (see getOutOfRangeSide). The warning used to be logged on every timeframe candle out of the range, each one relayed to
    // Telegram: 1440 a day at 1m while the price stayed out of a grid that GridBot does not move.
    const side = getOutOfRangeSide(close, this.gridBounds, this.reentryPrices, this.outOfRangeSide);
    if (side === this.outOfRangeSide) return;
    this.outOfRangeSide = side;

    if (side) {
      const outcome = this.describeOutOfRange(side, this.reentryPrices[side], tools);
      tools.log('warn', `GridBot: Price ${close} is out of ${range}: ${outcome}`);
    } else {
      tools.log('info', `GridBot: Price ${close} is back in ${range}`);
    }
  }

  /**
   * Starts the grid, once, around the close of the first candle after the warmup: a rebalance first if the portfolio needs one.
   * Started from init, the grid was centred on the first candle of the warmup: in realtime a candle of the history replayed at
   * start-up, a year old with 365 daily candles, and the Trader sent that grid live, so the levels the market had moved past
   * executed at once; in a backtest it traded through the warmup.
   */
  onTimeframeCandleAfterWarmup({ candle, portfolio, tools }: OnCandleEventParams<GridBotStrategyParams>): void {
    if (this.isGridStarted) return;
    this.isGridStarted = true;

    const close = candle.get(this.pair)!.close;
    const marketData = tools.marketData.get(this.pair)!;
    const { priceDecimals, priceStep, priceSignificantDigits } = inferPricePrecision(marketData);
    this.priceDecimals = priceDecimals;
    this.priceStep = priceStep;
    this.priceSignificantDigits = priceSignificantDigits;
    // Said before any refusal, which names the tick: a market that states none has its prices rounded to the default decimals, where
    // they used to be rounded to the decimals of the close, whole units for a close of 100
    if (!priceStep) {
      const noTick = `The market data of ${this.pair} states no price tick (precision.price)`;
      const rounded = `the prices of the grid are rounded to ${priceDecimals} decimals`;
      tools.log('warn', `GridBot: ${noTick}: ${rounded}, which the exchange refuses if its own tick is coarser`);
    }

    const centerPrice = roundPrice(close, priceDecimals, priceStep, priceSignificantDigits);

    // An atr grid needs the ATR, which has its first value on its atrPeriod + 1-th candle: started before that candle, the grid would
    // wait for it in silence, up to atrPeriod candles, two weeks on 1d. Refused instead, naming the warmup that gives it
    const { spacingType, atrPeriod } = tools.strategyParams;
    if (spacingType === 'atr' && this.atr === null) {
      const candles = `${atrPeriod + 1} timeframe ${pluralize('candle', atrPeriod + 1)}, the warmup's and the first after it`;
      const needed = `with atrPeriod ${atrPeriod} it needs ${candles}`;
      const warmup = `so set watch.warmup.candleCount to ${atrPeriod} or more`;
      this.stopRun(`The ATR has no value yet on the first candle after the warmup: ${needed}, ${warmup}`, tools);
    }
    this.placeGridAround(centerPrice, portfolio, tools);
  }

  onOrderCompleted({ order, exchange, tools }: OnOrderCompletedEventParams<GridBotStrategyParams>): void {
    // Handle rebalance order completion
    const { asset, currency } = getPortfolioContent(exchange.portfolio, this.base, this.quote);
    if (this.handleRebalanceCompletion(order.id, exchange.price, asset.free, currency.free, tools)) {
      return;
    }

    // Handle grid order completion
    const levelIndex = this.releaseLevel(order.id);
    if (levelIndex === undefined) return;
    // Filled before the cancel of a reset reached it: its level is not turned, the new grid replacing every level, built on the
    // portfolio the fill left
    if (this.awaitingReset) return this.rebuildOnceEnded(exchange, tools);
    this.turnLevel(levelIndex, tools);
  }

  onOrderCanceled({ order, exchange, tools }: OnOrderCanceledEventParams<GridBotStrategyParams>): void {
    // Handle rebalance order cancellation
    if (this.rebalanceOrderId && order.id === this.rebalanceOrderId) {
      const { asset, currency } = getPortfolioContent(exchange.portfolio, this.base, this.quote);
      this.handleRebalanceFailure('Order was canceled', exchange.price, asset, currency, tools);
      return;
    }

    // Handle grid order cancellation
    const levelIndex = this.releaseLevel(order.id);
    if (levelIndex === undefined) return;
    // Canceled by a reset: nothing of it is placed again, the new grid replacing every level, built on the portfolio that holds what it
    // filled first
    if (this.awaitingReset) return this.rebuildOnceEnded(exchange, tools);
    const level = this.levels[levelIndex];

    // What is left of the order is placed again, and the cancel counts as a failed attempt. The whole quantity used to be placed
    // again, the attempts counted from 0: what had filled before the cancel was traded a second time, and an exchange that kept
    // canceling the order (self-trade prevention, a cancel by hand) brought it back without end. A fill no answer of the exchange
    // reported reaches the strategy undefined (see OrderCanceledEvent): the order is then placed again whole.
    const { filled, remaining } = order;
    const isFillReported = isFiniteNumber(filled);
    const left = isFillReported ? addPrecise(level.amount, -filled) : level.amount;
    // Reported filled in full, or with less left than the market takes in an order: the level turns to its other side, as after a
    // fill. Such a remainder used to be placed again, refused at every attempt, and the level gave up holding the part filled.
    const price = this.priceOf(level);
    const minimumAmount = getMinimumAmount(price, tools.marketData.get(this.pair)!);
    if (left < minimumAmount) {
      if (left > 0) {
        const under = `${left} left, under the market minimum of ${minimumAmount}`;
        tools.log(
          'info',
          `GridBot: ${level.side} at ${price} was canceled with ${under}: its level turns to its other side, as after a fill`,
        );
      }
      return this.turnLevel(levelIndex, tools);
    }

    const fill = isFillReported ? `filled: ${filled}, remaining: ${remaining}` : 'no fill reported';
    const isPlacedAgain = this.placeAgain(levelIndex, left, `Order was canceled (${fill})`, tools);
    if (isPlacedAgain && !isFillReported) {
      const canceled = `${level.side} at ${price} was canceled with no fill reported`;
      tools.log('warn', `GridBot: ${canceled}: it is placed again whole, ${left}, which trades again any part of it that had filled`);
    }
  }

  onOrderErrored({ order, exchange, tools }: OnOrderErroredEventParams<GridBotStrategyParams>): void {
    // Handle rebalance order error
    if (this.rebalanceOrderId && order.id === this.rebalanceOrderId) {
      // A rebalance used to be planned and placed again whatever the error: one whose outcome is unknown may be live on the exchange,
      // untracked, and both filled, the portfolio was rebalanced twice. No grid order is open yet: the run stops, for the user to
      // check that one order before starting again.
      if (order.mayBeLive) {
        const plan = this.pendingRebalance;
        const rebalance = plan ? `The rebalance, a STICKY ${plan.side} of ${plan.amount},` : 'The rebalance';
        const untracked = `${rebalance} may be live on the exchange without GridBot tracking it: the grid is not built`;
        this.stopRun(`${untracked}. Check it on the exchange. Last error: ${order.reason}`, tools);
      }
      const { asset, currency } = getPortfolioContent(exchange.portfolio, this.base, this.quote);
      this.handleRebalanceFailure(order.reason ?? 'Unknown error', exchange.price, asset, currency, tools);
      return;
    }

    // Handle grid order error
    const levelIndex = this.releaseLevel(order.id);
    if (levelIndex === undefined) return;
    const level = this.levels[levelIndex];

    // Ended in error during a reset: not placed again, the new grid replacing every level. One that may be live is left untracked
    // all the same (see leaveUntracked), which stops the run at the latest where the new grid would be built over it (see rebuild)
    if (this.awaitingReset) {
      if (order.mayBeLive) this.leaveUntracked(level, order.reason, tools);
      return this.rebuildOnceEnded(exchange, tools);
    }

    // Any error used to place the order again. One that may be live on the exchange, where nothing tracks it any more, its creation
    // lost on the network or its poll failed for good, was doubled: two lots bought or sold where the level holds one, or the copy
    // refused for want of the reserve the first one holds. The order says whether it may be (OrderErroredEvent.mayBeLive); any other
    // error is a refusal: placed again, as refused.
    if (order.mayBeLive) return this.leaveUntracked(level, order.reason, tools);
    this.placeAgain(levelIndex, level.amount, order.reason, tools);
  }

  /** Reset all internal state */
  private reset(): void {
    this.isGridStarted = false;
    this.outOfRangeSide = null;
    this.isOneSided = false;
    this.levels = [];
    this.gridBounds = undefined;
    this.reentryPrices = undefined;
    this.quantity = 0;
    this.spacing = undefined;
    this.atr = null;
    this.retryCount.clear();
    this.untrackedOrders = [];
    this.orderToLevel.clear();
    this.awaitingRebalance = false;
    this.pendingRebalance = undefined;
    this.rebalanceOrderId = undefined;
    this.rebalanceRetryCount = 0;
    this.awaitingReset = false;
    this.outOfRange = null;
    this.cooldownLeft = 0;
    this.resetCount = 0;
    this.resetStartedAt = 0;
  }

  /** The levels and the spacing the grid is built with (see GridLayout): the parameters, their spacing resolved (see resolveSpacing) */
  private getLayout({ strategyParams }: Tools<GridBotStrategyParams>): GridLayout {
    const { buyLevels, sellLevels } = strategyParams;
    return { buyLevels, sellLevels, ...this.spacing! };
  }

  /**
   * Resolves the spacing the grid is built with around the center price (see resolveSpacing), when it starts and at each reset, an atr
   * step from the ATR of the last timeframe candle: an atr step raised to the minimum step is warned of
   */
  private resolveSpacing(centerPrice: number, marketData: MarketData, tools: Tools<GridBotStrategyParams>): void {
    const { spacing, warning } = resolveSpacing(tools.strategyParams, centerPrice, marketData, this.atr);
    if (warning) tools.log('warn', `GridBot: ${warning}`);
    this.spacing = spacing;
  }

  /**
   * Places the grid around the center price, when it starts and at each reset (see rebuild): its spacing resolved there (see
   * resolveSpacing), the grid checked there (see validateConfig), then a rebalance first if the free balances need one (see prepareGrid)
   */
  private placeGridAround(centerPrice: number, portfolio: Portfolio, tools: Tools<GridBotStrategyParams>): void {
    const marketData = tools.marketData.get(this.pair)!;
    this.resolveSpacing(centerPrice, marketData, tools);
    const layout = this.getLayout(tools);

    const validationError = validateConfig(layout, centerPrice, marketData);
    if (validationError) this.stopRun(validationError, tools);
    // A spacing under the round-trip fee makes a grid that loses money at each round trip of a level: a bad grid, not an impossible
    // one, placed all the same, after one warning
    const feeWarning = checkRoundTripFee(layout, centerPrice, marketData);
    if (feeWarning) tools.log('warn', `GridBot: ${feeWarning}`);

    // Always attempt rebalancing first
    this.prepareGrid(centerPrice, portfolio, tools);
  }

  /**
   * Counts the close towards a reset of the grid (see resetMode), and says whether it completes the count, resetConfirmCandles closes
   * in a row: a close beyond a bound on a side resetMode arms adds one to the closes of that side, and any other, back in the range, a
   * bound included, or out on a side not armed, starts the count again. None is counted in the cooldown of a grid a reset built (see
   * resetCooldownCandles). A close counted short of the count is logged at debug.
   */
  private countTowardsReset(close: number, range: string, tools: Tools<GridBotStrategyParams>): boolean {
    if (this.cooldownLeft > 0) {
      this.cooldownLeft--;
      return false;
    }

    // Beyond the bounds themselves, not the side of the warning (see getOutOfRangeSide), which keeps a price back in the range between
    // a bound and the grid's price next to it on the side it left: a wick back in the range would not start the count again
    const { resetMode, resetConfirmCandles } = tools.strategyParams;
    const { min, max } = this.gridBounds!;
    const side = close > max ? 'above' : close < min ? 'below' : null;
    if (!side || !isResetSide(resetMode, side)) {
      this.outOfRange = null;
      return false;
    }

    const count = this.outOfRange?.side === side ? this.outOfRange.count + 1 : 1;
    this.outOfRange = { side, count };
    if (count >= resetConfirmCandles) return true;
    const towards = `${count} of ${resetConfirmCandles} consecutive timeframe ${pluralize('candle', resetConfirmCandles)} towards a reset`;
    tools.log('debug', `GridBot: Price ${close} closed ${side} ${range}: ${towards}`);
    return false;
  }

  /**
   * Starts a reset once the closes counted towards it complete the count (see countTowardsReset): every open order of the grid is
   * canceled, and the new grid is placed once the last has ended (see rebuildOnceEnded), at once around the close when none is open.
   * Over an order that may be live untracked, the line says that the run stops instead, where the new grid would be built (see rebuild).
   */
  private startReset(close: number, range: string, portfolio: Portfolio, tools: Tools<GridBotStrategyParams>): void {
    const { side, count } = this.outOfRange!;
    this.awaitingReset = true;
    this.resetCount++;
    this.resetStartedAt = Date.now();
    this.outOfRange = null;

    const candles = `${count} consecutive timeframe ${pluralize('candle', count)}`;
    const closed = `Price ${close} closed ${side} ${range} for ${candles} (resetConfirmCandles): reset ${this.resetCount}`;
    const open = this.levels.filter(({ orderId }) => orderId);
    // Over an order that may be live untracked, the rebuild refuses the new grid (see rebuild): the line used to announce it all the
    // same, relayed to Telegram, and the run then stopped with every order of the grid canceled. It names the stop to come instead.
    const stop = this.untrackedOrders.length ? this.describeUntrackedStop() : undefined;
    // Kept for completeness: a grid whose levels all gave up on their orders, or left them untracked, stopped the run before
    if (!open.length) {
      const next = stop ? `and ${stop}` : `a new grid is built around ${close}`;
      tools.log('info', `GridBot: ${closed}, no order is open, ${next}`);
      return this.rebuild(close, portfolio, tools);
    }

    const canceled = `its ${open.length} open ${pluralize('order', open.length)} ${open.length === 1 ? 'is' : 'are'} canceled`;
    const ended = `once ${open.length === 1 ? 'it has' : 'they have'} ended`;
    const next = stop ? `, then ${stop}` : ` and a new grid is built around the price ${ended}`;
    tools.log('info', `GridBot: ${closed}, ${canceled}${next}`);
    for (const { orderId } of open) tools.cancelOrder(orderId!);
  }

  /**
   * Places the grid of a reset once the last order it canceled has ended, canceled, filled or in error (see rebuild): around the price
   * of that last event, on the portfolio it carries, which holds what the canceled orders filled first. The Trader reads that portfolio
   * after the order ended, best effort: when the read fails, the event carries the read before it, in which what the canceled orders
   * reserved may still count as used, left out of the new grid (see prepareGrid). A read dated before the reset started, or not dated,
   * is warned of, and the grid built on the rest all the same: the warning gives its cause to a smaller grid, or to a stop for an
   * insufficient portfolio.
   */
  private rebuildOnceEnded({ price, portfolio, portfolioReadAt }: ExchangeEvent, tools: Tools<GridBotStrategyParams>): void {
    if (this.orderToLevel.size > 0) return;
    // Not over an order that may be live untracked, which stops the run instead (see rebuild): no grid is built on any balance then
    const isReadBeforeReset = portfolioReadAt === undefined || portfolioReadAt < this.resetStartedAt;
    if (isReadBeforeReset && !this.untrackedOrders.length) {
      const unread = `The Trader could not read the balances after the cancels of reset ${this.resetCount}`;
      const locked = 'what the canceled orders held may still count as locked in other orders, and the grid is built on the rest';
      const restart = 'a restart builds it on the balances as they are';
      tools.log('warn', `GridBot: ${unread}, its last read predating the reset: ${locked}; ${restart}`);
    }
    this.rebuild(price, portfolio, tools);
  }

  /**
   * Places a new grid around `price` once a reset has ended the orders of the grid, as at the start (see placeGridAround): the free
   * balances rebalanced to the split of the new grid, which realizes what the breakout lost, then the grid built, an atr step resolved
   * again. Its first resetCooldownCandles timeframe candles are not counted towards another reset. An order of the grid that may be
   * live on the exchange untracked (see leaveUntracked), from before the reset or during it, stops the run instead: the new grid would
   * trade beside it, on funds it may hold.
   */
  private rebuild(price: number, portfolio: Portfolio, tools: Tools<GridBotStrategyParams>): void {
    if (this.untrackedOrders.length) {
      const { untracked, them } = this.describeUntracked();
      this.stopRun(`${untracked}: the grid of reset ${this.resetCount} is not built over ${them}. Check ${them} on the exchange`, tools);
    }

    // Every level of the new grid is built from nothing, as at the start, the rebalance state being idle already
    this.awaitingReset = false;
    this.cooldownLeft = tools.strategyParams.resetCooldownCandles;
    this.levels = [];
    this.gridBounds = undefined;
    this.reentryPrices = undefined;
    this.quantity = 0;
    this.retryCount.clear();
    this.orderToLevel.clear();
    this.outOfRangeSide = null;
    this.isOneSided = false;
    this.outOfRange = null;

    const centerPrice = roundPrice(price, this.priceDecimals, this.priceStep, this.priceSignificantDigits);
    this.placeGridAround(centerPrice, portfolio, tools);
  }

  /**
   * What the grid does while the price is out of its range on `side`, as the warning says it: it stays in place, its orders waiting for
   * the price to come back to `reentryPrice`, unless resetMode arms a reset on that side (see isResetSide). It then stays for the
   * candles left of the cooldown of a grid a reset built (see resetCooldownCandles), or until resetConfirmCandles closes in a row
   * beyond it reset it, from the candle that ends the cooldown on: that one is not counted, the next ones are.
   */
  private describeOutOfRange(side: OutOfRangeSide, reentryPrice: number, tools: Tools<GridBotStrategyParams>): string {
    const { resetMode, resetConfirmCandles, resetCooldownCandles } = tools.strategyParams;
    const waiting = `its orders waiting for the price to come back to ${reentryPrice}`;
    if (!isResetSide(resetMode, side)) return `the grid stays in place, ${waiting}`;
    if (this.cooldownLeft > 0) {
      const left = `${this.cooldownLeft} timeframe ${pluralize('candle', this.cooldownLeft)} left of its cooldown`;
      return `the grid stays in place for the ${left} (resetCooldownCandles ${resetCooldownCandles}), ${waiting}`;
    }
    const candles = `${resetConfirmCandles} consecutive timeframe ${pluralize('candle', resetConfirmCandles)}`;
    const close = resetConfirmCandles === 1 ? 'closes' : 'close';
    return `the grid is reset once ${candles} ${close} ${side} it (resetConfirmCandles), ${waiting} until then`;
  }

  /**
   * Rebalances the portfolio if it needs it, or builds the grid directly. Both use the free balances, which the grid's orders can
   * use. The rebalance used to be planned on the total balances, funds locked in other orders included: a portfolio whose free part
   * funded no grid was found balanced, and the run stopped for an insufficient portfolio, or a balanced free part was rebalanced
   * by trading it against the locked funds, and the grid built on half of it.
   */
  private prepareGrid(centerPrice: number, portfolio: Portfolio, tools: Tools<GridBotStrategyParams>): void {
    const { asset, currency } = getPortfolioContent(portfolio, this.base, this.quote);
    const locked = [asset.used > 0 && `${asset.used} ${this.base}`, currency.used > 0 && `${currency.used} ${this.quote}`].filter(Boolean);
    if (locked.length) {
      const free = `the free balances only, ${asset.free} ${this.base} and ${currency.free} ${this.quote}`;
      tools.log('info', `GridBot: ${locked.join(' and ')} locked in other orders, left out: the rebalance and the grid use ${free}`);
    }

    this.rebalanceRetryCount = 0;
    this.rebalanceOrBuild(centerPrice, asset, currency, tools);
  }

  /**
   * Places the rebalance the free balances call for, or builds the grid on them as they are: when they need none, when the market
   * would refuse the rebalance, under its minimum order, or when they cannot pay for it. A rebalance planned again after a failed one
   * comes with its `failure`, warned of with what follows it: the rebalance placed again, the grid built, or the run stopped.
   */
  private rebalanceOrBuild(
    centerPrice: number,
    asset: BalanceDetail,
    currency: BalanceDetail,
    tools: Tools<GridBotStrategyParams>,
    failure?: string,
  ): void {
    const layout = this.getLayout(tools);
    const { priceDecimals, priceStep, priceSignificantDigits } = this;
    const marketData = tools.marketData.get(this.pair)!;
    const plan = computeRebalancePlan(centerPrice, asset.free, currency.free, layout, marketData);
    const leftOut = plan ? this.getRebalanceLeftOut(plan, asset, currency, marketData) : undefined;
    const isPlaced = plan && !leftOut;

    // The start checked the grid around its own center price (see validateConfig), while a plan made again after a failed rebalance
    // is centred on the price the rebalance ended at. There, its STICKY order was sent for a grid the start would have refused: its
    // BUYs at or below 0 left out without a word, or two of its prices on one tick, a percent or logarithmic step shrinking with the
    // price, which the build refused only once that second rebalance had been paid. Refused before the plan is placed, as at the
    // start: the lowest BUY, then the prices of the grid the rebalance pays for against the tick. A grid built without a rebalance is
    // checked on the levels it builds (see buildGrid).
    const gridError =
      checkLowestBuyPrice(layout, centerPrice, priceDecimals, priceStep, priceSignificantDigits) ??
      (isPlaced ? checkPriceTick(layout, centerPrice, priceDecimals, priceStep, priceSignificantDigits) : null);
    if (gridError) {
      if (failure)
        tools.log('warn', `GridBot: ${failure}. Not placed again: the grid is refused around ${centerPrice}, the price it ended at`);
      this.stopRun(gridError, tools);
    }

    if (isPlaced) {
      if (failure) tools.log('warn', `GridBot: ${failure}. Retrying...`);
      this.awaitingRebalance = true;
      this.pendingRebalance = plan;
      this.placeRebalanceOrder(tools);
      return;
    }

    if (failure) {
      const built = leftOut
        ? 'the grid is built on the free balances it left'
        : 'the free balances it left need no rebalance, the grid is built on them';
      tools.log('warn', `GridBot: ${failure}. Not placed again: ${built}`);
    }
    if (leftOut) tools.log(leftOut.level, `GridBot: ${leftOut.message}`);
    this.awaitingRebalance = false;
    this.pendingRebalance = undefined;
    this.buildGrid(centerPrice, asset.free, currency.free, tools);
  }

  /**
   * Why the rebalance is not to be sent, as the line to log, undefined to send it: the market would refuse it, or the free balances
   * cannot pay for it
   */
  private getRebalanceLeftOut(
    plan: RebalancePlan,
    asset: BalanceDetail,
    currency: BalanceDetail,
    marketData: MarketData,
  ): { level: LogLevel; message: string } | undefined {
    // A rebalance under the market's minimum, a gap between the 1 % tolerance and cost.min on a small account, used to be sent and
    // refused, planned again identically at every attempt, until the run stopped, while the portfolio as it was funded a grid
    const minimumAmount = getMinimumAmount(getRebalanceOrderPrice(plan.side, plan.centerPrice, marketData), marketData);
    if (plan.amount < minimumAmount) {
      const under = `its ${plan.side} of ${plan.amount} ${this.base} being under the market minimum of ${minimumAmount} ${this.base}`;
      return { level: 'info', message: `No rebalance, ${under}: the grid is built on the free balances as they are` };
    }
    if (plan.side === 'SELL' && plan.amount > asset.free)
      return { level: 'warn', message: 'Insufficient asset for rebalance, building grid with current allocation' };
    // What the BUY takes from the free currency once placed, not its notional at the center price: a BUY whose notional was all
    // the free currency passed, to be refused at every attempt for its fee and the price of its STICKY order
    if (plan.side === 'BUY' && getRebalanceBuyCost(plan.amount, plan.centerPrice, marketData) > currency.free)
      return { level: 'warn', message: 'Insufficient currency for rebalance, building grid with current allocation' };
    return undefined;
  }

  /** Place the rebalance STICKY order */
  private placeRebalanceOrder(tools: Tools<GridBotStrategyParams>): void {
    if (!this.pendingRebalance) return;

    const { side, amount } = this.pendingRebalance;
    this.rebalanceOrderId = tools.createOrder({ type: 'STICKY', side, amount, symbol: this.pair });
    tools.log('info', `GridBot: Rebalancing - ${side} ${amount} (STICKY order)`);
  }

  /** Handle successful rebalance order completion */
  private handleRebalanceCompletion(
    orderId: UUID,
    currentPrice: number,
    assetFree: number,
    currencyFree: number,
    tools: Tools<GridBotStrategyParams>,
  ): boolean {
    if (!this.pendingRebalance || this.rebalanceOrderId !== orderId) return false;

    this.awaitingRebalance = false;
    this.rebalanceOrderId = undefined;
    this.rebalanceRetryCount = 0;
    this.pendingRebalance = undefined;

    tools.log('info', 'GridBot: Rebalance complete, building grid');

    const centerPrice = roundPrice(currentPrice, this.priceDecimals, this.priceStep, this.priceSignificantDigits);
    this.buildGrid(centerPrice, assetFree, currencyFree, tools);

    return true;
  }

  /** Handle rebalance order failure */
  private handleRebalanceFailure(
    reason: string,
    currentPrice: number,
    asset: BalanceDetail,
    currency: BalanceDetail,
    tools: Tools<GridBotStrategyParams>,
  ): void {
    this.rebalanceRetryCount++;
    this.rebalanceOrderId = undefined;

    // A rebalance that failed at every attempt stops the run. A grid used to follow, built anyway on the portfolio as it was, after a
    // tools.log('error') that had already thrown: it never ran. Not rebalanced, the portfolio would size every level on its scarcer
    // side, the rest left idle, or fund none.
    if (this.rebalanceRetryCount > this.retryLimit) {
      const failure = `Rebalance failed after ${this.rebalanceRetryCount} attempts (retryOnError: ${this.retryLimit})`;
      this.stopRun(`${failure}: the grid is not built. Last error: ${reason}`, tools);
    }

    // Planned again on the free balances the failure left, a partial fill included, with the checks of the first plan: the plan
    // used to be placed again unchecked. The failure is warned of with what follows it (see rebalanceOrBuild): it read "Retrying..."
    // first, whatever followed, the grid built on the balances left or the run stopped
    const failure = `Rebalance attempt ${this.rebalanceRetryCount} failed: ${reason}`;
    const centerPrice = roundPrice(currentPrice, this.priceDecimals, this.priceStep, this.priceSignificantDigits);
    this.rebalanceOrBuild(centerPrice, asset, currency, tools, failure);
  }

  /** Build the grid around the center price */
  private buildGrid(centerPrice: number, assetFree: number, currencyFree: number, tools: Tools<GridBotStrategyParams>): void {
    const { buyLevels, sellLevels } = tools.strategyParams;
    const { spacingType, spacingValue } = this.spacing!;
    const { priceDecimals, priceStep, priceSignificantDigits } = this;

    // A grid rebalanced first is built around the price the rebalance ended at, which the start did not check. Lower, a fixed grid
    // started with its lowest BUY a few ticks above 0 put it at or below 0: the sizing left that level out, with a warning that the
    // free balances funded no more orders of the market minimum, or stopped the run for an insufficient portfolio when no other level
    // was left. Refused before the sizing, as at the start.
    const lowestBuyError = checkLowestBuyPrice(this.getLayout(tools), centerPrice, priceDecimals, priceStep, priceSignificantDigits);
    if (lowestBuyError) this.stopRun(lowestBuyError, tools);

    const marketData = tools.marketData.get(this.pair)!;

    // Derive the quantity per level, and the levels the free balances fund with orders the market takes (see deriveLevelQuantity)
    const size = deriveLevelQuantity(
      centerPrice,
      assetFree,
      currencyFree,
      buyLevels,
      sellLevels,
      priceDecimals,
      spacingType,
      spacingValue,
      marketData,
      priceStep,
      priceSignificantDigits,
    );
    const free = `${assetFree} ${this.base} and ${currencyFree} ${this.quote} free`;
    if (size.quantity <= 0) this.stopRun(`Insufficient portfolio for any grid levels: ${free} fund no order the market takes`, tools);

    // The start checked the prices of the grid around its own center price, but a grid rebalanced first is built around the price the
    // rebalance ended at, where a percent or logarithmic step, which shrinks with the price, can round two adjacent prices to one tick
    const levelsBuilt = { ...this.spacing!, buyLevels: size.buyLevels, sellLevels: size.sellLevels };
    const tickError = checkPriceTick(levelsBuilt, centerPrice, priceDecimals, priceStep, priceSignificantDigits);
    if (tickError) this.stopRun(tickError, tools);

    // Bounds of the levels built
    const bounds = computeGridBounds(
      centerPrice,
      size.buyLevels,
      size.sellLevels,
      priceDecimals,
      spacingType,
      spacingValue,
      priceStep,
      priceSignificantDigits,
    );
    if (!bounds) this.stopRun('Could not compute valid grid bounds', tools);

    const leftOut = [
      size.buyLevels < buyLevels && `${buyLevels - size.buyLevels} of the ${buyLevels} buy levels`,
      size.sellLevels < sellLevels && `${sellLevels - size.sellLevels} of the ${sellLevels} sell levels`,
    ].filter(Boolean);
    if (leftOut.length) {
      const minimum = `the market minimum, ${size.minimumAmount} ${this.base} at ${bounds.min}, the lowest price of the grid`;
      tools.log(
        'warn',
        `GridBot: ${leftOut.join(' and ')} left out, the farthest from the center price: ${free} fund no more orders of ${minimum}`,
      );
    }

    const priceAt = (steps: number) =>
      computeLevelPrice(centerPrice, steps, priceDecimals, spacingType, spacingValue, priceStep, priceSignificantDigits);
    this.gridBounds = bounds;
    // One price inside each bound: the sell price of the lowest level, the buy price of the highest
    this.reentryPrices = { below: priceAt(1 - size.buyLevels), above: priceAt(size.sellLevels - 1) };
    this.quantity = size.quantity;
    // Built around the center price, in range and with no fill yet
    this.outOfRangeSide = null;
    this.isOneSided = false;

    // Build level states, each between two adjacent prices of the grid, the center price being the top of level -1 and the bottom
    // of level 1
    this.levels = [];
    this.orderToLevel.clear();
    this.retryCount.clear();

    // Create buy levels (negative indices, stored first), which start with their BUY: every one above 0, the lowest checked first
    for (let i = size.buyLevels; i >= 1; i--) {
      this.levels.push({ index: -i, buyPrice: priceAt(-i), sellPrice: priceAt(1 - i), side: 'BUY', amount: this.quantity });
    }

    // Create sell levels (positive indices), which start with their SELL, above the center price
    for (let i = 1; i <= size.sellLevels; i++) {
      this.levels.push({ index: i, buyPrice: priceAt(i - 1), sellPrice: priceAt(i), side: 'SELL', amount: this.quantity });
    }

    // Place initial orders
    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i];
      this.placeOrder(i, level.side, tools);
    }

    const levels = `${size.buyLevels} buy / ${size.sellLevels} sell levels`;
    tools.log('info', `GridBot: Grid built around ${centerPrice} with ${levels}, qty=${this.quantity}`);
  }

  /**
   * Place a LIMIT order for a level, at its buy or sell price, for the quantity of a level unless told otherwise: the level takes the
   * side and the amount of the order
   */
  private placeOrder(levelArrayIndex: number, side: OrderSide, tools: Tools<GridBotStrategyParams>, amount = this.quantity): void {
    const level = this.levels[levelArrayIndex];
    if (!level || level.orderId) return;

    const orderId = tools.createOrder({
      type: 'LIMIT',
      side,
      amount,
      price: side === 'BUY' ? level.buyPrice : level.sellPrice,
      symbol: this.pair,
    });

    // A fill turns its level to the other side. The level used to keep the side the grid was built with, so a canceled or errored
    // order a fill had armed came back on the other side: a BUY above the market or a SELL below it, which executed at once or,
    // unfunded, was refused on every retry. The one-side warning read the same stale sides.
    level.orderId = orderId;
    level.side = side;
    level.amount = amount;
    this.orderToLevel.set(orderId, levelArrayIndex);
  }

  /** The array index of the level that held the order, which no longer holds it: undefined for an order that is not the grid's */
  private releaseLevel(orderId: UUID): number | undefined {
    const levelIndex = this.orderToLevel.get(orderId);
    if (levelIndex === undefined) return undefined;

    this.orderToLevel.delete(orderId);
    this.levels[levelIndex].orderId = undefined;
    return levelIndex;
  }

  /** Turns a level whose order filled to its other side, for the quantity of a level: its failed attempts are forgotten */
  private turnLevel(levelIndex: number, tools: Tools<GridBotStrategyParams>): void {
    const level = this.levels[levelIndex];
    this.retryCount.delete(levelIndex);

    // The level that filled turns to the other side, one step away: a SELL above the BUY, a BUY below the SELL. A fill used to arm
    // the neighbouring level, and only if it held no order: a neighbour whose own fill was not reported yet was skipped, so a drop
    // through several BUYs re-armed when a backtest reported them highest first but not when paper or live trading polled them lowest
    // first, and the two levels next to the center price, each the other's neighbour, armed nothing on their first fill.
    this.placeOrder(levelIndex, level.side === 'BUY' ? 'SELL' : 'BUY', tools);

    // Warned of once, until a fill gives the grid both sides again. It was warned of after every fill that left one side, so after
    // every fill of a grid holding a single order: one whose free balances fund a single level, or whose other levels gave up.
    const isOneSided = hasOnlyOneSide(this.levels);
    if (isOneSided && !this.isOneSided) tools.log('warn', 'GridBot: Only one side of the grid remains active');
    this.isOneSided = isOneSided;
  }

  /**
   * Places a level's order again, for `amount`, once it was refused or canceled. Each counts as a failed attempt until the level fills,
   * and the level gives up once the first attempt and retryOnError retries failed (see giveUpLevel). Returns whether it was placed.
   */
  private placeAgain(levelIndex: number, amount: number, reason: string, tools: Tools<GridBotStrategyParams>): boolean {
    const level = this.levels[levelIndex];
    const attempts = (this.retryCount.get(levelIndex) ?? 0) + 1;
    if (attempts > this.retryLimit) {
      this.giveUpLevel(level, attempts, reason, tools);
      return false;
    }

    this.retryCount.set(levelIndex, attempts);
    this.placeOrder(levelIndex, level.side, tools, amount);
    return true;
  }

  /** The price of the order placed last on the level */
  private priceOf(level: LevelState): number {
    return level.side === 'BUY' ? level.buyPrice : level.sellPrice;
  }

  /**
   * Leaves a level without an order once its order failed at every attempt, the first and retryOnError retries: the rest of the grid
   * trades on, and the run stops once no level holds an order. A level used to give up through tools.log('error'), which throws: the
   * first one to give up stopped the bot, with a message naming an array index rather than the order.
   */
  private giveUpLevel(level: LevelState, attempts: number, reason: string, tools: Tools<GridBotStrategyParams>): void {
    const failure = `${level.side} at ${this.priceOf(level)} failed after ${attempts} attempts (retryOnError: ${this.retryLimit})`;
    if (this.levels.every(({ orderId }) => !orderId))
      this.stopRun(`${failure}: no level of the grid holds an order any more. Last error: ${reason}`, tools);
    tools.log('warn', `GridBot: ${failure}: its level is left without an order, the rest of the grid trades on. Last error: ${reason}`);
  }

  /**
   * Leaves a level without an order for good once its order ended with an unknown outcome: it may be live on the exchange, where
   * nothing tracks it any more, and placed again it could trade twice. The rest of the grid trades on. The run stops once more
   * orders than retryOnError ended so, many orders the bot may have lost track of, or once no level holds an order.
   */
  private leaveUntracked(level: LevelState, reason: string, tools: Tools<GridBotStrategyParams>): void {
    const order = `${level.side} ${level.amount} at ${this.priceOf(level)}`;
    this.untrackedOrders.push(order);
    const count = this.untrackedOrders.length;
    const { untracked, them } = this.describeUntracked();
    const check = `Check ${them} on the exchange. Last error: ${reason}`;
    if (count > this.retryLimit)
      this.stopRun(`${untracked}: ${count} orders, more than retryOnError (${this.retryLimit}). ${check}`, tools);
    if (this.levels.every(({ orderId }) => !orderId))
      this.stopRun(`${untracked}, and no level of the grid holds an order any more. ${check}`, tools);

    const left = 'it is not placed again, its level is left without an order, the rest of the grid trades on';
    tools.log(
      'warn',
      `GridBot: ${order} may be live on the exchange without GridBot tracking it: ${left}. Check it there. Last error: ${reason}`,
    );
  }

  /** The orders that may be live on the exchange untracked (see leaveUntracked), as the messages name them, and `it` or `them` */
  private describeUntracked(): { untracked: string; them: string } {
    const them = this.untrackedOrders.length > 1 ? 'them' : 'it';
    return { untracked: `${this.untrackedOrders.join(', ')} may be live on the exchange without GridBot tracking ${them}`, them };
  }

  /** The stop a reset comes to over the orders that may be live untracked (see rebuild), as the line that starts it says it */
  private describeUntrackedStop(): string {
    const { untracked, them } = this.describeUntracked();
    return `the run stops: ${untracked}, and no grid is built over ${them}`;
  }

  /**
   * Stops the run on the orders open on the pair at start-up (see init), naming each one, as the exchange lists them, for the user to
   * find it there and cancel it: its type, side, the amount it has left to execute, its price and its id
   */
  private refuseOpenOrders(orders: OpenOrder[], tools: Tools<GridBotStrategyParams>): never {
    const count = orders.length === 1 ? '1 order is' : `${orders.length} orders are`;
    const list = orders.map(({ id, side, type, price, remaining }) => `${type} ${side} ${remaining} at ${price ?? 'market'} (id ${id})`);
    const unfollowed = [
      'GridBot keeps its grid in memory and follows only the orders it places: an order placed before this run, by a previous run,',
      'by hand or by another bot, would trade beside the new grid without GridBot hearing of its fills.',
    ].join(' ');
    const cancel = `Cancel the orders open on ${this.pair} on the exchange, then start again`;
    this.stopRun(`${count} open on ${this.pair} at start-up: ${list.join(', ')}. ${unfollowed} ${cancel}`, tools);
  }

  /**
   * Stops the run with the message, logged and relayed at error level: tools.log('error') throws a GekkoError. GridBot places its
   * grid when it starts, and again only when it is reset (see resetMode), so a grid it cannot place, or one without any order left,
   * would leave it idle, for the rest of the run or until a reset.
   */
  private stopRun(message: string, tools: Tools<GridBotStrategyParams>): never {
    tools.log('error', `GridBot: ${message}`);
    // Not reached, tools.log('error') throwing first: it makes the stop explicit, to the compiler and with a log that would return
    throw new GekkoError('strategy', `GridBot: ${message}`);
  }
}
