import { ONE_MINUTE } from '@constants/time.const';
import { GekkoError } from '@errors/gekko.error';
import { Candle } from '@models/candle.types';
import { TradingPair } from '@models/utility.types';
import { EMPTY_FIRST_PAGE_RETRIES } from '@services/core/stream/historicalCandle/historicalCandle.const';
import { HistoricalCandleError } from '@services/core/stream/historicalCandle/historicalCandle.error';
import { MAX_GAP_FILL_MINUTES } from '@services/core/stream/validation/fillCandleGap.const';
import { Exchange } from '@services/exchange/exchange.types';
import { inject } from '@services/injecter/injecter';
import { info, warning } from '@services/logger';
import { formatDurationUTC, startOfMinuteUTC, toISOString } from '@utils/date/date.utils';
import { pluralize } from '@utils/string/string.utils';
import { isAfter } from 'date-fns';
import { last, minBy } from 'lodash-es';
import { Readable } from 'stream';
import { HistoricalCandleStreamParams } from './historicalCandle.types';

/**
 * Reads the 1-minute candles of one pair from the exchange, page by page, from `daterange.start` to `daterange.end` (both
 * inclusive). The stream is pulled: the next page is requested only once the consumer has taken the current one. It fails on a gap
 * in the history longer than the gap filler fills (MAX_GAP_FILL_MINUTES), and warns when the history starts after the range does or
 * ends before it does.
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
  /** The start of the latest candle of the range received so far, to measure the gap before the next one */
  private lastCandleStart?: EpochTimeStamp;

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
          // On the UTC calendar: on the host's, a range across a change of daylight saving time read an hour off ("30 days 23 hours")
          `(${formatDurationUTC(this.initialStartDate, this.endDate + ONE_MINUTE)})`,
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
    if (!this.checkGaps(candles)) return;
    // The exchange also serves the minutes after the range, up to the one in progress
    this.page = this.isLastPage ? candles.filter(({ start }) => start <= this.endDate) : candles;
    this.cursor = 0;
    if (this.pushPage()) this.scheduleFetch();
  }

  /**
   * Checks the minutes of the range the page skips. A gap between two candles longer than the gap filler fills fails the stream
   * at once: downstream, the gap of one pair among several shows only minute after minute, and the filler would make up a week of
   * flat candles, which an import stores, before refusing it. On the last page, the minutes between the last candle of the range
   * and its end, which the exchange skipped although it has later candles, used to be dropped without a word: they are warned
   * about, as the minutes before the first candle are on the first page (see checkStart). Returns false once the stream is destroyed.
   */
  private checkGaps(candles: Candle[]): boolean {
    if (this.lastCandleStart === undefined) this.checkStart(minBy(candles, 'start')!.start);
    let previousStart = this.lastCandleStart;
    let nextStart: EpochTimeStamp | undefined;
    for (const { start } of candles) {
      if (start > this.endDate) {
        nextStart = Math.min(nextStart ?? start, start);
        continue;
      }
      if (previousStart !== undefined && start - previousStart > (MAX_GAP_FILL_MINUTES + 1) * ONE_MINUTE) {
        const minutes = (start - previousStart) / ONE_MINUTE - 1;
        this.destroy(
          new GekkoError(
            'stream',
            [
              `The exchange has no ${this.symbol} candle from ${toISOString(previousStart + ONE_MINUTE)} to ${toISOString(start - ONE_MINUTE)}`,
              `(${minutes} minutes): refusing to fill more than ${MAX_GAP_FILL_MINUTES} minutes with empty candles.`,
            ].join(' '),
          ),
        );
        return false;
      }
      previousStart = Math.max(previousStart ?? start, start);
    }
    this.lastCandleStart = previousStart;

    // No candle of the range at all: the first one came after it, which checkStart has warned about
    if (this.isLastPage && nextStart !== undefined && previousStart !== undefined && previousStart < this.endDate) {
      const from = previousStart + ONE_MINUTE;
      warning(
        'stream',
        [
          `[${this.symbol}] The exchange has no candle from ${toISOString(from)} to ${toISOString(this.endDate)}, the end of the range,`,
          `its next one being at ${toISOString(nextStart)}: ${this.describeEarlyEnd(from)}`,
        ].join(' '),
      );
    }
    return true;
  }

  /**
   * Warns when the first candle the exchange has from the start of the range on, `first`, comes after it: a pair listed during the
   * range, or after it. Nothing compared that candle with the start of the range: an import of such a pair ended without its first
   * minutes and without a word, and a backtest of the range was then refused for want of them. They stay missing: the gap filler
   * fills a pair from its last candle, which it has none of before this one. A first candle after the whole range was warned about
   * as the end of a history it never started.
   */
  private checkStart(first: EpochTimeStamp): void {
    if (first <= this.initialStartDate) return;
    const isAfterRange = first > this.endDate;
    const lastMissing = isAfterRange ? this.endDate : first - ONE_MINUTE;
    const minutes = (lastMissing - this.initialStartDate) / ONE_MINUTE + 1;
    const missing = `${minutes} ${pluralize('minute', minutes)}`;
    warning(
      'stream',
      [
        `[${this.symbol}] The exchange has no candle from ${toISOString(this.initialStartDate)}, the start of the range,`,
        `to ${toISOString(lastMissing)}${isAfterRange ? ', the end of the range' : ''}, its first one being at ${toISOString(first)}:`,
        isAfterRange
          ? `starting the history of this pair after the range, without any of its ${missing}.`
          : `starting the history of this pair late, without its first ${missing}.`,
      ].join(' '),
    );
  }

  private onEmptyPage(): void {
    // Nothing between `from` and now after some progress: the pair stopped trading (suspended, delisted) or the exchange lags
    if (this.nextFrom > this.initialStartDate) {
      warning(
        'stream',
        [
          `[${this.symbol}] The exchange returned no candle after ${toISOString(this.nextFrom - 1)}, the last minute received,`,
          `although the range ends at ${toISOString(this.endDate)}: ${this.describeEarlyEnd(this.nextFrom - 1 + ONE_MINUTE)}`,
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

  /**
   * What an early end leaves out of the history: the minutes from `firstMissing` to the end of the range. A multi-pair import used to
   * fill them with flat candles while the other pairs went on, against what this line said; they stay missing now, as they do when
   * the pair is imported alone, and the realtime gap filler fills them until the pair's live candles start, saying so.
   */
  private describeEarlyEnd(firstMissing: EpochTimeStamp): string {
    const minutes = (this.endDate - firstMissing) / ONE_MINUTE + 1;
    return `ending the history of this pair early, without its last ${minutes} ${pluralize('minute', minutes)}.`;
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
