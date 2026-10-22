import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import type { Candle } from '@gekko/shared/models/candle.types';
import type { TradingPair } from '@gekko/shared/models/utility.types';
import type { SQLiteStorage } from '@gekko/core/storage/sqlite.storage';
import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { last } from 'lodash-es';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSyntheticCandle } from '../../fixtures/syntheticData';
import { minuteOf, REALTIME_START, startFakeClock } from '../../helpers/clock.helper';
import { mockConfiguration, type RawConfiguration } from '../../helpers/configuration.helper';
import { candleTables, countCandles, readCandles } from '../../helpers/database.helper';
import { endRealtimeRun, mockRealtimeModules, runRealtimeFor, runRealtimeUntil } from '../../helpers/realtimeRun.helper';
import { type Gap, MockCCXTExchange } from '../../mocks/ccxt.mock';
import { clearLogs, isTextLine, logStore } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// Winston, ccxt and the fetcher. Each test runs on real minutes under the fake clock, and ends its run before the next test starts (see
// realtimeRun.helper)
mockRealtimeModules();

type StorageSection = NonNullable<RawConfiguration['storage']>;

/** The storage of most scenarios, which writes each minute as it closes: realtime's insertThreshold is 1 by default */
const IN_MEMORY: StorageSection = { type: 'sqlite', database: ':memory:' };

// The storage of the next run, which setUpRun sets: the schema parses the configuration on every read
let mockStorage: StorageSection = IN_MEMORY;

mockConfiguration(() => ({
  watch: {
    mode: 'realtime',
    assets: ['BTC', 'ETH', 'LTC'],
    currency: 'USDT',
    timeframe: '1m',
    tickrate: 100,
    warmup: { candleCount: 0, tickrate: 100 },
  },
  exchange: { name: 'binance' },
  storage: mockStorage,
  plugins: [{ name: 'CandleWriter' }],
}));

// --------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------

const PAIRS: TradingPair[] = ['BTC/USDT', 'ETH/USDT', 'LTC/USDT'];

/**
 * 2024-01-01T12:00:00.000Z, the minute in progress when a run starts (REALTIME_START): the first one its live streams deliver, with the
 * tick of 12:01:02, each tick coming 2 s after a minute boundary and fetching the minute that just closed
 */
const FIRST_MINUTE = minuteOf(REALTIME_START);
/** The minute `n` minutes after the first one */
const minute = (n: number) => FIRST_MINUTE + n * ONE_MINUTE;
/** That minute, as the log lines write it */
const at = (n: number) => new Date(minute(n)).toISOString();

/** Sets the storage of the scenario's run, then builds it, which creates the table of each pair: it reads insertThreshold as it is built */
const setUpRun = async (storage: StorageSection = IN_MEMORY) => {
  mockStorage = storage;
  const { inject } = await import('@gekko/core/injecter/injecter');
  inject.reset();
  return inject.storage() as SQLiteStorage;
};

/** Runs the realtime pipeline `minutes` minutes, one at a time, and what `read` reads at the end of each */
const readEachMinute = async <T>(minutes: number, read: () => T) => {
  const reads: T[] = [];
  for (let elapsed = 0; elapsed < minutes; elapsed++) {
    await runRealtimeFor({ minutes: 1 });
    reads.push(read());
  }
  return reads;
};

/** The candles stored for each pair, by pair */
const storedCandles = (storage: SQLiteStorage) => Object.fromEntries(PAIRS.map(pair => [pair, readCandles(storage, pair)]));

/**
 * The candles a run stores for the pair, from its first minute to minute `lastMinute`: the exchange's, and for the minutes `filled`
 * holds a flat candle at the last close, without volume, as the gap filler makes them up
 */
const expectedCandles = (pair: TradingPair, lastMinute: number, { filled }: { filled?: Gap } = {}) => {
  const candles: Candle[] = [];
  for (let start = FIRST_MINUTE; start <= minute(lastMinute); start += ONE_MINUTE) {
    if (filled && start >= filled.start && start < filled.end) {
      const { close } = last(candles)!; // A gap is filled from the candle before it: a row filling the first minute is wrong
      candles.push({ start, open: close, high: close, low: close, close, volume: 0 });
    } else {
      candles.push(generateSyntheticCandle(pair, start));
    }
  }
  return candles;
};

/** The candles expected of each pair (see expectedCandles), by pair */
const expectedCandlesOfEachPair = (lastMinute: number, options?: { filled?: Gap }) =>
  Object.fromEntries(PAIRS.map(pair => [pair, expectedCandles(pair, lastMinute, options)]));

/** The lines logged at warn level since the beforeEach, oldest first */
const warnings = () =>
  logStore
    .filter(isTextLine)
    .filter(({ level }) => level === 'warn')
    .map(({ message }) => message);

/**
 * The candles of each pair the database file holds once the run has ended, read through a read-only connection to the file of the
 * storage, whose own connection the run closed as it ended
 */
const readDatabaseFile = (storage: SQLiteStorage, database: string) => {
  storage.db = new Database(database, { readonly: true });
  try {
    return storedCandles(storage);
  } finally {
    storage.db.close();
  }
};

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

// Every scenario compares each row stored, every field of it, with the candle expected for its minute. Checks of the opens alone passed
// a live stream that lost every third page: the minutes the gap filler made up for it, flat at the last close and without volume, had
// the opens of the minutes they stood for while the fixture closed each candle at the next one's open. A run that fails fails its
// scenario with its own error, which runRealtimeUntil and runRealtimeFor throw: the scenarios said the pipeline had completed without
// an error, which a realtime run never does.
describe('E2E: Realtime Writer (Synthetic)', () => {
  /** The directory of the database files, those of the scenarios that read what the end of a run writes */
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'gekko-writer-e2e-'));
  });

  beforeEach(() => {
    clearLogs();
    MockCCXTExchange.reset();
    startFakeClock();
  });

  // A realtime run never ends by itself: each test ends its own through the pipeline's signal before the next one starts, the plugins
  // finalised, CandleWriter closing the storage, which writes the minutes it still holds
  afterEach(() => endRealtimeRun());

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('Scenario A: stores each minute of a pair once it has closed, with the candle the exchange serves for it', async () => {
    const storage = await setUpRun();
    const storedAfterEachMinute = await readEachMinute(5, () => countCandles(storage, 'BTC/USDT'));
    expect({ storedAfterEachMinute, candles: readCandles(storage, 'BTC/USDT'), warnings: warnings() }).toEqual({
      storedAfterEachMinute: [1, 2, 3, 4, 5],
      candles: expectedCandles('BTC/USDT', 4),
      warnings: [],
    });
  });

  // The prices of the synthetic candles differ from pair to pair: a table holding the candles of another pair fails the comparison
  it('Scenario B: stores each pair in a table of its own, with the candles the exchange serves for that pair', async () => {
    const storage = await setUpRun();
    await runRealtimeUntil(() => PAIRS.every(pair => countCandles(storage, pair) >= 3), { maxMinutes: 6 });
    expect({ tables: candleTables(storage), candles: storedCandles(storage), warnings: warnings() }).toEqual({
      tables: ['CANDLES_BTC_USDT', 'CANDLES_ETH_USDT', 'CANDLES_LTC_USDT'],
      candles: expectedCandlesOfEachPair(2),
      warnings: [],
    });
  });

  // A lie of the exchange, which ccxt would never pass on (its parseOHLCVs keeps the candles at or after `since` alone): every third
  // page has each of its candles stamped with the first minute served, 12:00, the prices of the minutes asked for kept. The first is the
  // page of 12:03, at 12:04:02: the live stream drops its candle as delivered already, saying so for each pair, and asks for the minute
  // again with the next tick, which brings 12:03 and 12:04. Let through, the candle would reach RejectDuplicateCandle as a bucket of
  // 12:00 after 12:02, which it drops with a warning of its own, as the gap filler would after it, and the row of 12:00 would keep its
  // candle, a realtime run replacing only a stored candle that is made up. Skipped rather than asked for again, 12:03 would be made up
  // flat. The rows show the minute the lie hid as the exchange serves it, the warnings that the live stream dropped the candle itself.
  it('Scenario C: drops a candle the exchange stamps with a minute delivered already, and stores the minute it hid', async () => {
    MockCCXTExchange.emitDuplicatesEveryXCandle = 3;
    const storage = await setUpRun();
    await runRealtimeUntil(() => countCandles(storage, 'BTC/USDT') >= 5, { maxMinutes: 8 });
    expect({ candles: storedCandles(storage), warnings: warnings() }).toEqual({
      candles: expectedCandlesOfEachPair(4),
      warnings: PAIRS.flatMap(pair => [
        `Ignored a duplicate 1m candle of ${pair} @ ${at(0)}: already delivered`,
        `Received undefined candle for ${pair} @ ${at(3)}`,
      ]),
    });
  });

  // A lie of the exchange, which ccxt would never pass on (Binance has no candle after the minute in progress): every page opens with
  // the candle of 5 minutes after the call, off the minute boundaries, 12:06:02 for the call of 12:01:02. The live stream ignores it as a
  // minute not closed yet, at debug level. Let through, it would reach RejectFutureCandle, which drops it with a warning, while the live
  // stream fetched nothing more until that minute had closed, or, past that stage, be stored as a row off the minute boundaries, which
  // readCandles reads too.
  it('Scenario D: ignores a candle the exchange serves for a minute not closed yet', async () => {
    MockCCXTExchange.emitFutureCandles = true;
    const storage = await setUpRun();
    await runRealtimeUntil(() => countCandles(storage, 'BTC/USDT') >= 5, { maxMinutes: 8 });
    expect({ candles: storedCandles(storage), warnings: warnings() }).toEqual({ candles: expectedCandlesOfEachPair(4), warnings: [] });
  });

  // The exchange has no candle of any pair for minutes 2 to 4. The ticks of 12:03:02, 12:04:02 and 12:05:02 bring none, the last one
  // only the unfinished 12:05, and the tick of 12:06:02 brings 12:05: the gap filler makes up the three minutes before it, flat at the
  // close of 12:01, without volume. The gap was set from the wall clock before a cold import of the pipeline, which could start the run
  // after it, and the scenario checked the order of the minutes and prices above 0, which it passed without a minute made up.
  it('Scenario E: fills the minutes the exchange has no candle for with flat candles at the last close, for each pair', async () => {
    const gap: Gap = { start: minute(2), end: minute(5) };
    MockCCXTExchange.simulatedGaps = [gap];
    const storage = await setUpRun();
    await runRealtimeUntil(() => countCandles(storage, 'BTC/USDT', { start: gap.end, end: gap.end }) === 1, { maxMinutes: 10 });
    // Each tick of the gap asks again for the minutes from 12:02 on
    const noCandleYet = PAIRS.map(pair => `Received undefined candle for ${pair} @ ${at(2)}`);
    expect({ candles: storedCandles(storage), warnings: warnings() }).toEqual({
      candles: expectedCandlesOfEachPair(5, { filled: gap }),
      warnings: [...noCandleYet, ...noCandleYet, ...noCandleYet, `Total gap detected: filling 3 minutes for all assets from ${at(2)}`],
    });
  });

  // The storage holds the minutes until insertThreshold of them are, then writes them, and CandleWriter closes it as the run ends, which
  // writes those it still holds. The scenario set no insertThreshold and ran on realtime's 1, asserted a buffer of 1 minute at most,
  // and the run ended after its assertions: a storage that wrote a minute late, or a close that wrote nothing, passed it. The end is
  // read from a database file once the run has closed the storage: an in-memory database goes with the connection.
  it('Scenario F: writes the minutes insertThreshold at a time, and those it still holds as the run ends', async () => {
    const database = join(directory, 'candles.sql');
    const storage = await setUpRun({ type: 'sqlite', database, insertThreshold: 3 });
    const storedAfterEachMinute = await readEachMinute(5, () => PAIRS.map(pair => countCandles(storage, pair)));
    const warningsOfTheRun = warnings();
    await endRealtimeRun();
    expect({ storedAfterEachMinute, warnings: warningsOfTheRun, storedAtTheEnd: readDatabaseFile(storage, database) }).toEqual({
      // The rows of BTC, ETH and LTC at the end of each minute: none while one or two minutes are held, the three at the third
      storedAfterEachMinute: [
        [0, 0, 0],
        [0, 0, 0],
        [3, 3, 3],
        [3, 3, 3],
        [3, 3, 3],
      ],
      warnings: [],
      // The two minutes held as the run ended, 12:03 and 12:04, written by the close
      storedAtTheEnd: expectedCandlesOfEachPair(4),
    });
  });
});
