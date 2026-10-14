import { Candle } from '@models/candle.types';
import { CandleBucket } from '@models/event.types';
import { Nullable, TradingPair } from '@models/utility.types';
import { config } from '@services/configuration/configuration';
import { Interval } from 'date-fns';
import { toUpper } from 'lodash-es';
import { INSERT_THRESHOLD } from './storage.const';
import { CandleDateranges, MissingCandleCount } from './storage.types';

export abstract class Storage {
  protected buffer: CandleBucket[];
  protected insertThreshold: number;
  /**
   * Whether the real candles written have the last word over the stored ones: in an import, which reads the exchange's history.
   * SQLiteStorage.insertCandles states what each written candle replaces.
   */
  protected readonly hasLastWord: boolean;

  constructor() {
    const { mode } = config.getWatch();
    this.buffer = [];
    // Realtime writes each minute as it closes; the importer batches its inserts
    this.insertThreshold = config.getStorage()?.insertThreshold ?? (mode === 'realtime' ? 1 : INSERT_THRESHOLD);
    this.hasLastWord = mode === 'importer';
  }

  public addBucket(bucket: CandleBucket) {
    this.buffer.push(bucket);
    if (this.buffer.length >= this.insertThreshold) this.flush();
  }

  /**
   * Inserts the candles of every pair the buffer holds, not only the pairs of its last bucket, then empties it. The pairs are inserted
   * one after the other: an insert that fails stops the flush and keeps the whole buffer, the pairs inserted before it included, which
   * the next flush writes again, to the same rows. `inserted` collects those, for close() to tell what a failure left out.
   */
  protected flush(inserted = new Set<TradingPair>()) {
    const symbols = new Set<TradingPair>();
    for (const bucket of this.buffer) for (const symbol of bucket.keys()) symbols.add(symbol);
    for (const symbol of symbols) {
      this.insertCandles(symbol);
      inserted.add(symbol);
    }
    this.buffer = [];
  }

  protected getTable(symbol: TradingPair) {
    const [asset, currency] = symbol.split('/');
    // Not upperCase: it splits words with spaces (1INCH becomes '1 INCH'). Letter-only tickers keep the names they always had.
    return `CANDLES_${toUpper(asset)}_${toUpper(currency)}`;
  }

  public abstract insertCandles(symbol: TradingPair): void;
  public abstract createTable(symbol: TradingPair): void;
  public abstract getCandleDateranges(symbol: TradingPair): Nullable<CandleDateranges[]>;
  public abstract getCandles(symbol: TradingPair, interval: Interval<EpochTimeStamp, EpochTimeStamp>): Candle[];
  public abstract checkInterval(symbol: TradingPair, interval: Interval<EpochTimeStamp, EpochTimeStamp>): Nullable<MissingCandleCount>;
  /**
   * Inserts the buffered candles, then closes the connection, whatever the insert did: a failed insert throws an error that says which
   * minutes it left out of the database. Only the first call does anything.
   */
  public abstract close(): void;
}
