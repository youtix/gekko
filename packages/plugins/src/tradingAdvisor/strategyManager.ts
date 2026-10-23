import {
  STRATEGY_CANCEL_ORDER_EVENT,
  STRATEGY_CREATE_ORDER_EVENT,
  STRATEGY_INFO_EVENT,
  STRATEGY_WARMUP_COMPLETED_EVENT,
  TRAILING_STOP_ACTIVATED,
  TRAILING_STOP_TRIGGERED,
} from '@gekko/shared/constants/event.const';
import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { ApplicationStopError } from '@gekko/shared/errors/applicationStop.error';
import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { getBucketTimestamp, getFirstCandleFromBucket } from '@gekko/shared/helpers/candle/candle.helper';
import { clonePortfolio } from '@gekko/shared/helpers/portfolio/portfolio.helper';
import { isReadBeforeEnd, isSellable } from '@gekko/strategies/helpers/positionTracker/positionTracker.helper';
import * as indicators from '@gekko/indicators/index';
import { Indicator } from '@gekko/indicators/indicator';
import { IndicatorNames, IndicatorParameters } from '@gekko/indicators/indicator.types';
import { AdviceCancelOrder, AdviceOrder, StrategyOrder, TrailingConfig } from '@gekko/shared/models/advice.types';
import {
  CandleBucket,
  ExchangeEvent,
  OrderCanceledEvent,
  OrderCompletedEvent,
  OrderErroredEvent,
  OrderInitiatedEvent,
} from '@gekko/shared/models/event.types';
import { LogLevel } from '@gekko/shared/models/logLevel.types';
import { BalanceDetail, Portfolio } from '@gekko/shared/models/portfolio.types';
import { StrategyInfo } from '@gekko/shared/models/strategyInfo.types';
import { Asset, TradingPair } from '@gekko/shared/models/utility.types';
import type { Configuration } from '@gekko/schemas/configuration/configuration.types';
import { MarketData, OpenOrder } from '@gekko/shared/models/exchange.types';
import { debug, error, info, warning } from '@gekko/core/logger/logger';
import * as strategies from '@gekko/strategies/index';
import { toISOString } from '@gekko/shared/utils/date/date.utils';
import { addPrecise, isFiniteNumber } from '@gekko/shared/utils/math/math.utils';
import { pluralize } from '@gekko/shared/utils/string/string.utils';
import { bindAll, cloneDeep, isString, omit } from 'lodash-es';
import { randomUUID, UUID } from 'node:crypto';
import EventEmitter from 'node:events';
import { isAbsolute, resolve } from 'node:path';
import { inspect } from 'node:util';
import { z } from 'zod';
import { IndicatorResults, Strategy, StrategyConstructor, Tools } from '@gekko/strategies/strategy.types';
import { MAX_PENDING_ORDERS, MESSAGE_INSPECT_OPTIONS } from './strategyManager.const';
import {
  copyBucket,
  copyOrderEvent,
  copyResult,
  describeSale,
  describeUnreadBalances,
  getKeysProblem,
  getOrderProblem,
  getPairProblem,
  getParametersProblem,
  getTrailingProblem,
} from './strategyManager.helper';
import { OrderRecord } from './strategyManager.types';
import { TrailingStopManager } from './trailingStopManager';
import { TrailingStopState } from '@gekko/strategies/trailingStopManager.types';

export class StrategyManager extends EventEmitter {
  private readonly warmupPeriod: number;
  private readonly maxConsecutiveErrors: number;
  private readonly trailingStopManager: TrailingStopManager;

  /** The timeframe candles processed, counted up to the one that completes the warmup (see onTimeFrameCandle) */
  private age = 0;
  /** Set once init has run, on the first one-minute bucket, never reset: addIndicator refuses indicators from then on */
  private isInitialized = false;
  /** Set as the warmup event is emitted, never reset: createOrder refuses orders until then */
  private isWarmupCompleted = false;
  private indicators: { indicator: Indicator; symbol: TradingPair }[] = [];
  /**
   * The market data of every watched pair, set before the first candle: its keys are the pairs addIndicator and createOrder accept. The
   * strategy gets a copy (see setMarketData).
   */
  private marketData = new Map<TradingPair, MarketData>();
  /** The orders open on each watched pair at start-up, set before the first candle (see setOpenOrders): init gets a copy */
  private openOrders = new Map<TradingPair, OpenOrder[]>();
  /** The strategy's own copy of the last portfolio received (see onPortfolioChange), which the candle hooks get */
  private portfolio = new Map<Asset, BalanceDetail>();
  private indicatorsResults: IndicatorResults[] = [];
  private currentTimestamp: EpochTimeStamp = 0;
  /**
   * The stop each BUY asked for (its trailing), by the id of that BUY, until the BUY's outcome arms or drops it, or the strategy
   * cancels it, or the BUY is forgotten (see keepPendingOrder). Apart from pendingOrders, which forgets an order before the hook of its
   * outcome: a stop that hook cancels (tools.cancelTrailingOrder) must not be armed after it.
   */
  private readonly pendingTrailingStops = new Map<UUID, TrailingConfig>();
  /**
   * Every order created, the SELLs of the trailing stops included, until the manager hears of its outcome: a cancellation the strategy
   * asks for names its pair (see cancelOrder), a SELL the strategy created holds back the stops of its pair (see isTriggerHeld), and the
   * outcome of a stop's SELL settles that stop (see onOrderCompleted). Kept until that outcome alone, the orders of a run without a
   * Trader, where none ends, piled up for the life of the run: MAX_PENDING_ORDERS at most (see keepPendingOrder).
   */
  private readonly pendingOrders = new Map<UUID, OrderRecord>();
  /** The stops whose trigger isTriggerHeld held back, until the hold of their pair ends: each is said once per hold */
  private readonly heldStopIds = new Set<UUID>();
  private consecutiveErrors = 0;
  /** The levels outside LogLevel the strategy logged at, each reported once */
  private readonly unknownLogLevels = new Set<unknown>();
  private strategy?: Strategy<object>;
  private tools: Tools<object>;

  /**
   * Built by the TradingAdvisor from what it reads of the run: the strategy block of the configuration (undefined without one), of
   * which the strategy gets a copy as its parameters, the warmup's count of timeframe candles and the bound of the circuit breaker
   * (maxConsecutiveErrors, -1 disabling it). It reads nothing else of the configuration.
   */
  constructor(strategyBlock: Configuration['strategy'], warmupPeriod: number, maxConsecutiveErrors: number = 5) {
    super();
    this.warmupPeriod = warmupPeriod;
    this.maxConsecutiveErrors = maxConsecutiveErrors;

    bindAll(this, [
      this.addIndicator.name,
      this.createOrder.name,
      this.cancelOrder.name,
      this.cancelTrailingOrder.name,
      this.isTriggerHeld.name,
      this.log.name,
      this.onTrailingStopActivated.name,
      this.onTrailingStopTriggered.name,
    ]);

    this.trailingStopManager = new TrailingStopManager(this.isTriggerHeld);

    this.tools = {
      createOrder: this.createOrder,
      cancelOrder: this.cancelOrder,
      log: this.log,
      // A copy of the strategy block, made before the strategy's schema, if any, parses it (see parseStrategyParams): what the schema
      // passes through as it is comes from the copy too. The block is the configuration's, which every plugin keeps: a strategy without
      // schema got that very object, and what it wrote there changed the run id of the PerformanceReporter.
      strategyParams: cloneDeep(strategyBlock ?? {}),
      marketData: this.marketData,
      cancelTrailingOrder: this.cancelTrailingOrder,
    };

    this.trailingStopManager.on(TRAILING_STOP_TRIGGERED, this.onTrailingStopTriggered);
    this.trailingStopManager.on(TRAILING_STOP_ACTIVATED, this.onTrailingStopActivated);
  }

  public async createStrategy(strategyName: string, strategyPath?: string) {
    // Annotated, not cast: the compiler checks that every export of the registry is a strategy class whose schema, if any, is a zod
    // schema. The export of an external file is only known at run time.
    let SelectedStrategy: StrategyConstructor | undefined;
    if (strategyPath) {
      const resolvedPath = isAbsolute(strategyPath) ? strategyPath : resolve(process.cwd(), strategyPath);
      let strategyModule: Record<string, StrategyConstructor | undefined>;
      try {
        strategyModule = await import(resolvedPath);
      } catch (err) {
        // Bun rejects with a ResolveMessage or a BuildMessage, which are not Errors, when it cannot find or parse the file, and with an
        // AggregateError of BuildMessages for two syntax errors or more, which the log wrote as '2 errors building "<file>"', without
        // them. The start-up failed without saying which step failed: describeError writes each of them, with its file.
        throw new GekkoError('trading advisor', `Cannot import the strategy file ${resolvedPath}: ${describeError(err)}`, { cause: err });
      }
      SelectedStrategy = strategyModule[strategyName];
      if (!SelectedStrategy) throw new GekkoError('trading advisor', `Cannot find external ${strategyName} strategy in ${resolvedPath}`);
    } else {
      SelectedStrategy = strategies[strategyName as keyof typeof strategies];
      if (!SelectedStrategy) throw new GekkoError('trading advisor', `Cannot find internal ${strategyName} strategy`);
    }
    this.parseStrategyParams(strategyName, SelectedStrategy);
    this.strategy = new SelectedStrategy();
  }

  /* -------------------------------------------------------------------------- */
  /*                            EVENT LISTENERS                                 */
  /* -------------------------------------------------------------------------- */

  public onOneMinuteBucket(bucket: CandleBucket) {
    // Update current timestamp with the latest candle data
    const firstCandle = getFirstCandleFromBucket(bucket);
    // The end of the minute, in epoch milliseconds: date-fns' addMinutes built a Date on every bucket for this sum
    this.currentTimestamp = firstCandle.start + ONE_MINUTE;
    // init runs on the first bucket, once the clock is set: it dates what init logs
    if (!this.isInitialized) this.initStrategy(bucket);
    // Update trailing stop orders each minute with the latest candle data
    this.trailingStopManager.update(bucket);
  }

  public onTimeFrameCandle(bucket: CandleBucket) {
    // The hooks of the candle share one copy of the bucket (see copyBucket): the bucket itself feeds the indicators and the warmup event
    const params = { candle: copyBucket(bucket), portfolio: this.portfolio, tools: this.tools };

    // Update indicators: each is on a watched pair (see addIndicator), and a timeframe bucket holds a candle of every watched pair. The
    // hooks get a copy of each result, made once per candle (see copyResult).
    this.indicatorsResults = this.indicators.map<IndicatorResults>(({ indicator, symbol }) => {
      indicator.onNewCandle(bucket.get(symbol)!);
      return { results: copyResult(indicator.getResult()), symbol };
    });
    // Call for each candle
    this.strategy?.onEachTimeframeCandle?.(params, ...this.indicatorsResults);

    // Fire the warm-up event only when the strategy has fully completed its warm-up phase.
    if (this.warmupPeriod === this.age) this.emitWarmupCompletedEvent(bucket);

    // Call log and onCandleAfterWarmup only after warm up is done
    if (this.isWarmupCompleted) {
      this.strategy?.log?.(params, ...this.indicatorsResults);
      this.strategy?.onTimeframeCandleAfterWarmup?.(params, ...this.indicatorsResults);
    }

    // Not counted beyond the candle that completes the warmup: neither the warmup event nor onStrategyEnd needs more
    if (this.warmupPeriod >= this.age) this.age++;
  }

  public onOrderCompleted({ order, exchange }: OrderCompletedEvent) {
    // Forgotten before anything that may throw, the hook included, its record kept for what follows: from now on, a cancellation of
    // the order names no pair
    const record = this.forgetPendingOrder(order.id);
    this.consecutiveErrors = 0;
    // The hook gets its own copy of the event (see copyOrderEvent): what follows reads the event itself
    this.strategy?.onOrderCompleted?.({ ...copyOrderEvent(order, exchange), tools: this.tools }, ...this.indicatorsResults);

    this.armPendingTrailingStop(order, order.amount);

    // The SELL of a stop settles that stop alone (see settleCompletedStopSell): the other stops of the pair still protect theirs. A
    // SELL the strategy created closed the position the stops of its pair protected.
    if (record?.seller === 'stop') this.settleCompletedStopSell(order, exchange);
    else if (order.side === 'SELL') this.cancelTrailingStopsOfPair(order);
  }

  public onOrderCanceled({ order, exchange }: OrderCanceledEvent) {
    // As on a completion (see onOrderCompleted)
    const record = this.forgetPendingOrder(order.id);
    this.consecutiveErrors = 0;
    this.strategy?.onOrderCanceled?.({ ...copyOrderEvent(order, exchange), tools: this.tools }, ...this.indicatorsResults);
    // A BUY canceled drops the stop it asked for, even after a partial fill
    this.cancelTrailingOrder(order.id);
    if (record?.seller === 'stop') {
      // What it sold before it expired (a MARKET SELL fills what the book allows), or 0 when its cancelation was answered without the
      // fill: the stop then sells its whole amount again, which the Trader caps to what is free
      const sold = isFiniteNumber(order.filled) && order.filled > 0 ? order.filled : 0;
      this.resumeTrailingStop(order.id, 'was canceled', sold, exchange);
    } else if (record?.seller === 'strategy') {
      this.releaseTriggersOfPair(order, 'was canceled');
    }
  }

  public onOrderErrored({ order, exchange }: OrderErroredEvent) {
    // As on a completion (see onOrderCompleted), the error that trips the circuit breaker included
    const record = this.forgetPendingOrder(order.id);
    this.consecutiveErrors++;
    const isConsecutiveErrorsReached = this.maxConsecutiveErrors !== -1 && this.consecutiveErrors >= this.maxConsecutiveErrors;
    // Thrown before the hook and the trailing clean-up, the breaker kept the error that trips it from the strategy, which ended holding
    // the order as pending
    try {
      this.strategy?.onOrderErrored?.({ ...copyOrderEvent(order, exchange), tools: this.tools }, ...this.indicatorsResults);
    } catch (hookError) {
      if (!isConsecutiveErrorsReached) throw hookError;
      // The orderly stop prevails, as in PluginsStream: a restart-on-failure supervisor leaves the bot stopped
      error('strategy', `The strategy's onOrderErrored failed on the error that trips the circuit breaker: ${describeError(hookError)}`);
    }
    // What the order executed before its error, as far as the exchange reported it
    const filled = isFiniteNumber(order.filled) && order.filled > 0 ? order.filled : 0;
    if (record?.seller === 'stop') {
      this.resumeTrailingStop(order.id, 'errored', filled, exchange, order.reason, order.mayBeLive);
    } else if (record?.seller === 'strategy') {
      // Released even when that SELL may still be live on the exchange: no outcome of it will follow, and the stops it held would never
      // trigger again
      this.releaseTriggersOfPair(order, 'errored');
    } else {
      this.settleTrailingStopOfErroredBuy(order, filled);
    }
    if (isConsecutiveErrorsReached)
      throw new ApplicationStopError('strategy', `Max consecutive order errors reached (${this.maxConsecutiveErrors})`);
  }

  /** `failure` is the error that stops the run before its end, if any: the strategy's end gets its message (see Strategy.end) */
  public onStrategyEnd(failure?: Error) {
    // A backtest too short for its warmup ended normally, without a trade, and only analyzer warnings that did not name the warmup.
    // The configuration refuses such a range, but a run can still stop before its warmup is over (on an error, or in realtime before
    // the first live timeframe candle).
    if (!this.isWarmupCompleted)
      error(
        'strategy',
        `Strategy ended before its warmup was over, so it never traded: ${this.age} timeframe ${pluralize('candle', this.age)} processed, ${this.warmupPeriod + 1} needed (warmup.candleCount: ${this.warmupPeriod}, then one to trade on)`,
      );
    const stops = [...this.trailingStopManager.getOrders().values()];
    const sellingCount = stops.filter(({ status }) => status === 'selling').length;
    const armedCount = stops.length - sellingCount;
    if (armedCount > 0)
      warning('strategy', `Strategy ended with ${armedCount} active trailing ${pluralize('stop', armedCount)} that never triggered.`);
    if (sellingCount > 0)
      warning(
        'strategy',
        `Strategy ended with ${sellingCount} triggered trailing ${pluralize('stop', sellingCount)} whose SELL had not ended.`,
      );
    this.trailingStopManager.removeAllListeners();
    // The message, not the error, which every plugin is finalised with: what a hook receives is the strategy's own (see Strategy)
    this.strategy?.end?.(failure?.message);
  }

  public onPortfolioChange(portfolio: Portfolio) {
    // The strategy's own copy, which the candle hooks get, and may write to, until the next change. What it is made from is the
    // TradingAdvisor's own, the balance it read at start-up or its copy of an event, each listener of a deferred event getting one: no
    // other plugin reads it.
    this.portfolio = clonePortfolio(portfolio);
  }

  // Given the state alone, the trailing hooks could neither cancel a stop, log nor order unless the strategy had kept the tools of an
  // earlier hook: they get them last, so that a hook written without them still fits
  private onTrailingStopActivated(state: TrailingStopState) {
    this.strategy?.onTrailingStopActivated?.(state, this.tools);
  }

  private onTrailingStopTriggered(state: TrailingStopState) {
    // Kept as the SELL of a stop, not of the strategy: it holds no other stop of the pair, each selling its own BUY's fill. It keeps
    // its pair (see pendingOrders): the strategy may adopt that SELL, and cancel it.
    const orderId = this.relayOrder({ symbol: state.symbol, side: 'SELL', type: 'MARKET', amount: state.amount }, 'stop');
    // The stop sells until that SELL ends (see onOrderCompleted and resumeTrailingStop): the hook gets it with the id of its SELL
    const selling = this.trailingStopManager.setSellOrderId(state.id, orderId) ?? state;
    this.strategy?.onTrailingStopTriggered?.(orderId, selling, this.tools);
  }

  /* -------------------------------------------------------------------------- */
  /*                                  SETTERS                                   */
  /* -------------------------------------------------------------------------- */

  public setMarketData(marketData: Map<TradingPair, MarketData>) {
    this.marketData = marketData;
    // A copy: on dummy-cex and paper trading the entries are those the simulator charges and checks orders with, and a fee the strategy
    // zeroed there made every fill free. What it adds to its copy is no watched pair either: the checks read this.marketData.
    this.tools.marketData = cloneDeep(marketData);
  }

  /**
   * Sets the orders open on each watched pair before the run placed any, which the TradingAdvisor reads from the exchange at start-up:
   * init, which runs on the first bucket, gets them (see InitParams.openOrders)
   */
  public setOpenOrders(openOrders: Map<TradingPair, OpenOrder[]>) {
    this.openOrders = openOrders;
  }

  /* -------------------------------------------------------------------------- */
  /*                  FUNCTIONS USED IN TRADER STRATEGIES                       */
  /* -------------------------------------------------------------------------- */

  private addIndicator<T extends IndicatorNames>(name: T, symbol: TradingPair, parameters: IndicatorParameters<T>): void {
    // Kept from init and called from a later hook, it added an indicator fed from then on only, and one more argument to every hook:
    // one per candle for a strategy that called it on each
    if (this.isInitialized)
      throw new GekkoError('strategy', `Impossible to add the ${name} indicator on ${symbol}: addIndicator is available in init only`);
    const Indicator = indicators[name];
    if (!Indicator) throw new GekkoError('strategy', `${name} indicator not found.`);
    // An indicator on a pair that is not watched never got a candle: its results stayed null for the whole run, so a strategy waiting
    // for them never traded, with one warning per candle that the default log level hid
    const pairProblem = getPairProblem(symbol, this.marketData);
    if (pairProblem) throw new GekkoError('strategy', `Impossible to add the ${name} indicator on ${symbol}: ${pairProblem}`);
    const parametersProblem = getParametersProblem(parameters);
    if (parametersProblem) throw new GekkoError('strategy', `Impossible to add the ${name} indicator on ${symbol}: ${parametersProblem}`);

    // None given, the indicator gets {}: its defaults, or the refusal of its own checks for a parameter it requires (see
    // getParametersProblem)
    // @ts-expect-error TODO fix complex typescript error
    const indicator = new Indicator(parameters ?? {});
    this.indicators.push({ indicator, symbol });
  }

  /**
   * Relays the cancellation of `orderId`, with the pair of the order while the manager has not heard of its outcome (see
   * pendingOrders). Relayed as a bare id, it named no pair, nor did the strat_cancel notification: a chat fed by several instances,
   * one per pair, could not tell which one it was about. An id the manager did not create in this run, or of an order whose end it has
   * heard of, goes alone, and the Trader, which knows no such order, warns of it. So does that of an order the manager forgot, older
   * than the MAX_PENDING_ORDERS most recent of those pending (see keepPendingOrder), which the Trader may still know.
   */
  private cancelOrder(orderId: UUID): void {
    const symbol = this.pendingOrders.get(orderId)?.symbol;
    this.emit<AdviceCancelOrder>(STRATEGY_CANCEL_ORDER_EVENT, symbol ? { id: orderId, symbol } : { id: orderId });
  }

  private cancelTrailingOrder(orderId: UUID): void {
    this.pendingTrailingStops.delete(orderId);
    this.trailingStopManager.removeOrder(orderId);
    this.heldStopIds.delete(orderId);
  }

  private createOrder(order: StrategyOrder): UUID {
    // Until its outcome, a SELL of the strategy's own holds back the triggers of the stops of its pair (see isTriggerHeld)
    return this.relayOrder(order, order.side === 'SELL' ? 'strategy' : undefined);
  }

  /**
   * Checks `order`, then relays it to the Trader under the id it draws for it, which it returns, and keeps it pending until its
   * outcome (see pendingOrders): `seller` says who sells, the strategy or a trailing stop, for a SELL
   */
  private relayOrder(order: StrategyOrder, seller?: OrderRecord['seller']): UUID {
    if (!this.currentTimestamp) throw new GekkoError('strategy', 'No candle when relaying advice');
    // In realtime the warmup candles are history, replayed with the Trader active: an order created on one of them went to the
    // exchange at once, priced or centred on a close that could be a year old (in backtest it traded on candles the reports leave out).
    // The warmup event comes before log and onTimeframeCandleAfterWarmup on the candle that completes the warmup (the first candle
    // when candleCount is 0): every order follows it, and none can come from init.
    if (!this.isWarmupCompleted)
      throw new GekkoError(
        'strategy',
        'Orders are not available until the warmup is over: create them from onTimeframeCandleAfterWarmup, log or an order hook, never from init',
      );
    this.checkOrder(order);
    const id = randomUUID();
    // The clock is already the end of the minute being processed, where the Trader and the simulated exchange date fills and errors:
    // a minute added to it dated every order after its own fill.
    const orderCreationDate = this.currentTimestamp;

    // The stop of a BUY (checkOrder refuses one on a SELL) is armed once the BUY completes. Kept by reference until then, it was the
    // strategy's object: a change made in between armed another stop than the one checked here, or none (a percentage of 0).
    if (order.trailing) this.pendingTrailingStops.set(id, { ...order.trailing });
    // Until its outcome, a cancellation of the order names its pair (see cancelOrder), and a SELL says who sells (see OrderRecord)
    this.keepPendingOrder(id, seller ? { symbol: order.symbol, seller } : { symbol: order.symbol });

    this.emit<AdviceOrder>(STRATEGY_CREATE_ORDER_EVENT, { ...omit(order, 'trailing'), id, orderCreationDate });
    return id;
  }

  /**
   * Keeps the order `id` pending until its outcome (see pendingOrders), MAX_PENDING_ORDERS of them at most: beyond, the manager forgets
   * the oldest, with the stop it asked for, as it forgets an order whose outcome has come. A cancellation of it then goes with its id
   * alone, and a SELL of the strategy holds back the stops of its pair no more. Only orders that do not end pile up so: without a
   * Trader, where no stop is ever armed, or more than that many left open on the exchange at once.
   */
  private keepPendingOrder(id: UUID, record: OrderRecord) {
    this.pendingOrders.set(id, record);
    if (this.pendingOrders.size <= MAX_PENDING_ORDERS) return;
    const [oldestId] = this.pendingOrders.keys();
    this.pendingOrders.delete(oldestId);
    this.pendingTrailingStops.delete(oldestId);
  }

  /** The record of the order `id`, whose outcome has come, which the manager forgets (see pendingOrders) */
  private forgetPendingOrder(id: UUID): OrderRecord | undefined {
    const record = this.pendingOrders.get(id);
    this.pendingOrders.delete(id);
    return record;
  }

  /**
   * Logs a line of the strategy, printed if GEKKO_LOG_LEVEL lets its level through. An info, warn or error line is also relayed as
   * strategy info (the strat_info notifications of the EventSubscriber), whatever GEKKO_LOG_LEVEL; a debug line is not. An error line
   * then throws. A message that is not a string, which only an untyped strategy can pass, is written as util.inspect shows it, on one
   * line but for an Error's stack (see MESSAGE_INSPECT_OPTIONS).
   */
  private log(level: LogLevel, message: unknown) {
    // Bun loads a strategyPath without type-checking it. An object reached the logger and the strat_info subscribers as
    // "[object Object]", and one holding a function (tools itself) could not be copied with the events of its bucket: the bucket
    // failed on a DataCloneError that named neither tools.log nor the strategy info.
    const text = isString(message) ? message : inspect(message, MESSAGE_INSPECT_OPTIONS);
    let relayedLevel = level;
    switch (level) {
      case 'debug':
        // Not relayed: the built-in strategies log their indicator values at debug, up to four lines a candle (MACD), which reached the
        // strat_info subscribers as as many Telegram messages. Not even formatted below GEKKO_LOG_LEVEL, which debug checks before it
        // hands winston anything: winston formats a line before its level filter drops it, and with the relay that was most of the
        // cost of a candle in a backtest.
        debug('strategy', text);
        return;
      case 'info':
        info('strategy', text);
        break;
      case 'warn':
        warning('strategy', text);
        break;
      case 'error':
        error('strategy', text);
        break;
      default: {
        // Bun loads a strategyPath without type-checking it, and a JavaScript strategy has no types: a level outside LogLevel ('warning',
        // 'ERROR') logged nothing and was relayed as it was, to Telegram too. Reported once per level: a strategy logs on every candle.
        const unknownLevel: never = level;
        if (!this.unknownLogLevels.has(unknownLevel)) {
          this.unknownLogLevels.add(unknownLevel);
          warning(
            'strategy',
            `Unknown log level ${inspect(unknownLevel)} in tools.log: its messages are logged and relayed at info level (levels: debug, info, warn, error)`,
          );
        }
        info('strategy', text);
        relayedLevel = 'info';
      }
    }
    this.emit<StrategyInfo>(STRATEGY_INFO_EVENT, { timestamp: this.currentTimestamp, level: relayedLevel, tag: 'strategy', message: text });
    // Relayed before the throw, as every other line is: thrown first, an error line was never relayed, even when the strategy caught the
    // error and went on
    if (level === 'error') throw new GekkoError('strategy', text);
  }

  /* -------------------------------------------------------------------------- */
  /*                            UTILS FUNCTIONS                                 */
  /* -------------------------------------------------------------------------- */

  /**
   * Checks the strategy block with the schema of the strategy's class, before the strategy exists. Unchecked, a misspelt or missing
   * parameter was silently undefined: an indicator fell back to its default period, a comparison with undefined never held, or the
   * strategy threw a TypeError once its indicators were ready, which can be hours into a realtime run.
   */
  private parseStrategyParams(strategyName: string, { schema }: StrategyConstructor) {
    if (!schema) {
      info('trading advisor', `Strategy ${strategyName} declares no schema: its parameters (the strategy block) are not validated`);
      return;
    }
    // Without name, which only labels the run and which the configuration schema checks: the strategy gets what the schema outputs
    const result = schema.safeParse(omit(this.tools.strategyParams, 'name'));
    if (!result.success) {
      const issues = z.prettifyError(result.error);
      throw new GekkoError('trading advisor', `Invalid parameters for strategy ${strategyName} (strategy block):\n${issues}`);
    }
    this.tools.strategyParams = result.data;
  }

  /**
   * Runs init, once, on the first one-minute bucket, given the strategy's own copy of it (see copyBucket): a candle of every watched
   * pair, all init needs to pick its pairs and register its indicators, which are fed from the first timeframe candle on. Run on that
   * candle instead, init came up to a day after start-up on 1d without warmup (a month on 1M): an indicator misspelt there, or a
   * parameter its checks refused, stopped the bot only then. addIndicator is closed once init has returned. init also gets its own
   * copy of the orders open at start-up, with which a strategy can refuse to start beside orders it cannot follow.
   */
  private initStrategy(bucket: CandleBucket) {
    this.strategy?.init?.({
      candle: copyBucket(bucket),
      portfolio: this.portfolio,
      tools: this.tools,
      addIndicator: this.addIndicator,
      openOrders: cloneDeep(this.openOrders),
    });
    this.isInitialized = true;
  }

  /**
   * Refuses, before anything is relayed, an order the strategy cannot have meant. A key the Trader does not read was ignored (see
   * getKeysProblem). One on a pair that is not watched, given a price, was placed on a live exchange (an all-in BUY spending the
   * currency of the watched pairs), though Gekko has no candle or balance of that pair: what it bought was missing from the portfolio
   * and its stop never trailed. A side, a type, an amount or a price an untyped strategy got wrong was relayed as it was, and so
   * would a cost, an allocation or two ways to size the order be (see getOrderProblem). The trailing stop of a BUY was only checked
   * once the BUY had completed: an invalid one was refused then, with a warning, and the position the BUY had just opened kept no
   * stop. One given to a SELL was dropped without a word.
   */
  private checkOrder(order: StrategyOrder) {
    const problem =
      getKeysProblem(order) ?? getPairProblem(order.symbol, this.marketData) ?? getOrderProblem(order) ?? getTrailingProblem(order);
    if (!problem) return;
    const { side, type, symbol } = order;
    throw new GekkoError('strategy', `Impossible to create the ${side} ${type} order on ${symbol}: ${problem}`);
  }

  /** Arms the stop the BUY `order` asked for, if any, for `amount`: what that BUY filled */
  private armPendingTrailingStop({ id, symbol, orderCreationDate }: OrderInitiatedEvent['order'], amount: number) {
    const trailing = this.pendingTrailingStops.get(id);
    if (!trailing) return;
    this.pendingTrailingStops.delete(id);
    this.trailingStopManager.addOrder({ id, symbol, amount, trailing, createdAt: orderCreationDate });
  }

  /**
   * Settles the stop an errored BUY asked for. Armed for what the BUY filled when the exchange reported a fill: a STICKY order whose
   * relaunch failed, or an order whose poll or cancelation failed for good, errors after its fills, and the stop, dropped, left the
   * coins bought without protection. Dropped otherwise, with a warning: nothing tells what to arm, and kept pending the stop would
   * never be armed, no completion following an error (the Trader relays the first end of an order only). The warnings say that the
   * BUY may have executed, or may fill more, only when it may still be live on the exchange (OrderErroredEvent.mayBeLive): they said
   * so of every BUY that errored, one the exchange refused included.
   */
  private settleTrailingStopOfErroredBuy(order: OrderErroredEvent['order'], filled: number) {
    const { id, symbol, amount, reason, mayBeLive } = order;
    if (!this.pendingTrailingStops.has(id)) return;
    if (filled > 0) {
      const [asset] = symbol.split('/');
      const rest = mayBeLive ? ', and the rest of it may still fill on the exchange, without a stop' : '';
      warning(
        'strategy',
        `BUY ${id} errored after it filled ${filled} of ${amount} ${asset} (${reason}): its trailing stop is armed for that part${rest}`,
      );
      this.armPendingTrailingStop(order, filled);
      return;
    }
    const notArmed = `Trailing stop of BUY ${id} not armed: the BUY errored`;
    warning(
      'strategy',
      mayBeLive
        ? [
            `${notArmed}, no fill reported (${reason}).`,
            'If it executed all the same, as an order whose outcome is unknown may have, what it bought has no stop',
          ].join(' ')
        : `${notArmed}, nothing filled (${reason})`,
    );
    this.cancelTrailingOrder(id);
  }

  /**
   * Makes the stop whose SELL ended without completing active again, for what that SELL left unsold (see
   * TrailingStopManager.resumeSellingStop), with a warning. A SELL refused every time with the asset still free (an API key refused,
   * an exchange that refuses what it should take) is then sent again on each minute whose price reaches the stop price, each refusal
   * counting towards the circuit breaker, which stops the bot: rather than run on with the position held without any stop. A stop
   * removed while it sold (canceled by the strategy, or by a SELL the strategy created) stays removed: that SELL is the strategy's.
   *
   * A stop whose SELL errored while it may still be live on the exchange (`mayBeLive`: its creation's answer lost, the exchange busy
   * or overloaded) is made active again too, with a warning that says so. That SELL is a MARKET order: it may have executed, it rests
   * on no book. If it did, the portfolio read once it errored shows the asset gone, and the stop is removed (below); read too early,
   * the next SELL of the stop, which the Trader caps to the free balance less the SELLs placed since, is refused for lack of anything
   * to sell, and that refusal removes it. Removed at once, the stop left the position without protection whenever the exchange lost
   * its answer or was busy, a crash on an overloaded exchange included. What is left of the risk: a second sale, of the stop's amount
   * at most, of coins of the asset the account holds besides.
   *
   * Unless what that SELL left unsold is too little to sell at the minimums of the market, the PositionTracker's rule for the MARKET
   * SELL the stop sends (see isSellable): nothing is left for the stop to protect, may that SELL still be live or not. Resumed, it sent
   * a SELL of that rest, refused on each such minute until the breaker stopped the bot, whenever the account held other coins of the
   * asset free (the position of another stop, a holding of its own), which kept the check below from removing it; a stop armed for
   * less than the minimums did so from its first SELL. The stop is over, said at info level, as after a SELL that completed for less
   * (see settleCompletedStopSell).
   *
   * Nor when the portfolio after that SELL (`exchange`) shows too little of the asset free to sell (see isNothingFreeToSell): nothing
   * is left for the stop to protect (sold by hand on the exchange, or by a SELL whose outcome was lost), and resumed it sent a SELL
   * refused on each such minute until the breaker stopped the bot. It is removed, with a warning.
   *
   * Unless the Trader read that portfolio before the SELL ended (see isReadBeforeEnd): its read after the end failed, and the event
   * carries an earlier one, which counts as used what the SELL reserved when it was made while the SELL rested, and still shows free
   * what the SELL sold when it was made before. It is not read (see isNothingFreeToSell): removed on it, the stop of a SELL canceled
   * while the position was still held left that position without protection. The stop is active again, or kept, for what the SELL
   * left unsold, its warning adding that the Trader could not read the balances after it: if that rest is gone, the next SELL of the
   * stop is refused for lack of anything to sell, and the portfolio read after that refusal removes the stop, unless the account holds
   * other coins of the asset free, which that SELL sells, as after a SELL that may still be live (above).
   */
  private resumeTrailingStop(sellId: UUID, outcome: string, sold: number, exchange: ExchangeEvent, reason?: string, mayBeLive = false) {
    const stop = this.trailingStopManager.resumeSellingStop(sellId, sold);
    if (!stop) return;
    const [asset] = stop.symbol.split('/');
    const sale = sold > 0 ? ` after selling ${sold} ${asset}` : ', no fill reported';
    const ending = `${outcome}${sale}${reason ? ` (${reason})` : ''}`;
    if (!isSellable(stop.amount, exchange.price, 'MARKET', this.marketData.get(stop.symbol))) {
      this.trailingStopManager.removeOrder(stop.id);
      info(
        'strategy',
        `Trailing stop of BUY ${stop.id} over: its SELL ${sellId} ${ending}, and the rest, ${stop.amount} ${asset}, is too little to sell at the minimums of the market`,
      );
      return;
    }
    if (this.isNothingFreeToSell(stop, exchange)) {
      this.trailingStopManager.removeOrder(stop.id);
      const free = exchange.portfolio.get(asset)?.free;
      warning(
        'strategy',
        [
          `Trailing stop of BUY ${stop.id} removed: its SELL ${sellId} ${ending}, and the portfolio after it shows ${free} ${asset} free,`,
          'too little to sell at the minimums of the market. Nothing is left for the stop to protect',
        ].join(' '),
      );
      return;
    }
    const selling = describeSale(stop);
    // Empty unless the Trader read the balances of that end before it, which the stop is not ended on (see isNothingFreeToSell)
    const unread = describeUnreadBalances(exchange);
    if (!mayBeLive) {
      warning('strategy', `Trailing stop of BUY ${stop.id} active again: its SELL ${sellId} ${ending}${unread}. It sells ${selling}`);
      return;
    }
    warning(
      'strategy',
      [
        `Trailing stop of BUY ${stop.id} kept: its SELL ${sellId} ${ending}, and may still have gone through on the exchange, where`,
        `Gekko follows it no more${unread}. Check that SELL there. The stop stays armed, selling ${selling}: if that SELL went through,`,
        `the next one is refused for lack of free ${asset} and the stop removed, unless the account holds other ${asset} free, which it`,
        'would sell',
      ].join(' '),
    );
  }

  /**
   * Settles the stop whose SELL completed: over once that SELL sold all the stop sells, the position it protected sold. The Trader caps
   * a SELL to the free balance and to the most the market takes in one order (its maximum amount, that of a market order for a MARKET
   * one), and the SELL then completes for less. Over all the same, the stop left the rest of the position without protection: the SELL
   * of a position bought above the maximum of a MARKET order (by a STICKY or a LIMIT BUY) sold that maximum only. The stop is now
   * active again for the rest, from the peak and the stop price it triggered at, with a warning, as after a SELL that ended without
   * completing (see resumeTrailingStop): the next price at or below that stop price sells the next part. Unless the rest is too little
   * to sell at the minimums of the market, or the portfolio after that SELL shows too little of the asset free (see
   * isNothingFreeToSell): a BUY whose fee the exchange took from the asset bought leaves its stop selling more than is free, its SELL
   * capped to what is, and nothing is left to protect. The stop is then over, said at info level. A portfolio the Trader read before
   * that SELL ended is not read (see isNothingFreeToSell): the stop is active again for the rest, its warning adding that the Trader
   * could not read the balances after it, and if that rest is gone, the refusal of its next SELL removes it (see resumeTrailingStop).
   */
  private settleCompletedStopSell({ id: sellId, amount: sold }: OrderCompletedEvent['order'], exchange: ExchangeEvent) {
    const stop = this.getSellingStop(sellId);
    // None once the strategy, or a SELL it created, removed the stop while it sold: that SELL was the strategy's
    if (!stop) return;
    if (!(sold < stop.amount)) {
      this.trailingStopManager.removeSellingStop(sellId);
      return;
    }
    const [asset] = stop.symbol.split('/');
    const left = addPrecise(stop.amount, -sold);
    const ending = `its SELL ${sellId} completed after selling ${sold} of its ${stop.amount} ${asset}`;
    const isLeftSellable = isSellable(left, exchange.price, 'MARKET', this.marketData.get(stop.symbol));
    if (!isLeftSellable || this.isNothingFreeToSell(stop, exchange)) {
      this.trailingStopManager.removeSellingStop(sellId);
      const tooLittle = isLeftSellable
        ? `the portfolio after it shows ${exchange.portfolio.get(asset)?.free} ${asset} free,`
        : `the rest, ${left} ${asset}, is`;
      info(
        'strategy',
        `Trailing stop of BUY ${stop.id} over: ${ending}, and ${tooLittle} too little to sell at the minimums of the market`,
      );
      return;
    }
    const resumed = this.trailingStopManager.resumeSellingStop(sellId, sold) ?? stop;
    warning(
      'strategy',
      [
        `Trailing stop of BUY ${stop.id} active again: ${ending} (the Trader caps a SELL to the free balance and to the maximum amount`,
        `of the market)${describeUnreadBalances(exchange)}. It sells ${describeSale(resumed)}`,
      ].join(' '),
    );
  }

  /**
   * Whether the portfolio after the SELL of a stop (`exchange`) shows too little of its asset free to sell: nothing is left for the
   * stop to protect. Not while a SELL the strategy created is pending on the pair, whose reservation of the asset leaves little free
   * while the position is held: that SELL decides (see isTriggerHeld). Nor when the portfolio does not list the asset, read before the
   * first synchronization, or when the Trader read it before the SELL ended (see isReadBeforeEnd): nothing tells then, a read made while
   * the SELL rested counting as used what the SELL reserved, and one made before the SELL was placed still showing free what it sold,
   * so that the stop is never ended on such a read. Too little is the PositionTracker's rule (see isSellable), for the MARKET SELL the
   * stop sends.
   */
  private isNothingFreeToSell({ symbol }: TrailingStopState, exchange: ExchangeEvent): boolean {
    const [asset] = symbol.split('/');
    const free = exchange.portfolio.get(asset)?.free;
    if (isReadBeforeEnd(exchange) || !isFiniteNumber(free) || this.getStrategySellIds(symbol).length > 0) return false;
    return !isSellable(free, exchange.price, 'MARKET', this.marketData.get(symbol));
  }

  /** The stop selling through the SELL `sellId` (see TrailingStopState.sellOrderId), if any */
  private getSellingStop(sellId: UUID): TrailingStopState | undefined {
    return [...this.trailingStopManager.getOrders().values()].find(stop => stop.status === 'selling' && stop.sellOrderId === sellId);
  }

  /**
   * Cancels the trailing stops armed on the pair of a SELL the strategy created, once it completed: that SELL closed the position they
   * protected. Left armed, a stop outlived its position: it later sold a position the strategy opened afterwards (the Trader capping its
   * SELL to what was free), or, the strategy being flat, sent a SELL that was refused, an error counting towards the circuit breaker.
   * Every stop of the pair, whatever the amount sold: every built-in strategy sells all it holds, and an all-in SELL sells less than
   * its BUY filled when the exchange took the fee of the BUY from the asset bought, so a comparison of amounts would keep the stop. A
   * stop selling is canceled too: its SELL, sent already, is the strategy's, and is not resumed if it fails. A stop whose BUY has not
   * completed is kept: that BUY opens a position after this SELL. A SELL canceled or errored cancels nothing: the position is still
   * held, in part at least.
   */
  private cancelTrailingStopsOfPair({ id: sellId, symbol }: OrderCompletedEvent['order']) {
    const stopIds = [...this.trailingStopManager.getOrders().values()].filter(stop => stop.symbol === symbol).map(({ id }) => id);
    for (const stopId of stopIds) {
      this.cancelTrailingOrder(stopId);
      info(
        'strategy',
        `Trailing stop of BUY ${stopId} canceled: the strategy sold on ${symbol} (SELL ${sellId} completed), closing the position the stop protected`,
      );
    }
  }

  /** The SELLs the strategy created on `symbol` whose outcome has not come yet */
  private getStrategySellIds(symbol: TradingPair): UUID[] {
    return [...this.pendingOrders].filter(([, { symbol: pair, seller }]) => seller === 'strategy' && pair === symbol).map(([id]) => id);
  }

  /**
   * Holds back the trigger of a stop (see TriggerHold) while a SELL the strategy created is pending on its pair. The exchange reserves
   * the asset for that SELL: a stop that triggered meanwhile had its own SELL refused, and, active again, sent it on each minute the
   * price stayed under its stop price, each refusal counting towards the circuit breaker, which stopped the bot. That SELL decides
   * instead: completed, it cancels the stops of the pair (see cancelTrailingStopsOfPair); canceled or errored, it releases them (see
   * releaseTriggersOfPair). Said once per stop and hold, at info level.
   */
  private isTriggerHeld(stop: TrailingStopState, price: number): boolean {
    const sellIds = this.getStrategySellIds(stop.symbol);
    if (!sellIds.length) return false;
    if (this.heldStopIds.has(stop.id)) return true;
    this.heldStopIds.add(stop.id);
    info(
      'strategy',
      [
        `Trailing stop of BUY ${stop.id} held back: a price, ${price}, reached its stop price, ${stop.stopPrice},`,
        `while a SELL the strategy created on ${stop.symbol} is pending (${sellIds.join(', ')}). The stop sends no SELL until that one`,
        'ends: completed, it cancels the stop; canceled or errored, the stop may trigger again from the next minute',
      ].join(' '),
    );
    return true;
  }

  /**
   * Releases the stops of the pair of a SELL the strategy created that ended without completing (canceled, errored), once no other is
   * pending there: the position is still held, in part at least, and the next price at or below a stop price triggers that stop.
   * Said at info level for each stop of the pair, but those selling, whose SELL went out before the hold.
   */
  private releaseTriggersOfPair({ id: sellId, symbol }: OrderInitiatedEvent['order'], outcome: string) {
    if (this.getStrategySellIds(symbol).length) return;
    for (const stop of this.trailingStopManager.getOrders().values()) {
      if (stop.symbol !== symbol || stop.status === 'selling') continue;
      this.heldStopIds.delete(stop.id);
      info(
        'strategy',
        [
          `Trailing stop of BUY ${stop.id} resumes: the SELL ${sellId} the strategy created on ${symbol} ${outcome},`,
          'and no other is pending there, so the stop may trigger again from the next minute',
        ].join(' '),
      );
    }
  }

  private emitWarmupCompletedEvent(bucket: CandleBucket) {
    this.isWarmupCompleted = true;
    info('strategy', `Strategy warmup done ! Sending first candle bucket (${toISOString(getBucketTimestamp(bucket))}) to strategy`);
    this.emit<CandleBucket>(STRATEGY_WARMUP_COMPLETED_EVENT, bucket);
  }
}
