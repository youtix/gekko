import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { IndicatorNames } from '@gekko/indicators/indicator.types';
import { AdviceOrder, StrategyOrder } from '@gekko/shared/models/advice.types';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { LogLevel } from '@gekko/shared/models/logLevel.types';
import { OrderSide } from '@gekko/shared/models/order.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { MarketData } from '@gekko/shared/models/exchange.types';
import {
  AddIndicatorFn,
  IndicatorResults,
  LoggerFn,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Positions,
  PositionBuyOrder,
  PositionSellOrder,
  Strategy,
  Tools,
} from './strategy.types';
import { listInWords, pluralize } from '@gekko/shared/utils/string/string.utils';
import { bindAll, noop, pick } from 'lodash-es';
import { UUID } from 'node:crypto';

export type OrderOutcome = 'completed' | 'canceled' | 'errored';
/** A strategy's order hooks, or those of the position book and of its trackers */
type OrderHooks<T> = Pick<Strategy<T>, 'onOrderCompleted' | 'onOrderCanceled' | 'onOrderErrored'>;
/** An order as the events of its outcome describe it: its id, and what the Trader relays with it */
type RelayedOrder = Pick<AdviceOrder, 'id'> & Partial<Omit<AdviceOrder, 'id' | 'orderCreationDate'>>;

/**
 * What the event of an outcome reports besides its order. Each part left out reports nothing of an execution, as the Trader relays
 * an order canceled with no fill reported (neither filled nor remaining) before it ever read the portfolio (empty), the price unknown
 * (0), on a market without minimums.
 */
export type OutcomeFacts = {
  /**
   * What a cancelation, or an error, reports filled; left out, or given as undefined, the event misses it, as the order leaves out a
   * fill unknown
   */
  filled?: number;
  /** What a cancelation reports remaining; left out, or given as undefined, the event misses it */
  remaining?: number;
  /** Whether an order that errored may still be live on the exchange (OrderErroredEvent.mayBeLive); left out, the event misses it */
  mayBeLive?: boolean;
  /** The portfolio after the order */
  portfolio?: Portfolio;
  /**
   * Whether the Trader read that portfolio after the order ended (ExchangeEvent.portfolioReadAfterOrder); left out, the event misses
   * it, as before the Trader's first read
   */
  portfolioReadAfterOrder?: boolean;
  /** The price of the order's pair */
  price?: number;
  /** tools.marketData */
  marketData?: Map<TradingPair, MarketData>;
  /** tools.log */
  log?: LoggerFn;
};

/** The id of an order the strategy did not create, relayed by the step '<outcome>:unknown' */
export const UNKNOWN_ORDER_ID: UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/**
 * The id OrderRecorder and ScriptedPositions give the n-th order, from 1: 00000000-0000-0000-0000-00000000000n. Each numbers its own
 * orders: a suite reads the orders of a strategy through one of them.
 */
export const orderId = (n: number): UUID => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

/** A portfolio holding `free` of the asset of `symbol`, and `used` reserved by an order, as the Trader reads it after an order */
export const holding = (symbol: TradingPair, free: number, used = 0): Portfolio => {
  const [asset] = symbol.split('/');
  return new Map([[asset, { free, used, total: free + used }]]);
};

/**
 * Stands in for tools.createOrder: records every order as it was created, and gives the n-th one the id
 * 00000000-0000-0000-0000-00000000000n (see orderId). An all-in order keeps its amount left out: recorded with amount 1, it could not be
 * told from an order of 1 unit, and a strategy that stopped trading all-in kept its suite green.
 */
export class OrderRecorder {
  readonly advices: StrategyOrder[] = [];
  readonly ids: UUID[] = [];

  readonly createOrder = (order: StrategyOrder): UUID => {
    this.advices.push({ ...order });
    const id = orderId(this.advices.length);
    this.ids.push(id);
    return id;
  };

  /** The n-th order created, from 1, as the events of its outcome describe it; undefined when there is none */
  created(n: number): RelayedOrder | undefined {
    const advice = this.advices[n - 1];
    if (!advice) return undefined;
    const { symbol, side, type, amount, price } = advice;
    return { id: this.ids[n - 1], symbol, side, type, amount, price };
  }
}

/** Relays the outcome of an order to the order hook, with what its event reports besides (see OutcomeFacts); returns what it returns */
export const relayOrderOutcome = <T>(
  target: OrderHooks<T>,
  outcome: OrderOutcome,
  order: RelayedOrder,
  facts: OutcomeFacts = {},
): unknown => {
  const { portfolio = new Map(), price = 0, marketData = new Map(), log = noop } = facts;
  const exchange = { portfolio, price, ...pick(facts, 'portfolioReadAfterOrder') };
  const tools = { marketData, log };
  switch (outcome) {
    case 'completed':
      return target.onOrderCompleted?.({ order, exchange, tools } as unknown as OnOrderCompletedEventParams<T>);
    case 'canceled': {
      const params = { order: { ...order, ...pick(facts, 'filled', 'remaining') }, exchange, tools };
      return target.onOrderCanceled?.(params as unknown as OnOrderCanceledEventParams<T>);
    }
    case 'errored': {
      const params = { order: { ...order, ...pick(facts, 'filled', 'mayBeLive') }, exchange, tools };
      return target.onOrderErrored?.(params as unknown as OnOrderErroredEventParams<T>);
    }
    default:
      throw new Error(`Unknown order outcome: ${outcome}`);
  }
};

/**
 * Plays the steps, separated by spaces: '<outcome>:<n>' relays the outcome (completed, canceled, errored) of the n-th order the
 * recorder gave an id, its event reporting nothing of an execution (see OutcomeFacts), '<outcome>:<n>:<free>' with a portfolio
 * holding <free> of the order's asset after it, '<outcome>:unknown' that of an order the strategy did not create, and playStep plays
 * any other step (a candle).
 */
export const playSteps = <T>(steps: string, target: OrderHooks<T>, orders: OrderRecorder, playStep: (step: string) => void): void => {
  for (const step of steps.split(' ').filter(Boolean)) {
    const [kind, n, free] = step.split(':');
    if (!n) {
      playStep(kind);
      continue;
    }
    const order = n === 'unknown' ? { id: UNKNOWN_ORDER_ID } : orders.created(Number(n));
    if (!order) throw new Error(`No order ${n} to relay the outcome of, in "${steps}"`);
    if (free === undefined) {
      relayOrderOutcome(target, kind as OrderOutcome, order);
      continue;
    }
    if (!order.symbol || !/^\d+(\.\d+)?$/.test(free)) throw new Error(`No portfolio holding "${free}" after order ${n}, in "${steps}"`);
    relayOrderOutcome(target, kind as OrderOutcome, order, { portfolio: holding(order.symbol, Number(free)) });
  }
};

/** A line logged through tools.log */
export type LoggedLine = { level: LogLevel; message: string };

/** What track logs, through tools.log, on a bucket of BTC/USDT then ETH/USDT: the pairs traded, and the rule of their orders */
export const BTC_ETH_TRADED_INFO: LoggedLine = {
  level: 'info',
  message:
    'Trading BTC/USDT and ETH/USDT: each BUY takes an equal share of the free currency among the pairs not invested, each SELL sells all of its asset',
};

/**
 * What a pair of ScriptedPositions answers, as the position book answers once the outcomes the test has in mind are settled:
 * - FLAT: not long, nothing pending, so canBuy: at start-up, after a SELL that sold everything, after a BUY canceled or errored without
 *   a fill;
 * - LONG: long, nothing pending, so canSell: after a BUY that completed;
 * - BUYING: not long, a BUY pending, so neither canBuy nor canSell;
 * - SELLING: long, a SELL pending, so neither;
 * - SKIPPING: as FLAT, but the book skips the BUYs of the pair, as a book of several pairs skips a share under a minimum of the
 *   market: buy returns undefined.
 */
export type ScriptedPosition = 'FLAT' | 'LONG' | 'BUYING' | 'SELLING' | 'SKIPPING';

/** What each scripted position answers to isLong and isPendingOrder (see ScriptedPosition) */
const POSITION_ANSWERS: Record<ScriptedPosition, { isLong: boolean; isPendingOrder: boolean }> = {
  FLAT: { isLong: false, isPendingOrder: false },
  LONG: { isLong: true, isPendingOrder: false },
  BUYING: { isLong: false, isPendingOrder: true },
  SELLING: { isLong: true, isPendingOrder: true },
  SKIPPING: { isLong: false, isPendingOrder: false },
};

/** Whether a step names a scripted position (see playPositionSteps) */
const isScriptedPosition = (name: string): name is ScriptedPosition => Object.hasOwn(POSITION_ANSWERS, name);

/**
 * An order the strategy asked of tools.positions: the order as it gave it, with its side, and `skipped` for a BUY of a pair SKIPPING,
 * which got no id (see ScriptedPositions)
 */
export type AskedOrder = (PositionBuyOrder | PositionSellOrder) & { side: OrderSide; skipped?: true };

/**
 * Stands in for tools.positions in a strategy suite, which checks that the signal makes the right call: the test says what each pair
 * answers (see set), and reads what the strategy asked (advices). It has no transition of its own: an order asked changes no answer,
 * and the test sets each position before the step that reads it, as the position book would have settled it. The book's own
 * behaviour (the shares, the skips, the settlement of the outcomes, its lines) is tested where it lives, in @gekko/plugins.
 *
 * - Built with the pairs watched, in the order of watch.assets: track() tracks them all, track(pairs) those given, each a watched pair
 *   (any other throws); called a second time, it throws the GekkoError of the position book. It replays no other refusal of
 *   tools.positions.track (an empty list, a pair named twice, a call once init has returned): the StrategyManager's suite covers
 *   them. `pairs` is empty before track, and each call is recorded (trackCalls). Build one for each strategy under test, as each run
 *   has its own: tracked by one strategy, it would hand another the pairs that one never set up.
 * - A pair answers as its position says (see ScriptedPosition), FLAT until the test sets another: canBuy when flat with nothing pending,
 *   canSell when long with nothing pending. A pair not tracked, every pair before track among them, answers false to all four.
 * - buy and sell record the order as the strategy gave it, with its side (see AskedOrder), and return the id of the n-th order asked of
 *   either, from 1 (see orderId). A BUY of a pair SKIPPING is recorded too, flagged `skipped`, and returns undefined, as a BUY the book
 *   skips. An order of a pair not tracked throws the GekkoError of the position book, before anything is recorded.
 */
export class ScriptedPositions implements Positions {
  /** The orders asked of buy and sell, in order (see AskedOrder) */
  readonly advices: AskedOrder[] = [];
  /** The arguments of each call to track, in order: [] for a call without pairs, [pairs] for one with */
  readonly trackCalls: [pairs?: TradingPair[]][] = [];
  /** The pairs watched, in the order of watch.assets */
  readonly watched: readonly TradingPair[];
  /** The positions the test set, by pair: FLAT for the others */
  private readonly positions = new Map<TradingPair, ScriptedPosition>();
  /** The pairs tracked, in the order track took them: none before track */
  private tracked: readonly TradingPair[] = [];
  private isTracking = false;

  constructor(watched: readonly TradingPair[]) {
    this.watched = [...watched];
    // A strategy may take tools.positions apart (`const { canBuy, buy } = tools.positions`), whose members are closures in a run:
    // unbound, a member called alone lost its instance, and a strategy that passed in a run failed in its suite
    bindAll(this, [
      this.track.name,
      this.isLong.name,
      this.isPendingOrder.name,
      this.canBuy.name,
      this.canSell.name,
      this.buy.name,
      this.sell.name,
    ]);
  }

  get pairs(): readonly TradingPair[] {
    return this.tracked;
  }

  track(...args: [pairs?: TradingPair[]]): void {
    this.trackCalls.push(args);
    if (this.isTracking) throw new GekkoError('strategy', 'The position book tracks its pairs already: track is called once, from init');
    const [pairs] = args;
    const unwatched = pairs?.find(pair => !this.watched.includes(pair));
    if (unwatched) throw new Error(`The scripted positions watch no ${unwatched}: they watch ${listInWords(this.watched)}`);
    this.tracked = [...(pairs ?? this.watched)];
    this.isTracking = true;
  }

  isLong(pair: TradingPair): boolean {
    return this.isTracked(pair) && POSITION_ANSWERS[this.positionOf(pair)].isLong;
  }

  isPendingOrder(pair: TradingPair): boolean {
    return this.isTracked(pair) && POSITION_ANSWERS[this.positionOf(pair)].isPendingOrder;
  }

  canBuy(pair: TradingPair): boolean {
    return this.isTracked(pair) && !this.isLong(pair) && !this.isPendingOrder(pair);
  }

  canSell(pair: TradingPair): boolean {
    return this.isLong(pair) && !this.isPendingOrder(pair);
  }

  buy(order: PositionBuyOrder): UUID | undefined {
    this.refuseUntracked('BUY', order);
    if (this.positionOf(order.symbol) !== 'SKIPPING') return this.record({ ...order, side: 'BUY' });
    this.record({ ...order, side: 'BUY', skipped: true });
    return undefined;
  }

  sell(order: PositionSellOrder): UUID {
    this.refuseUntracked('SELL', order);
    return this.record({ ...order, side: 'SELL' });
  }

  /** Sets what `pair`, a watched pair, answers from now on (see ScriptedPosition), tracked yet or not */
  set(pair: TradingPair, position: ScriptedPosition): void {
    if (!this.watched.includes(pair)) throw new Error(`The scripted positions watch no ${pair}: they watch ${listInWords(this.watched)}`);
    this.positions.set(pair, position);
  }

  private isTracked(pair: TradingPair) {
    return this.tracked.includes(pair);
  }

  private positionOf(pair: TradingPair): ScriptedPosition {
    return this.positions.get(pair) ?? 'FLAT';
  }

  /** Records the order asked; returns the id of the n-th order asked (see orderId) */
  private record(order: AskedOrder): UUID {
    this.advices.push(order);
    return orderId(this.advices.length);
  }

  /** Throws, as the position book does, for an order of a pair it does not track */
  private refuseUntracked(side: OrderSide, { symbol, type }: PositionSellOrder) {
    if (this.isTracked(symbol)) return;
    const tracked = this.tracked.length > 0 ? listInWords(this.tracked) : 'no pair until init calls track';
    const problem = `the position book does not track it (it tracks ${tracked})`;
    throw new GekkoError('strategy', `Impossible to place the ${side} ${type} order on ${symbol}: ${problem}`);
  }
}

/**
 * Plays the steps, separated by spaces: a step that names a position (see ScriptedPosition) for each pair watched, in their order,
 * separated by '/' or ',' ('LONG' on one pair, 'LONG/BUYING' or 'LONG,BUYING' on two), sets what those pairs answer from then on (see
 * ScriptedPositions.set), and playCandle plays any other step (a candle). Nothing else changes a position: an order asked changes none.
 */
export const playPositionSteps = (steps: string, positions: ScriptedPositions, playCandle: (step: string) => void): void => {
  for (const step of steps.split(' ').filter(Boolean)) {
    const named = step.split(/[/,]/);
    if (!named.every(isScriptedPosition)) {
      playCandle(step);
      continue;
    }
    const { watched } = positions;
    if (named.length !== watched.length) {
      const expected = `one for each pair watched, in their order (${listInWords(watched)})`;
      throw new Error(`The step ${step} names ${named.length} ${pluralize('position', named.length)}, ${expected}, in "${steps}"`);
    }
    named.forEach((position, index) => positions.set(watched[index], position));
  }
};

/**
 * Stands in for tools.indicatorsBySymbol, grouping as the StrategyManager's does: the results of each pair in the order of the
 * arguments, the pairs in the order of their first indicator
 */
export const indicatorsBySymbol = <R>(indicators: readonly IndicatorResults<R>[]): Map<TradingPair, IndicatorResults<R>[]> => {
  const bySymbol = new Map<TradingPair, IndicatorResults<R>[]>();
  for (const indicator of indicators) {
    const ofSymbol = bySymbol.get(indicator.symbol);
    if (ofSymbol) ofSymbol.push(indicator);
    else bySymbol.set(indicator.symbol, [indicator]);
  }
  return bySymbol;
};

/** What a strategy suite hands the hooks and reads or scripts of it (see fakeTools) */
export type FakeTools<T> = {
  /** The tools every hook gets: one object for the whole run, as the StrategyManager's */
  tools: Tools<T>;
  /** tools.positions, which the test scripts and reads (see ScriptedPositions) */
  positions: ScriptedPositions;
  /** The lines logged through tools.log, in order */
  logs: LoggedLine[];
  /** The orders created through tools.createOrder (see OrderRecorder) */
  orders: OrderRecorder;
};

/** The tools fakeTools takes besides the parameters, and the pairs watched */
export type FakeToolsOptions<T> = Partial<Pick<Tools<T>, 'marketData' | 'cancelOrder' | 'cancelTrailingOrder'>> & {
  /** The pairs watched, in the order of watch.assets: those tools.positions tracks (see ScriptedPositions); BTC/USDT unless given */
  pairs?: TradingPair[];
};

/**
 * Fake tools for a strategy suite, as the StrategyManager hands them to the hooks: `strategyParams`, tools.positions scripted positions
 * of the pairs watched (see ScriptedPositions), tools.indicatorsBySymbol grouping as the manager's (see indicatorsBySymbol), tools.log
 * recording each line in `logs`, then throwing a GekkoError on an error line, as the manager's does, tools.createOrder recording each
 * order in `orders`, tools.marketData empty and tools.cancelOrder and tools.cancelTrailingOrder doing nothing, unless given.
 */
export const fakeTools = <T>(strategyParams: T, { pairs = ['BTC/USDT'], ...given }: FakeToolsOptions<T> = {}): FakeTools<T> => {
  const positions = new ScriptedPositions(pairs);
  const logs: LoggedLine[] = [];
  const orders = new OrderRecorder();
  const log: LoggerFn = (level, message) => {
    logs.push({ level, message });
    // The bot stops on an error line: a strategy never runs what follows it
    if (level === 'error') throw new GekkoError('strategy', message);
  };
  const tools: Tools<T> = {
    strategyParams,
    marketData: new Map(),
    log,
    createOrder: orders.createOrder,
    cancelOrder: noop,
    cancelTrailingOrder: noop,
    positions,
    indicatorsBySymbol,
    ...given,
  };
  return { tools, positions, logs, orders };
};

/** An addIndicator call: the name of the indicator, its pair and its parameters */
export type AddedIndicator = [name: IndicatorNames, symbol: TradingPair, parameters: unknown];

/** What playInit returns: the fake tools init got (see fakeTools), and its addIndicator calls, in order */
export type PlayedInit<T> = FakeTools<T> & { indicators: AddedIndicator[] };

/**
 * Plays init as the StrategyManager does, on the first one-minute bucket: a candle of each of `pairs`, in their order (that of
 * watch.assets), with the strategy's parameters and fake tools of those pairs (see fakeTools), which the test can go on playing the
 * hooks with; returns those tools, with the lines init logged and its addIndicator calls, each in order
 */
export const playInit = <T>(strategy: Pick<Strategy<T>, 'init'>, pairs: TradingPair[], strategyParams: T): PlayedInit<T> => {
  const fake = fakeTools(strategyParams, { pairs });
  const indicators: AddedIndicator[] = [];
  const candle: CandleBucket = new Map(pairs.map(pair => [pair, { start: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 }]));
  const addIndicator: AddIndicatorFn = (name, symbol, parameters) => {
    indicators.push([name, symbol, parameters]);
  };
  strategy.init?.({ candle, portfolio: new Map(), tools: fake.tools, addIndicator });
  return { ...fake, indicators };
};

/** The lines init logs, in order (see playInit) */
export const logsAtInit = <T>(strategy: Pick<Strategy<T>, 'init'>, pairs: TradingPair[], strategyParams: T): LoggedLine[] =>
  playInit(strategy, pairs, strategyParams).logs;

/**
 * The indicator arguments of a hook, as the StrategyManager passes them to a strategy that adds the same indicators on every pair,
 * pair by pair: the results given for each pair, in the order of its addIndicator calls, the pairs in the order given (that of
 * watch.assets). `indicatorArguments({ 'BTC/USDT': [1, 2], 'ETH/USDT': [3, 4] })` is DEMA's dema and sma of BTC/USDT, then of ETH/USDT.
 */
export const indicatorArguments = <T>(resultsByPair: Record<TradingPair, readonly T[]>): IndicatorResults<T>[] =>
  Object.entries(resultsByPair).flatMap(([symbol, results]) => results.map(result => ({ results: result, symbol: symbol as TradingPair })));

/**
 * A bucket holding a flat candle of each pair at the close given (open, high, low and close alike), the pairs in the order given (that
 * of watch.assets), each candle starting at `start`, a real minute, the first of 2024 (UTC) unless given: `flatBucket({ 'BTC/USDT':
 * 110, 'ETH/USDT': 90 })`. Every candle used to start at 0, the epoch, so that a suite could not play buckets one minute after another.
 */
export const flatBucket = (closeByPair: Record<TradingPair, number>, start = Date.UTC(2024, 0, 1)): CandleBucket =>
  new Map(
    Object.entries(closeByPair).map(([pair, close]) => [
      pair as TradingPair,
      { start, open: close, high: close, low: close, close, volume: 1 },
    ]),
  );

/**
 * Plays init as the StrategyManager does, on the first one-minute bucket: a candle of each of `pairs`, in their order (that of
 * watch.assets), with the strategy's parameters (see playInit); returns its addIndicator calls, in order
 */
export const indicatorsAtInit = <T>(strategy: Pick<Strategy<T>, 'init'>, pairs: TradingPair[], strategyParams: T) =>
  playInit(strategy, pairs, strategyParams).indicators;
