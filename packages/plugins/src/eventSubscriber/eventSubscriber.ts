import { ONE_MINUTE, ONE_SECOND } from '@gekko/shared/constants/time.const';
import { getAssetBalance } from '@gekko/shared/helpers/portfolio/portfolio.helper';
import { AdviceCancelOrder, AdviceOrder } from '@gekko/shared/models/advice.types';
import {
  CandleBucket,
  OrderCanceledEvent,
  OrderCompletedEvent,
  OrderErroredEvent,
  OrderInitiatedEvent,
  RoundTrip,
} from '@gekko/shared/models/event.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { StrategyInfo } from '@gekko/shared/models/strategyInfo.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { PERCENT_ROUNDING } from '../analyzers/analyzer.const';
import { Plugin } from '@gekko/core/plugin/plugin';
import type { RunContext } from '@gekko/core/run/runContext.types';
import { LAST_FLUSH_TIMEOUT } from '@gekko/core/bots/telegram/telegram.const';
import { TelegramBot } from '@gekko/core/bots/telegram/TelegramBot';
import { debug, info, warning } from '@gekko/core/logger/logger';
import { formatDurationUTC, toISOString } from '@gekko/shared/utils/date/date.utils';
import { isFiniteNumber, isFinitePositive } from '@gekko/shared/utils/math/math.utils';
import { formatAmount, formatPercent, pluralize } from '@gekko/shared/utils/string/string.utils';
import { bindAll, filter, isNil } from 'lodash-es';
import { MAX_PENDING_NOTIFICATIONS } from './eventSubscriber.const';
import { describeNotSent, describePortfolioAnswer, describeRequestedAmount, describeTargetPrice } from './eventSubscriber.helper';
import { eventSubscriberSchema } from '@gekko/schemas/plugins/eventSubscriber.schema';
import { Event, EVENT_NAMES, EventSubscriberConfig, KeptPortfolio, PendingNotification } from './eventSubscriber.types';

export class EventSubscriber extends Plugin {
  private bot: TelegramBot;
  /** The close of each pair's last 1-minute candle, which the notifications and /portfolio price things at */
  private prices = new Map<TradingPair, number>();
  /** The close of the last 1-minute bucket processed, that of `prices`: undefined until one is */
  private pricesAt?: EpochTimeStamp;
  /**
   * The last read of the Trader's portfolio the events brought, which /portfolio answers with, and the time it is dated with (see
   * keepRead and onPortfolioChange): undefined until one comes. Not fetched: the plugin is given no exchange, and a command is answered
   * synchronously.
   */
  private kept?: KeptPortfolio;
  private subscriptions = new Set<Event>();
  /** The notifications waiting for their turn, oldest first: see notify */
  private pending: PendingNotification[] = [];
  /**
   * Whether the loop sending the pending notifications runs. The loop sets it, and clears it in the step that finds the queue empty:
   * a notification queued before then is its to send, one queued after starts another loop.
   */
  private isSending = false;
  /** That loop, or the last one to have run: it resolves once the queue is empty, and never rejects */
  private sending: Promise<void> = Promise.resolve();
  /** Whether a notification has been dropped since the queue was last empty: the first drop of a backlog is a warning, not the next */
  private isOverflowing = false;
  /** How many sends have failed in a row since the last one that went through, or the start: see logSendFailure */
  private failedSends = 0;

  constructor({ name, token, botUsername, chatId }: EventSubscriberConfig, context: RunContext) {
    super(name, context);
    bindAll(this, [this.handleCommand.name]);
    this.bot = new TelegramBot(token, botUsername, this.handleCommand, chatId);
  }

  private handleCommand(command: string): string {
    switch (command) {
      case '/help':
        return [
          'sub_strat_info - Subscribe to strategy logs',
          'sub_strat_create - Notify on strategy order creation',
          'sub_strat_cancel - Notify on strategy order cancellation',
          'sub_order_init - Notify on order initiation',
          'sub_order_cancel - Notify on order cancellation',
          'sub_order_error - Notify on order error',
          'sub_order_complete - Notify on order completion',
          'sub_roundtrip_complete - Notify on roundtrip completion',
          'subscribe_all - Subscribe to all notifications',
          'unsubscribe_all - Unsubscribe from all notifications',
          'subscriptions - View current subscriptions',
          'portfolio - Show the balances, the last prices and the total value',
          'help - Show help information',
        ].join('\n');
      case '/subscribe_all':
        EVENT_NAMES.forEach(e => this.subscriptions.add(e));
        return 'Subscribed to all events';
      case '/unsubscribe_all':
        this.subscriptions.clear();
        return 'Unsubscribed from all events';
      case '/subscriptions':
        return this.subscriptions.size ? [...this.subscriptions].join('\n') : 'No subscriptions';
      case '/portfolio':
        // Answered at once, subscribed or not, from what the plugin holds
        return describePortfolioAnswer({
          kept: this.kept,
          prices: this.prices,
          pricesAt: this.pricesAt,
          pairs: this.pairs,
          assets: this.assets,
          currency: this.currency,
          now: Date.now(),
        });
      default:
        if (command.startsWith('/sub_')) {
          const event = command.replace('/sub_', '') as Event;
          if (!EVENT_NAMES.includes(event)) return 'Unknown command';
          if (this.subscriptions.has(event)) {
            this.subscriptions.delete(event);
            return `Unsubscribed from ${event}`;
          }
          this.subscriptions.add(event);
          return `Subscribed to ${event}`;
        }
        return 'Unknown command';
    }
  }

  /**
   * Queues a message for each payload of a batch, if the chat is subscribed to `event`, and returns at once: one loop sends the queued
   * messages in the background (sendPending), and processFinalize waits for them, up to LAST_FLUSH_TIMEOUT.
   * - Not awaited, because the deferred events are flushed, and the next bucket processed (the candles, the orders), only once every
   *   handler has returned: Telegram slow or unreachable (the fetcher tries a send 4 times, each up to 30 s) would stall the trading
   *   for minutes at each notification.
   * - Sent one at a time, in the order they came, because sent together the parts of long messages would interleave, and a batch (a
   *   grid strategy places dozens of orders at once) would hit Telegram's rate limits in one burst, where one at a time each send
   *   waits out the 429 of the one before.
   * - At most MAX_PENDING_NOTIFICATIONS waiting, because during an outage they would pile up without end.
   * A notification goes out only if the chat is subscribed to its event when the event arrives, and still is when its turn comes. Its
   * message is built at once, from the payload and the prices of now. A payload it cannot be built from is logged and skipped: this
   * never throws, since a handler that throws ends the run (see PluginsStream).
   */
  private notify<T>(event: Event, payloads: T[], buildMessage: (payload: T) => string) {
    if (!this.subscriptions.has(event)) return;
    for (const payload of payloads) {
      try {
        this.enqueue({ event, text: buildMessage(payload) });
      } catch (err) {
        warning('event subscriber', describeNotSent(event, err)); // Only buildMessage throws: the next payloads still go out
      }
    }
  }

  /** Queues a notification, after dropping the oldest one waiting if the queue is full, and starts the loop sending them if it is idle */
  private enqueue(notification: PendingNotification) {
    if (this.pending.length >= MAX_PENDING_NOTIFICATIONS) {
      const { event } = this.pending.shift()!;
      const queueFull = `the queue of ${MAX_PENDING_NOTIFICATIONS} notifications waiting for Telegram is full`;
      const dropped = `The ${event} notification was dropped: ${queueFull}`;
      // One warning per backlog, until the queue is empty again: the warnings go to Telegram too, in Supervision's log batches, and a
      // long outage would flood them. A full queue is not always Telegram's doing: a burst fills it too (see MAX_PENDING_NOTIFICATIONS)
      if (this.isOverflowing) {
        debug('event subscriber', dropped);
      } else {
        warning(
          'event subscriber',
          `${dropped} (a burst, or Telegram not answering). Until it empties, each new one drops the oldest, logged at debug level`,
        );
      }
      this.isOverflowing = true;
    }
    this.pending.push(notification);
    if (!this.isSending) this.sending = this.sendPending();
  }

  /**
   * Sends the queued notifications one at a time, oldest first, until none is left, those queued meanwhile included. It never rejects,
   * which nothing but the finalisation would handle (an unhandled rejection makes the run exit 1): a failure is logged with its event,
   * and the next one goes out.
   */
  private async sendPending() {
    this.isSending = true;
    while (this.pending.length) {
      const { event, text } = this.pending.shift()!;
      if (!this.subscriptions.has(event)) continue; // Unsubscribed while it waited: the chat wants no more of them
      try {
        await this.bot.sendMessage(text);
      } catch (err) {
        this.logSendFailure(event, err);
        continue;
      }
      this.endFailureStreak();
    }
    // In the step that found the queue empty: a notification queued from now on starts another loop
    this.isSending = false;
    this.isOverflowing = false;
  }

  /**
   * Logs a send that failed. A failure that will not pass (a 403 for a blocked bot, a 400 for a chat not found, a 429 asking to wait
   * more than a minute) is thrown by the fetcher at once, so every notification queued then fails in turn, instantly. Only the first
   * failure since the last send that went through is a warning, the next ones are debug lines: the warnings go to Telegram too, in
   * Supervision's log batches, which they would flood.
   */
  private logSendFailure(event: Event, err: unknown) {
    this.failedSends++;
    const notSent = describeNotSent(event, err);
    if (this.failedSends > 1) debug('event subscriber', notSent);
    else warning('event subscriber', `${notSent}. Until a notification goes out again, the next failures are logged at debug level`);
  }

  /** After a send that went through: says how many had failed in a row before it, if any, and starts the count again */
  private endFailureStreak() {
    if (!this.failedSends) return;
    info('event subscriber', `Notifications go out again, after ${this.failedSends} ${pluralize('failure', this.failedSends)}`);
    this.failedSends = 0;
  }

  /**
   * Lets the pending notifications go out before the run ends, for LAST_FLUSH_TIMEOUT at most: they are then given up, their loop
   * left to go on in the background until the process exits. It never rejects, as `sending` never does.
   * No event is delivered once the finalisation has started (PluginsStream waits for the bucket in flight before it finalises the
   * plugins), but the wait stays defensive: a notification queued while no loop runs starts another one, with its own promise. So,
   * within the one deadline, it waits for `sending` read anew until a wait ends with no loop running, the first wait included: that
   * lets in a notification queued right after the call, even when no loop ran then.
   */
  private async waitForPending() {
    let timer: Timer | undefined;
    const givenUp = new Promise<'given up'>(resolve => {
      timer = setTimeout(() => resolve('given up'), LAST_FLUSH_TIMEOUT);
    });
    let outcome: 'given up' | void;
    try {
      do {
        outcome = await Promise.race([this.sending, givenUp]);
      } while (outcome !== 'given up' && this.isSending);
    } finally {
      clearTimeout(timer); // Left pending, it would keep a process that ends normally alive until it fires
    }
    if (outcome !== 'given up') return;
    const count = this.pending.length + 1; // With the one being sent
    warning(
      'event subscriber',
      `${count} ${pluralize('notification', count)} given up: not sent within ${LAST_FLUSH_TIMEOUT / ONE_SECOND} s`,
    );
  }

  /**
   * Keeps the read of the Trader's portfolio that the last of these order events carries, dated with the time the Trader made it, which
   * every order event says (see ExchangeEvent.portfolioReadAt): whatever the event, whatever its balances. The end of an order carries
   * the read made once the order had ended (see Trader.relayError), so that a fill reaches /portfolio although the Trader's
   * portfolioUpdates filter holds a small change back from the portfolio events. The creation of an order, an end whose read failed, and
   * an order refused before it was placed carry the last read as it stands, maybe minutes old, which keeps the time it was made. Dated
   * with their reception, such reads came out fresh: a read the filter had held back, carried by the end of an order whose read failed,
   * was "8 seconds ago" for balances read minutes before the fill, and the creations of the orders were not kept at all.
   * The Trader queues its events in the order of its reads, each with the last one it made (see onPortfolioChange): the last event brings
   * the newest read, even one whose time comes before that of the read kept, the clock set back between the two, which a comparison of
   * the times would leave out until the clock had caught up. An event without a read time carries no read: the empty portfolio the
   * Trader starts with, until one of its synchronizations succeeds. Run before the notification, subscribed or not, and never throws: a
   * handler that throws ends the run.
   */
  private keepRead(payloads: OrderInitiatedEvent[]) {
    const exchange = payloads.at(-1)?.exchange;
    const readAt = exchange?.portfolioReadAt;
    if (exchange?.portfolio && isFiniteNumber(readAt)) this.kept = { portfolio: exchange.portfolio, at: readAt, dated: 'read' };
  }

  // --- BEGIN LISTENERS ---
  public onStrategyInfo(payloads: StrategyInfo[]) {
    this.notify(
      'strat_info',
      payloads,
      ({ timestamp, level, tag, message }) => `• ${toISOString(timestamp)} [${level.toUpperCase()}] (${tag})\n${message}\n------\n`,
    );
  }

  public onStrategyCreateOrder(payloads: AdviceOrder[]) {
    this.notify('strat_create', payloads, advice => {
      const { id, orderCreationDate, side, type, symbol } = advice;
      return [
        `Order Id: ${id}`,
        `Received ${type} ${side} advice for ${symbol}`,
        `Requested amount: ${describeRequestedAmount(advice)}`,
        `At time: ${toISOString(orderCreationDate)}`,
        describeTargetPrice(advice, this.prices.get(symbol)),
        '------',
      ].join('\n');
    });
  }

  // Its portfolio is the Trader's last read as it stands, maybe minutes old, kept with the time it was made (see keepRead)
  public onOrderInitiated(payloads: OrderInitiatedEvent[]) {
    this.keepRead(payloads);
    this.notify('order_init', payloads, ({ order, exchange }) => {
      const { portfolio } = exchange;
      const { id, amount, side, type, orderCreationDate, symbol } = order;
      const [asset, currency] = symbol.split('/');
      const assetBalance = getAssetBalance(portfolio, asset);
      const currencyBalance = getAssetBalance(portfolio, currency);
      return [
        `${side} ${type} order created (${id}) for ${symbol}`,
        `Requested amount: ${formatAmount(amount)}`,
        `Current symbol portfolio: ${formatAmount(assetBalance.total)} ${asset} / ${formatAmount(currencyBalance.total)} ${currency}`,
        // As the notification of its advice wrote it (see describeTargetPrice)
        describeTargetPrice(order, this.prices.get(symbol)),
        `At time: ${toISOString(orderCreationDate)}`,
        '------',
      ].join('\n');
    });
  }

  public onOrderCanceled(payloads: OrderCanceledEvent[]) {
    this.keepRead(payloads);
    this.notify('order_cancel', payloads, ({ order }) => {
      const { id, amount, side, type, price, orderCancelationDate, filled, remaining, fillPrice, symbol } = order;
      const [asset, currency] = symbol.split('/');
      const currentPrice = this.prices.get(symbol) ?? 0;
      // Only a LIMIT order rests at the price it asked for: a MARKET or a STICKY one follows the market, its price only sizing it (see
      // describeTargetPrice)
      const priceLine =
        type === 'LIMIT' && !isNil(price)
          ? `Requested limit price: ${formatAmount(price)} ${currency}`
          : `Current price: ${formatAmount(currentPrice)} ${currency}`;
      // An order leaves both amounts out when no answer of the exchange reported a fill (see OrderCanceledEvent): printed as they were,
      // they read "undefined". The mean price of that fill comes with a LIMIT or a STICKY order whose fills the exchange priced, not with
      // a MARKET one, whose reported price can be the bound of its slippage (see OrderCanceledEvent.fillPrice).
      const fillLines =
        isNil(filled) || isNil(remaining)
          ? [`Filled amount: not reported / ${formatAmount(amount)} ${asset}`]
          : [
              `Filled amount: ${formatAmount(filled)} / ${formatAmount(amount)} ${asset}`,
              `Remaining amount: ${formatAmount(remaining)} ${asset}`,
              ...(isFinitePositive(fillPrice) ? [`Average fill price: ${formatAmount(fillPrice)} ${currency}`] : []),
            ];
      return [
        `${side} ${type} order canceled (${id}) for ${symbol}`,
        `At time: ${toISOString(orderCancelationDate)}`,
        ...fillLines,
        priceLine,
        '------',
      ].join('\n');
    });
  }

  public onOrderErrored(payloads: OrderErroredEvent[]) {
    this.keepRead(payloads);
    this.notify('order_error', payloads, ({ order }) => {
      const { id, amount, side, type, reason, orderErrorDate, symbol, mayBeLive } = order;
      const [, currency] = symbol.split('/');
      const currentPrice = this.prices.get(symbol) ?? 0;
      return [
        `${side} ${type} order errored (${id}) for ${symbol}`,
        `Due to ${reason}`,
        // The Trader follows it no more: only a look at the exchange tells whether it is there, and what it executed
        ...(mayBeLive ? ['It may still be live on the exchange, where Gekko follows it no more: check it there'] : []),
        `At time: ${toISOString(orderErrorDate)}`,
        `Requested amount: ${formatAmount(amount)}`,
        `Current price: ${formatAmount(currentPrice)} ${currency}`,
        '------',
      ].join('\n');
    });
  }

  public onOrderCompleted(payloads: OrderCompletedEvent[]) {
    this.keepRead(payloads);
    this.notify('order_complete', payloads, ({ order, exchange }) => {
      const { portfolio } = exchange;
      const { id, amount, side, type, orderExecutionDate, effectivePrice, feePercent, fee, feeAsset, symbol } = order;
      const [asset, currency] = symbol.split('/');
      const assetBalance = getAssetBalance(portfolio, asset);
      const currencyBalance = getAssetBalance(portfolio, currency);
      // Without a fee rate (no trade of the order reported one), the Trader assumes no fee (computeOrderPricing): it sends a fee of 0
      // and the bare trade price as the effective price, which must not read as a free trade at a price fee included
      const isFeeKnown = isFiniteNumber(feePercent);
      // The fee is written in the currency whatever the asset the exchange took it in, named when it is another one: the asset bought,
      // which Binance takes a BUY's fee in unless the fees are paid in BNB, or BNB, whose fee the Trader does not convert
      const takenIn = feeAsset !== undefined && feeAsset !== currency ? ` (taken in ${feeAsset})` : '';
      return [
        `${side} ${type} order completed (${id}) for ${symbol}`,
        `Amount: ${formatAmount(amount)} ${asset}`,
        isFeeKnown
          ? `Price: ${formatAmount(effectivePrice)} ${currency}`
          : `Price (excluding fee): ${formatAmount(effectivePrice)} ${currency}`,
        // A rate keeps its decimals, as the amounts do: 0.075 % rounded to 2 decimals would read 0.07 %
        `Fee percent: ${isFeeKnown ? `${formatAmount(feePercent)}%` : 'unknown'}`,
        `Fee: ${isFeeKnown ? `${formatAmount(fee)} ${currency}` : 'unknown'}${takenIn}`,
        `At time: ${toISOString(orderExecutionDate)}`,
        `Current portfolio: ${formatAmount(assetBalance.total)} ${asset} / ${formatAmount(currencyBalance.total)} ${currency}`,
        '------',
      ].join('\n');
    });
  }

  public onStrategyCancelOrder(payloads: AdviceCancelOrder[]) {
    // When the requests arrived, which their payloads do not say, one time for the batch: not when the messages go out, maybe much later
    const requestedAt = Date.now();
    this.notify('strat_cancel', payloads, ({ id, symbol }) =>
      [
        // The StrategyManager names the pair of an order it created and that has not ended, the 10 000 most recent of those, and knows
        // no other (see AdviceCancelOrder)
        `Strategy requested order cancellation for ${isNil(symbol) ? 'an order it did not create, or that had ended' : symbol}`,
        `Order Id: ${id}`,
        `At time: ${toISOString(requestedAt)}`,
      ].join('\n'),
    );
  }

  /**
   * Keeps the last portfolio of the batch, the latest the Trader read: the Trader queues a portfolio event once it has read the account,
   * and each order event with the read it holds as it queues it, so that what comes after carries that read or a later one (see
   * keepRead). The event does not say when the read was made: dated with its reception, a minute or so after the read at most, the
   * events queued between two buckets being delivered as the next one arrives, before the plugins process it (see PluginsStream).
   */
  public onPortfolioChange(payloads: Portfolio[]) {
    const portfolio = payloads.at(-1);
    if (portfolio) this.kept = { portfolio, at: Date.now(), dated: 'received' };
  }

  public onRoundtripCompleted(payloads: RoundTrip[]) {
    this.notify('roundtrip_complete', payloads, ({ symbol, pnl, profit, duration, entryPrice, exitPrice, maxAdverseExcursion, exitAt }) =>
      [
        `Roundtrip completed for ${symbol}`,
        // Its P&L comes from its fills, and its profit is NaN when no portfolio read valued its entry (see RoundTrip): read "unknown" then
        `PnL: ${isFiniteNumber(pnl) ? formatAmount(pnl) : 'unknown'}`,
        // Rounded as the console table rounds them (see PERCENT_ROUNDING): rounded half up here, a round trip of 2.345 % read 2.35 %,
        // and 2.34 % on the console
        `Profit: ${isFiniteNumber(profit) ? formatPercent(profit, PERCENT_ROUNDING.profit) : 'unknown'}`,
        // On the UTC calendar from epoch 0: on the host's, a round trip of 120 days read "3 months 30 days 1 hour" in New York
        `Duration: ${formatDurationUTC(0, duration)}`,
        // Written as the amounts are: the mean price of the SELLs read 0.10000000000000002
        `Entry Price: ${formatAmount(entryPrice)}`,
        `Exit Price: ${formatAmount(exitPrice)}`,
        `Max Adverse Excursion: ${formatPercent(maxAdverseExcursion, PERCENT_ROUNDING.maxAdverseExcursion)}`,
        `At time: ${toISOString(exitAt)}`,
        '------',
      ].join('\n'),
    );
  }

  // --- END LISTENERS ---

  // --------------------------------------------------------------------------
  //                           PLUGIN LIFECYCLE HOOKS
  // --------------------------------------------------------------------------

  protected processInit(): void {
    this.bot.listen();
  }

  protected processOneMinuteBucket(bucket: CandleBucket) {
    for (const [symbol, candle] of bucket) {
      this.prices.set(symbol, candle.close);
      // Every candle of a bucket starts on its minute: the close of the bucket, which /portfolio dates the prices with
      this.pricesAt = candle.start + ONE_MINUTE;
    }
  }

  protected async processFinalize() {
    this.bot.close(); // Stops the polling for commands only: the notifications still go out
    await this.waitForPending();
  }

  public static getStaticConfiguration() {
    return {
      name: 'EventSubscriber',
      schema: eventSubscriberSchema,
      modes: ['realtime'],
      dependencies: [],
      inject: [],
      eventsHandlers: filter(Object.getOwnPropertyNames(EventSubscriber.prototype), p => p.startsWith('on')),
      eventsEmitted: [],
    } as const;
  }
}
