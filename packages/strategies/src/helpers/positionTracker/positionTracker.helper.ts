import { CandleBucket } from '@gekko/shared/models/event.types';
import { OrderType } from '@gekko/shared/models/order.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { MarketData } from '@gekko/shared/models/exchange.types';
import { Tools } from '../../strategy.types';
import { getMarketOrderLimits, getSentCost } from '@gekko/shared/helpers/market/market.helper';
import { isFiniteNumber } from '@gekko/shared/utils/math/math.utils';
import { Fill, PendingOrder, UnfinishedOrderParams } from './positionTracker.types';

/** Whether a value above 0 is below a market minimum: one left undefined, 0 or below sets no bound, as toBound reads it (market.helper) */
const isBelowMinimum = (value: number, minimum?: number) => minimum !== undefined && value < minimum;

/**
 * Whether an all-in SELL of `amount` passes the minimums of the market as the exchange checks them: the amount, truncated to the step
 * of the market as CCXTExchange sends it, against the minimum amount (that of a market order for a MARKET one, which the exchange
 * checks against both lot sizes), then its cost at `price` (see getSentCost), unchecked while the price is unknown (0). Less is dust,
 * which no order can sell. Checked before the truncation, a remainder worth less than a step above the minimum cost would read as
 * enough to sell, every SELL of it refused: 0.0000549 BTC at 95000 USDT is 5.22 USDT, sent as 0.00005 BTC, 4.75 USDT. The cost is
 * worked out in decimal, as the exchange checks it: the binary product of a holding worth the minimum exactly can fall an ulp under it,
 * and the holding read as dust, 0.00007 BTC at 100000 USDT coming out at 6.999999999999999 USDT against a minimum of 7.
 */
export const isSellable = (amount: number, price: number, type: OrderType, marketData: MarketData = {}) => {
  const limits = type === 'MARKET' ? getMarketOrderLimits(marketData) : marketData;
  const { sent, cost } = getSentCost(amount, price, limits);
  if (!(sent > 0) || isBelowMinimum(sent, limits.amount?.min)) return false;
  return !(price > 0) || !isBelowMinimum(cost, limits.cost?.min);
};

/**
 * Whether a SELL of an amount the strategy chose covers all of it: placed for all of it (`amount`, that of its cancelation), or sold all
 * of it (that of its completion). The tracker takes such an amount for the position, and what the SELL leaves of it for what is left.
 * Not a SELL without one, all-in or sized by a cost or an allocation, whose amount the Trader works out, nor an adopted one, whose amount
 * is not known here, nor one the Trader capped below it, at the free balance or at the most the market takes in one order: the portfolio
 * after them tells what is left (see getHolding and PositionTracker.settleCompletedSell).
 */
export const coversAmountAsked = (asked: number | undefined, amount: number) => isFiniteNumber(asked) && !(amount < asked);

/**
 * What an order that ended without completing leaves held of its asset, with the fact it is taken from, undefined when nothing tells:
 * 1. A BUY canceled with a fill (`fill`, undefined when the cancelation reports none): what it filled, the order's own figure, which a
 *    holding present at start-up does not blur.
 * 2. A SELL canceled with a fill that covers the amount the strategy asked for (see coversAmountAsked): what it left unsold, the rest of
 *    that amount.
 * 3. Any other SELL canceled with a fill: the free balance of the asset in the portfolio after it, as for the same SELL completed. What
 *    it left unsold is what is left of the order, the holding only when the order was for all of it: read so, a SELL of a share of the
 *    asset (by a cost or an allocation), one capped at the most the market takes in one order, all-in or not, or an adopted one,
 *    canceled once it had sold all but dust, left the strategy flat beside the rest of the asset, while the same SELL completed read it
 *    long. The cancelation released what the order left unsold: a portfolio that shows less, or does not list the asset, was read before
 *    that, or never, and that rest is what is known to be held.
 * 4. An order without a fill, errored or canceled with no fill reported by any answer of the exchange: the free balance of the asset in
 *    the portfolio after it, what an all-in SELL would sell, nothing known when the portfolio does not list the asset.
 * The portfolio is read again once the order ended (`exchange.portfolio`, see Trader.relayError). It is the one known before when that
 * read failed, which may still show what a SELL sold: read long, as after a completed SELL, the position is settled by the next SELL,
 * refused for lack of anything to sell. It is empty before the first read, the asset then missing from it.
 */
export const getHolding = ({ side, amount: asked }: PendingOrder, { order, exchange }: UnfinishedOrderParams, fill?: Fill) => {
  if (fill && side === 'BUY') return { held: fill.filled, fact: 'filled' };
  const unsold = fill && { held: fill.remaining, fact: 'left unsold' };
  if (unsold && coversAmountAsked(asked, order.amount)) return unsold;
  const [asset] = order.symbol.split('/');
  const free = exchange.portfolio.get(asset)?.free;
  if (free === undefined || (unsold && !(free > unsold.held))) return unsold;
  return { held: free, fact: 'free in the portfolio after it' };
};

/**
 * The pair a single-pair strategy trades, GridBot or a custom strategy that trades one pair (the seven signal strategies trade every
 * watched pair, a position each, through a PositionBook): the first of the bucket its init gets, which holds a candle of every watched
 * pair in the order of watch.assets. Taken without a word, it left the other pairs ignored, their candles still required every minute.
 * Called once, from init, it warns through the strategy's log when the bucket holds more than one pair, naming the pair traded and the
 * others.
 */
export const pickTradedPair = (candle: CandleBucket, tools: Pick<Tools<unknown>, 'log'>): TradingPair => {
  const [pair, ...ignored] = candle.keys();
  if (ignored.length > 0) {
    const others = ignored.join(', ');
    tools.log(
      'warn',
      `The strategy trades ${pair} only, the first pair watched (watch.assets): it ignores ${others}, whose candles are still required every minute`,
    );
  }
  return pair;
};
