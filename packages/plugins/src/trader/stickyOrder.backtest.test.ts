import { ORDER_CANCELED_EVENT, ORDER_COMPLETED_EVENT, ORDER_ERRORED_EVENT, ORDER_INVALID_EVENT } from '@gekko/shared/constants/event.const';
import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { Candle } from '@gekko/shared/models/candle.types';
import { OrderCompletedEvent } from '@gekko/shared/models/event.types';
import { OrderState } from '@gekko/shared/models/order.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { Trader } from './trader';
import { DummyCentralizedExchange } from '@gekko/core/exchange/dummy/dummyCentralizedExchange';
import { MarketData } from '@gekko/shared/models/exchange.types';
import type { MockInstance } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StickyOrder } from '@gekko/core/core/order/sticky/stickyOrder';

// A STICKY order in backtest, on the real simulated exchange: nothing polls it there, the exchange settles it through the callback
// of its creation, and the Trader checks it once per bucket, which moves it once the market has gone past its price.

const { mockConfig, injected } = vi.hoisted(() => ({
  mockConfig: { getWatch: vi.fn(), getExchange: vi.fn(), getStrategy: vi.fn() },
  injected: { exchange: undefined as unknown },
}));

vi.mock('@gekko/core/configuration/configuration', () => ({ config: mockConfig }));
vi.mock('@gekko/core/logger/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));
// The orders reach the simulated exchange through the injecter, as in a backtest
vi.mock('@gekko/core/injecter/injecter', () => ({ inject: { exchange: () => injected.exchange } }));

const SYMBOL: TradingPair = 'BTC/USDT';
const ORDER_ID = 'ee21e130-48bc-405f-be0c-46e9bf17b52e';
const START = Date.UTC(2024, 0, 1);
const TERMINAL_EVENTS = [ORDER_COMPLETED_EVENT, ORDER_CANCELED_EVENT, ORDER_ERRORED_EVENT, ORDER_INVALID_EVENT];
// A STICKY order is placed price.min beyond the ticker, which the simulated exchange quotes at the last close for bid and ask
const marketData: MarketData = { price: { min: 0.01 }, amount: { min: 0.001 }, cost: { min: 1 }, fee: { maker: 0.001, taker: 0.002 } };

type Prices = Pick<Candle, 'low' | 'high' | 'close'>;

/** The bucket of the given minute of the backtest */
const createBucket = (minute: number, { low, high, close }: Prices) =>
  new Map<TradingPair, Candle>([[SYMBOL, { start: START + minute * ONE_MINUTE, open: close, high, low, close, volume: 1 }]]);

/** The simulated exchange of the backtest, which the orders reach through the injecter, once it has settled the first bucket */
const startBacktest = async (firstBucket: Map<TradingPair, Candle>) => {
  mockConfig.getWatch.mockReturnValue({
    mode: 'backtest',
    pairs: [{ symbol: SYMBOL, timeframe: '1m' }],
    timeframe: '1m',
    warmup: { candleCount: 0 },
    assets: ['BTC'],
    currency: 'USDT',
    daterange: { start: START, end: START + 10 * ONE_MINUTE },
  });
  mockConfig.getExchange.mockReturnValue({ name: 'dummy-cex', exchangeSynchInterval: 600_000, orderSynchInterval: 1_000 });
  mockConfig.getStrategy.mockReturnValue({});

  const exchange = new DummyCentralizedExchange({
    name: 'dummy-cex',
    exchangeSynchInterval: 600_000,
    orderSynchInterval: 1_000,
    marketData: new Map([[SYMBOL, marketData]]),
    simulationBalance: new Map([
      ['BTC', 1],
      ['USDT', 1_000],
    ]),
    initialTicker: new Map(),
  });
  injected.exchange = exchange;
  await exchange.processOneMinuteBucket(firstBucket);
  return exchange;
};

// The order is placed at the close of 100 of the first minute. The next candle never reaches it, and closes past it: the order is
// moved one step beyond that close. The candle after reaches that new price, but not the first one.
describe.each`
  side      | placedAt  | runAway                                    | movedTo   | reached
  ${'BUY'}  | ${100.01} | ${{ low: 101, high: 101.5, close: 101.2 }} | ${101.21} | ${{ low: 101.1, high: 101.4, close: 101.3 }}
  ${'SELL'} | ${99.99}  | ${{ low: 98.5, high: 99, close: 98.8 }}    | ${98.79}  | ${{ low: 98.6, high: 98.9, close: 98.7 }}
`('A STICKY $side order in backtest', ({ side, placedAt, runAway, movedTo, reached }) => {
  const firstBucket = createBucket(0, { low: 99.5, high: 100.5, close: 100 });
  let exchange: DummyCentralizedExchange;
  let createLimitOrder: MockInstance<DummyCentralizedExchange['createLimitOrder']>;
  let cancelOrder: MockInstance<DummyCentralizedExchange['cancelOrder']>;

  beforeEach(async () => {
    exchange = await startBacktest(firstBucket);
    createLimitOrder = vi.spyOn(exchange, 'createLimitOrder');
    cancelOrder = vi.spyOn(exchange, 'cancelOrder');
  });

  // As the Trader checks it: once the simulated exchange has settled the bucket (see PluginsStream)
  describe('checked after each bucket', () => {
    let order: StickyOrder;
    let firstTransaction: OrderState;
    let terminalEvents: string[];

    const processBucket = async (minute: number, prices: Prices) => {
      await exchange.processOneMinuteBucket(createBucket(minute, prices));
      await order.checkOrder();
    };

    beforeEach(async () => {
      terminalEvents = [];
      order = new StickyOrder(SYMBOL, ORDER_ID, side, 1);
      TERMINAL_EVENTS.forEach(event => order.on(event, () => terminalEvents.push(event)));
      await order.launch();
      firstTransaction = await createLimitOrder.mock.results[0].value;
    });

    it(`is placed at ${placedAt}`, () => {
      expect(createLimitOrder).toHaveBeenCalledWith(SYMBOL, side, 1, placedAt, expect.any(Function));
    });

    describe('when the next candle closes past it without reaching it', () => {
      beforeEach(async () => {
        await processBucket(1, runAway);
      });

      it('cancels the transaction placed first', () => {
        expect(cancelOrder.mock.calls).toEqual([[SYMBOL, firstTransaction.id]]);
      });

      // Worked out in decimal: in binary, 101.2 + 0.01 was 101.21000000000001 and 98.8 - 0.01 was 98.78999999999999
      it(`places it again one step beyond the close, at ${movedTo}, to be settled through the callback`, () => {
        expect(createLimitOrder).toHaveBeenLastCalledWith(SYMBOL, side, 1, movedTo, expect.any(Function));
      });

      it('does not end the order', () => {
        expect(terminalEvents).toEqual([]);
      });

      describe(`then a candle reaches ${movedTo}`, () => {
        beforeEach(async () => {
          await processBucket(2, reached);
        });

        it('completes the order', () => {
          expect(terminalEvents).toEqual([ORDER_COMPLETED_EVENT]);
        });

        // At the price it was placed at: the simulated exchange fills a limit order at its own price
        it(`executes it at ${movedTo}`, async () => {
          const { price } = await order.createSummary();
          expect(price).toBe(movedTo);
        });
      });
    });

    // The check of an order already over, still listed by the Trader until its report removes it, does nothing
    describe('when the next candle reaches it', () => {
      beforeEach(async () => {
        await processBucket(1, { low: 99, high: 101, close: 100 });
      });

      it('completes the order', () => {
        expect(terminalEvents).toEqual([ORDER_COMPLETED_EVENT]);
      });

      it('does not move it', () => {
        expect(cancelOrder).not.toHaveBeenCalled();
      });
    });
  });

  // As a backtest runs them: the simulated exchange settles each bucket, then the plugins process it (see PluginsStream)
  describe('created by the Trader', () => {
    const relayedEvents = [ORDER_COMPLETED_EVENT, ORDER_CANCELED_EVENT, ORDER_ERRORED_EVENT];
    let trader: Trader;
    let addDeferredEmit: MockInstance<Trader['addDeferredEmit']>;

    // The Trader awaits neither the launch of an order nor the report of its end: once only timers are left, both are over
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const processBucket = async (minute: number, prices: Prices) => {
      const bucket = createBucket(minute, prices);
      await exchange.processOneMinuteBucket(bucket);
      await trader.processInputStream(bucket);
    };

    beforeEach(async () => {
      trader = new Trader();
      trader.setExchange(exchange);
      addDeferredEmit = vi.spyOn(trader, 'addDeferredEmit');
      await trader.processInputStream(firstBucket);

      await trader.onStrategyCreateOrder([
        { id: ORDER_ID, orderCreationDate: START + ONE_MINUTE, side, type: 'STICKY', amount: 1, symbol: SYMBOL },
      ]);
      await settle();
      await processBucket(1, runAway);
      await processBucket(2, reached);
      await settle();
    });

    // Not the market price of its creation, 100, nor the price it was first placed at: the price it filled at
    it(`relays its execution at ${movedTo}, where the bucket after its creation moved it`, () => {
      const completed = addDeferredEmit.mock.calls.find(([event]) => event === ORDER_COMPLETED_EVENT)?.[1] as OrderCompletedEvent;
      expect(completed?.order.price).toBe(movedTo);
    });

    it('relays no other end of the order', () => {
      const relayed = addDeferredEmit.mock.calls.map(([event]) => event).filter(event => relayedEvents.includes(event));
      expect(relayed).toEqual([ORDER_COMPLETED_EVENT]);
    });
  });
});

// A candle that reaches the price of the order exactly fills it. Worked out in binary, one step beyond the close was an ulp short of
// that price (130.01 + 0.01 was 130.01999999999998, 129.99 - 0.01 was 129.98000000000002), which the simulated exchange took as it
// was: the candle missed the order, and it was moved instead
describe.each`
  side      | close     | placedAt  | touch
  ${'BUY'}  | ${130.01} | ${130.02} | ${{ low: 130.02, high: 130.5, close: 130.3 }}
  ${'SELL'} | ${129.99} | ${129.98} | ${{ low: 129.5, high: 129.98, close: 129.7 }}
`('A STICKY $side order placed in backtest one step beyond a close of $close', ({ side, close, placedAt, touch }) => {
  let createLimitOrder: MockInstance<DummyCentralizedExchange['createLimitOrder']>;
  let cancelOrder: MockInstance<DummyCentralizedExchange['cancelOrder']>;
  let terminalEvents: string[];

  beforeEach(async () => {
    const exchange = await startBacktest(createBucket(0, { low: close, high: close, close }));
    createLimitOrder = vi.spyOn(exchange, 'createLimitOrder');
    cancelOrder = vi.spyOn(exchange, 'cancelOrder');
    const order = new StickyOrder(SYMBOL, ORDER_ID, side, 1);
    terminalEvents = [];
    TERMINAL_EVENTS.forEach(event => order.on(event, () => terminalEvents.push(event)));
    await order.launch();
    // As the Trader checks it: once the simulated exchange has settled the bucket (see PluginsStream)
    await exchange.processOneMinuteBucket(createBucket(1, touch));
    await order.checkOrder();
  });

  it(`is placed at ${placedAt}`, () => {
    expect(createLimitOrder).toHaveBeenCalledWith(SYMBOL, side, 1, placedAt, expect.any(Function));
  });

  it(`is completed by the next candle, which reaches ${placedAt} exactly`, () => {
    expect(terminalEvents).toEqual([ORDER_COMPLETED_EVENT]);
  });

  it('is not moved', () => {
    expect(cancelOrder).not.toHaveBeenCalled();
  });
});
