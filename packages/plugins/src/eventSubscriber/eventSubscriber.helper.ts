import { describeError } from '@gekko/shared/errors/error.helper';
import { calculatePortfolioTotalValue, getAssetBalance } from '@gekko/shared/helpers/portfolio/portfolio.helper';
import { AdviceOrder } from '@gekko/shared/models/advice.types';
import { formatDurationUTC, toISOString } from '@gekko/shared/utils/date/date.utils';
import { formatAmount } from '@gekko/shared/utils/string/string.utils';
import { isNil, uniq } from 'lodash-es';
import { Event, PortfolioAnswerParams } from './eventSubscriber.types';

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

/**
 * The price line of an advice, as its strat_create notification writes it, and of the order created from it, as its order_init one
 * does. The Trader places an order of any type at the price of its advice, or without one at the market price (see
 * Trader.onStrategyCreateOrder): a LIMIT one with a price requests it as its limit, any other is placed or sized at that price, its
 * target, `marketPrice` without one (unknown before any close of its pair). A MARKET or a STICKY order executes at the market whatever
 * its price, which only sizes a BUY without an amount, all-in or by a cost or an allocation, or a SELL by a cost: order_init read
 * "Requested limit price" for any order with a price, while strat_create, of the same order, read "Target price".
 */
export const describeTargetPrice = ({ type, price, symbol }: Pick<AdviceOrder, 'type' | 'price' | 'symbol'>, marketPrice?: number) => {
  const [, currency] = symbol.split('/');
  if (type === 'LIMIT' && !isNil(price)) return `Requested limit price: ${formatAmount(price)} ${currency}`;
  const target = price ?? marketPrice;
  return `Target price: ${isNil(target) ? 'unknown' : formatAmount(target)} ${currency}`;
};

/**
 * The answer to /portfolio, one line after the other. First the balances of the last read of the Trader's portfolio the events
 * brought, dated with that read and its age, since Telegram shows when a message was sent, not when its figures were read: with the
 * time of the read, which an order event says, or with the reception of a portfolioChange, which does not (see KeptPortfolio). The
 * balances of each watched asset, then of the currency, 0 for one the portfolio lacks. Then the close of each pair's last 1-minute
 * candle, dated with the close of their bucket, a pair without one left out. Last, with both, the value of the portfolio at those
 * closes in the currency, an asset without a close adding nothing (see calculatePortfolioTotalValue).
 */
export const describePortfolioAnswer = (params: PortfolioAnswerParams) => {
  const { kept, prices, pricesAt, pairs, assets, currency, now } = params;
  const lines: string[] = [];
  if (kept) {
    const { portfolio, at, dated } = kept;
    // A clock set back since then reads as just now, rather than as a negative age
    const age = formatDurationUTC(at, Math.max(at, now));
    const when = dated === 'read' ? ` at ${toISOString(at)}` : `, received at ${toISOString(at)}`;
    lines.push(`Balances read by the Trader${when} (${age ? `${age} ago` : 'just now'})`);
    // The currency once, were it listed among the assets
    for (const asset of uniq([...assets, currency])) {
      const { total, free, used } = getAssetBalance(portfolio, asset);
      lines.push(`${asset}: ${formatAmount(total)} (free ${formatAmount(free)}, used ${formatAmount(used)})`);
    }
  } else {
    lines.push('No balance received from the Trader yet (no Trader configured, or its first read still on its way)');
  }
  if (isNil(pricesAt)) {
    lines.push('No price yet: no 1-minute candle has been processed');
  } else {
    lines.push(`Prices at the close of ${toISOString(pricesAt)}`);
    for (const pair of pairs) {
      const price = prices.get(pair);
      if (!isNil(price)) lines.push(`${pair}: ${formatAmount(price)} ${currency}`);
    }
    if (kept) {
      const total = calculatePortfolioTotalValue(kept.portfolio, prices, currency, assets, pairs);
      lines.push(`Total value: ${formatAmount(total)} ${currency}`);
    }
  }
  return lines.join('\n');
};
