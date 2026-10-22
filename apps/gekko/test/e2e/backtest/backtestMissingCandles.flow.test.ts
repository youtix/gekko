import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import type { RunContext } from '@gekko/core/run/runContext.types';
import type { SQLiteStorage } from '@gekko/core/storage/sqlite.storage';
import { beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import { createFlowContext, rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { seedDatabaseWithCandles } from '../helpers/database.helper';
import { MockWinston } from '../mocks/winston.mock';
import { BACKTEST_TEST_TIMEOUT } from './backtestRun.helper';

mock.module('winston', () => MockWinston);
// Not ccxt, on purpose: the pipeline imports it, and this flow is the only test that loads the real ccxt under Bun, the runtime of the
// executable (the unit tests load it under Node, CI and the release build the executable without running it). Nor mockBacktestModules,
// which mocks it: the timeout of the other backtest flows is set here, the real ccxt making this flow the slowest to start
setDefaultTimeout(BACKTEST_TEST_TIMEOUT);

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

const CONFIGURATION: RawConfiguration = {
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
};

describe('E2E: Backtest on a database with missing candles', () => {
  /** The context of the run, whose in-memory database the pipeline reads: seeded with the candles of each pair first */
  let context: RunContext;

  beforeEach(async () => {
    context = await createFlowContext(CONFIGURATION);
    const storage = context.services.storage() as SQLiteStorage;
    seedDatabaseWithCandles(storage, 'BTC/USDT', candlesWithout());
    seedDatabaseWithCandles(storage, 'ETH/USDT', candlesWithout(4, 5));
  });

  it('is refused, with the pair that has a gap and the date ranges the database holds for it', async () => {
    const { gekkoPipeline } = await import('@gekko/core/core/pipeline/pipeline');
    const plugins = await import('@gekko/plugins/index');

    // Caught rather than asserted through `rejects`, which Bun waits on past the test's timeout: a backtest that froze would hang the
    // suite instead of failing this test
    const failure = await gekkoPipeline({ context, plugins }).then(
      () => new Error('The backtest ran'),
      (error: Error) => error,
    );
    expect({ name: failure.name, message: failure.message }).toEqual({
      name: 'MissingCandlesError',
      message:
        '[STREAM] Missing candles in database: ETH/USDT 2024-01-01T00:00:00.000Z -> 2024-01-01T00:09:00.000Z, Available date ranges: [2024-01-01T00:00:00.000Z - 2024-01-01T00:03:00.000Z], [2024-01-01T00:06:00.000Z - 2024-01-01T00:09:00.000Z]',
    });
  });
});
