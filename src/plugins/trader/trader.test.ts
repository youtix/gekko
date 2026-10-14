import {
  ORDER_CANCELED_EVENT,
  ORDER_COMPLETED_EVENT,
  ORDER_ERRORED_EVENT,
  ORDER_INITIATED_EVENT,
  ORDER_INVALID_EVENT,
  ORDER_PARTIALLY_FILLED_EVENT,
  ORDER_STATUS_CHANGED_EVENT,
  PORTFOLIO_CHANGE_EVENT,
} from '@constants/event.const';
import { EMPTY_ORDER_SUMMARY } from '@constants/order.const';
import { GekkoError } from '@errors/gekko.error';
import { AdviceOrder } from '@models/advice.types';
import { Watch } from '@models/configuration.types';
import { BalanceDetail, Portfolio } from '@models/portfolio.types';
import { config } from '@services/configuration/configuration';
import { OrderSummary } from '@services/core/order/order.types';
import * as logger from '@services/logger';
import { noop } from 'lodash-es';
import type { Mock } from 'vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Trader } from './trader';

vi.mock('@services/logger');

// launch(), cancel() and checkOrder() of every order mock: they resolve, unless a test makes them reject
const { orderActions } = vi.hoisted(() => ({
  orderActions: {
    launch: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    checkOrder: vi.fn(async () => undefined),
  },
}));

// A realtime run on BTC/USDT at 1m, as config.getWatch() returns it: the timeframe belongs to the watch, and the pairs are derived from
// the assets. Typed, so that it keeps the shape of the schema's output: untyped, it kept a retired option and put the timeframe on the
// pair, so that the Trader ran without one and its backtest synchronizations were tested on a fallback no configuration reaches
const baseWatch: Watch = {
  assets: ['BTC'],
  currency: 'USDT',
  timeframe: '1m',
  tickrate: 1000,
  mode: 'realtime',
  warmup: { tickrate: 1000, candleCount: 0 },
  pairs: [{ symbol: 'BTC/USDT' }],
};

const cloneWatch = (): Watch => ({
  ...baseWatch,
  assets: [...baseWatch.assets],
  pairs: [...baseWatch.pairs],
  warmup: { ...baseWatch.warmup },
});

type OrderListener = (...args: unknown[]) => unknown;

vi.mock('@services/configuration/configuration', () => {
  const getWatch = vi.fn(() => cloneWatch());
  const getStrategy = vi.fn(() => ({}));
  const getExchange = vi.fn(() => ({ name: 'dummy-cex' }));
  return { config: { getWatch, getStrategy, getExchange } };
});

const tick = async (count = 3) => {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
};

// A promise settled by the test, for an exchange call still in flight while something else happens
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

function createOrderMock(type: 'STICKY' | 'MARKET' | 'LIMIT', requiresPrice = false) {
  const listenersStore = new WeakMap<object, Map<string, Set<OrderListener>>>();

  const ensureStore = (instance: object) => {
    let store = listenersStore.get(instance);
    if (!store) {
      store = new Map();
      listenersStore.set(instance, store);
    }
    return store;
  };

  const addListener = (instance: object, event: string, handler: OrderListener) => {
    const store = ensureStore(instance);
    let handlers = store.get(event);
    if (!handlers) {
      handlers = new Set();
      store.set(event, handlers);
    }
    handlers.add(handler);
  };

  const removeListener = (instance: object, event: string, handler: OrderListener) => {
    const store = ensureStore(instance);
    const handlers = store.get(event);
    if (!handlers) return;
    handlers.delete(handler);
    if (!handlers.size) store.delete(event);
  };

  function MockOrder(
    this: any,
    symbol: string,
    id: string,
    side: string,
    amount: number,
    priceOrExchange: unknown,
    maybeExchange?: unknown,
  ) {
    ensureStore(this);
    this.symbol = symbol;
    this.id = id;
    this.side = side;
    this.amount = amount;
    this.price = requiresPrice ? priceOrExchange : undefined;
    this.exchange = requiresPrice ? maybeExchange : priceOrExchange;
    this.cancel = orderActions.cancel;
    this.launch = orderActions.launch;
    this.checkOrder = orderActions.checkOrder;
    this.createSummary = vi.fn().mockImplementation(async () => ({
      amount: this.amount,
      price: 100,
      feePercent: 0.25,
      side: this.side,
      orderExecutionDate: 1_700_000_111_000,
    }));
    // No fill reported, unless a test says otherwise: a refused order executed nothing (see Trader.reportRejected), and the summary
    // of a filled order that reported none is estimated from the amount ordered (see Trader.estimateOrderSummary)
    this.getFilledAmount = vi.fn(() => 0);
    // Nor its price: the price of an estimated summary comes from the Trader (see Trader.estimateExecutionPrice)
    this.getAverageFillPrice = vi.fn(() => undefined);
    this.removeAllListeners = vi.fn(() => {
      listenersStore.set(this, new Map());
    });
  }

  MockOrder.prototype.getGekkoOrderId = function () {
    return this.id;
  };

  MockOrder.prototype.getType = function () {
    return type;
  };

  MockOrder.prototype.getSide = function () {
    return this.side;
  };

  MockOrder.prototype.on = function (event: string, handler: OrderListener) {
    addListener(this, event, handler);
    return this;
  };

  MockOrder.prototype.once = function (event: string, handler: OrderListener) {
    const wrapped: OrderListener = (...args) => {
      removeListener(this, event, wrapped);
      return handler(...args);
    };
    addListener(this, event, wrapped);
    return this;
  };

  MockOrder.prototype.emit = function (event: string, ...args: unknown[]) {
    const handlers = ensureStore(this).get(event);
    if (!handlers) return false;
    Array.from(handlers).forEach(listener => listener(...args));
    return handlers.size > 0;
  };

  // Like emit, then resolves with how each listener settled. An EventEmitter ignores what its listeners return, so in the
  // application a listener promise that rejects is an unhandled rejection.
  MockOrder.prototype.emitAndSettle = function (event: string, ...args: unknown[]) {
    const handlers = Array.from(ensureStore(this).get(event) ?? []);
    return Promise.allSettled(handlers.map(listener => listener(...args)));
  };

  return MockOrder as unknown as new (symbol: string, id: string, side: string, amount: number, exchange: unknown) => any;
}

vi.mock('@services/core/order/sticky/stickyOrder', () => ({
  StickyOrder: createOrderMock('STICKY'),
}));

vi.mock('@services/core/order/market/marketOrder', () => ({
  MarketOrder: createOrderMock('MARKET'),
}));

vi.mock('@services/core/order/limit/limitOrder', () => ({
  LimitOrder: createOrderMock('LIMIT', true),
}));

describe('Trader', () => {
  const defaultCandle = { close: 100, start: 1_700_000_000_000 } as any;
  let trader: Trader;
  let fakeExchange: {
    getExchangeName: Mock;
    fetchTicker: Mock;
    fetchTickers: Mock;
    fetchBalance: Mock;
    getMarketData: Mock;
  };
  const getWatchMock = config.getWatch as unknown as Mock;
  const getExchangeMock = config.getExchange as unknown as Mock;
  const getStrategyMock = config.getStrategy as unknown as Mock;

  const getOrdersMap = () => (trader as any).orders;
  const getOrderMetadata = (id: string) => getOrdersMap().get(id);
  const getOrderInstance = (id: string) => getOrderMetadata(id)?.orderInstance;
  const getCompletedEvent = () =>
    (trader['addDeferredEmit'] as unknown as Mock).mock.calls.find(call => call[0] === ORDER_COMPLETED_EVENT)?.[1];
  const getCanceledEvent = () =>
    (trader['addDeferredEmit'] as unknown as Mock).mock.calls.find(call => call[0] === ORDER_CANCELED_EVENT)?.[1];
  const getErroredEvent = () =>
    (trader['addDeferredEmit'] as unknown as Mock).mock.calls.find(call => call[0] === ORDER_ERRORED_EVENT)?.[1];
  // The terminal events relayed to the strategy, in the order they were queued
  const getRelayedEvents = () =>
    (trader['addDeferredEmit'] as unknown as Mock).mock.calls
      .map(([event]) => event)
      .filter(event => [ORDER_CANCELED_EVENT, ORDER_COMPLETED_EVENT, ORDER_ERRORED_EVENT].includes(event));

  const buildAdvice = (overrides?: Partial<AdviceOrder>): AdviceOrder => ({
    id: overrides?.id ?? '20a7abd2-546b-4c65-b04d-900b84fa5fe6',
    orderCreationDate: overrides?.orderCreationDate ?? 1_700_000_000_100,
    type: overrides?.type ?? 'STICKY',
    side: overrides?.side ?? 'BUY',
    amount: overrides?.amount,
    price: overrides?.price,
    symbol: overrides?.symbol ?? 'BTC/USDT',
  });

  // An order created by the trader, listened to by its creation flow, or by its cancelation flow once canceled
  const prepareOrder = async (flow: 'creation' | 'cancelation', advice = buildAdvice()) => {
    await trader.onStrategyCreateOrder([advice]);
    const order = getOrderInstance(advice.id)!;
    if (flow === 'cancelation') await trader.onStrategyCancelOrder([advice.id]);
    return order;
  };

  beforeAll(() => {
    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    getWatchMock.mockReturnValue(cloneWatch());
    getExchangeMock.mockReturnValue({ name: 'dummy-cex' });
    getStrategyMock.mockReturnValue({});

    trader = new Trader();
    // Default currentTimestamp to something valid so dates in events are not 0
    trader['currentTimestamp'] = 1_700_000_000_000;

    fakeExchange = {
      getExchangeName: vi.fn(() => 'MockExchange'),
      fetchTicker: vi.fn().mockResolvedValue({ bid: 123 }),
      fetchTickers: vi.fn().mockResolvedValue({ 'BTC/USDT': { bid: 123 } }),
      fetchBalance: vi.fn().mockResolvedValue(
        new Map<string, BalanceDetail>([
          ['BTC', { free: 1, used: 0, total: 1 }],
          ['USDT', { free: 2, used: 0, total: 2 }],
        ]),
      ),
      // A market without limits, unless a test sets some: no order is capped at its maximum
      getMarketData: vi.fn(() => ({})),
    };

    trader['getExchange'] = vi.fn().mockReturnValue(fakeExchange);
    trader['addDeferredEmit'] = vi.fn();
  });

  afterEach(() => {
    trader?.['processFinalize']?.();
  });

  describe('constructor', () => {
    it('initializes prices as an empty Map', () => {
      expect(trader['prices']).toEqual(new Map());
    });

    it('initializes portfolio as an empty Map', () => {
      const portfolio = (trader as any).portfolio;
      expect(portfolio).toBeInstanceOf(Map);
      expect(portfolio.size).toBe(0);
    });

    it('initializes orders collection as empty map', () => {
      const orders = getOrdersMap();
      expect(orders).toBeInstanceOf(Map);
      expect(orders.size).toBe(0);
    });

    // A minified build (bun build --minify) renames classes: named after its class, the Trader logged its events and failures as "GO"
    it('names itself Trader whatever its class is named', () => {
      const className = Object.getOwnPropertyDescriptor(Trader, 'name')!;
      Object.defineProperty(Trader, 'name', { value: 'GO' });
      try {
        expect(new Trader().emitterName).toBe('Trader');
      } finally {
        Object.defineProperty(Trader, 'name', className);
      }
    });
  });

  describe('synchronize', () => {
    describe('Default Mode (No Portfolio Updates Config)', () => {
      it('should fetch portfolio and tickers from exchange', async () => {
        await trader['synchronize']();
        expect(fakeExchange.fetchBalance).toHaveBeenCalledTimes(1);
        expect(fakeExchange.fetchTickers).toHaveBeenCalledTimes(1);
      });

      it('should update trader plugin portfolio and prices', async () => {
        const newBalance = new Map<string, BalanceDetail>([
          ['BTC', { free: 3, used: 0, total: 3 }],
          ['USDT', { free: 50, used: 0, total: 50 }],
        ]);
        fakeExchange.fetchBalance.mockResolvedValue(newBalance);
        fakeExchange.fetchTickers.mockResolvedValue({ 'BTC/USDT': { bid: 200 } });

        await trader['synchronize']();

        expect(trader['portfolio']).toEqual(newBalance);
        expect(trader['prices'].get('BTC/USDT')).toBe(200);
      });

      it('should always emit portfolio change event', async () => {
        // Even if portfolio is empty or unchanged
        const spy = vi.spyOn(trader as any, 'addDeferredEmit');
        await trader['synchronize']();
        expect(spy).toHaveBeenCalledWith(PORTFOLIO_CHANGE_EVENT, trader['portfolio']);
      });
    });

    describe('With Portfolio Updates Config', () => {
      let filteredTrader: Trader;

      beforeEach(() => {
        getWatchMock.mockReturnValue(cloneWatch());
        // threshold 1%, dust 1
        filteredTrader = new Trader({ portfolioUpdates: { threshold: 1, dust: 1 } });
        filteredTrader['currentTimestamp'] = 1_700_000_000_000;
        filteredTrader['getExchange'] = vi.fn().mockReturnValue(fakeExchange);
        filteredTrader['addDeferredEmit'] = vi.fn();
        filteredTrader['prices'].set('BTC/USDT', 100);
      });

      it.each`
        description                                                   | oldPortfolio                                                                                                                 | newPortfolio                                                                                                                         | expectedEmit
        ${'should emit when first sync (lastEmitted is null)'}        | ${null}                                                                                                                      | ${new Map([['BTC', { total: 2 }]])}                                                                                                  | ${true}
        ${'should NOT emit when change is below threshold'}           | ${new Map<string, BalanceDetail>([['BTC', { free: 1, used: 0, total: 1 }], ['USDT', { free: 1000, used: 0, total: 1000 }]])} | ${new Map<string, BalanceDetail>([['BTC', { free: 1.005, used: 0, total: 1.005 }], ['USDT', { free: 1000, used: 0, total: 1000 }]])} | ${false}
        ${'should emit when change is above threshold'}               | ${new Map<string, BalanceDetail>([['BTC', { free: 1, used: 0, total: 1 }], ['USDT', { free: 1000, used: 0, total: 1000 }]])} | ${new Map<string, BalanceDetail>([['BTC', { free: 1.05, used: 0, total: 1.05 }], ['USDT', { free: 1000, used: 0, total: 1000 }]])}   | ${true}
        ${'should emit when portfolio structure changes (new asset)'} | ${new Map<string, BalanceDetail>([['USDT', { free: 1000, used: 0, total: 1000 }]])}                                          | ${new Map<string, BalanceDetail>([['BTC', { free: 0.1, used: 0, total: 0.1 }], ['USDT', { free: 1000, used: 0, total: 1000 }]])}     | ${true}
      `('$description', async ({ oldPortfolio, newPortfolio, expectedEmit }) => {
        // Setup initial state
        filteredTrader['lastEmittedPortfolio'] = oldPortfolio;
        filteredTrader['portfolio'] = oldPortfolio || new Map(); // just to have something before sync overrides it

        // Mock exchange to return new portfolio
        fakeExchange.fetchBalance.mockResolvedValue(newPortfolio);

        // Mock Emit
        const emitSpy = vi.spyOn(filteredTrader as any, 'addDeferredEmit');

        await filteredTrader['synchronize']();

        if (expectedEmit) {
          expect(emitSpy).toHaveBeenCalledOnce();
          // Also verify lastEmittedPortfolio is updated to newPortfolio
          expect(filteredTrader['lastEmittedPortfolio']).toEqual(newPortfolio);
        } else {
          expect(emitSpy).not.toHaveBeenCalled();
          // Verify lastEmittedPortfolio remains unchanged
          expect(filteredTrader['lastEmittedPortfolio']).toEqual(oldPortfolio);
        }
      });
    });

    // The filter holds back the portfolio change of a fill below its threshold, not the portfolio after it: the end of the order carries
    // it all the same, and the TradingAdvisor and the analyzers take it as the latest
    describe('when the portfolioUpdates filter holds back the portfolio change of a fill', () => {
      const portfolioBefore = new Map<string, BalanceDetail>([
        ['BTC', { free: 1, used: 0, total: 1 }],
        ['USDT', { free: 100_000, used: 0, total: 100_000 }],
      ]);
      // A BUY of 0.005 at 100000, with a fee of 0.1 %: no balance moves by 1 % or more
      const portfolioAfter = new Map<string, BalanceDetail>([
        ['BTC', { free: 1.005, used: 0, total: 1.005 }],
        ['USDT', { free: 99_499.5, used: 0, total: 99_499.5 }],
      ]);

      beforeEach(async () => {
        trader = new Trader({ portfolioUpdates: { threshold: 1, dust: 10 } });
        trader['currentTimestamp'] = 1_700_000_000_000;
        trader['getExchange'] = vi.fn().mockReturnValue(fakeExchange);
        trader['addDeferredEmit'] = vi.fn();
        fakeExchange.fetchTickers.mockResolvedValue({ 'BTC/USDT': { bid: 100_000 } });
        fakeExchange.fetchBalance.mockResolvedValueOnce(portfolioBefore).mockResolvedValue(portfolioAfter);
        await trader['synchronize'](); // The first one, always emitted
        const order = await prepareOrder('creation', buildAdvice({ type: 'MARKET', amount: 0.005 }));
        await order.emitAndSettle(ORDER_COMPLETED_EVENT);
      });

      it('emits no portfolio change after the fill', () => {
        const calls = (trader['addDeferredEmit'] as unknown as Mock).mock.calls;
        expect(calls.filter(([event]) => event === PORTFOLIO_CHANGE_EVENT)).toEqual([[PORTFOLIO_CHANGE_EVENT, portfolioBefore]]);
      });

      it('relays the fill with the portfolio after it', () => {
        expect(getCompletedEvent()?.exchange.portfolio).toEqual(portfolioAfter);
      });
    });

    // One synchronization at a time: two in flight could end in any order, the older one overwriting what the newer one read
    describe('Overlapping calls', () => {
      it('fetches the balance once for two calls made while a synchronization is in flight', async () => {
        await Promise.all([trader['synchronize'](), trader['synchronize']()]);
        expect(fakeExchange.fetchBalance).toHaveBeenCalledOnce();
      });

      it('emits the portfolio once for two calls made while a synchronization is in flight', async () => {
        await Promise.all([trader['synchronize'](), trader['synchronize']()]);
        expect(trader['addDeferredEmit']).toHaveBeenCalledOnce();
      });

      it('shares the failure of the synchronization in flight with the call that joined it', async () => {
        fakeExchange.fetchBalance.mockRejectedValueOnce(new Error('network down'));
        const [, joined] = await Promise.allSettled([trader['synchronize'](), trader['synchronize']()]);
        expect(joined).toEqual({ status: 'rejected', reason: new Error('network down') });
      });

      it.each`
        outcome     | rejection
        ${'ended'}  | ${undefined}
        ${'failed'} | ${new Error('network down')}
      `('fetches the balance again for a call made once the synchronization has $outcome', async ({ rejection }) => {
        if (rejection) fakeExchange.fetchBalance.mockRejectedValueOnce(rejection);
        await trader['synchronize']().catch(noop);
        await trader['synchronize']();
        expect(fakeExchange.fetchBalance).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('processInit', () => {
    const exchangeSynchInterval = 60_000;

    beforeEach(() => {
      getExchangeMock.mockReturnValue({ name: 'binance', exchangeSynchInterval });
    });

    it('synchronizes at once', async () => {
      trader['processInit']();
      await tick();
      expect(fakeExchange.fetchBalance).toHaveBeenCalledOnce();
    });

    it('synchronizes again every exchangeSynchInterval in realtime', async () => {
      trader['processInit']();
      await vi.advanceTimersByTimeAsync(exchangeSynchInterval);
      expect(fakeExchange.fetchBalance).toHaveBeenCalledTimes(2);
    });

    it('does not synchronize periodically in backtest', async () => {
      (trader as any).mode = 'backtest';
      trader['processInit']();
      await vi.advanceTimersByTimeAsync(exchangeSynchInterval);
      expect(fakeExchange.fetchBalance).toHaveBeenCalledOnce();
    });

    it('stops the periodic synchronization once finalized', async () => {
      trader['processInit']();
      trader['processFinalize']();
      await vi.advanceTimersByTimeAsync(exchangeSynchInterval);
      expect(fakeExchange.fetchBalance).toHaveBeenCalledOnce();
    });

    // Neither is awaited: a rejection would be unhandled, and a failed synchronization is not fatal, the next one tries again
    it.each`
      synchronization | failingCall
      ${'first'}      | ${1}
      ${'periodic'}   | ${2}
    `('logs a $synchronization synchronization that fails instead of leaving the rejection unhandled', async ({ failingCall }) => {
      fakeExchange.fetchBalance.mockImplementation(async () => {
        if (fakeExchange.fetchBalance.mock.calls.length === failingCall) throw new Error('network down');
        return new Map();
      });
      trader['processInit']();
      await vi.advanceTimersByTimeAsync(exchangeSynchInterval);
      expect(logger.error).toHaveBeenCalledWith('trader', 'Impossible to synchronize: network down');
    });

    // Quoted under the Trader's tag: a GekkoError without its own, which showed two tags, and a value without a prototype as util.inspect
    // writes it: String() threw for it, from the handler meant to log the failure, and left the rejection unhandled
    it.each`
      failure                          | thrown                                                                         | reason
      ${'a GekkoError'}                | ${new GekkoError('exchange', 'binance GET /api/v3/account request timed out')} | ${'binance GET /api/v3/account request timed out'}
      ${'a value without a prototype'} | ${Object.assign(Object.create(null), { status: 503 })}                         | ${'[Object: null prototype] { status: 503 }'}
    `('logs a synchronization that fails with $failure as: Impossible to synchronize: $reason', async ({ thrown, reason }) => {
      fakeExchange.fetchBalance.mockRejectedValue(thrown);
      trader['processInit']();
      await vi.advanceTimersByTimeAsync(0);
      expect(logger.error).toHaveBeenCalledWith('trader', `Impossible to synchronize: ${reason}`);
    });

    describe('when a periodic synchronization comes while one is in flight', () => {
      beforeEach(async () => {
        fakeExchange.fetchBalance.mockReturnValueOnce(new Promise(noop));
        trader['processInit']();
        await vi.advanceTimersByTimeAsync(exchangeSynchInterval);
      });

      it('skips it', () => {
        expect(fakeExchange.fetchBalance).toHaveBeenCalledOnce();
      });

      it('says so at debug level', () => {
        expect(logger.debug).toHaveBeenCalledWith('trader', 'Synchronization skipped: another one is in flight');
      });
    });
  });

  // The bucket that ends the warmup was processed as it arrived, like every bucket: what is left is a synchronization, which emits the
  // portfolio unless the portfolioUpdates filter holds it back
  describe('onStrategyWarmupCompleted', () => {
    const bucket = new Map([['BTC/USDT', defaultCandle]]) as any;

    // As in the stream: every plugin processes the bucket that ends the warmup, then its events are flushed
    const completeWarmup = async () => {
      await trader['processOneMinuteBucket'](bucket);
      await trader.onStrategyWarmupCompleted([bucket]);
    };

    it('synchronizes once', async () => {
      await completeWarmup();
      expect(fakeExchange.fetchBalance).toHaveBeenCalledOnce();
    });

    it('emits the portfolio it fetched', async () => {
      await completeWarmup();
      expect(trader['addDeferredEmit']).toHaveBeenCalledWith(PORTFOLIO_CHANGE_EVENT, trader['portfolio']);
    });

    it('checks a STICKY order once for the bucket that ends the warmup in backtest', async () => {
      (trader as any).mode = 'backtest';
      await trader.onStrategyCreateOrder([buildAdvice({ amount: 1, price: 100 })]);
      await completeWarmup();
      expect(orderActions.checkOrder).toHaveBeenCalledOnce();
    });

    // The synchronization at the start emitted the first portfolio read: with the filter, the one at the end of the warmup emits only a
    // portfolio that moved past it since, here by more than 1 % of the USDT
    describe('with the portfolioUpdates filter', () => {
      const portfolioHolding = (usdt: number) =>
        new Map<string, BalanceDetail>([
          ['BTC', { free: 1, used: 0, total: 1 }],
          ['USDT', { free: usdt, used: 0, total: usdt }],
        ]);
      const getEmittedPortfolios = () =>
        (trader['addDeferredEmit'] as unknown as Mock).mock.calls
          .filter(([event]) => event === PORTFOLIO_CHANGE_EVENT)
          .map(([, portfolio]) => portfolio);

      beforeEach(() => {
        trader = new Trader({ portfolioUpdates: { threshold: 1, dust: 10 } });
        trader['currentTimestamp'] = 1_700_000_000_000;
        trader['getExchange'] = vi.fn().mockReturnValue(fakeExchange);
        trader['addDeferredEmit'] = vi.fn();
      });

      it.each`
        usdt    | emitted
        ${1000} | ${[1000]}
        ${1005} | ${[1000]}
        ${1020} | ${[1000, 1020]}
      `('emits the portfolios of $emitted USDT when the USDT went from 1000 to $usdt during the warmup', async ({ usdt, emitted }) => {
        fakeExchange.fetchBalance.mockResolvedValueOnce(portfolioHolding(1000)).mockResolvedValue(portfolioHolding(usdt));
        await trader['synchronize'](); // At the start (see processInit)
        await completeWarmup();
        expect(getEmittedPortfolios()).toEqual(emitted.map(portfolioHolding));
      });
    });

    // Best effort, like every synchronization of the plugin: a rejection leaving the handler would end the run
    describe('when the synchronization fails', () => {
      let settled: PromiseSettledResult<void>[];

      beforeEach(async () => {
        fakeExchange.fetchBalance.mockRejectedValue(new Error('network down'));
        settled = await Promise.allSettled([completeWarmup()]);
      });

      it('resolves instead of rejecting', () => {
        expect(settled).toEqual([{ status: 'fulfilled', value: undefined }]);
      });

      it('logs the failure', () => {
        expect(logger.error).toHaveBeenCalledWith('trader', '[warmup] Impossible to synchronize: network down');
      });
    });
  });

  describe('processOneMinuteBucket', () => {
    it('should update price for all symbols in bucket', async () => {
      trader['prices'].set('BTC/USDT', 0);
      const bucket = new Map([['BTC/USDT', defaultCandle]]) as any;

      await trader['processOneMinuteBucket'](bucket);

      expect(trader['prices'].get('BTC/USDT')).toBe(100);
    });

    it('should NOT trigger synchronize in realtime mode even if interval matches', async () => {
      (trader as any).mode = 'realtime';
      trader['synchronize'] = vi.fn();
      const bucket = new Map([['BTC/USDT', defaultCandle]]) as any;

      await trader['processOneMinuteBucket'](bucket);

      expect(trader['synchronize']).not.toHaveBeenCalled();
    });

    it('should update currentTimestamp', async () => {
      trader['currentTimestamp'] = 0;
      const bucket = new Map([['BTC/USDT', defaultCandle]]) as any;

      await trader['processOneMinuteBucket'](bucket);

      expect(trader['currentTimestamp']).toBe(1_700_000_060_000); // start + 1 min
    });

    // The backtest synchronizes on the minutes since the epoch that are a multiple of getBacktestModeIntervalSyncTime, 10 at 1m, the
    // minutes counted as date-fns' differenceInMinutes counted them: truncated
    it.each`
      start                | minute                              | calls
      ${1_700_000_400_000} | ${'28,333,340'}                     | ${1}
      ${1_700_000_430_000} | ${'28,333,340, 30 seconds into it'} | ${1}
      ${1_700_000_460_000} | ${'28,333,341'}                     | ${0}
      ${1_700_000_940_000} | ${'28,333,349'}                     | ${0}
      ${1_700_001_000_000} | ${'28,333,350'}                     | ${1}
    `('synchronizes $calls time(s) in backtest on a bucket of minute $minute since the epoch', async ({ start, calls }) => {
      (trader as any).mode = 'backtest';
      const synchronizeSpy = vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);

      await trader['processOneMinuteBucket'](new Map([['BTC/USDT', { ...defaultCandle, start }]]));

      expect(synchronizeSpy).toHaveBeenCalledTimes(calls);
    });

    // At a timeframe of the watch above 10 minutes, once a timeframe candle: 28,333,335 is a multiple of 15 but not of 10, 28,333,320 a
    // multiple of 60, and 28,333,340 a multiple of 10 but of neither 15 nor 60
    it.each`
      timeframe | start                | minute          | calls
      ${'15m'}  | ${1_700_000_100_000} | ${'28,333,335'} | ${1}
      ${'15m'}  | ${1_700_000_400_000} | ${'28,333,340'} | ${0}
      ${'1h'}   | ${1_699_999_200_000} | ${'28,333,320'} | ${1}
      ${'1h'}   | ${1_700_000_400_000} | ${'28,333,340'} | ${0}
    `(
      'synchronizes $calls time(s) in a backtest at $timeframe on a bucket of minute $minute since the epoch',
      async ({ timeframe, start, calls }) => {
        getWatchMock.mockReturnValue({ ...cloneWatch(), timeframe });
        trader = new Trader();
        trader['currentTimestamp'] = 1_700_000_000_000; // Not the first bucket, which the backtest does not synchronize on
        (trader as any).mode = 'backtest';
        const synchronizeSpy = vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);

        await trader['processOneMinuteBucket'](new Map([['BTC/USDT', { ...defaultCandle, start }]]));

        expect(synchronizeSpy).toHaveBeenCalledTimes(calls);
      },
    );

    // In backtest a bucket checks the STICKY orders and waits for the reports in flight. With no order listed, nothing can be checked,
    // nor start a report: awaited all the same, each cost a turn of the microtask queue, on most buckets of a run.
    describe('in backtest, with no order listed and no report in flight', () => {
      const bucket = new Map([['BTC/USDT', defaultCandle]]) as any;

      beforeEach(() => {
        (trader as any).mode = 'backtest';
      });

      it.each`
        method
        ${'checkStickyOrders'}
        ${'settlePendingReports'}
      `('does not call $method', async ({ method }) => {
        const spy = vi.spyOn(trader as any, method);
        await trader['processOneMinuteBucket'](bucket);
        expect(spy).not.toHaveBeenCalled();
      });
    });

    // In realtime an interval of each order runs its check. In backtest nothing does but the bucket, for the STICKY orders, which
    // move to follow the market: the simulated exchange settles LIMIT and MARKET orders through the callback of their creation.
    describe('order checks', () => {
      const ids = [
        '0f8f6f36-31c4-4c39-9a3b-7f9e0c1d2a01',
        '0f8f6f36-31c4-4c39-9a3b-7f9e0c1d2a02',
        '0f8f6f36-31c4-4c39-9a3b-7f9e0c1d2a03',
      ] as const;
      const bucket = new Map([['BTC/USDT', defaultCandle]]) as any;
      // A minute that is a multiple of 10, when the backtest synchronizes (see getBacktestModeIntervalSyncTime)
      const synchronizationBucket = new Map([['BTC/USDT', { ...defaultCandle, start: 1_700_000_400_000 }]]) as any;
      const getCheckedTypes = () => orderActions.checkOrder.mock.contexts.map(order => (order as any).getType());

      const createOrders = async (mode: 'backtest' | 'realtime', types: AdviceOrder['type'][]) => {
        (trader as any).mode = mode;
        await trader.onStrategyCreateOrder(types.map((type, index) => buildAdvice({ id: ids[index], type, amount: 1, price: 100 })));
      };

      it.each`
        mode          | types                            | checked
        ${'backtest'} | ${['STICKY', 'STICKY']}          | ${['STICKY', 'STICKY']}
        ${'backtest'} | ${['LIMIT', 'STICKY', 'MARKET']} | ${['STICKY']}
        ${'realtime'} | ${['STICKY', 'LIMIT', 'MARKET']} | ${[]}
      `('checks the $checked orders among the $types orders in flight in $mode', async ({ mode, types, checked }) => {
        await createOrders(mode, types);
        await trader['processOneMinuteBucket'](bucket);
        expect(getCheckedTypes()).toEqual(checked);
      });

      it('checks a STICKY order again at each bucket', async () => {
        await createOrders('backtest', ['STICKY']);
        await trader['processOneMinuteBucket'](bucket);
        await trader['processOneMinuteBucket'](bucket);
        expect(orderActions.checkOrder).toHaveBeenCalledTimes(2);
      });

      it('no longer checks an order once its end is reported', async () => {
        vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
        await createOrders('backtest', ['STICKY']);
        await getOrderInstance(ids[0]).emitAndSettle(ORDER_CANCELED_EVENT, { timestamp: 1_700_000_100_000, filled: 0, remaining: 1 });
        await trader['processOneMinuteBucket'](bucket);
        expect(orderActions.checkOrder).not.toHaveBeenCalled();
      });

      // The deferred events of the bucket are flushed once every plugin has processed it: a move must be over by then
      describe('while the check of an order is in flight', () => {
        let synchronizeSpy: ReturnType<typeof vi.spyOn>;
        let check: ReturnType<typeof deferred<undefined>>;
        let processed: Promise<void>;
        let isProcessed: boolean;

        beforeEach(async () => {
          synchronizeSpy = vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
          await createOrders('backtest', ['STICKY']);
          check = deferred<undefined>();
          orderActions.checkOrder.mockReturnValueOnce(check.promise);
          isProcessed = false;
          processed = trader['processOneMinuteBucket'](synchronizationBucket).then(() => {
            isProcessed = true;
          });
          await tick(10);
        });

        it('does not end the bucket yet', () => {
          expect(isProcessed).toBe(false);
        });

        it('does not synchronize yet', () => {
          expect(synchronizeSpy).not.toHaveBeenCalled();
        });

        it('synchronizes once it has ended', async () => {
          check.resolve(undefined);
          await processed;
          expect(synchronizeSpy).toHaveBeenCalledOnce();
        });
      });

      // A check reports its failures through the events of the order and never rejects: should it, the bucket goes on
      it.each`
        kind                   | rejection
        ${'an Error'}          | ${new Error('check exploded')}
        ${'a non-Error value'} | ${'check exploded'}
      `('logs a check rejecting with $kind', async ({ rejection }) => {
        await createOrders('backtest', ['STICKY']);
        orderActions.checkOrder.mockRejectedValueOnce(rejection);
        await trader['processOneMinuteBucket'](bucket);
        expect(logger.error).toHaveBeenCalledWith('trader', `[${ids[0]}] Impossible to check the BUY STICKY order: check exploded`);
      });

      it('ends the bucket when a check rejects', async () => {
        await createOrders('backtest', ['STICKY']);
        orderActions.checkOrder.mockRejectedValueOnce(new Error('check exploded'));
        await expect(trader['processOneMinuteBucket'](bucket)).resolves.toBeUndefined();
      });
    });
  });

  describe('onStrategyCreateOrder', () => {
    const getInitiatedEvent = () => {
      const emitCalls = (trader['addDeferredEmit'] as unknown as Mock).mock.calls;
      return emitCalls.find(call => call[0] === ORDER_INITIATED_EVENT)?.[1];
    };
    const getInitiatedOrder = () => getInitiatedEvent()?.order;
    const getPlacedAmount = ({ id }: AdviceOrder) => getOrderInstance(id)?.amount;
    const getInitiatedAmount = ({ id }: AdviceOrder) =>
      (trader['addDeferredEmit'] as unknown as Mock).mock.calls.find(
        ([event, { order }]) => event === ORDER_INITIATED_EVENT && order.id === id,
      )?.[1].order.amount;

    beforeEach(() => {
      trader['prices'].set('BTC/USDT', 100);
      trader['portfolio'] = new Map<string, BalanceDetail>([
        ['BTC', { free: 3, used: 0, total: 3 }],
        ['USDT', { free: 1000, used: 0, total: 1000 }],
      ]);
    });

    it('creates order in internal map', async () => {
      const advice = buildAdvice();
      await trader.onStrategyCreateOrder([advice]);
      expect(getOrdersMap().size).toBe(1);
    });

    it.each`
      field       | expected
      ${'id'}     | ${'20a7abd2-546b-4c65-b04d-900b84fa5fe6'}
      ${'type'}   | ${'STICKY'}
      ${'side'}   | ${'BUY'}
      ${'amount'} | ${9.5}
    `('emits initiated event with correct $field', async ({ field, expected }) => {
      const advice = buildAdvice();
      await trader.onStrategyCreateOrder([advice]);
      const initiated = getInitiatedOrder();

      if (typeof expected === 'number') {
        expect(initiated?.[field]).toBeCloseTo(expected);
      } else {
        expect(initiated?.[field]).toBe(expected);
      }
    });

    it.each`
      side      | currencyFree | assetFree | price  | expectedAmount | desc
      ${'BUY'}  | ${1000}      | ${0}      | ${100} | ${9.5}         | ${'BUY uses currency / price * (1 - fee)'}
      ${'SELL'} | ${0}         | ${2.5}    | ${100} | ${2.5}         | ${'SELL uses full asset free balance'}
    `('computes correct amount for $desc', async ({ side, currencyFree, assetFree, price, expectedAmount }) => {
      trader['portfolio'] = new Map<string, BalanceDetail>([
        ['BTC', { free: assetFree, used: 0, total: assetFree }],
        ['USDT', { free: currencyFree, used: 0, total: currencyFree }],
      ]);
      trader['prices'].set('BTC/USDT', price);
      const advice = buildAdvice({ side, type: 'MARKET' });

      await trader.onStrategyCreateOrder([advice]);

      const initiated = getInitiatedOrder();
      expect(initiated?.amount).toBeCloseTo(expectedAmount, 5);
    });

    it('uses provided quantity when present in advice', async () => {
      const advice = buildAdvice({ amount: 1.2345, type: 'MARKET', side: 'BUY' });

      await trader.onStrategyCreateOrder([advice]);

      const initiated = getInitiatedOrder();
      expect(initiated?.amount).toBeCloseTo(1.2345, 5);

      const metadata = getOrderMetadata(advice.id);
      expect(metadata?.amount).toBeCloseTo(1.2345, 5);
    });

    // A BUY of 0.5 BTC whose fee (0.1 %) the exchange took from the BTC bought, as Binance does unless the fees are paid in BNB: the
    // account holds 0.4995 BTC, and the SELL of the 0.5 the BUY filled (its trailing stop) is refused for insufficient balance
    describe('when a SELL asks for more than the free balance of the asset', () => {
      const advice = buildAdvice({ side: 'SELL', type: 'MARKET', amount: 0.5 });

      beforeEach(async () => {
        trader['portfolio'] = new Map<string, BalanceDetail>([
          ['BTC', { free: 0.4995, used: 0, total: 0.4995 }],
          ['USDT', { free: 1000, used: 0, total: 1000 }],
        ]);
        await trader.onStrategyCreateOrder([advice]);
      });

      it('places the order for the free balance', () => {
        expect(getOrderInstance(advice.id)?.amount).toBe(0.4995);
      });

      it('relays the free balance as the amount of the order', () => {
        expect(getInitiatedOrder()?.amount).toBe(0.4995);
      });

      it('warns with the amount asked for and the amount sent', () => {
        expect(logger.warning).toHaveBeenCalledWith(
          'trader',
          `[${advice.id}] SELL MARKET order of 0.5 BTC above the free balance: 0.4995 BTC sent, all that can be sold`,
        );
      });
    });

    // A balance of 0 may be a portfolio not synchronized yet; NaN and Infinity are refused, as before, rather than sold all-in
    it.each`
      description                                    | side      | amount      | assetFree
      ${'a SELL within the free balance'}            | ${'SELL'} | ${0.4}      | ${0.4995}
      ${'a SELL of the whole free balance'}          | ${'SELL'} | ${0.4995}   | ${0.4995}
      ${'a SELL while the free balance known is 0'}  | ${'SELL'} | ${0.5}      | ${0}
      ${'a SELL of NaN'}                             | ${'SELL'} | ${NaN}      | ${0.4995}
      ${'a SELL of Infinity'}                        | ${'SELL'} | ${Infinity} | ${0.4995}
      ${'a BUY above the free balance of the asset'} | ${'BUY'}  | ${0.5}      | ${0.4995}
    `('places $description for the amount asked for', async ({ side, amount, assetFree }) => {
      trader['portfolio'] = new Map<string, BalanceDetail>([
        ['BTC', { free: assetFree, used: 0, total: assetFree }],
        ['USDT', { free: 1000, used: 0, total: 1000 }],
      ]);
      const advice = buildAdvice({ side, type: 'MARKET', amount });

      await trader.onStrategyCreateOrder([advice]);

      expect(getOrderInstance(advice.id)?.amount).toBe(amount);
    });

    // Two BUYs of 0.5 and 0.3 BTC whose fees (0.1 %) the exchange took from the BTC bought: the account holds 0.7992 BTC, and their
    // trailing stops trigger on the same minute. Each SELL was capped against the whole balance read: the SELL of 0.3 was refused.
    describe('when SELLs of one asset are placed before the balance is read again', () => {
      const sell = (id: number, amount?: number, type: AdviceOrder['type'] = 'MARKET', symbol: AdviceOrder['symbol'] = 'BTC/USDT') =>
        buildAdvice({
          id: `00000000-0000-4000-8000-00000000000${id}`,
          side: 'SELL',
          type,
          amount,
          symbol,
          price: type === 'LIMIT' ? 120 : undefined,
        });
      const firstSell = sell(1, 0.5);
      const secondSell = sell(2, 0.3);
      const allInSell = sell(3);
      const buy = buildAdvice({ id: '00000000-0000-4000-8000-000000000004', side: 'BUY', type: 'MARKET' });
      const balance = (btcFree: number) =>
        new Map<string, BalanceDetail>([
          ['BTC', { free: btcFree, used: 0, total: btcFree }],
          ['ETH', { free: 2, used: 0, total: 2 }],
          ['USDT', { free: 1000, used: 0, total: 1000 }],
        ]);

      beforeEach(() => {
        trader['portfolio'] = balance(0.7992);
        trader['prices'].set('ETH/USDT', 10);
      });

      describe('in one batch', () => {
        beforeEach(async () => {
          await trader.onStrategyCreateOrder([firstSell, secondSell]);
        });

        it.each`
          order       | advice        | amount
          ${'first'}  | ${firstSell}  | ${0.5}
          ${'second'} | ${secondSell} | ${0.2992}
        `('places the $order for $amount', ({ advice, amount }) => {
          expect(getPlacedAmount(advice)).toBe(amount);
        });

        it('relays what the first leaves as the amount of the second', () => {
          expect(getInitiatedAmount(secondSell)).toBe(0.2992);
        });

        it('warns with the free balance read and what the SELLs placed since take from it', () => {
          expect(logger.warning).toHaveBeenCalledWith(
            'trader',
            `[${secondSell.id}] SELL MARKET order of 0.3 BTC above the free balance: 0.2992 BTC sent, all that can be sold (0.7992 BTC free at the last synchronization, less 0.5 BTC for the SELLs placed since)`,
          );
        });
      });

      // The BUY's coins are not in the balance before it fills, and a BUY is sized from the currency
      it.each`
        order                | advice        | amount
        ${'the BUY'}         | ${buy}        | ${9.5}
        ${'the second SELL'} | ${secondSell} | ${0.2992}
      `('places $order of a batch with a BUY between the SELLs for $amount', async ({ advice, amount }) => {
        await trader.onStrategyCreateOrder([firstSell, buy, secondSell]);
        expect(getPlacedAmount(advice)).toBe(amount);
      });

      // Two groups of one flush: a line the strategy logs from the hook of the first stop comes between the two SELLs
      it('places the second of two batches for what the first leaves', async () => {
        await trader.onStrategyCreateOrder([firstSell]);
        await trader.onStrategyCreateOrder([secondSell]);
        expect(getPlacedAmount(secondSell)).toBe(0.2992);
      });

      it.each`
        description                                                  | before                             | advice        | amount
        ${'an all-in SELL for what the SELLs before leave'}          | ${[firstSell]}                     | ${allInSell}  | ${0.2992}
        ${'a SELL as asked once nothing is left'}                    | ${[sell(5, 0.7992)]}               | ${secondSell} | ${0.3}
        ${'an all-in SELL for 0 once nothing is left'}               | ${[sell(5, 0.7992)]}               | ${allInSell}  | ${0}
        ${'an all-in SELL for 0 once the SELLs before ask for more'} | ${[sell(5, 0.7992), sell(6, 0.3)]} | ${allInSell}  | ${0}
      `('places $description', async ({ before, advice, amount }) => {
        await trader.onStrategyCreateOrder([...before, advice]);
        expect(getPlacedAmount(advice)).toBe(amount);
      });

      it('does not warn of an all-in SELL', async () => {
        await trader.onStrategyCreateOrder([firstSell, allInSell]);
        expect(logger.warning).not.toHaveBeenCalled();
      });

      // Added and subtracted as written, 0.7 - (0.1 + 0.2) is 0.3999999999999999
      it('places an all-in SELL for what the SELLs before leave, to the decimal', async () => {
        trader['portfolio'] = balance(0.7);
        await trader.onStrategyCreateOrder([sell(1, 0.1), sell(2, 0.2), allInSell]);
        expect(getPlacedAmount(allInSell)).toBe(0.4);
      });

      // Refused by the exchange, it takes nothing from the balance
      it.each`
        amount
        ${NaN}
        ${Infinity}
        ${0}
        ${-0.5}
      `('places an all-in SELL for what the SELLs before leave when one asks for $amount', async ({ amount }) => {
        await trader.onStrategyCreateOrder([sell(5, amount), firstSell, allInSell]);
        expect(getPlacedAmount(allInSell)).toBe(0.2992);
      });

      it('places a SELL as asked after a SELL of another asset', async () => {
        await trader.onStrategyCreateOrder([sell(1, 0.5, 'MARKET', 'ETH/USDT'), secondSell]);
        expect(getPlacedAmount(secondSell)).toBe(0.3);
      });

      // Its read shows the first SELL, filled: taken from it a second time, that SELL would have left the next one short
      describe('once a synchronization started after them has read the balance', () => {
        beforeEach(async () => {
          await trader.onStrategyCreateOrder([firstSell]);
          fakeExchange.fetchBalance.mockResolvedValue(balance(0.2992));
          await trader['synchronize']();
          await trader.onStrategyCreateOrder([secondSell]);
        });

        it('places the next SELL against that balance alone', () => {
          expect(getPlacedAmount(secondSell)).toBe(0.2992);
        });

        it('warns with that balance alone', () => {
          expect(logger.warning).toHaveBeenCalledWith(
            'trader',
            `[${secondSell.id}] SELL MARKET order of 0.3 BTC above the free balance: 0.2992 BTC sent, all that can be sold`,
          );
        });
      });

      // The balance read before them is still the one held
      it('places the next SELL for what the first leaves once a synchronization has failed to read the balance', async () => {
        await trader.onStrategyCreateOrder([firstSell]);
        fakeExchange.fetchBalance.mockRejectedValueOnce(new Error('network down'));
        await trader['synchronize']().catch(noop);
        await trader.onStrategyCreateOrder([secondSell]);
        expect(getPlacedAmount(secondSell)).toBe(0.2992);
      });

      // It read the balance before the SELL reached the exchange
      it('places the next SELL for what the first leaves once a synchronization started before them has read the balance', async () => {
        const read = deferred<Portfolio>();
        fakeExchange.fetchBalance.mockReturnValueOnce(read.promise);
        const inFlight = trader['synchronize']();
        await trader.onStrategyCreateOrder([firstSell]);
        read.resolve(balance(0.7992));
        await inFlight;
        await trader.onStrategyCreateOrder([secondSell]);
        expect(getPlacedAmount(secondSell)).toBe(0.2992);
      });

      // The exchange gets the cancelation first, and releases what the canceled SELL reserved
      it.each`
        description                                          | placed                                            | amount
        ${'all it holds once the strategy cancels its SELL'} | ${[sell(1, 0.5, 'LIMIT')]}                        | ${0.7992}
        ${'what the SELL it does not cancel leaves'}         | ${[sell(1, 0.5, 'LIMIT'), sell(2, 0.2, 'LIMIT')]} | ${0.5992}
      `('places an all-in SELL for $description', async ({ placed, amount }) => {
        await trader.onStrategyCreateOrder(placed);
        await trader.onStrategyCancelOrder([placed[0].id]);
        await trader.onStrategyCreateOrder([allInSell]);
        expect(getPlacedAmount(allInSell)).toBe(amount);
      });
    });

    // Two all-in BUYs on one candle, as a strategy with two entry signals sends them, or a BUY then an all-in BUY: each was sized from
    // the whole of the 1000 USDT read, and the second was refused for insufficient balance
    describe('when BUYs are placed before the balance is read again', () => {
      const buy = (id: number, amount?: number, type: AdviceOrder['type'] = 'MARKET', symbol: AdviceOrder['symbol'] = 'BTC/USDT') =>
        buildAdvice({
          id: `00000000-0000-4000-8000-00000000001${id}`,
          side: 'BUY',
          type,
          amount,
          symbol,
          price: type === 'LIMIT' ? 95 : undefined,
        });
      const firstAllIn = buy(1);
      const secondAllIn = buy(2);
      const sell = (amount?: number) => buildAdvice({ id: '00000000-0000-4000-8000-000000000020', side: 'SELL', type: 'MARKET', amount });
      const balance = (usdtFree: number) =>
        new Map<string, BalanceDetail>([
          ['BTC', { free: 0.7992, used: 0, total: 0.7992 }],
          ['ETH', { free: 2, used: 0, total: 2 }],
          ['USDT', { free: usdtFree, used: 0, total: usdtFree }],
        ]);

      beforeEach(() => {
        trader['portfolio'] = balance(1000);
        trader['prices'].set('ETH/USDT', 10);
        fakeExchange.fetchTickers.mockResolvedValue({ 'BTC/USDT': { bid: 100 } });
      });

      describe('in one batch', () => {
        beforeEach(async () => {
          await trader.onStrategyCreateOrder([firstAllIn, secondAllIn]);
        });

        it.each`
          order       | advice         | amount
          ${'first'}  | ${firstAllIn}  | ${9.5}
          ${'second'} | ${secondAllIn} | ${0}
        `('places the $order for $amount', ({ advice, amount }) => {
          expect(getPlacedAmount(advice)).toBe(amount);
        });

        it('relays what the first leaves as the amount of the second', () => {
          expect(getInitiatedAmount(secondAllIn)).toBe(0);
        });
      });

      // A BUY may spend its cost and the 5 % an all-in BUY keeps back for the fee, at the price of the order: for a LIMIT order the price
      // asked for, 95 here, the market at 100
      it.each`
        description                                                       | before                                       | advice         | amount
        ${'an all-in BUY for what a BUY of 4.75 leaves'}                  | ${[buy(3, 4.75)]}                            | ${secondAllIn} | ${4.75}
        ${'an all-in BUY for what a LIMIT BUY of 2 at 95 leaves'}         | ${[buy(4, 2, 'LIMIT')]}                      | ${secondAllIn} | ${7.6}
        ${'an all-in BUY for 0 once a BUY may spend more than was read'}  | ${[buy(5, 9.6)]}                             | ${secondAllIn} | ${0}
        ${'an all-in BUY of BTC for 0 once an all-in BUY of ETH took it'} | ${[buy(6, undefined, 'MARKET', 'ETH/USDT')]} | ${secondAllIn} | ${0}
        ${'a BUY as asked whatever the BUYs before may spend'}            | ${[firstAllIn]}                              | ${buy(7, 3)}   | ${3}
        ${'an all-in BUY for the whole currency after a SELL'}            | ${[sell(0.5)]}                               | ${secondAllIn} | ${9.5}
        ${'an all-in SELL for the whole asset after a BUY'}               | ${[firstAllIn]}                              | ${sell()}      | ${0.7992}
      `('places $description', async ({ before, advice, amount }) => {
        await trader.onStrategyCreateOrder([...before, advice]);
        expect(getPlacedAmount(advice)).toBe(amount);
      });

      // In binary, (currency / price) * 0.95 came out at 5.699999999999999, 7.598099999999999 and 4.499999999999999 BTC, which an
      // exchange that truncates the amount to its step placed one step short (5.69999 BTC)
      it.each`
        description                                          | read     | before                  | amount
        ${'the 600 USDT read'}                               | ${600}   | ${[]}                   | ${5.7}
        ${'the 799.8 USDT read'}                             | ${799.8} | ${[]}                   | ${7.5981}
        ${'what a LIMIT BUY of 4 at 95 leaves of 1000 USDT'} | ${1000}  | ${[buy(9, 4, 'LIMIT')]} | ${5.7}
        ${'what a BUY of 5 leaves of 1000 USDT'}             | ${1000}  | ${[buy(9, 5)]}          | ${4.5}
      `('places an all-in BUY spending $description for $amount BTC', async ({ read, before, amount }) => {
        trader['portfolio'] = balance(read);
        await trader.onStrategyCreateOrder([...before, secondAllIn]);
        expect(getPlacedAmount(secondAllIn)).toBe(amount);
      });

      it('relays the amount an all-in BUY is placed for, to the decimal', async () => {
        trader['portfolio'] = balance(600);
        await trader.onStrategyCreateOrder([secondAllIn]);
        expect(getInitiatedAmount(secondAllIn)).toBe(5.7);
      });

      it.each`
        before                  | sized  | sent    | taken
        ${[firstAllIn]}         | ${0}   | ${0}    | ${1000}
        ${[buy(3, 4.75)]}       | ${500} | ${4.75} | ${500}
        ${[buy(9, 4, 'LIMIT')]} | ${600} | ${5.7}  | ${400}
      `('warns of an all-in BUY sized from the $sized USDT the BUYs before it leave', async ({ before, sized, sent, taken }) => {
        await trader.onStrategyCreateOrder([...before, secondAllIn]);
        expect(logger.warning).toHaveBeenCalledWith(
          'trader',
          `[${secondAllIn.id}] All-in BUY MARKET order sized from ${sized} USDT: ${sent} BTC sent (1000 USDT free at the last synchronization, less ${taken} USDT for the BUYs placed since, the 5 % kept back for their fee included)`,
        );
      });

      it('does not warn of an all-in BUY placed alone', async () => {
        await trader.onStrategyCreateOrder([firstAllIn]);
        expect(logger.warning).not.toHaveBeenCalled();
      });

      // The first takes the currency it was sized from, to the last digit: worked out again from the amount it was sized to, it comes out
      // at 1000.0099999999999, and the second would be sized to 1.1e-15 BTC
      it('places a second all-in BUY for 0 whatever the currency the first was sized from', async () => {
        trader['portfolio'] = balance(1000.01);
        trader['prices'].set('BTC/USDT', 97.3);
        await trader.onStrategyCreateOrder([firstAllIn, secondAllIn]);
        expect(getPlacedAmount(secondAllIn)).toBe(0);
      });

      // Refused by the exchange, it takes nothing from the currency
      it.each`
        amount
        ${NaN}
        ${Infinity}
        ${0}
        ${-0.5}
      `('places an all-in BUY for what the BUYs before leave when one asks for $amount', async ({ amount }) => {
        await trader.onStrategyCreateOrder([buy(5, amount), buy(3, 4.75), secondAllIn]);
        expect(getPlacedAmount(secondAllIn)).toBe(4.75);
      });

      // A price of Infinity passes the Trader's check of the price: an all-in BUY at it is sized to 0, and the exchange refuses either
      it.each`
        description         | amount
        ${'an all-in BUY'}  | ${undefined}
        ${'a BUY of 2 BTC'} | ${2}
      `('places an all-in BUY for the whole currency after $description at a price of Infinity', async ({ amount }) => {
        await trader.onStrategyCreateOrder([buildAdvice({ ...buy(5, amount, 'LIMIT'), price: Infinity }), secondAllIn]);
        expect(getPlacedAmount(secondAllIn)).toBe(9.5);
      });

      // Its read shows the first BUY, filled: taken from it a second time, that BUY would have left the next one short
      describe('once a synchronization started after them has read the balance', () => {
        beforeEach(async () => {
          await trader.onStrategyCreateOrder([firstAllIn]);
          fakeExchange.fetchBalance.mockResolvedValue(balance(50));
          await trader['synchronize']();
          await trader.onStrategyCreateOrder([secondAllIn]);
        });

        it('places the next all-in BUY from that balance alone', () => {
          expect(getPlacedAmount(secondAllIn)).toBe(0.475);
        });

        it('does not warn of it', () => {
          expect(logger.warning).not.toHaveBeenCalled();
        });
      });

      // The balance read before them is still the one held
      it('places the next all-in BUY for what the first leaves once a synchronization has failed to read the balance', async () => {
        await trader.onStrategyCreateOrder([buy(3, 4.75)]);
        fakeExchange.fetchBalance.mockRejectedValueOnce(new Error('network down'));
        await trader['synchronize']().catch(noop);
        await trader.onStrategyCreateOrder([secondAllIn]);
        expect(getPlacedAmount(secondAllIn)).toBe(4.75);
      });

      // It read the balance before the BUY reached the exchange
      it('places the next all-in BUY for what the first leaves once a synchronization started before them has read the balance', async () => {
        const read = deferred<Portfolio>();
        fakeExchange.fetchBalance.mockReturnValueOnce(read.promise);
        const inFlight = trader['synchronize']();
        await trader.onStrategyCreateOrder([buy(3, 4.75)]);
        read.resolve(balance(1000));
        await inFlight;
        await trader.onStrategyCreateOrder([secondAllIn]);
        expect(getPlacedAmount(secondAllIn)).toBe(4.75);
      });

      // The exchange gets the cancelation first, and releases what the canceled BUY reserved
      it.each`
        description                                               | placed                                      | amount
        ${'the whole currency once the strategy cancels its BUY'} | ${[buy(4, 2, 'LIMIT')]}                     | ${9.5}
        ${'what the BUY it does not cancel leaves'}               | ${[buy(4, 2, 'LIMIT'), buy(8, 2, 'LIMIT')]} | ${7.6}
      `('places an all-in BUY for $description', async ({ placed, amount }) => {
        await trader.onStrategyCreateOrder(placed);
        await trader.onStrategyCancelOrder([placed[0].id]);
        await trader.onStrategyCreateOrder([secondAllIn]);
        expect(getPlacedAmount(secondAllIn)).toBe(amount);
      });
    });

    // LIMIT and STICKY BUYs can build a position larger than one MARKET order can sell (Binance's MARKET_LOT_SIZE: tens of BTC on
    // BTCUSDT, against 9000 for LOT_SIZE): the SELL of the whole, the strategy's or its trailing stop's, was refused at each signal or
    // minute until the circuit breaker stopped the bot, the position unsold
    describe('when an order asks for more than the market takes in one order', () => {
      // LOT_SIZE (amount) up to 1 BTC, MARKET_LOT_SIZE (market) up to 0.5 BTC; the account holds 3 BTC and 1000 USDT, BTC at 100
      const marketData = { amount: { min: 0.00001, max: 1 }, market: { min: 0, max: 0.5 } };
      const order = (side: AdviceOrder['side'], type: AdviceOrder['type'], amount?: number, index = 0) =>
        buildAdvice({ id: `00000000-0000-4000-8000-00000000003${index}`, side, type, amount, price: type === 'LIMIT' ? 120 : undefined });

      beforeEach(() => {
        fakeExchange.getMarketData.mockReturnValue(marketData);
      });

      it.each`
        description                                       | advice                               | amount
        ${'a STICKY SELL of 2 BTC'}                       | ${order('SELL', 'STICKY', 2)}        | ${1}
        ${'a LIMIT SELL of 2 BTC'}                        | ${order('SELL', 'LIMIT', 2)}         | ${1}
        ${'a MARKET SELL of 2 BTC'}                       | ${order('SELL', 'MARKET', 2)}        | ${0.5}
        ${'a STICKY SELL of 5 BTC, above the 3 BTC held'} | ${order('SELL', 'STICKY', 5)}        | ${1}
        ${'an all-in MARKET SELL of the 3 BTC held'}      | ${order('SELL', 'MARKET')}           | ${0.5}
        ${'an all-in STICKY SELL of the 3 BTC held'}      | ${order('SELL', 'STICKY')}           | ${1}
        ${'an all-in MARKET BUY of 9.5 BTC'}              | ${order('BUY', 'MARKET')}            | ${0.5}
        ${'a LIMIT SELL of 0.8 BTC, within its maximum'}  | ${order('SELL', 'LIMIT', 0.8)}       | ${0.8}
        ${'a MARKET BUY of 2 BTC, as asked'}              | ${order('BUY', 'MARKET', 2)}         | ${2}
        ${'a SELL of NaN, as asked'}                      | ${order('SELL', 'MARKET', NaN)}      | ${NaN}
        ${'a SELL of Infinity, as asked'}                 | ${order('SELL', 'MARKET', Infinity)} | ${Infinity}
      `('places $description for $amount BTC', async ({ advice, amount }) => {
        await trader.onStrategyCreateOrder([advice]);
        expect(getPlacedAmount(advice)).toBe(amount);
      });

      it('relays 0.5 BTC, the amount sent, as the amount of the order', async () => {
        const advice = order('SELL', 'MARKET', 2);
        await trader.onStrategyCreateOrder([advice]);
        expect(getInitiatedAmount(advice)).toBe(0.5);
      });

      // What the StrategyManager compares with the amount a trailing stop asked its SELL for, the rest still held
      it('relays 0.5 BTC, the amount sent, as the amount the SELL executed once it completes', async () => {
        vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
        const sell = await prepareOrder('creation', order('SELL', 'MARKET', 2));
        await sell.emitAndSettle(ORDER_COMPLETED_EVENT);
        expect(getCompletedEvent()?.order.amount).toBe(0.5);
      });

      it.each`
        description                                       | advice                        | message
        ${'a STICKY SELL of 2 BTC'}                       | ${order('SELL', 'STICKY', 2)} | ${'SELL STICKY order of 2 BTC above the maximum amount of a STICKY order on BTC/USDT: 1 BTC sent, the rest stays held'}
        ${'a STICKY SELL of 5 BTC, above the 3 BTC held'} | ${order('SELL', 'STICKY', 5)} | ${'SELL STICKY order of 5 BTC above the maximum amount of a STICKY order on BTC/USDT: 1 BTC sent, the rest stays held'}
        ${'an all-in MARKET SELL of the 3 BTC held'}      | ${order('SELL', 'MARKET')}    | ${'All-in SELL MARKET order of 3 BTC above the maximum amount of a MARKET order on BTC/USDT: 0.5 BTC sent, the rest stays held'}
        ${'an all-in MARKET BUY of 9.5 BTC'}              | ${order('BUY', 'MARKET')}     | ${'All-in BUY MARKET order sized from 1000 USDT: 9.5 BTC, above the maximum amount of a MARKET order on BTC/USDT: 0.5 BTC sent, the rest of the USDT left unspent'}
      `('warns once of $description, with the amount asked for, the maximum sent and the rest', async ({ advice, message }) => {
        await trader.onStrategyCreateOrder([advice]);
        expect(logger.warning).toHaveBeenCalledExactlyOnceWith('trader', `[${advice.id}] ${message}`);
      });

      it.each`
        description                                      | advice
        ${'a LIMIT SELL of 0.8 BTC, within its maximum'} | ${order('SELL', 'LIMIT', 0.8)}
        ${'a MARKET BUY of 2 BTC, placed as asked'}      | ${order('BUY', 'MARKET', 2)}
      `('does not warn of $description', async ({ advice }) => {
        await trader.onStrategyCreateOrder([advice]);
        expect(logger.warning).not.toHaveBeenCalled();
      });

      // Until the balance is read again, a capped order takes from it what it sends (see unreadOrders): taking what the SELL asked for,
      // or the whole currency the all-in BUY was sized from, would leave the order after it short
      it.each`
        description                                                          | maximum | first                                   | second                                   | amount
        ${'an all-in SELL for what a STICKY SELL of 2.5 capped at 2 leaves'} | ${2}    | ${order('SELL', 'STICKY', 2.5, 1)}      | ${order('SELL', 'STICKY', undefined, 2)} | ${1}
        ${'an all-in BUY for what an all-in BUY capped at 5 leaves'}         | ${5}    | ${order('BUY', 'STICKY', undefined, 1)} | ${order('BUY', 'STICKY', undefined, 2)}  | ${4.5}
      `('places $description for $amount BTC', async ({ maximum, first, second, amount }) => {
        fakeExchange.getMarketData.mockReturnValue({ amount: { max: maximum } });
        await trader.onStrategyCreateOrder([first, second]);
        expect(getPlacedAmount(second)).toBe(amount);
      });

      // Binance disables a filter bound by setting it to 0
      it.each`
        description              | limits
        ${'a maximum of 0'}      | ${{ amount: { max: 0 }, market: { max: 0 } }}
        ${'an infinite maximum'} | ${{ amount: { max: Infinity } }}
        ${'a NaN maximum'}       | ${{ amount: { max: NaN } }}
        ${'no amount range'}     | ${{ price: { min: 0.01 } }}
      `('places a MARKET SELL of 2 BTC as asked on a market with $description', async ({ limits }) => {
        fakeExchange.getMarketData.mockReturnValue(limits);
        const advice = order('SELL', 'MARKET', 2);
        await trader.onStrategyCreateOrder([advice]);
        expect(getPlacedAmount(advice)).toBe(2);
      });
    });

    // Placed for 0 and refused for it, with a reason that names the amount, not its cause: no currency on the account (a
    // simulationBalance naming another one), or no balance read from the exchange yet
    describe('when an all-in BUY is sized from no currency at all', () => {
      const advice = buildAdvice({ side: 'BUY', type: 'MARKET' });
      const btc: BalanceDetail = { free: 3, used: 0, total: 3 };

      it.each`
        description                 | portfolio                                                            | cause
        ${'0 USDT free'}            | ${new Map([['BTC', btc], ['USDT', { free: 0, used: 0, total: 0 }]])} | ${'0 USDT free at the last synchronization'}
        ${'no USDT on the account'} | ${new Map([['BTC', btc]])}                                           | ${'0 USDT free at the last synchronization'}
        ${'no balance read yet'}    | ${new Map()}                                                         | ${'no balance read from the exchange yet'}
      `('warns of it with its cause when $description', async ({ portfolio, cause }) => {
        trader['portfolio'] = portfolio;
        await trader.onStrategyCreateOrder([advice]);
        expect(logger.warning).toHaveBeenCalledWith(
          'trader',
          `[${advice.id}] All-in BUY MARKET order sized from 0 USDT: 0 BTC sent, which the market refuses (${cause})`,
        );
      });

      it('places it for 0, for the exchange to refuse', async () => {
        trader['portfolio'] = new Map();
        await trader.onStrategyCreateOrder([advice]);
        expect(getPlacedAmount(advice)).toBe(0);
      });
    });

    // The same for an all-in SELL: placed for 0 and refused for it, with a reason that names the amount, not its cause: none of the
    // asset free, the SELLs placed since the last synchronization taking what was, or no balance read from the exchange yet
    describe('when an all-in SELL is sized from no asset at all', () => {
      const allInSell = buildAdvice({ id: '00000000-0000-4000-8000-000000000050', side: 'SELL', type: 'MARKET' });
      const sellOf3 = buildAdvice({ id: '00000000-0000-4000-8000-000000000051', side: 'SELL', type: 'MARKET', amount: 3 });
      const usdt: BalanceDetail = { free: 1000, used: 0, total: 1000 };

      it.each`
        description                                   | portfolio                                                             | before       | cause
        ${'0 BTC free'}                               | ${new Map([['BTC', { free: 0, used: 0, total: 0 }], ['USDT', usdt]])} | ${[]}        | ${'0 BTC free at the last synchronization'}
        ${'no BTC on the account'}                    | ${new Map([['USDT', usdt]])}                                          | ${[]}        | ${'0 BTC free at the last synchronization'}
        ${'a SELL placed since takes the 3 BTC free'} | ${new Map([['BTC', { free: 3, used: 0, total: 3 }], ['USDT', usdt]])} | ${[sellOf3]} | ${'3 BTC free at the last synchronization, less 3 BTC for the SELLs placed since'}
        ${'no balance read yet'}                      | ${new Map()}                                                          | ${[]}        | ${'no balance read from the exchange yet'}
      `('warns of it with its cause when $description', async ({ portfolio, before, cause }) => {
        trader['portfolio'] = portfolio;
        await trader.onStrategyCreateOrder([...before, allInSell]);
        expect(logger.warning).toHaveBeenCalledWith(
          'trader',
          `[${allInSell.id}] All-in SELL MARKET order sized from 0 BTC: 0 BTC sent, which the market refuses (${cause})`,
        );
      });

      it('places it for 0, for the exchange to refuse', async () => {
        trader['portfolio'] = new Map();
        await trader.onStrategyCreateOrder([allInSell]);
        expect(getPlacedAmount(allInSell)).toBe(0);
      });

      // Placed as asked whatever the balance: the exchange refuses what cannot be sold, with a reason that says so
      it('does not warn of a SELL with an amount while no BTC is free', async () => {
        trader['portfolio'] = new Map([
          ['BTC', { free: 0, used: 0, total: 0 }],
          ['USDT', usdt],
        ]);
        await trader.onStrategyCreateOrder([buildAdvice({ side: 'SELL', type: 'MARKET', amount: 0.5 })]);
        expect(logger.warning).not.toHaveBeenCalled();
      });
    });

    it('creates limit order with requested price', async () => {
      const advice = buildAdvice({ type: 'LIMIT', side: 'BUY', price: 95 });

      await trader.onStrategyCreateOrder([advice]);

      const initiated = getInitiatedOrder();
      expect(initiated?.price).toBe(95);

      const metadata = getOrderMetadata(advice.id);
      expect(metadata?.price).toBe(95);
    });

    // The strategy already holds the id of the order (see StrategyManager.createOrder) and waits for a terminal event of it
    describe.each`
      description                          | price        | marketPrice  | reason
      ${'no price is known for the pair'}  | ${undefined} | ${undefined} | ${'no price known for BTC/USDT'}
      ${'the price requested is 0'}        | ${0}         | ${100}       | ${'invalid requested price 0'}
      ${'the price requested is negative'} | ${-5}        | ${100}       | ${'invalid requested price -5'}
      ${'the price requested is NaN'}      | ${NaN}       | ${100}       | ${'invalid requested price NaN'}
    `('when $description', ({ price, marketPrice, reason }) => {
      const advice = buildAdvice({ price });

      beforeEach(async () => {
        trader['prices'].clear();
        if (marketPrice) trader['prices'].set('BTC/USDT', marketPrice);
        await trader.onStrategyCreateOrder([advice]);
      });

      it('logs a warning with the reason', () => {
        expect(logger.warning).toHaveBeenCalledWith('trader', `[${advice.id}] Impossible to create the BUY STICKY order: ${reason}`);
      });

      // Never placed, it filled nothing, and nothing of it is live
      it('emits a deferred ORDER_ERRORED_EVENT with the reason, nothing filled nor live, the portfolio and the price known', () => {
        expect(trader['addDeferredEmit']).toHaveBeenCalledWith(ORDER_ERRORED_EVENT, {
          order: { ...advice, amount: 0, reason, orderErrorDate: 1_700_000_000_000, filled: 0, mayBeLive: false },
          exchange: { price: marketPrice ?? 0, portfolio: trader['portfolio'] },
        });
      });

      it('emits no ORDER_INITIATED_EVENT', () => {
        expect(getInitiatedEvent()).toBeUndefined();
      });

      it('creates no order', () => {
        expect(getOrdersMap().size).toBe(0);
      });

      // Nothing was placed, so nothing changed on the exchange
      it('does not synchronize', () => {
        expect(fakeExchange.fetchBalance).not.toHaveBeenCalled();
      });
    });

    it('relays the amount the strategy asked for in the ORDER_ERRORED_EVENT of an order without price', async () => {
      trader['prices'].clear();

      await trader.onStrategyCreateOrder([buildAdvice({ amount: 1, type: 'MARKET', side: 'SELL' })]);

      expect(trader['addDeferredEmit']).toHaveBeenCalledWith(
        ORDER_ERRORED_EVENT,
        expect.objectContaining({ order: expect.objectContaining({ amount: 1 }) }),
      );
    });

    it('handles ORDER_ERRORED_EVENT from order instance', async () => {
      const advice = buildAdvice();
      const synchronizeSpy = vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
      (logger.error as Mock).mockClear();

      await trader.onStrategyCreateOrder([advice]);
      const order = getOrderInstance(advice.id)!;

      order.emit(ORDER_ERRORED_EVENT, { reason: 'boom', mayBeLive: false });
      await tick(); // Wait for async callbacks

      expect(logger.error).toHaveBeenCalledWith('trader', expect.stringContaining('boom'));
      expect(getOrdersMap().size).toBe(0);
      expect(synchronizeSpy).toHaveBeenCalled();

      expect(trader['addDeferredEmit']).toHaveBeenCalledWith(
        ORDER_ERRORED_EVENT,
        expect.objectContaining({
          order: expect.objectContaining({ id: advice.id, reason: 'boom' }),
          exchange: { price: 100, portfolio: trader['portfolio'] },
        }),
      );
    });

    it('handles ORDER_INVALID_EVENT from order instance', async () => {
      const advice = buildAdvice();
      const synchronizeSpy = vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);

      await trader.onStrategyCreateOrder([advice]);
      const order = getOrderInstance(advice.id)!;

      order.emit(ORDER_INVALID_EVENT, { reason: 'limit too low', status: 'INVALID', filled: 0 });
      await tick();

      expect(logger.info).toHaveBeenCalledWith('trader', expect.stringContaining('limit too low'));
      expect(getOrdersMap().size).toBe(0);
      expect(synchronizeSpy).toHaveBeenCalled();

      expect(trader['addDeferredEmit']).toHaveBeenCalledWith(
        ORDER_ERRORED_EVENT,
        expect.objectContaining({
          order: expect.objectContaining({ id: advice.id, reason: 'limit too low' }),
        }),
      );
    });

    it('delegates ORDER_COMPLETED_EVENT to completion handler', async () => {
      const advice = buildAdvice();
      const synchronizeSpy = vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
      const completionSpy = vi.spyOn(trader as any, 'checkOrderSummary');

      await trader.onStrategyCreateOrder([advice]);
      const order = getOrderInstance(advice.id)!;

      order.emit(ORDER_COMPLETED_EVENT);
      await tick(); // Extra tick for async summary creation

      expect(order.createSummary).toHaveBeenCalled();
      expect(synchronizeSpy).toHaveBeenCalled();
      expect(completionSpy).toHaveBeenCalledWith(expect.objectContaining({ id: advice.id }));
      expect(getOrdersMap().size).toBe(0);
    });

    it('emits ORDER_COMPLETED_EVENT with the portfolio fetched after the fill', async () => {
      const portfolioAfterFill = new Map<string, BalanceDetail>([
        ['BTC', { free: 12.5, used: 0, total: 12.5 }],
        ['USDT', { free: 50, used: 0, total: 50 }],
      ]);
      fakeExchange.fetchBalance.mockResolvedValue(portfolioAfterFill);
      const advice = buildAdvice();

      await trader.onStrategyCreateOrder([advice]);
      getOrderInstance(advice.id)!.emit(ORDER_COMPLETED_EVENT);
      await tick(10); // createSummary, then synchronize (fetchBalance, fetchTickers)

      expect(getCompletedEvent()?.exchange.portfolio).toEqual(portfolioAfterFill);
    });

    // Expired, or canceled from the interface of the exchange: the strategy did not ask for it, but waits for the end of the order
    describe('when the exchange cancels an order', () => {
      const advice = buildAdvice();

      beforeEach(async () => {
        vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
        await trader.onStrategyCreateOrder([advice]);
        const order = getOrderInstance(advice.id)!;
        await order.emitAndSettle(ORDER_CANCELED_EVENT, { status: 'canceled', timestamp: 123_456, filled: 2, remaining: 7.5 });
      });

      it('emits a deferred ORDER_CANCELED_EVENT with what the order filled', () => {
        expect(trader['addDeferredEmit']).toHaveBeenCalledWith(ORDER_CANCELED_EVENT, {
          order: expect.objectContaining({ id: advice.id, orderCancelationDate: 123_456, filled: 2, remaining: 7.5 }),
          exchange: { price: 100, portfolio: trader['portfolio'] },
        });
      });

      it('synchronizes before emitting it', () => {
        expect(trader['synchronize']).toHaveBeenCalledOnce();
      });

      it('forgets the order', () => {
        expect(getOrdersMap().has(advice.id)).toBe(false);
      });

      it('warns when the strategy cancels the order afterwards', async () => {
        await trader.onStrategyCancelOrder([advice.id]);
        expect(logger.warning).toHaveBeenCalledWith('trader', `[${advice.id}] Impossible to cancel order: Unknown Order`);
      });

      it('logs the cancelation with what the order filled', () => {
        expect(logger.info).toHaveBeenCalledWith('trader', `[${advice.id}] BUY STICKY order canceled (filled: 2, remaining: 7.5)`);
      });
    });

    // An order leaves its fill out when no answer of the exchange reported one (see Order.getCancelationFill): unknown, not 0 filled
    describe('when the exchange cancels an order whose fill no answer reported', () => {
      const advice = buildAdvice();

      beforeEach(async () => {
        vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
        await trader.onStrategyCreateOrder([advice]);
        await getOrderInstance(advice.id)!.emitAndSettle(ORDER_CANCELED_EVENT, { status: 'canceled', timestamp: 123_456 });
      });

      it('emits a deferred ORDER_CANCELED_EVENT without a fill', () => {
        expect(getCanceledEvent()?.order).toEqual(expect.objectContaining({ filled: undefined, remaining: undefined }));
      });

      it('logs the cancelation as reporting no fill', () => {
        expect(logger.info).toHaveBeenCalledWith('trader', `[${advice.id}] BUY STICKY order canceled (no fill reported)`);
      });
    });

    it('logs order updates (partially filled)', async () => {
      const advice = buildAdvice();
      await trader.onStrategyCreateOrder([advice]);
      const order = getOrderInstance(advice.id)!;

      order.emit(ORDER_PARTIALLY_FILLED_EVENT, 5.0);

      expect(logger.info).toHaveBeenCalledWith('trader', expect.stringContaining('total filled: 5'));
    });

    it('logs order updates (status changed)', async () => {
      const advice = buildAdvice();
      await trader.onStrategyCreateOrder([advice]);
      const order = getOrderInstance(advice.id)!;

      order.emit(ORDER_STATUS_CHANGED_EVENT, { status: 'OPEN', reason: 'Placed' });

      expect(logger.info).toHaveBeenCalledWith('trader', expect.stringContaining('Status changed: OPEN'));
    });

    it.each`
      kind                   | rejection
      ${'an Error'}          | ${new Error('exchange exploded')}
      ${'a non-Error value'} | ${'exchange exploded'}
    `('logs a launch rejecting with $kind instead of leaving the rejection unhandled', async ({ rejection }) => {
      orderActions.launch.mockRejectedValueOnce(rejection);

      await trader.onStrategyCreateOrder([buildAdvice()]);
      await tick();

      expect(logger.error).toHaveBeenCalledWith(
        'trader',
        expect.stringContaining('Impossible to launch the BUY STICKY order: exchange exploded'),
      );
    });
  });

  describe('onStrategyCancelOrder', () => {
    it('warns when order is unknown', async () => {
      await trader.onStrategyCancelOrder(['missing-id' as any]);
      expect(logger.warning).toHaveBeenCalledWith('trader', '[missing-id] Impossible to cancel order: Unknown Order');
    });

    it('cancels an order once when its id comes twice in the same batch', async () => {
      const advice = buildAdvice();
      trader['prices'].set('BTC/USDT', 100);
      await trader.onStrategyCreateOrder([advice]);

      await trader.onStrategyCancelOrder([advice.id, advice.id]);

      expect(orderActions.cancel).toHaveBeenCalledOnce();
    });

    it('cancels regular order and handles cancellation success', async () => {
      const advice = buildAdvice();
      const synchronizeSpy = vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
      trader['prices'].set('BTC/USDT', 100);

      await trader.onStrategyCreateOrder([advice]);
      const order = getOrderInstance(advice.id)!;

      await trader.onStrategyCancelOrder([advice.id]);

      expect(order.removeAllListeners).toHaveBeenCalled();
      expect(order.cancel).toHaveBeenCalled();

      // Simulate successful cancel
      order.emit(ORDER_CANCELED_EVENT, { timestamp: 123456, filled: 2, remaining: 7.5 });
      await tick();

      expect(getOrdersMap().size).toBe(0);
      expect(synchronizeSpy).toHaveBeenCalled();

      expect(trader['addDeferredEmit']).toHaveBeenCalledWith(
        ORDER_CANCELED_EVENT,
        expect.objectContaining({
          order: expect.objectContaining({
            id: advice.id,
            filled: 2,
            remaining: 7.5,
          }),
          exchange: { price: 100, portfolio: trader['portfolio'] },
        }),
      );
    });

    it('handles cancellation error', async () => {
      const advice = buildAdvice();
      const synchronizeSpy = vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
      trader['prices'].set('BTC/USDT', 100);

      await trader.onStrategyCreateOrder([advice]);
      const order = getOrderInstance(advice.id)!;

      await trader.onStrategyCancelOrder([advice.id]);

      order.emit(ORDER_ERRORED_EVENT, { reason: 'exchange timeout', mayBeLive: false });
      await tick();

      expect(getOrdersMap().size).toBe(0);
      expect(synchronizeSpy).toHaveBeenCalled();
      expect(trader['addDeferredEmit']).toHaveBeenCalledWith(
        ORDER_ERRORED_EVENT,
        expect.objectContaining({
          order: expect.objectContaining({ id: advice.id, reason: 'exchange timeout', orderErrorDate: expect.any(Number) }),
        }),
      );
    });

    it('handles completion during cancellation', async () => {
      const advice = buildAdvice();
      const completionSpy = vi.spyOn(trader as any, 'checkOrderSummary');
      trader['prices'].set('BTC/USDT', 100);

      await trader.onStrategyCreateOrder([advice]);
      const order = getOrderInstance(advice.id)!;

      await trader.onStrategyCancelOrder([advice.id]);

      // Simulate completed instead of canceled
      await order.emitAndSettle(ORDER_COMPLETED_EVENT);

      expect(completionSpy).toHaveBeenCalled();
      expect(getOrdersMap().size).toBe(0);
    });

    it('emits ORDER_COMPLETED_EVENT with the portfolio fetched after a fill that beat the cancel', async () => {
      const portfolioAfterFill = new Map<string, BalanceDetail>([
        ['BTC', { free: 9.5, used: 0, total: 9.5 }],
        ['USDT', { free: 50, used: 0, total: 50 }],
      ]);
      fakeExchange.fetchBalance.mockResolvedValue(portfolioAfterFill);
      trader['prices'].set('BTC/USDT', 100);
      const advice = buildAdvice();

      await trader.onStrategyCreateOrder([advice]);
      const order = getOrderInstance(advice.id)!;
      await trader.onStrategyCancelOrder([advice.id]);
      order.emit(ORDER_COMPLETED_EVENT);
      await tick(10); // createSummary, then synchronize (fetchBalance, fetchTickers)

      expect(getCompletedEvent()?.exchange.portfolio).toEqual(portfolioAfterFill);
    });

    // A cancelation asked while the order is created is sent once it has an id, and the exchange may refuse the creation first
    it('relays the refusal of the creation of an order being canceled as an ORDER_ERRORED_EVENT', async () => {
      vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
      trader['prices'].set('BTC/USDT', 100);
      const order = await prepareOrder('cancelation');

      await order.emitAndSettle(ORDER_INVALID_EVENT, { reason: 'too small', status: 'rejected', filled: false });

      expect(trader['addDeferredEmit']).toHaveBeenCalledWith(ORDER_ERRORED_EVENT, {
        order: expect.objectContaining({ id: buildAdvice().id, reason: 'too small', orderErrorDate: 1_700_000_000_000 }),
        exchange: { price: 100, portfolio: trader['portfolio'] },
      });
    });

    it('logs a cancel that rejects instead of leaving the rejection unhandled', async () => {
      const advice = buildAdvice();
      trader['prices'].set('BTC/USDT', 100);
      await trader.onStrategyCreateOrder([advice]);
      orderActions.cancel.mockRejectedValueOnce(new Error('cancel exploded'));

      await trader.onStrategyCancelOrder([advice.id]);
      await tick();

      expect(logger.error).toHaveBeenCalledWith(
        'trader',
        expect.stringContaining('Impossible to cancel the BUY STICKY order: cancel exploded'),
      );
    });
  });

  describe('order listener failures', () => {
    beforeEach(() => {
      trader['prices'].set('BTC/USDT', 100);
    });

    // Every terminal event is listened to in both flows. The synchronization is best effort: the strategy waits for the event.
    describe.each`
      flow             | event                    | payload                                                        | relayed
      ${'creation'}    | ${ORDER_INVALID_EVENT}   | ${{ reason: 'too small', status: 'rejected', filled: false }}  | ${ORDER_ERRORED_EVENT}
      ${'creation'}    | ${ORDER_ERRORED_EVENT}   | ${{ reason: 'exchange timeout', mayBeLive: false }}            | ${ORDER_ERRORED_EVENT}
      ${'creation'}    | ${ORDER_COMPLETED_EVENT} | ${undefined}                                                   | ${ORDER_COMPLETED_EVENT}
      ${'creation'}    | ${ORDER_CANCELED_EVENT}  | ${{ timestamp: 1_700_000_100_000, filled: 0, remaining: 9.5 }} | ${ORDER_CANCELED_EVENT}
      ${'cancelation'} | ${ORDER_INVALID_EVENT}   | ${{ reason: 'too small', status: 'rejected', filled: false }}  | ${ORDER_ERRORED_EVENT}
      ${'cancelation'} | ${ORDER_ERRORED_EVENT}   | ${{ reason: 'exchange timeout', mayBeLive: false }}            | ${ORDER_ERRORED_EVENT}
      ${'cancelation'} | ${ORDER_COMPLETED_EVENT} | ${undefined}                                                   | ${ORDER_COMPLETED_EVENT}
      ${'cancelation'} | ${ORDER_CANCELED_EVENT}  | ${{ timestamp: 1_700_000_100_000, filled: 0, remaining: 9.5 }} | ${ORDER_CANCELED_EVENT}
    `('when the synchronization fails in the $event listener of the $flow flow', ({ flow, event, payload, relayed }) => {
      const advice = buildAdvice();
      let settled: PromiseSettledResult<unknown>[];

      beforeEach(async () => {
        vi.spyOn(trader as any, 'synchronize').mockRejectedValue(new Error('network down'));
        const order = await prepareOrder(flow, advice);
        settled = await order.emitAndSettle(event, payload);
      });

      it('settles the listener instead of rejecting', () => {
        expect(settled).toEqual([{ status: 'fulfilled', value: undefined }]);
      });

      it('logs the failure', () => {
        expect(logger.error).toHaveBeenCalledWith('trader', `[${advice.id}] Impossible to synchronize: network down`);
      });

      it(`still emits the deferred ${relayed}, with the portfolio known`, () => {
        expect(trader['addDeferredEmit']).toHaveBeenCalledWith(relayed, {
          order: expect.objectContaining({ id: advice.id }),
          exchange: { price: 100, portfolio: trader['portfolio'] },
        });
      });
    });

    // What is left to fail once the synchronization is best effort: queuing the event (structuredClone)
    describe.each`
      event                    | payload                                                        | report
      ${ORDER_INVALID_EVENT}   | ${{ reason: 'too small', status: 'rejected', filled: false }}  | ${'rejection'}
      ${ORDER_ERRORED_EVENT}   | ${{ reason: 'exchange timeout', mayBeLive: false }}            | ${'error'}
      ${ORDER_COMPLETED_EVENT} | ${undefined}                                                   | ${'completion'}
      ${ORDER_CANCELED_EVENT}  | ${{ timestamp: 1_700_000_100_000, filled: 0, remaining: 9.5 }} | ${'cancelation'}
    `('when the $event of an order cannot be relayed', ({ event, payload, report }) => {
      let settled: PromiseSettledResult<unknown>[];

      beforeEach(async () => {
        vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
        const order = await prepareOrder('creation');
        (trader['addDeferredEmit'] as unknown as Mock).mockImplementation(() => {
          throw new Error('payload not cloneable');
        });
        settled = await order.emitAndSettle(event, payload);
      });

      it('settles the listener instead of rejecting', () => {
        expect(settled).toEqual([{ status: 'fulfilled', value: undefined }]);
      });

      it('logs the failure', () => {
        expect(logger.error).toHaveBeenCalledWith(
          'trader',
          expect.stringContaining(`Impossible to report the ${report} of the BUY STICKY order: payload not cloneable`),
        );
      });
    });

    // A fill is a fact: the strategy hears of it as one, its summary estimated from what the Trader and the order know. Relayed as an
    // error, it counted towards the circuit breaker, dropped the trailing stop of the position, and let the strategy order again.
    describe.each`
      flow
      ${'creation'}
      ${'cancelation'}
    `('when the summary of an order completed in the $flow flow cannot be created', ({ flow }) => {
      const advice = buildAdvice({ type: 'MARKET', amount: 1 });
      let settled: PromiseSettledResult<unknown>[];

      beforeEach(async () => {
        vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
        const order = await prepareOrder(flow, advice);
        order.createSummary.mockRejectedValue(new Error('fetchMyTrades failed'));
        order.getFilledAmount.mockReturnValue(0.98);
        trader['prices'].set('BTC/USDT', 105);
        settled = await order.emitAndSettle(ORDER_COMPLETED_EVENT);
      });

      it('settles the listener instead of rejecting', () => {
        expect(settled).toEqual([{ status: 'fulfilled', value: undefined }]);
      });

      it('logs an error with the reason, saying the summary is estimated', () => {
        expect(logger.error).toHaveBeenCalledWith(
          'trader',
          expect.stringContaining(
            `[${advice.id}] BUY MARKET order filled, but its summary could not be created: fetchMyTrades failed. Its summary is estimated:`,
          ),
        );
      });

      it('emits a deferred ORDER_COMPLETED_EVENT with the estimated summary, its fee unknown', () => {
        expect(trader['addDeferredEmit']).toHaveBeenCalledWith(ORDER_COMPLETED_EVENT, {
          order: {
            id: advice.id,
            symbol: 'BTC/USDT',
            side: 'BUY',
            type: 'MARKET',
            orderCreationDate: advice.orderCreationDate,
            orderExecutionDate: 1_700_000_000_000,
            amount: 0.98,
            price: 105,
            feePercent: undefined,
            fee: 0,
            effectivePrice: 105,
          },
          exchange: { price: 105, portfolio: trader['portfolio'] },
        });
      });

      it('emits no ORDER_ERRORED_EVENT', () => {
        expect(getErroredEvent()).toBeUndefined();
      });

      it('forgets the order', () => {
        expect(getOrdersMap().has(advice.id)).toBe(false);
      });
    });

    it('relays the summary of a completed order as the exchange gave it when its figures are usable', async () => {
      vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
      const order = await prepareOrder('creation', buildAdvice({ type: 'MARKET', amount: 1 }));
      trader['prices'].set('BTC/USDT', 105);
      await order.emitAndSettle(ORDER_COMPLETED_EVENT);
      expect(getCompletedEvent()?.order).toEqual(
        expect.objectContaining({ amount: 1, price: 100, feePercent: 0.25, orderExecutionDate: 1_700_000_111_000 }),
      );
    });

    // createOrderSummary resolves with NaN figures when none of the trades of the account matches the order. Relayed as they were,
    // they armed the trailing stop of the position with an amount of NaN and the analyzers skipped or misdated the fill: the summary
    // is estimated instead, as when it cannot be created.
    describe.each`
      shape                            | summary                                                                                 | figures
      ${'empty (EMPTY_ORDER_SUMMARY)'} | ${EMPTY_ORDER_SUMMARY}                                                                  | ${'amount NaN, price NaN, executed at Unknown Date'}
      ${'without amount'}              | ${{ amount: NaN, price: 100, feePercent: 0.25, orderExecutionDate: 1_700_000_111_000 }} | ${'amount NaN, price 100, executed at 2023-11-14T22:15:11.000Z'}
      ${'with a price of 0'}           | ${{ amount: 1, price: 0, feePercent: 0.25, orderExecutionDate: 1_700_000_111_000 }}     | ${'amount 1, price 0, executed at 2023-11-14T22:15:11.000Z'}
      ${'without execution date'}      | ${{ amount: 1, price: 100, feePercent: 0.25, orderExecutionDate: NaN }}                 | ${'amount 1, price 100, executed at Unknown Date'}
    `('when the summary of a completed order is $shape', ({ summary, figures }) => {
      const advice = buildAdvice({ type: 'MARKET', amount: 1 });

      beforeEach(async () => {
        vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
        const order = await prepareOrder('creation', advice);
        order.createSummary.mockResolvedValue({ ...summary, side: 'BUY' });
        order.getFilledAmount.mockReturnValue(0.98);
        trader['prices'].set('BTC/USDT', 105);
        await order.emitAndSettle(ORDER_COMPLETED_EVENT);
      });

      it('logs an error with its figures, saying the summary is estimated', () => {
        expect(logger.error).toHaveBeenCalledWith(
          'trader',
          expect.stringContaining(
            `[${advice.id}] BUY MARKET order filled, but its trades were not found, or not usable (${figures}). Its summary is estimated:`,
          ),
        );
      });

      it('emits a deferred ORDER_COMPLETED_EVENT with finite estimated figures, its fee unknown', () => {
        expect(trader['addDeferredEmit']).toHaveBeenCalledWith(ORDER_COMPLETED_EVENT, {
          order: {
            id: advice.id,
            symbol: 'BTC/USDT',
            side: 'BUY',
            type: 'MARKET',
            orderCreationDate: advice.orderCreationDate,
            orderExecutionDate: 1_700_000_000_000,
            amount: 0.98,
            price: 105,
            feePercent: undefined,
            fee: 0,
            effectivePrice: 105,
          },
          exchange: { price: 105, portfolio: trader['portfolio'] },
        });
      });

      it('emits no ORDER_ERRORED_EVENT', () => {
        expect(getErroredEvent()).toBeUndefined();
      });
    });

    // Each figure of the estimate comes from the best source known (see Trader.estimateOrderSummary)
    describe('the summary estimated when the exchange cannot create it', () => {
      // Created with a requested price of 95, at a market price of 100; the last market price is 105, unless unknown by then. The
      // order reports the price of its fills when given one.
      const completeWithoutSummary = async (type: AdviceOrder['type'], filled: number, marketPrice?: number, fillPrice?: number) => {
        vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
        const order = await prepareOrder('creation', buildAdvice({ type, amount: 1, price: 95 }));
        order.createSummary.mockRejectedValue(new Error('fetchMyTrades failed'));
        order.getFilledAmount.mockReturnValue(filled);
        order.getAverageFillPrice.mockReturnValue(fillPrice);
        trader['prices'].clear();
        if (marketPrice) trader['prices'].set('BTC/USDT', marketPrice);
        await order.emitAndSettle(ORDER_COMPLETED_EVENT);
      };

      describe.each`
        source                  | filled  | amount  | note
        ${'the fill reported'}  | ${0.98} | ${0.98} | ${'amount 0.98 (the fill reported)'}
        ${'the amount ordered'} | ${0}    | ${1}    | ${'amount 1 (the amount ordered: no fill reported, and a filled order executed it in full, up to lot rounding)'}
      `('when the amount comes from $source', ({ filled, amount, note }) => {
        beforeEach(async () => {
          await completeWithoutSummary('MARKET', filled, 105);
        });

        it(`relays an amount of ${amount}`, () => {
          expect(getCompletedEvent()?.order.amount).toBe(amount);
        });

        it('says so in the log', () => {
          expect(logger.error).toHaveBeenCalledWith('trader', expect.stringContaining(note));
        });
      });

      // A STICKY order that rested at 100.01 and filled there was reported at the market, 105 by then: its fills say where it executed.
      // Not those of a MARKET order, whose price reported can be the bound of its slippage.
      describe.each`
        type        | marketPrice  | fillPrice    | source                                             | price     | note
        ${'LIMIT'}  | ${105}       | ${undefined} | ${'its limit price'}                               | ${95}     | ${'price 95 (its limit price)'}
        ${'MARKET'} | ${105}       | ${undefined} | ${'the last market price'}                         | ${105}    | ${'price 105 (the last market price)'}
        ${'STICKY'} | ${105}       | ${undefined} | ${'the last market price'}                         | ${105}    | ${'price 105 (the last market price)'}
        ${'MARKET'} | ${undefined} | ${undefined} | ${'the price it was created with'}                 | ${95}     | ${'price 95 (the price it was created with: no market price known)'}
        ${'STICKY'} | ${105}       | ${100.01}    | ${'the prices of its fills'}                       | ${100.01} | ${'price 100.01 (the prices of its fills, as the exchange reported them)'}
        ${'LIMIT'}  | ${105}       | ${94.99}     | ${'the prices of its fills'}                       | ${94.99}  | ${'price 94.99 (the prices of its fills, as the exchange reported them)'}
        ${'MARKET'} | ${105}       | ${110.25}    | ${'the last market price, whatever its fills say'} | ${105}    | ${'price 105 (the last market price)'}
      `('when the price of a $type order comes from $source', ({ type, marketPrice, fillPrice, price, note }) => {
        beforeEach(async () => {
          await completeWithoutSummary(type, 0.98, marketPrice, fillPrice);
        });

        it(`relays a price of ${price}`, () => {
          expect(getCompletedEvent()?.order.price).toBe(price);
        });

        it('says so in the log', () => {
          expect(logger.error).toHaveBeenCalledWith('trader', expect.stringContaining(note));
        });
      });

      // Placed at the market price of its creation, 100: its limit price, although its events relay no requested price
      it('relays the market price a LIMIT order created without price was placed at as its price', async () => {
        vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
        const order = await prepareOrder('creation', buildAdvice({ type: 'LIMIT', amount: 1 }));
        order.createSummary.mockRejectedValue(new Error('fetchMyTrades failed'));
        trader['prices'].set('BTC/USDT', 105);
        await order.emitAndSettle(ORDER_COMPLETED_EVENT);
        expect(getCompletedEvent()?.order.price).toBe(100);
      });

      it('logs the fee as unknown and the execution date as the end of the last minute processed', async () => {
        await completeWithoutSummary('MARKET', 0.98, 105);
        expect(logger.error).toHaveBeenCalledWith(
          'trader',
          expect.stringContaining('fee unknown, executed at 2023-11-14T22:13:20.000Z (the end of the last minute processed)'),
        );
      });

      // The price an order was created with comes with its report: read from the orders the Trader lists, an order no longer listed
      // was relayed with a price of NaN
      it.each`
        end                       | flow             | event                    | payload                                                                     | filled
        ${'filled'}               | ${'creation'}    | ${ORDER_COMPLETED_EVENT} | ${undefined}                                                                | ${0}
        ${'filled'}               | ${'cancelation'} | ${ORDER_COMPLETED_EVENT} | ${undefined}                                                                | ${0}
        ${'refused after a fill'} | ${'creation'}    | ${ORDER_INVALID_EVENT}   | ${{ reason: 'Filter failure: NOTIONAL', status: 'rejected', filled: true }} | ${0.5}
      `(
        'relays a price of 95, its limit price, for a LIMIT order $end in the $flow flow whatever the orders the Trader lists',
        async ({ flow, event, payload, filled }) => {
          vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
          const order = await prepareOrder(flow, buildAdvice({ type: 'LIMIT', amount: 1, price: 95 }));
          order.createSummary.mockRejectedValue(new Error('fetchMyTrades failed'));
          order.getFilledAmount.mockReturnValue(filled);
          getOrdersMap().clear();
          await order.emitAndSettle(event, payload);
          expect(getCompletedEvent()?.order.price).toBe(95);
        },
      );
    });

    describe.each`
      flow
      ${'creation'}
      ${'cancelation'}
    `('when neither the summary nor the synchronization succeed for an order completed in the $flow flow', ({ flow }) => {
      beforeEach(async () => {
        vi.spyOn(trader as any, 'synchronize').mockRejectedValue(new Error('network down'));
        const order = await prepareOrder(flow);
        order.createSummary.mockRejectedValue(new Error('fetchMyTrades failed'));
        await order.emitAndSettle(ORDER_COMPLETED_EVENT);
      });

      it('still emits a deferred ORDER_COMPLETED_EVENT, with the portfolio known', () => {
        expect(trader['addDeferredEmit']).toHaveBeenCalledWith(ORDER_COMPLETED_EVENT, {
          order: expect.objectContaining({ id: buildAdvice().id }),
          exchange: { price: 100, portfolio: trader['portfolio'] },
        });
      });

      it('logs the synchronization failure', () => {
        expect(logger.error).toHaveBeenCalledWith('trader', expect.stringContaining('Impossible to synchronize: network down'));
      });
    });

    it('reports a price of 0 in the ORDER_ERRORED_EVENT of an order when the price of its pair is unknown', async () => {
      vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
      const order = await prepareOrder('creation');
      trader['prices'].clear();

      await order.emitAndSettle(ORDER_ERRORED_EVENT, { reason: 'exchange timeout', mayBeLive: false });

      expect(trader['addDeferredEmit']).toHaveBeenCalledWith(
        ORDER_ERRORED_EVENT,
        expect.objectContaining({ exchange: { price: 0, portfolio: trader['portfolio'] } }),
      );
    });

    it('reports a price of 0 in the ORDER_CANCELED_EVENT of an order when the price of its pair is unknown', async () => {
      vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
      const order = await prepareOrder('creation');
      trader['prices'].clear();

      await order.emitAndSettle(ORDER_CANCELED_EVENT, { timestamp: 1_700_000_100_000, filled: 0, remaining: 9.5 });

      expect(trader['addDeferredEmit']).toHaveBeenCalledWith(
        ORDER_CANCELED_EVENT,
        expect.objectContaining({ exchange: { price: 0, portfolio: trader['portfolio'] } }),
      );
    });
  });

  // A STICKY order whose relaunch after a move is refused is over with what its earlier transactions filled (see
  // StickyOrder.handleCreateOrderError), its rejection saying so (`filled: true`). Relayed as an error, the strategy never heard of
  // that fill, the trailing stop of the position was not armed, and the analyzers missed it: it is reported as a completion.
  describe('the refusal of an order', () => {
    const advice = buildAdvice({ type: 'STICKY', amount: 5 });
    const rejection = { reason: 'Filter failure: NOTIONAL', status: 'rejected' };
    // What the exchange summarizes from the trades of the order: the part filled, 2 of the 5 ordered
    const summary = { amount: 2, price: 101.25, feePercent: 0.1, side: 'BUY', orderExecutionDate: 1_700_000_002_000 };

    // An order of the flow, refused after it filled the amount given
    const refuse = async (flow: 'creation' | 'cancelation', filled: number) => {
      const order = await prepareOrder(flow, advice);
      order.getFilledAmount.mockReturnValue(filled);
      order.createSummary.mockResolvedValue(summary);
      await order.emitAndSettle(ORDER_INVALID_EVENT, { ...rejection, filled: filled > 0 });
      return order;
    };

    beforeEach(() => {
      trader['prices'].set('BTC/USDT', 100);
      vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
    });

    it.each`
      flow             | filled | relayed
      ${'creation'}    | ${0}   | ${ORDER_ERRORED_EVENT}
      ${'creation'}    | ${2}   | ${ORDER_COMPLETED_EVENT}
      ${'cancelation'} | ${0}   | ${ORDER_ERRORED_EVENT}
      ${'cancelation'} | ${2}   | ${ORDER_COMPLETED_EVENT}
    `('relays as $relayed the refusal of an order of the $flow flow that filled $filled', async ({ flow, filled, relayed }) => {
      await refuse(flow, filled);
      expect(getRelayedEvents()).toEqual([relayed]);
    });

    describe('when it had filled part of what it ordered', () => {
      beforeEach(async () => {
        await refuse('creation', 2);
      });

      it('relays the summary the exchange gives of the part filled', () => {
        expect(getCompletedEvent()?.order).toEqual(expect.objectContaining({ id: advice.id, ...summary }));
      });

      it('logs a warning with the reason and the part filled', () => {
        expect(logger.warning).toHaveBeenCalledWith(
          'trader',
          `[${advice.id}] BUY STICKY order: Filter failure: NOTIONAL (status: rejected), after 2 of 5 filled: that part is reported as a completion`,
        );
      });

      it('forgets the order', () => {
        expect(getOrdersMap().has(advice.id)).toBe(false);
      });
    });

    // As for any fill the exchange cannot summarize: the amount is the fill the order reported (see Trader.estimateOrderSummary)
    it('relays the part filled as the amount of the summary estimated when the exchange cannot give one', async () => {
      const order = await prepareOrder('creation', advice);
      order.getFilledAmount.mockReturnValue(2);
      order.createSummary.mockRejectedValue(new Error('fetchMyTrades failed'));
      await order.emitAndSettle(ORDER_INVALID_EVENT, { ...rejection, filled: true });
      expect(getCompletedEvent()?.order.amount).toBe(2);
    });

    it.each`
      flow
      ${'creation'}
      ${'cancelation'}
    `('relays the refusal of an order of the $flow flow that filled nothing with nothing filled', async ({ flow }) => {
      await refuse(flow, 0);
      expect(getErroredEvent()?.order.filled).toBe(0);
    });
  });

  // An error may follow fills: a STICKY order whose relaunch failed reported them in its reason only, in words, and the strategy, told
  // nothing else, dropped the trailing stop of the coins a BUY had bought (see StrategyManager.onOrderErrored)
  describe('the error of an order', () => {
    const advice = buildAdvice({ type: 'STICKY', amount: 5 });

    beforeEach(() => {
      trader['prices'].set('BTC/USDT', 100);
      vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
    });

    it.each`
      flow             | filled
      ${'creation'}    | ${0}
      ${'creation'}    | ${2}
      ${'cancelation'} | ${0}
      ${'cancelation'} | ${2}
    `('relays the error of an order of the $flow flow with what it had filled, $filled', async ({ flow, filled }) => {
      const order = await prepareOrder(flow, advice);
      order.getFilledAmount.mockReturnValue(filled);
      await order.emitAndSettle(ORDER_ERRORED_EVENT, { reason: 'ticker unavailable', mayBeLive: false });
      expect(getErroredEvent()?.order.filled).toBe(filled);
    });

    // Not a completion: the order may still be live on the exchange, its poll or its cancelation having failed for good
    it('relays it as an error after a fill', async () => {
      const order = await prepareOrder('creation', advice);
      order.getFilledAmount.mockReturnValue(2);
      await order.emitAndSettle(ORDER_ERRORED_EVENT, { reason: 'Invalid API key (2 of 5 already filled)', mayBeLive: true });
      expect(getRelayedEvents()).toEqual([ORDER_ERRORED_EVENT]);
    });

    // Whether the order may still be live is the order's to say (see Order.orderErrored): GridBot could only read it from the words of
    // a creation lost on the network, and placed again an order whose poll had failed for good while it was open
    describe('whether it may still be live on the exchange', () => {
      it.each`
        flow             | mayBeLive
        ${'creation'}    | ${true}
        ${'creation'}    | ${false}
        ${'cancelation'} | ${true}
        ${'cancelation'} | ${false}
      `('relays mayBeLive $mayBeLive, as the order of the $flow flow said it', async ({ flow, mayBeLive }) => {
        const order = await prepareOrder(flow, advice);
        await order.emitAndSettle(ORDER_ERRORED_EVENT, { reason: 'Invalid API key', mayBeLive });
        expect(getErroredEvent()?.order.mayBeLive).toBe(mayBeLive);
      });

      it.each`
        flow
        ${'creation'}
        ${'cancelation'}
      `('relays a refusal of the $flow flow as not live: the exchange placed nothing', async ({ flow }) => {
        const order = await prepareOrder(flow, advice);
        await order.emitAndSettle(ORDER_INVALID_EVENT, { reason: 'too small', status: 'rejected', filled: false });
        expect(getErroredEvent()?.order.mayBeLive).toBe(false);
      });

      it('says, in the error it logs, that an order which may be live is followed no more', async () => {
        const order = await prepareOrder('creation', advice);
        await order.emitAndSettle(ORDER_ERRORED_EVENT, { reason: 'Invalid API key', mayBeLive: true });
        expect(logger.error).toHaveBeenCalledWith(
          'trader',
          `[${advice.id}] BUY STICKY order: Invalid API key (status: ERROR), it may still be live on the exchange, where Gekko follows it no more`,
        );
      });

      it('logs the error of an order that is not live as before', async () => {
        const order = await prepareOrder('creation', advice);
        await order.emitAndSettle(ORDER_ERRORED_EVENT, { reason: 'Invalid API key', mayBeLive: false });
        expect(logger.error).toHaveBeenCalledWith('trader', `[${advice.id}] BUY STICKY order: Invalid API key (status: ERROR)`);
      });
    });
  });

  // Whatever way an order ended, the portfolio may have changed: a fill, the release of what it reserved, before an error or a refusal
  // too (the relaunch of a STICKY order is refused once its move has canceled the transaction before). Every report waits for a
  // synchronization started after the end of its order.
  describe('synchronization after the end of an order', () => {
    const portfolioBefore = new Map<string, BalanceDetail>([['USDT', { free: 50, used: 950, total: 1000 }]]);
    const portfolioAfter = new Map<string, BalanceDetail>([['USDT', { free: 1000, used: 0, total: 1000 }]]);
    const rejection = { reason: 'Filter failure: NOTIONAL', status: 'rejected' };

    beforeEach(() => {
      trader['prices'].set('BTC/USDT', 100);
    });

    describe.each`
      end                       | flow             | event                   | payload                                                                   | filled | getRelayed
      ${'cancelation'}          | ${'cancelation'} | ${ORDER_CANCELED_EVENT} | ${{ timestamp: 1_700_000_100_000, filled: 0, remaining: 9.5 }}            | ${0}   | ${getCanceledEvent}
      ${'error after a fill'}   | ${'creation'}    | ${ORDER_ERRORED_EVENT}  | ${{ reason: 'Invalid API key (2 of 5 already filled)', mayBeLive: true }} | ${2}   | ${getErroredEvent}
      ${'refusal'}              | ${'creation'}    | ${ORDER_INVALID_EVENT}  | ${{ ...rejection, filled: false }}                                        | ${0}   | ${getErroredEvent}
      ${'refusal after a fill'} | ${'creation'}    | ${ORDER_INVALID_EVENT}  | ${{ ...rejection, filled: true }}                                         | ${2}   | ${getCompletedEvent}
    `('when a synchronization started before the $end of an order is in flight', ({ flow, event, payload, filled, getRelayed }) => {
      beforeEach(async () => {
        const order = await prepareOrder(flow);
        order.getFilledAmount.mockReturnValue(filled);
        const balance = deferred<Portfolio>();
        fakeExchange.fetchBalance.mockReturnValueOnce(balance.promise).mockResolvedValueOnce(portfolioAfter);
        const inFlight = trader['synchronize']();
        const reported = order.emitAndSettle(event, payload);
        await tick(10); // The report reaches its synchronization while the one in flight still waits for the balance
        balance.resolve(portfolioBefore);
        await Promise.all([inFlight, reported]);
      });

      it('waits for it to end, then fetches the balance again', () => {
        expect(fakeExchange.fetchBalance).toHaveBeenCalledTimes(2);
      });

      it('relays the end of the order with the portfolio fetched after it', () => {
        expect(getRelayed()?.exchange.portfolio).toEqual(portfolioAfter);
      });
    });

    // The fill changed the portfolio, whether its summary is created or estimated
    it('emits the ORDER_COMPLETED_EVENT of an order whose summary is estimated with the portfolio fetched after the fill', async () => {
      const order = await prepareOrder('creation');
      order.createSummary.mockRejectedValue(new Error('fetchMyTrades failed'));
      const balance = deferred<Portfolio>();
      fakeExchange.fetchBalance.mockReturnValueOnce(balance.promise).mockResolvedValueOnce(portfolioAfter);
      const inFlight = trader['synchronize']();
      const reported = order.emitAndSettle(ORDER_COMPLETED_EVENT);
      balance.resolve(portfolioBefore);
      await Promise.all([inFlight, reported]);

      expect(getCompletedEvent()?.exchange.portfolio).toEqual(portfolioAfter);
    });

    describe('when a synchronization starts between the fill of an order and its report', () => {
      beforeEach(async () => {
        const order = await prepareOrder('creation');
        const balance = deferred<Portfolio>();
        fakeExchange.fetchBalance.mockReturnValueOnce(balance.promise);
        const reported = order.emitAndSettle(ORDER_COMPLETED_EVENT); // The report summarizes the order first
        const started = trader['synchronize']();
        await tick(10);
        balance.resolve(portfolioAfter);
        await Promise.all([started, reported]);
      });

      it('joins it', () => {
        expect(fakeExchange.fetchBalance).toHaveBeenCalledOnce();
      });

      it('emits the ORDER_COMPLETED_EVENT with the portfolio it fetched', () => {
        expect(getCompletedEvent()?.exchange.portfolio).toEqual(portfolioAfter);
      });
    });
  });

  // The price the strategy asked for, if any, in both flows. The cancelation flow relayed the price the order was created with: for
  // an order without one, the market price of its creation, which the strategy and the EventSubscriber read as a requested limit price.
  describe.each`
    flow             | event                   | payload
    ${'creation'}    | ${ORDER_CANCELED_EVENT} | ${{ timestamp: 1_700_000_100_000, filled: 0, remaining: 1 }}
    ${'creation'}    | ${ORDER_ERRORED_EVENT}  | ${{ reason: 'exchange timeout', mayBeLive: false }}
    ${'cancelation'} | ${ORDER_CANCELED_EVENT} | ${{ timestamp: 1_700_000_100_000, filled: 0, remaining: 1 }}
    ${'cancelation'} | ${ORDER_ERRORED_EVENT}  | ${{ reason: 'exchange timeout', mayBeLive: false }}
  `('the price of the $event relayed in the $flow flow', ({ flow, event, payload }) => {
    // Throws when the event was not relayed, rather than reading its price as undefined
    const getRelayedPrice = () => (event === ORDER_CANCELED_EVENT ? getCanceledEvent() : getErroredEvent()).order.price;

    beforeEach(() => {
      trader['prices'].set('BTC/USDT', 100);
      vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
    });

    it.each`
      order                            | type        | price
      ${'a MARKET order'}              | ${'MARKET'} | ${undefined}
      ${'a STICKY order'}              | ${'STICKY'} | ${undefined}
      ${'a LIMIT order without price'} | ${'LIMIT'}  | ${undefined}
      ${'a LIMIT order at 210'}        | ${'LIMIT'}  | ${210}
    `('is the price requested ($price) for $order', async ({ type, price }) => {
      const order = await prepareOrder(flow, buildAdvice({ type, amount: 1, price }));
      await order.emitAndSettle(event, payload);
      expect(getRelayedPrice()).toBe(price);
    });
  });

  // The first terminal event of an order removes all its listeners: a later one, a fill after an error or an error repeated at every
  // check, is never relayed, and the strategy hears once of each order
  describe('late events of an order already over', () => {
    const payloads: Record<string, unknown> = {
      [ORDER_INVALID_EVENT]: { reason: 'too small', status: 'rejected', filled: false },
      [ORDER_ERRORED_EVENT]: { reason: 'exchange timeout', mayBeLive: false },
      [ORDER_COMPLETED_EVENT]: undefined,
      [ORDER_CANCELED_EVENT]: { timestamp: 1_700_000_100_000, filled: 0, remaining: 9.5 },
    };

    beforeEach(() => {
      trader['prices'].set('BTC/USDT', 100);
      vi.spyOn(trader as any, 'synchronize').mockResolvedValue(undefined);
    });

    it.each`
      flow             | first                    | late                     | relayed
      ${'creation'}    | ${ORDER_ERRORED_EVENT}   | ${ORDER_COMPLETED_EVENT} | ${[ORDER_ERRORED_EVENT]}
      ${'creation'}    | ${ORDER_ERRORED_EVENT}   | ${ORDER_ERRORED_EVENT}   | ${[ORDER_ERRORED_EVENT]}
      ${'creation'}    | ${ORDER_INVALID_EVENT}   | ${ORDER_COMPLETED_EVENT} | ${[ORDER_ERRORED_EVENT]}
      ${'creation'}    | ${ORDER_COMPLETED_EVENT} | ${ORDER_ERRORED_EVENT}   | ${[ORDER_COMPLETED_EVENT]}
      ${'creation'}    | ${ORDER_COMPLETED_EVENT} | ${ORDER_INVALID_EVENT}   | ${[ORDER_COMPLETED_EVENT]}
      ${'creation'}    | ${ORDER_COMPLETED_EVENT} | ${ORDER_CANCELED_EVENT}  | ${[ORDER_COMPLETED_EVENT]}
      ${'creation'}    | ${ORDER_CANCELED_EVENT}  | ${ORDER_COMPLETED_EVENT} | ${[ORDER_CANCELED_EVENT]}
      ${'cancelation'} | ${ORDER_COMPLETED_EVENT} | ${ORDER_CANCELED_EVENT}  | ${[ORDER_COMPLETED_EVENT]}
      ${'cancelation'} | ${ORDER_ERRORED_EVENT}   | ${ORDER_COMPLETED_EVENT} | ${[ORDER_ERRORED_EVENT]}
      ${'cancelation'} | ${ORDER_CANCELED_EVENT}  | ${ORDER_ERRORED_EVENT}   | ${[ORDER_CANCELED_EVENT]}
      ${'cancelation'} | ${ORDER_INVALID_EVENT}   | ${ORDER_COMPLETED_EVENT} | ${[ORDER_ERRORED_EVENT]}
    `('relays $relayed only when an order of the $flow flow emits $late after $first', async ({ flow, first, late, relayed }) => {
      const order = await prepareOrder(flow);

      await order.emitAndSettle(first, payloads[first]);
      await order.emitAndSettle(late, payloads[late]);

      expect(getRelayedEvents()).toEqual(relayed);
    });

    it('stops logging the updates of an order once it is over', async () => {
      const order = await prepareOrder('creation');
      await order.emitAndSettle(ORDER_ERRORED_EVENT, { reason: 'exchange timeout', mayBeLive: false });
      (logger.info as Mock).mockClear();

      order.emit(ORDER_STATUS_CHANGED_EVENT, { status: 'filled' });

      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  // A report queues its event several exchange calls after the end of the order, and the events of a bucket are flushed once. In
  // backtest the reports are awaited before the flush: left to race it, the end of an order reached the strategy and the analyzers
  // one or two candles late, and never for the last bucket. In realtime a report waits for the network, which nothing waits for.
  describe('delivery of the end of an order', () => {
    const advice = buildAdvice({ type: 'MARKET', amount: 1 });
    const bucket = new Map([['BTC/USDT', defaultCandle]]) as any;
    const cancelation = { timestamp: 1_700_000_100_000, filled: 0, remaining: 1 };
    const isAbout = (id: string) => expect.objectContaining({ order: expect.objectContaining({ id }) });

    // The events of the Trader are flushed as PluginsStream flushes them
    const flush = async () => {
      while (await trader.broadcastDeferredEmit()) {
        // Until none is queued
      }
    };

    // A listener of the Trader's event, which the deferred queue, no longer mocked, delivers
    const listenTo = (event: string) => {
      delete (trader as any).addDeferredEmit;
      const listener = vi.fn();
      trader.on(event, listener);
      return listener;
    };

    // An order whose report takes several ticks, as with an exchange: its summary and the balance come late
    const prepareSlowOrder = async () => {
      const order = await prepareOrder('creation', advice);
      const summary = await order.createSummary();
      order.createSummary.mockImplementation(async () => {
        await tick(10);
        return summary;
      });
      fakeExchange.fetchBalance.mockImplementation(async () => {
        await tick(10);
        return new Map<string, BalanceDetail>([['USDT', { free: 1000, used: 0, total: 1000 }]]);
      });
      return order;
    };

    beforeEach(() => {
      trader['prices'].set('BTC/USDT', 100);
    });

    describe('in backtest', () => {
      beforeEach(() => {
        (trader as any).mode = 'backtest';
      });

      describe.each`
        event                    | payload                                                       | relayed
        ${ORDER_COMPLETED_EVENT} | ${undefined}                                                  | ${ORDER_COMPLETED_EVENT}
        ${ORDER_CANCELED_EVENT}  | ${cancelation}                                                | ${ORDER_CANCELED_EVENT}
        ${ORDER_ERRORED_EVENT}   | ${{ reason: 'exchange timeout', mayBeLive: false }}           | ${ORDER_ERRORED_EVENT}
        ${ORDER_INVALID_EVENT}   | ${{ reason: 'too small', status: 'rejected', filled: false }} | ${ORDER_ERRORED_EVENT}
      `('when an order emits $event and its report takes several ticks', ({ event, payload, relayed }) => {
        // Emitted as the simulated exchange settles the bucket, before the plugins process it
        it(`queues the ${relayed} by the time the bucket is processed`, async () => {
          const order = await prepareSlowOrder();
          order.emit(event, payload);
          await trader['processOneMinuteBucket'](bucket);
          expect(trader['addDeferredEmit']).toHaveBeenCalledWith(relayed, isAbout(advice.id));
        });

        it(`delivers the ${relayed} in a flush that starts while the report is in flight`, async () => {
          const listener = listenTo(relayed);
          const order = await prepareSlowOrder();
          order.emit(event, payload);
          await flush();
          expect(listener).toHaveBeenCalledWith([isAbout(advice.id)]);
        });

        it(`queues the ${relayed} before the run ends`, async () => {
          const order = await prepareSlowOrder();
          order.emit(event, payload);
          await trader['processFinalize']();
          expect(trader['addDeferredEmit']).toHaveBeenCalledWith(relayed, isAbout(advice.id));
        });
      });

      // The flush of the TradingAdvisor comes first, and the simulated exchange ends at once some of the orders it creates or cancels
      it.each`
        action      | event                    | payload
        ${'launch'} | ${ORDER_COMPLETED_EVENT} | ${undefined}
        ${'cancel'} | ${ORDER_CANCELED_EVENT}  | ${cancelation}
      `('delivers in the same flush the $event of an order that the answer to its $action ends', async ({ action, event, payload }) => {
        const listener = listenTo(event);
        const answer = async function (this: { emit: (event: string, payload: unknown) => void }) {
          await tick(10);
          this.emit(event, payload);
          return undefined;
        };
        (action === 'launch' ? orderActions.launch : orderActions.cancel).mockImplementationOnce(answer);
        await trader.onStrategyCreateOrder([advice]);
        if (action === 'cancel') await trader.onStrategyCancelOrder([advice.id]);
        await flush();
        expect(listener).toHaveBeenCalledWith([isAbout(advice.id)]);
      });

      // An order canceled in a later flush than the one of its creation (a LIMIT order resting in the book), with nothing else queued:
      // the answer to the cancelation starts the report, which is awaited in turn. Awaited alone, the cancelation left the queue empty
      // and the flush ended, the event one bucket late. The balance comes late, so that the portfolio is not queued in time either.
      it('delivers in a later flush, nothing else queued, the ORDER_CANCELED_EVENT of an order the answer to its cancelation ends', async () => {
        const listener = listenTo(ORDER_CANCELED_EVENT);
        await prepareSlowOrder();
        await flush(); // The flush of the bucket it was created in
        orderActions.cancel.mockImplementationOnce(async function (this: { emit: (event: string, payload: unknown) => void }) {
          await tick(10);
          this.emit(ORDER_CANCELED_EVENT, cancelation);
        });
        await trader.onStrategyCancelOrder([advice.id]);
        await flush();
        expect(listener).toHaveBeenCalledWith([isAbout(advice.id)]);
      });

      // The end of the minute, where the clock of the simulated exchange is when it settles the bucket
      it('dates the estimated summary of a fill settled with the bucket at the end of its minute', async () => {
        const order = await prepareSlowOrder();
        order.createSummary.mockImplementation(async () => {
          await tick(10);
          throw new Error('fetchMyTrades failed');
        });
        order.emit(ORDER_COMPLETED_EVENT);
        await trader['processOneMinuteBucket'](bucket);
        expect(getCompletedEvent()?.order.orderExecutionDate).toBe(1_700_000_060_000);
      });

      it('does not synchronize at the first bucket, even at a minute of the synchronization interval', async () => {
        const synchronizeSpy = vi.spyOn(trader as any, 'synchronize');
        trader['currentTimestamp'] = 0;
        await trader['processOneMinuteBucket'](new Map([['BTC/USDT', { ...defaultCandle, start: 1_700_000_400_000 }]]));
        expect(synchronizeSpy).not.toHaveBeenCalled();
      });

      // The stream calls it at least once per bucket, most often with no report in flight: awaited all the same, the wait cost a turn of
      // the microtask queue each time
      it('does not wait for the reports in a flush when none is in flight', async () => {
        const settleSpy = vi.spyOn(trader as any, 'settlePendingReports');
        await flush();
        expect(settleSpy).not.toHaveBeenCalled();
      });
    });

    // The exchange has not answered the synchronization of the report yet
    describe('in realtime', () => {
      beforeEach(async () => {
        (trader as any).mode = 'realtime';
        delete (trader as any).addDeferredEmit;
        const order = await prepareOrder('creation', advice);
        fakeExchange.fetchBalance.mockReturnValue(new Promise(noop));
        order.emit(ORDER_COMPLETED_EVENT);
      });

      it('processes the bucket without waiting for the report', async () => {
        await expect(trader['processOneMinuteBucket'](bucket)).resolves.toBeUndefined();
      });

      it('delivers the events queued without waiting for the report', async () => {
        await expect(trader.broadcastDeferredEmit()).resolves.toBe(true);
      });

      it('finalizes without waiting for the report', async () => {
        await expect(trader['processFinalize']()).resolves.toBeUndefined();
      });
    });
  });

  // The stream broadcasts only while a plugin has something to deliver: in backtest, a report in flight queues the end of its order
  // before the broadcast that waits for it delivers it (see broadcastDeferredEmit)
  describe('hasDeferredEvents', () => {
    it.each`
      mode          | reports | expected
      ${'backtest'} | ${1}    | ${true}
      ${'backtest'} | ${0}    | ${false}
      ${'realtime'} | ${1}    | ${false}
    `('is $expected in $mode with $reports report(s) in flight and nothing queued', ({ mode, reports, expected }) => {
      (trader as any).mode = mode;
      for (let index = 0; index < reports; index++) trader['trackReport'](new Promise(noop));
      expect(trader.hasDeferredEvents()).toBe(expected);
    });

    it('is true with an event queued', () => {
      delete (trader as any).addDeferredEmit;
      trader.addDeferredEmit(PORTFOLIO_CHANGE_EVENT, new Map());
      expect(trader.hasDeferredEvents()).toBe(true);
    });
  });

  describe('checkOrderSummary', () => {
    it('returns completion summary with computed pricing', () => {
      const summary: OrderSummary = {
        amount: 2,
        price: 100,
        feePercent: 0.5,
        side: 'BUY',
        orderExecutionDate: 1_700_000_111_000,
      };

      trader['prices'].set('BTC/USDT', 100);

      const result = trader['checkOrderSummary']({
        id: '20a7abd2-546b-4c65-b04d-900b84fa5fe6',
        symbol: 'BTC/USDT',
        type: 'STICKY',
        orderCreationDate: 1_700_000_051_000,
        summary,
      });

      // fee = 2 * 100 * 0.5% = 1
      // effective price = 100 + 100 * 0.5% = 100.5

      expect(result).toEqual({
        order: {
          ...summary,
          id: '20a7abd2-546b-4c65-b04d-900b84fa5fe6',
          symbol: 'BTC/USDT',
          type: 'STICKY',
          orderCreationDate: 1_700_000_051_000,
          fee: 1,
          effectivePrice: 100.5,
        },
        exchange: {
          price: 100,
          portfolio: trader['portfolio'],
        },
      });
    });
  });

  describe('getStaticConfiguration', () => {
    it('exposes expected metadata', () => {
      const configInfo = Trader.getStaticConfiguration();
      expect(configInfo.name).toBe('Trader');
      expect(configInfo.eventsEmitted).toEqual(
        expect.arrayContaining([
          PORTFOLIO_CHANGE_EVENT,
          ORDER_CANCELED_EVENT,
          ORDER_COMPLETED_EVENT,
          ORDER_ERRORED_EVENT,
          ORDER_INITIATED_EVENT,
        ]),
      );
    });
  });
});
