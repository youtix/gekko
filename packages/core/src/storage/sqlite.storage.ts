import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { Candle } from '@gekko/shared/models/candle.types';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import type { Watch } from '@gekko/schemas/configuration/configuration.types';
import { debug } from '../logger/logger';
import { toISOString } from '@gekko/shared/utils/date/date.utils';
import { pluralize } from '@gekko/shared/utils/string/string.utils';
import { Database, SQLQueryBindings, Statement } from 'bun:sqlite';
import { Interval } from 'date-fns';
import { each } from 'lodash-es';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Storage } from './storage';
import { IN_MEMORY } from './storage.const';
import { CandleDateranges, MissingCandleCount, StorageConfig } from './storage.types';

/**
 * The storage of a run in an SQLite file, on bun:sqlite. Built from the storage section (the file, storage.database) and the watch
 * section: a table per watched pair, created if need be, but in a backtest, which opens the file read-only and refuses a pair without
 * a table (see Storage for the mode's other effects).
 */
export class SQLiteStorage extends Storage {
  db: Database;
  /** storage.database, the path of the SQLite file */
  private readonly database: string;
  /**
   * A backtest only reads, so a mistyped path fails instead of creating an empty database. An in-memory database cannot be
   * opened read-only and starts empty anyway: it is read-write in every mode (only tests use it).
   */
  private readonly readOnly: boolean;
  /** CandleWriter closes the storage when it is finalised, and main() closes it again on its way out (see close) */
  private closed = false;

  constructor(storageConfig: StorageConfig, watch: Pick<Watch, 'mode' | 'pairs'>) {
    super(storageConfig, watch);
    const { database } = storageConfig;
    if (!database) throw new GekkoError('storage', 'No database to open: set storage.database to the path of the SQLite file.');
    const symbols = watch.pairs.map(({ symbol }) => symbol);
    this.database = database;
    this.readOnly = watch.mode === 'backtest' && database !== IN_MEMORY;
    this.db = this.open(database);
    try {
      if (this.readOnly) {
        this.checkTables(database, symbols);
      } else {
        this.db.run('PRAGMA journal_mode = WAL;');
        this.db.run('PRAGMA synchronous = NORMAL;');
        each(symbols, symbol => this.createTable(symbol));
      }
    } catch (error) {
      // The storage never reaches the injecter, whose closeStorage() closes the one it created: a backtest refused for a pair without
      // a table left its connection open, holding the database, until the garbage collector closed it
      this.db.close(false);
      throw error;
    }
  }

  public insertCandles(symbol: TradingPair): void {
    const table = this.getQuotedTable(symbol);
    // What a written candle replaces, always keeping the row of the minute and its id (INSERT OR REPLACE would delete it and insert
    // another one). A stored candle looks made up when it is flat without volume, like the candles FillCandleGapStream makes up for
    // the minutes an exchange did not deliver, which it flags synthetic (a flag the database does not keep):
    // - in an import, a real candle replaces whatever is stored, a minute without trades included: the import reads the exchange's
    //   history and has the last word;
    // - in an import, a candle it made up only replaces a stored candle that looks made up: a minute missing from the exchange's
    //   history never erases a candle that traded;
    // - in any other mode, a candle only replaces a stored candle that looks made up, and only when it traded itself: a later run
    //   corrects the minutes an earlier one had to invent, and its own stand-ins never overwrite real data.
    const storedMadeUp = `
      ${table}.volume = 0 AND ${table}.open = ${table}.high AND ${table}.high = ${table}.low AND ${table}.low = ${table}.close`;
    const storedMadeUpByTraded = `WHERE ${storedMadeUp} AND excluded.volume > 0`;
    const conditions = this.hasLastWord
      ? { real: '', synthetic: `WHERE ${storedMadeUp}` }
      : { real: storedMadeUpByTraded, synthetic: storedMadeUpByTraded };
    const statements = new Map<string, Statement>(); // One per condition, prepared for the first candle that needs it
    const getStatement = (condition: string) => {
      let statement = statements.get(condition);
      if (!statement) {
        statement = this.db.prepare(`
          INSERT INTO ${table} (start, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(start) DO UPDATE SET
            open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume
          ${condition}
        `);
        statements.set(condition, statement);
      }
      return statement;
    };
    // A statement left open keeps the connection alive after close(false): the WAL is never checkpointed into the database file
    try {
      const insertCandles = this.db.transaction((buffer: CandleBucket[]) => {
        let written = 0; // Rows inserted or replaced, not the minutes already stored that were left as they were
        for (const bucket of buffer) {
          const candle = bucket.get(symbol);
          if (!candle) continue;
          const statement = getStatement(candle.synthetic ? conditions.synthetic : conditions.real);
          written += statement.run(candle.start, candle.open, candle.high, candle.low, candle.close, candle.volume).changes;
        }
        return written;
      });
      const written = insertCandles(this.buffer);
      debug('storage', `${written} ${symbol} ${pluralize('candle', written)} written in database`);
    } finally {
      for (const statement of statements.values()) statement.finalize();
    }
  }

  public createTable(symbol: TradingPair): void {
    const query = `
      CREATE TABLE IF NOT EXISTS
      ${this.getQuotedTable(symbol)} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start INTEGER UNIQUE,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL
      );
    `;
    this.db.run(query);
  }

  public getCandleDateranges(symbol: TradingPair) {
    const query = this.db.query<CandleDateranges, SQLQueryBindings[]>(`
      WITH gaps AS (
        SELECT start, start / ${ONE_MINUTE} - ROW_NUMBER() OVER (ORDER BY start) AS gap_group
        FROM ${this.getQuotedTable(symbol)}
    )
    SELECT MIN(start) AS daterange_start, MAX(start) AS daterange_end
    FROM gaps
    GROUP BY gap_group
    ORDER BY daterange_start;
  `);
    return query.all();
  }

  public getCandles(symbol: TradingPair, { start, end }: Interval<EpochTimeStamp, EpochTimeStamp>): Candle[] {
    const query = this.db.query<Candle, SQLQueryBindings[]>(`
      SELECT id,start,open,high,low,close,volume
      FROM ${this.getQuotedTable(symbol)}
      WHERE start BETWEEN $start AND $end AND start % ${ONE_MINUTE} = 0
      ORDER BY start ASC
    `);
    return query.all({ $start: start, $end: end });
  }

  /** The minutes of the interval with no candle. Its bounds must be starts of minutes, as the stored candles are. */
  public checkInterval(symbol: TradingPair, { start, end }: Interval<EpochTimeStamp, EpochTimeStamp>) {
    const query = this.db.query<MissingCandleCount, SQLQueryBindings[]>(`
      SELECT ($end - $start) / ${ONE_MINUTE} + 1 - COUNT(*) AS missingCandleCount
      FROM ${this.getQuotedTable(symbol)}
      WHERE start BETWEEN $start AND $end AND start % ${ONE_MINUTE} = 0
    `);
    return query.get({ $start: start, $end: end });
  }

  /**
   * Inserts the buffered candles and closes the connection, whatever the insert did. A failed insert leaves the buffered minutes of the
   * pairs it did not reach out of the database: SQLite's error alone did not say so, and the import whose last insert it was exited
   * with code 0. The error thrown counts those minutes per pair and gives their range, which an import writes again.
   * Only the first call does anything, a failed one included: the connection is closed, writing the buffer would mean opening the
   * database again only to wait out the same lock or meet the same full disk, and main() closes the storage again after CandleWriter,
   * where a second report of the same minutes would throw past the failure of the run.
   */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      // Without it, a crash or a stop outside the plugins (main()'s uncaughtException handler) would lose the buffered buckets
      this.flushBeforeClosing();
      // Copies the WAL into the database file and empties it, so that the file alone holds every candle (a copy, a backup)
      if (!this.readOnly) this.db.run('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
      this.db.close(false);
    }
  }

  /** flush(), whose failure names the buffered minutes it did not write: those of every pair it did not insert (see close) */
  private flushBeforeClosing() {
    const inserted = new Set<TradingPair>();
    try {
      this.flush(inserted);
    } catch (error) {
      const minuteCounts = new Map<TradingPair, number>();
      let first = Infinity;
      let last = -Infinity;
      for (const bucket of this.buffer) {
        for (const [symbol, { start }] of bucket) {
          if (inserted.has(symbol)) continue;
          minuteCounts.set(symbol, (minuteCounts.get(symbol) ?? 0) + 1);
          first = Math.min(first, start);
          last = Math.max(last, start);
        }
      }
      const counts = Array.from(minuteCounts, ([symbol, count]) => `${count} of ${symbol}`).join(', ');
      throw new GekkoError(
        'storage',
        `Could not write the buffered candles into ${resolve(this.database)} (${describeError(error)}): the minutes from ${toISOString(first)} to ${toISOString(last)} were not written, ${counts}. An import of that range writes them.`,
        { cause: error },
      );
    }
  }

  /**
   * Opens the database and reads its schema. bun:sqlite reads the file only for the first statement that needs it: a file that is not
   * a database (a CSV, another tool's file) or a truncated copy failed there, at the first query of a backtest or the switch to WAL of
   * the other modes, with SQLite's own error and its stack, without the path and the hint below.
   */
  private open(database: string) {
    let db: Database | undefined;
    try {
      if (this.readOnly) db = new Database(database, { readonly: true, create: false });
      else {
        if (database !== IN_MEMORY) mkdirSync(dirname(database), { recursive: true }); // db/ is gitignored: absent from a fresh clone
        db = new Database(database);
      }
      db.run('PRAGMA busy_timeout = 5000;'); // Wait instead of erroring when the DB is locked, from the read below on
      // Not PRAGMA schema_version, which a file cut within the 100 bytes of its header passes: it reads the schema version only
      db.run('SELECT count(*) FROM sqlite_master;');
      return db;
    } catch (error) {
      db?.close(false);
      const hint = this.readOnly ? ' A backtest reads an existing database: check storage.database, or import the candles first.' : '';
      // Kept as the cause, which main() appends to its report: only its message was kept, the error (its class, code and stack) dropped
      throw new GekkoError('storage', `Cannot open the database ${resolve(database)} (${describeError(error)}).${hint}`, { cause: error });
    }
  }

  /** Read-only, a missing table cannot be created: the pair was never imported into this database. */
  private checkTables(database: string, symbols: TradingPair[]) {
    const query = this.db.query<{ name: string }, [string, string]>(
      'SELECT name FROM sqlite_master WHERE type = ? AND name = ? COLLATE NOCASE',
    );
    const missingSymbols = symbols.filter(symbol => !query.get('table', this.getTable(symbol)));
    if (missingSymbols.length) {
      throw new GekkoError('storage', `${resolve(database)} holds no candles of ${missingSymbols.join(', ')}: import them first.`);
    }
  }

  /** Tickers can hold digits and punctuation (1INCH, USDC:USDC), so the name is always quoted, its own quotes doubled. */
  private getQuotedTable(symbol: TradingPair) {
    return `"${this.getTable(symbol).replaceAll('"', '""')}"`;
  }
}
