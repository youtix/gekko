import { describe, expect, it, mock } from 'bun:test';
import { createCcxtModuleMock } from '../mocks/ccxt.mock';
import { MockWinston } from '../mocks/winston.mock';
import { createFlowContext, paperExchange, rawDaterange, type RawConfiguration } from './configuration.helper';

// The context loads the logger and the exchanges, ccxt among them, which the flows mock: backtestMissingCandles.flow.test.ts alone loads
// the real ccxt under Bun
mock.module('winston', () => MockWinston);
mock.module('ccxt', () => createCcxtModuleMock());

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

describe('createFlowContext', () => {
  it('should hand out the sections the schema returns, a daterange in epoch milliseconds', async () => {
    const { configuration } = await createFlowContext(backtest);
    expect(configuration.getWatch().daterange).toEqual({ start: 1704067200000, end: 1704067740000 });
  });

  it('should hand out the other sections as the schema returns them, the logo shown by default', async () => {
    const { configuration } = await createFlowContext({
      ...backtest,
      plugins: [{ name: 'Trader' }],
      strategy: { name: 'DebugBacktest', buyCandleIndex: 1 },
    });
    expect({ showLogo: configuration.showLogo(), plugins: configuration.getPlugins(), strategy: configuration.getStrategy() }).toEqual({
      showLogo: true,
      plugins: [{ name: 'Trader' }],
      strategy: { name: 'DebugBacktest', buyCandleIndex: 1 },
    });
  });

  it('should give the paper exchange the synchronization periods of the schema: ten minutes, twenty seconds an order', async () => {
    const { configuration } = await createFlowContext(realtime([{ name: 'Trader' }]));
    const { exchangeSynchInterval, orderSynchInterval } = configuration.getExchange();
    expect({ exchangeSynchInterval, orderSynchInterval }).toEqual({ exchangeSynchInterval: 600_000, orderSynchInterval: 20_000 });
  });

  it.each<[string, RawConfiguration, boolean]>([
    ['should hand out the storage in backtest mode', backtest, true],
    ['should hand out the storage to a realtime run with a CandleWriter', realtime([{ name: 'CandleWriter' }]), true],
    ['should withhold the storage from a realtime run without a CandleWriter', realtime([{ name: 'Trader' }]), false],
  ])('%s', async (_title, configured, isHandedOut) => {
    const { configuration } = await createFlowContext(configured);
    expect(configuration.getStorage() !== undefined).toBe(isHandedOut);
  });

  it('should build the services of the run from its configuration: the storage of the watched pairs', async () => {
    const { services } = await createFlowContext(backtest);
    const candles = services.storage().getCandles('BTC/USDT', { start: 0, end: 60_000 });
    services.closeStorage();
    expect(candles).toEqual([]);
  });

  it('should build a context of its own on every call, each with its configuration and its services', async () => {
    const [first, second] = [await createFlowContext(realtime([{ name: 'Trader' }])), await createFlowContext(backtest)];
    expect({
      modes: [first.configuration.getWatch().mode, second.configuration.getWatch().mode],
      sharesServices: first.services === second.services,
    }).toEqual({ modes: ['realtime', 'backtest'], sharesServices: false });
  });

  it('should refuse a configuration the loader refuses, with the issues of the schema', async () => {
    const raw = { ...backtest, exchange: { ...backtest.exchange, verbose: false } as RawConfiguration['exchange'] };
    // Caught rather than asserted through `rejects`, which Bun waits on past the test's timeout
    const failure = await createFlowContext(raw).then(
      () => undefined,
      (error: Error) => error,
    );
    expect({ name: failure?.name, message: failure?.message }).toEqual({
      name: 'GekkoError',
      message: '[CONFIGURATION] Invalid configuration object:\n✖ Unrecognized key: "verbose"\n  → at exchange',
    });
  });
});
