import { ORDER_COMPLETED_EVENT } from '@constants/event.const';
import { ONE_MINUTE, ONE_SECOND } from '@constants/time.const';
import { AdviceCancelOrder, AdviceOrder } from '@models/advice.types';
import {
  ExchangeEvent,
  OrderCanceledEvent,
  OrderCompletedEvent,
  OrderErroredEvent,
  OrderInitiatedEvent,
  RoundTrip,
} from '@models/event.types';
import { BalanceDetail, Portfolio } from '@models/portfolio.types';
import { StrategyInfo } from '@models/strategyInfo.types';
import { Trader } from '@plugins/trader/trader';
import { PortfolioUpdatesConfig } from '@plugins/trader/trader.helper';
import { TelegramBot } from '@services/bots/telegram/TelegramBot';
import { debug, info, warning } from '@services/logger';
import { useTimeZone } from '@utils/date/date.mock';
import { toTimestamp } from '@utils/date/date.utils';
import { range, upperFirst } from 'lodash-es';
import { UUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSubscriber } from './eventSubscriber';
import { eventSubscriberSchema } from './eventSubscriber.schema';
import { EVENT_NAMES } from './eventSubscriber.types';

vi.mock('@services/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));
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

// The orders a real Trader places, in the describe that feeds the subscriber with one: placed at once, they end when the test emits
// their end, filled as they were created
const { orderModule } = vi.hoisted(() => ({
  orderModule: (name: string) => async () => {
    const { EventEmitter } = await import('node:events');
    class Order extends EventEmitter {
      constructor(
        public symbol: string,
        public id: string,
        public side: string,
        public amount: number,
        public price: number,
      ) {
        super();
      }
      launch = async () => undefined;
      cancel = async () => undefined;
      createSummary = async () => ({
        amount: this.amount,
        price: this.price,
        feePercent: 0.1,
        side: this.side,
        orderExecutionDate: Date.now(),
      });
      getFilledAmount = () => 0;
      getAverageFillPrice = () => undefined;
    }
    return { [name]: Order };
  },
}));
vi.mock('@services/core/order/limit/limitOrder', orderModule('LimitOrder'));
vi.mock('@services/core/order/market/marketOrder', orderModule('MarketOrder'));
vi.mock('@services/core/order/sticky/stickyOrder', orderModule('StickyOrder'));

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
      portfolio: new Map<string, BalanceDetail>([
        ['asset', { free: 0, used: 0, total: 0 }],
        ['currency', { free: 0, used: 0, total: 0 }],
      ]),
      portfolioReadAt: eventTimestamp,
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
      cost: 1000,
      proceeds: 1100,
      fees: 0,
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

    // The price of a MARKET order only sized it (a BUY by a cost or an allocation): the order executes at the market, which its advice
    // writes as its target, and so does the notification of its creation
    it('lists the lines of an order created', async () => {
      const portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: 1, used: 0, total: 1 }],
        ['USD', { free: 2, used: 0, total: 2 }],
      ]);
      plugin['handleCommand']('/sub_order_init');
      onOrderInitiated(plugin, { order: { type: 'MARKET', amount: 5, price: 321 }, exchange: { portfolio } });
      await settle();
      expect(fakeBot.sendMessage).toHaveBeenCalledExactlyOnceWith(
        [
          `BUY MARKET order created (${baseOrder.id}) for BTC/USD`,
          'Requested amount: 5',
          'Current symbol portfolio: 1 BTC / 2 USD',
          'Target price: 321 USD',
          'At time: 2022-01-01T00:00:00.000Z',
          '------',
        ].join('\n'),
      );
    });

    // Only a LIMIT order rests at the price it asked for: a MARKET or a STICKY one executes at the market, its price only sizing it.
    // Created, an order is written as its advice was, its price or the last close its target; canceled, the market is quoted beside it.
    // Both labelled any price "Requested limit price", that of a MARKET or a STICKY order too.
    it.each`
      event             | type        | price        | line
      ${'order_init'}   | ${'LIMIT'}  | ${123}       | ${'Requested limit price: 123 USD'}
      ${'order_init'}   | ${'LIMIT'}  | ${undefined} | ${'Target price: 42 USD'}
      ${'order_init'}   | ${'STICKY'} | ${123}       | ${'Target price: 123 USD'}
      ${'order_init'}   | ${'STICKY'} | ${undefined} | ${'Target price: 42 USD'}
      ${'order_init'}   | ${'MARKET'} | ${321}       | ${'Target price: 321 USD'}
      ${'order_init'}   | ${'MARKET'} | ${undefined} | ${'Target price: 42 USD'}
      ${'order_cancel'} | ${'LIMIT'}  | ${999}       | ${'Requested limit price: 999 USD'}
      ${'order_cancel'} | ${'LIMIT'}  | ${undefined} | ${'Current price: 42 USD'}
      ${'order_cancel'} | ${'STICKY'} | ${123}       | ${'Current price: 42 USD'}
      ${'order_cancel'} | ${'STICKY'} | ${undefined} | ${'Current price: 42 USD'}
      ${'order_cancel'} | ${'MARKET'} | ${321}       | ${'Current price: 42 USD'}
    `('writes "$line" in the $event notification of a $type order with a price of $price', async ({ event, type, price, line }) => {
      plugin['processOneMinuteBucket'](new Map([[symbol, { close: 42 }]]) as any);
      plugin['handleCommand'](`/sub_${event}`);
      const overrides = { order: { type, price } };
      if (event === 'order_init') onOrderInitiated(plugin, overrides);
      else onOrderCanceled(plugin, overrides);
      await settle();
      expect(fakeBot.sendMessage).toHaveBeenCalledWith(expect.stringContaining(`\n${line}\n`));
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

    // The mean price of the fills the exchange reported, which the Trader relays for a LIMIT or a STICKY order whose fills it priced, never
    // for a MARKET one (see OrderCanceledEvent.fillPrice): written after the fill, a price above 0 only
    it.each`
      filled       | remaining    | fillPrice          | lines
      ${1}         | ${1}         | ${94.99}           | ${['Filled amount: 1 / 2 BTC', 'Remaining amount: 1 BTC', 'Average fill price: 94.99 USD']}
      ${1}         | ${1}         | ${42500.123456789} | ${['Filled amount: 1 / 2 BTC', 'Remaining amount: 1 BTC', 'Average fill price: 42,500.12345679 USD']}
      ${1}         | ${1}         | ${undefined}       | ${['Filled amount: 1 / 2 BTC', 'Remaining amount: 1 BTC']}
      ${1}         | ${1}         | ${0}               | ${['Filled amount: 1 / 2 BTC', 'Remaining amount: 1 BTC']}
      ${1}         | ${1}         | ${NaN}             | ${['Filled amount: 1 / 2 BTC', 'Remaining amount: 1 BTC']}
      ${undefined} | ${undefined} | ${94.99}           | ${['Filled amount: not reported / 2 BTC']}
    `(
      'writes the fill of a canceled order that filled $filled at $fillPrice as $lines',
      async ({ filled, remaining, fillPrice, lines }) => {
        plugin['handleCommand']('/sub_order_cancel');
        onOrderCanceled(plugin, { order: { type: 'LIMIT', side: 'SELL', amount: 2, filled, remaining, fillPrice, price: 999 } });
        await settle();
        // Between the date and the price line
        expect(fakeBot.sendMessage.mock.calls[0][0].split('\n').slice(2, -2)).toEqual(lines);
      },
    );

    it('reports no remaining amount for a canceled order whose fill no answer of the exchange reported', async () => {
      plugin['handleCommand']('/sub_order_cancel');
      onOrderCanceled(plugin, { order: { amount: 2, filled: undefined, remaining: undefined } });
      await settle();
      expect(fakeBot.sendMessage).not.toHaveBeenCalledWith(expect.stringContaining('Remaining amount'));
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

    // What /portfolio answers with: the last read of the Trader's portfolio the events brought, dated with the time of the read, which an
    // order event says, or with the reception of a portfolio change, which does not
    describe('the portfolio it keeps', () => {
      const receivedAt = toTimestamp('2024-01-01T12:00:02Z');
      /** A portfolio the Trader read, told apart from the others by the BTC it holds */
      const read = (btc: number): Portfolio =>
        new Map([
          ['BTC', { free: btc, used: 0, total: btc }],
          ['USD', { free: 100, used: 0, total: 100 }],
        ]);
      /** A read made `seconds` after receivedAt, as an order event brings it */
      const readAt = (seconds: number) => receivedAt + seconds * ONE_SECOND;

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'], now: receivedAt });
      });

      it('keeps the last portfolio of a batch of portfolio changes, dated with its reception', () => {
        plugin.onPortfolioChange([read(1), read(2)]);
        expect(plugin['kept']).toEqual({ portfolio: read(2), at: receivedAt, dated: 'received' });
      });

      // A portfolio change is queued as the Trader reads the account: the same balances read again are dated anew
      it('dates anew a portfolio change holding the balances it keeps', () => {
        plugin.onPortfolioChange([read(1)]);
        vi.setSystemTime(receivedAt + ONE_MINUTE);
        plugin.onPortfolioChange([read(1)]);
        expect(plugin['kept']?.at).toBe(receivedAt + ONE_MINUTE);
      });

      it('keeps its portfolio through an empty batch of portfolio changes', () => {
        plugin.onPortfolioChange([read(1)]);
        plugin.onPortfolioChange([]);
        expect(plugin['kept']).toEqual({ portfolio: read(1), at: receivedAt, dated: 'received' });
      });

      // The Trader queues a portfolio change once it has read the account, and each order event with the read it holds: what follows a
      // portfolio change carries its read or a later one, whatever the time of that read and that of the reception
      it('keeps a portfolio change over the read an order event brought before it', () => {
        plugin.onOrderCompleted([makeOrderCompletedEvent({ exchange: { portfolio: read(1), portfolioReadAt: readAt(30) } })]);
        vi.setSystemTime(receivedAt + ONE_MINUTE);
        plugin.onPortfolioChange([read(2)]);
        expect(plugin['kept']).toEqual({ portfolio: read(2), at: receivedAt + ONE_MINUTE, dated: 'received' });
      });

      // Every order event carries the Trader's last read with its time: the end of an order the read made once it had ended, which the
      // portfolioUpdates filter may have held back from the portfolio changes, the creation of an order and an end whose read failed the
      // last read as it stands, maybe minutes old, which keeps the time it was made
      describe.each`
        event               | notify
        ${'order_init'}     | ${(p: EventSubscriber, exchanges: Partial<ExchangeEvent>[]) => p.onOrderInitiated(exchanges.map(exchange => makeOrderInitiatedEvent({ exchange })))}
        ${'order_cancel'}   | ${(p: EventSubscriber, exchanges: Partial<ExchangeEvent>[]) => p.onOrderCanceled(exchanges.map(exchange => makeOrderCanceledEvent({ exchange })))}
        ${'order_error'}    | ${(p: EventSubscriber, exchanges: Partial<ExchangeEvent>[]) => p.onOrderErrored(exchanges.map(exchange => makeOrderErroredEvent({ exchange })))}
        ${'order_complete'} | ${(p: EventSubscriber, exchanges: Partial<ExchangeEvent>[]) => p.onOrderCompleted(exchanges.map(exchange => makeOrderCompletedEvent({ exchange })))}
      `('on an order event ($event)', ({ notify }) => {
        // A portfolio change received at 12:00:02, then the order event a minute later
        beforeEach(() => {
          plugin.onPortfolioChange([read(1)]);
          vi.setSystemTime(receivedAt + ONE_MINUTE);
        });

        it('keeps the read it carries, dated with the time the Trader made it, while the chat is subscribed to nothing', () => {
          notify(plugin, [{ portfolio: read(2), portfolioReadAt: readAt(40) }]);
          expect(plugin['kept']).toEqual({ portfolio: read(2), at: readAt(40), dated: 'read' });
        });

        it('keeps the read of the last event of its batch', () => {
          notify(plugin, [
            { portfolio: read(2), portfolioReadAt: readAt(40) },
            { portfolio: read(3), portfolioReadAt: readAt(50) },
          ]);
          expect(plugin['kept']).toEqual({ portfolio: read(3), at: readAt(50), dated: 'read' });
        });

        // The read the portfolio change brought, as it was made: the change said nothing of its time
        it('dates the balances it keeps back to the time of their read', () => {
          notify(plugin, [{ portfolio: read(1), portfolioReadAt: readAt(-2) }]);
          expect(plugin['kept']).toEqual({ portfolio: read(1), at: readAt(-2), dated: 'read' });
        });

        // The Trader read the account again and found nothing changed, which its portfolioUpdates filter holds back from the changes
        it('dates the balances it keeps with a later read of the same balances', () => {
          notify(plugin, [{ portfolio: read(2), portfolioReadAt: readAt(40) }]);
          notify(plugin, [{ portfolio: read(2), portfolioReadAt: readAt(55) }]);
          expect(plugin['kept']).toEqual({ portfolio: read(2), at: readAt(55), dated: 'read' });
        });

        // The Trader queues its events in the order of its reads: the last brings the newest read, though dated before the one kept by a
        // clock set back between the two
        it('keeps the read of the last event, dated before the one it holds', () => {
          notify(plugin, [{ portfolio: read(2), portfolioReadAt: readAt(40) }]);
          notify(plugin, [{ portfolio: read(3), portfolioReadAt: readAt(39) }]);
          expect(plugin['kept']).toEqual({ portfolio: read(3), at: readAt(39), dated: 'read' });
        });

        // The empty portfolio the Trader starts with, until one of its synchronizations succeeds, is no read: an event says so by
        // carrying no read time, whatever its portfolio holds
        it.each`
          held                       | portfolio    | portfolioReadAt
          ${'the empty portfolio'}   | ${new Map()} | ${undefined}
          ${'the empty portfolio'}   | ${new Map()} | ${NaN}
          ${'balances of the asset'} | ${read(2)}   | ${undefined}
        `('leaves out $held of an event read at $portfolioReadAt', ({ portfolio, portfolioReadAt }) => {
          notify(plugin, [{ portfolio, portfolioReadAt }]);
          expect(plugin['kept']).toEqual({ portfolio: read(1), at: receivedAt, dated: 'received' });
        });

        it('changes nothing on an empty batch', () => {
          notify(plugin, []);
          expect(plugin['kept']).toEqual({ portfolio: read(1), at: receivedAt, dated: 'received' });
        });
      });

      // A handler that throws ends the run
      it.each`
        handler
        ${'onOrderInitiated'}
        ${'onOrderCanceled'}
        ${'onOrderErrored'}
        ${'onOrderCompleted'}
      `('does not throw on an event without its exchange part ($handler)', ({ handler }) => {
        const unreadable = { order: makeOrderCompletedEvent().order } as any;
        expect(() => plugin[handler as 'onOrderCompleted']([unreadable])).not.toThrow();
      });

      it('answers /portfolio with the balances an order end brought, the chat subscribed to nothing', () => {
        plugin.onOrderCompleted([makeOrderCompletedEvent({ exchange: { portfolio: read(2), portfolioReadAt: readAt(-30) } })]);
        expect(plugin['handleCommand']('/portfolio').split('\n')[1]).toBe('BTC: 2 (free 2, used 0)');
      });

      // The read made at 12:00:30, received with the next bucket at 12:01:02, is 42 seconds old at 12:01:12
      it('answers /portfolio with the time of the read an order event brought, not with its reception', () => {
        vi.setSystemTime(readAt(60));
        plugin.onOrderCompleted([makeOrderCompletedEvent({ exchange: { portfolio: read(2), portfolioReadAt: readAt(28) } })]);
        vi.setSystemTime(readAt(70));
        expect(plugin['handleCommand']('/portfolio').split('\n')[0]).toBe(
          'Balances read by the Trader at 2024-01-01T12:00:30.000Z (42 seconds ago)',
        );
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

      // Not through the notifications, even once the chat is subscribed to everything: the bot sends the answer itself
      it('sends nothing through the notifications', async () => {
        plugin['handleCommand']('/subscribe_all');
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

  // A real Trader feeding the subscriber, its events delivered as the pipeline wires and flushes them. The portfolioUpdates filter holds
  // back the read that shows a LIMIT BUY reserving its cost, and the read after the BUY's fill fails: the end of the order carries the
  // read the Trader made before it, minutes old. Dated with its reception, it answered "8 seconds ago" under the filter; without the
  // filter, which let that read through as a portfolio change, with the reception of the change.
  describe('fed by a Trader', () => {
    const at = (time: string) => toTimestamp(`2024-01-01T${time}Z`);
    /** The balances of an account holding no asset, `usdUsed` of its 10,000 USD reserved by an open order */
    const balances = (usdUsed: number): Portfolio =>
      new Map([
        ['BTC', { free: 0, used: 0, total: 0 }],
        ['ETH', { free: 0, used: 0, total: 0 }],
        ['USD', { free: 10000 - usdUsed, used: usdUsed, total: 10000 }],
      ]);
    const id: UUID = '00000000-0000-4000-8000-0000000000a4';

    /** The answer to /portfolio at 12:15:10, after the Trader's run of 12:00 to 12:15 */
    const answerAfterRun = async (portfolioUpdates?: PortfolioUpdatesConfig) => {
      vi.useFakeTimers({ toFake: ['Date'], now: at('12:00:00') });
      const trader = new Trader(portfolioUpdates && { portfolioUpdates });
      const subscriber = new EventSubscriber({ name: 'EventSubscriber', botUsername: 'bot_name', token: 't' });
      // As the pipeline wires the plugins: each event the Trader emits to the handler of its name (see wirePlugins)
      const handlers = subscriber as unknown as Record<string, (payloads: unknown[]) => void>;
      for (const event of Trader.getStaticConfiguration().eventsEmitted) {
        trader.on(event, (payloads: unknown[]) => handlers[`on${upperFirst(event)}`](payloads));
      }
      const flushAt = async (time: string) => {
        vi.setSystemTime(at(time));
        while (await trader.broadcastDeferredEmit());
      };
      // Read at 12:00 before the order, at 12:10 with the BUY's 950 USD reserved, then the read after its fill fails
      const fetchBalance = vi
        .fn()
        .mockResolvedValueOnce(balances(0))
        .mockResolvedValueOnce(balances(950))
        .mockRejectedValue(new Error('network down'));
      const fetchTickers = async () => ({ 'BTC/USD': { bid: 100 }, 'ETH/USD': { bid: 2000 } });
      trader.setExchange({ getExchangeName: () => 'binance', fetchBalance, fetchTickers, getMarketData: () => ({}) } as any);

      await trader['synchronize']();
      await flushAt('12:00:02');
      vi.setSystemTime(at('12:05:00'));
      await trader.onStrategyCreateOrder([
        { id, orderCreationDate: at('12:05:00'), type: 'LIMIT', side: 'BUY', amount: 10, price: 95, symbol: 'BTC/USD' },
      ]);
      await flushAt('12:05:02');
      vi.setSystemTime(at('12:10:00'));
      await trader['synchronize']();
      await flushAt('12:10:02');
      vi.setSystemTime(at('12:14:00'));
      trader['orders'].get(id)!.orderInstance.emit(ORDER_COMPLETED_EVENT);
      await trader['settlePendingReports']();
      await flushAt('12:15:02');
      vi.setSystemTime(at('12:15:10'));
      return subscriber['handleCommand']('/portfolio');
    };

    it.each`
      filter                                      | portfolioUpdates
      ${'with the portfolioUpdates filter'}       | ${{ threshold: 1, dust: 10 }}
      ${'without the filter, every read emitted'} | ${undefined}
    `('dates the read the end of an order brought with the time of the read, $filter', async ({ portfolioUpdates }) => {
      expect(await answerAfterRun(portfolioUpdates)).toBe(
        [
          'Balances read by the Trader at 2024-01-01T12:10:00.000Z (5 minutes 10 seconds ago)',
          'BTC: 0 (free 0, used 0)',
          'ETH: 0 (free 0, used 0)',
          'USD: 10,000 (free 9,050, used 950)',
          'No price yet: no 1-minute candle has been processed',
        ].join('\n'),
      );
    });
  });
});
