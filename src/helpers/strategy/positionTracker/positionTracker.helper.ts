import { CandleBucket } from '@models/event.types';
import { OrderSide, OrderType } from '@models/order.types';
import { TradingPair } from '@models/utility.types';
import { MarketData } from '@services/exchange/exchange.types';
import { Tools } from '@strategies/strategy.types';
import { getMarketOrderLimits } from '@helpers/market/market.helper';
import { roundToStep } from '@helpers/market/precision.helper';
import { multiplyPrecise } from '@utils/math/math.utils';
import { Fill, UnfinishedOrderParams } from './positionTracker.types';

/** Whether a value above 0 is below a market minimum: one left undefined, 0 or below sets no bound, as for the orders (market.utils) */
export const isBelowMinimum = (value: number, minimum?: number) => minimum !== undefined && value < minimum;

/**
 * Whether an all-in SELL of `amount` passes the minimums of the market as the exchange checks them: the amount, truncated to the step
 * of the market as CCXTExchange sends it, against the minimum amount (that of a market order for a MARKET one, which the exchange
 * checks against both lot sizes), then its cost at `price`, unchecked while the price is unknown (0). Less is dust, which no order
 * can sell. Checked before the truncation, a remainder worth less than a step above the minimum cost would read as enough to sell,
 * every SELL of it refused: 0.0000549 BTC at 95000 USDT is 5.22 USDT, sent as 0.00005 BTC, 4.75 USDT. The cost is worked out in
 * decimal, as the exchange checks it: the binary product of a holding worth the minimum exactly can fall an ulp under it, and the
 * holding read as dust, 0.00007 BTC at 100000 USDT coming out at 6.999999999999999 USDT against a minimum of 7.
 */
export const isSellable = (amount: number, price: number, type: OrderType, marketData: MarketData = {}) => {
  const limits = type === 'MARKET' ? getMarketOrderLimits(marketData) : marketData;
  const sent = roundToStep(amount, limits.precision?.amount, 'down');
  if (!(sent > 0) || isBelowMinimum(sent, limits.amount?.min)) return false;
  return !(price > 0) || !isBelowMinimum(multiplyPrecise(sent, price), limits.cost?.min);
};

/**
 * What an order that ended without completing leaves held of its asset, with the fact it is taken from: the first one its event
 * reports, in this order.
 * 1. The fill of a cancelation (`fill`, undefined when it reports none): what a BUY filled, what a SELL left unsold. The order's
 *    own figures, which a holding present at start-up does not blur.
 * 2. The portfolio after the order (`exchange.portfolio`, read again once it ended): the free balance of the asset, what an all-in
 *    SELL would sell. An error reports no fill, nor does a cancelation whose fill no answer of the exchange reported. It is the
 *    portfolio known before when that read failed, and empty before the first one: the asset is then missing from it.
 * 3. Neither: undefined, nothing known to have executed.
 */
export const getHolding = (side: OrderSide, { order, exchange }: UnfinishedOrderParams, fill?: Fill) => {
  if (fill) return side === 'BUY' ? { held: fill.filled, fact: 'filled' } : { held: fill.remaining, fact: 'left unsold' };
  const [asset] = order.symbol.split('/');
  const free = exchange.portfolio.get(asset)?.free;
  return free === undefined ? undefined : { held: free, fact: 'free in the portfolio after it' };
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
