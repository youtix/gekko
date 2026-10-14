import { Candle } from '@models/candle.types';
import { Portfolio } from '@models/portfolio.types';
import { config } from '@services/configuration/configuration';
import { info } from '@services/logger';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CCXTExchange } from '../ccxtExchange';
import { DummyCentralizedExchange } from '../dummy/dummyCentralizedExchange';
import { MarketData, OpenOrder } from '../exchange.types';
import { PaperTradingBinanceExchange } from './paperTradingBinanceExchange';

vi.mock('@services/configuration/configuration', () => ({
  config: { getWatch: vi.fn(), getExchange: vi.fn() },
}));
vi.mock('@services/logger', () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn() }));

vi.mock('../ccxtExchange', () => {
  const MockCCXT = vi.fn();
  MockCCXT.prototype.loadMarkets = vi.fn().mockResolvedValue(undefined);
  MockCCXT.prototype.fetchTicker = vi.fn().mockResolvedValue({ ask: 100, bid: 99 });
  MockCCXT.prototype.fetchOHLCV = vi.fn().mockResolvedValue([]);
  MockCCXT.prototype.fetchTickers = vi.fn();
  MockCCXT.prototype.getMarketData = vi.fn();
  MockCCXT.prototype.fetchOpenOrders = vi.fn();
  MockCCXT.prototype.onNewCandle = vi.fn().mockReturnValue(() => {});
  return { CCXTExchange: MockCCXT };
});

vi.mock('../dummy/dummyCentralizedExchange', () => {
  const MockDummy = vi.fn();
  MockDummy.prototype.fetchBalance = vi.fn().mockResolvedValue({ asset: { free: 1 }, currency: { free: 10000 } });
  MockDummy.prototype.createLimitOrder = vi.fn().mockResolvedValue({ id: 'order-1', status: 'open' });
  MockDummy.prototype.createMarketOrder = vi.fn().mockResolvedValue({ id: 'order-2', status: 'closed' });
  MockDummy.prototype.cancelOrder = vi.fn().mockResolvedValue({ id: 'order-1', status: 'canceled' });
  MockDummy.prototype.fetchOrder = vi.fn().mockResolvedValue({ id: 'order-1', status: 'open' });
  MockDummy.prototype.fetchMyTrades = vi.fn().mockResolvedValue([]);
  MockDummy.prototype.fetchOpenOrders = vi.fn();
  MockDummy.prototype.processOneMinuteBucket = vi.fn().mockResolvedValue(undefined);
  return { DummyCentralizedExchange: MockDummy };
});

const mockWatchConfig = { pairs: [{ symbol: 'BTC/USDT', timeframe: '1m' }] };
const mockExchangeConfig = {
  name: 'paper-binance' as const,
  verbose: false,
  simulationBalance: new Map([
    ['BTC', 1],
    ['USDT', 10000],
  ]),
  exchangeSynchInterval: 10000,
  orderSynchInterval: 5000,
};
// BTCUSDT as CCXTExchange reads it from Binance, its MARKET_LOT_SIZE (market) included
const REAL_MARKET_DATA: MarketData = {
  amount: { min: 0.00001, max: 9000 },
  price: { min: 0.01, max: 1000000 },
  cost: { min: 5, max: 9000000 },
  market: { min: 0, max: 86.27382215 },
  precision: { price: 0.01, amount: 0.00001 },
  fee: { maker: 0.001, taker: 0.002 },
};
/** A portfolio as the simulator holds it once built: each balance free, nothing used */
const createPortfolio = (balances: [string, number][]): Portfolio =>
  new Map(balances.map(([asset, balance]) => [asset, { free: balance, used: 0, total: balance }]));
const simulatorMarketData = () => vi.mocked(DummyCentralizedExchange).mock.calls[0][0].marketData;
const realExchangeConfig = () => vi.mocked(CCXTExchange).mock.calls[0][0];

describe('PaperTradingBinanceExchange', () => {
  beforeEach(() => {
    (config.getWatch as Mock).mockReturnValue(mockWatchConfig);
    // A fresh object per call, as CCXTExchange builds one
    vi.mocked(CCXTExchange.prototype.getMarketData).mockImplementation(() => structuredClone(REAL_MARKET_DATA));
    // The portfolio of the simulator built from mockExchangeConfig
    vi.mocked(DummyCentralizedExchange.prototype.fetchBalance).mockResolvedValue(
      createPortfolio([
        ['BTC', 1],
        ['USDT', 10000],
      ]),
    );
  });

  describe('Constructor', () => {
    it('returns paper-binance as exchange name', () => {
      expect(new PaperTradingBinanceExchange(mockExchangeConfig).getExchangeName()).toBe('paper-binance');
    });

    it('creates CCXTExchange with binance config', () => {
      new PaperTradingBinanceExchange(mockExchangeConfig);
      expect(CCXTExchange).toHaveBeenCalledWith(expect.objectContaining({ name: 'binance' }));
    });

    it.each`
      proxy
      ${'socks5://127.0.0.1:1080'}
      ${'http://127.0.0.1:3128'}
      ${undefined}
    `('creates the CCXTExchange that reads the market data with the proxy $proxy of the config', ({ proxy }) => {
      new PaperTradingBinanceExchange({ ...mockExchangeConfig, proxy });
      expect(realExchangeConfig().proxy).toBe(proxy);
    });
  });

  describe('loadMarkets', () => {
    it('loads markets from real exchange', async () => {
      const exchange = new PaperTradingBinanceExchange(mockExchangeConfig);
      await exchange.loadMarkets();
      expect(CCXTExchange.prototype.loadMarkets).toHaveBeenCalled();
    });

    it('creates DummyCentralizedExchange with simulation config', async () => {
      const exchange = new PaperTradingBinanceExchange(mockExchangeConfig);
      await exchange.loadMarkets();
      expect(DummyCentralizedExchange).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'dummy-cex', simulationBalance: expect.any(Map) }),
      );
    });

    it.each`
      feeOverride                        | fee
      ${undefined}                       | ${{ maker: 0.001, taker: 0.002 }}
      ${{}}                              | ${{ maker: 0.001, taker: 0.002 }}
      ${{ maker: 0.0008 }}               | ${{ maker: 0.0008, taker: 0.002 }}
      ${{ taker: 0.003 }}                | ${{ maker: 0.001, taker: 0.003 }}
      ${{ maker: 0.0005, taker: 0.001 }} | ${{ maker: 0.0005, taker: 0.001 }}
      ${{ maker: 0, taker: 0 }}          | ${{ maker: 0, taker: 0 }}
    `('gives the simulator the real market data with the fees $fee when feeOverride is $feeOverride', async ({ feeOverride, fee }) => {
      const exchange = new PaperTradingBinanceExchange({ ...mockExchangeConfig, feeOverride });
      await exchange.loadMarkets();
      expect(simulatorMarketData().get('BTC/USDT')).toEqual({ ...REAL_MARKET_DATA, fee });
    });

    // The portfolio the simulator holds once built, every asset and currency of the watched pairs. The configured simulationBalance, a
    // Map, used to be written with JSON.stringify: "Initial portfolio: {}".
    it.each`
      balances                                         | message
      ${[['BTC', 1], ['USDT', 10000]]}                 | ${'Initial portfolio: 1 BTC, 10,000 USDT'}
      ${[['BTC', 0.00000012], ['USDT', 0]]}            | ${'Initial portfolio: 0.00000012 BTC, 0 USDT'}
      ${[['BTC', 0.5], ['ETH', 2.25], ['USDT', 1500]]} | ${'Initial portfolio: 0.5 BTC, 2.25 ETH, 1,500 USDT'}
    `('logs the portfolio of the simulator at info level: $message', async ({ balances, message }) => {
      vi.mocked(DummyCentralizedExchange.prototype.fetchBalance).mockResolvedValue(createPortfolio(balances));
      await new PaperTradingBinanceExchange(mockExchangeConfig).loadMarkets();
      expect(info).toHaveBeenCalledWith('exchange', message);
    });

    // The simulator narrows the amounts of a market order with it, so that paper trading refuses the market orders Binance refuses
    it.each`
      feeOverride
      ${undefined}
      ${{ maker: 0.0008 }}
    `(
      'gives the simulator the amount limits of a market order of the real market when feeOverride is $feeOverride',
      async ({ feeOverride }) => {
        const exchange = new PaperTradingBinanceExchange({ ...mockExchangeConfig, feeOverride });
        await exchange.loadMarkets();
        expect(simulatorMarketData().get('BTC/USDT')?.market).toEqual({ min: 0, max: 86.27382215 });
      },
    );
  });

  describe('getMarketData', () => {
    it('returns the real market data before loadMarkets', () => {
      const exchange = new PaperTradingBinanceExchange({ ...mockExchangeConfig, feeOverride: { maker: 0.0008 } });
      expect(exchange.getMarketData('BTC/USDT')).toEqual(REAL_MARKET_DATA);
    });

    it.each`
      feeOverride          | fee
      ${undefined}         | ${{ maker: 0.001, taker: 0.002 }}
      ${{ maker: 0.0008 }} | ${{ maker: 0.0008, taker: 0.002 }}
      ${{ taker: 0.003 }}  | ${{ maker: 0.001, taker: 0.003 }}
    `('returns the fees $fee the simulator charges after loadMarkets when feeOverride is $feeOverride', async ({ feeOverride, fee }) => {
      const exchange = new PaperTradingBinanceExchange({ ...mockExchangeConfig, feeOverride });
      await exchange.loadMarkets();
      expect(exchange.getMarketData('BTC/USDT').fee).toEqual(fee);
    });

    it('returns the very market data the simulator was given once markets are loaded', async () => {
      const exchange = new PaperTradingBinanceExchange({ ...mockExchangeConfig, feeOverride: { maker: 0.0008 } });
      await exchange.loadMarkets();
      expect(exchange.getMarketData('BTC/USDT')).toBe(simulatorMarketData().get('BTC/USDT'));
    });

    it('returns the real market data of a pair that is not watched', async () => {
      const exchange = new PaperTradingBinanceExchange({ ...mockExchangeConfig, feeOverride: { maker: 0.0008 } });
      await exchange.loadMarkets();
      expect(exchange.getMarketData('ETH/USDT')).toEqual(REAL_MARKET_DATA);
    });
  });

  describe('Unauthenticated Operations (CCXTExchange)', () => {
    let exchange: PaperTradingBinanceExchange;

    beforeEach(async () => {
      exchange = new PaperTradingBinanceExchange(mockExchangeConfig);
      await exchange.loadMarkets();
    });

    it('fetchOHLCV delegates to real exchange', async () => {
      await exchange.fetchOHLCV('BTC/USDT', { limit: 10 });
      expect(CCXTExchange.prototype.fetchOHLCV).toHaveBeenCalledWith('BTC/USDT', { limit: 10 });
    });

    it('fetchTicker delegates to real exchange', async () => {
      await exchange.fetchTicker('BTC/USDT');
      expect(CCXTExchange.prototype.fetchTicker).toHaveBeenCalledWith('BTC/USDT');
    });

    it('fetchTickers delegates to real exchange', async () => {
      await exchange.fetchTickers(['BTC/USDT']);
      expect(CCXTExchange.prototype.fetchTickers).toHaveBeenCalledWith(['BTC/USDT']);
    });
  });

  describe('Authenticated Operations (DummyCentralizedExchange)', () => {
    let exchange: PaperTradingBinanceExchange;

    beforeEach(async () => {
      exchange = new PaperTradingBinanceExchange(mockExchangeConfig);
      await exchange.loadMarkets();
    });

    it('fetchBalance delegates to simulated exchange', async () => {
      await exchange.fetchBalance();
      expect(DummyCentralizedExchange.prototype.fetchBalance).toHaveBeenCalled();
    });

    it('createLimitOrder delegates to simulated exchange', async () => {
      await exchange.createLimitOrder('BTC/USDT', 'BUY', 0.1, 100);
      expect(DummyCentralizedExchange.prototype.createLimitOrder).toHaveBeenCalledWith('BTC/USDT', 'BUY', 0.1, 100, undefined);
    });

    it('createMarketOrder delegates to simulated exchange', async () => {
      await exchange.createMarketOrder('BTC/USDT', 'SELL', 0.5);
      expect(DummyCentralizedExchange.prototype.createMarketOrder).toHaveBeenCalledWith('BTC/USDT', 'SELL', 0.5);
    });

    it('cancelOrder delegates to simulated exchange', async () => {
      await exchange.cancelOrder('BTC/USDT', 'order-1');
      expect(DummyCentralizedExchange.prototype.cancelOrder).toHaveBeenCalledWith('BTC/USDT', 'order-1');
    });

    it('fetchOrder delegates to simulated exchange', async () => {
      await exchange.fetchOrder('BTC/USDT', 'order-1');
      expect(DummyCentralizedExchange.prototype.fetchOrder).toHaveBeenCalledWith('BTC/USDT', 'order-1');
    });

    it('fetchMyTrades delegates to simulated exchange', async () => {
      await exchange.fetchMyTrades('BTC/USDT', 1000);
      expect(DummyCentralizedExchange.prototype.fetchMyTrades).toHaveBeenCalledWith('BTC/USDT', 1000);
    });

    it('fetchOpenOrders delegates to simulated exchange', async () => {
      await exchange.fetchOpenOrders('BTC/USDT');
      expect(DummyCentralizedExchange.prototype.fetchOpenOrders).toHaveBeenCalledWith('BTC/USDT');
    });

    it('fetchOpenOrders returns the open orders of the simulated exchange', async () => {
      const openOrders: OpenOrder[] = [
        { id: 'limit-order-1', side: 'BUY', type: 'LIMIT', price: 95, amount: 2, filled: 0, remaining: 2, timestamp: 1000 },
      ];
      vi.mocked(DummyCentralizedExchange.prototype.fetchOpenOrders).mockResolvedValue(openOrders);
      expect(await exchange.fetchOpenOrders('BTC/USDT')).toBe(openOrders);
    });

    // A paper session has no Binance account: what is open on Binance is no order of its own
    it('fetchOpenOrders does not read the open orders of Binance', async () => {
      await exchange.fetchOpenOrders('BTC/USDT');
      expect(CCXTExchange.prototype.fetchOpenOrders).not.toHaveBeenCalled();
    });

    it('processOneMinuteBucket delegates to simulated exchange', async () => {
      const candle: Candle = { id: undefined, start: 1000, open: 100, high: 110, low: 90, close: 105, volume: 1000 };
      const bucket = new Map([['BTC/USDT', candle]]);
      await exchange.processOneMinuteBucket(bucket as any);
      expect(DummyCentralizedExchange.prototype.processOneMinuteBucket).toHaveBeenCalledWith(bucket);
    });
  });
});
