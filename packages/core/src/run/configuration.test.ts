import { describe, expect, it } from 'vitest';
import { parseConfiguration } from '../configuration/configuration.helper';
import { Configuration } from './configuration';

/** A paper trading configuration as a file holds it, before the schema checks it */
const raw = {
  showLogo: true,
  watch: {
    assets: ['BTC'],
    currency: 'USDT',
    timeframe: '1m',
    mode: 'realtime',
    warmup: { candleCount: 100, tickrate: 1000 },
    tickrate: 1000,
  },
  plugins: [{ name: 'PerformanceAnalyzer' }],
  strategy: { name: 'CCI' },
  exchange: {
    name: 'paper-binance',
    simulationBalance: [
      { assetName: 'BTC', balance: 1 },
      { assetName: 'USDT', balance: 10000 },
    ],
  },
};
const storage = { type: 'sqlite', database: 'gekko.db' };
const daterange = { start: '2023-01-01T00:00:00Z', end: '2023-01-02T00:00:00Z' };
/** raw as a backtest: the simulator of dummy-cex, with the market data of the watched pair, over a day */
const backtest = {
  ...raw,
  exchange: {
    ...raw.exchange,
    name: 'dummy-cex',
    marketData: [
      {
        symbol: 'BTC/USDT',
        marketData: {
          price: { min: 0.01, max: 1000000 },
          amount: { min: 0.00001, max: 9000 },
          cost: { min: 5, max: 9000000 },
          precision: { price: 8, amount: 8 },
          fee: { maker: 0.0004, taker: 0.0007 },
        },
      },
    ],
  },
  watch: { ...raw.watch, mode: 'backtest', daterange },
};
/** raw as an import from Binance, over a day */
const importer = { ...raw, exchange: { name: 'binance' }, watch: { ...raw.watch, mode: 'importer', daterange } };

/** The class as createRunContext builds it, from the configuration the schema outputs */
const configurationOf = (content: object) => new Configuration(parseConfiguration(content, 'object'));

describe('Configuration', () => {
  it.each`
    getter           | expected
    ${'showLogo'}    | ${true}
    ${'getPlugins'}  | ${[{ name: 'PerformanceAnalyzer' }]}
    ${'getStrategy'} | ${{ name: 'CCI' }}
    ${'getWatch'}    | ${{ ...raw.watch, pairs: [{ symbol: 'BTC/USDT' }] }}
    ${'getExchange'} | ${{ name: 'paper-binance', verbose: false, simulationBalance: new Map([['BTC', 1], ['USDT', 10000]]), exchangeSynchInterval: 600_000, orderSynchInterval: 20_000 }}
  `('returns with $getter its section as the schema outputs it', ({ getter, expected }) => {
    expect(configurationOf(raw)[getter as Exclude<keyof Configuration, 'getStorage'>]()).toEqual(expected);
  });

  // The storage section goes to the two users of a storage alone: a backtest, which reads its candles from it, and a CandleWriter,
  // which writes them
  describe('getStorage', () => {
    it.each`
      run                                           | content                                                          | expected
      ${'a realtime run without a storage section'} | ${raw}                                                           | ${undefined}
      ${'a realtime run without a CandleWriter'}    | ${{ ...raw, storage }}                                           | ${undefined}
      ${'a realtime run with a CandleWriter'}       | ${{ ...raw, storage, plugins: [{ name: 'CandleWriter' }] }}      | ${storage}
      ${'a backtest'}                               | ${{ ...backtest, storage }}                                      | ${storage}
      ${'an import with a CandleWriter'}            | ${{ ...importer, storage, plugins: [{ name: 'CandleWriter' }] }} | ${storage}
    `('returns $expected for $run', ({ content, expected }) => {
      expect(configurationOf(content).getStorage()).toEqual(expected);
    });
  });
});
