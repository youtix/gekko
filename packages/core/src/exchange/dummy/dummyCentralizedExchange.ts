import { COST_DECIMALS } from '@gekko/shared/constants/order.const';
import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { AsyncMutex } from '@gekko/shared/helpers/async/asyncMutex';
import { assertOrderWithinLimits, getMarketOrderLimits } from '@gekko/shared/helpers/market/market.helper';
import { clonePortfolio, initializePortfolio } from '@gekko/shared/helpers/portfolio/portfolio.helper';
import { Candle } from '@gekko/shared/models/candle.types';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { OrderSide, OrderState } from '@gekko/shared/models/order.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { Trade } from '@gekko/shared/models/trade.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import type { Watch } from '@gekko/schemas/configuration/configuration.types';
import { DUMMY_CANDLE_BUFFER_SIZE, DUMMY_CANDLE_BUFFER_TRIM_MARGIN, LIMITS } from '../exchange.const';
import { InvalidOrder, OrderNotFound } from '../exchange.error';
import { Exchange, FetchOHLCVParams, MarketData, OpenOrder, OrderSettledCallback, Ticker } from '@gekko/shared/models/exchange.types';
import { addPrecise, multiplyPrecise } from '@gekko/shared/utils/math/math.utils';
import { round, shiftDecimalPoint } from '@gekko/shared/utils/math/round.utils';
import { difference, isNil, sortedIndexBy, sortedLastIndexBy } from 'lodash-es';
import { addToBalance, describeShortfall, roundToMarketPrecision } from './dummyCentralizedExchange.helper';
import { DummyCentralizedExchangeConfig, DummyInternalOrder } from './dummyCentralizedExchange.types';

/**
 * The exchange of a backtest, and the simulator of paper trading: it fills the orders on the candles it is given (see
 * processOneMinuteBucket). Built from its dummy-cex section (the fees and order limits of each pair, the starting balances and
 * tickers) and the watch section: one order book and one balance per watched pair, its clock at the start of the daterange until the
 * first candle (at the time it is built without a daterange, as in paper trading).
 */
export class DummyCentralizedExchange implements Exchange {
  private readonly mutex = new AsyncMutex();
  private readonly ordersMap: Map<string, DummyInternalOrder>;
  private readonly orderSettledCallbacks: Map<string, OrderSettledCallback>;
  private readonly orderBooks: Map<TradingPair, Record<OrderSide, DummyInternalOrder[]>>; // BUY sorted by price DESC, SELL by price ASC
  private readonly candles: Map<TradingPair, Candle[]>;
  private readonly marketData: Map<TradingPair, MarketData>;
  /** The executions of each pair, oldest first: what fetchMyTrades reads, recorded by recordExecution when an order fills */
  private readonly executions: Map<TradingPair, Trade[]>;
  private readonly portfolio: Portfolio;
  private ticker: Map<TradingPair, Ticker | undefined>;
  /**
   * The close of the last candle processed (the daterange start, or now, until then). From the first bucket on it never goes back,
   * because buckets come in ascending order (the SQLite reader in backtest, RejectDuplicateCandleStream in realtime). The first
   * bucket itself can take it back, as a paper session starts at now and then replays its warmup, but no order executes before it:
   * orders come from strategy advice, which needs a candle.
   */
  private currentTimestamp: EpochTimeStamp;
  private orderSequence = 0;

  constructor(exchangeConfig: DummyCentralizedExchangeConfig, watch: Pick<Watch, 'pairs' | 'daterange'>) {
    const { marketData, simulationBalance, initialTicker } = exchangeConfig;
    const { pairs, daterange } = watch;
    const symbols = pairs.map(({ symbol }) => symbol);
    // The fees and order limits of a pair come from its marketData entry alone. The configuration schema refuses a watched pair
    // without one, but PaperTradingBinanceExchange builds its dummy directly, from the market data of the real exchange.
    const symbolsWithoutMarketData = difference(symbols, [...marketData.keys()]);
    if (symbolsWithoutMarketData.length)
      throw new GekkoError(
        'exchange',
        `Each watched pair needs a marketData entry, or dummy-cex fills its orders with no fees and no order limits (missing: ${symbolsWithoutMarketData.join(', ')})`,
      );
    this.marketData = marketData;
    this.portfolio = initializePortfolio(symbols, simulationBalance);
    this.ticker = new Map(symbols.map(symbol => [symbol, initialTicker.get(symbol)]));
    this.ordersMap = new Map();
    this.orderSettledCallbacks = new Map();
    this.candles = new Map();
    this.orderBooks = new Map();
    this.executions = new Map();
    this.currentTimestamp = daterange?.start ? daterange.start : Date.now();
  }

  public getExchangeName(): string {
    return 'dummy-cex';
  }

  /** Because dummy exchange is not a plugin, I need to call this function manually in the plugins stream */
  public async processOneMinuteBucket(bucket: CandleBucket): Promise<void> {
    return this.mutex.runExclusive(() => {
      for (const [symbol, candle] of bucket) {
        // The close time of the candle, in epoch milliseconds: date-fns' addMinutes built a Date for each candle of each bucket
        this.currentTimestamp = candle.start + ONE_MINUTE;
        const oldCandles = this.candles.get(symbol);
        if (oldCandles) {
          oldCandles.push(candle);
          // Only the last DUMMY_CANDLE_BUFFER_SIZE candles are kept, or a backtest would hold its whole daterange in memory (and a paper
          // session one more candle per pair every minute). They are dropped in blocks: one shift() per minute moves the whole buffer.
          if (oldCandles.length > DUMMY_CANDLE_BUFFER_SIZE + DUMMY_CANDLE_BUFFER_TRIM_MARGIN)
            oldCandles.splice(0, oldCandles.length - DUMMY_CANDLE_BUFFER_SIZE);
        } else this.candles.set(symbol, [candle]);
        this.ticker.set(symbol, { bid: candle.close, ask: candle.close });
        this.settleOrdersWithCandle(symbol, candle);
      }
    });
  }

  public async loadMarkets(): Promise<void> {
    // Nothing to do, already done in constructor
  }

  /**
   * Warning: if you fetch tickers before the first candle is processed, it will return { bid: 0, ask: 0 }.
   * Unless you set the initialTicker in configuration.
   */
  public async fetchTickers(symbols: TradingPair[]): Promise<Record<TradingPair, Ticker>> {
    return this.mutex.runExclusive(() =>
      symbols.reduce(
        (acc, symbol) => ({ ...acc, [symbol]: this.ticker.get(symbol) ?? { bid: 0, ask: 0 } }),
        {} as Record<TradingPair, Ticker>,
      ),
    );
  }

  /**
   * Warning: if you fetch the ticker before the first candle is processed, it will return { bid: 0, ask: 0 }.
   * Unless you set the initialTicker in configuration.
   */
  public async fetchTicker(symbol: TradingPair): Promise<Ticker> {
    return this.mutex.runExclusive(() => ({ ...(this.ticker.get(symbol) ?? { bid: 0, ask: 0 }) }));
  }

  /**
   * Reads the candles buffered by processOneMinuteBucket, which keeps the last DUMMY_CANDLE_BUFFER_SIZE of each pair, plus up to
   * DUMMY_CANDLE_BUFFER_TRIM_MARGIN older ones until its next trim. Without `from`, it returns the most recent `limit` candles.
   * A `from` older than the oldest candle kept starts at that candle: the candles before it are gone.
   */
  public async fetchOHLCV(symbol: TradingPair, params: FetchOHLCVParams = {}): Promise<Candle[]> {
    return this.mutex.runExclusive(() => {
      const { from, limit = LIMITS[this.getExchangeName()].candles } = params;
      const candles = this.candles.get(symbol) ?? [];
      if (candles.length === 0) return [];
      if (isNil(from)) return candles.slice(-limit);

      // The first candle starting at or after `from`: the buffer is in ascending start order, as the buckets come
      const startIndex = sortedIndexBy<Pick<Candle, 'start'>>(candles, { start: from }, 'start');

      // If no candle matches (start index is at the end), return empty
      if (startIndex >= candles.length) return [];

      const endIndex = isNil(limit) ? candles.length : startIndex + limit;
      return candles.slice(startIndex, endIndex);
    });
  }

  /**
   * Returns the executions of the pair, oldest first, as a real exchange does: an order still open, or canceled, has none. At most
   * LIMITS['dummy-cex'].trades come back, like ccxt given a limit: the first ones executed at or after `from`, found by bisection (a
   * call costs O(log n) plus what it returns, however many orders the session made), or the most recent ones without it.
   */
  public async fetchMyTrades(symbol: TradingPair, from?: EpochTimeStamp): Promise<Trade[]> {
    return this.mutex.runExclusive(() => {
      const limit = LIMITS[this.getExchangeName()].trades;
      const executions = this.executions.get(symbol) ?? [];
      const start = isNil(from)
        ? Math.max(executions.length - limit, 0)
        : sortedIndexBy<Pick<Trade, 'timestamp'>>(executions, { timestamp: from }, 'timestamp');
      return executions.slice(start, start + limit).map(execution => ({ ...execution, fee: { ...execution.fee } }));
    });
  }

  public async fetchBalance(): Promise<Portfolio> {
    return this.mutex.runExclusive(() => clonePortfolio(this.portfolio));
  }

  public async createLimitOrder(
    symbol: TradingPair,
    side: OrderSide,
    amount: number,
    price: number,
    onSettled?: OrderSettledCallback,
  ): Promise<OrderState> {
    return this.mutex.runExclusive(() => {
      // The limits are checked as CCXTExchange checks them, on the amount and the price it sends (see roundToMarketPrecision): an order
      // out of them is refused with the same error in every mode
      const marketData = this.getPairMarketData(symbol);
      const rounded = roundToMarketPrecision(amount, price, marketData);
      const { amount: orderAmount, price: orderPrice } = assertOrderWithinLimits({
        tag: 'exchange',
        ...rounded,
        marketData,
        requested: { amount, price },
      });

      this.reserveBalance(symbol, side, orderAmount, orderPrice);

      const id = `limit-order-${++this.orderSequence}`;
      const order: DummyInternalOrder = {
        id,
        symbol,
        status: 'open',
        price: orderPrice,
        filled: 0,
        remaining: orderAmount,
        amount: orderAmount,
        timestamp: this.currentTimestamp,
        side,
        type: 'LIMIT',
      };
      this.ordersMap.set(id, order);

      if (onSettled) this.orderSettledCallbacks.set(id, onSettled);

      if (side === 'BUY') this.insertBuyOrder(order);
      else this.insertSellOrder(order);

      return this.cloneOrder(order);
    });
  }

  public async createMarketOrder(symbol: TradingPair, side: OrderSide, amount: number): Promise<OrderState> {
    return this.mutex.runExclusive(() => {
      // Narrowed to the amounts of a market order (see getMarketOrderLimits): the MARKET_LOT_SIZE of Binance that paper trading carries, or
      // the `market` range of a backtest's marketData entry
      const marketData = getMarketOrderLimits(this.getPairMarketData(symbol));

      // The limits are checked as CCXTExchange checks them, at the price the order executes at: the ask for a BUY, the bid for a SELL,
      // with the amount and that price as it sends them (see roundToMarketPrecision)
      const price = side === 'BUY' ? this.ticker.get(symbol)?.ask : this.ticker.get(symbol)?.bid;
      if (isNil(price)) throw new InvalidOrder(`Ticker not found for symbol ${symbol}`);
      const rounded = roundToMarketPrecision(amount, price, marketData);
      const { amount: orderAmount, price: orderPrice } = assertOrderWithinLimits({
        tag: 'exchange',
        ...rounded,
        marketData,
        requested: { amount, price },
      });

      const id = `market-order-${++this.orderSequence}`;
      const { assetBalance, currencyBalance } = this.getPairBalances(symbol);

      if (side === 'BUY') {
        const totalCost = this.getCurrencyAmount(symbol, 'MARKET', side, orderAmount, orderPrice);
        if (currencyBalance.free < totalCost) throw new InvalidOrder(describeShortfall('BUY', currencyBalance.free, totalCost));
        addToBalance(currencyBalance, { free: -totalCost, total: -totalCost });
        addToBalance(assetBalance, { free: orderAmount, total: orderAmount });
      } else {
        if (assetBalance.free < orderAmount) throw new InvalidOrder(describeShortfall('SELL', assetBalance.free, orderAmount));
        const gain = this.getCurrencyAmount(symbol, 'MARKET', side, orderAmount, orderPrice);
        addToBalance(assetBalance, { free: -orderAmount, total: -orderAmount });
        addToBalance(currencyBalance, { free: gain, total: gain });
      }

      const order: DummyInternalOrder = {
        id,
        symbol,
        status: 'closed',
        price: orderPrice,
        filled: orderAmount,
        remaining: 0,
        amount: orderAmount,
        timestamp: this.currentTimestamp,
        side,
        type: 'MARKET',
      };
      this.ordersMap.set(id, order);
      this.recordExecution(order);

      return this.cloneOrder(order);
    });
  }

  public async cancelOrder(_symbol: TradingPair, id: string): Promise<OrderState> {
    return this.mutex.runExclusive(() => {
      const order = this.ordersMap.get(id);
      if (!order) throw new OrderNotFound(`Unknown order: ${id}`);

      if (order.status === 'open') {
        this.releaseBalance(order);
        order.status = 'canceled';
        order.timestamp = this.currentTimestamp;

        const orders = this.getOrderBook(order.symbol)[order.side];
        const idx = orders.indexOf(order);
        if (idx !== -1) orders.splice(idx, 1);

        // onSettled is dropped, not called: the caller gets the canceled state as the return value and would see the cancel twice
        this.orderSettledCallbacks.delete(order.id);
      }

      return this.cloneOrder(order);
    });
  }

  public async fetchOrder(_symbol: TradingPair, id: string): Promise<OrderState> {
    return this.mutex.runExclusive(() => {
      const order = this.ordersMap.get(id);
      if (!order) throw new OrderNotFound(`Unknown order: ${id}`);
      return this.cloneOrder(order);
    });
  }

  /**
   * The book of the pair, the limit orders neither filled nor canceled: the BUYs from the highest price down, then the SELLs from the
   * lowest price up. A market order fills at once and is never open, and an order fills in full or not at all, so an open order has
   * filled nothing yet. The books start empty: a backtest, or a paper session, has no open order until it places its own.
   */
  public async fetchOpenOrders(symbol: TradingPair): Promise<OpenOrder[]> {
    return this.mutex.runExclusive(() => {
      const orderBook = this.orderBooks.get(symbol);
      if (!orderBook) return [];
      return [...orderBook.BUY, ...orderBook.SELL].map(order => this.toOpenOrder(order));
    });
  }

  public getMarketData(symbol: TradingPair): MarketData {
    return this.marketData.get(symbol) ?? {};
  }

  /**
   * The marketData entry of a pair: its fees and order limits. Each watched pair has one (see the constructor), so an order on a pair
   * without one, such as USDT/BTC when BTC/USDT is watched, is refused here, before its limits are checked: it would trade free of
   * fees and order limits. A pair that is not watched but has an entry is refused by getPairBalances.
   */
  private getPairMarketData(symbol: TradingPair) {
    const marketData = this.marketData.get(symbol);
    if (!marketData)
      throw new InvalidOrder(
        `Unknown symbol ${symbol}: dummy-cex only trades the pairs it has a marketData entry for (${[...this.marketData.keys()].join(', ')})`,
      );
    return marketData;
  }

  /**
   * The balances of the asset and of the currency of a pair, as the portfolio holds them: the callers update them in place. The
   * portfolio has a balance for each asset and currency of the watched pairs (initializePortfolio) and for nothing else, so an order
   * on another pair is refused here, before any balance changes.
   */
  private getPairBalances(symbol: TradingPair) {
    const [asset, currency] = symbol.split('/');
    const assetBalance = this.portfolio.get(asset);
    const currencyBalance = this.portfolio.get(currency);
    if (!assetBalance || !currencyBalance)
      throw new InvalidOrder(
        `Unknown symbol ${symbol}: the portfolio only holds the assets and currencies of the watched pairs (${[...this.portfolio.keys()].join(', ')})`,
      );
    return { asset, currency, assetBalance, currencyBalance };
  }

  /** The fee rate (0.001 is 0.1 %) of an order on the pair: the taker fee for a market order, the maker fee for a limit order, 0 without */
  private getFeeRate(symbol: TradingPair, type: DummyInternalOrder['type']) {
    const fee = this.marketData.get(symbol)?.fee;
    return (type === 'MARKET' ? fee?.taker : fee?.maker) ?? 0;
  }

  /**
   * The currency an order of `amount` at `price` books, at the fee of its type (see getFeeRate): what a BUY costs, its fee on top, or
   * what a SELL brings in, its fee taken off. The product is rounded to COST_DECIMALS decimals, a half rounded up, as an exchange books
   * it: the balances it is added to then stay decimals (see addToBalance). It is worked out in decimal (multiplyPrecise, addPrecise),
   * exact while each product has 15 significant digits or fewer, as for any booking under 10,000 on the steps of Binance's BTC/USDT
   * (prices to the cent, amounts to 1e-5). In binary, a product a few ulps under a half was rounded down, 1e-8 short: a SELL of 0.01325
   * at 81619.12 at a fee of 0.00075 booked 1080.64224999 for 1080.64225. With more digits (prices and amounts of 8 decimals) it is a
   * binary product of the decimal parts, as near as a double gets, and can still be 1e-8 off.
   */
  private getCurrencyAmount(symbol: TradingPair, type: DummyInternalOrder['type'], side: OrderSide, amount: number, price: number) {
    const feeRate = this.getFeeRate(symbol, type);
    const feeFactor = addPrecise(1, side === 'BUY' ? feeRate : -feeRate);
    return round(multiplyPrecise(multiplyPrecise(amount, price), feeFactor), COST_DECIMALS);
  }

  /**
   * What a limit BUY of `amount` at `price` costs in currency, maker fee included: what its creation reserves, what its cancelation
   * releases (for the amount left) and what its execution spends. One formula for the three keeps them equal, so that a settled order
   * leaves nothing in `used`.
   */
  private getLimitBuyCost(symbol: TradingPair, amount: number, price: number) {
    return this.getCurrencyAmount(symbol, 'LIMIT', 'BUY', amount, price);
  }

  private reserveBalance(symbol: TradingPair, side: OrderSide, amount: number, price: number) {
    const { assetBalance, currencyBalance } = this.getPairBalances(symbol);

    if (side === 'BUY') {
      const totalCost = this.getLimitBuyCost(symbol, amount, price);
      if (currencyBalance.free < totalCost) throw new InvalidOrder(describeShortfall('BUY', currencyBalance.free, totalCost));
      addToBalance(currencyBalance, { free: -totalCost, used: totalCost });
    } else {
      if (assetBalance.free < amount) throw new InvalidOrder(describeShortfall('SELL', assetBalance.free, amount));
      addToBalance(assetBalance, { free: -amount, used: amount });
    }
  }

  private releaseBalance(order: DummyInternalOrder) {
    const { symbol } = order;
    const filled = order.filled ?? 0;
    const remaining = addPrecise(order.amount, -filled);
    if (remaining <= 0) return;

    const { assetBalance, currencyBalance } = this.getPairBalances(symbol);

    if (order.side === 'BUY') {
      const release = this.getLimitBuyCost(symbol, remaining, order.price ?? 0);
      addToBalance(currencyBalance, { free: release, used: -release });
    } else {
      addToBalance(assetBalance, { free: remaining, used: -remaining });
    }
  }

  private settleOrdersWithCandle(symbol: TradingPair, candle: Candle) {
    const orderBook = this.orderBooks.get(symbol);
    if (!orderBook) return;
    const { BUY: buyOrders, SELL: sellOrders } = orderBook;

    // Process BUYs (descending price)
    // Matches if candle.low <= order.price
    // Since sorted DESC, all orders from 0 to splitIndex match: splitIndex is the index of the first order priced below candle.low,
    // found by bisection on the negated price, or the length of the book when they all match
    const buySplitIndex = sortedLastIndexBy<Pick<DummyInternalOrder, 'price'>>(buyOrders, { price: candle.low }, o => -(o.price ?? 0));

    if (buySplitIndex > 0) {
      const matched = buyOrders.splice(0, buySplitIndex);
      for (const order of matched) {
        this.fillOrder(order, candle);
      }
    }

    // Process SELLs (ascending price)
    // Matches if candle.high >= order.price
    // Since sorted ASC, all orders from 0 to splitIndex match: splitIndex is the index of the first order priced above candle.high,
    // found by bisection, or the length of the book when they all match
    const sellSplitIndex = sortedLastIndexBy<Pick<DummyInternalOrder, 'price'>>(sellOrders, { price: candle.high }, o => o.price ?? 0);

    if (sellSplitIndex > 0) {
      const matched = sellOrders.splice(0, sellSplitIndex);
      for (const order of matched) {
        this.fillOrder(order, candle);
      }
    }
  }

  private fillOrder(order: DummyInternalOrder, _candle?: Candle) {
    if (order.status !== 'open') return;

    const { symbol } = order;
    const price = order.price ?? 0;
    const { assetBalance, currencyBalance } = this.getPairBalances(symbol);
    order.status = 'closed';
    order.filled = order.amount;
    order.remaining = 0;
    order.timestamp = this.currentTimestamp;

    if (order.side === 'BUY') {
      const cost = this.getLimitBuyCost(symbol, order.amount, price);
      addToBalance(currencyBalance, { used: -cost, total: -cost });
      addToBalance(assetBalance, { free: order.amount, total: order.amount });
    } else {
      const gain = this.getCurrencyAmount(symbol, 'LIMIT', 'SELL', order.amount, price);
      addToBalance(assetBalance, { used: -order.amount, total: -order.amount });
      addToBalance(currencyBalance, { free: gain, total: gain });
    }

    this.recordExecution(order);
    this.notifyAndCleanupCallback(order);
  }

  private notifyAndCleanupCallback(order: DummyInternalOrder) {
    const callback = this.orderSettledCallbacks.get(order.id);
    if (callback) {
      callback(this.cloneOrder(order));
      this.orderSettledCallbacks.delete(order.id);
    }
  }

  private getOrderBook(symbol: TradingPair) {
    let orderBook = this.orderBooks.get(symbol);
    if (!orderBook) {
      orderBook = { BUY: [], SELL: [] };
      this.orderBooks.set(symbol, orderBook);
    }
    return orderBook;
  }

  // Both books are kept sorted by bisection. sortedIndexBy, not sortedLastIndexBy, puts a new order before the orders already at its
  // price, so a candle reaching that price fills the most recent first.
  private insertBuyOrder(order: DummyInternalOrder) {
    // DESC: bisection on the negated price
    const buyOrders = this.getOrderBook(order.symbol).BUY;
    const index = sortedIndexBy(buyOrders, order, o => -o.price!);
    buyOrders.splice(index, 0, order);
  }

  private insertSellOrder(order: DummyInternalOrder) {
    // ASC
    const sellOrders = this.getOrderBook(order.symbol).SELL;
    const index = sortedIndexBy(sellOrders, order, 'price');
    sellOrders.splice(index, 0, order);
  }

  private cloneOrder(order: DummyInternalOrder): OrderState {
    const { id, status, filled, remaining, price, timestamp } = order;
    return { id, status, filled, remaining, price, timestamp };
  }

  /** An order of a book as fetchOpenOrders lists it: a limit order, whose fill and remaining amount createLimitOrder sets */
  private toOpenOrder(order: DummyInternalOrder): OpenOrder {
    const { id, side, type, price, amount, timestamp } = order;
    return { id, side, type, price, amount, filled: order.filled ?? 0, remaining: order.remaining ?? amount, timestamp };
  }

  /**
   * Journals the execution of an order that just filled. There is no partial fill: an order executes once, for its whole amount at
   * its own price, with the fee of its type (see getFeeRate), recorded in % as a Trade carries it: its decimal point moved two places,
   * where multiplied by 100 in binary a fee of 0.0007 was journaled as 0.06999999999999999 %.
   * Executions come in timestamp order (see currentTimestamp), so each one lands at the end of its journal; inserting it with
   * sortedLastIndexBy, O(log n), keeps the journal sorted for the bisection in fetchMyTrades even if the clock ever went back.
   */
  private recordExecution(order: DummyInternalOrder) {
    const execution: Trade = {
      id: order.id,
      amount: order.filled ?? 0,
      price: order.price ?? 0,
      timestamp: order.timestamp,
      fee: { rate: shiftDecimalPoint(this.getFeeRate(order.symbol, order.type), 2) },
    };

    const executions = this.executions.get(order.symbol);
    if (!executions) this.executions.set(order.symbol, [execution]);
    else executions.splice(sortedLastIndexBy(executions, execution, 'timestamp'), 0, execution);
  }
}
