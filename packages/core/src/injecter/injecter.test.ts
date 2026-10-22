import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { Watch } from '@gekko/schemas/configuration/configuration.types';
import { config } from '../configuration/configuration';
import { SQLiteStorage } from '../storage/sqlite.storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inject } from './injecter';

const { BinanceExchangeMock, DummyCentralizedExchangeMock, PaperTradingBinanceExchangeMock } = vi.hoisted(() => ({
  BinanceExchangeMock: vi.fn(function (cfg) {
    return { exchangeName: cfg.name, type: 'ccxt' };
  }),
  DummyCentralizedExchangeMock: vi.fn(function (cfg) {
    return { exchangeName: cfg.name, type: 'dummy' };
  }),
  PaperTradingBinanceExchangeMock: vi.fn(function (cfg) {
    return { exchangeName: cfg.name, type: 'paper' };
  }),
}));

vi.mock('../configuration/configuration', () => ({
  config: { getStorage: vi.fn(), getExchange: vi.fn(), getWatch: vi.fn() },
}));

vi.mock('../storage/sqlite.storage', () => ({
  SQLiteStorage: vi.fn(function () {
    return { close: vi.fn() };
  }),
}));

vi.mock('../exchange/ccxtExchange', () => ({
  CCXTExchange: BinanceExchangeMock,
}));
vi.mock('../exchange/dummy/dummyCentralizedExchange', () => ({
  DummyCentralizedExchange: DummyCentralizedExchangeMock,
}));
vi.mock('../exchange/paper/paperTradingBinanceExchange', () => ({
  PaperTradingBinanceExchange: PaperTradingBinanceExchangeMock,
}));

describe('Injecter', () => {
  const getStorageMock = vi.mocked(config.getStorage);
  const getExchangeMock = vi.mocked(config.getExchange);
  const getWatchMock = vi.mocked(config.getWatch);

  beforeEach(() => {
    // Reset singleton state (accessing private property for testing)
    (inject as any).storageInstance = undefined;
    (inject as any).exchangeInstance = undefined;
    getStorageMock.mockClear();
    getExchangeMock.mockClear();
    getWatchMock.mockClear();
  });

  describe('storage', () => {
    it('returns cached storage instance on subsequent calls', () => {
      getStorageMock.mockReturnValue({ type: 'sqlite', database: '' });
      // Checked against the parsed watch rather than cast to it: cast, it kept fillGaps, an option the schema refuses
      getWatchMock.mockReturnValue({
        pairs: [{ symbol: 'BTC/USDT' }],
        assets: ['BTC'],
        currency: 'USDT',
        timeframe: '1h',
        mode: 'backtest',
        tickrate: 1000,
        warmup: { candleCount: 100, tickrate: 1000 },
      });
      const first = inject.storage();
      const second = inject.storage();
      expect(second).toBe(first);
      expect(getStorageMock).toHaveBeenCalledTimes(1);
    });

    it('builds the storage once, with the watched symbols in order', () => {
      getStorageMock.mockReturnValue({ type: 'sqlite', database: ':memory:' });
      // Not in alphabetical order, so a sorted list would not match either
      getWatchMock.mockReturnValue({ pairs: [{ symbol: 'ETH/USDT' }, { symbol: 'BTC/USDT' }] } as unknown as Watch);

      inject.storage();
      inject.storage();

      expect(SQLiteStorage).toHaveBeenCalledExactlyOnceWith(['ETH/USDT', 'BTC/USDT']);
    });

    it('throws GekkoError if storage config is missing', () => {
      getStorageMock.mockReturnValue(undefined);
      expect(() => inject.storage()).toThrow(GekkoError);
    });
  });

  describe('closeStorage', () => {
    it('does not throw when no storage is configured', () => {
      getStorageMock.mockReturnValue(undefined);
      expect(() => inject.closeStorage()).not.toThrow();
    });

    it('does not create a storage when none was created', () => {
      getStorageMock.mockReturnValue({ type: 'sqlite', database: ':memory:' });
      getWatchMock.mockReturnValue({ pairs: [{ symbol: 'BTC/USDT' }] } as unknown as Watch);

      inject.closeStorage();

      expect(SQLiteStorage).not.toHaveBeenCalled();
    });

    it('closes the storage that was created, once', () => {
      const close = vi.fn();
      (inject as any).storageInstance = { close };

      inject.closeStorage();

      expect(close).toHaveBeenCalledOnce();
    });
  });

  describe('exchange', () => {
    const testCases = [
      {
        name: 'binance',
        config: { name: 'binance', apiKey: 'k', secret: 's' },
        mock: BinanceExchangeMock,
      },
      {
        name: 'hyperliquid',
        config: { name: 'hyperliquid', privateKey: 'pk', walletAddress: 'wa' },
        mock: BinanceExchangeMock,
      },
      {
        name: 'dummy-cex',
        config: { name: 'dummy-cex', simulationBalance: {} },
        mock: DummyCentralizedExchangeMock,
      },
      {
        name: 'paper-binance',
        config: { name: 'paper-binance', simulationBalance: {} },
        mock: PaperTradingBinanceExchangeMock,
      },
    ];

    it.each(testCases)('instantiates and caches $name exchange', ({ config: cfg, mock }) => {
      getExchangeMock.mockReturnValue(cfg as any);
      getWatchMock.mockReturnValue({
        pairs: [{ symbol: 'BTC/USDT' }],
        assets: ['BTC'],
        currency: 'USDT',
        timeframe: '1h',
        mode: 'backtest',
        tickrate: 1000,
        warmup: { candleCount: 100, tickrate: 1000 },
      });

      const first = inject.exchange();
      const second = inject.exchange();

      expect(first).toMatchObject({ exchangeName: cfg.name });
      expect(second).toBe(first);
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock).toHaveBeenCalledWith(cfg);
    });

    it('throws GekkoError if exchange config is missing', () => {
      getExchangeMock.mockReturnValue(undefined as any);
      expect(() => inject.exchange()).toThrow(GekkoError);
    });

    it('throws GekkoError for unknown exchange name', () => {
      getExchangeMock.mockReturnValue({ name: 'unknown' } as any);
      expect(() => inject.exchange()).toThrow(GekkoError);
    });
  });
});
