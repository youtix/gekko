import {
  REALTIME_GRACE_PERIOD,
  REALTIME_MAX_CANDLES_PER_FETCH,
  REALTIME_MAX_TICKS_WITHOUT_CANDLE,
} from '@gekko/shared/constants/realtime.const';
import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { Candle } from '@gekko/shared/models/candle.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { Heart } from '../../heart/heart';
import { Exchange } from '@gekko/shared/models/exchange.types';
import { inject } from '../../../injecter/injecter';
import { debug, warning } from '../../../logger/logger';
import { startOfMinuteUTC, toISOString } from '@gekko/shared/utils/date/date.utils';
import { sortBy } from 'lodash-es';
import { Readable } from 'node:stream';

/**
 * Pushes the closed 1-minute candles of one pair, in order, from `startMinute` on (the minutes before it belong to the warmup
 * history). Its heart ticks a grace period after each minute boundary; each tick asks the exchange for every closed minute not
 * pushed yet, so that a minute whose fetch failed or came back empty is asked again on the next tick. It fails with a GekkoError
 * once REALTIME_MAX_TICKS_WITHOUT_CANDLE consecutive ticks have pushed nothing.
 *
 * `startMinute` comes from the pipeline, which reads the clock once for every pair and ends the warmup history the minute before.
 * Read by each stream as it is built, a start-up that crosses a minute boundary would start the pairs on different minutes and make
 * the live minutes overlap the history or leave a gap after it.
 */
export class RealtimeStream extends Readable {
  private readonly heart: Heart;
  private readonly exchange: Exchange;
  private readonly symbol: TradingPair;
  /** The start of the last minute pushed: until a candle is, the minute before `startMinute`, the last one of the warmup history */
  private lastPushedStart: EpochTimeStamp;
  private ticksWithoutCandle = 0;
  /** Set while a fetch is in flight: a tick meanwhile fetches nothing, so that every minute is pushed once and in order */
  private isFetching = false;

  constructor(symbol: TradingPair, startMinute: EpochTimeStamp) {
    super({ objectMode: true });
    this.symbol = symbol;
    this.exchange = inject.exchange();
    this.lastPushedStart = startMinute - ONE_MINUTE;
    this.heart = new Heart(ONE_MINUTE, { gracePeriod: REALTIME_GRACE_PERIOD });
    // The heart does not wait for its listeners: a failure would be an unhandled rejection
    this.heart.on('tick', () => this.onTick().catch((error: Error) => this.destroy(error)));
    this.heart.on('error', (error: Error) => this.destroy(error));
    this.heart.pump();
  }

  private async onTick() {
    // A minute counts as closed a grace period after its end, including on the first tick, which comes right after pump(). Floored
    // in UTC: in local time, the hour repeated when DST ends came back an hour early, and its 60 ticks fetched nothing.
    const lastClosedMinute = startOfMinuteUTC(Date.now() - REALTIME_GRACE_PERIOD) - ONE_MINUTE;
    if (lastClosedMinute <= this.lastPushedStart) return;
    // A fetch longer than a minute: this tick has nothing to add, the next one asks for every minute still missing
    if (this.isFetching) return this.countTickWithoutCandle(lastClosedMinute);

    this.isFetching = true;
    let pushedCount: number;
    try {
      pushedCount = await this.pushClosedCandles(lastClosedMinute);
    } finally {
      this.isFetching = false;
    }

    if (this.destroyed) return;
    if (pushedCount) this.ticksWithoutCandle = 0;
    else this.countTickWithoutCandle(lastClosedMinute);
  }

  /** Fetches the closed minutes after the last one pushed and pushes them in order. Returns how many were pushed. */
  private async pushClosedCandles(lastClosedMinute: EpochTimeStamp) {
    const from = this.lastPushedStart + ONE_MINUTE;
    const limit = Math.min((lastClosedMinute - this.lastPushedStart) / ONE_MINUTE, REALTIME_MAX_CANDLES_PER_FETCH);

    let candles: Candle[];
    try {
      candles = await this.exchange.fetchOHLCV(this.symbol, { from, limit });
    } catch (error) {
      if (!this.destroyed) {
        warning(
          'stream',
          `Failed to fetch the 1m candles of ${this.symbol} from ${toISOString(from)}, retrying on the next tick: ${describeError(error)}`,
        );
      }
      return 0;
    }
    if (this.destroyed) return 0;

    let pushedCount = 0;
    for (const candle of sortBy(candles, 'start')) {
      if (candle.start <= this.lastPushedStart) {
        warning('stream', `Ignored a duplicate 1m candle of ${this.symbol} @ ${toISOString(candle.start)}: already delivered`);
      } else if (candle.start > lastClosedMinute) {
        // The minute in progress, served when the exchange has none of the minutes asked for: it is not closed yet
        debug('stream', `Ignored the unfinished 1m candle of ${this.symbol} @ ${toISOString(candle.start)}`);
      } else {
        this.pushCandle(candle);
        pushedCount++;
      }
    }
    if (!pushedCount) warning('stream', `Received undefined candle for ${this.symbol} @ ${toISOString(from)}`);
    return pushedCount;
  }

  private pushCandle(candle: Candle) {
    debug(
      'stream',
      [
        `1m candle from ${this.exchange.getExchangeName()} for ${this.symbol} @ ${toISOString(candle.start)} `,
        `O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close} V:${candle.volume}`,
      ].join(' '),
    );
    this.lastPushedStart = candle.start;
    this.push({ symbol: this.symbol, candle });
  }

  private countTickWithoutCandle(lastClosedMinute: EpochTimeStamp) {
    this.ticksWithoutCandle++;
    if (this.ticksWithoutCandle < REALTIME_MAX_TICKS_WITHOUT_CANDLE) return;
    const missingMinutes = (lastClosedMinute - this.lastPushedStart) / ONE_MINUTE;
    this.destroy(
      new GekkoError(
        'stream',
        `No 1m candle received for ${this.symbol} for ${missingMinutes} minutes (last one @ ${toISOString(this.lastPushedStart)}): the pair no longer delivers.`,
      ),
    );
  }

  _read(): void {
    // Data is pushed from the heart's ticks
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    try {
      this.heart.stop();
    } finally {
      callback(error);
    }
  }
}
