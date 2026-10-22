import {
  STRATEGY_CANCEL_ORDER_EVENT,
  STRATEGY_CREATE_ORDER_EVENT,
  STRATEGY_INFO_EVENT,
  STRATEGY_WARMUP_COMPLETED_EVENT,
  TIMEFRAME_CANDLE_EVENT,
} from '@gekko/shared/constants/event.const';
import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { ApplicationStopError } from '@gekko/shared/errors/applicationStop.error';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { IndicatorNames } from '@gekko/indicators/indicator.types';
import { StrategyOrder } from '@gekko/shared/models/advice.types';
import { Candle } from '@gekko/shared/models/candle.types';
import { Timeframe, Watch } from '@gekko/schemas/configuration/configuration.types';
import { LogLevel } from '@gekko/shared/models/logLevel.types';
import {
  CandleBucket,
  ExchangeEvent,
  OrderCanceledEvent,
  OrderCompletedEvent,
  OrderErroredEvent,
  OrderInitiatedEvent,
} from '@gekko/shared/models/event.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { config } from '@gekko/core/configuration/configuration';
import { Exchange, MarketData, OpenOrder } from '@gekko/shared/models/exchange.types';
import { error } from '@gekko/core/logger/logger';
import {
  AddIndicatorFn,
  IndicatorResults,
  InitParams,
  OnCandleEventParams,
  OnOrderCanceledEventParams,
  OnOrderCompletedEventParams,
  OnOrderErroredEventParams,
  Strategy,
  Tools,
} from '@gekko/strategies/strategy.types';
import { toTimestamp } from '@gekko/shared/utils/date/date.utils';
import { UUID } from 'node:crypto';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TradingAdvisor } from './tradingAdvisor';
import { tradingAdvisorSchema } from '@gekko/schemas/plugins/tradingAdvisor.schema';

// The advisor runs on the real StrategyManager, only the strategy is a double. Its hooks are these spies, through which a test
// scripts what the strategy does (tools.createOrder, tools.cancelOrder, tools.log) and reads what the strategy was given.
const { strategy, TestStrategy } = vi.hoisted(() => {
  const strategy = {
    init: vi.fn<(params: InitParams<object>) => void>(),
    onEachTimeframeCandle: vi.fn<(params: OnCandleEventParams<object>, ...indicators: IndicatorResults[]) => void>(),
    onTimeframeCandleAfterWarmup: vi.fn<(params: OnCandleEventParams<object>, ...indicators: IndicatorResults[]) => void>(),
    onOrderCompleted: vi.fn<(params: OnOrderCompletedEventParams<object>) => void>(),
    onOrderCanceled: vi.fn<(params: OnOrderCanceledEventParams<object>) => void>(),
    onOrderErrored: vi.fn<(params: OnOrderErroredEventParams<object>) => void>(),
    end: vi.fn<(interruption?: string) => void>(),
  };
  class TestStrategy implements Strategy<object> {
    init = strategy.init;
    onEachTimeframeCandle = strategy.onEachTimeframeCandle;
    onTimeframeCandleAfterWarmup = strategy.onTimeframeCandleAfterWarmup;
    onOrderCompleted = strategy.onOrderCompleted;
    onOrderCanceled = strategy.onOrderCanceled;
    onOrderErrored = strategy.onOrderErrored;
    end = strategy.end;
  }
  return { strategy, TestStrategy };
});

// The real registry answers undefined for a name it does not export, a module mock throws: MissingStrategy plays that name
vi.mock('@gekko/strategies/index', () => ({ TestStrategy, MissingStrategy: undefined }));
vi.mock('@gekko/core/configuration/configuration', () => ({ config: { getWatch: vi.fn(), getStrategy: vi.fn() } }));
vi.mock('@gekko/core/logger/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

// A midnight (UTC), so that the first bucket sent opens a candle of every timeframe used here
const START = toTimestamp('2025-01-01T00:00:00.000Z');
const BASE_PRICES = new Map<TradingPair, number>([
  ['BTC/USDT', 100],
  ['ETH/USDT', 200],
]);

/** The bucket of the minute starting `minute` minutes after START: the prices of every pair rise by 1 a minute from its base price. */
const oneMinuteBucket = (minute: number): CandleBucket =>
  new Map(
    [...BASE_PRICES].map(([pair, basePrice]): [TradingPair, Candle] => {
      const price = basePrice + minute;
      return [pair, { start: START + minute * ONE_MINUTE, open: price, high: price + 2, low: price - 2, close: price + 1, volume: 1 }];
    }),
  );

/** The 3m bucket made of the first three one-minute buckets: first open, highest high, lowest low, last close, total volume. */
const FIRST_3M_BUCKET: CandleBucket = new Map([
  ['BTC/USDT', { start: START, open: 100, high: 104, low: 98, close: 103, volume: 3 }],
  ['ETH/USDT', { start: START, open: 200, high: 204, low: 198, close: 203, volume: 3 }],
]);

const watch = (timeframe: Timeframe, warmupCandleCount: number): Watch => ({
  assets: ['BTC', 'ETH'],
  currency: 'USDT',
  pairs: [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }],
  timeframe,
  tickrate: 1000,
  mode: 'backtest',
  warmup: { tickrate: 1000, candleCount: warmupCandleCount },
});

const MARKET_DATA = new Map<TradingPair, MarketData>([
  ['BTC/USDT', { amount: { min: 0.0001 }, price: { min: 0.01 } }],
  ['ETH/USDT', { amount: { min: 0.001 }, price: { min: 0.1 } }],
]);

const usdtPortfolio = (total: number): Portfolio => new Map([['USDT', { free: total, used: 0, total }]]);
const FETCHED_BALANCE = usdtPortfolio(1000);

// What an exchange lists as open at start-up: on BTC/USDT a BUY of 2 at 95 that filled 0.5, and a stop-loss without a price
const OPEN_ORDERS = new Map<TradingPair, OpenOrder[]>([
  [
    'BTC/USDT',
    [
      { id: '28458', side: 'BUY', type: 'LIMIT', price: 95, amount: 2, filled: 0.5, remaining: 1.5, timestamp: START - ONE_MINUTE },
      { id: '28459', side: 'SELL', type: 'OTHER', amount: 1, filled: 0, remaining: 1, timestamp: START - ONE_MINUTE },
    ],
  ],
  ['ETH/USDT', []],
]);

// All that processInit asks of the exchange
type StartUpExchange = Pick<Exchange, 'getMarketData' | 'fetchBalance' | 'fetchOpenOrders'>;
// No order open at start-up, as in a backtest or a paper session, whose simulator starts empty
const exchange: StartUpExchange = {
  getMarketData: symbol => MARKET_DATA.get(symbol) ?? {},
  fetchBalance: async () => FETCHED_BALANCE,
  fetchOpenOrders: async () => [],
};

const ORDER_IDS: UUID[] = ['3b0e8a52-4c1d-4f6e-9a7b-2d5c8e1f0a01', '3b0e8a52-4c1d-4f6e-9a7b-2d5c8e1f0a02'];
const ORDER = { symbol: 'BTC/USDT', side: 'BUY', type: 'LIMIT', amount: 1, price: 100, orderCreationDate: START } as const;
const EXCHANGE_EVENT: ExchangeEvent = { portfolio: FETCHED_BALANCE, price: 100 };

const orderCompleted = (id: UUID): OrderCompletedEvent => ({
  order: { ...ORDER, id, orderExecutionDate: START, effectivePrice: 100, fee: 0.1, feePercent: 0.1 },
  exchange: EXCHANGE_EVENT,
});
const orderCanceled = (id: UUID): OrderCanceledEvent => ({
  order: { ...ORDER, id, orderCancelationDate: START, filled: 0, remaining: 1 },
  exchange: EXCHANGE_EVENT,
});
const orderErrored = (id: UUID): OrderErroredEvent => ({
  order: { ...ORDER, id, orderErrorDate: START, reason: 'Insufficient balance', filled: 0, mayBeLive: false },
  exchange: EXCHANGE_EVENT,
});

/** A batch of order events of one kind, one per id of ORDER_IDS, in that order. */
const batchOf = <T>(orderEvent: (id: UUID) => T) => ORDER_IDS.map(id => orderEvent(id));

/** An event of `orderEvent`'s kind for each portfolio, in that order, with the ids of ORDER_IDS: the portfolio the Trader read after it */
const carrying = <T extends OrderInitiatedEvent>(orderEvent: (id: UUID) => T, ...portfolios: Portfolio[]): T[] =>
  portfolios.map((portfolio, index) => ({ ...orderEvent(ORDER_IDS[index]), exchange: { portfolio, price: 100 } }));

// Each order handler of the advisor, sent a batch of its own kind of events
const SEND_ORDER_BATCH = {
  onOrderCompleted: (advisor: TradingAdvisor) => advisor.onOrderCompleted(batchOf(orderCompleted)),
  onOrderCanceled: (advisor: TradingAdvisor) => advisor.onOrderCanceled(batchOf(orderCanceled)),
  onOrderErrored: (advisor: TradingAdvisor) => advisor.onOrderErrored(batchOf(orderErrored)),
};

const BUY_ORDER: StrategyOrder = { symbol: 'BTC/USDT', side: 'BUY', type: 'MARKET', amount: 1 };
const ORDER_TO_CANCEL: UUID = '3b0e8a52-4c1d-4f6e-9a7b-2d5c8e1f0a03';
const INFO_MESSAGE = 'Buying BTC';

// What the advisor queues, in the order getStaticConfiguration declares it
const EMITTED_EVENTS = [
  STRATEGY_INFO_EVENT,
  STRATEGY_CREATE_ORDER_EVENT,
  STRATEGY_CANCEL_ORDER_EVENT,
  STRATEGY_WARMUP_COMPLETED_EVENT,
  TIMEFRAME_CANDLE_EVENT,
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type StaticConfiguration = ReturnType<typeof TradingAdvisor.getStaticConfiguration>;

type AdvisorOptions = Partial<{
  timeframe: Timeframe;
  warmupCandleCount: number;
  maxConsecutiveErrors: number;
  strategyName: string;
  strategyPath: string;
}>;

/** What the listeners of an advisor record while flushDeferredEvents broadcasts its queue: the payloads delivered, by event */
type DeliveryRecorder = { delivered?: Map<string, unknown[]> };
const recorders = new WeakMap<TradingAdvisor, DeliveryRecorder>();

/**
 * An advisor set up as the pipeline does it: built from its parsed configuration, given the exchange it asks for, and listened to on
 * every event it emits before it queues any, as the pipeline wires the plugins before it starts the stream: an event queued while
 * nobody listens reaches nobody. The listeners record the deferred events flushDeferredEvents broadcasts, not the events emitted at
 * once (the error line of the strategy).
 */
const createAdvisor = ({
  timeframe = '3m',
  warmupCandleCount = 0,
  maxConsecutiveErrors = 5,
  strategyName = 'TestStrategy',
  strategyPath,
}: AdvisorOptions = {}) => {
  vi.mocked(config.getWatch).mockReturnValue(watch(timeframe, warmupCandleCount));
  const advisor = new TradingAdvisor({ name: 'TradingAdvisor', strategyName, strategyPath, maxConsecutiveErrors });
  advisor.setExchange(exchange as Exchange);
  const recorder: DeliveryRecorder = {};
  for (const event of EMITTED_EVENTS) {
    advisor.on<unknown[]>(event, payloads => {
      const { delivered } = recorder;
      if (delivered) delivered.set(event, [...(delivered.get(event) ?? []), ...payloads]);
    });
  }
  recorders.set(advisor, recorder);
  return advisor;
};

const startAdvisor = async (options?: AdvisorOptions) => {
  const advisor = createAdvisor(options);
  await advisor.processInitStream();
  return advisor;
};

/** Sends the advisor the `count` consecutive one-minute buckets from START, one at a time as PluginsStream does. */
const sendBuckets = async (advisor: TradingAdvisor, count: number) => {
  for (let minute = 0; minute < count; minute++) await advisor.processInputStream(oneMinuteBucket(minute));
};

/**
 * Broadcasts what the advisor queued, as PluginsStream does after a bucket, and returns the payloads delivered for each event to the
 * listeners createAdvisor wired.
 */
const flushDeferredEvents = async (advisor: TradingAdvisor) => {
  const recorder = recorders.get(advisor)!;
  const delivered = new Map<string, unknown[]>();
  recorder.delivered = delivered;
  while (await advisor.broadcastDeferredEmit()) {
    // Until the queue is empty
  }
  delete recorder.delivered;
  return delivered;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TradingAdvisor', () => {
  describe('getStaticConfiguration', () => {
    it.each`
      property            | expected
      ${'name'}           | ${'TradingAdvisor'}
      ${'schema'}         | ${tradingAdvisorSchema}
      ${'modes'}          | ${['realtime', 'backtest']}
      ${'dependencies'}   | ${[]}
      ${'inject'}         | ${['exchange']}
      ${'eventsHandlers'} | ${['onOrderCompleted', 'onOrderCanceled', 'onOrderErrored', 'onPortfolioChange']}
      ${'eventsEmitted'}  | ${EMITTED_EVENTS}
    `('declares its $property', ({ property, expected }: { property: keyof StaticConfiguration; expected: unknown }) => {
      expect(TradingAdvisor.getStaticConfiguration()[property]).toEqual(expected);
    });
  });

  describe('processInit', () => {
    it.each`
      source                    | strategyName         | strategyPath                                     | message
      ${'the strategies index'} | ${'MissingStrategy'} | ${undefined}                                     | ${'Cannot find internal MissingStrategy strategy'}
      ${'its strategyPath'}     | ${'TestStrategy'}    | ${resolve(__dirname, 'tradingAdvisor.types.ts')} | ${'Cannot find external TestStrategy strategy'}
    `('rejects when $source does not export the strategy', async ({ strategyName, strategyPath, message }) => {
      await expect(createAdvisor({ strategyName, strategyPath }).processInitStream()).rejects.toThrow(message);
    });

    // One bucket, before any timeframe candle: a 3m candle takes three
    describe('on the first one-minute bucket', () => {
      beforeEach(async () => {
        await sendBuckets(await startAdvisor(), 1);
      });

      it.each`
        given                                      | expected
        ${'the market data of every watched pair'} | ${expect.objectContaining({ tools: expect.objectContaining({ marketData: MARKET_DATA }) })}
        ${'the balance fetched from the exchange'} | ${expect.objectContaining({ portfolio: FETCHED_BALANCE })}
        ${'the candles of that bucket'}            | ${expect.objectContaining({ candle: oneMinuteBucket(0) })}
      `('gives the strategy $given', ({ expected }) => {
        expect(strategy.init).toHaveBeenCalledExactlyOnceWith(expected);
      });
    });

    // A strategy keeps its orders in memory: restarted, GridBot could not tell the grid its previous run had left on the exchange, and
    // built a second one beside it
    describe('the orders open on the exchange at start-up', () => {
      let fetchOpenOrders: Mock<Exchange['fetchOpenOrders']>;

      /** An advisor on an exchange that lists the orders of OPEN_ORDERS as open */
      const createAdvisorOnOpenOrders = () => {
        const advisor = createAdvisor();
        const listing: StartUpExchange = { ...exchange, fetchOpenOrders };
        advisor.setExchange(listing as Exchange);
        return advisor;
      };

      beforeEach(() => {
        // A new list at each call, as the exchange maps a new one at each read
        fetchOpenOrders = vi.fn(async (symbol: TradingPair) => structuredClone(OPEN_ORDERS.get(symbol) ?? []));
      });

      it('asks the exchange for those of each watched pair, once each, before any bucket', async () => {
        await createAdvisorOnOpenOrders().processInitStream();
        expect(fetchOpenOrders.mock.calls).toEqual([['BTC/USDT'], ['ETH/USDT']]);
      });

      it('gives init those of each watched pair', async () => {
        const advisor = createAdvisorOnOpenOrders();
        await advisor.processInitStream();
        await sendBuckets(advisor, 1);
        expect(strategy.init).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ openOrders: OPEN_ORDERS }));
      });

      // As a failed fetchBalance does: the strategy would start blind to the orders it was to check
      it('rejects when the exchange cannot list those of a pair', async () => {
        const unreadable = new GekkoError('exchange', 'Open order 28460 on ETH/USDT has no side Gekko knows (undefined)');
        fetchOpenOrders.mockImplementation(async symbol => {
          if (symbol === 'ETH/USDT') throw unreadable;
          return [];
        });
        await expect(createAdvisorOnOpenOrders().processInitStream()).rejects.toBe(unreadable);
      });
    });
  });

  describe('processOneMinuteBucket', () => {
    it.each`
      timeframe | bucketCount | candleCount
      ${'1m'}   | ${1}        | ${1}
      ${'1m'}   | ${3}        | ${3}
      ${'3m'}   | ${2}        | ${0}
      ${'3m'}   | ${3}        | ${1}
      ${'3m'}   | ${6}        | ${2}
      ${'1h'}   | ${59}       | ${0}
      ${'1h'}   | ${60}       | ${1}
    `(
      'sends the strategy the $timeframe candles completed by $bucketCount one-minute buckets',
      async ({ timeframe, bucketCount, candleCount }) => {
        await sendBuckets(await startAdvisor({ timeframe }), bucketCount);
        expect(strategy.onEachTimeframeCandle).toHaveBeenCalledTimes(candleCount);
      },
    );

    it('queues no event before the timeframe candle is complete', async () => {
      const advisor = await startAdvisor();
      await sendBuckets(advisor, 2);
      expect(await flushDeferredEvents(advisor)).toEqual(new Map());
    });

    it('queues only the timeframe candle while the strategy warms up', async () => {
      strategy.onTimeframeCandleAfterWarmup.mockImplementation(({ tools }) => tools.log('info', INFO_MESSAGE));
      const advisor = await startAdvisor({ warmupCandleCount: 1 });
      await sendBuckets(advisor, 3);
      const delivered = await flushDeferredEvents(advisor);
      expect([...delivered.keys()]).toEqual([TIMEFRAME_CANDLE_EVENT]);
    });

    it('rejects when the strategy logs an error', async () => {
      strategy.onEachTimeframeCandle.mockImplementation(({ tools }) => tools.log('error', 'Indicator out of range'));
      const advisor = await startAdvisor();
      await expect(sendBuckets(advisor, 3)).rejects.toThrow('Indicator out of range');
    });

    describe('a line the strategy logs', () => {
      const ERROR_MESSAGE = 'Indicator out of range';
      /** The strategy info of a line logged on the first 3m candle, dated with its end */
      const strategyInfo = (level: LogLevel, message: string) => ({ timestamp: START + 3 * ONE_MINUTE, level, tag: 'strategy', message });
      /** A candle hook that logs an error line, then catches the error tools.log('error') throws and goes on */
      const logErrorAndGoOn = ({ tools }: OnCandleEventParams<object>) => {
        try {
          tools.log('error', ERROR_MESSAGE);
        } catch {
          // The strategy goes on
        }
      };
      let advisor: TradingAdvisor;
      let listener: Mock;

      beforeEach(async () => {
        advisor = await startAdvisor();
        listener = vi.fn();
        advisor.on(STRATEGY_INFO_EVENT, listener); // As the pipeline wires the onStrategyInfo of an EventSubscriber
      });

      describe.each`
        level
        ${'info'}
        ${'warn'}
      `('at $level', ({ level }: { level: LogLevel }) => {
        beforeEach(async () => {
          strategy.onEachTimeframeCandle.mockImplementation(({ tools }) => tools.log(level, INFO_MESSAGE));
          await sendBuckets(advisor, 3);
        });

        it('is not delivered before the events of the bucket are broadcast', () => {
          expect(listener).not.toHaveBeenCalled();
        });

        it('is queued with the events of the bucket', async () => {
          expect((await flushDeferredEvents(advisor)).get(STRATEGY_INFO_EVENT)).toEqual([strategyInfo(level, INFO_MESSAGE)]);
        });
      });

      // Queued, it was dropped with the events of the bucket that tools.log('error') fails, which PluginsStream never broadcasts: the
      // strat_info subscribers never heard why the bot stopped
      it('at error, is delivered at once, alone in an array as the deferred events are, though its bucket fails', async () => {
        strategy.onEachTimeframeCandle.mockImplementation(({ tools }) => tools.log('error', ERROR_MESSAGE));
        await sendBuckets(advisor, 3).catch(() => undefined);
        expect(listener).toHaveBeenCalledExactlyOnceWith([strategyInfo('error', ERROR_MESSAGE)]);
      });

      // Thrown before it was relayed, the error line was lost even to a strategy that caught the error and went on
      describe('at error, when the strategy catches the error and goes on', () => {
        beforeEach(async () => {
          strategy.onEachTimeframeCandle.mockImplementation(logErrorAndGoOn);
          await sendBuckets(advisor, 3);
        });

        it('is delivered at once, before the events of the bucket are broadcast', () => {
          expect(listener).toHaveBeenCalledExactlyOnceWith([strategyInfo('error', ERROR_MESSAGE)]);
        });

        it('is not queued with the events of the bucket as well', async () => {
          expect((await flushDeferredEvents(advisor)).has(STRATEGY_INFO_EVENT)).toBe(false);
        });
      });

      // Bun loads a strategyPath without type-checking it. An object holding a function, tools itself included, could not be copied
      // with the events of its bucket: the bucket failed on a DataCloneError that named neither tools.log nor the strategy info.
      describe.each`
        kind                                 | pick
        ${'an object holding a function'}    | ${() => ({ rsi: 42, onTick: () => undefined })}
        ${'the tools the strategy is given'} | ${(tools: Tools<object>) => tools}
      `('when the strategy logs $kind, as an untyped strategy can', ({ pick }: { pick: (tools: Tools<object>) => unknown }) => {
        beforeEach(() => {
          strategy.onEachTimeframeCandle.mockImplementation(({ tools }) => tools.log('info', pick(tools) as string));
        });

        it('does not fail the bucket', async () => {
          await expect(sendBuckets(advisor, 3)).resolves.toBeUndefined();
        });
      });

      it('queues a message that is not a string as util.inspect writes it: { rsi: 42, onTick: [Function: onTick] }', async () => {
        strategy.onEachTimeframeCandle.mockImplementation(({ tools }) =>
          tools.log('info', { rsi: 42, onTick: function onTick() {} } as unknown as string),
        );
        await sendBuckets(advisor, 3);
        expect((await flushDeferredEvents(advisor)).get(STRATEGY_INFO_EVENT)).toEqual([
          strategyInfo('info', '{ rsi: 42, onTick: [Function: onTick] }'),
        ]);
      });

      // A string as it is, as main() reports one: util.inspect quoted it
      it.each`
        failure       | thrown                        | reason
        ${'an Error'} | ${new Error('Telegram down')} | ${'Telegram down'}
        ${'a string'} | ${'Telegram down'}            | ${'Telegram down'}
      `('at error, has a listener that fails on it with $failure logged at error level: $reason', async ({ thrown, reason }) => {
        strategy.onEachTimeframeCandle.mockImplementation(logErrorAndGoOn);
        advisor.on(STRATEGY_INFO_EVENT, () => {
          throw thrown;
        });
        await sendBuckets(advisor, 3);
        expect(vi.mocked(error).mock.calls).toEqual([
          ['strategy', ERROR_MESSAGE],
          ['trading advisor', `A listener failed on the error line of the strategy: ${reason}`],
        ]);
      });
    });

    // In realtime the warmup candles are history, replayed with the Trader active: an order created on them is refused, which stops
    // the run before the Trader hears of it
    it.each`
      hook
      ${'init'}
      ${'onEachTimeframeCandle'}
    `(
      'rejects when the strategy creates an order from $hook during the warmup',
      async ({ hook }: { hook: 'init' | 'onEachTimeframeCandle' }) => {
        strategy[hook].mockImplementation(({ tools }) => {
          tools.createOrder(BUY_ORDER);
        });
        const advisor = await startAdvisor({ warmupCandleCount: 1 });
        await expect(sendBuckets(advisor, 3)).rejects.toThrow('[STRATEGY] Orders are not available until the warmup is over');
      },
    );

    // init ran on the first timeframe candle: on 1d without warmup up to a day after start-up, which is when an indicator misspelt
    // there stopped the bot
    describe('the init of the strategy', () => {
      it('runs on the first one-minute bucket, before the first 1d candle closes', async () => {
        await sendBuckets(await startAdvisor({ timeframe: '1d' }), 1);
        expect(strategy.init).toHaveBeenCalledOnce();
      });

      it('runs once', async () => {
        await sendBuckets(await startAdvisor(), 6);
        expect(strategy.init).toHaveBeenCalledOnce();
      });

      it('rejects the first one-minute bucket when it registers an indicator that does not exist', async () => {
        strategy.init.mockImplementation(({ addIndicator }) => addIndicator('SMAA' as IndicatorNames, 'BTC/USDT', {} as never));
        const advisor = await startAdvisor({ timeframe: '1d' });
        await expect(advisor.processInputStream(oneMinuteBucket(0))).rejects.toThrow('[STRATEGY] SMAA indicator not found.');
      });

      it('rejects when the strategy adds an indicator once it has returned', async () => {
        let kept: AddIndicatorFn | undefined;
        strategy.init.mockImplementation(({ addIndicator }) => {
          kept = addIndicator;
        });
        strategy.onEachTimeframeCandle.mockImplementation(() => kept?.('SMA', 'BTC/USDT', { period: 2 }));
        const advisor = await startAdvisor();
        await expect(sendBuckets(advisor, 3)).rejects.toThrow(
          '[STRATEGY] Impossible to add the SMA indicator on BTC/USDT: addIndicator is available in init only',
        );
      });
    });

    describe('on a complete timeframe candle after the warmup', () => {
      let createdOrderId: UUID | undefined;
      let delivered: Map<string, unknown[]>;

      beforeEach(async () => {
        createdOrderId = undefined;
        strategy.onTimeframeCandleAfterWarmup.mockImplementation(({ tools }) => {
          createdOrderId = tools.createOrder(BUY_ORDER);
          tools.cancelOrder(createdOrderId);
          tools.cancelOrder(ORDER_TO_CANCEL);
          tools.log('info', INFO_MESSAGE);
        });
        const advisor = await startAdvisor();
        await sendBuckets(advisor, 3);
        delivered = await flushDeferredEvents(advisor);
      });

      it('sends the strategy the bucket aggregated over the timeframe', () => {
        expect(strategy.onEachTimeframeCandle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ candle: FIRST_3M_BUCKET }));
      });

      // The last bucket starts at START + 2 min: the strategy's clock is its close, START + 3 min, which dates the order as the Trader
      // and the simulated exchange date the fills and the errors of that bucket
      it('queues the order the strategy created', () => {
        expect(delivered.get(STRATEGY_CREATE_ORDER_EVENT)).toEqual([
          { ...BUY_ORDER, id: createdOrderId, orderCreationDate: START + 3 * ONE_MINUTE },
        ]);
      });

      // As the strategy manager relays them: compared strictly, the pair is left out, not undefined
      it('queues the cancellations the strategy asked for: of the order it created with its pair, BTC/USDT, of an id it did not create alone', () => {
        expect(delivered.get(STRATEGY_CANCEL_ORDER_EVENT)).toStrictEqual([
          { id: createdOrderId, symbol: 'BTC/USDT' },
          { id: ORDER_TO_CANCEL },
        ]);
      });

      it.each`
        event                              | expected
        ${STRATEGY_INFO_EVENT}             | ${[{ timestamp: START + 3 * ONE_MINUTE, level: 'info', tag: 'strategy', message: INFO_MESSAGE }]}
        ${STRATEGY_WARMUP_COMPLETED_EVENT} | ${[FIRST_3M_BUCKET]}
        ${TIMEFRAME_CANDLE_EVENT}          | ${[FIRST_3M_BUCKET]}
      `('queues $event', ({ event, expected }) => {
        expect(delivered.get(event)).toEqual(expected);
      });
    });
  });

  describe('order events', () => {
    it.each`
      handler
      ${'onOrderCompleted'}
      ${'onOrderCanceled'}
      ${'onOrderErrored'}
    `('$handler gives the strategy every order of the batch, in order', async ({ handler }: { handler: keyof typeof SEND_ORDER_BATCH }) => {
      SEND_ORDER_BATCH[handler](await startAdvisor());
      expect(strategy[handler].mock.calls.map(([{ order }]) => order.id)).toEqual(ORDER_IDS);
    });

    // The hooks are synchronous: an `await Promise.all` over them only seemed to run them together
    it.each`
      handler
      ${'onOrderCompleted'}
      ${'onOrderCanceled'}
      ${'onOrderErrored'}
    `(
      '$handler returns nothing to wait for, its batch relayed by then',
      async ({ handler }: { handler: keyof typeof SEND_ORDER_BATCH }) => {
        const advisor = await startAdvisor();
        expect(SEND_ORDER_BATCH[handler](advisor)).toBeUndefined();
      },
    );

    it('onOrderErrored throws an ApplicationStopError once a batch reaches maxConsecutiveErrors', async () => {
      const advisor = await startAdvisor({ maxConsecutiveErrors: ORDER_IDS.length });
      expect(() => SEND_ORDER_BATCH.onOrderErrored(advisor)).toThrow(ApplicationStopError);
    });

    // Thrown before the strategy's hook, the circuit breaker kept the error that trips it from the strategy
    it('onOrderErrored gives the strategy the order that trips the circuit breaker too', async () => {
      const advisor = await startAdvisor({ maxConsecutiveErrors: ORDER_IDS.length });
      try {
        SEND_ORDER_BATCH.onOrderErrored(advisor);
      } catch {
        // The circuit breaker, which has a test of its own
      }
      expect(strategy.onOrderErrored.mock.calls.map(([{ order }]) => order.id)).toEqual(ORDER_IDS);
    });
  });

  describe('onPortfolioChange', () => {
    it('gives the strategy the last portfolio of the batch', async () => {
      const advisor = await startAdvisor();
      advisor.onPortfolioChange([usdtPortfolio(900), usdtPortfolio(800)]);
      await sendBuckets(advisor, 3);
      expect(strategy.onEachTimeframeCandle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ portfolio: usdtPortfolio(800) }));
    });
  });

  // Only a portfolio change refreshed the portfolio of the candle hooks, and the Trader's portfolioUpdates filter holds that back for a
  // fill below its threshold: they kept the balance from before the fill, and an all-in order sized on it was refused
  describe('the portfolio an order event carries', () => {
    it.each`
      handler               | orderEvent
      ${'onOrderCompleted'} | ${orderCompleted}
      ${'onOrderCanceled'}  | ${orderCanceled}
      ${'onOrderErrored'}   | ${orderErrored}
    `(
      '$handler gives the next candle the portfolio the last event of its batch carries',
      async ({ handler, orderEvent }: { handler: keyof typeof SEND_ORDER_BATCH; orderEvent: (id: UUID) => OrderCompletedEvent }) => {
        const advisor = await startAdvisor();
        advisor[handler](carrying(orderEvent, usdtPortfolio(900), usdtPortfolio(800)) as never);
        await sendBuckets(advisor, 3);
        expect(strategy.onEachTimeframeCandle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ portfolio: usdtPortfolio(800) }));
      },
    );

    // Until one of its synchronizations succeeds, the Trader relays the end of an order with the empty portfolio it starts with
    it.each`
      handler               | orderEvent
      ${'onOrderCompleted'} | ${orderCompleted}
      ${'onOrderCanceled'}  | ${orderCanceled}
      ${'onOrderErrored'}   | ${orderErrored}
    `(
      '$handler leaves the next candle the portfolio it had when its event carries the empty one of a Trader yet to fetch any',
      async ({ handler, orderEvent }: { handler: keyof typeof SEND_ORDER_BATCH; orderEvent: (id: UUID) => OrderCompletedEvent }) => {
        const advisor = await startAdvisor();
        advisor[handler](carrying(orderEvent, new Map()) as never);
        await sendBuckets(advisor, 3);
        expect(strategy.onEachTimeframeCandle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ portfolio: FETCHED_BALANCE }));
      },
    );

    // Each in the order the Trader queued it: the last one received is the latest it read
    const portfolioChangeThenEnd = (advisor: TradingAdvisor) => {
      advisor.onPortfolioChange([usdtPortfolio(900)]);
      advisor.onOrderCompleted(carrying(orderCompleted, usdtPortfolio(800)));
    };
    const endThenPortfolioChange = (advisor: TradingAdvisor) => {
      advisor.onOrderCompleted(carrying(orderCompleted, usdtPortfolio(800)));
      advisor.onPortfolioChange([usdtPortfolio(900)]);
    };

    it.each`
      received                                          | send                      | expected
      ${'a portfolio change, then the end of an order'} | ${portfolioChangeThenEnd} | ${usdtPortfolio(800)}
      ${'the end of an order, then a portfolio change'} | ${endThenPortfolioChange} | ${usdtPortfolio(900)}
    `('gives the next candle the last portfolio received, after $received', async ({ send, expected }) => {
      const advisor = await startAdvisor();
      send(advisor);
      await sendBuckets(advisor, 3);
      expect(strategy.onEachTimeframeCandle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ portfolio: expected }));
    });
  });

  // What the strategy received was the engine's own object, which the other plugins, the exchange or the configuration held too
  describe('when the strategy writes to what it receives', () => {
    describe('to its candles', () => {
      let delivered: Map<string, unknown[]>;

      beforeEach(async () => {
        strategy.onEachTimeframeCandle.mockImplementation(({ candle }) => {
          candle.get('BTC/USDT')!.close = 0;
          candle.delete('ETH/USDT');
        });
        // Without warmup the first candle completes it: its warmup event is queued after onEachTimeframeCandle
        const advisor = await startAdvisor();
        await sendBuckets(advisor, 3);
        delivered = await flushDeferredEvents(advisor);
      });

      it.each`
        event
        ${STRATEGY_WARMUP_COMPLETED_EVENT}
        ${TIMEFRAME_CANDLE_EVENT}
      `('queues $event with the bucket as the batcher built it', ({ event }) => {
        expect(delivered.get(event)).toEqual([FIRST_3M_BUCKET]);
      });
    });

    describe('to the candles init gets', () => {
      beforeEach(() => {
        strategy.init.mockImplementation(({ candle }) => {
          candle.get('BTC/USDT')!.open = 0;
          candle.get('BTC/USDT')!.high = 999;
        });
      });

      // Every plugin receives it
      it('leaves the first one-minute bucket as it was', async () => {
        const bucket = oneMinuteBucket(0);
        await (await startAdvisor()).processInputStream(bucket);
        expect(bucket).toEqual(oneMinuteBucket(0));
      });

      // Built from the one-minute buckets
      it('queues the first timeframe candle as the batcher built it', async () => {
        const advisor = await startAdvisor();
        await sendBuckets(advisor, 3);
        expect((await flushDeferredEvents(advisor)).get(TIMEFRAME_CANDLE_EVENT)).toEqual([FIRST_3M_BUCKET]);
      });
    });

    it('leaves the portfolio the other plugins received as it was', async () => {
      const portfolio = usdtPortfolio(800);
      strategy.onEachTimeframeCandle.mockImplementation(({ portfolio: own }) => {
        own.get('USDT')!.free = 0;
      });
      const advisor = await startAdvisor();
      advisor.onPortfolioChange([portfolio]);
      await sendBuckets(advisor, 3);
      expect(portfolio).toEqual(usdtPortfolio(800));
    });

    it('leaves the portfolio of an order event, which the other plugins received too, as it was', async () => {
      const [event] = carrying(orderCompleted, usdtPortfolio(800));
      strategy.onEachTimeframeCandle.mockImplementation(({ portfolio: own }) => {
        own.get('USDT')!.free = 0;
      });
      const advisor = await startAdvisor();
      advisor.onOrderCompleted([event]);
      await sendBuckets(advisor, 3);
      expect(event.exchange.portfolio).toEqual(usdtPortfolio(800));
    });

    it.each`
      handler               | orderEvent
      ${'onOrderCompleted'} | ${orderCompleted}
      ${'onOrderCanceled'}  | ${orderCanceled}
      ${'onOrderErrored'}   | ${orderErrored}
    `(
      '$handler leaves the events of the batch, which the other plugins receive after it, as they were',
      async ({ handler, orderEvent }: { handler: keyof typeof SEND_ORDER_BATCH; orderEvent: (id: UUID) => OrderCompletedEvent }) => {
        // Each event with a portfolio of its own
        const batch = () => batchOf(id => ({ ...orderEvent(id), exchange: { portfolio: usdtPortfolio(1000), price: 100 } }));
        (strategy[handler] as Mock).mockImplementation(({ order, exchange }: { order: { amount: number }; exchange: ExchangeEvent }) => {
          order.amount = 0;
          exchange.portfolio.clear();
        });
        const sent = batch();
        (await startAdvisor())[handler](sent as never);
        expect(sent).toEqual(batch());
      },
    );

    it('leaves the market data of the exchange as it was', async () => {
      const entry: MarketData = { amount: { min: 0.0001 }, fee: { maker: 0.001, taker: 0.001 } };
      strategy.init.mockImplementation(({ tools }) => {
        tools.marketData.get('BTC/USDT')!.fee!.taker = 0;
      });
      // As dummy-cex and paper trading do, the exchange hands out its own entry, the one its simulator charges fees with
      const ownEntryExchange: StartUpExchange = { ...exchange, getMarketData: () => entry };
      const advisor = createAdvisor();
      advisor.setExchange(ownEntryExchange as Exchange);
      await advisor.processInitStream();
      await sendBuckets(advisor, 3);
      expect(entry).toEqual({ amount: { min: 0.0001 }, fee: { maker: 0.001, taker: 0.001 } });
    });

    // The list the exchange answered with, which the StrategyManager keeps
    it('leaves the orders the exchange listed as open as they were', async () => {
      const listed = structuredClone(OPEN_ORDERS.get('BTC/USDT')!);
      strategy.init.mockImplementation(({ openOrders }) => {
        openOrders!.get('BTC/USDT')![0].remaining = 0;
        openOrders!.clear();
      });
      const advisor = createAdvisor();
      advisor.setExchange({ ...exchange, fetchOpenOrders: async symbol => (symbol === 'BTC/USDT' ? listed : []) } as Exchange);
      await advisor.processInitStream();
      await sendBuckets(advisor, 1);
      expect(listed).toEqual(OPEN_ORDERS.get('BTC/USDT'));
    });

    // Every plugin keeps the block: the PerformanceReporter makes its run id of it
    it('leaves the strategy block of the configuration as it was', async () => {
      vi.mocked(config.getStrategy).mockReturnValue({ name: 'TestStrategy', thresholds: { up: 1 } });
      strategy.init.mockImplementation(({ tools }) => {
        (tools.strategyParams as { thresholds: { up: number } }).thresholds.up = 9;
      });
      await sendBuckets(await startAdvisor(), 3);
      expect(config.getStrategy()).toEqual({ name: 'TestStrategy', thresholds: { up: 1 } });
    });

    // Two 3m candles closing at 103 and 106: the ribbon of an EMA(1) and an EMA(2) is ready on the second one
    it('leaves the results of an indicator as it computed them', async () => {
      strategy.init.mockImplementation(({ addIndicator }) => addIndicator('EMARibbon', 'BTC/USDT', { count: 2, start: 1, step: 1 }));
      strategy.onEachTimeframeCandle.mockImplementation((_params, ribbon) => {
        (ribbon.results as { results: number[] } | null)?.results.reverse();
      });
      const advisor = await startAdvisor();
      await sendBuckets(advisor, 6);
      const [{ indicator }] = advisor['strategyManager']!['indicators'];
      expect(indicator.getResult()).toEqual({ results: [106, 104.5], spread: 1.5 });
    });
  });

  describe('processFinalize', () => {
    it('ends the strategy', async () => {
      const advisor = await startAdvisor();
      await advisor.processCloseStream();
      expect(strategy.end).toHaveBeenCalledOnce();
    });

    // The analyzers said in their reports why a run stopped before its end, while the end of the strategy could not know it
    it.each`
      run                                   | failure                                                                             | interruption
      ${'that reached its end'}             | ${undefined}                                                                        | ${undefined}
      ${'that the circuit breaker stopped'} | ${new ApplicationStopError('strategy', 'Max consecutive order errors reached (5)')} | ${'[STRATEGY] Max consecutive order errors reached (5)'}
      ${'that a crash stopped'}             | ${new Error('Database locked')}                                                     | ${'Database locked'}
    `('gives the end of the strategy the interruption of a run $run: $interruption', async ({ failure, interruption }) => {
      const advisor = await startAdvisor();
      await advisor.processCloseStream(failure);
      expect(strategy.end).toHaveBeenCalledExactlyOnceWith(interruption);
    });

    // With a warmup of one 3m candle, the second one completes it: a run that ended before used to say nothing about it
    it.each`
      bucketCount | errors
      ${3}        | ${[['strategy', 'Strategy ended before its warmup was over, so it never traded: 1 timeframe candle processed, 2 needed (warmup.candleCount: 1, then one to trade on)']]}
      ${6}        | ${[]}
    `('logs $errors.length error(s) when the run ends after $bucketCount one-minute buckets', async ({ bucketCount, errors }) => {
      const advisor = await startAdvisor({ warmupCandleCount: 1 });
      await sendBuckets(advisor, bucketCount);
      await advisor.processCloseStream();
      expect(vi.mocked(error).mock.calls).toEqual(errors);
    });
  });
});
