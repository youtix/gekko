import { Candle } from '@gekko/shared/models/candle.types';
import { bench } from '@gekko/shared/utils/bench/bench.mock';
import { describe, vi } from 'vitest';
import { DummyCentralizedExchange } from './dummyCentralizedExchange';
import { DEFAULT_TICKER } from './dummyCentralizedExchange.const';
import { DummyCentralizedExchangeConfig } from './dummyCentralizedExchange.types';

const SYMBOL: `${string}/${string}` = 'BTC/USDT';

vi.mock('../../configuration/configuration', () => ({
  config: {
    getWatch: vi.fn(() => ({
      pairs: [{ symbol: 'BTC/USDT', timeframe: '1m' }],
      daterange: {
        start: '2020-01-01T00:00:00Z',
        end: '2020-01-02T00:00:00Z',
      },
    })),
  },
}));

const defaultMarketData = {
  price: { min: 1, max: 10_000 },
  amount: { min: 0.1, max: 100 },
  cost: { min: 10, max: 100_000 },
  precision: { price: 0.01, amount: 0.01 },
  fee: { maker: 0.001, taker: 0.002 },
};

describe('DummyCentralizedExchange Benchmarks', async () => {
  const exchangeConfig: DummyCentralizedExchangeConfig = {
    name: 'dummy-cex',
    exchangeSynchInterval: 200,
    orderSynchInterval: 200,
    simulationBalance: new Map([
      ['BTC', 1000000],
      ['USDT', 100000000],
    ]),
    marketData: new Map([[SYMBOL, defaultMarketData]]),
    initialTicker: new Map([[SYMBOL, DEFAULT_TICKER]]),
  };

  const exchange = new DummyCentralizedExchange(exchangeConfig);
  const numberOfOrders = 10000;

  // Setup orders that won't be filled
  // Current price ~100 (default)
  // Create BUY orders at 50
  // Create SELL orders at 150
  for (let i = 0; i < numberOfOrders / 2; i++) {
    await exchange.createLimitOrder(SYMBOL, 'BUY', 1, 50);
  }
  for (let i = 0; i < numberOfOrders / 2; i++) {
    await exchange.createLimitOrder(SYMBOL, 'SELL', 1, 150);
  }

  bench('processOneMinuteBucket with 10k orders (no fills)', async () => {
    const candle: Candle = {
      start: Date.now(),
      open: 100,
      high: 105,
      low: 95,
      close: 100,
      volume: 1000,
    };
    const bucket = new Map([[SYMBOL, candle]]);
    await exchange.processOneMinuteBucket(bucket);
  });
});
