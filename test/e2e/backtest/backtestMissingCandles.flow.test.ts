import { ONE_MINUTE } from '@constants/time.const';
import type { SQLiteStorage } from '@services/storage/sqlite.storage';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { mockConfiguration, rawDaterange } from '../helpers/configuration.helper';
import { seedDatabaseWithCandles } from '../helpers/database.helper';
import { MockWinston } from '../mocks/winston.mock';

mock.module('winston', () => MockWinston);

const start = Date.parse('2024-01-01T00:00:00Z');
/** One candle a minute from 00:00 to 00:09, except the missing minutes */
const candlesWithout = (...missingMinutes: number[]) =>
  Array.from({ length: 10 }, (_, minute) => minute)
    .filter(minute => !missingMinutes.includes(minute))
    .map(minute => ({ start: start + minute * ONE_MINUTE, open: 100, high: 110, low: 90, close: 105, volume: 1 }));

const marketData = (symbol: string) => ({
  symbol,
  marketData: {
    price: { min: 0 },
    amount: { min: 0 },
    cost: { min: 0 },
    precision: { price: 2, amount: 6 },
    fee: { maker: 0.001, taker: 0.001 },
  },
});

mockConfiguration({
  watch: {
    mode: 'backtest',
    assets: ['BTC', 'ETH'],
    currency: 'USDT',
    timeframe: '1m',
    warmup: { candleCount: 0 },
    // Up to 00:09:59.999, so the last candle read is the one of 00:09
    daterange: rawDaterange({ start, end: start + 10 * ONE_MINUTE - 1 }),
    batchSize: 1440,
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [{ assetName: 'USDT', balance: 1000 }],
    marketData: [marketData('BTC/USDT'), marketData('ETH/USDT')],
  },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [],
});

describe('E2E: Backtest on a database with missing candles', () => {
  beforeEach(async () => {
    const { inject } = await import('@services/injecter/injecter');
    inject.reset();
    const storage = inject.storage() as SQLiteStorage;
    seedDatabaseWithCandles(storage, 'BTC/USDT', candlesWithout());
    seedDatabaseWithCandles(storage, 'ETH/USDT', candlesWithout(4, 5));
  });

  it('is refused, with the pair that has a gap and the date ranges the database holds for it', async () => {
    const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');

    await expect(gekkoPipeline()).rejects.toHaveProperty(
      'message',
      '[STREAM] Missing candles in database: ETH/USDT 2024-01-01T00:00:00.000Z -> 2024-01-01T00:09:00.000Z, Available date ranges: [2024-01-01T00:00:00.000Z - 2024-01-01T00:03:00.000Z], [2024-01-01T00:06:00.000Z - 2024-01-01T00:09:00.000Z]',
    );
  });
});
