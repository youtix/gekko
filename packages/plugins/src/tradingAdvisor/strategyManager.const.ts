import { StrategyOrder, TrailingConfig } from '@gekko/shared/models/advice.types';
import { InspectOptions } from 'node:util';

/** The keys of an order, those of StrategyOrder: the record is typed to hold each of them and no other */
export const ORDER_KEYS = Object.keys({
  symbol: true,
  side: true,
  type: true,
  amount: true,
  cost: true,
  allocation: true,
  price: true,
  trailing: true,
} satisfies Record<keyof StrategyOrder, true>);

/** The keys that size an order, each its own way (see Tools.createOrder): an order holds at most one of them, none for an all-in order */
export const SIZING_KEYS = ['amount', 'cost', 'allocation'] as const satisfies readonly (keyof StrategyOrder)[];

/** The keys of a trailing stop, those of TrailingConfig: the record is typed to hold each of them and no other */
export const TRAILING_KEYS = Object.keys({ percentage: true, trigger: true } satisfies Record<keyof TrailingConfig, true>);

/**
 * The most orders the StrategyManager keeps pending, those whose outcome it has not heard of yet (see StrategyManager.pendingOrders):
 * beyond, it forgets the oldest. Without a Trader (a screener) no order ever ends, and one kept per advice grew the manager for the
 * life of the run, about 58 MB a year of advices on 1m candles. With one, the orders pending are those open on the exchange, far fewer.
 */
export const MAX_PENDING_ORDERS = 10_000;

/**
 * How a message that is not a string is written (see StrategyManager.log): the objects it holds two levels deep, on one line but for an
 * Error, written with its stack. Not compact, util.inspect wrote an array of more than six items in rows, and whatever held one with it.
 */
export const MESSAGE_INSPECT_OPTIONS: InspectOptions = { depth: 2, breakLength: Infinity, compact: true };
