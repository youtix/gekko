import { describe, expect, it } from 'bun:test';
import { mockConfiguration, paperExchange, rawDaterange, type RawConfiguration } from './configuration.helper';

const realtime = (plugins: RawConfiguration['plugins']): RawConfiguration => ({
  watch: { mode: 'realtime', assets: ['BTC'], currency: 'USDT', timeframe: '1m' },
  exchange: paperExchange([{ assetName: 'USDT', balance: 1000 }]),
  storage: { type: 'sqlite', database: ':memory:' },
  plugins,
});

const backtest: RawConfiguration = {
  watch: {
    mode: 'backtest',
    assets: ['BTC'],
    currency: 'USDT',
    timeframe: '1m',
    daterange: rawDaterange({ start: Date.parse('2024-01-01T00:00:00Z'), end: Date.parse('2024-01-01T00:09:00Z') }),
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [{ assetName: 'USDT', balance: 1000 }],
    marketData: [
      {
        symbol: 'BTC/USDT',
        marketData: {
          price: { min: 0 },
          amount: { min: 0 },
          cost: { min: 0 },
          precision: { price: 2, amount: 6 },
          fee: { maker: 0.001, taker: 0.001 },
        },
      },
    ],
  },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [],
};

let raw: RawConfiguration = backtest;
mockConfiguration(() => raw);

/** The mocked singleton, as the code under test imports it */
const configuration = async () => (await import('@services/configuration/configuration')).config;

describe('mockConfiguration', () => {
  it('should hand out the sections the schema returns, a daterange in epoch milliseconds', async () => {
    raw = backtest;
    expect((await configuration()).getWatch().daterange).toEqual({ start: 1704067200000, end: 1704067740000 });
  });

  it('should hand out the other sections as the schema returns them, the logo shown by default', async () => {
    raw = { ...backtest, plugins: [{ name: 'Trader' }], strategy: { name: 'DebugBacktest', buyCandleIndex: 1 } };
    const config = await configuration();
    expect({ showLogo: config.showLogo(), plugins: config.getPlugins(), strategy: config.getStrategy() }).toEqual({
      showLogo: true,
      plugins: [{ name: 'Trader' }],
      strategy: { name: 'DebugBacktest', buyCandleIndex: 1 },
    });
  });

  it('should give the paper exchange the synchronization periods of the schema: ten minutes, twenty seconds an order', async () => {
    raw = realtime([{ name: 'Trader' }]);
    const { exchangeSynchInterval, orderSynchInterval } = (await configuration()).getExchange();
    expect({ exchangeSynchInterval, orderSynchInterval }).toEqual({ exchangeSynchInterval: 600_000, orderSynchInterval: 20_000 });
  });

  it('should read the configuration again on every call', async () => {
    raw = realtime([{ name: 'Trader' }]);
    const config = await configuration();
    raw = backtest;
    expect(config.getWatch().mode).toBe('backtest');
  });

  it.each<[string, RawConfiguration, boolean]>([
    ['should hand out the storage in backtest mode', backtest, true],
    ['should hand out the storage to a realtime run with a CandleWriter', realtime([{ name: 'CandleWriter' }]), true],
    ['should withhold the storage from a realtime run without a CandleWriter', realtime([{ name: 'Trader' }]), false],
  ])('%s', async (_title, configured, isHandedOut) => {
    raw = configured;
    expect((await configuration()).getStorage() !== undefined).toBe(isHandedOut);
  });

  it('should refuse a configuration the loader refuses, with the issues of the schema', async () => {
    raw = { ...backtest, exchange: { ...backtest.exchange, verbose: false } as RawConfiguration['exchange'] };
    const config = await configuration();
    expect(() => config.getWatch()).toThrow('Invalid configuration of the flow:\n✖ Unrecognized key: "verbose"\n  → at exchange');
  });
});
