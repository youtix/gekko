import { describeError } from '@errors/error.helper';
import { GekkoError } from '@errors/gekko.error';
import { Candle } from '@models/candle.types';
import { OrderSide, OrderState } from '@models/order.types';
import { Trade } from '@models/trade.types';
import { debug } from '@services/logger';
import { getRetryDelay } from '@utils/fetch/fetch.utils';
import { addPrecise, isFiniteNumber, multiplyPrecise, toSignificantDigits } from '@utils/math/math.utils';
import { shiftDecimalPoint } from '@utils/math/round.utils';
import { wait } from '@utils/process/process.utils';
import ccxt, { Order as CCXTOrder, Trade as CCXTTrade, ConstructorArgs, Exchange, MarketInterface, OHLCV } from 'ccxt';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { isNil } from 'lodash-es';
import { inspect } from 'node:util';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { BROKER_MANDATORY_FEATURES, BROKER_MAX_RETRIES_ON_FAILURE } from './exchange.const';
import { ExchangeNetworkError, InvalidOrder, OrderNotFound } from './exchange.error';
import { CCXTExchangeConfig, DummyExchange, OpenOrder, OpenOrderType } from './exchange.types';

const selectAgent = (proxy: string) => {
  if (proxy.startsWith('socks')) {
    return new SocksProxyAgent(proxy);
  } else if (proxy.startsWith('http')) {
    return new HttpsProxyAgent(proxy);
  }
};

/**
 * Create two instances of exchange: public and private:
 * - Public: thanks to proxy, we can use rotating proxies for public client to avoid to be banned from exchange
 * - Private: we do not use proxy for private client because exchange use the API key sent in each request for rate limiting
 */
export const createExchange = (config: CCXTExchangeConfig) => {
  const { name, verbose, proxy, sandbox } = config;
  const commonConfig: ConstructorArgs = { verbose, sandbox };

  // Setup proxy agent if configured
  const agent = proxy ? selectAgent(proxy) : undefined;

  switch (name) {
    case 'hyperliquid': {
      const { privateKey, walletAddress } = config;
      // maxRetriesOnFailure: we handle it manualy.
      // builderFee: on by default, ccxt's hyperliquid charges a builder fee for ccxt's own address. Before the first order or cancelation
      // of a session (initializeClient), it signs with the user's wallet an approval of 0.01 % for that address, then adds 1 basis point
      // to every order: paid on every spot sell, missing from Gekko's fee model (the fees of getMarketData), and counted twice in the
      // fee of the trades ccxt parses (Hyperliquid's fee already includes it, parseTrade adds it again). Off, nothing is approved nor
      // added. The referrer ccxt also sets in initializeClient (code CCXT1, a fee discount for the user) is left as it is.
      const options = { fetchMarkets: { types: ['spot'] }, maxRetriesOnFailure: 0, builderFee: false };
      const publicClient = new ccxt.hyperliquid({ ...commonConfig, agent, options });
      const privateClient = new ccxt.hyperliquid({ ...commonConfig, privateKey, walletAddress, options });
      return { publicClient, privateClient };
    }
    default: {
      const { apiKey, secret } = config;
      // maxRetriesOnFailure: we handle it manualy.
      // quoteOrderQty: CCXTExchange.createMarketOrder sends the ticker price along with a market order, as Hyperliquid requires it.
      // Given a price, ccxt's binance turns a spot market order into a quoteOrderQty of amount × price, an amount of quote currency:
      // a SELL then sells whatever base amount it takes to receive it, more than the amount asked if the price fell, beyond the
      // balance for an all-in exit or a trailing stop. Off, binance sends the amount as the quantity and ignores the price.
      const options = { maxRetriesOnFailure: 0, quoteOrderQty: false };
      const publicClient = new ccxt[name]({ ...commonConfig, agent, options });
      const privateClient = new ccxt[name]({ ...commonConfig, options, apiKey, secret });
      return { publicClient, privateClient };
    }
  }
};

export const checkMandatoryFeatures = (exchange: Exchange, hasSandbox: boolean) => {
  const mandatoryFeatures = [...BROKER_MANDATORY_FEATURES, ...(hasSandbox ? ['sandbox'] : [])];
  mandatoryFeatures.forEach(feature => {
    if (!exchange.has[feature]) throw new GekkoError('exchange', `Missing ${feature} feature in ${exchange.name} exchange`);
  });
};

export const isDummyExchange = (exchange: unknown): exchange is DummyExchange =>
  !!(
    typeof exchange === 'object' &&
    exchange &&
    'getExchangeName' in exchange &&
    typeof exchange.getExchangeName === 'function' &&
    (exchange.getExchangeName().includes('dummy') || exchange.getExchangeName().includes('paper')) &&
    'processOneMinuteBucket' in exchange &&
    typeof exchange.processOneMinuteBucket === 'function'
  );

/**
 * Translates a ccxt error into the Gekko error the orders handle, the one the simulated exchange throws. Despite their names, the
 * ccxt classes are unrelated to Gekko's, so untranslated an order never recognises a rejection or an unknown order.
 * - OrderNotFound becomes OrderNotFound. It is tested first: in ccxt it extends InvalidOrder.
 * - InvalidOrder, InsufficientFunds and BadRequest (BadSymbol included) become InvalidOrder: the exchange refused the request and
 *   would refuse it again.
 * - NetworkError (timeout, rate limit, maintenance, nonce...) becomes ExchangeNetworkError.
 * The message is kept and the ccxt error becomes the cause. Anything else, other ccxt errors included, is returned unchanged.
 */
export const translateCcxtError = (err: unknown): unknown => {
  if (err instanceof ccxt.OrderNotFound) return new OrderNotFound(err.message, { cause: err });
  if (err instanceof ccxt.InvalidOrder || err instanceof ccxt.InsufficientFunds || err instanceof ccxt.BadRequest)
    return new InvalidOrder(err.message, { cause: err });
  if (err instanceof ccxt.NetworkError) return new ExchangeNetworkError(err.message, { cause: err });
  return err;
};

/**
 * Calls the exchange once and throws its failure translated by translateCcxtError. For the calls that must never be replayed, such
 * as an order creation or cancelation, which retry would send again after a timeout.
 */
export const translateErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    throw translateCcxtError(err);
  }
};

/**
 * Calls the exchange, and calls it again after a ccxt NetworkError, up to maxRetries more times. The error it gives up on, or any
 * other error at once, is thrown translated by translateCcxtError.
 * - `attempt` numbers the calls from 0, the first one, as the fetcher numbers its requests: the call that failed waits
 *   getRetryDelay(attempt) before the next one, 1000, 1585 and 2000 ms. Numbered from 1, every read waited 1585, 2000 and 2322 ms.
 * - Each failure is logged at debug level only. The callers log what they could not read, at the level it deserves: an order poll
 *   that failed on the network warns that the order stays open, a synchronization that failed is an error. Logged here as an error
 *   then a warning, a read that failed once and succeeded at the next call reached Telegram as an alert (Supervision forwards every
 *   warning and error), and a read that failed for good was reported twice.
 */
export const retry = async <T>(fn: () => Promise<T>, attempt = 0, maxRetries = BROKER_MAX_RETRIES_ON_FAILURE): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    const failure = `Call to the exchange failed, attempt ${attempt + 1}`;
    const reason = describeError(err);
    if (!(err instanceof ccxt.NetworkError)) {
      debug('exchange', `${failure}, not retried: ${reason}`);
      throw translateCcxtError(err);
    }
    if (attempt >= maxRetries) {
      debug('exchange', `${failure} of ${maxRetries + 1}, given up: ${reason}`);
      throw translateCcxtError(err);
    }
    const delay = getRetryDelay(attempt);
    debug('exchange', `${failure} of ${maxRetries + 1}, retried in ${Math.round(delay)} ms: ${reason}`);
    await wait(delay);
    return retry(fn, attempt + 1, maxRetries);
  }
};

/** A ccxt trade that says what it executed: an amount and a price, both finite numbers above 0 (see isExecutedTrade) */
export type ExecutedTrade = CCXTTrade & { amount: number; price: number };

/**
 * Whether a ccxt trade says what it executed: an amount and a price, both finite numbers above 0. ccxt 4.5.39 leaves either undefined
 * when the exchange gives none (safeTrade derives the cost from the price, never the price from the cost). Read as 0, an unknown price
 * entered the mean price of its order as a real one: fills of 0.5 at 100 and of 0.5 at an unknown price made a fill of 1 at 50.
 * Binance (myTrades) and Hyperliquid (fills) give both on every trade.
 */
export const isExecutedTrade = (trade: CCXTTrade): trade is ExecutedTrade =>
  isFiniteNumber(trade.amount) && trade.amount > 0 && isFiniteNumber(trade.price) && trade.price > 0;

/**
 * The fee rate of a ccxt trade in %, the unit of Trade.fee.rate and of the simulated exchange (0.1 for 0.1 %), or undefined when it
 * cannot be known. Never 0 by default: 0 is a trade without fees, and only an unknown rate makes the Trader warn about it.
 * - A rate given by ccxt is a fraction (0.001 for 0.1 %): it is multiplied by 100. ccxt 4.5.39 gives none for binance or hyperliquid.
 * - Otherwise the rate is derived from the cost and the currency of the fee, which both drivers give. A fee paid in the quote
 *   currency is that share of the cost of the trade (amount × price), a fee paid in the base currency that share of its amount.
 *   Hyperliquid names the fee currency by its token (feeToken, which ccxt does not unify), while the market is named after the coins
 *   ccxt maps the tokens to: the token is also matched with the baseName of the market (UBTC for BTC/USDC) and its quoteId (USDT0 for
 *   a market quoted in USDT).
 * - A fee paid in any other currency, such as BNB with Binance's fee discount, is not converted: its rate is unknown.
 * The percentage is worked out in decimal: the decimal point of the rate or of the fee moved two places, the cost of the trade as its
 * amount and price are written (multiplyPrecise), the one division rounded to 15 significant digits (toSignificantDigits). In binary,
 * a rate of 0.0007 came out at 0.06999999999999999 %, and so did a fee of 0.0007 USDC on 0.01 at 100.
 */
const getFeePercent = (trade: ExecutedTrade, market: MarketInterface): number | undefined => {
  const rate = trade.fee?.rate;
  if (isFiniteNumber(rate)) return shiftDecimalPoint(rate, 2);

  const cost = trade.fee?.cost;
  const currency = trade.fee?.currency;
  if (!isFiniteNumber(cost) || !currency) return undefined;

  const baseName = 'baseName' in market && typeof market.baseName === 'string' ? market.baseName : undefined;
  const percentOf = (whole: number) => toSignificantDigits(shiftDecimalPoint(cost, 2) / whole);
  if (currency === market.quote || currency === market.quoteId) return percentOf(multiplyPrecise(trade.amount, trade.price));
  if (currency === market.base || currency === baseName) return percentOf(trade.amount);
  return undefined;
};

/**
 * Maps a ccxt trade of the market given, one that says what it executed (see isExecutedTrade), onto a Gekko trade. Its fee rate is in
 * % (see getFeePercent); the cost and the currency of the fee are kept as ccxt gives them, for information.
 */
export const mapCcxtTradeToTrade = (trade: ExecutedTrade, market: MarketInterface): Trade => ({
  id: trade.order ?? '',
  amount: trade.amount,
  price: trade.price,
  timestamp: trade.timestamp ?? Date.now(),
  fee: { rate: getFeePercent(trade, market), cost: trade.fee?.cost, currency: trade.fee?.currency },
});

/**
 * The fill and the remaining amount of a ccxt order, each a finite number or undefined: unknown, not 0. ccxt 4.5.39 leaves them
 * undefined when the exchange gives too little (an acknowledgement, an answer with the id alone). One missing, or not a finite
 * number, is the amount of the order less the other, never below 0. ccxt's safeOrder derives them so already (without the floor):
 * this covers an answer that did not go through it. The difference is taken in decimal, as ccxt takes it: in binary, 0.8 less 0.1
 * was 0.7000000000000001, a fill a hair above the one made.
 */
const getFill = ({ amount, filled, remaining }: CCXTOrder): Pick<OrderState, 'filled' | 'remaining'> => {
  const amountLess = (part: unknown) =>
    isFiniteNumber(amount) && isFiniteNumber(part) ? Math.max(addPrecise(amount, -part), 0) : undefined;
  return {
    filled: isFiniteNumber(filled) ? filled : amountLess(remaining),
    remaining: isFiniteNumber(remaining) ? remaining : amountLess(filled),
  };
};

/** The timestamp of a ccxt order, or, when ccxt leaves it undefined, the last update of the order, then now (see mapCcxtOrderToOrder) */
const getOrderTimestamp = ({ timestamp, lastUpdateTimestamp }: CCXTOrder): EpochTimeStamp =>
  [timestamp, lastUpdateTimestamp].find(isFiniteNumber) ?? Date.now();

/**
 * Maps a ccxt order onto the state of a Gekko order, its fill and remaining amount completed by getFill. Its timestamp is never left
 * undefined, as ccxt 4.5.39 leaves it when the exchange gives none: createOrderSummary fetches the trades of the order from it
 * (fetchMyTrades), and undefined made that bound NaN, so that no trade was found and logging the bound threw. It falls back on the
 * last update of the order, then on now, the time the state is read. Now is the safest bound left: the order exists by then, so the
 * bound does not reach back into the trades of older orders, which could crowd its own out of the page fetched, though it may miss
 * a fill made before the state was read.
 */
export const mapCcxtOrderToOrder = (order: CCXTOrder): OrderState => ({
  id: order.id,
  status: processStatus(order.status),
  ...getFill(order),
  price: order.price,
  timestamp: getOrderTimestamp(order),
});

/** The side of a ccxt order, which ccxt writes in lower case, or undefined when it is neither a buy nor a sell */
const getOrderSide = ({ side }: CCXTOrder): OrderSide | undefined => {
  const upperCaseSide = side?.toUpperCase();
  return upperCaseSide === 'BUY' || upperCaseSide === 'SELL' ? upperCaseSide : undefined;
};

/**
 * The type of a ccxt order listed as open (see OpenOrderType). ccxt 4.5.39 writes the types it unifies in lower case, limit and
 * market, and leaves the others as the exchange wrote them (Binance's stop_loss_limit, Hyperliquid's take profit market). It gives a
 * conditional order the type it executes with once triggered, Hyperliquid's stop limit and Binance's take_profit as limit, along with
 * its trigger price: an order with a trigger price is OTHER whatever its type, waiting off the book until the price reaches it.
 */
const getOpenOrderType = ({ type, triggerPrice }: CCXTOrder): OpenOrderType => {
  if (isFiniteNumber(triggerPrice) && triggerPrice > 0) return 'OTHER';
  const lowerCaseType = type?.toLowerCase();
  if (lowerCaseType === 'limit') return 'LIMIT';
  if (lowerCaseType === 'market') return 'MARKET';
  return 'OTHER';
};

/**
 * Maps a ccxt order the exchange lists as open onto an OpenOrder: its side and its type in Gekko's terms, its fill and remaining
 * amount completed by getFill, its timestamp as mapCcxtOrderToOrder dates an order, and its price left undefined when ccxt gives none
 * (a stop-loss executed at the market). An order whose side is neither buy nor sell, or whose amount, fill or remaining amount stays
 * unknown, is refused with a GekkoError naming it: listed with made-up values, or left out, an order holding funds on the exchange
 * would go unseen by whoever reads the list to know what is open there.
 */
export const mapCcxtOrderToOpenOrder = (order: CCXTOrder): OpenOrder => {
  const { id, symbol, amount, price } = order;
  const side = getOrderSide(order);
  const { filled, remaining } = getFill(order);
  const refuse = (problem: string) =>
    new GekkoError(
      'exchange',
      `Open order ${id} on ${symbol} has ${problem}: the open orders of ${symbol} cannot be listed, check it on the exchange`,
    );
  if (!side) throw refuse(`no side Gekko knows (${inspect(order.side)})`);
  if (!isFiniteNumber(amount) || !isFiniteNumber(filled) || !isFiniteNumber(remaining)) {
    const given = `amount ${inspect(amount)}, filled ${inspect(order.filled)}, remaining ${inspect(order.remaining)}`;
    throw refuse(`no known amount (${given})`);
  }
  return {
    id,
    side,
    type: getOpenOrderType(order),
    price: isFiniteNumber(price) ? price : undefined,
    amount,
    filled,
    remaining,
    timestamp: getOrderTimestamp(order),
  };
};

export const mapOhlcvToCandles = (ohlcvList: OHLCV[]): Candle[] =>
  ohlcvList.map(ohlcv => ({
    start: ohlcv[0] ?? 0,
    open: ohlcv[1] ?? 0,
    high: ohlcv[2] ?? 0,
    low: ohlcv[3] ?? 0,
    close: ohlcv[4] ?? 0,
    volume: ohlcv[5] ?? 0,
  }));

/**
 * Maps the status of a ccxt order onto those of Gekko. Only a status that ends the order is final:
 * - 'closed', an order executed in full, is closed: a fill.
 * - 'canceled', 'rejected' and 'expired' are canceled, and so is Hyperliquid's 'scheduledCancel', an order canceled by the dead
 *   man's switch (scheduleCancel), which ccxt passes on as is: its parseOrderStatus only maps the statuses ending in Canceled or
 *   Rejected.
 * - Anything else is open: no status, 'open', and whatever ccxt passes on as the exchange wrote it, such as 'canceling' (Binance's
 *   PENDING_CANCEL), 'PENDING_NEW', or 'success' (ccxt's order for Hyperliquid's acknowledgement of a cancelation, with neither id nor
 *   fill). Such an order is not known to have ended: taken as closed, it would be reported filled, a fill that may never have
 *   happened; open, it is only read again by the orders that poll.
 */
const processStatus = (status?: string): OrderState['status'] => {
  if (status === 'closed') return 'closed';
  if (status === 'canceled' || status === 'rejected' || status === 'expired' || status === 'scheduledCancel') return 'canceled';
  if (status && status !== 'open') debug('exchange', `Unknown order status ${status}, taken as open: the order is not known to have ended`);
  return 'open';
};

/**
 * What tells a ccxt trade from the others, for CCXTExchange.fetchMyTrades to keep once a trade fetched on two pages: its id, with the
 * id of its order, both sides of a self-trade (two orders of the account matched together) sharing the id of the trade. A trade without
 * an id is told by its time, side, price and amount, as in ccxt's removeRepeatedTradesFromArray.
 */
export const getTradeKey = ({ id, order, timestamp, side, price, amount }: CCXTTrade) =>
  JSON.stringify(isNil(id) ? [order, timestamp, side, price, amount] : [order, id]);
