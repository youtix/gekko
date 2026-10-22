import type { Watch } from '@gekko/schemas/configuration/configuration.types';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CCXTExchange } from '../exchange/ccxtExchange';
import { DummyCentralizedExchange } from '../exchange/dummy/dummyCentralizedExchange';
import { PaperTradingBinanceExchange } from '../exchange/paper/paperTradingBinanceExchange';
import { SQLiteStorage } from '../storage/sqlite.storage';
import { Services } from './services';

// The services are built from the sections they are given: none of them opens a database or reaches an exchange here
vi.mock('../storage/sqlite.storage', () => ({
  SQLiteStorage: vi.fn(function () {
    return { close: vi.fn() };
  }),
}));
vi.mock('../exchange/ccxtExchange', () => ({
  CCXTExchange: vi.fn(function () {
    return { kind: 'ccxt' };
  }),
}));
vi.mock('../exchange/dummy/dummyCentralizedExchange', () => ({
  DummyCentralizedExchange: vi.fn(function () {
    return { kind: 'dummy' };
  }),
}));
vi.mock('../exchange/paper/paperTradingBinanceExchange', () => ({
  PaperTradingBinanceExchange: vi.fn(function () {
    return { kind: 'paper' };
  }),
}));

/** The watch section of the run, as the schema outputs it: the pairs are not in alphabetical order, so a sorted list would not match */
const watch: Watch = {
  assets: ['ETH', 'BTC'],
  currency: 'USDT',
  pairs: [{ symbol: 'ETH/USDT' }, { symbol: 'BTC/USDT' }],
  timeframe: '1h',
  mode: 'backtest',
  tickrate: 1000,
  warmup: { candleCount: 100, tickrate: 1000 },
};
const storageConfig = { type: 'sqlite' as const, database: 'gekko.db' };
const intervals = { exchangeSynchInterval: 600_000, orderSynchInterval: 20_000 };
const simulation = { simulationBalance: new Map([['USDT', 1000]]) };

describe('Services', () => {
  // The configuration of the run, as a literal: each getter returns what the test sets
  const configuration = {
    showLogo: vi.fn(),
    getPlugins: vi.fn(),
    getStrategy: vi.fn(),
    getWatch: vi.fn(),
    getStorage: vi.fn(),
    getExchange: vi.fn(),
  };
  let services: Services;

  beforeEach(() => {
    configuration.getWatch.mockReturnValue(watch);
    services = new Services(configuration);
  });

  describe('storage', () => {
    beforeEach(() => {
      configuration.getStorage.mockReturnValue(storageConfig);
    });

    it('returns the storage it built on every later call', () => {
      expect(services.storage()).toBe(services.storage());
    });

    it('reads the storage section once', () => {
      services.storage();
      services.storage();
      expect(configuration.getStorage).toHaveBeenCalledOnce();
    });

    it('builds one SQLiteStorage, from the storage section and the watch section', () => {
      services.storage();
      services.storage();
      expect(SQLiteStorage).toHaveBeenCalledExactlyOnceWith(storageConfig, watch);
    });

    // The configuration gives no storage section to a run that has no use for one (see Configuration.getStorage)
    it.each`
      section
      ${undefined}
      ${{ database: 'gekko.db' }}
    `('refuses to build a storage from the storage section $section', ({ section }) => {
      configuration.getStorage.mockReturnValue(section);
      expect(() => services.storage()).toThrow(new GekkoError('configuration', 'Missing or unknown storage.'));
    });
  });

  describe('closeStorage', () => {
    it('does not throw when no storage is configured', () => {
      configuration.getStorage.mockReturnValue(undefined);
      expect(() => services.closeStorage()).not.toThrow();
    });

    it('does not create a storage when none was created', () => {
      configuration.getStorage.mockReturnValue(storageConfig);
      services.closeStorage();
      expect(SQLiteStorage).not.toHaveBeenCalled();
    });

    it('closes the storage that was created, once', () => {
      configuration.getStorage.mockReturnValue(storageConfig);
      const storage = services.storage();
      services.closeStorage();
      expect(storage.close).toHaveBeenCalledOnce();
    });
  });

  describe('exchange', () => {
    describe.each`
      name               | className                        | exchangeClass                  | section
      ${'binance'}       | ${'CCXTExchange'}                | ${CCXTExchange}                | ${{ name: 'binance', apiKey: 'k', secret: 's', sandbox: false, verbose: false, ...intervals }}
      ${'hyperliquid'}   | ${'CCXTExchange'}                | ${CCXTExchange}                | ${{ name: 'hyperliquid', privateKey: 'pk', walletAddress: 'wa', sandbox: false, verbose: false, ...intervals }}
      ${'dummy-cex'}     | ${'DummyCentralizedExchange'}    | ${DummyCentralizedExchange}    | ${{ name: 'dummy-cex', ...simulation, marketData: new Map(), initialTicker: new Map(), ...intervals }}
      ${'paper-binance'} | ${'PaperTradingBinanceExchange'} | ${PaperTradingBinanceExchange} | ${{ name: 'paper-binance', ...simulation, verbose: false, ...intervals }}
    `('named $name', ({ className, exchangeClass, section }) => {
      beforeEach(() => {
        configuration.getExchange.mockReturnValue(section);
      });

      it(`builds one ${className}, from the exchange section and the watch section`, () => {
        services.exchange();
        services.exchange();
        expect(exchangeClass).toHaveBeenCalledExactlyOnceWith(section, watch);
      });

      it('returns the exchange it built on every later call', () => {
        expect(services.exchange()).toBe(services.exchange());
      });
    });

    it.each`
      section
      ${undefined}
      ${{ name: 'unknown' }}
    `('refuses to build an exchange from the exchange section $section', ({ section }) => {
      configuration.getExchange.mockReturnValue(section);
      expect(() => services.exchange()).toThrow(new GekkoError('configuration', 'Missing or unknown exchange.'));
    });
  });
});
