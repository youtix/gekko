import type { Candle } from '@gekko/shared/models/candle.types';
import type { SQLiteStorage } from '@gekko/core/storage/sqlite.storage';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSyntheticCandle } from '../../fixtures/syntheticData';
import { startFakeClock } from '../../helpers/clock.helper';
import { createFlowContext, type RawConfiguration } from '../../helpers/configuration.helper';
import { seedDatabaseWithCandles } from '../../helpers/database.helper';
import { endRealtimeRun, mockRealtimeModules, runRealtimeFor, useRealtimeConfiguration } from '../../helpers/realtimeRun.helper';
import { MockCCXTExchange } from '../../mocks/ccxt.mock';
import { clearLogs, isTextLine, logStore } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// 1. Mock winston, ccxt and the fetcher. Each test runs on real minutes under the fake clock, from 12:00:30, and ends its run before
// the next test starts (see realtimeRun.helper)
mockRealtimeModules();

// 2. Configuration: a CandleWriter storing BTC in a database file, which each test creates in a directory of its own
let database: string;
const writerOfBtc = (): RawConfiguration => ({
  watch: { mode: 'realtime', assets: ['BTC'], currency: 'USDT', timeframe: '1m', warmup: { candleCount: 0 } },
  exchange: { name: 'binance' },
  storage: { type: 'sqlite', database },
  plugins: [{ name: 'CandleWriter' }],
});
useRealtimeConfiguration(writerOfBtc);

// --------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------

/** The start of the minute hh:mm of the day the runs start on, 2024-01-01 (see REALTIME_START) */
const minute = (hours: number, minutes: number) => Date.UTC(2024, 0, 1, hours, minutes);

/** A candle that looks made up, as the gap filler makes one: flat at `price`, without volume */
const madeUp = (start: number, price: number): Candle => ({ start, open: price, high: price, low: price, close: price, volume: 0 });

/** The candles stored in the database file, read through a connection of their own, read-only, once the run's storage is closed */
const readDatabaseFile = () => {
  const db = new Database(database, { readonly: true });
  try {
    return db.query<Candle, []>('SELECT start, open, high, low, close, volume FROM "CANDLES_BTC_USDT" ORDER BY start').all();
  } finally {
    db.close();
  }
};

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Realtime run on stored minutes', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'gekko-e2e-stored-minutes-'));
    database = join(directory, 'candles.sqlite');
    clearLogs();
    MockCCXTExchange.reset();
    startFakeClock();
  });

  afterEach(async () => {
    // A realtime run never ends by itself: each test ends its own, plugins finalised, before the next one starts
    try {
      await endRealtimeRun();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("Scenario A: a stored made-up minute replaced by a traded one; a stored traded or made-up one kept against the run's", async () => {
    // A database an earlier run left: 12:00 and 12:03 made up, 12:01 and 12:02 traded, written as they are, through the storage of that
    // run's own context
    const earlierRun = (await createFlowContext(writerOfBtc())).services.storage() as SQLiteStorage;
    const stored = {
      twelveOne: { start: minute(12, 1), open: 1001, high: 1011, low: 991, close: 1005, volume: 7 },
      twelveTwo: { start: minute(12, 2), open: 1002, high: 1012, low: 992, close: 1006, volume: 8 },
      twelveThree: madeUp(minute(12, 3), 777),
    };
    seedDatabaseWithCandles(earlierRun, 'BTC/USDT', [madeUp(minute(12, 0), 1000), stored.twelveOne, stored.twelveTwo, stored.twelveThree]);
    earlierRun.close();

    // The exchange serves every minute but 12:02 and 12:03. The ticks of 12:03:02 and 12:04:02 get no closed minute (at 12:04:02 the
    // exchange serves 12:04, not closed yet); the tick of 12:05:02 gets 12:04, and the gap filler makes up 12:02 and 12:03 before it,
    // flat at the close of 12:01 and without volume.
    MockCCXTExchange.simulatedGaps = [{ start: minute(12, 2), end: minute(12, 4) }];

    // To 12:06:30, past the tick that stored 12:05, then the end of the run, which closes the storage of the CandleWriter
    await runRealtimeFor({ minutes: 6 });
    await endRealtimeRun();

    // A realtime run replaces a stored minute only when it looks made up, flat without volume, and only with a candle that traded:
    // 12:00 is the exchange's now; 12:01 keeps the candle stored against the exchange's own, 12:02 and 12:03 against the made-up ones
    const exchange = (start: number) => generateSyntheticCandle('BTC/USDT', start);
    const warnings = logStore.filter(isTextLine).flatMap(({ level, message }) => (level === 'warn' ? [message] : []));
    expect({ candles: readDatabaseFile(), warnings }).toEqual({
      candles: [
        exchange(minute(12, 0)),
        stored.twelveOne,
        stored.twelveTwo,
        stored.twelveThree,
        exchange(minute(12, 4)),
        exchange(minute(12, 5)),
      ],
      warnings: [
        'Received undefined candle for BTC/USDT @ 2024-01-01T12:02:00.000Z',
        'Received undefined candle for BTC/USDT @ 2024-01-01T12:02:00.000Z',
        'Total gap detected: filling 2 minutes for all assets from 2024-01-01T12:02:00.000Z',
      ],
    });
  });
});
