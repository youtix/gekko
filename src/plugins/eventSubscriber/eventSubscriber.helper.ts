import { describeError } from '@errors/error.helper';
import { AdviceOrder } from '@models/advice.types';
import { formatAmount } from '@utils/string/string.utils';
import { isNil } from 'lodash-es';
import { Event } from './eventSubscriber.types';

/** How the logs say that a notification was not sent */
export const describeNotSent = (event: Event, err: unknown) => `The ${event} notification was not sent: ${describeError(err)}`;

/**
 * What an advice asks to trade, as its strat_create notification writes it: the amount the strategy gave, else its cost in the
 * currency, else its share of the currency a BUY spends or of the asset a SELL sells, else auto for an all-in order. createOrder
 * relays at most one of the three, and null from an untyped strategy as it was given, which the Trader reads as left out.
 */
export const describeRequestedAmount = ({ symbol, side, amount, cost, allocation }: AdviceOrder) => {
  const [asset, currency] = symbol.split('/');
  if (!isNil(amount)) return formatAmount(amount);
  if (!isNil(cost)) return `${formatAmount(cost)} ${currency} worth`;
  if (!isNil(allocation)) return `${formatAmount(allocation)} % of the ${side === 'BUY' ? currency : asset}`;
  return 'auto';
};
