import { ONE_MINUTE } from '@constants/time.const';
import { Candle } from '@models/candle.types';
import { TradingPair } from '@models/utility.types';
import { EMPTY_FIRST_PAGE_RETRIES } from '@services/core/stream/historicalCandle/historicalCandle.const';
import { HistoricalCandleError } from '@services/core/stream/historicalCandle/historicalCandle.error';
import { Exchange } from '@services/exchange/exchange.types';
import { inject } from '@services/injecter/injecter';
import { info, warning } from '@services/logger';
import { startOfMinuteUTC, toISOString } from '@utils/date/date.utils';
import { pluralize } from '@utils/string/string.utils';
import { formatDuration, Interval, intervalToDuration, isAfter } from 'date-fns';
import { last } from 'lodash-es';
import { Readable } from 'stream';

export interface HistoricalCandleStreamParams {
  daterange: Interval<EpochTimeStamp, EpochTimeStamp>;
  /** Minimum delay in ms between the starts of two requests to the exchange */
  tickrate: number;
  symbol: TradingPair;
}

/**
 * Reads the 1-minute candles of one pair from the exchange, page by page, from `daterange.start` to `daterange.end` (both
 * inclusive). The stream is pulled: the next page is requested only once the consumer has taken the current one.
 */
export class HistoricalCandleStream extends Readable {
  private readonly symbol: TradingPair;
  private readonly tickrate: number;
  private readonly exchange: Exchange;
  private readonly initialStartDate: EpochTimeStamp;
  private readonly endDate: EpochTimeStamp;
  private readonly isEmptyRange: boolean;
  /** `from` of the next request */
  private nextFrom: EpochTimeStamp;
  /** Candles of the last page fetched, pushed from `cursor` on */
  private page: Candle[];
  private cursor: number;
  private isLastPage: boolean;
  private isFetching: boolean;
  private fetchTimer?: ReturnType<typeof setTimeout>;
  private lastFetchAt?: EpochTimeStamp;
  private emptyFirstPages: number;
  private pushedCandles: number;
  private lastProgressLog: number;

  constructor({ daterange, tickrate, symbol }: HistoricalCandleStreamParams) {
    super({ objectMode: true });
    this.symbol = symbol;
    this.tickrate = tickrate;
    this.exchange = inject.exchange();
    this.initialStartDate = startOfMinuteUTC(daterange.start);
    this.endDate = startOfMinuteUTC(daterange.end);
    this.nextFrom = this.initialStartDate;
    this.page = [];
    this.cursor = 0;
    this.isFetching = false;
    this.emptyFirstPages = 0;
    this.pushedCandles = 0;
    this.lastProgressLog = 0;
    // Both bounds are inclusive: equal dates are a one-minute range. An empty range ends at the first read.
    this.isEmptyRange = isAfter(this.initialStartDate, this.endDate);
    this.isLastPage = this.isEmptyRange;

    if (this.isEmptyRange) info('stream', `[${symbol}] No historical data to download`);
    else
      info(
        'stream',
        [
          `[${symbol}] Fetching historical data from ${toISOString(this.initialStartDate)}`,
          `to ${toISOString(this.endDate)}`,
          `(${formatDuration(intervalToDuration({ start: this.initialStartDate, end: this.endDate + ONE_MINUTE }))})`,
        ].join(' '),
      );
  }

  _read(): void {
    if (this.pushPage()) this.scheduleFetch();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.fetchTimer);
    this.fetchTimer = undefined;
    callback(error);
  }

  /** Pushes the rest of the current page while the consumer asks for more. Returns true when it wants the next page. */
  private pushPage(): boolean {
    // A plain loop rather than lodash `each`, which stops as soon as its callback returns false
    while (this.cursor < this.page.length) {
      const candle = this.page[this.cursor++];
      this.pushedCandles++;
      this.logProgress(candle.start);
      if (!this.push({ symbol: this.symbol, candle })) return false;
    }
    if (!this.isLastPage) return true;
    this.finish();
    return false;
  }

  /** Requests the next page, at the earliest `tickrate` ms after the previous request started */
  private scheduleFetch(): void {
    if (this.isFetching || this.fetchTimer || this.destroyed) return;
    const delay = this.lastFetchAt === undefined ? 0 : this.lastFetchAt + this.tickrate - Date.now();
    if (delay <= 0) {
      void this.fetchPage();
      return;
    }
    this.fetchTimer = setTimeout(() => {
      this.fetchTimer = undefined;
      void this.fetchPage();
    }, delay);
  }

  private async fetchPage(): Promise<void> {
    this.isFetching = true;
    this.lastFetchAt = Date.now();
    let candles: Candle[];
    try {
      candles = await this.exchange.fetchOHLCV(this.symbol, { from: this.nextFrom });
    } catch (error) {
      this.destroy(error as Error);
      return;
    } finally {
      this.isFetching = false;
    }
    if (this.destroyed) return;
    if (candles.length) this.onPage(candles);
    else this.onEmptyPage();
  }

  private onPage(candles: Candle[]): void {
    const lastStart = last(candles)!.start;
    this.nextFrom = lastStart + 1;
    this.isLastPage = lastStart >= this.endDate;
    // The exchange also serves the minutes after the range, up to the one in progress
    this.page = this.isLastPage ? candles.filter(({ start }) => start <= this.endDate) : candles;
    this.cursor = 0;
    if (this.pushPage()) this.scheduleFetch();
  }

  private onEmptyPage(): void {
    // Nothing between `from` and now after some progress: the pair stopped trading (suspended, delisted) or the exchange lags
    if (this.nextFrom > this.initialStartDate) {
      warning(
        'stream',
        [
          `[${this.symbol}] The exchange returned no candle after ${toISOString(this.nextFrom - 1)}, the last minute received,`,
          `although the range ends at ${toISOString(this.endDate)}: ending the history of this pair early.`,
        ].join(' '),
      );
      this.finish();
      return;
    }
    if (this.emptyFirstPages++ < EMPTY_FIRST_PAGE_RETRIES) {
      this.scheduleFetch();
      return;
    }
    this.destroy(new HistoricalCandleError(this.symbol, { start: this.nextFrom, end: this.endDate }, this.emptyFirstPages));
  }

  private finish(): void {
    if (!this.isEmptyRange) info('stream', `[${this.symbol}] Fetched ${this.pushedCandles} ${pluralize('candle', this.pushedCandles)}`);
    this.push(null);
  }

  private logProgress(candleStart: EpochTimeStamp): void {
    const totalDuration = this.endDate - this.initialStartDate;
    const progress = totalDuration > 0 ? Math.floor(((candleStart - this.initialStartDate) / totalDuration) * 100) : 100;
    // Log progress every 1%
    if (progress < this.lastProgressLog + 1) return;
    this.lastProgressLog = progress;
    info('stream', `[${this.symbol}] Importing: ${progress}% (${toISOString(candleStart)})`);
  }
}
