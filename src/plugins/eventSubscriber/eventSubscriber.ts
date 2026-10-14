import { ONE_SECOND } from '@constants/time.const';
import { describeError } from '@errors/error.utils';
import { AdviceOrder } from '@models/advice.types';
import {
  CandleBucket,
  OrderCanceledEvent,
  OrderCompletedEvent,
  OrderErroredEvent,
  OrderInitiatedEvent,
  RoundTrip,
} from '@models/event.types';
import { StrategyInfo } from '@models/strategyInfo.types';
import { TradingPair } from '@models/utility.types';
import { Plugin } from '@plugins/plugin';
import { TelegramBot } from '@services/bots/telegram/TelegramBot';
import { debug, info, warning } from '@services/logger';
import { toISOString } from '@utils/date/date.utils';
import { round } from '@utils/math/round.utils';
import { getAssetBalance } from '@utils/portfolio/portfolio.utils';
import { formatAmount, pluralize } from '@utils/string/string.utils';
import { formatDuration, intervalToDuration } from 'date-fns';
import { bindAll, filter, isNil } from 'lodash-es';
import { UUID } from 'node:crypto';
import { eventSubscriberSchema } from './eventSubscriber.schema';
import { Event, EVENT_NAMES, EventSubscriberConfig } from './eventSubscriber.types';

/**
 * The most notifications waiting for their turn, the one being sent aside. With Telegram unreachable, each send takes every attempt
 * of the fetcher, about two minutes, and they would pile up for as long as the outage lasts: past this many, each new one drops the
 * oldest, the least worth reading once Telegram answers again. A burst must fit while Telegram answers, since no send ends while a
 * flush queues notifications (no handler waits on the network): a grid strategy placing N orders in one loop queues N strat_create,
 * N order_init and its logs in one flush. Their texts are short, so a full queue costs little memory.
 */
const MAX_PENDING_NOTIFICATIONS = 1000;

/**
 * How long the finalisation waits for the pending notifications, and so holds the exit. The value of Supervision's last flush, which
 * runs at the same time (the plugins are finalised together): the exit waits that long at most for both.
 */
const LAST_FLUSH_TIMEOUT = 15 * ONE_SECOND;

/** A message waiting for its turn, with the event it notifies of, which the logs name */
type PendingNotification = { event: Event; text: string };

/** How the logs say that a notification was not sent */
const describeNotSent = (event: Event, err: unknown) => `The ${event} notification was not sent: ${describeError(err)}`;

export class EventSubscriber extends Plugin {
  private bot: TelegramBot;
  private prices = new Map<TradingPair, number>();
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

  constructor({ name, token, botUsername, chatId }: EventSubscriberConfig) {
    super(name);
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

  // --- BEGIN LISTENERS ---
  public onStrategyInfo(payloads: StrategyInfo[]) {
    this.notify(
      'strat_info',
      payloads,
      ({ timestamp, level, tag, message }) => `• ${toISOString(timestamp)} [${level.toUpperCase()}] (${tag})\n${message}\n------\n`,
    );
  }

  public onStrategyCreateOrder(payloads: AdviceOrder[]) {
    this.notify('strat_create', payloads, ({ id, orderCreationDate, side, type, amount, price, symbol }) => {
      const [, currency] = symbol.split('/');
      const currentPrice = this.prices.get(symbol);
      // The Trader places an advice of any type at its price, or without one at the market price (see Trader.onStrategyCreateOrder):
      // a LIMIT advice with a price shows it as the limit it requests, any other advice that price it is placed at, as its target
      const priceLine =
        type === 'LIMIT' && !isNil(price)
          ? `Requested limit price: ${price} ${currency}`
          : `Target price: ${price ?? currentPrice ?? 'unknown'} ${currency}`;
      return [
        `Order Id: ${id}`,
        `Received ${type} ${side} advice for ${symbol}`,
        `Requested amount: ${amount ?? 'auto'}`,
        `At time: ${toISOString(orderCreationDate)}`,
        priceLine,
        '------',
      ].join('\n');
    });
  }

  public onOrderInitiated(payloads: OrderInitiatedEvent[]) {
    this.notify('order_init', payloads, ({ order, exchange }) => {
      const { portfolio } = exchange;
      const { id, amount, side, type, price, orderCreationDate, symbol } = order;
      const [asset, currency] = symbol.split('/');
      const currentPrice = this.prices.get(symbol) ?? 0;
      const priceLine = price ? `Requested limit price: ${price} ${currency}` : `Target price: ${currentPrice} ${currency}`;
      const assetBalance = getAssetBalance(portfolio, asset);
      const currencyBalance = getAssetBalance(portfolio, currency);
      return [
        `${side} ${type} order created (${id}) for ${symbol}`,
        `Requested amount: ${amount}`,
        `Current symbol portfolio: ${assetBalance.total} ${asset} / ${currencyBalance.total} ${currency}`,
        priceLine,
        `At time: ${toISOString(orderCreationDate)}`,
        '------',
      ].join('\n');
    });
  }

  public onOrderCanceled(payloads: OrderCanceledEvent[]) {
    this.notify('order_cancel', payloads, ({ order }) => {
      const { id, amount, side, type, price, orderCancelationDate, filled, remaining, symbol } = order;
      const [asset, currency] = symbol.split('/');
      const currentPrice = this.prices.get(symbol) ?? 0;
      const priceLine = price ? `Requested limit price: ${price} ${currency}` : `Current price: ${currentPrice} ${currency}`;
      // An order leaves both amounts out when no answer of the exchange reported a fill (see OrderCanceledEvent): printed as they were,
      // they read "undefined"
      const fillLines = isNil(filled)
        ? [`Filled amount: not reported / ${amount} ${asset}`]
        : [`Filled amount: ${filled} / ${amount} ${asset}`, `Remaining amount: ${remaining} ${asset}`];
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
        `Requested amount: ${amount}`,
        `Current price: ${currentPrice} ${currency}`,
        '------',
      ].join('\n');
    });
  }

  public onOrderCompleted(payloads: OrderCompletedEvent[]) {
    this.notify('order_complete', payloads, ({ order, exchange }) => {
      const { portfolio } = exchange;
      const { id, amount, side, type, orderExecutionDate, effectivePrice, feePercent, fee, symbol } = order;
      const [asset, currency] = symbol.split('/');
      const assetBalance = getAssetBalance(portfolio, asset);
      const currencyBalance = getAssetBalance(portfolio, currency);
      // Without a fee rate (no trade of the order reported one), the Trader assumes no fee (computeOrderPricing): it sends a fee of 0
      // and the bare trade price as the effective price, which must not read as a free trade at a price fee included
      const isFeeKnown = Number.isFinite(feePercent);
      return [
        `${side} ${type} order completed (${id}) for ${symbol}`,
        `Amount: ${amount} ${asset}`,
        isFeeKnown ? `Price: ${effectivePrice} ${currency}` : `Price (excluding fee): ${effectivePrice} ${currency}`,
        `Fee percent: ${isFeeKnown ? `${feePercent}%` : 'unknown'}`,
        `Fee: ${isFeeKnown ? `${fee} ${currency}` : 'unknown'}`,
        `At time: ${toISOString(orderExecutionDate)}`,
        `Current portfolio: ${assetBalance.total} ${asset} / ${currencyBalance.total} ${currency}`,
        '------',
      ].join('\n');
    });
  }

  public onStrategyCancelOrder(payloads: UUID[]) {
    // When the requests arrived, which their payloads do not say, one time for the batch: not when the messages go out, maybe much later
    const requestedAt = Date.now();
    this.notify('strat_cancel', payloads, id =>
      ['Strategy requested order cancellation', `Order Id: ${id}`, `At time: ${toISOString(requestedAt)}`].join('\n'),
    );
  }

  public onRoundtripCompleted(payloads: RoundTrip[]) {
    this.notify('roundtrip_complete', payloads, ({ pnl, profit, duration, entryPrice, exitPrice, maxAdverseExcursion, exitAt }) => {
      const durationStr = formatDuration(intervalToDuration({ start: 0, end: duration }));
      return [
        'Roundtrip completed',
        `PnL: ${formatAmount(pnl)}`,
        `Profit: ${round(profit, 2)}%`,
        `Duration: ${durationStr}`,
        `Entry Price: ${entryPrice}`,
        `Exit Price: ${exitPrice}`,
        `Max Adverse Excursion: ${round(maxAdverseExcursion, 2)}%`,
        `At time: ${toISOString(exitAt)}`,
        '------',
      ].join('\n');
    });
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
