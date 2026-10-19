import { describeError } from '@errors/error.helper';
import { calculatePortfolioTotalValue, getAssetBalance } from '@helpers/portfolio/portfolio.helper';
import { AdviceOrder } from '@models/advice.types';
import { formatDurationUTC, toISOString } from '@utils/date/date.utils';
import { formatAmount } from '@utils/string/string.utils';
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
 * The answer to /portfolio, one line after the other. First the balances of the last portfolio received, dated with its reception and
 * its age, since Telegram shows when a message was sent, not when its figures were read: those of each watched asset, then of the
 * currency, 0 for one the portfolio lacks. Then the close of each pair's last 1-minute candle, dated with the close of their bucket, a
 * pair without one left out. Last, with both, the value of the portfolio at those closes in the currency, an asset without a close
 * adding nothing (see calculatePortfolioTotalValue).
 */
export const describePortfolioAnswer = (params: PortfolioAnswerParams) => {
  const { portfolio, portfolioAt, prices, pricesAt, pairs, assets, currency, now } = params;
  const lines: string[] = [];
  const isRead = !isNil(portfolio) && !isNil(portfolioAt);
  if (isRead) {
    // A clock set back since the reception reads as just now, rather than as a negative age
    const age = formatDurationUTC(portfolioAt, Math.max(portfolioAt, now));
    lines.push(`Balances read by the Trader, received at ${toISOString(portfolioAt)} (${age ? `${age} ago` : 'just now'})`);
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
    if (isRead) {
      const total = calculatePortfolioTotalValue(portfolio, prices, currency, assets, pairs);
      lines.push(`Total value: ${formatAmount(total)} ${currency}`);
    }
  }
  return lines.join('\n');
};
