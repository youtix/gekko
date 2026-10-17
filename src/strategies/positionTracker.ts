import { StrategyOrder } from '@models/advice.types';
import { CandleBucket } from '@models/event.types';
import { OrderSide, OrderType } from '@models/order.types';
import { TradingPair } from '@models/utility.types';
import { MarketData } from '@services/exchange/exchange.types';
import { getMarketOrderLimits } from '@utils/market/market.utils';
import { roundToStep } from '@utils/market/precision.utils';
import { isFiniteNumber, multiplyPrecise } from '@utils/math/math.utils';
import { UUID } from 'node:crypto';
import { OnOrderCanceledEventParams, OnOrderCompletedEventParams, OnOrderErroredEventParams, Tools } from './strategy.types';

type UnfinishedOrderParams = OnOrderCanceledEventParams<unknown> | OnOrderErroredEventParams<unknown>;
/** What a cancelation reports its order executed: the amount filled, and what remains of the amount ordered */
type Fill = { filled: number; remaining: number };
/**
 * An order of the tracker's own whose outcome has not come yet: its side, and the amount a SELL asked for, unknown when all-in, sized
 * by a cost or an allocation, or adopted
 */
type PendingOrder = { side: OrderSide; amount?: number };

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
const getHolding = (side: OrderSide, { order, exchange }: UnfinishedOrderParams, fill?: Fill) => {
  if (fill) return side === 'BUY' ? { held: fill.filled, fact: 'filled' } : { held: fill.remaining, fact: 'left unsold' };
  const [asset] = order.symbol.split('/');
  const free = exchange.portfolio.get(asset)?.free;
  return free === undefined ? undefined : { held: free, fact: 'free in the portfolio after it' };
};

/**
 * The position of a strategy that trades all-in: flat or long, and its own orders whose outcome has not come yet. Gekko 2 relays
 * every advice, so a strategy advising on every candle of a trend placed an all-in order sized from what the previous one left,
 * then had it refused until maxConsecutiveErrors stopped the bot: the strategy buys only when flat and sells only when long, never
 * while an order of its own is pending, and this is the bookkeeping that tells it which. It follows one pair: a strategy that trades
 * several keeps one per pair in a PositionBook, which also shares the currency among their BUYs.
 *
 * - It starts flat: a holding present at start-up is sold only by its first SELL, which follows a BUY that completed, or one that
 *   ended without completing while the account held it (see settleUnfinished).
 * - A completed BUY makes it long, a completed SELL flat, unless it sold less than it asked for, all of the asset free for an all-in
 *   SELL: the position is then read from the portfolio after it (see settleCompletedSell).
 * - A canceled or errored order may have executed all the same, in part or in full: the position is read from what its event
 *   reports, long when what the order leaves held is enough to sell (see settleUnfinished). Nothing reported, it stays as it was.
 * - The outcome of an order that is not its own changes nothing, and an order counts once: its first outcome settles it.
 *
 * The strategy places its orders through buy and sell once canBuy or canSell allows it, and hands the params of its three order
 * hooks over as it gets them, whole: the event, with the portfolio after the order, and the tools, with the market data and the log.
 */
export class PositionTracker {
  private long = false;
  // Not one id per side: the SELL of a trailing stop (adoptSell) can pend beside a SELL of the strategy's own
  private readonly pendingOrders = new Map<UUID, PendingOrder>();

  /** Whether it holds enough to sell, as far as the outcomes of its orders tell */
  get isLong(): boolean {
    return this.long;
  }

  /** Whether an order of its own still waits for its outcome */
  get isPendingOrder(): boolean {
    return this.pendingOrders.size > 0;
  }

  /** Flat, and nothing pending */
  canBuy(): boolean {
    return !this.long && !this.isPendingOrder;
  }

  /** Long, and nothing pending */
  canSell(): boolean {
    return this.long && !this.isPendingOrder;
  }

  /** Creates the order as a BUY through createOrder and keeps it pending until its outcome; returns its id */
  buy(createOrder: Tools<unknown>['createOrder'], order: Omit<StrategyOrder, 'side'>): UUID {
    const id = createOrder({ ...order, side: 'BUY' });
    this.pendingOrders.set(id, { side: 'BUY' });
    return id;
  }

  /**
   * Creates the order as a SELL through createOrder and keeps it pending until its outcome, with the amount it asks for, left out
   * for an all-in SELL and for one sized by a cost or an allocation (see settleCompletedSell); returns its id
   */
  sell(createOrder: Tools<unknown>['createOrder'], order: Omit<StrategyOrder, 'side' | 'trailing'>): UUID {
    const id = createOrder({ ...order, side: 'SELL' });
    this.pendingOrders.set(id, { side: 'SELL', amount: order.amount });
    return id;
  }

  /**
   * Keeps pending, as sell does, a SELL the strategy did not create itself: the one a trailing stop sends when it triggers. A
   * strategy whose BUYs carry a stop adopts it from `onTrailingStopTriggered(orderId, …)`; left out, the stop's SELL is not its own
   * and its outcome changes nothing: once the stop has sold everything, the strategy stays long until the SELL it advises next is
   * refused, nothing left to sell. The amount it asks for is not known here: completed, it is read as an all-in SELL is (see
   * settleCompletedSell).
   */
  adoptSell(orderId: UUID): void {
    this.pendingOrders.set(orderId, { side: 'SELL' });
  }

  /**
   * Settles its own order that completed, a fill: a BUY makes it long, a SELL flat unless it sold less than it asked for (see
   * settleCompletedSell); returns whether the order was its own
   */
  onOrderCompleted(params: OnOrderCompletedEventParams<unknown>): boolean {
    const pending = this.pendingOrders.get(params.order.id);
    if (!pending) return false;
    this.pendingOrders.delete(params.order.id);
    if (pending.side === 'BUY') this.long = true;
    else this.settleCompletedSell(params, pending.amount);
    return true;
  }

  /** Settles its own order that was canceled, after what it filled (see settleUnfinished); returns whether the order was its own */
  onOrderCanceled(params: OnOrderCanceledEventParams<unknown>): boolean {
    const { filled, remaining } = params.order;
    // A cancelation missing either amount reports no fill: the order leaves both out when no answer of the exchange reported one. 0
    // filled and 0 remaining used to mean the same, the order relaying the amounts its last answer left out as 0: it is a fact now.
    const fill = isFiniteNumber(filled) && isFiniteNumber(remaining) ? { filled, remaining } : undefined;
    return this.settleUnfinished('canceled', params, fill);
  }

  /** Settles its own order that errored, after what it executed (see settleUnfinished); returns whether the order was its own */
  onOrderErrored(params: OnOrderErroredEventParams<unknown>): boolean {
    return this.settleUnfinished('errored', params);
  }

  /**
   * Settles its own order that ended without completing. Read as "nothing executed", a SELL errored after it had sold everything
   * left the strategy long with nothing to sell, every SELL it advised refused until maxConsecutiveErrors stopped the bot, and a BUY
   * canceled once it had filled 90 % left it flat, holding the coins, its SELL signals ignored. Neither outcome means that nothing
   * executed: a cancelation comes after the fills it reports (expired with what the book allowed, canceled from the exchange's
   * interface), and an error may follow fills (a STICKY order reports what it had already filled) or a creation whose outcome is
   * unknown.
   * So the strategy is long when what the order leaves held of its asset is enough to sell (see getHolding and isSellable), and
   * stays as it was when nothing tells. A position read from the facts that differs from the one held before is logged, at info
   * level, through the strategy's log.
   */
  private settleUnfinished(outcome: 'canceled' | 'errored', params: UnfinishedOrderParams, fill?: Fill) {
    const { order, exchange, tools } = params;
    const pending = this.pendingOrders.get(order.id);
    if (!pending) return false;
    this.pendingOrders.delete(order.id);

    const { side } = pending;
    const holding = getHolding(side, params, fill);
    if (!holding) return true;

    const isLong = isSellable(holding.held, exchange.price, order.type, tools.marketData.get(order.symbol));
    if (isLong !== this.long) {
      const [asset] = order.symbol.split('/');
      const position = isLong ? 'enough to sell: the strategy is long' : 'too little to sell: the strategy is flat';
      tools.log('info', `[${order.id}] ${side} order ${outcome}: ${holding.held} ${asset} ${holding.fact}, ${position}`);
    }
    this.long = isLong;
    return true;
  }

  /**
   * Settles its own SELL that completed: flat once it sold all it asked for. The Trader caps a SELL to the free balance and to the
   * most the market takes in one order (its maximum amount, that of a market order for a MARKET one): a position above that maximum,
   * bought by a STICKY or a LIMIT BUY, read flat once its first SELL had completed, the rest held while the strategy ignored its SELL
   * signals and followed its BUY signals. A SELL that sold less than it asked for is read from the portfolio after it, as one that
   * did not complete: long when the asset free there is enough to sell (see isSellable), flat when it is not, or when the portfolio
   * does not list the asset. So is an all-in SELL, which asks for all of the asset free, one sized by a cost or an allocation, whose
   * amount the Trader works out, and an adopted one, whose amount is not known here: what is free after them is what they left. When
   * the Trader could not read the portfolio again after the fill, it is the one known before, which may still show the asset free:
   * read long, the position is settled by the next SELL, refused for lack of anything to sell. Read long, the position is logged at
   * info level, through the strategy's log.
   */
  private settleCompletedSell({ order, exchange, tools }: OnOrderCompletedEventParams<unknown>, asked?: number) {
    this.long = false;
    if (isFiniteNumber(asked) && !(order.amount < asked)) return;
    const [asset] = order.symbol.split('/');
    const free = exchange.portfolio.get(asset)?.free;
    if (free === undefined || !isSellable(free, exchange.price, order.type, tools.marketData.get(order.symbol))) return;
    this.long = true;
    const sale = isFiniteNumber(asked) ? `${order.amount} of the ${asked} ${asset} it asked for` : `${order.amount} ${asset}`;
    tools.log(
      'info',
      `[${order.id}] SELL order completed after selling ${sale}: ${free} ${asset} free in the portfolio after it, enough to sell: the strategy is long`,
    );
  }
}

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
