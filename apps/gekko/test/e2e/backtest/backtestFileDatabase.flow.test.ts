import type { TradingPair } from '@gekko/shared/models/utility.types';
import type { SQLiteStorage } from '@gekko/core/storage/sqlite.storage';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { omit } from 'lodash-es';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowContext, rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { clearLogs, logStore } from '../mocks/winston.mock';
import { candlesClosingAt, minute, mockBacktestModules, rawMarket, runBacktest, unreservedRead } from './backtestRun.helper';

mockBacktestModules();

const DATERANGE = rawDaterange({ start: minute(0), end: minute(9) - 1 });

/** BTC opening every minute of 00:00 to 00:08 at 10000, closing there but at 9000 on 00:01 and 11000 on 00:03, 100 either side */
const CANDLES = candlesClosingAt({ 1: 9000, 3: 11000 });

let directory: string;

/**
 * Writes the candles of BTC into the database file as an import does: through the storage of the importer mode, built by the services of
 * an import's context, which creates the file and its table, switches it to WAL, buffers the candles and inserts them when it closes, the
 * WAL copied into the file
 */
const importCandles = async (database: string) => {
  const { services } = await createFlowContext({
    watch: { mode: 'importer', assets: ['BTC'], currency: 'USDT', daterange: DATERANGE },
    exchange: { name: 'binance' },
    storage: { type: 'sqlite', database },
    plugins: [{ name: 'CandleWriter' }],
  });
  const storage = services.storage() as SQLiteStorage;
  for (const candle of CANDLES) storage.addBucket(new Map([['BTC/USDT', candle]]));
  storage.close();
};

/** A backtest of the minutes 00:00 to 00:08 on the database file, DebugBacktest buying 1 of each pair on 00:01, selling it on 00:03 */
const backtestOn = (database: string, assets: ('BTC' | 'ETH')[]): RawConfiguration => ({
  watch: { mode: 'backtest', assets, currency: 'USDT', timeframe: '1m', daterange: DATERANGE },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [...assets.map(assetName => ({ assetName, balance: 0 })), { assetName: 'USDT', balance: 300000 }],
    marketData: assets.map(asset => rawMarket(`${asset}/USDT` as TradingPair)),
  },
  storage: { type: 'sqlite', database },
  plugins: [{ name: 'TradingAdvisor', strategyName: 'DebugBacktest' }, { name: 'Trader' }],
  strategy: { name: 'DebugBacktest', buyCandleIndex: 1, sellCandleIndex: 3 },
});

/** The files of the directory, by name, with their size in bytes */
const filesOf = (path: string) => Object.fromEntries(readdirSync(path).map(file => [file, statSync(join(path, file)).size]));

describe('E2E: Backtest on a database file', () => {
  beforeEach(() => {
    clearLogs();
    directory = mkdtempSync(join(tmpdir(), 'gekko-file-database-e2e-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reads the candles an import wrote to the file, writing nothing to it, the storage closed once the run is over', async () => {
    const database = join(directory, 'candles.sql');
    await importCandles(database);
    const imported = readFileSync(database);

    const { failure, balanceReads, context } = await runBacktest(backtestOn(database, ['BTC']));
    // As main() does once a run is over
    context?.services.closeStorage();
    const reader = new Database(database, { readonly: true });
    const rowCount = reader.query('SELECT count(*) AS count FROM "CANDLES_BTC_USDT"').get();
    reader.close();

    // A backtest opens the database read-only: a connection of that kind to a database in WAL creates its shared memory and an empty WAL
    // beside it, which only a connection that writes removes, as the next import does when it closes
    const besideIt = omit(filesOf(directory), 'candles.sql');
    expect({
      failure,
      balanceReads: balanceReads.slice(3),
      unchanged: readFileSync(database).equals(imported),
      besideIt,
      rowCount,
    }).toEqual({
      failure: undefined,
      // The BUY of 1 at the close of 00:01, 9000, for 9009 with its fee; the SELL at that of 00:03, 11000, for 10989
      balanceReads: [unreservedRead(minute(2), { BTC: 1, USDT: 290991 }), unreservedRead(minute(4), { BTC: 0, USDT: 301980 })],
      unchanged: true,
      besideIt: { 'candles.sql-shm': 32768, 'candles.sql-wal': 0 },
      rowCount: { count: 9 },
    });
  });

  // The refusals of SQLiteStorage, which a backtest opens first, before the plugins are created, the candles not read
  it.each([
    [
      'a file that does not exist, which it does not create',
      'missing.sql',
      ['BTC'],
      (path: string) =>
        `[STORAGE] Cannot open the database ${path} (unable to open database file). A backtest reads an existing database: check storage.database, or import the candles first.`,
      ['candles.sql'],
    ],
    [
      'a file without the table of a pair it watches',
      'candles.sql',
      ['BTC', 'ETH'],
      (path: string) => `[STORAGE] ${path} holds no candles of ETH/USDT: import them first.`,
      ['candles.sql', 'candles.sql-shm', 'candles.sql-wal'],
    ],
  ] as const)('refuses %s, naming the file', async (_case, file, assets, message, files) => {
    await importCandles(join(directory, 'candles.sql'));
    // The lines of the import that prepared the file are not the backtest's: at debug level, its count of the candles written was taken
    // for a line of the refused backtest
    clearLogs();
    const database = join(directory, file);

    const { failure, orderCalls } = await runBacktest(backtestOn(database, [...assets]));

    expect({
      failure: failure && { name: failure.name, message: failure.message },
      orderCalls,
      logged: logStore,
      files: readdirSync(directory).sort(),
    }).toEqual({
      failure: { name: 'GekkoError', message: message(database) },
      orderCalls: [],
      logged: [],
      files: [...files],
    });
  });
});
