import { ONE_MINUTE } from '@constants/time.const';
import { AdviceCancelOrder, AdviceOrder } from '@models/advice.types';
import { OrderCanceledEvent, OrderCompletedEvent, OrderErroredEvent, OrderInitiatedEvent, RoundTrip } from '@models/event.types';
import { BalanceDetail, Portfolio } from '@models/portfolio.types';
import { StrategyInfo } from '@models/strategyInfo.types';
import { TelegramBot } from '@services/bots/telegram/TelegramBot';
import { debug, info, warning } from '@services/logger';
import { useTimeZone } from '@utils/date/date.mock';
import { toTimestamp } from '@utils/date/date.utils';
import { range } from 'lodash-es';
import { UUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSubscriber } from './eventSubscriber';
import { eventSubscriberSchema } from './eventSubscriber.schema';
import { EVENT_NAMES } from './eventSubscriber.types';

vi.mock('@services/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn() }));
// Only records how the plugin builds its bot: each test then puts fakeBot in its place
vi.mock('@services/bots/telegram/TelegramBot', () => ({ TelegramBot: vi.fn(function () {}) }));
vi.mock('@services/configuration/configuration', () => {
  const Configuration = vi.fn(function () {
    return {
      getWatch: vi.fn(() => ({
        pairs: [
          { symbol: 'BTC/USD', timeframe: '1m' },
          { symbol: 'ETH/USD', timeframe: '1m' },
        ],
        assets: ['BTC', 'ETH'],
        currency: 'USD',
        mode: 'realtime',
        warmup: {},
      })),
      getStrategy: vi.fn(() => ({})),
      showLogo: vi.fn(),
      getPlugins: vi.fn(),
      getStorage: vi.fn(),
      getExchange: vi.fn(),
    };
  });
  return { config: new Configuration() };
});

const fakeBot = { sendMessage: vi.fn(), listen: vi.fn(), close: vi.fn() };

/**
 * Lets every pending promise callback run: by then the notifications have gone out in the background as far as Telegram, here the
 * mock, answered them, and a send made without waiting for the one before it would have been made
 */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('EventSubscriber', () => {
  let plugin: EventSubscriber;

  beforeEach(() => {
    plugin = new EventSubscriber({ name: 'EventSubscriber', botUsername: 'bot_name', token: 't' });
    plugin['bot'] = fakeBot as any;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The bot handles the commands of that chat only and sends the notifications there; without it, it takes the first chat to
  // send a command
  it.each`
    scenario                  | chatId
    ${'a configured chat id'} | ${-1001234567890}
    ${'no chat id'}           | ${undefined}
  `('builds its bot with $scenario', ({ chatId }) => {
    const subscriber = new EventSubscriber({ name: 'EventSubscriber', botUsername: 'bot_name', token: 't', chatId });
    expect(TelegramBot).toHaveBeenLastCalledWith('t', 'bot_name', subscriber['handleCommand'], chatId);
  });

  it.each`
    trigger                              | method
    ${() => plugin['processInit']()}     | ${'listen'}
    ${() => plugin['processFinalize']()} | ${'close'}
  `('invokes bot.$method', ({ trigger, method }) => {
    trigger();
    expect(fakeBot[method as 'listen' | 'close']).toHaveBeenCalled();
  });

  it.each`
    close
    ${42}
    ${0}
  `('updates price on processOneMinuteBucket', ({ close }) => {
    const bucket = new Map([['BTC/USD', { close }]]);
    plugin['processOneMinuteBucket'](bucket as any);
    expect(plugin['prices'].get('BTC/USD')).toBe(close);
  });

  // Every candle of a bucket starts on its minute: the prices are those of the close of the bucket
  it('dates the prices with the close of the last bucket processed', () => {
    const start = toTimestamp('2024-01-01T12:02:00Z');
    const bucket = new Map([
      ['BTC/USD', { start, close: 110 }],
      ['ETH/USD', { start, close: 2200 }],
    ]);
    plugin['processOneMinuteBucket'](bucket as any);
    expect(plugin['pricesAt']).toBe(toTimestamp('2024-01-01T12:03:00Z'));
  });

  describe('event notifications', () => {
    const eventTimestamp = toTimestamp('2022-01-01T00:00:00Z');
    const symbol = 'BTC/USD' as any;
    const baseOrder = {
      id: 'ee21e130-48bc-405f-be0c-46e9bf17b52e' as UUID,
      side: 'BUY' as const,
      type: 'STICKY' as const,
      amount: 1,
      price: 123,
      symbol,
    };
    const baseExchange = {
      price: 123,
      balance: { free: 1, used: 0, total: 1 },
      portfolio: new Map<string, BalanceDetail>([
        ['asset', { free: 0, used: 0, total: 0 }],
        ['currency', { free: 0, used: 0, total: 0 }],
      ]),
    };
    const makeStrategyInfo = (overrides: Partial<StrategyInfo> = {}): StrategyInfo => ({
      timestamp: eventTimestamp,
      level: 'debug',
      message: 'M',
      tag: 'strategy',
      ...overrides,
    });
    const makeAdviceOrder = (overrides: Partial<AdviceOrder> = {}): AdviceOrder => ({
      ...baseOrder,
      orderCreationDate: eventTimestamp,
      ...overrides,
    });
    const onStrategyCreateOrder = (p: EventSubscriber, overrides: Partial<AdviceOrder> = {}) =>
      p.onStrategyCreateOrder([makeAdviceOrder(overrides)]);
    const makeOrderInitiatedEvent = (
      overrides: {
        order?: Partial<OrderInitiatedEvent['order']>;
        exchange?: Partial<OrderInitiatedEvent['exchange']>;
      } = {},
    ): OrderInitiatedEvent => ({
      order: { ...baseOrder, orderCreationDate: eventTimestamp, ...overrides.order },
      exchange: { ...baseExchange, ...overrides.exchange },
    });
    const onOrderInitiated = (p: EventSubscriber, overrides = {}) => p.onOrderInitiated([makeOrderInitiatedEvent(overrides)]);
    const makeOrderCanceledEvent = (
      overrides: {
        order?: Partial<OrderCanceledEvent['order']>;
        exchange?: Partial<OrderCanceledEvent['exchange']>;
      } = {},
    ): OrderCanceledEvent => {
      const initiated = makeOrderInitiatedEvent(overrides);
      return {
        ...initiated,
        order: {
          ...initiated.order,
          orderCancelationDate: eventTimestamp,
          filled: 1,
          remaining: 1,
          ...overrides.order,
        },
        exchange: { ...initiated.exchange, ...overrides.exchange },
      };
    };
    const onOrderCanceled = (p: EventSubscriber, overrides = {}) => p.onOrderCanceled([makeOrderCanceledEvent(overrides)]);
    const makeOrderErroredEvent = (
      overrides: {
        order?: Partial<OrderErroredEvent['order']>;
        exchange?: Partial<OrderErroredEvent['exchange']>;
      } = {},
    ): OrderErroredEvent => {
      const initiated = makeOrderInitiatedEvent(overrides);
      return {
        ...initiated,
        order: {
          ...initiated.order,
          reason: 'r',
          orderErrorDate: eventTimestamp,
          filled: 0,
          mayBeLive: false,
          ...overrides.order,
        },
        exchange: { ...initiated.exchange, ...overrides.exchange },
      };
    };
    const makeOrderCompletedEvent = (
      overrides: {
        order?: Partial<OrderCompletedEvent['order']>;
        exchange?: Partial<OrderCompletedEvent['exchange']>;
      } = {},
    ): OrderCompletedEvent => {
      const initiated = makeOrderInitiatedEvent(overrides);
      return {
        ...initiated,
        order: {
          ...initiated.order,
          orderExecutionDate: eventTimestamp,
          effectivePrice: 1,
          fee: 1,
          feePercent: 0.1,
          ...overrides.order,
        },
        exchange: { ...initiated.exchange, ...overrides.exchange },
      };
    };
    const onOrderCompleted = (p: EventSubscriber, overrides = {}) => p.onOrderCompleted([makeOrderCompletedEvent(overrides)]);
    const makeRoundTrip = (overrides: Partial<RoundTrip> = {}): RoundTrip => ({
      id: 1,
      symbol: 'BTC/USD',
      entryAt: 1000,
      entryPrice: 100,
      entryEquity: 1000,
      exitAt: 2000,
      exitPrice: 110,
      exitEquity: 1100,
      duration: 1000,
      maxAdverseExcursion: 0,
      profit: 10,
      pnl: 100,
      ...overrides,
    });

    // Two payloads of each event, told apart in their messages by these ids (of their orders, or as the texts of the strategy
    // logs), or for the round trips, which have none, by their exit times
    const [firstId, secondId] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] as UUID[];
    const [firstExit, secondExit] = ['2022-01-01T01:00:00.000Z', '2022-01-01T02:00:00.000Z'];
    /** A cancel request as the StrategyManager relays it for an order it created and that has not ended: with its pair */
    const cancelRequest = (id: UUID): AdviceCancelOrder => ({ id, symbol });
    const notifyStrategyInfos = (p: EventSubscriber) => p.onStrategyInfo([firstId, secondId].map(message => makeStrategyInfo({ message })));
    const notifyAdviceOrders = (p: EventSubscriber) => p.onStrategyCreateOrder([firstId, secondId].map(id => makeAdviceOrder({ id })));
    const notifyCancelRequests = (p: EventSubscriber) => p.onStrategyCancelOrder([firstId, secondId].map(cancelRequest));
    const notifyInitiatedOrders = (p: EventSubscriber) =>
      p.onOrderInitiated([firstId, secondId].map(id => makeOrderInitiatedEvent({ order: { id } })));
    const notifyCanceledOrders = (p: EventSubscriber) =>
      p.onOrderCanceled([firstId, secondId].map(id => makeOrderCanceledEvent({ order: { id } })));
    const notifyErroredOrders = (p: EventSubscriber) =>
      p.onOrderErrored([firstId, secondId].map(id => makeOrderErroredEvent({ order: { id } })));
    const notifyCompletedOrders = (p: EventSubscriber) =>
      p.onOrderCompleted([firstId, secondId].map(id => makeOrderCompletedEvent({ order: { id } })));
    const notifyRoundTrips = (p: EventSubscriber) =>
      p.onRoundtripCompleted([firstExit, secondExit].map(exit => makeRoundTrip({ exitAt: toTimestamp(exit) })));

    describe.each`
      event                   | notifyTwice              | first                      | second
      ${'strat_info'}         | ${notifyStrategyInfos}   | ${firstId}                 | ${secondId}
      ${'strat_create'}       | ${notifyAdviceOrders}    | ${firstId}                 | ${secondId}
      ${'strat_cancel'}       | ${notifyCancelRequests}  | ${firstId}                 | ${secondId}
      ${'order_init'}         | ${notifyInitiatedOrders} | ${firstId}                 | ${secondId}
      ${'order_cancel'}       | ${notifyCanceledOrders}  | ${firstId}                 | ${secondId}
      ${'order_error'}        | ${notifyErroredOrders}   | ${firstId}                 | ${secondId}
      ${'order_complete'}     | ${notifyCompletedOrders} | ${firstId}                 | ${secondId}
      ${'roundtrip_complete'} | ${notifyRoundTrips}      | ${`At time: ${firstExit}`} | ${`At time: ${secondExit}`}
    `('$event notifications', ({ event, notifyTwice, first, second }) => {
      it('are sent one per payload, in payload order', async () => {
        plugin['handleCommand'](`/sub_${event}`);
        notifyTwice(plugin);
        await settle();
        expect(fakeBot.sendMessage.mock.calls).toEqual([[expect.stringContaining(first)], [expect.stringContaining(second)]]);
      });

      // The flush of the deferred events, and so the next bucket (the candles, the orders), waits for the handler: it must not wait
      // for Telegram
      it('are sent in the background: the handler returns while Telegram does not answer', async () => {
        plugin['handleCommand'](`/sub_${event}`);
        fakeBot.sendMessage.mockReturnValue(new Promise(() => {})); // A black-holed network: no send ever settles
        const handled = Promise.resolve(notifyTwice(plugin)).then(() => 'returned');
        const outcome = await Promise.race([handled, settle().then(() => 'still waiting')]);
        expect(outcome).toBe('returned');
      });

      it('are sent one at a time, the second once the first is out', async () => {
        plugin['handleCommand'](`/sub_${event}`);
        const firstSend = Promise.withResolvers<void>();
        fakeBot.sendMessage.mockReturnValueOnce(firstSend.promise);
        notifyTwice(plugin);
        await settle();
        const sendsWhileFirstGoesOut = fakeBot.sendMessage.mock.calls.length;
        firstSend.resolve();
        await settle();
        expect(sendsWhileFirstGoesOut).toBe(1);
      });

      it('that fail are logged as warnings naming their event', async () => {
        plugin['handleCommand'](`/sub_${event}`);
        fakeBot.sendMessage.mockRejectedValueOnce(new Error('HTTP 429 Too Many Requests: retry after 5'));
        notifyTwice(plugin);
        await settle();
        expect(warning).toHaveBeenCalledWith(
          'event subscriber',
          `The ${event} notification was not sent: HTTP 429 Too Many Requests: retry after 5. ` +
            'Until a notification goes out again, the next failures are logged at debug level',
        );
      });

      it('go on after one that failed', async () => {
        plugin['handleCommand'](`/sub_${event}`);
        fakeBot.sendMessage.mockRejectedValueOnce(new Error('HTTP 429 Too Many Requests: retry after 5'));
        notifyTwice(plugin);
        await settle();
        expect(fakeBot.sendMessage).toHaveBeenNthCalledWith(2, expect.stringContaining(second));
      });

      it('are not sent while the chat is subscribed to every other event only', async () => {
        EVENT_NAMES.filter(name => name !== event).forEach(name => plugin['handleCommand'](`/sub_${name}`));
        notifyTwice(plugin);
        await settle();
        expect(fakeBot.sendMessage).not.toHaveBeenCalled();
      });
    });

    describe('while a message goes out', () => {
      let firstSend: PromiseWithResolvers<void>;

      beforeEach(() => {
        plugin['handleCommand']('/subscribe_all');
        firstSend = Promise.withResolvers<void>();
        fakeBot.sendMessage.mockReturnValueOnce(firstSend.promise);
      });

      // In the flush, the handlers of consecutive batches run one after the other, each returning at once: the messages of the
      // second batch wait for those of the first
      it('sends the messages of the next batch, of another event, once those of the first are out', async () => {
        notifyAdviceOrders(plugin);
        notifyInitiatedOrders(plugin);
        await settle();
        const sendsWhileFirstGoesOut = fakeBot.sendMessage.mock.calls.length;
        firstSend.resolve();
        await settle();
        expect(sendsWhileFirstGoesOut).toBe(1);
      });

      it('sends the messages of consecutive batches in the order they came', async () => {
        notifyAdviceOrders(plugin);
        notifyInitiatedOrders(plugin);
        firstSend.resolve();
        await settle();
        expect(fakeBot.sendMessage.mock.calls).toEqual([
          [expect.stringContaining(`Order Id: ${firstId}`)],
          [expect.stringContaining(`Order Id: ${secondId}`)],
          [expect.stringContaining(`order created (${firstId})`)],
          [expect.stringContaining(`order created (${secondId})`)],
        ]);
      });

      // A notification goes out only if the chat is subscribed to its event when the event arrives, and still is when its turn
      // comes: here /unsubscribe_all arrives while the first message goes out, the second waiting
      it('drops the waiting notifications of an event the chat unsubscribes from', async () => {
        notifyAdviceOrders(plugin);
        plugin['handleCommand']('/unsubscribe_all');
        firstSend.resolve();
        await settle();
        expect(fakeBot.sendMessage).toHaveBeenCalledTimes(1);
      });

      it('does not send an event that arrived before the chat subscribed to it', async () => {
        plugin['handleCommand']('/sub_strat_cancel'); // A toggle: unsubscribes
        notifyAdviceOrders(plugin);
        notifyCancelRequests(plugin);
        plugin['handleCommand']('/sub_strat_cancel');
        firstSend.resolve();
        await settle();
        expect(fakeBot.sendMessage).toHaveBeenCalledTimes(2);
      });
    });

    // Strategy logs told apart by their texts, n0, n1..., which are the second lines of their messages
    const strategyInfos = (from: number, to: number) => range(from, to).map(i => makeStrategyInfo({ message: `n${i}` }));
    const messages = (...ranges: [number, number][]) => ranges.flatMap(([from, to]) => range(from, to).map(i => `n${i}`));
    const sentMessages = () => fakeBot.sendMessage.mock.calls.map(([text]) => text.split('\n')[1]);
    const dropped = 'The strat_info notification was dropped: the queue of 1000 notifications waiting for Telegram is full';
    const droppedFirst =
      `${dropped} (a burst, or Telegram not answering). ` + 'Until it empties, each new one drops the oldest, logged at debug level';

    // Telegram slow or unreachable (each send then takes every attempt of the fetcher, about two minutes), the notifications pile up
    describe('when notifications pile up', () => {
      let firstSend: PromiseWithResolvers<void>;

      // n0 goes out and Telegram does not answer yet: n1 to n1000 wait, which fills the queue
      beforeEach(() => {
        plugin['handleCommand']('/sub_strat_info');
        firstSend = Promise.withResolvers<void>();
        fakeBot.sendMessage.mockReturnValueOnce(firstSend.promise);
        plugin.onStrategyInfo(strategyInfos(0, 1001));
      });

      it.each`
        newOnes | sent
        ${0}    | ${messages([0, 1001])}
        ${1}    | ${messages([0, 1], [2, 1002])}
        ${3}    | ${messages([0, 1], [4, 1004])}
      `('drops the oldest waiting notification for each of $newOnes new ones', async ({ newOnes, sent }) => {
        plugin.onStrategyInfo(strategyInfos(1001, 1001 + newOnes));
        firstSend.resolve();
        await settle();
        expect(sentMessages()).toEqual(sent);
      });

      // Once per backlog: the warnings go to Telegram too, in Supervision's log batches, and a long outage would flood them
      it.each`
        newOnes | level        | drops
        ${0}    | ${'warning'} | ${0}
        ${3}    | ${'warning'} | ${1}
        ${3}    | ${'debug'}   | ${2}
      `('logs $drops drops at $level level for $newOnes new ones', ({ newOnes, level, drops }) => {
        plugin.onStrategyInfo(strategyInfos(1001, 1001 + newOnes));
        expect({ warning, debug }[level as 'warning' | 'debug']).toHaveBeenCalledTimes(drops);
      });

      it('warns of the first drop that the queue is full', () => {
        plugin.onStrategyInfo(strategyInfos(1001, 1002));
        expect(warning).toHaveBeenCalledWith('event subscriber', droppedFirst);
      });

      it('logs the next drops at debug level', () => {
        plugin.onStrategyInfo(strategyInfos(1001, 1003));
        expect(debug).toHaveBeenCalledWith('event subscriber', dropped);
      });

      // Telegram answers, but falls behind again before the queue is empty: the same backlog
      it('logs the drops at debug level until the queue has been emptied', async () => {
        plugin.onStrategyInfo(strategyInfos(1001, 1002)); // Drops n1
        fakeBot.sendMessage.mockReturnValueOnce(new Promise(() => {}));
        firstSend.resolve(); // n2 goes out and Telegram does not answer: n3 to n1001 wait
        await settle();
        plugin.onStrategyInfo(strategyInfos(1002, 1004)); // n1003 drops n3
        expect(warning).toHaveBeenCalledTimes(1);
      });

      it('warns again when the queue overflows once it has been emptied', async () => {
        plugin.onStrategyInfo(strategyInfos(1001, 1002)); // Drops n1
        firstSend.resolve();
        await settle();
        fakeBot.sendMessage.mockReturnValueOnce(new Promise(() => {}));
        // n2000 goes out and Telegram does not answer: n2001 to n3000 wait, n3001 drops n2001
        plugin.onStrategyInfo(strategyInfos(2000, 3002));
        expect(warning).toHaveBeenCalledTimes(2);
      });
    });

    // A grid strategy placing its orders in one loop queues their notifications in one flush, during which no send ends (no handler
    // waits on the network): Telegram answers, but not before the whole burst is queued
    describe('when 1001 notifications come in one call while another one goes out', () => {
      let firstSend: PromiseWithResolvers<void>;

      beforeEach(() => {
        plugin['handleCommand']('/sub_strat_info');
        firstSend = Promise.withResolvers<void>();
        fakeBot.sendMessage.mockReturnValueOnce(firstSend.promise);
        plugin.onStrategyInfo([makeStrategyInfo({ message: 'before' })]);
        plugin.onStrategyInfo(strategyInfos(0, 1001)); // n1000 drops n0
      });

      it('drops exactly the oldest of them', async () => {
        firstSend.resolve();
        await settle();
        expect(sentMessages()).toEqual(['before', ...messages([1, 1001])]);
      });

      it.each`
        level        | drops
        ${'warning'} | ${1}
        ${'debug'}   | ${0}
      `('logs $drops drops at $level level', ({ level, drops }) => {
        expect({ warning, debug }[level as 'warning' | 'debug']).toHaveBeenCalledTimes(drops);
      });

      it('warns of the drop that the queue is full', () => {
        expect(warning).toHaveBeenCalledWith('event subscriber', droppedFirst);
      });
    });

    // A failure that will not pass (a 403 for a blocked bot, a 400 for a chat not found, a 429 asking to wait more than a minute) is
    // thrown by the fetcher at once, and every notification queued then fails in turn, instantly: one warning per streak of failures,
    // since the warnings go to Telegram too, in Supervision's log batches
    describe('when sends fail in a row', () => {
      const blocked = 'HTTP 403 Forbidden: Forbidden: bot was blocked by the user';
      const notSent = `The strat_cancel notification was not sent: ${blocked}`;
      const failNextSends = (count: number) => range(count).forEach(() => fakeBot.sendMessage.mockRejectedValueOnce(new Error(blocked)));
      const requestCancels = (count: number) => plugin.onStrategyCancelOrder(range(count).map(() => cancelRequest(firstId)));

      beforeEach(() => {
        plugin['handleCommand']('/sub_strat_cancel');
      });

      it.each`
        level        | failures
        ${'warning'} | ${1}
        ${'debug'}   | ${2}
      `('logs $failures of 3 failures in a row at $level level', async ({ level, failures }) => {
        failNextSends(3);
        requestCancels(3);
        await settle();
        expect({ warning, debug }[level as 'warning' | 'debug']).toHaveBeenCalledTimes(failures);
      });

      it('warns of the first failure that the next ones are logged at debug level', async () => {
        failNextSends(3);
        requestCancels(3);
        await settle();
        expect(warning).toHaveBeenCalledWith(
          'event subscriber',
          `${notSent}. Until a notification goes out again, the next failures are logged at debug level`,
        );
      });

      it('logs the next failures at debug level', async () => {
        failNextSends(3);
        requestCancels(3);
        await settle();
        expect(debug).toHaveBeenCalledWith('event subscriber', notSent);
      });

      // Not once the queue is empty: a bot blocked for hours would warn of every notification, however far apart
      it('logs at debug level a failure after the queue emptied, while no send has gone through since the last one', async () => {
        failNextSends(2);
        requestCancels(1);
        await settle();
        requestCancels(1);
        await settle();
        expect(debug).toHaveBeenCalledTimes(1);
      });

      it.each`
        failures | line
        ${1}     | ${'Notifications go out again, after 1 failure'}
        ${3}     | ${'Notifications go out again, after 3 failures'}
      `('logs at info level, once one goes out, that the $failures before it failed', async ({ failures, line }) => {
        failNextSends(failures);
        requestCancels(failures + 1);
        await settle();
        expect(info).toHaveBeenCalledWith('event subscriber', line);
      });

      it('logs nothing at info level while no send fails', async () => {
        requestCancels(2);
        await settle();
        expect(info).not.toHaveBeenCalled();
      });

      it('warns again of a failure once a send has gone through', async () => {
        failNextSends(3);
        requestCancels(4); // The fourth goes through
        await settle();
        failNextSends(1);
        requestCancels(1);
        await settle();
        expect(warning).toHaveBeenCalledTimes(2);
      });
    });

    describe('at the end of the run', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      it('is over at once when no notification is pending', async () => {
        let isFinalized = false;
        plugin['processFinalize']().then(() => (isFinalized = true));
        await vi.advanceTimersByTimeAsync(0);
        expect(isFinalized).toBe(true);
      });

      describe('with notifications pending', () => {
        let firstSend: PromiseWithResolvers<void>;
        let finalization: Promise<void>;
        let isFinalized: boolean;

        // The first goes out and Telegram does not answer yet: the second waits
        beforeEach(() => {
          plugin['handleCommand']('/sub_strat_create');
          firstSend = Promise.withResolvers<void>();
          fakeBot.sendMessage.mockReturnValueOnce(firstSend.promise);
          notifyAdviceOrders(plugin);
          isFinalized = false;
          finalization = plugin['processFinalize']().then(() => {
            isFinalized = true;
          });
        });

        it.each`
          outcome      | answer
          ${'sent'}    | ${(s: PromiseWithResolvers<void>) => s.resolve()}
          ${'refused'} | ${(s: PromiseWithResolvers<void>) => s.reject(new Error('HTTP 403 Forbidden: bot was blocked by the user'))}
        `('is over once they are out, the first one $outcome', async ({ answer }) => {
          answer(firstSend);
          await vi.advanceTimersByTimeAsync(0);
          expect(isFinalized).toBe(true);
        });

        it.each`
          elapsed  | finalization       | expected
          ${14999} | ${'still waiting'} | ${false}
          ${15000} | ${'over'}          | ${true}
        `('is $finalization $elapsed ms after it started while Telegram does not answer', async ({ elapsed, expected }) => {
          await vi.advanceTimersByTimeAsync(elapsed);
          expect(isFinalized).toBe(expected);
        });

        it('sends the waiting notifications before it is over', async () => {
          firstSend.resolve();
          await finalization;
          expect(fakeBot.sendMessage).toHaveBeenCalledTimes(2);
        });

        it('leaves no timer behind once they are out', async () => {
          firstSend.resolve();
          await finalization;
          expect(vi.getTimerCount()).toBe(0);
        });

        it('logs a warning when it gives them up', async () => {
          await vi.advanceTimersByTimeAsync(15000);
          expect(warning).toHaveBeenCalledWith('event subscriber', '2 notifications given up: not sent within 15 s');
        });

        // Until the process exits: Telegram may still answer
        it('lets the ones it gave up go out in the background', async () => {
          await vi.advanceTimersByTimeAsync(15000);
          firstSend.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(fakeBot.sendMessage).toHaveBeenCalledTimes(2);
        });
      });

      it('names a single notification given up in the singular', async () => {
        plugin['handleCommand']('/sub_strat_cancel');
        fakeBot.sendMessage.mockReturnValueOnce(new Promise(() => {}));
        plugin.onStrategyCancelOrder([cancelRequest(firstId)]);
        plugin['processFinalize']();
        await vi.advanceTimersByTimeAsync(15000);
        expect(warning).toHaveBeenCalledWith('event subscriber', '1 notification given up: not sent within 15 s');
      });

      // No event is delivered once it has started (PluginsStream waits for the bucket in flight before it finalises the plugins), but
      // the wait stays defensive: a notification queued while no loop runs starts another one, with its own promise
      describe('with a notification queued once it has started', () => {
        let finalization: Promise<void>;
        let isFinalized: boolean;
        const finalize = () => {
          isFinalized = false;
          finalization = plugin['processFinalize']().then(() => {
            isFinalized = true;
          });
        };
        // Queues a cancel request as the loop sending the first one ends, before the wait looks again: registered before the wait, on
        // the promise of that loop, its callback runs first
        const requestCancelAsTheLoopEnds = () => plugin['sending'].then(() => plugin.onStrategyCancelOrder([cancelRequest(secondId)]));

        beforeEach(() => {
          plugin['handleCommand']('/sub_strat_cancel');
        });

        it('waits for one queued right after it started, while none was being sent', async () => {
          fakeBot.sendMessage.mockReturnValueOnce(new Promise(() => {}));
          finalize();
          plugin.onStrategyCancelOrder([cancelRequest(firstId)]);
          await vi.advanceTimersByTimeAsync(0);
          expect(isFinalized).toBe(false);
        });

        it('waits for one queued as the loop it was waiting for ended', async () => {
          const firstSend = Promise.withResolvers<void>();
          fakeBot.sendMessage.mockReturnValueOnce(firstSend.promise).mockReturnValueOnce(new Promise(() => {}));
          plugin.onStrategyCancelOrder([cancelRequest(firstId)]);
          requestCancelAsTheLoopEnds();
          finalize();
          firstSend.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(isFinalized).toBe(false);
        });

        // One deadline for the whole wait, not one per loop: the first send is answered after 10 s, the next one never
        it.each`
          elapsed  | finalization       | expected
          ${14999} | ${'still waiting'} | ${false}
          ${15000} | ${'over'}          | ${true}
        `('is $finalization $elapsed ms after it started, when the loop it waited for ended at 10 s', async ({ elapsed, expected }) => {
          fakeBot.sendMessage
            .mockReturnValueOnce(new Promise<void>(resolve => setTimeout(resolve, 10000)))
            .mockReturnValueOnce(new Promise(() => {}));
          plugin.onStrategyCancelOrder([cancelRequest(firstId)]);
          requestCancelAsTheLoopEnds();
          finalize();
          await vi.advanceTimersByTimeAsync(elapsed);
          expect(isFinalized).toBe(expected);
        });

        it('gives up the one queued as the loop it was waiting for ended', async () => {
          fakeBot.sendMessage.mockReturnValueOnce(Promise.resolve()).mockReturnValueOnce(new Promise(() => {}));
          plugin.onStrategyCancelOrder([cancelRequest(firstId)]);
          requestCancelAsTheLoopEnds();
          finalize();
          await vi.advanceTimersByTimeAsync(15000);
          expect(warning).toHaveBeenCalledWith('event subscriber', '1 notification given up: not sent within 15 s');
        });

        it('leaves no timer behind once the one queued meanwhile is out', async () => {
          const firstSend = Promise.withResolvers<void>();
          fakeBot.sendMessage.mockReturnValueOnce(firstSend.promise);
          plugin.onStrategyCancelOrder([cancelRequest(firstId)]);
          requestCancelAsTheLoopEnds();
          finalize();
          firstSend.resolve();
          await finalization;
          expect(vi.getTimerCount()).toBe(0);
        });
      });

      // The loop never rejects (sendPending catches every failure), but whatever ends the wait, its timer must not be left pending: it
      // would keep a process that ends normally alive until it fires
      it('leaves no timer behind when the loop it waits for rejects', async () => {
        plugin['isSending'] = true;
        plugin['sending'] = Promise.reject(new Error('Unexpected'));
        await plugin['processFinalize']().catch(() => {});
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    // inspect(), not String(), which throws for a value without a prototype: the warning would fail and the loop reject. A string as it
    // is, which inspect() quoted.
    it.each`
      failure                          | rejection                                              | reason
      ${'a value without a prototype'} | ${Object.assign(Object.create(null), { status: 503 })} | ${'[Object: null prototype] { status: 503 }'}
      ${'a string'}                    | ${'socket hang up'}                                    | ${'socket hang up'}
    `('logs a notification not sent for a rejection with $failure: $reason', async ({ rejection, reason }) => {
      plugin['handleCommand']('/sub_strat_cancel');
      fakeBot.sendMessage.mockRejectedValueOnce(rejection);
      notifyCancelRequests(plugin);
      await settle();
      expect(warning).toHaveBeenCalledWith(
        'event subscriber',
        `The strat_cancel notification was not sent: ${reason}. Until a notification goes out again, the next failures are logged at debug level`,
      );
    });

    // Its message is built from its payload when it arrives: a payload that cannot be read is a notification not sent, not a handler
    // that throws, which would end the run
    describe('with a payload that cannot be read', () => {
      const notifyUnreadableFirst = (p: EventSubscriber) =>
        p.onOrderInitiated([
          makeOrderInitiatedEvent({ order: { symbol: undefined } }),
          makeOrderInitiatedEvent({ order: { id: secondId } }),
        ]);

      beforeEach(() => {
        plugin['handleCommand']('/sub_order_init');
      });

      it('does not throw', () => {
        expect(() => notifyUnreadableFirst(plugin)).not.toThrow();
      });

      it('logs its notification as not sent', () => {
        notifyUnreadableFirst(plugin);
        expect(warning).toHaveBeenCalledWith('event subscriber', expect.stringMatching(/^The order_init notification was not sent: /));
      });

      it('sends the other notifications of its batch', async () => {
        notifyUnreadableFirst(plugin);
        await settle();
        expect(fakeBot.sendMessage.mock.calls).toEqual([[expect.stringContaining(secondId)]]);
      });
    });

    // The second message goes out once the first is, here 5 s later: it still shows when the requests arrived
    it('shows when the cancel requests arrived', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: eventTimestamp });
      plugin['handleCommand']('/sub_strat_cancel');
      const firstSend = Promise.withResolvers<void>();
      fakeBot.sendMessage.mockReturnValueOnce(firstSend.promise);
      notifyCancelRequests(plugin);
      vi.setSystemTime(eventTimestamp + 5000);
      firstSend.resolve();
      await settle();
      expect(fakeBot.sendMessage).toHaveBeenLastCalledWith(
        ['Strategy requested order cancellation for BTC/USD', `Order Id: ${secondId}`, 'At time: 2022-01-01T00:00:00.000Z'].join('\n'),
      );
    });

    // The StrategyManager names the pair of an order it created and that has not ended, and knows no other (see AdviceCancelOrder)
    it.each`
      request                    | line
      ${{ id: firstId, symbol }} | ${'Strategy requested order cancellation for BTC/USD'}
      ${{ id: firstId }}         | ${'Strategy requested order cancellation for an order it did not create, or that had ended'}
    `('opens the notification of a cancel request with "$line"', async ({ request, line }) => {
      plugin['handleCommand']('/sub_strat_cancel');
      plugin.onStrategyCancelOrder([request]);
      await settle();
      expect(fakeBot.sendMessage.mock.calls[0][0].split('\n')[0]).toBe(line);
    });

    // The Trader places an advice of any type at its price, or without one (none given, or an indicator still null) at the market
    // price (advice.price ?? the last close): a LIMIT advice with a price requests it as its limit, any other targets that price
    it.each`
      type        | price        | line
      ${'LIMIT'}  | ${123}       | ${'Requested limit price: 123 USD'}
      ${'LIMIT'}  | ${undefined} | ${'Target price: 42 USD'}
      ${'LIMIT'}  | ${null}      | ${'Target price: 42 USD'}
      ${'STICKY'} | ${123}       | ${'Target price: 123 USD'}
      ${'STICKY'} | ${undefined} | ${'Target price: 42 USD'}
      ${'MARKET'} | ${123}       | ${'Target price: 123 USD'}
      ${'MARKET'} | ${undefined} | ${'Target price: 42 USD'}
    `('reports $line for a $type advice with a price of $price', async ({ type, price, line }) => {
      plugin['processOneMinuteBucket'](new Map([[symbol, { close: 42 }]]) as any);
      plugin['handleCommand']('/sub_strat_create');
      onStrategyCreateOrder(plugin, { type, price });
      await settle();
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining(`\n${line}\n`));
    });

    it('reports an unknown target price for an advice without a price, before any price of its pair is known', async () => {
      plugin['handleCommand']('/sub_strat_create');
      onStrategyCreateOrder(plugin, { type: 'MARKET', price: undefined });
      await settle();
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('\nTarget price: unknown USD\n'));
    });

    // The Trader sizes an advice from the amount the strategy gave, else from its cost or its share of a balance, else all-in: the line
    // says which the strategy asked for, a cost in the currency, a share with its base, the currency a BUY spends or the asset a SELL
    // sells. An untyped strategy may give null for any of them, which createOrder relays and the Trader reads as left out.
    it.each`
      side      | sizing                                  | sizes                                             | line
      ${'BUY'}  | ${'all-in'}                             | ${{ amount: undefined }}                          | ${'Requested amount: auto'}
      ${'SELL'} | ${'all-in, its sizes null'}             | ${{ amount: null, cost: null, allocation: null }} | ${'Requested amount: auto'}
      ${'SELL'} | ${'by an amount'}                       | ${{ amount: 3 }}                                  | ${'Requested amount: 3'}
      ${'BUY'}  | ${'by an amount, its other sizes null'} | ${{ amount: 3, cost: null, allocation: null }}    | ${'Requested amount: 3'}
      ${'BUY'}  | ${'by a cost'}                          | ${{ amount: undefined, cost: 100 }}               | ${'Requested amount: 100 USD worth'}
      ${'SELL'} | ${'by a cost, its thousands grouped'}   | ${{ amount: undefined, cost: 1234.5 }}            | ${'Requested amount: 1,234.5 USD worth'}
      ${'BUY'}  | ${'by an allocation of the currency'}   | ${{ amount: undefined, allocation: 25 }}          | ${'Requested amount: 25 % of the USD'}
      ${'SELL'} | ${'by an allocation of the asset'}      | ${{ amount: undefined, allocation: 100 / 3 }}     | ${'Requested amount: 33.33333333 % of the BTC'}
      ${'BUY'}  | ${'by a cost, its other sizes null'}    | ${{ amount: null, cost: 0.5, allocation: null }}  | ${'Requested amount: 0.5 USD worth'}
    `('writes "$line" for a $side advice sized $sizing', async ({ side, sizes, line }) => {
      plugin['handleCommand']('/sub_strat_create');
      onStrategyCreateOrder(plugin, { side, ...sizes });
      await settle();
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining(`\n${line}\n`));
    });

    it('lists the lines of an advice sized by an allocation', async () => {
      plugin['processOneMinuteBucket'](new Map([[symbol, { close: 42 }]]) as any);
      plugin['handleCommand']('/sub_strat_create');
      onStrategyCreateOrder(plugin, { side: 'SELL', type: 'MARKET', amount: undefined, allocation: 50, price: undefined });
      await settle();
      expect(fakeBot.sendMessage).toHaveBeenCalledExactlyOnceWith(
        [
          `Order Id: ${baseOrder.id}`,
          'Received MARKET SELL advice for BTC/USD',
          'Requested amount: 50 % of the BTC',
          'At time: 2022-01-01T00:00:00.000Z',
          'Target price: 42 USD',
          '------',
        ].join('\n'),
      );
    });

    it('formats strategy advice message with order metadata', () => {
      fakeBot.sendMessage.mockReset();
      plugin['handleCommand']('/sub_strat_create');
      onStrategyCreateOrder(plugin, { type: 'MARKET', side: 'SELL', amount: 3 });
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('MARKET SELL advice'));
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Requested amount: 3'));
    });

    it('reports trade initiation details including order type and requested amount', () => {
      const portfolio = new Map<string, BalanceDetail>();
      portfolio.set('BTC', { free: 1, used: 0, total: 1 });
      portfolio.set('USDT', { free: 2, used: 0, total: 2 });
      fakeBot.sendMessage.mockReset();
      plugin['handleCommand']('/sub_order_init');
      onOrderInitiated(plugin, {
        order: { type: 'MARKET', amount: 5, price: 321 },
        exchange: {
          balance: { free: 10, used: 0, total: 10 },
          portfolio,
        },
      });
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('MARKET order created (ee21e130-48bc-405f-be0c-46e9bf17b52e)'),
      );
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Requested amount: 5'));
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('Requested limit price: 321 USD'));
    });

    // An order leaves its fill and what remains out when no answer of the exchange reported a fill: printed as they were, both read
    // "undefined". 0 filled is a fact, reported as such.
    it.each`
      filled       | remaining    | line
      ${1}         | ${1}         | ${'Filled amount: 1 / 2 BTC'}
      ${1}         | ${1}         | ${'Remaining amount: 1 BTC'}
      ${0}         | ${2}         | ${'Filled amount: 0 / 2 BTC'}
      ${0}         | ${2}         | ${'Remaining amount: 2 BTC'}
      ${undefined} | ${undefined} | ${'Filled amount: not reported / 2 BTC'}
    `('reports "$line" for a canceled order of 2 that filled $filled', async ({ filled, remaining, line }) => {
      plugin['handleCommand']('/sub_order_cancel');
      onOrderCanceled(plugin, { order: { type: 'LIMIT', side: 'SELL', amount: 2, filled, remaining, price: 999 } });
      await settle();
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining(`\n${line}\n`));
    });

    it('reports no remaining amount for a canceled order whose fill no answer of the exchange reported', async () => {
      plugin['handleCommand']('/sub_order_cancel');
      onOrderCanceled(plugin, { order: { amount: 2, filled: undefined, remaining: undefined } });
      await settle();
      expect(fakeBot.sendMessage).not.toHaveBeenCalledWith(expect.stringContaining('Remaining amount'));
    });

    // An order without a price (a MARKET or a STICKY one) is priced at the last close of its pair
    it.each`
      event             | notify                                                                          | line
      ${'order_init'}   | ${(p: EventSubscriber) => onOrderInitiated(p, { order: { price: undefined } })} | ${'Target price: 42 USD'}
      ${'order_cancel'} | ${(p: EventSubscriber) => onOrderCanceled(p, { order: { price: undefined } })}  | ${'Current price: 42 USD'}
    `('writes "$line" in the $event notification of an order without a price', async ({ event, notify, line }) => {
      plugin['processOneMinuteBucket'](new Map([[symbol, { close: 42 }]]) as any);
      plugin['handleCommand'](`/sub_${event}`);
      notify(plugin);
      await settle();
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining(`\n${line}\n`));
    });

    it('reports the limit price of a canceled LIMIT order', async () => {
      plugin['handleCommand']('/sub_order_cancel');
      onOrderCanceled(plugin, { order: { type: 'LIMIT', side: 'SELL', amount: 2, filled: 1, remaining: 1, price: 999 } });
      await settle();
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('\nRequested limit price: 999 USD\n'));
    });

    // Nothing follows an order once it errored: one that may still be live is to be checked on the exchange, where it may fill
    describe('the message of an errored order', () => {
      const HEAD = [`BUY STICKY order errored (${baseOrder.id}) for BTC/USD`, 'Due to r'];
      const MAY_BE_LIVE = 'It may still be live on the exchange, where Gekko follows it no more: check it there';
      const TAIL = ['At time: 2022-01-01T00:00:00.000Z', 'Requested amount: 1', 'Current price: 42 USD', '------'];

      it.each`
        mayBeLive | case                                   | lines
        ${true}   | ${'may still be live on the exchange'} | ${[...HEAD, MAY_BE_LIVE, ...TAIL]}
        ${false}  | ${'was refused'}                       | ${[...HEAD, ...TAIL]}
      `('reports an order that $case', async ({ mayBeLive, lines }) => {
        plugin['processOneMinuteBucket'](new Map([[symbol, { close: 42 }]]) as any);
        plugin['handleCommand']('/sub_order_error');
        plugin.onOrderErrored([makeOrderErroredEvent({ order: { mayBeLive } })]);
        await settle();
        expect(fakeBot.sendMessage).toHaveBeenCalledExactlyOnceWith(lines.join('\n'));
      });
    });

    // An unknown fee rate (undefined since createOrderSummary averages only the rates the trades report, never defaulted to 0) must
    // not read as a 0% fee; a known rate, 0 included, is shown as a percentage
    it.each`
      feePercent   | expected
      ${0.1}       | ${'0.1%'}
      ${0}         | ${'0%'}
      ${undefined} | ${'unknown'}
      ${null}      | ${'unknown'}
      ${NaN}       | ${'unknown'}
      ${Infinity}  | ${'unknown'}
    `('reports a fee percent of $feePercent as $expected when an order completes', async ({ feePercent, expected }) => {
      plugin['handleCommand']('/sub_order_complete');
      onOrderCompleted(plugin, { order: { feePercent } });
      await settle();
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining(`\nFee percent: ${expected}\n`));
    });

    // Without a fee rate the Trader assumes no fee (computeOrderPricing) and sends a fee of 0 with the bare trade price: the fee must
    // not read as 0 nor the price as fee included; a known rate, 0 included, keeps the fee and the effective price as they are
    it.each`
      feePercent   | effectivePrice | fee    | line
      ${0.1}       | ${100.1}       | ${0.1} | ${'Price: 100.1 USD'}
      ${0.1}       | ${100.1}       | ${0.1} | ${'Fee: 0.1 USD'}
      ${0}         | ${100}         | ${0}   | ${'Price: 100 USD'}
      ${0}         | ${100}         | ${0}   | ${'Fee: 0 USD'}
      ${undefined} | ${100}         | ${0}   | ${'Price (excluding fee): 100 USD'}
      ${undefined} | ${100}         | ${0}   | ${'Fee: unknown'}
      ${NaN}       | ${100}         | ${0}   | ${'Price (excluding fee): 100 USD'}
      ${NaN}       | ${100}         | ${0}   | ${'Fee: unknown'}
    `('reports $line when an order completes with a fee percent of $feePercent', async ({ feePercent, effectivePrice, fee, line }) => {
      plugin['handleCommand']('/sub_order_complete');
      onOrderCompleted(plugin, { order: { feePercent, effectivePrice, fee } });
      await settle();
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining(`\n${line}\n`));
    });

    // The amounts, prices and balances of a notification are written as those of the other outputs (see formatAmount): their thousands
    // grouped, up to 8 decimals, never with an exponent. Written by String, a dust amount read 1.2e-7, and a sum its binary noise. A fee
    // rate keeps its decimals too: rounded to 2 as the percentages of a report are, 0.075 % would read 0.07 %.
    describe('figures written as amounts', () => {
      const dust = 0.00000012;
      const balances = new Map<string, BalanceDetail>([
        ['BTC', { free: dust, used: 0, total: dust }],
        ['USD', { free: 47500, used: 0, total: 47500 }],
      ]);

      it.each`
        event               | notify                                                                                             | line
        ${'strat_create'}   | ${(p: EventSubscriber) => onStrategyCreateOrder(p, { amount: dust })}                              | ${'Requested amount: 0.00000012'}
        ${'strat_create'}   | ${(p: EventSubscriber) => onStrategyCreateOrder(p, { type: 'LIMIT', price: 42500 })}               | ${'Requested limit price: 42,500 USD'}
        ${'strat_create'}   | ${(p: EventSubscriber) => onStrategyCreateOrder(p, { type: 'MARKET', price: 0.1 + 0.2 })}          | ${'Target price: 0.3 USD'}
        ${'order_init'}     | ${(p: EventSubscriber) => onOrderInitiated(p, { order: { amount: dust } })}                        | ${'Requested amount: 0.00000012'}
        ${'order_init'}     | ${(p: EventSubscriber) => onOrderInitiated(p, { exchange: { portfolio: balances } })}              | ${'Current symbol portfolio: 0.00000012 BTC / 47,500 USD'}
        ${'order_cancel'}   | ${(p: EventSubscriber) => onOrderCanceled(p, { order: { filled: dust, remaining: 1 } })}           | ${'Filled amount: 0.00000012 / 1 BTC'}
        ${'order_error'}    | ${(p: EventSubscriber) => p.onOrderErrored([makeOrderErroredEvent({ order: { amount: 47500 } })])} | ${'Requested amount: 47,500'}
        ${'order_complete'} | ${(p: EventSubscriber) => onOrderCompleted(p, { order: { amount: dust } })}                        | ${'Amount: 0.00000012 BTC'}
        ${'order_complete'} | ${(p: EventSubscriber) => onOrderCompleted(p, { order: { effectivePrice: 42542.5 } })}             | ${'Price: 42,542.5 USD'}
        ${'order_complete'} | ${(p: EventSubscriber) => onOrderCompleted(p, { order: { feePercent: 0.075 } })}                   | ${'Fee percent: 0.075%'}
        ${'order_complete'} | ${(p: EventSubscriber) => onOrderCompleted(p, { exchange: { portfolio: balances } })}              | ${'Current portfolio: 0.00000012 BTC / 47,500 USD'}
      `('writes "$line" in the $event notification', async ({ event, notify, line }) => {
        plugin['handleCommand'](`/sub_${event}`);
        notify(plugin);
        await settle();
        expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining(`\n${line}\n`));
      });
    });

    // A round trip is written as the console table of the RoundTripAnalyzer writes it: its prices as amounts, its percentages rounded
    // down to 2 decimals (see PERCENT_ROUNDING), its duration on the UTC calendar. Its P&L and profit are unknown (NaN) when no
    // portfolio read valued it: written as they came, they read "PnL: NaN" and "Profit: NaN%".
    describe('the message of a round trip', () => {
      const notifyRoundTrip = async (fields: Partial<RoundTrip>) => {
        plugin['handleCommand']('/sub_roundtrip_complete');
        plugin.onRoundtripCompleted([makeRoundTrip(fields)]);
        await settle();
      };

      it('lists its figures', async () => {
        await notifyRoundTrip({ exitAt: toTimestamp(firstExit) });
        expect(fakeBot.sendMessage).toHaveBeenCalledExactlyOnceWith(
          [
            'Roundtrip completed for BTC/USD',
            'PnL: 100',
            'Profit: 10%',
            'Duration: 1 second',
            'Entry Price: 100',
            'Exit Price: 110',
            'Max Adverse Excursion: 0%',
            `At time: ${firstExit}`,
            '------',
          ].join('\n'),
        );
      });

      it('names the pair of the round trip', async () => {
        await notifyRoundTrip({ symbol: 'ETH/USD' });
        expect(fakeBot.sendMessage.mock.calls[0][0].split('\n')[0]).toBe('Roundtrip completed for ETH/USD');
      });

      it.each`
        description                                | fields                                | line
        ${'an unknown P&L'}                        | ${{ pnl: NaN }}                       | ${'PnL: unknown'}
        ${'an unknown profit'}                     | ${{ profit: NaN }}                    | ${'Profit: unknown'}
        ${'a P&L with its thousands grouped'}      | ${{ pnl: -1234.5678 }}                | ${'PnL: -1,234.5678'}
        ${'a loss rounded down'}                   | ${{ profit: -5.001 }}                 | ${'Profit: -5.01%'}
        ${'a profit on a tie rounded down'}        | ${{ profit: 3.125 }}                  | ${'Profit: 3.12%'}
        ${'an adverse excursion rounded down'}     | ${{ maxAdverseExcursion: 1.005 }}     | ${'Max Adverse Excursion: 1%'}
        ${'an adverse excursion on a tie'}         | ${{ maxAdverseExcursion: 3.125 }}     | ${'Max Adverse Excursion: 3.12%'}
        ${'a mean price without its binary noise'} | ${{ exitPrice: 0.10000000000000002 }} | ${'Exit Price: 0.1'}
        ${'a price of a fraction of a cent'}       | ${{ entryPrice: 0.00000012 }}         | ${'Entry Price: 0.00000012'}
      `('writes $description: $line', async ({ fields, line }) => {
        await notifyRoundTrip(fields);
        expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining(`\n${line}\n`));
      });

      // From epoch 0, on the UTC calendar: on the host's, New York moved its clocks in 1970, and 120 days read "3 months 30 days 1 hour"
      describe.each`
        timeZone
        ${'UTC'}
        ${'Europe/Paris'}
        ${'America/New_York'}
      `('on a host in $timeZone', ({ timeZone }) => {
        useTimeZone(timeZone);

        it('writes a round trip of 120 days as lasting 4 months', async () => {
          await notifyRoundTrip({ duration: 120 * 24 * 60 * ONE_MINUTE });
          expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining('\nDuration: 4 months\n'));
        });
      });
    });

    // What /portfolio answers with: the last portfolio the Trader read, as the events bring it, dated with its reception, since no event
    // says when the Trader read it
    describe('the portfolio it keeps', () => {
      const receivedAt = toTimestamp('2024-01-01T12:00:02Z');
      /** A portfolio the Trader read, told apart from the others by the BTC it holds */
      const read = (btc: number): Portfolio =>
        new Map([
          ['BTC', { free: btc, used: 0, total: btc }],
          ['USD', { free: 100, used: 0, total: 100 }],
        ]);
      const kept = () => ({ portfolio: plugin['portfolio'], portfolioAt: plugin['portfolioAt'] });

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'], now: receivedAt });
      });

      it('keeps the last portfolio of a batch of portfolio changes, dated with its reception', () => {
        plugin.onPortfolioChange([read(1), read(2)]);
        expect(kept()).toEqual({ portfolio: read(2), portfolioAt: receivedAt });
      });

      // A portfolio change is queued as the Trader reads the account: the same balances read again are dated anew
      it('dates anew a portfolio change holding the balances it keeps', () => {
        plugin.onPortfolioChange([read(1)]);
        vi.setSystemTime(receivedAt + ONE_MINUTE);
        plugin.onPortfolioChange([read(1)]);
        expect(plugin['portfolioAt']).toBe(receivedAt + ONE_MINUTE);
      });

      it('keeps its portfolio through an empty batch of portfolio changes', () => {
        plugin.onPortfolioChange([read(1)]);
        plugin.onPortfolioChange([]);
        expect(kept()).toEqual({ portfolio: read(1), portfolioAt: receivedAt });
      });

      // The Trader's portfolioUpdates filter holds a small change back from the portfolio events, that of a fill included: the end of an
      // order carries the read made once the order had ended
      describe.each`
        event               | notifyEnds
        ${'order_cancel'}   | ${(p: EventSubscriber, ends: Portfolio[]) => p.onOrderCanceled(ends.map(portfolio => makeOrderCanceledEvent({ exchange: { portfolio } })))}
        ${'order_error'}    | ${(p: EventSubscriber, ends: Portfolio[]) => p.onOrderErrored(ends.map(portfolio => makeOrderErroredEvent({ exchange: { portfolio } })))}
        ${'order_complete'} | ${(p: EventSubscriber, ends: Portfolio[]) => p.onOrderCompleted(ends.map(portfolio => makeOrderCompletedEvent({ exchange: { portfolio } })))}
      `('on the end of an order ($event)', ({ notifyEnds }) => {
        beforeEach(() => {
          plugin.onPortfolioChange([read(1)]);
          vi.setSystemTime(receivedAt + ONE_MINUTE);
        });

        it('keeps the portfolio it carries, dated with its reception, while the chat is subscribed to nothing', () => {
          notifyEnds(plugin, [read(2)]);
          expect(kept()).toEqual({ portfolio: read(2), portfolioAt: receivedAt + ONE_MINUTE });
        });

        it('keeps the portfolio of the last end of its batch', () => {
          notifyEnds(plugin, [read(2), read(3)]);
          expect(plugin['portfolio']).toEqual(read(3));
        });

        // An end whose read failed, or an order refused before it was placed, carries the last read as it stands: dated anew, it would
        // read as fresh
        it('leaves the date of the balances it keeps', () => {
          notifyEnds(plugin, [read(1)]);
          expect(plugin['portfolioAt']).toBe(receivedAt);
        });

        // The empty portfolio the Trader starts with, until one of its synchronizations succeeds, is no read
        it('leaves out the empty portfolio of a Trader that has read none', () => {
          notifyEnds(plugin, [new Map()]);
          expect(kept()).toEqual({ portfolio: read(1), portfolioAt: receivedAt });
        });

        it('changes nothing on an empty batch', () => {
          notifyEnds(plugin, []);
          expect(kept()).toEqual({ portfolio: read(1), portfolioAt: receivedAt });
        });
      });

      // A handler that throws ends the run
      it.each`
        handler
        ${'onOrderCanceled'}
        ${'onOrderErrored'}
        ${'onOrderCompleted'}
      `('does not throw on an end without its exchange part ($handler)', ({ handler }) => {
        const unreadable = { order: makeOrderCompletedEvent().order } as any;
        expect(() => plugin[handler as 'onOrderCompleted']([unreadable])).not.toThrow();
      });

      // It carries the Trader's last read as it stands, up to exchangeSynchInterval old: dated with its reception, it would read as fresh
      it('changes neither its portfolio nor its date on an order initiated carrying other balances', () => {
        plugin.onPortfolioChange([read(1)]);
        vi.setSystemTime(receivedAt + ONE_MINUTE);
        plugin.onOrderInitiated([makeOrderInitiatedEvent({ exchange: { portfolio: read(2) } })]);
        expect(kept()).toEqual({ portfolio: read(1), portfolioAt: receivedAt });
      });

      it('answers /portfolio with the balances an order end brought, the chat subscribed to nothing', () => {
        plugin.onOrderCompleted([makeOrderCompletedEvent({ exchange: { portfolio: read(2) } })]);
        expect(plugin['handleCommand']('/portfolio').split('\n')[1]).toBe('BTC: 2 (free 2, used 0)');
      });
    });
  });

  describe('commands', () => {
    it.each`
      command
      ${'/foo'}
      ${'/sub_foo'}
    `('answers $command with Unknown command', ({ command }) => {
      expect(plugin['handleCommand'](command)).toBe('Unknown command');
    });

    it.each`
      preSubscribed | expected
      ${false}      | ${'Subscribed to order_init'}
      ${true}       | ${'Unsubscribed from order_init'}
    `('toggles subscription', ({ preSubscribed, expected }) => {
      if (preSubscribed) plugin['handleCommand']('/sub_order_init');
      const res = plugin['handleCommand']('/sub_order_init');
      expect(res).toBe(expected);
    });

    it.each`
      setup                                               | expected
      ${() => undefined}                                  | ${'No subscriptions'}
      ${() => plugin['handleCommand']('/sub_order_init')} | ${'order_init'}
    `('lists subscriptions', ({ setup, expected }) => {
      setup();
      const res = plugin['handleCommand']('/subscriptions');
      expect(res).toContain(expected);
    });

    it.each`
      command             | size
      ${'/subscribe_all'} | ${EVENT_NAMES.length}
    `('subscribes to all', ({ command, size }) => {
      plugin['handleCommand'](command);
      expect(plugin['subscriptions'].size).toBe(size);
    });

    it.each`
      setup                                              | command               | size
      ${() => plugin['handleCommand']('/subscribe_all')} | ${'/unsubscribe_all'} | ${0}
    `('unsubscribes from all', ({ setup, command, size }) => {
      setup();
      plugin['handleCommand'](command);
      expect(plugin['subscriptions'].size).toBe(size);
    });

    it('returns help', () => {
      const res = plugin['handleCommand']('/help');
      expect(res).toBe(`sub_strat_info - Subscribe to strategy logs
sub_strat_create - Notify on strategy order creation
sub_strat_cancel - Notify on strategy order cancellation
sub_order_init - Notify on order initiation
sub_order_cancel - Notify on order cancellation
sub_order_error - Notify on order error
sub_order_complete - Notify on order completion
sub_roundtrip_complete - Notify on roundtrip completion
subscribe_all - Subscribe to all notifications
unsubscribe_all - Unsubscribe from all notifications
subscriptions - View current subscriptions
portfolio - Show the balances, the last prices and the total value
help - Show help information`);
    });

    // Answered at once, from what the plugin holds: the balances the Trader read last as the events brought them, the closes of the
    // last bucket processed, and the total value at those closes
    describe('/portfolio', () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'], now: toTimestamp('2024-01-01T12:00:02Z') });
      });

      it('answers before any portfolio or bucket came that there is none yet', () => {
        expect(plugin['handleCommand']('/portfolio')).toBe(
          [
            'No balance received from the Trader yet (no Trader configured, or its first read still on its way)',
            'No price yet: no 1-minute candle has been processed',
          ].join('\n'),
        );
      });

      // The total value: the 1,000 USD, plus the 0.5 BTC, 0.1 of it reserved by an open order, at 110 (55), plus the 0 ETH at 2,200
      it('answers with the balances of the watched assets and the currency, the closes of the pairs and the total value', () => {
        plugin.onPortfolioChange([
          new Map([
            ['BTC', { free: 0.4, used: 0.1, total: 0.5 }],
            ['ETH', { free: 0, used: 0, total: 0 }],
            ['USD', { free: 1000, used: 0, total: 1000 }],
          ]),
        ]);
        const start = toTimestamp('2024-01-01T12:02:00Z');
        const bucket = new Map([
          ['BTC/USD', { start, close: 110 }],
          ['ETH/USD', { start, close: 2200 }],
        ]);
        plugin['processOneMinuteBucket'](bucket as any);
        vi.setSystemTime(toTimestamp('2024-01-01T12:03:14Z'));
        expect(plugin['handleCommand']('/portfolio')).toBe(
          [
            'Balances read by the Trader, received at 2024-01-01T12:00:02.000Z (3 minutes 12 seconds ago)',
            'BTC: 0.5 (free 0.4, used 0.1)',
            'ETH: 0 (free 0, used 0)',
            'USD: 1,000 (free 1,000, used 0)',
            'Prices at the close of 2024-01-01T12:03:00.000Z',
            'BTC/USD: 110 USD',
            'ETH/USD: 2,200 USD',
            'Total value: 1,055 USD',
          ].join('\n'),
        );
      });

      // Not through the notifications, which wait for a subscription: the bot sends the answer itself
      it('sends nothing through the notifications', async () => {
        plugin['handleCommand']('/portfolio');
        await settle();
        expect(fakeBot.sendMessage).not.toHaveBeenCalled();
      });
    });
  });

  it('getStaticConfiguration returns meta', () => {
    const meta = EventSubscriber.getStaticConfiguration();
    expect(meta).toMatchObject({ schema: eventSubscriberSchema, name: 'EventSubscriber' });
  });

  // The pipeline wires an event to the handler of its name: the portfolio changes reach onPortfolioChange
  it('listens to the portfolio changes', () => {
    expect(EventSubscriber.getStaticConfiguration().eventsHandlers).toContain('onPortfolioChange');
  });
});
