import { describeError } from '@errors/error.utils';
import { GekkoError } from '@errors/gekko.error';
import { Candle } from '@models/candle.types';
import { CandleBucket } from '@models/event.types';
import { TradingPair } from '@models/utility.types';
import { config } from '@services/configuration/configuration';
import { debug } from '@services/logger';
import { pluralize } from '@utils/string/string.utils';
import { Database, SQLQueryBindings, Statement } from 'bun:sqlite';
import { Interval } from 'date-fns';
import { each } from 'lodash-es';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Storage } from './storage';
import { CandleDateranges, MissingCandleCount } from './storage.types';

const IN_MEMORY = ':memory:';

export class SQLiteStorage extends Storage {
  db: Database;
  /**
   * A backtest only reads, so a mistyped path fails instead of creating an empty database. An in-memory database cannot be
   * opened read-only and starts empty anyway: it is read-write in every mode (only tests use it).
   */
  private readonly readOnly: boolean;
  /** CandleWriter closes the storage when it is finalised, and main() closes it again on its way out */
  private closed = false;

  constructor(symbols: TradingPair[]) {
    super();
    const database = config.getStorage()?.database;
    if (!database) throw new GekkoError('storage', 'No database to open: set storage.database to the path of the SQLite file.');
    this.readOnly = config.getWatch().mode === 'backtest' && database !== IN_MEMORY;
    this.db = this.open(database);
    this.db.run('PRAGMA busy_timeout = 5000;'); // Wait instead of erroring when the DB is locked
    if (this.readOnly) {
      this.checkTables(database, symbols);
    } else {
      this.db.run('PRAGMA journal_mode = WAL;');
      this.db.run('PRAGMA synchronous = NORMAL;');
      each(symbols, symbol => this.createTable(symbol));
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
        SELECT start, start / 60000 - ROW_NUMBER() OVER (ORDER BY start) AS gap_group
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
      WHERE start BETWEEN $start AND $end AND start % 60000 = 0
      ORDER BY start ASC
    `);
    return query.all({ $start: start, $end: end });
  }

  /** The minutes of the interval with no candle. Its bounds must be starts of minutes, as the stored candles are. */
  public checkInterval(symbol: TradingPair, { start, end }: Interval<EpochTimeStamp, EpochTimeStamp>) {
    const query = this.db.query<MissingCandleCount, SQLQueryBindings[]>(`
      SELECT ($end - $start) / 60000 + 1 - COUNT(*) AS missingCandleCount
      FROM ${this.getQuotedTable(symbol)}
      WHERE start BETWEEN $start AND $end AND start % 60000 = 0
    `);
    return query.get({ $start: start, $end: end });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      // Without it, a crash or a stop outside the plugins (main()'s uncaughtException handler) would lose the buffered buckets
      this.flush();
      // Copies the WAL into the database file and empties it, so that the file alone holds every candle (a copy, a backup)
      if (!this.readOnly) this.db.run('PRAGMA wal_checkpoint(TRUNCATE);');
    } finally {
      this.db.close(false);
    }
  }

  private open(database: string) {
    try {
      if (this.readOnly) return new Database(database, { readonly: true, create: false });
      if (database !== IN_MEMORY) mkdirSync(dirname(database), { recursive: true }); // db/ is gitignored: absent from a fresh clone
      return new Database(database);
    } catch (error) {
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
