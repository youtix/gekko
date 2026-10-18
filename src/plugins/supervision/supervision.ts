import { ONE_MINUTE, ONE_SECOND } from '@constants/time.const';
import { TIMEFRAME_TO_MINUTES } from '@constants/timeframe.const';
import { describeError } from '@errors/error.helper';
import { Candle } from '@models/candle.types';
import { CandleBucket } from '@models/event.types';
import { TradingPair } from '@models/utility.types';
import { Plugin } from '@plugins/plugin';
import { LAST_FLUSH_TIMEOUT } from '@services/bots/telegram/telegram.const';
import { TelegramBot } from '@services/bots/telegram/TelegramBot';
import { FastCandleBatcher } from '@services/core/batcher/candleBatcher/fastCandleBatcher';
import { LIMITS } from '@services/exchange/exchange.const';
import { debug, getBufferedLogs, warning } from '@services/logger';
import { BufferedLog } from '@services/logger.types';
import { toISOString } from '@utils/date/date.utils';
import { shallowObjectDiff } from '@utils/object/object.utils';
import { pluralize } from '@utils/string/string.utils';
import { filter, isEmpty } from 'lodash-es';
import { NATIVE_TIMEFRAMES, STOPPING_ANSWER } from './supervision.const';
import { supervisionSchema } from './supervision.schema';
import { Subscription, SUBSCRIPTION_NAMES, SupervisionConfig, ThresholdCheck } from './supervision.types';

export class Supervision extends Plugin {
  private bot: TelegramBot;
  private subscriptions = new Set<Subscription>();
  private cpuThreshold: number;
  private memoryThreshold: number;
  private cpuIntervalTime: number;
  private memoryIntervalTime: number;
  private cpuInterval?: Timer;
  private memoryInterval?: Timer;
  private logMonitorInterval?: Timer;
  /** The CPU time used and the time at the last CPU sample, which the next one measures from. Reset when the CPU check starts. */
  private lastCpuUsage = process.cpuUsage();
  private lastCpuCheck = Date.now();
  /** The threshold checks whose alert is being sent: each sends one at a time */
  private alertsInFlight = new Set<ThresholdCheck>();
  /** Whether the candle check has said why it skips the timeframe, which it says once */
  private isCandleCheckSkipLogged = false;
  /** The check of the last bucket of timeframe candles, while it is in flight. It never rejects. */
  private candleCheckInFlight?: Promise<unknown>;
  /**
   * Whether processFinalize has started. close() does not abort the long poll in flight, which can still deliver a command then: a
   * subscription would start timers that nothing stops any more (and a log batch alongside the last flush), so handleCommand takes
   * none.
   */
  private isFinalized = false;
  private logMonitorIntervalTime: number;
  /**
   * The last buffered log already checked: the next batch is made of the warnings and errors buffered after it. Kept as the
   * entry itself, since a timestamp would skip the logs of its millisecond. Undefined when the buffer was empty.
   */
  private lastCheckedLog?: BufferedLog;
  /** The batch the log monitoring is sending, if any. It never rejects. */
  private logBatchInFlight?: Promise<void>;
  /** How often the candle check looks at the age of the last 1-minute bucket (see checkCandleFreshness) */
  private candleCheckIntervalTime: number;
  /** The age of the last 1-minute bucket beyond which the candle check reports that the candles stopped coming */
  private candleStaleThreshold: number;
  private candleCheckInterval?: Timer;
  /** When the last 1-minute bucket was received, or when the candle check started if none had been by then */
  private lastBucketReceivedAt?: EpochTimeStamp;
  /** Whether Telegram has taken the alert that the candles stopped, and not since the message that they are coming again */
  private candlesReportedStale = false;
  /** The candle alert being sent, if any (see checkCandleFreshness). It never rejects. */
  private candleAlertInFlight?: Promise<void>;

  constructor({
    name,
    token,
    botUsername,
    chatId,
    cpuThreshold,
    memoryThreshold,
    cpuCheckInterval,
    memoryCheckInterval,
    logMonitoringInterval,
    candleCheckInterval,
    candleStaleThreshold,
  }: SupervisionConfig) {
    super(name);
    this.bot = new TelegramBot(token, botUsername, this.handleCommand.bind(this), chatId);
    this.cpuThreshold = cpuThreshold;
    this.memoryThreshold = memoryThreshold;
    this.cpuIntervalTime = cpuCheckInterval;
    this.memoryIntervalTime = memoryCheckInterval;
    this.logMonitorIntervalTime = logMonitoringInterval;
    this.candleCheckIntervalTime = candleCheckInterval;
    this.candleStaleThreshold = candleStaleThreshold;
  }

  private handleCommand(command: string): string {
    switch (command) {
      case '/help':
        return [
          'healthcheck - Check if gekko is up',
          'sub_cpu_check - Check CPU usage',
          'sub_memory_check - Check memory usage',
          'sub_candle_check - Check timeframe candle calculations and that 1m candles keep coming',
          'sub_monitor_log - Monitor log application',
          'subscribe_all - Subscribe to all notifications',
          'unsubscribe_all - Unsubscribe from all notifications',
          'subscriptions - View current subscriptions',
          'help - Show help information',
        ].join('\n');
      case '/healthcheck':
        return this.isRunning() ? '✅ Gekko is running' : '❌ Gekko is not running';
      case '/subscribe_all':
        if (this.isFinalized) return STOPPING_ANSWER;
        SUBSCRIPTION_NAMES.forEach(s => this.toggleSubscription(s, true));
        return 'Subscribed to all monitoring';
      case '/unsubscribe_all':
        SUBSCRIPTION_NAMES.forEach(s => this.toggleSubscription(s, false));
        return 'Unsubscribed from all monitoring';
      case '/subscriptions':
        return this.subscriptions.size ? [...this.subscriptions].join('\n') : 'No subscriptions';
      default:
        if (command.startsWith('/sub_')) {
          const subscription = command.replace('/sub_', '') as Subscription;
          if (!SUBSCRIPTION_NAMES.includes(subscription)) return 'Unknown command';
          const isSubscribed = this.subscriptions.has(subscription);
          if (!isSubscribed && this.isFinalized) return STOPPING_ANSWER;
          this.toggleSubscription(subscription, !isSubscribed);
          return isSubscribed ? `Unsubscribed from ${subscription}` : `Subscribed to ${subscription}`;
        }
        return 'Unknown command';
    }
  }

  private toggleSubscription(subscription: Subscription, subscribe: boolean) {
    if (subscribe) {
      this.subscriptions.add(subscription);
      this.startMonitoring(subscription);
    } else {
      this.subscriptions.delete(subscription);
      this.stopMonitoring(subscription);
    }
  }

  private startMonitoring(subscription: Subscription) {
    switch (subscription) {
      case 'cpu_check':
        this.launchCpuCheck();
        break;
      case 'memory_check':
        this.launchMemoryCheck();
        break;
      case 'candle_check':
        this.launchTimeframeCandleCheck();
        break;
      case 'monitor_log':
        this.startLogMonitoring();
        break;
    }
  }

  private stopMonitoring(subscription: Subscription) {
    switch (subscription) {
      case 'cpu_check':
        this.stopCpuCheck();
        break;
      case 'memory_check':
        this.stopMemoryCheck();
        break;
      case 'candle_check':
        this.stopTimeframeCandleCheck();
        break;
      case 'monitor_log':
        this.stopLogMonitoring();
        break;
    }
  }

  private isRunning(): boolean {
    return process.uptime() > 0;
  }

  private launchCpuCheck() {
    if (this.cpuInterval) return;
    debug('supervision', 'Starting CPU monitoring');
    // A fresh baseline, so that the first sample measures the first interval only: from start-up, or from the last sample of an
    // earlier subscription, it would average the usage over all that time, and a spike after hours of quiet would not alert
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuCheck = Date.now();
    this.cpuInterval = setInterval(async () => {
      const usage = this.getCpuUsage();
      if (usage > this.cpuThreshold) await this.sendAlert('CPU', `⚠️ CPU usage exceeded: ${usage.toFixed(2)}%`);
    }, this.cpuIntervalTime);
  }

  private stopCpuCheck() {
    if (!this.cpuInterval) return;
    clearInterval(this.cpuInterval);
    this.cpuInterval = undefined;
    debug('supervision', 'Stopped CPU monitoring');
  }

  private launchMemoryCheck() {
    if (this.memoryInterval) return;
    debug('supervision', 'Starting Memory monitoring');
    this.memoryInterval = setInterval(async () => {
      const usage = this.getMemoryUsage();
      if (usage > this.memoryThreshold) await this.sendAlert('Memory', `⚠️ Memory usage exceeded: ${usage.toFixed(2)} MB`);
    }, this.memoryIntervalTime);
  }

  private stopMemoryCheck() {
    if (!this.memoryInterval) return;
    clearInterval(this.memoryInterval);
    this.memoryInterval = undefined;
    debug('supervision', 'Stopped Memory monitoring');
  }

  /**
   * Sends the alert of a threshold check, one at a time: an alert due while the previous one of its check is still in flight
   * (Telegram slow to answer, the fetcher retrying) is skipped rather than queued behind it. It never rejects: nothing awaits the
   * interval callbacks that call it, so a failure (Telegram down) would be an unhandled rejection, which makes the run exit 1. It
   * is logged as a warning instead.
   */
  private async sendAlert(check: ThresholdCheck, message: string) {
    if (this.alertsInFlight.has(check)) return debug('supervision', `${check} alert skipped: the previous one is still in flight`);
    this.alertsInFlight.add(check);
    try {
      await this.bot.sendMessage(message);
    } catch (err) {
      warning('supervision', `${check} alert not sent: ${describeError(err)}`);
    } finally {
      this.alertsInFlight.delete(check);
    }
  }

  private launchTimeframeCandleCheck() {
    if (this.candleCheckInterval) return;
    debug('supervision', 'Starting Timeframe Candle monitoring');
    // Counted from the subscription when no bucket came yet: a stall is measured from the last candle, or from here
    this.lastBucketReceivedAt ??= Date.now();
    this.candleCheckInterval = setInterval(() => this.checkCandleFreshness(), this.candleCheckIntervalTime);
  }

  private stopTimeframeCandleCheck() {
    if (!this.candleCheckInterval) return;
    clearInterval(this.candleCheckInterval);
    this.candleCheckInterval = undefined;
    this.candlesReportedStale = false;
    debug('supervision', 'Stopped Timeframe Candle monitoring');
  }

  /**
   * The strategy, the trailing stops and the circuit breaker only run on candles: when they stop coming (the exchange, the network,
   * or a stream that stalled), nothing else tells. One alert when they stop, one message when they come back. A check is skipped
   * while an alert is in flight (Telegram slow to answer, the fetcher retrying), so that they go out one at a time and in order:
   * the check after it sends what has changed meanwhile, if anything has.
   */
  private checkCandleFreshness() {
    if (this.candleAlertInFlight) return debug('supervision', 'Candle freshness check skipped: the previous alert is still in flight');
    const lastBucketReceivedAt = this.lastBucketReceivedAt!; // Set when the check started, at the latest
    const age = Date.now() - lastBucketReceivedAt;
    const isStale = age > this.candleStaleThreshold;
    if (isStale === this.candlesReportedStale) return;
    const minutes = Math.floor(age / ONE_MINUTE);
    const message = isStale
      ? `⚠️ No 1m candle received for ${minutes} ${pluralize('minute', minutes)}, last one @ ${toISOString(lastBucketReceivedAt)}`
      : `✅ 1m candles are coming again, last one @ ${toISOString(lastBucketReceivedAt)}`;
    this.candleAlertInFlight = this.sendCandleAlert(message, isStale).finally(() => {
      this.candleAlertInFlight = undefined;
    });
  }

  /**
   * Sends a candle alert, and records what it reports once Telegram has taken it: an alert it fails to take is sent again at the
   * next check, with the age of then. It never rejects: nothing awaits the interval callback that calls it, so a failure would be
   * an unhandled rejection, which makes the run exit 1. It is logged as a warning instead.
   */
  private async sendCandleAlert(message: string, isStale: boolean) {
    try {
      await this.bot.sendMessage(message);
      this.candlesReportedStale = isStale;
    } catch (err) {
      warning('supervision', `Candle alert not sent, sent again at the next check: ${describeError(err)}`);
    }
  }

  private startLogMonitoring() {
    if (this.logMonitorInterval) return;
    debug('supervision', 'Starting Log monitoring');
    // Only what is logged from now on
    this.lastCheckedLog = getBufferedLogs().at(-1);
    this.logMonitorInterval = setInterval(() => this.sendNewLogsInBackground(), this.logMonitorIntervalTime);
  }

  /**
   * A batch nobody waits for: the periodic ones. Skipped while one is in flight, whose logs are not marked as checked yet and
   * would go out twice. A failure is logged rather than thrown, which would make it an unhandled rejection, and at debug level:
   * a warning or an error would join the next batch, which already holds the logs that failed to go out.
   */
  private sendNewLogsInBackground() {
    if (this.logBatchInFlight) return debug('supervision', 'Log batch skipped: another one is in flight');
    this.logBatchInFlight = this.sendNewLogs()
      .catch(err => debug('supervision', `Logs not sent, retried with the next batch: ${describeError(err)}`))
      .finally(() => {
        this.logBatchInFlight = undefined;
      });
  }

  /**
   * Sends the warnings and errors logged since the last batch. It first lets the batch in flight, if any, settle: the last flush
   * can start while one is, and its logs are not marked as checked until then. They are only once Telegram has taken them: when
   * it fails, this rejects and the next batch sends them again, in part twice if the first parts of a long batch had gone out.
   */
  private async sendNewLogs() {
    await this.logBatchInFlight;
    const lastCheckedLog = this.lastCheckedLog;
    const buffered = getBufferedLogs();
    // Looked up by identity. When it is missing (evicted from the ring buffer, which drops the oldest logs first, or the buffer
    // was empty), every buffered log came after it.
    const logs = buffered.slice(buffered.findLastIndex(l => l === lastCheckedLog) + 1).filter(l => ['warn', 'error'].includes(l.level));
    if (logs.length) {
      const message = logs.map(l => `• ${toISOString(l.timestamp)} [${l.level.toUpperCase()}] (${l.tag})\n${l.message}`).join('---\n');
      await this.bot.sendMessage(message);
    }
    // Unless a subscription made meanwhile has moved it, to skip what was logged before it
    if (this.lastCheckedLog === lastCheckedLog) this.lastCheckedLog = buffered.at(-1);
  }

  private stopLogMonitoring() {
    if (!this.logMonitorInterval) return;
    clearInterval(this.logMonitorInterval);
    this.logMonitorInterval = undefined;
    debug('supervision', 'Stopped Log monitoring');
  }

  /** Reports to Telegram how the timeframe candle of a pair differs from the exchange's. It never rejects: a failure is logged. */
  private async checkTimeframeCandle(symbol: TradingPair, candle: Candle) {
    const candleName = `${symbol} ${this.timeframe} candle starting at ${toISOString(candle.start)}`;
    try {
      const exchangeCandle = await this.fetchExchangeTimeframeCandle(symbol, candle.start);
      if (!exchangeCandle) return debug('supervision', `No exchange candle to compare with the ${candleName}`);
      const diff = shallowObjectDiff(exchangeCandle, candle);
      if (isEmpty(diff)) return;
      const fields = Object.keys(diff).map(key => `${key}: ${exchangeCandle[key as keyof Candle]} | ${candle[key as keyof Candle]}`);
      await this.bot.sendMessage([`⚠️ Timeframe candle mismatch detected: ${candleName} (exchange | Gekko)`, ...fields].join('\n'));
    } catch (err) {
      warning('supervision', `Timeframe candle check failed for the ${candleName}: ${describeError(err)}`);
    }
  }

  /**
   * The exchange's candle of the timeframe starting at `start`, if it has one. A timeframe the exchange does not serve is batched
   * from its 1-minute candles, as TradingAdvisor batches them, when one request returns them all: otherwise there is no candle to
   * compare with, which is logged once.
   */
  private async fetchExchangeTimeframeCandle(symbol: TradingPair, start: EpochTimeStamp) {
    const exchange = this.getExchange();
    const exchangeName = exchange.getExchangeName();
    const timeframe = this.timeframe!; // Required in realtime by the configuration schema
    if (NATIVE_TIMEFRAMES[exchangeName]?.includes(timeframe)) {
      const candles = await exchange.fetchOHLCV(symbol, { from: start, timeframe, limit: 1 });
      return candles.find(candle => candle.start === start);
    }

    const candleSize = TIMEFRAME_TO_MINUTES[timeframe];
    const { candles: candleLimit } = LIMITS[exchangeName];
    if (candleSize > candleLimit) {
      if (!this.isCandleCheckSkipLogged) {
        const reason = `one request returns ${candleLimit} 1-minute candles at most, fewer than a ${timeframe} candle spans`;
        warning('supervision', `Timeframe candles not checked: ${exchangeName} serves no ${timeframe} candles, and ${reason}`);
        this.isCandleCheckSkipLogged = true;
      }
      return;
    }

    const minutes = await exchange.fetchOHLCV(symbol, { from: start, timeframe: '1m', limit: candleSize });
    // Only the minutes of the window: the exchange answers the first `limit` minutes from `start` on, so a minute it lacks in the window
    // lets one after it in. The batcher completes the candle with the last minute of the window, if the exchange has it.
    const end = start + candleSize * ONE_MINUTE;
    const batcher = new FastCandleBatcher(candleSize);
    return minutes
      .filter(minute => minute.start < end)
      .map(minute => batcher.addCandle(minute))
      .at(-1);
  }

  private getCpuUsage(): number {
    const currentUsage = process.cpuUsage(this.lastCpuUsage);
    const currentTime = Date.now();
    const elapsedMicros = (currentTime - this.lastCpuCheck) * 1000;
    const usedMicros = currentUsage.user + currentUsage.system;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuCheck = currentTime;
    return (usedMicros / elapsedMicros) * 100;
  }

  private getMemoryUsage(): number {
    const bytes = process.memoryUsage().rss;
    return bytes / (1024 * 1024);
  }

  /**
   * Starts the check of each bucket of timeframe candles in the background, and returns at once. Nothing in the pipeline may wait
   * for it: the deferred events are flushed, and the next bucket processed (the candles, the orders), only once every handler has
   * returned, and a check waits on the exchange (a fetch, which ccxt timeouts and retries stretch to about 46 s) and, when the
   * candles differ, on Telegram (about 125 s when it does not answer: every attempt of the fetcher). Awaited, it would hold the
   * trading back by that much at every timeframe candle, and the realtime warmup by an exchange round trip per candle.
   */
  public onTimeframeCandle(payloads: CandleBucket[]) {
    if (!this.subscriptions.has('candle_check')) return;
    for (const bucket of payloads) this.checkTimeframeCandlesInBackground(bucket);
  }

  /**
   * Checks the candles of a bucket, the pairs together, unless the check of the previous bucket is still in flight: the bucket is
   * then skipped rather than queued, the check being a monitoring aid, not a trading input. It never rejects, which would be an
   * unhandled rejection (the run then exits 1): each check catches its own failure.
   */
  private checkTimeframeCandlesInBackground(bucket: CandleBucket) {
    if (this.candleCheckInFlight) return debug('supervision', 'Timeframe candle check skipped: the previous one is still in flight');
    const checks = Array.from(bucket, ([symbol, candle]) => this.checkTimeframeCandle(symbol, candle));
    this.candleCheckInFlight = Promise.all(checks).finally(() => {
      this.candleCheckInFlight = undefined;
    });
  }

  protected processInit() {
    debug('supervision', 'Supervision plugin initialized');
    this.bot.listen();
  }

  /** Records when the last 1-minute bucket came, whose age the candle check measures (see checkCandleFreshness) */
  protected processOneMinuteBucket(): void {
    this.lastBucketReceivedAt = Date.now();
  }

  protected async processFinalize() {
    this.isFinalized = true;
    this.bot.close();
    this.stopCpuCheck();
    this.stopMemoryCheck();
    this.stopTimeframeCandleCheck();
    this.stopLogMonitoring();
    // Last flush: what is logged while the application stops (such as why it stops) would otherwise never be sent
    if (this.subscriptions.has('monitor_log')) await this.sendLastLogs();
  }

  /**
   * The last flush, given up after LAST_FLUSH_TIMEOUT: the send is then left to go on in the background until the process exits.
   * It never rejects: a failure, like the giving up, is logged as a warning.
   */
  private async sendLastLogs() {
    let timer: Timer | undefined;
    const givenUp = new Promise<'given up'>(resolve => {
      timer = setTimeout(() => resolve('given up'), LAST_FLUSH_TIMEOUT);
    });
    const flush = this.sendNewLogs().catch(err => warning('supervision', `Last logs not sent: ${describeError(err)}`));
    const outcome = await Promise.race([flush, givenUp]);
    clearTimeout(timer); // Left pending, it would keep a process that ends normally alive until it fires
    if (outcome === 'given up') warning('supervision', `Last logs given up: not sent within ${LAST_FLUSH_TIMEOUT / ONE_SECOND} s`);
  }

  public static getStaticConfiguration() {
    return {
      name: 'Supervision',
      schema: supervisionSchema,
      modes: ['realtime'],
      dependencies: [],
      inject: ['exchange'],
      eventsHandlers: filter(Object.getOwnPropertyNames(Supervision.prototype), p => p.startsWith('on')),
      eventsEmitted: [],
    } as const;
  }
}
