import type { StrategyOrder } from '@models/advice.types';
import { isNil } from 'lodash-es';
import { DebugBacktestParams } from './debugBacktest.types';

/**
 * What sizes every order: an amount of 1, for a PnL known to the unit, the SELL closing the position the BUY opened, unless the block
 * has the Trader size the orders: no amount with allIn (all-in), the cost or the allocation alone with either. A key not used is left
 * out rather than undefined, as a built-in strategy creates its all-in orders.
 */
export const getSizing = ({ allIn, cost, allocation }: DebugBacktestParams): Pick<StrategyOrder, 'amount' | 'cost' | 'allocation'> => {
  if (allIn) return {};
  if (!isNil(cost)) return { cost };
  if (!isNil(allocation)) return { allocation };
  return { amount: 1 };
};
