import {
  STRATEGY_CANCEL_ORDER_EVENT,
  STRATEGY_CREATE_ORDER_EVENT,
  STRATEGY_INFO_EVENT,
  STRATEGY_WARMUP_COMPLETED_EVENT,
  TRAILING_STOP_ACTIVATED,
  TRAILING_STOP_TRIGGERED,
} from '@constants/event.const';
import { ORDER_SIDES, ORDER_TYPES } from '@constants/order.const';
import { ONE_MINUTE } from '@constants/time.const';
import { ApplicationStopError } from '@errors/applicationStop.error';
import { describeError } from '@errors/error.utils';
import { GekkoError } from '@errors/gekko.error';
import * as indicators from '@indicators/index';
import { Indicator } from '@indicators/indicator';
import { IndicatorNames, IndicatorParameters } from '@indicators/indicator.types';
import { AdviceOrder, StrategyOrder, TrailingConfig } from '@models/advice.types';
import {
  CandleBucket,
  ExchangeEvent,
  OrderCanceledEvent,
  OrderCompletedEvent,
  OrderErroredEvent,
  OrderInitiatedEvent,
} from '@models/event.types';
import { LogLevel } from '@models/logLevel.types';
import { BalanceDetail, Portfolio } from '@models/portfolio.types';
import { StrategyInfo } from '@models/strategyInfo.types';
import { Asset, TradingPair } from '@models/utility.types';
import { config } from '@services/configuration/configuration';
import { MarketData, OpenOrder } from '@services/exchange/exchange.types';
import { debug, error, info, isLevelEnabled, warning } from '@services/logger';
import * as strategies from '@strategies/index';
import { getBucketTimestamp, getFirstCandleFromBucket } from '@utils/candle/candle.utils';
import { toISOString } from '@utils/date/date.utils';
import { copyPayload } from '@utils/event/event.utils';
import { addPrecise, isFiniteNumber, isFinitePositive } from '@utils/math/math.utils';
import { clonePortfolio } from '@utils/portfolio/portfolio.utils';
import { bindAll, cloneDeep, isNil, isString, omit } from 'lodash-es';
import { randomUUID, UUID } from 'node:crypto';
import EventEmitter from 'node:events';
import { isAbsolute, resolve } from 'node:path';
import { inspect, InspectOptions } from 'node:util';
import { z } from 'zod';
import { isSellable } from './positionTracker';
import { IndicatorResults, Strategy, StrategyConstructor, Tools } from './strategy.types';
import { TrailingStopManager } from './trailingStopManager';
import { TrailingStopState } from './trailingStopManager.types';

/**
 * What is wrong with the pair an order or an indicator names, or undefined when it is watched: a key of `marketData`, which the
 * TradingAdvisor fills with every watched pair before the first candle. Gekko has no candle, price or balance of any other pair.
 */
const getPairProblem = (symbol: TradingPair, marketData: Map<TradingPair, MarketData>): string | undefined => {
  if (marketData.has(symbol)) return;
  return `symbol must be one of the watched pairs (${[...marketData.keys()].join(', ')}), got ${inspect(symbol)}`;
};

/** Values as util.inspect shows them, quoted when they are strings: the case of a side or a type shows */
const showValues = (values: readonly unknown[]) => values.map(value => inspect(value)).join(', ');

/** The keys of `object` that are not among `keys`, in the order `object` holds them, whatever their values: undefined ones included */
const getUnknownKeys = (object: object, keys: readonly string[]) => Object.keys(object).filter(key => !keys.includes(key));

/** The keys of an order, those of StrategyOrder: the record is typed to hold each of them and no other */
const ORDER_KEYS = Object.keys({
  symbol: true,
  side: true,
  type: true,
  amount: true,
  price: true,
  trailing: true,
} satisfies Record<keyof StrategyOrder, true>);

/**
 * What is wrong with the keys of an order, or undefined when it holds none but those of StrategyOrder. The Trader reads those alone,
 * and any other key was relayed and ignored: a LIMIT whose price was misspelt (limitPrice, prise) was placed at the last price of the
 * pair, where it filled at once, a take-profit SELL selling at the market; an amount given as quantity made the order all-in; a
 * trailing stop given under another name was dropped, the BUY going without it. Refused whatever its value, undefined included: a
 * misspelt key fed from an optional parameter is caught at the first order, not on the first run that sets it. Checked before the
 * fields, a misspelt symbol, side or type is named, not reported as undefined.
 */
const getKeysProblem = (order: StrategyOrder): string | undefined => {
  const unknownKeys = getUnknownKeys(order, ORDER_KEYS);
  if (unknownKeys.length) return `order keys must be one of ${showValues(ORDER_KEYS)}, got ${showValues(unknownKeys)}`;
};

/**
 * What is wrong with the side, the type, the amount or the price of an order, or undefined when nothing is: a side of ORDER_SIDES and a
 * type of ORDER_TYPES as they are spelt there, an amount and a price above 0 or left out (undefined, or null from an untyped strategy,
 * as the Trader reads them), for an all-in order and for the last price of the pair. Each layer below read them its own way. ccxt's
 * 'buy', which only an untyped strategy can pass, was sized by the Trader as a SELL, all the asset held, which the simulator executed
 * as a SELL and Binance as a BUY; 'market' threw a TypeError in the Trader after the order was initiated, which stopped the bot without
 * naming the strategy. An amount or a price of NaN, 0 or below, or quoted, was refused by the Trader or by the exchange as an error
 * counting towards the circuit breaker.
 */
const getOrderProblem = ({ side, type, amount, price }: StrategyOrder): string | undefined => {
  if (!ORDER_SIDES.includes(side)) return `side must be one of ${showValues(ORDER_SIDES)}, got ${inspect(side)}`;
  if (!ORDER_TYPES.includes(type)) return `type must be one of ${showValues(ORDER_TYPES)}, got ${inspect(type)}`;
  if (!isNil(amount) && !isFinitePositive(amount))
    return `amount must be a number above 0, or left out for an all-in order, got ${inspect(amount)}`;
  if (!isNil(price) && !isFinitePositive(price))
    return `price must be a number above 0, or left out for the last price of the pair, got ${inspect(price)}`;
};

/** The keys of a trailing stop, those of TrailingConfig: the record is typed to hold each of them and no other */
const TRAILING_KEYS = Object.keys({ percentage: true, trigger: true } satisfies Record<keyof TrailingConfig, true>);

/**
 * What is wrong with the trailing stop an order asks for, or undefined when it asks for none or for a valid one: on a BUY only, with no
 * key but those of TrailingConfig, within the bounds the TrailingStopManager checks again as it arms the stop. A trigger left out
 * (undefined, or null from an untyped strategy) asks for a stop active as soon as it is armed.
 */
const getTrailingProblem = ({ side, trailing }: StrategyOrder): string | undefined => {
  if (!trailing) return;
  if (side !== 'BUY') return 'trailing applies to BUY orders only: its stop sells what the BUY filled';
  // A misspelt key was ignored: { percentage: 2, triger: 50000 } armed a stop active at once, not one waiting for 50000
  const unknownKeys = getUnknownKeys(trailing, TRAILING_KEYS);
  if (unknownKeys.length) return `trailing keys must be one of ${showValues(TRAILING_KEYS)}, got ${showValues(unknownKeys)}`;
  const { percentage, trigger } = trailing;
  if (!(Number.isFinite(percentage) && percentage > 0 && percentage < 100))
    return `trailing.percentage must be a number above 0 and below 100 (2.5 for 2.5%), got ${inspect(percentage)}`;
  if (!isNil(trigger) && !(Number.isFinite(trigger) && trigger > 0))
    return `trailing.trigger must be a price above 0, or left out for a stop active as soon as its BUY completes, got ${inspect(trigger)}`;
};

/**
 * The strategy's own copy of a bucket: a timeframe bucket for the candle hooks, the first one-minute bucket for init. A timeframe
 * bucket is the TradingAdvisor's, queued as the timeframe candle event once the hooks have run, and its candles are those the
 * indicators are fed, which some keep (the previous candle of TrueRange, PSAR and ±DM, the window of CCI): a close the strategy
 * overwrote reached the analyzers, the warmup event and every later ATR. A one-minute bucket is the one every plugin receives, which
 * the TradingAdvisor then batches. A candle holds numbers and a flag only, so a spread copies it.
 */
const copyBucket = (bucket: CandleBucket): CandleBucket => {
  const copy: CandleBucket = new Map();
  for (const [pair, candle] of bucket) copy.set(pair, { ...candle });
  return copy;
};

/**
 * The strategy's own copy of an indicator's result: a number or null as it is, an object or an array copied with what it holds (the
 * array of a ribbon). Handed out as it was, the result was the indicator's own object: a write by one hook reached the hooks after it,
 * and the next candles while the indicator handed that object out again, as MACD and Stochastic did while warming up.
 */
const copyResult = (result: unknown): unknown => {
  if (Array.isArray(result)) return result.map(copyResult);
  // Not lodash's isPlainObject, which doubled the cost of a copy: a result is declared as numbers, objects and arrays of them
  if (result === null || typeof result !== 'object') return result;
  const source = result as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key in source) copy[key] = copyResult(source[key]);
  return copy;
};

/**
 * The strategy's own copy of an order event: the StrategyManager reads the event again once the hook has run, to arm and settle the
 * trailing stops, and a BUY whose side the strategy rewrote to SELL canceled the stop it had just armed. The event is the
 * TradingAdvisor's own, each listener of a deferred event getting its copy: what the strategy writes reaches no other plugin either
 * way. It holds plain data and a Map, which copyPayload copies by hand: structuredClone took five times as long, on every order end.
 */
const copyOrderEvent = <O extends OrderInitiatedEvent['order']>(order: O, exchange: ExchangeEvent) => copyPayload({ order, exchange });

/**
 * How a message that is not a string is written (see StrategyManager.log): the objects it holds two levels deep, on one line but for an
 * Error, written with its stack. Not compact, util.inspect wrote an array of more than six items in rows, and whatever held one with it.
 */
const MESSAGE_INSPECT_OPTIONS: InspectOptions = { depth: 2, breakLength: Infinity, compact: true };

/** What a stop sells, and when, as the warnings about it say: its amount, its stop price and the peak that price trails from */
const describeSale = ({ symbol, amount, stopPrice, highestPeak }: TrailingStopState) => {
  const [asset] = symbol.split('/');
  return `${amount} ${asset} once a price reaches its stop price, ${stopPrice}, trailing from its peak, ${highestPeak}`;
};

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
  private pendingTrailingStops = new Map<UUID, TrailingConfig>();
  /** The SELLs the trailing stops sent, until their outcome: told apart from the SELLs the strategy created (see onOrderCompleted) */
  private readonly trailingStopSellIds = new Set<UUID>();
  /** The SELLs the strategy created, with their pair, until their outcome: the stops of that pair hold their trigger (see isTriggerHeld) */
  private readonly strategySellIds = new Map<UUID, TradingPair>();
  /** The stops whose trigger isTriggerHeld held back, until the hold of their pair ends: each is said once per hold */
  private readonly heldStopIds = new Set<UUID>();
  private consecutiveErrors = 0;
  /** The levels outside LogLevel the strategy logged at, each reported once */
  private readonly unknownLogLevels = new Set<unknown>();
  private strategy?: Strategy<object>;
  private tools: Tools<object>;

  constructor(warmupPeriod: number, maxConsecutiveErrors: number = 5) {
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
      strategyParams: cloneDeep(config.getStrategy() ?? {}),
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
      SelectedStrategy = (await import(resolvedPath))[strategyName];
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
    this.consecutiveErrors = 0;
    // The hook gets its own copy of the event (see copyOrderEvent): what follows reads the event itself
    this.strategy?.onOrderCompleted?.({ ...copyOrderEvent(order, exchange), tools: this.tools }, ...this.indicatorsResults);

    this.armPendingTrailingStop(order, order.amount);

    // The SELL of a stop settles that stop alone (see settleCompletedStopSell): the other stops of the pair still protect theirs. A
    // SELL the strategy created closed the position the stops of its pair protected.
    this.strategySellIds.delete(order.id);
    const isTrailingStopSell = this.trailingStopSellIds.delete(order.id);
    if (isTrailingStopSell) this.settleCompletedStopSell(order, exchange);
    else if (order.side === 'SELL') this.cancelTrailingStopsOfPair(order);
  }

  public onOrderCanceled({ order, exchange }: OrderCanceledEvent) {
    this.consecutiveErrors = 0;
    this.strategy?.onOrderCanceled?.({ ...copyOrderEvent(order, exchange), tools: this.tools }, ...this.indicatorsResults);
    // A BUY canceled drops the stop it asked for, even after a partial fill
    this.cancelTrailingOrder(order.id);
    if (this.trailingStopSellIds.delete(order.id)) {
      // What it sold before it expired (a MARKET SELL fills what the book allows), or 0 when its cancelation was answered without the
      // fill: the stop then sells its whole amount again, which the Trader caps to what is free
      const sold = isFiniteNumber(order.filled) && order.filled > 0 ? order.filled : 0;
      this.resumeTrailingStop(order.id, 'was canceled', sold, exchange);
    } else if (this.strategySellIds.delete(order.id)) {
      this.releaseTriggersOfPair(order, 'was canceled');
    }
  }

  public onOrderErrored({ order, exchange }: OrderErroredEvent) {
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
    if (this.trailingStopSellIds.delete(order.id)) {
      this.resumeTrailingStop(order.id, 'errored', filled, exchange, order.reason, order.mayBeLive);
    } else if (this.strategySellIds.delete(order.id)) {
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
        `Strategy ended before its warmup was over, so it never traded: ${this.age} timeframe candle(s) processed, ${this.warmupPeriod + 1} needed (warmup.candleCount: ${this.warmupPeriod}, then one to trade on)`,
      );
    const stops = [...this.trailingStopManager.getOrders().values()];
    const sellingCount = stops.filter(({ status }) => status === 'selling').length;
    const armedCount = stops.length - sellingCount;
    if (armedCount > 0) warning('strategy', `Strategy ended with ${armedCount} active trailing stop(s) that never triggered.`);
    if (sellingCount > 0) warning('strategy', `Strategy ended with ${sellingCount} triggered trailing stop(s) whose SELL had not ended.`);
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
    const orderId = this.createOrder({ symbol: state.symbol, side: 'SELL', type: 'MARKET', amount: state.amount });
    // createOrder kept it as a SELL of the strategy: the SELL of a stop holds no other stop of the pair, each selling its own BUY's fill
    this.strategySellIds.delete(orderId);
    this.trailingStopSellIds.add(orderId);
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

    // @ts-expect-error TODO fix complex typescript error
    const indicator = new Indicator(parameters);
    this.indicators.push({ indicator, symbol });
  }

  private cancelOrder(orderId: UUID): void {
    this.emit<UUID>(STRATEGY_CANCEL_ORDER_EVENT, orderId);
  }

  private cancelTrailingOrder(orderId: UUID): void {
    this.pendingTrailingStops.delete(orderId);
    this.trailingStopManager.removeOrder(orderId);
    this.heldStopIds.delete(orderId);
  }

  private createOrder(order: StrategyOrder): UUID {
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
    // Until its outcome, a SELL holds back the triggers of the stops of its pair (see isTriggerHeld)
    if (order.side === 'SELL') this.strategySellIds.set(id, order.symbol);

    this.emit<AdviceOrder>(STRATEGY_CREATE_ORDER_EVENT, { ...omit(order, 'trailing'), id, orderCreationDate });
    return id;
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
        // strat_info subscribers as as many Telegram messages. Not even formatted below GEKKO_LOG_LEVEL: winston formats a line before
        // its level filter drops it, and with the relay that was most of the cost of a candle in a backtest.
        if (isLevelEnabled('debug')) debug('strategy', text);
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
   * and its stop never trailed. A side, a type, an amount or a price an untyped strategy got wrong was relayed as it was (see
   * getOrderProblem). The trailing stop of a BUY was only checked once the BUY had completed: an invalid one was refused then, with a
   * warning, and the position the BUY had just opened kept no stop. One given to a SELL was dropped without a word.
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
    if (!mayBeLive) {
      warning('strategy', `Trailing stop of BUY ${stop.id} active again: its SELL ${sellId} ${ending}. It sells ${selling}`);
      return;
    }
    warning(
      'strategy',
      [
        `Trailing stop of BUY ${stop.id} kept: its SELL ${sellId} ${ending}, and may still have gone through on the exchange, where`,
        `Gekko follows it no more. Check that SELL there. The stop stays armed, selling ${selling}: if that SELL went through, the next`,
        `one is refused for lack of free ${asset} and the stop removed, unless the account holds other ${asset} free, which it would sell`,
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
   * capped to what is, and nothing is left to protect. The stop is then over, said at info level.
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
        `of the market). It sells ${describeSale(resumed)}`,
      ].join(' '),
    );
  }

  /**
   * Whether the portfolio after the SELL of a stop (`exchange`) shows too little of its asset free to sell: nothing is left for the
   * stop to protect. Not while a SELL the strategy created is pending on the pair, whose reservation of the asset leaves little free
   * while the position is held: that SELL decides (see isTriggerHeld). Nor when the portfolio does not list the asset, read before the
   * first synchronization: nothing tells then. Too little is the PositionTracker's rule (see isSellable), for the MARKET SELL the stop
   * sends.
   */
  private isNothingFreeToSell({ symbol }: TrailingStopState, { portfolio, price }: ExchangeEvent): boolean {
    const [asset] = symbol.split('/');
    const free = portfolio.get(asset)?.free;
    if (!isFiniteNumber(free) || this.getStrategySellIds(symbol).length > 0) return false;
    return !isSellable(free, price, 'MARKET', this.marketData.get(symbol));
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
    return [...this.strategySellIds].filter(([, pair]) => pair === symbol).map(([id]) => id);
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
