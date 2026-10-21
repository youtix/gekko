import { IndicatorNames } from '@indicators/indicator.types';
import { AdviceOrder, StrategyOrder } from '@models/advice.types';
import { CandleBucket } from '@models/event.types';
import { LogLevel } from '@models/logLevel.types';
import { Portfolio } from '@models/portfolio.types';
import { TradingPair } from '@models/utility.types';
import { MarketData } from '@services/exchange/exchange.types';
import {
  AddIndicatorFn,
  LoggerFn,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Strategy,
  Tools,
} from '@strategies/strategy.types';
import { noop, pick } from 'lodash-es';
import { UUID } from 'node:crypto';

export type OrderOutcome = 'completed' | 'canceled' | 'errored';
/** A strategy's order hooks, or those of a PositionTracker */
type OrderHooks<T> = Pick<Strategy<T>, 'onOrderCompleted' | 'onOrderCanceled' | 'onOrderErrored'>;
/** An order as the events of its outcome describe it: its id, and what the Trader relays with it */
type RelayedOrder = Pick<AdviceOrder, 'id'> & Partial<Omit<AdviceOrder, 'id' | 'orderCreationDate'>>;

/**
 * What the event of an outcome reports besides its order. Each part left out reports nothing of an execution, as the Trader relays
 * an order canceled with no fill reported (neither filled nor remaining) before it ever read the portfolio (empty), the price unknown
 * (0), on a market without minimums.
 */
export type OutcomeFacts = {
  /** What a cancelation reports filled; left out, or given as undefined, the event misses it, as the order leaves out a fill unknown */
  filled?: number;
  /** What a cancelation reports remaining; left out, or given as undefined, the event misses it */
  remaining?: number;
  /** The portfolio after the order */
  portfolio?: Portfolio;
  /** The price of the order's pair */
  price?: number;
  /** tools.marketData */
  marketData?: Map<TradingPair, MarketData>;
  /** tools.log */
  log?: LoggerFn;
};

/** The id of an order the strategy did not create, relayed by the step '<outcome>:unknown' */
export const UNKNOWN_ORDER_ID: UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/** A portfolio holding `free` of the asset of `symbol`, and `used` reserved by an order, as the Trader reads it after an order */
export const holding = (symbol: TradingPair, free: number, used = 0): Portfolio => {
  const [asset] = symbol.split('/');
  return new Map([[asset, { free, used, total: free + used }]]);
};

/**
 * Stands in for tools.createOrder: records every order as it was created, and gives the n-th one the id
 * 00000000-0000-0000-0000-00000000000n. An all-in order keeps its amount left out: recorded with amount 1, it could not be told from
 * an order of 1 unit, and a strategy that stopped trading all-in kept its suite green.
 */
export class OrderRecorder {
  readonly advices: StrategyOrder[] = [];
  readonly ids: UUID[] = [];

  readonly createOrder = (order: StrategyOrder): UUID => {
    this.advices.push({ ...order });
    const id = `00000000-0000-0000-0000-${String(this.advices.length).padStart(12, '0')}` as UUID;
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
  const exchange = { portfolio, price };
  const tools = { marketData, log };
  switch (outcome) {
    case 'completed':
      return target.onOrderCompleted?.({ order, exchange, tools } as unknown as OnOrderCompletedEventParams<T>);
    case 'canceled': {
      const params = { order: { ...order, ...pick(facts, 'filled', 'remaining') }, exchange, tools };
      return target.onOrderCanceled?.(params as unknown as OnOrderCanceledEventParams<T>);
    }
    case 'errored':
      return target.onOrderErrored?.({ order, exchange, tools } as unknown as OnOrderErroredEventParams<T>);
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

/** What init warns, through tools.log, on a bucket of BTC/USDT then ETH/USDT: the strategy trades the first pair only */
export const ETH_IGNORED_WARNING: LoggedLine = {
  level: 'warn',
  message:
    'The strategy trades BTC/USDT only, the first pair watched (watch.assets): it ignores ETH/USDT, whose candles are still required every minute',
};

/** An addIndicator call: the name of the indicator, its pair and its parameters */
type AddedIndicator = [name: IndicatorNames, symbol: TradingPair, parameters: unknown];

/**
 * Plays init as the StrategyManager does, on the first one-minute bucket: a candle of each of `pairs`, in their order (that of
 * watch.assets), with the strategy's parameters; returns the lines it logged and its addIndicator calls, each in order
 */
export const playInit = <T>(strategy: Pick<Strategy<T>, 'init'>, pairs: TradingPair[], strategyParams: T) => {
  const logs: LoggedLine[] = [];
  const indicators: AddedIndicator[] = [];
  const candle: CandleBucket = new Map(pairs.map(pair => [pair, { start: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 }]));
  const log: LoggerFn = (level, message) => logs.push({ level, message });
  const addIndicator: AddIndicatorFn = (name, symbol, parameters) => {
    indicators.push([name, symbol, parameters]);
  };
  strategy.init?.({ candle, portfolio: new Map(), tools: { strategyParams, log } as Tools<T>, addIndicator });
  return { logs, indicators };
};

/** The lines init logs, in order (see playInit) */
export const logsAtInit = <T>(strategy: Pick<Strategy<T>, 'init'>, pairs: TradingPair[], strategyParams: T): LoggedLine[] =>
  playInit(strategy, pairs, strategyParams).logs;
