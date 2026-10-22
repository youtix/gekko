import { CandleBucket } from '@gekko/shared/models/event.types';
import { OrderSide, OrderState } from '@gekko/shared/models/order.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { Trade } from '@gekko/shared/models/trade.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import type { Watch } from '@gekko/schemas/configuration/configuration.types';
import { info } from '../../logger/logger';
import { CCXTExchange } from '../ccxtExchange';
import { DummyCentralizedExchange } from '../dummy/dummyCentralizedExchange';
import {
  DummyExchange,
  Exchange,
  FetchOHLCVParams,
  MarketData,
  OpenOrder,
  OrderSettledCallback,
} from '@gekko/shared/models/exchange.types';
import { describePortfolio } from './paperTradingBinanceExchange.helper';
import { PaperTradingBinanceExchangeConfig } from './paperTradingBinanceExchange.types';

/**
 * Paper Trading Exchange for Binance
 *
 * This exchange reads real market data from Binance (public endpoints, no authentication required)
 * while simulating all trades locally. It's designed for "screener mode" - testing strategies
 * with real-time data without risking real capital.
 *
 * Read Operations: Delegated to CCXTExchange (fetchOHLCV, fetchTicker, onNewCandle, etc.)
 * Write Operations: Simulated locally via DummyCentralizedExchange (createLimitOrder, etc.)
 *
 * Built from its paper-binance section (the starting balances, the fee override, the proxy) and the watch section: loadMarkets reads
 * the market and the ticker of each watched pair, and the watch section goes on to the CCXTExchange that reads Binance and to the
 * simulator loadMarkets builds.
 */
export class PaperTradingBinanceExchange implements Exchange, DummyExchange {
  private readonly realExchange: CCXTExchange;
  private readonly exchangeConfig: PaperTradingBinanceExchangeConfig;
  private readonly watch: Pick<Watch, 'pairs' | 'daterange'>;
  private simulatedExchange!: DummyCentralizedExchange;
  /** Set by loadMarkets: the market data the simulator trades with, fee override included */
  private simulatedMarketData?: Map<TradingPair, MarketData>;

  constructor(exchangeConfig: PaperTradingBinanceExchangeConfig, watch: Pick<Watch, 'pairs' | 'daterange'>) {
    // Use CCXTExchange for read operations (public endpoints only, no auth required)
    this.realExchange = new CCXTExchange(
      {
        name: 'binance',
        verbose: exchangeConfig.verbose,
        sandbox: false,
        exchangeSynchInterval: exchangeConfig.exchangeSynchInterval,
        orderSynchInterval: exchangeConfig.orderSynchInterval,
        proxy: exchangeConfig.proxy, // routes the public client, hence all the market data traffic, through the configured proxy
      },
      watch,
    );
    this.exchangeConfig = exchangeConfig;
    this.watch = watch;
  }

  /* -------------------------------------------------------------------------- */
  /*                              INITIALIZATION                                */
  /* -------------------------------------------------------------------------- */

  public async loadMarkets(): Promise<void> {
    const { pairs } = this.watch;

    // Load real market data from Binance via CCXTExchange
    await this.realExchange.loadMarkets();

    // Build market data from real exchange, with optional fee overrides
    const marketData = new Map(pairs.map(({ symbol }) => [symbol, this.buildMarketData(symbol)]));

    // Get all tickers for initial price
    const tickers = await Promise.all(pairs.map(async ({ symbol }) => [symbol, await this.realExchange.fetchTicker(symbol)] as const));

    // Initialize simulated exchange with real market constraints
    this.simulatedExchange = new DummyCentralizedExchange(
      {
        name: 'dummy-cex',
        marketData,
        simulationBalance: this.exchangeConfig.simulationBalance,
        initialTicker: new Map(tickers),
        exchangeSynchInterval: this.exchangeConfig.exchangeSynchInterval,
        orderSynchInterval: this.exchangeConfig.orderSynchInterval,
      },
      this.watch,
    );
    this.simulatedMarketData = marketData;

    info('exchange', '🔶 PAPER TRADING MODE - Using simulated orders with real market data');
    info('exchange', `Initial portfolio: ${describePortfolio(await this.simulatedExchange.fetchBalance())}`);
  }

  /** The override is merged into the real fees, not substituted: a fee it leaves out (maker or taker) keeps its Binance value */
  private buildMarketData(symbol: TradingPair): MarketData {
    const marketData = this.realExchange.getMarketData(symbol);
    const { feeOverride } = this.exchangeConfig;
    return feeOverride ? { ...marketData, fee: { ...marketData.fee, ...feeOverride } } : marketData;
  }

  /* -------------------------------------------------------------------------- */
  /*                    UNAUTHENTICATED OPERATIONS (via CCXTExchange)           */
  /* -------------------------------------------------------------------------- */

  public async fetchOHLCV(symbol: TradingPair, params?: FetchOHLCVParams) {
    return this.realExchange.fetchOHLCV(symbol, params);
  }

  public async fetchTickers(symbols: TradingPair[]) {
    return this.realExchange.fetchTickers(symbols);
  }

  public async fetchTicker(symbol: TradingPair) {
    return this.realExchange.fetchTicker(symbol);
  }

  /** Once loadMarkets has run, a watched pair gets what the simulator charges (fee override included), not Binance's own fees */
  public getMarketData(symbol: TradingPair): MarketData {
    return this.simulatedMarketData?.get(symbol) ?? this.realExchange.getMarketData(symbol);
  }

  /* -------------------------------------------------------------------------- */
  /*                   AUTHENTICATED OPERATIONS (Simulated Locally)             */
  /* -------------------------------------------------------------------------- */

  public async fetchBalance(): Promise<Portfolio> {
    return this.simulatedExchange.fetchBalance();
  }

  public async createLimitOrder(
    symbol: TradingPair,
    side: OrderSide,
    amount: number,
    price: number,
    onSettled?: OrderSettledCallback,
  ): Promise<OrderState> {
    return this.simulatedExchange.createLimitOrder(symbol, side, amount, price, onSettled);
  }

  public async createMarketOrder(symbol: TradingPair, side: OrderSide, amount: number): Promise<OrderState> {
    return this.simulatedExchange.createMarketOrder(symbol, side, amount);
  }

  public async cancelOrder(symbol: TradingPair, id: string): Promise<OrderState> {
    return this.simulatedExchange.cancelOrder(symbol, id);
  }

  public async fetchOrder(symbol: TradingPair, id: string): Promise<OrderState> {
    return this.simulatedExchange.fetchOrder(symbol, id);
  }

  public async fetchMyTrades(symbol: TradingPair, from?: EpochTimeStamp): Promise<Trade[]> {
    return this.simulatedExchange.fetchMyTrades(symbol, from);
  }

  /** The simulated orders open on the pair, not Binance's: a paper session starts with none, its simulator being new */
  public async fetchOpenOrders(symbol: TradingPair): Promise<OpenOrder[]> {
    return this.simulatedExchange.fetchOpenOrders(symbol);
  }

  /* -------------------------------------------------------------------------- */
  /*                          DUMMY EXCHANGE INTERFACE                          */
  /* -------------------------------------------------------------------------- */

  public async processOneMinuteBucket(bucket: CandleBucket): Promise<void> {
    return this.simulatedExchange.processOneMinuteBucket(bucket);
  }

  /* -------------------------------------------------------------------------- */
  /*                                IDENTIFICATION                              */
  /* -------------------------------------------------------------------------- */

  public getExchangeName(): string {
    return 'paper-binance';
  }
}
