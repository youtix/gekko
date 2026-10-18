import { TradingPair } from '@models/utility.types';
import { config } from '@services/configuration/configuration';
import { inject } from '@services/injecter/injecter';
import { debug, info } from '@services/logger';
import { Storage } from '@services/storage/storage';
import { splitIntervals, toISOString } from '@utils/date/date.utils';
import { differenceInMinutes, Interval } from 'date-fns';
import { Readable } from 'node:stream';
import { MissingCandlesError } from './backtest.error';
import { BacktestStreamParams } from './backtest.types';

/** Reads the stored 1-minute candles of one pair, one batch of `watch.batchSize` minutes per read */
export class BacktestStream extends Readable {
  private storage: Storage;
  private dateranges: Interval<EpochTimeStamp, EpochTimeStamp>[];
  private iteration: number;
  private symbol: TradingPair;

  constructor({ daterange, symbol }: BacktestStreamParams) {
    super({ objectMode: true });
    this.storage = inject.storage();
    const { batchSize } = config.getWatch();
    const strategy = config.getStrategy();
    this.dateranges = splitIntervals(daterange.start, daterange.end, batchSize ?? 1440);
    this.iteration = 0;
    this.symbol = symbol;

    info(
      'stream',
      [
        `Launching backtest on ${symbol}`,
        `from ${toISOString(daterange.start)} -> to ${toISOString(daterange.end)}`,
        `using ${strategy?.name} strategy`,
      ].join(' '),
    );
  }

  public _read(_size: number): void {
    const daterange = this.dateranges[this.iteration++];
    if (!daterange) {
      this.push(null);
      return;
    }

    debug('stream', `Reading database data from ${toISOString(daterange.start)} -> to ${toISOString(daterange.end)}`);
    const candles = this.storage.getCandles(this.symbol, daterange);
    const expected = differenceInMinutes(daterange.end, daterange.start) + 1;
    // The date range was checked before the backtest started, so a short batch means the database changed since then
    if (candles.length !== expected) {
      const availableDateranges = this.storage.getCandleDateranges(this.symbol);
      this.destroy(new MissingCandlesError(this.symbol, daterange, availableDateranges, { expected, received: candles.length }));
      return;
    }
    for (const candle of candles) this.push({ symbol: this.symbol, candle });
  }
}
