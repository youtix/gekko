import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { assertOrderWithinLimits, getMarketOrderLimits } from '@gekko/shared/helpers/market/market.helper';
import { Candle } from '@gekko/shared/models/candle.types';
import { OrderSide, OrderState } from '@gekko/shared/models/order.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { Trade } from '@gekko/shared/models/trade.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { debug, error, warning } from '../logger/logger';
import { formatDurationUTC, toISOString } from '@gekko/shared/utils/date/date.utils';
import { addPrecise } from '@gekko/shared/utils/math/math.utils';
import { formatEveryDecimal, pluralize } from '@gekko/shared/utils/string/string.utils';
import ccxt, { Exchange as CCXT, Order as CCXTOrder, Trade as CCXTTrade } from 'ccxt';
import { first, isNil, last, partition } from 'lodash-es';
import { LIMITS, MAX_MY_TRADES_PAGES, PARAMS, PRICE_SIGNIFICANT_DIGITS } from './exchange.const';
import { OrderOutcomeUnknown } from './exchange.error';
import {
  checkMandatoryFeatures,
  createExchange,
  getTradeKey,
  isExecutedTrade,
  mapCcxtOrderToOpenOrder,
  mapCcxtOrderToOrder,
  mapCcxtTradeToTrade,
  mapOhlcvToCandles,
  retry,
  translateErrors,
} from './exchange.helper';
import type { Watch } from '@gekko/schemas/configuration/configuration.types';
import { CCXTExchangeConfig } from '@gekko/schemas/exchange/exchange.types';
import { Exchange, FetchOHLCVParams, MarketData, OpenOrder, OrderSettledCallback, Ticker } from '@gekko/shared/models/exchange.types';

/**
 * A real exchange reached through ccxt. Every call goes through one of two wrappers of exchange.helper, which both translate the
 * ccxt errors into Gekko's:
 * - The reads (fetchTicker(s), fetchOHLCV, fetchMyTrades, fetchOrder, fetchOpenOrders, fetchBalance) go through retry, which sends
 *   them again after a ccxt NetworkError: they are idempotent.
 * - The writes (createLimitOrder, createMarketOrder, cancelOrder) go through translateErrors: sent once, never replayed. A
 *   NetworkError (timeout, 5xx, Binance -1007 "execution status unknown") is precisely the case where the exchange may have
 *   processed the request and only its response was lost. ccxt signs each call anew, with a new client order id (Binance) or
 *   nonce (Hyperliquid), so a replayed creation would place a second order, and a replayed cancelation would fail with
 *   OrderNotFound, which the limit and sticky orders take for a fill. The failure is thrown at once as an ExchangeNetworkError:
 *   the outcome of the request is unknown. A creation answered without the status of the order, and a cancelation answered
 *   without its id or its status, are completed by a fetchOrder, a read (see getCreatedOrderState and getCanceledOrderState). A
 *   creation that leaves nothing to follow the order by, that read failing, throws OrderOutcomeUnknown: the order may be live too.
 *   So does a creation the exchange answers with a failure that is not a refusal of the order (see sendCreation).
 * ccxt's own retries are off too (maxRetriesOnFailure: 0 in createExchange).
 * Built from its exchange section (binance or hyperliquid, which the configuration names) and the pairs of the watch section, whose
 * balances fetchBalance reads.
 */
export class CCXTExchange implements Exchange {
  protected publicClient: CCXT;
  protected privateClient: CCXT;
  protected exchangeName: string;
  /** The watched pairs: fetchBalance keys the balance of each by the asset and the currency of its symbol */
  private readonly pairs: Watch['pairs'];

  constructor(exchangeConfig: CCXTExchangeConfig, watch: Pick<Watch, 'pairs'>) {
    const { name, sandbox } = exchangeConfig;
    this.pairs = watch.pairs;

    const { publicClient, privateClient } = createExchange(exchangeConfig);
    this.publicClient = publicClient;
    this.privateClient = privateClient;

    checkMandatoryFeatures(this.publicClient, sandbox);

    this.exchangeName = name;
  }

  getMarketData(symbol: TradingPair): MarketData {
    const market = this.publicClient.market(symbol);
    return {
      amount: {
        min: market.limits?.amount?.min,
        max: market.limits?.amount?.max,
      },
      price: {
        min: market.limits?.price?.min,
        max: market.limits?.price?.max,
      },
      cost: {
        min: market.limits?.cost?.min,
        max: market.limits?.cost?.max,
      },
      // Binance's MARKET_LOT_SIZE: the amounts of a market order (see getMarketOrderLimits), which the simulator of paper trading checks
      market: {
        min: market.limits?.market?.min,
        max: market.limits?.market?.max,
      },
      precision: {
        price: market.precision?.price,
        amount: market.precision?.amount,
        // Hyperliquid's tick depends on the price, which precision.price, its tick at the price the markets were loaded at, does not tell
        priceSignificantDigits: PRICE_SIGNIFICANT_DIGITS[this.exchangeName],
      },
      fee: {
        maker: market.maker,
        taker: market.taker,
      },
    };
  }

  getExchangeName(): string {
    return this.exchangeName;
  }

  /**
   * Downloads the markets once, with the public client, which a configured proxy routes, and shares them with the private client.
   * Loaded by both clients, the catalogue was downloaded twice, the requests of the private client bypassing the proxy (Binance with
   * keys adding its sapi requests for the currencies and the margin pairs; paper trading, for a private client it never uses), and
   * held twice in memory.
   * - setMarketsFromExchange (ccxt 4.5.39) gives the private client the very markets and currencies of the public one. Its calls
   *   (createOrder, cancelOrder, fetchOrder, fetchMyTrades) start with loadMarkets, which then downloads nothing: loadMarketsHelper
   *   only fetches the markets when none are set, or on reload.
   * - Hyperliquid learns from its token list (fetchCurrencies) the wrapped spot tokens its built-in spotCurrencyMapping lacks or maps
   *   otherwise, into the options of the client loading the markets, which setMarketsFromExchange leaves out. The markets are built
   *   with that mapping, and the private client reads it to resolve a symbol written with a token name (UBTC/USDC for BTC/USDC)
   *   and to key its spot balance (fetchBalance): it is copied.
   * - Hyperliquid's private fetchCurrencies also ran ccxt's initializeClient at start-up, which sets ccxt's referrer and would approve
   *   ccxt's builder fee but for the builderFee: false that createExchange sets (exchange.helper.ts): createOrder and cancelOrder run
   *   it before their first request anyway.
   */
  public async loadMarkets() {
    await this.publicClient.loadMarkets();
    this.privateClient.setMarketsFromExchange(this.publicClient);
    const { spotCurrencyMapping } = this.publicClient.options;
    if (spotCurrencyMapping) this.privateClient.options.spotCurrencyMapping = { ...spotCurrencyMapping };
  }

  /**
   * The tickers keyed by the symbols asked for, the configured ones the Trader reads them with. ccxt 4.5.39 keys them by the unified
   * symbol of their market, which may differ from the symbol asked for: it resolves a symbol written with the name of a wrapped spot
   * token of Hyperliquid (UBTC/USDC) to the market of the coin it wraps (BTC/USDC, see fetchBalance), and keys its ticker BTC/USDC.
   * Each ticker is read under the unified symbol of its market, as ccxt's own fetchTicker does, or else under the symbol asked for.
   */
  public async fetchTickers(symbols: TradingPair[]): Promise<Record<TradingPair, Ticker>> {
    return retry<Record<TradingPair, Ticker>>(async () => {
      const tickers = await this.publicClient.fetchTickers(symbols);
      const result = {} as Record<TradingPair, Ticker>;
      for (const symbol of symbols) {
        const ticker = tickers[this.publicClient.market(symbol).symbol] ?? tickers[symbol];
        if (isNil(ticker?.last)) throw new GekkoError('exchange', `Fetch ticker failed to return data for ${symbol}`);
        result[symbol] = { ask: ticker.ask ?? ticker.last, bid: ticker.bid ?? ticker.last };
      }
      return result;
    });
  }

  public async fetchTicker(symbol: string) {
    return retry<Ticker>(async () => {
      const ticker = await this.publicClient.fetchTicker(symbol, PARAMS.fetchTicker[this.exchangeName]);
      if (isNil(ticker.last)) throw new GekkoError('exchange', `Fetch ticker failed to return data for ${symbol}`);
      return { ask: ticker.ask ?? ticker.last, bid: ticker.bid ?? ticker.last };
    });
  }

  public async fetchOHLCV(symbol: string, params: FetchOHLCVParams = {}) {
    return retry<Candle[]>(async () => {
      const { from, timeframe = '1m', limit = LIMITS[this.exchangeName].candles } = params;
      const ohlcvList = await this.publicClient.fetchOHLCV(symbol, timeframe, from, limit);
      const candles = mapOhlcvToCandles(ohlcvList);
      debug('exchange', this.describeFetchedCandles(symbol, candles));
      return candles;
    });
  }

  /**
   * What fetchOHLCV fetched: how many candles, and from the start of the first to the start of the last. The duration between them is
   * counted on the UTC calendar: on the host's, a page across a DST change came out an hour off, 4999 minutes from 2026-10-24T00:00Z
   * reading "3 days 10 hours 19 minutes" in Paris. The line used to name the candles without their count, and to date an empty page
   * from 'Unknown Date' to 'Unknown Date'.
   */
  private describeFetchedCandles(symbol: string, candles: Candle[]) {
    const fetched = `Fetched ${candles.length} ${symbol} ${pluralize('candle', candles.length)} from ${this.exchangeName}.`;
    const start = first(candles)?.start;
    const end = last(candles)?.start;
    if (isNil(start) || isNil(end)) return fetched;
    const duration = formatDurationUTC(start, end);
    return `${fetched} From ${toISOString(start)} to ${toISOString(end)}${duration ? ` (${duration})` : ''}`;
  }

  /**
   * The trades of the account on a symbol made at or after `from`, its latest trades without it. ccxt 4.5.39 answers a call with one
   * page, sorted by time, of the first `limit` trades at or after `since` (parseTrades, filterBySinceLimit): Binance's fetchMyTrades
   * sends `since` as the startTime of myTrades, with `limit` (1000 at most on spot), Hyperliquid's sends it as the startTime of
   * userFillsByTime, which answers 2000 fills at most and takes no limit (see LIMITS).
   * createOrderSummary fetches the trades of an order from its first transaction on. If the account traded more than a page before the
   * order filled (another bot, manual trading, the other pairs watched), the fills of the order were beyond the single page fetched, and
   * its summary partial or empty. So while a page is full, the next one is fetched from the time of its last trade, not a millisecond
   * later (trades share milliseconds), and a trade fetched twice is kept once (getTradeKey). The fetching stops on a page that is not
   * full, and, warning that the later trades are missing, on a full page that brings no new trade (a page of trades in one millisecond)
   * or after MAX_MY_TRADES_PAGES pages. Without `from`, one page.
   * Hyperliquid's fills endpoints take no market: a page holds the fills of every market of the account, perpetuals included, which ccxt
   * filters by symbol afterwards, so that a page cut short by the fills of other markets would look like the last one. Its fills are
   * fetched for every market, those of the symbol being kept here.
   */
  public async fetchMyTrades(symbol: string, from?: EpochTimeStamp) {
    // Each page is read under retry; translateErrors translates a failure of the market lookup
    return translateErrors<Trade[]>(async () => {
      // The fee rate of a trade is derived from the currency its fee was paid in, base or quote of the market (see mapCcxtTradeToTrade)
      const market = this.publicClient.market(symbol);
      const limit = LIMITS[this.exchangeName].trades;
      // Hyperliquid: the fills of every market, filtered below (see above)
      const requestedSymbol = this.exchangeName === 'hyperliquid' ? undefined : symbol;
      const trades = new Map<string, CCXTTrade>();

      let since = from;
      for (let pageCount = 1; pageCount <= MAX_MY_TRADES_PAGES; pageCount++) {
        const page = await retry(() => this.privateClient.fetchMyTrades(requestedSymbol, since, limit));
        const knownCount = trades.size;
        for (const trade of page) trades.set(getTradeKey(trade), trade);
        if (isNil(from) || page.length < limit) break;

        const lastTime = last(page)?.timestamp ?? since;
        const isStuck = trades.size === knownCount;
        if (isStuck || pageCount === MAX_MY_TRADES_PAGES) {
          const reason = isStuck
            ? `cannot page past that time, a full page of ${limit} trades from it brought no new one`
            : `stopped after ${MAX_MY_TRADES_PAGES} pages of ${limit} trades, the most allowed`;
          warning(
            'exchange',
            `Trades of ${symbol} on ${this.exchangeName} fetched only up to ${toISOString(lastTime)}, later trades are missing: ${reason}`,
          );
          break;
        }
        since = lastTime;
      }

      const [executed, unknown] = partition(
        [...trades.values()].filter(trade => trade.symbol === market.symbol),
        isExecutedTrade,
      );
      if (unknown.length) this.warnOfUnknownTrades(symbol, unknown);
      return executed.map(trade => mapCcxtTradeToTrade(trade, market));
    });
  }

  /**
   * Warns, once for a call to fetchMyTrades, of the trades it leaves out, those that do not say what they executed (see
   * isExecutedTrade): an order they filled is summed up without them, from the trades left, or estimated by the Trader without any.
   */
  private warnOfUnknownTrades(symbol: string, trades: CCXTTrade[]) {
    const leftOut = `${trades.length} ${pluralize('trade', trades.length)} of ${symbol} on ${this.exchangeName} left out`;
    const described = trades.map(({ id, order, amount, price }) => `trade ${id} of order ${order} (amount ${amount}, price ${price})`);
    warning('exchange', `${leftOut}, their amount or price not a number above 0: ${described.join(', ')}`);
  }

  public async fetchOrder(symbol: string, id: string) {
    return retry<OrderState>(async () => {
      const order = await this.privateClient.fetchOrder(id, symbol);
      return mapCcxtOrderToOrder(order);
    });
  }

  /**
   * The orders open on the symbol, whoever placed them, oldest first as ccxt sorts them, each mapped by mapCcxtOrderToOpenOrder. The
   * private client asks: Binance signs the request (GET /api/v3/openOrders, for the symbol), and Hyperliquid, whose open orders anyone
   * may read, is told whose by the wallet address, which only that client has. ccxt 4.5.39 reads Hyperliquid's open orders on every
   * market of the account at once (frontendOpenOrders, which gives their types) and keeps those of the market of the symbol, the one a
   * symbol written with the name of a wrapped spot token resolves to (UBTC/USDC to BTC/USDC).
   */
  public async fetchOpenOrders(symbol: TradingPair) {
    return retry<OpenOrder[]>(async () => {
      const orders = await this.privateClient.fetchOpenOrders(symbol);
      return orders.map(order => mapCcxtOrderToOpenOrder(order));
    });
  }

  public async fetchBalance() {
    return retry<Portfolio>(async () => {
      const balance = await this.privateClient.fetchBalance(PARAMS.fetchBalance[this.exchangeName]);
      const portfolio: Portfolio = new Map();
      for (const { symbol } of this.pairs) {
        // Keyed by the asset and the currency of the configured symbol, the names the rest of Gekko reads the portfolio with
        // (symbol.split('/')). ccxt keys the balance by its unified codes, the base and the quote of the market, which may differ:
        // it lists Hyperliquid's wrapped spot tokens (UBTC, UETH, USOL...) under the coins they wrap (symbol BTC/USDC, base BTC,
        // baseName UBTC), keys their spot balance by those coins, and resolves a symbol written with the token name (UBTC/USDC) to
        // the same market.
        const [assetName, currencyName] = symbol.split('/');
        const market = this.publicClient.market(symbol);
        // Defensive: an asset with nothing under the base is read under baseName, the token name, which ccxt sets on Hyperliquid's
        // markets (not on Binance's) but leaves out of its types. For a balance keyed by token names: from another ccxt version, or
        // from a private client that has not loaded its currencies, where ccxt learns the wrapped tokens its built-in mapping lacks.
        const baseName = 'baseName' in market && typeof market.baseName === 'string' ? market.baseName : undefined;
        const asset = balance[market.base] ?? (baseName ? balance[baseName] : undefined);
        const currency = balance[market.quote];
        portfolio.set(assetName, { free: asset?.free ?? 0, used: asset?.used ?? 0, total: asset?.total ?? 0 });
        portfolio.set(currencyName, { free: currency?.free ?? 0, used: currency?.used ?? 0, total: currency?.total ?? 0 });
      }
      return portfolio;
    });
  }

  /** A write: sent once, never replayed (see the class comment). */
  public async createLimitOrder(
    symbol: string,
    side: OrderSide,
    amount: number,
    price: number,
    _onSettled?: OrderSettledCallback, // Ignored - real exchanges use polling
  ) {
    return translateErrors<OrderState>(async () => {
      // ccxt's limits carry no precision: given with it and the values asked for, a value rounded to nothing is refused as asked, with
      // the step that rounded it (see assertOrderWithinLimits)
      const { limits, precision } = this.publicClient.market(symbol);
      const rounded = this.roundToMarketPrecision(symbol, amount, price);
      const { amount: orderAmount, price: orderPrice } = assertOrderWithinLimits({
        tag: 'exchange',
        ...rounded,
        marketData: { ...limits, precision },
        requested: { amount, price },
      });
      this.warnOfPriceMove(symbol, side, price, orderPrice);

      const order = await this.sendCreation(symbol, 'limit', side, orderAmount, orderPrice);
      return this.getCreatedOrderState(symbol, order);
    });
  }

  /** A write: sent once, never replayed (see the class comment). */
  public async createMarketOrder(symbol: string, side: OrderSide, amount: number) {
    return translateErrors<OrderState>(async () => {
      // Narrowed to the amounts the exchange takes in a market order, Binance's MARKET_LOT_SIZE (see getMarketOrderLimits), with the
      // precision of the market, which names the step of a value rounded to nothing (see createLimitOrder)
      const { limits: marketLimits, precision } = this.publicClient.market(symbol);
      const limits = getMarketOrderLimits({ ...marketLimits, precision });

      // A read: fetchTicker retries it on its own. Its failure ends the creation before any order is sent, so it is not thrown as it
      // is: an ExchangeNetworkError thrown by a creation tells the orders that its outcome is unknown, the order maybe live
      const ticker = await this.fetchTicker(symbol).catch((err: unknown) => {
        throw new GekkoError('exchange', `Market order not sent: ticker unavailable (${describeError(err)})`, { cause: err });
      });
      const price = side === 'BUY' ? ticker.ask : ticker.bid;
      const rounded = this.roundToMarketPrecision(symbol, amount, price);
      const { amount: orderAmount, price: orderPrice } = assertOrderWithinLimits({
        tag: 'exchange',
        ...rounded,
        marketData: limits,
        requested: { amount, price },
      });

      // The price goes with the order. Hyperliquid has no market order: ccxt sends an immediate-or-cancel limit order at this price
      // plus or minus its defaultSlippage option (5%), and refuses a market order without a price. Binance ignores it, its
      // quoteOrderQty option being off (see createExchange).
      const order = await this.sendCreation(symbol, 'market', side, orderAmount, orderPrice);
      return this.getCreatedOrderState(symbol, order);
    });
  }

  /** A write: sent once, never replayed (see the class comment). */
  public async cancelOrder(symbol: string, id: string) {
    return translateErrors<OrderState>(async () => {
      const order = await this.privateClient.cancelOrder(id, symbol);
      return this.getCanceledOrderState(symbol, id, order);
    });
  }

  /**
   * The amount and the price of an order as the exchange is to receive them, so that the limits of the market are checked on them.
   * Checked on the raw values, an order whose cost exceeded cost.min by less than the rounding takes off (0.0000560556 BTC at 99990
   * USDT: 5.605 USDT, sent as 0.00005 BTC: 4.9995 USDT) passed, to be refused by the exchange as an InvalidOrder (Binance -1013)
   * instead of here as an OrderOutOfRangeError, which a partially filled sticky order takes for the end of its fill.
   * - The amount is truncated to the step of the market whatever the exchange, as ccxt's base amountToPrecision does for Binance
   *   (decimalToPrecision with TRUNCATE, in the precision mode of the exchange). Hyperliquid's own amountToPrecision rounds it half
   *   up: an all-in order would be sent above the balance, 0.000059958 BTC as 0.00006. createOrder rounds the amount again with
   *   amountToPrecision, which leaves a truncated amount as it is on both exchanges (ccxt 4.5.39).
   * - The price is rounded by ccxt's priceToPrecision, as createOrder rounds it: half up to the tick of the market (Binance), to 5
   *   significant digits, then 8 decimals less those of the amount (Hyperliquid, see PRICE_SIGNIFICANT_DIGITS), a tick that can be
   *   coarser than precision.price from the power of ten above the price the markets were loaded at (see warnOfPriceMove).
   * A value rounded to nothing is 0, which assertOrderWithinLimits refuses: decimalToPrecision returns '0', priceToPrecision throws an
   * InvalidOrder (Binance) or returns '0' (Hyperliquid). A value is left as it is:
   * - when it is not a finite number above 0, for assertOrderWithinLimits to refuse it with its own message (ccxt would throw a plain
   *   Error for a NaN price);
   * - when the market has no precision for it: Binance's createOrder then sends it as it is, where ccxt's rounding would throw.
   */
  private roundToMarketPrecision(symbol: string, amount: number, price: number): { amount: number; price: number } {
    const client = this.publicClient;
    const { precision } = client.market(symbol);
    const round = (value: number, marketPrecision: number | undefined, toPrecision: (value: number, marketPrecision: number) => string) => {
      if (!Number.isFinite(value) || value <= 0 || isNil(marketPrecision)) return value;
      try {
        return Number(toPrecision(value, marketPrecision));
      } catch (err) {
        if (err instanceof ccxt.InvalidOrder) return 0;
        throw err;
      }
    };
    return {
      // Written by numberToString, without an exponent, as ccxt does with a number: String(1.234567e-7) would truncate to 1.23456
      amount: round(amount, precision?.amount, (value, step) =>
        client.decimalToPrecision(client.numberToString(value)!, ccxt.TRUNCATE, step, client.precisionMode, client.paddingMode),
      ),
      price: round(price, precision?.price, value => client.priceToPrecision(symbol, value)),
    };
  }

  /**
   * Warns of a limit order whose price the rounding moved by more than half a tick of precision.price, the most a rounding to that tick
   * moves a price. Hyperliquid's tick can be coarser from the power of ten above the price its markets were loaded at (see
   * MarketData.precision.priceSignificantDigits): there, two prices a precision.price apart, two levels of a grid, were sent at one price
   * without a word. The order is sent all the same, at the price the exchange takes: refused, most limit orders of a pair whose price had
   * risen past a power of ten since the start would fail. A market order is priced at the ticker, a price the exchange takes as it is.
   */
  private warnOfPriceMove(symbol: string, side: OrderSide, price: number, sentPrice: number) {
    const tick = this.publicClient.market(symbol).precision?.price;
    if (isNil(tick) || !(tick > 0) || 2 * Math.abs(addPrecise(sentPrice, -price)) <= tick) return;
    // Every decimal, without an exponent: String wrote a price under 1e-6 as 4.5678e-7, and rounded to 8 decimals the price asked for
    // would read as the one sent
    const write = formatEveryDecimal;
    const moved = `LIMIT ${side} order on ${symbol} at ${write(price)} sent to ${this.exchangeName} at ${write(sentPrice)}`;
    const significantDigits = PRICE_SIGNIFICANT_DIGITS[this.exchangeName];
    const rule = `${this.exchangeName} takes ${significantDigits} significant digits in a price (precision.priceSignificantDigits)`;
    const reason = significantDigits ? `: ${rule}, a tick coarser than precision.price at that price` : '';
    warning('exchange', `${moved}, more than half a tick of precision.price (${write(tick)}) away${reason}`);
  }

  /**
   * Sends the creation of an order to the exchange, once. A failure that is not a refusal of the order is an OrderOutcomeUnknown: a
   * ccxt OperationFailed that is not a NetworkError (translateErrors makes that one an ExchangeNetworkError). ccxt 4.5.39 throws it
   * for an answer it could not read (BadResponse), and for Binance's internal errors: -1000 (unknown error) and -1006 (unexpected
   * response, "execution status unknown"), which ccxt files with -1001, -1004 and -1008 (disconnected, busy, overloaded), -1010
   * (error message received) and -1112 (no orders on the book). Left as it was, such a failure ended the order as one that placed
   * nothing, which a strategy then placed again, beside the first if it had gone through.
   */
  private async sendCreation(symbol: string, type: 'limit' | 'market', side: OrderSide, amount: number, price: number) {
    try {
      return await this.privateClient.createOrder(symbol, type, side, amount, price);
    } catch (err) {
      if (!(err instanceof ccxt.OperationFailed) || err instanceof ccxt.NetworkError) throw err;
      const failure = `${this.exchangeName} answered the creation of an order on ${symbol} with a failure that is not a refusal`;
      throw new OrderOutcomeUnknown(`${failure}: ${err.message}`, { cause: err });
    }
  }

  /**
   * The state of an order the exchange has just created. Hyperliquid answers a creation with the id of the order alone, without its
   * status or timestamp ({ resting: { oid } } for an order on the book, { filled: { totalSz, avgPx, oid } } for an executed one):
   * mapped as is, it would be open, and a market order, which never polls, would stay open forever. Such an order is read back with
   * fetchOrder, a read, retried on its own without replaying the creation.
   * An answer with neither a status nor an id, or a read-back that fails, leaves an order that may be live with nothing to follow it
   * by: OrderOutcomeUnknown, the id of the order created in its message. The read-back threw its own failure: taken by the orders for a
   * refusal (an InvalidOrder) or for a failure that placed nothing, the order created was placed again by the strategy beside it.
   */
  private async getCreatedOrderState(symbol: string, order: CCXTOrder | undefined): Promise<OrderState> {
    if (order && !isNil(order.status)) return mapCcxtOrderToOrder(order);
    if (isNil(order?.id))
      throw new OrderOutcomeUnknown(
        `${this.exchangeName} answered the creation of an order on ${symbol} with neither a status nor an id: the order may exist on the exchange, but cannot be followed`,
      );

    const created = `Order ${order.id} was created on ${this.exchangeName} for ${symbol}`;
    try {
      return await this.readOrderBack(symbol, order.id, created);
    } catch (err) {
      throw new OrderOutcomeUnknown(`${created}, but its state could not be read back: ${describeError(err)}`, { cause: err });
    }
  }

  /**
   * The state of an order the exchange has just accepted to cancel. Binance answers with the order canceled, its id, its status and
   * the amount filled until then: it is mapped as is. Hyperliquid only acknowledges the request ({ statuses: ['success'] }), which
   * ccxt turns into an order of status 'success' with neither id nor fill: mapped as is, it would be an order without an id, which
   * the order classes drop, so that the cancelation of a limit order would never end and a fill made just before it would go unseen.
   * An answer lacking the id or the status of the order is completed by reading the order back by the id the cancelation was sent for.
   */
  private async getCanceledOrderState(symbol: string, id: string, order: CCXTOrder | undefined): Promise<OrderState> {
    if (order && !isNil(order.id) && !isNil(order.status)) return mapCcxtOrderToOrder(order);
    return this.readOrderBack(symbol, id, `${this.exchangeName} accepted the cancelation of order ${id} on ${symbol}`);
  }

  /**
   * Reads back the state of an order after a write answered without it. fetchOrder is a read, retried on its own without sending
   * the write again. If it fails, the write has been carried out all the same: what was done is logged before the failure is thrown.
   */
  private async readOrderBack(symbol: string, id: string, writeDone: string): Promise<OrderState> {
    try {
      return await this.fetchOrder(symbol, id);
    } catch (err) {
      error('exchange', `${writeDone}, but reading its state back failed`);
      throw err;
    }
  }
}
