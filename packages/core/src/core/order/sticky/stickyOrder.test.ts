import {
  ORDER_CANCELED_EVENT,
  ORDER_COMPLETED_EVENT,
  ORDER_ERRORED_EVENT,
  ORDER_INVALID_EVENT,
  ORDER_PARTIALLY_FILLED_EVENT,
  ORDER_STATUS_CHANGED_EVENT,
} from '@gekko/shared/constants/event.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { OrderOutOfRangeError } from '@gekko/shared/errors/orderOutOfRange.error';
import { Exchange } from '@gekko/shared/models/exchange.types';
import { OrderState } from '@gekko/shared/models/order.types';
import { ExchangeNetworkError, InvalidOrder, OrderNotFound } from '../../../exchange/exchange.error';
import * as logger from '../../../logger/logger';
import { createRunContextMock } from '../../../run/runContext.mock';
import { assertOrderWithinLimits } from '@gekko/shared/helpers/market/market.helper';
import { round } from '@gekko/shared/utils/math/round.utils';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Transaction } from '../order.types';
import { StickyOrder } from './stickyOrder';

const fakeExchange = {
  fetchTicker: vi.fn(),
  getMarketData: vi.fn(),
  createLimitOrder: vi.fn(),
  cancelOrder: vi.fn(),
  fetchOrder: vi.fn(),
};

// The run the orders belong to: the watch and the exchange section mockConfig returns (set by each test), fakeExchange as its exchange
const mockConfig = { getWatch: vi.fn(), getExchange: vi.fn() };
const context = createRunContextMock({
  configuration: mockConfig,
  services: { exchange: () => fakeExchange as unknown as Exchange },
});

vi.mock('../../../logger/logger', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
// A response the test settles itself, to act while the exchange call is in flight
const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(res => (resolve = res));
  return { promise, resolve };
};

// The next call of an exchange method answers with the given promise: resolves once that call is sent
const whenSent = (method: Mock, response: Promise<OrderState>) =>
  new Promise<void>(resolve =>
    method.mockImplementationOnce(() => {
      resolve();
      return response;
    }),
  );

describe('StickyOrder', () => {
  const defaultOrder: OrderState = { id: 'order-1', status: 'open', filled: 0, remaining: 5, timestamp: Date.now() };
  const flushAsync = () => new Promise(resolve => setTimeout(resolve, 0));

  beforeEach(() => {
    mockConfig.getWatch.mockReturnValue({ mode: 'backtest', pairs: [{ symbol: 'BTC/USDT' }] });
    mockConfig.getExchange.mockReturnValue({ orderSynchInterval: 1000 });
    Object.values(fakeExchange).forEach(value => {
      if (typeof value === 'function') value.mockReset();
    });
    fakeExchange.fetchTicker.mockResolvedValue({ bid: 100, ask: 105 });
    fakeExchange.getMarketData.mockReturnValue({ price: { min: 2 } });
    fakeExchange.createLimitOrder.mockResolvedValue(defaultOrder);
    fakeExchange.cancelOrder.mockResolvedValue({ ...defaultOrder, status: 'canceled' });
    fakeExchange.fetchOrder.mockResolvedValue(defaultOrder);
  });

  const createOrder = async (side: 'BUY' | 'SELL', amount = 5) => {
    const order = new StickyOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', side, amount, undefined, context);
    await order.launch();
    await flushAsync();
    return order;
  };

  describe('launch', () => {
    it.each`
      side      | amount | tickerBid | tickerAsk | marketMin | expectedPrice
      ${'BUY'}  | ${10}  | ${100}    | ${105}    | ${2}      | ${102}
      ${'SELL'} | ${10}  | ${100}    | ${105}    | ${2}      | ${103}
    `(
      'places an initial limit order for $side with price $expectedPrice',
      async ({ side, amount, tickerBid, tickerAsk, marketMin, expectedPrice }) => {
        fakeExchange.fetchTicker.mockResolvedValue({ bid: tickerBid, ask: tickerAsk });
        fakeExchange.getMarketData.mockReturnValue({ price: { min: marketMin } });

        await createOrder(side, amount);

        expect(fakeExchange.createLimitOrder).toHaveBeenCalledWith('BTC/USDT', side, amount, expectedPrice, expect.any(Function));
      },
    );

    // Without a price step, the order is placed at the best bid (ask)
    it.each`
      marketData       | side      | expectedPrice
      ${undefined}     | ${'BUY'}  | ${100}
      ${{}}            | ${'BUY'}  | ${100}
      ${{ price: {} }} | ${'SELL'} | ${105}
    `(
      'places an initial $side limit order at $expectedPrice given the market data $marketData',
      async ({ marketData, side, expectedPrice }) => {
        fakeExchange.getMarketData.mockReturnValue(marketData);

        await createOrder(side);

        expect(fakeExchange.createLimitOrder).toHaveBeenCalledWith('BTC/USDT', side, 5, expectedPrice, expect.any(Function));
      },
    );

    // One price.min beyond the best bid (ask), worked out in decimal: in binary, 101.2 + 0.01 was 101.21000000000001 and 0.3 - 0.1 was
    // 0.19999999999999998, the price the order was created at
    it.each`
      side      | bid      | ask      | marketMin | expectedPrice
      ${'BUY'}  | ${101.2} | ${101.3} | ${0.01}   | ${101.21}
      ${'SELL'} | ${0.1}   | ${0.3}   | ${0.1}    | ${0.2}
    `(
      'places an initial $side limit order at $expectedPrice given a bid of $bid, an ask of $ask and a price.min of $marketMin',
      async ({ side, bid, ask, marketMin, expectedPrice }) => {
        fakeExchange.fetchTicker.mockResolvedValue({ bid, ask });
        fakeExchange.getMarketData.mockReturnValue({ price: { min: marketMin } });

        await createOrder(side);

        expect(fakeExchange.createLimitOrder).toHaveBeenCalledWith('BTC/USDT', side, 5, expectedPrice, expect.any(Function));
      },
    );

    it('creates additional orders using the remaining amount after fills', async () => {
      const order = await createOrder('SELL', 6); // Initial launch
      // Simulate partial fill on first order
      order['transactions'].set('order-1', { id: 'order-1', status: 'open', filled: 4, timestamp: Date.now() });
      fakeExchange.fetchTicker.mockResolvedValue({ bid: 50, ask: 60 });
      fakeExchange.createLimitOrder.mockResolvedValue({ ...defaultOrder, id: 'order-2' });

      await order.launch(); // Re-launch (e.g. after move)

      expect(fakeExchange.createLimitOrder).toHaveBeenLastCalledWith('BTC/USDT', 'SELL', 2, 58, expect.any(Function));
    });

    it('logs the creation of the order', async () => {
      await createOrder('BUY');
      expect(logger.info).toHaveBeenCalledWith(
        'order',
        '[ee21e130-48bc-405f-be0c-46e9bf17b52e] Creating BUY limit order with amount: 5 and price 102',
      );
    });

    // Nothing polls the order in backtest: the simulated exchange reports the fill through the callback given at the creation
    it('completes the order when the simulated exchange settles it through the callback', async () => {
      const order = await createOrder('BUY');
      const listener = vi.fn();
      order.on(ORDER_COMPLETED_EVENT, listener);
      await fakeExchange.createLimitOrder.mock.calls[0][4]({ ...defaultOrder, status: 'closed', filled: 5, remaining: 0 });
      expect(listener).toHaveBeenCalledOnce();
    });

    // The trades of the order are fetched from the first timestamp of its transactions: the settlement carries the time of the fill
    it('keeps the time of the creation when the simulated exchange settles the transaction', async () => {
      const order = await createOrder('BUY');
      const settled = { ...defaultOrder, status: 'closed', filled: 5, remaining: 0, timestamp: defaultOrder.timestamp + 60_000 };
      await fakeExchange.createLimitOrder.mock.calls[0][4](settled);
      expect(order['transactions'].get('order-1')?.timestamp).toBe(defaultOrder.timestamp);
    });

    describe('in realtime mode', () => {
      beforeEach(() => {
        vi.useFakeTimers();
        mockConfig.getWatch.mockReturnValue({ mode: 'realtime', pairs: [{ symbol: 'BTC/USDT' }] });
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('keeps polling the order status once the order is placed', async () => {
        const order = new StickyOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', 5, undefined, context);

        await order.launch();

        expect(vi.getTimerCount()).toBe(1);
      });

      it('gives the exchange no callback: the order is polled', async () => {
        const order = new StickyOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', 5, undefined, context);

        await order.launch();

        expect(fakeExchange.createLimitOrder).toHaveBeenCalledWith('BTC/USDT', 'BUY', 5, 102, undefined);
      });

      // The price comes from the ticker, before any order exists: nobody awaits launch(), so a failure there must end the order
      describe.each`
        kind                   | failure                      | message
        ${'an Error'}          | ${new Error('Network down')} | ${'Network down'}
        ${'a non-Error value'} | ${'ticker unavailable'}      | ${'ticker unavailable'}
      `('when the ticker fetch rejects with $kind', ({ failure, message }) => {
        let order: StickyOrder;

        beforeEach(() => {
          fakeExchange.fetchTicker.mockRejectedValue(failure);
          order = new StickyOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', 5, undefined, context);
        });

        it('resolves instead of rejecting', async () => {
          await expect(order.launch()).resolves.toBeUndefined();
        });

        it('sets the status to error', async () => {
          await order.launch();
          expect(order['getStatus']()).toBe('error');
        });

        // Nothing placed: nothing of it is live
        it('emits ORDER_ERRORED_EVENT once with the failure message, the order not live', async () => {
          const listener = vi.fn();
          order.on(ORDER_ERRORED_EVENT, listener);
          await order.launch();
          expect(listener.mock.calls).toEqual([[{ reason: message, mayBeLive: false }]]);
        });

        it('clears the interval polling the order status', async () => {
          await order.launch();
          expect(vi.getTimerCount()).toBe(0);
        });

        it('does not place a limit order', async () => {
          await order.launch();
          expect(fakeExchange.createLimitOrder).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('cancel', () => {
    it('does nothing when order is already completed', async () => {
      const order = await createOrder('BUY');
      order['setStatus']('filled');
      await order.cancel();
      expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
    });

    it('forwards cancelation when order id is set and status is open', async () => {
      const order = await createOrder('BUY');
      order['setStatus']('open');
      order['id'] = 'order-1';
      await order.cancel();
      expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', 'order-1');
    });

    it('does not cancel if order id is missing', async () => {
      const order = await createOrder('BUY');
      order['setStatus']('open');
      order['id'] = undefined;
      await order.cancel();
      expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
    });

    it('does not cancel if already checking', async () => {
      const order = await createOrder('BUY');
      order['setStatus']('open');
      order['id'] = 'order-1';
      order['isChecking'] = true;
      await order.cancel();
      expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
    });

    it('clears interval if status is not error after cancel', async () => {
      const order = await createOrder('BUY');
      order['setStatus']('open');
      order['id'] = 'order-1';
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      await order.cancel();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });

  describe('checkOrder', () => {
    it('fetches the latest order status when still active', async () => {
      const order = await createOrder('SELL');
      order['setStatus']('open');
      order['id'] = 'order-1';

      await order.checkOrder();

      expect(fakeExchange.fetchOrder).toHaveBeenCalledWith('BTC/USDT', 'order-1');
    });

    it.each`
      condition             | setup
      ${'completed'}        | ${(o: StickyOrder) => o['setStatus']('filled')}
      ${'no id'}            | ${(o: StickyOrder) => (o['id'] = undefined)}
      ${'initializing'}     | ${(o: StickyOrder) => o['setStatus']('initializing')}
      ${'already checking'} | ${(o: StickyOrder) => (o['isChecking'] = true)}
    `('skips fetching when $condition', async ({ setup }) => {
      const order = await createOrder('SELL');
      order['id'] = 'order-1'; // Default valid id
      setup(order);

      await order.checkOrder();

      expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
    });

    // The Trader checks a STICKY order at every candle in backtest: a check is logged at debug level, and only when it is made
    it('logs the check at debug level', async () => {
      const order = await createOrder('SELL');
      await order.checkOrder();
      expect(logger.debug).toHaveBeenCalledWith(
        'order',
        '[ee21e130-48bc-405f-be0c-46e9bf17b52e] Starting checking SELL STICKY order status',
      );
    });

    it('does not log a check it skips', async () => {
      const order = await createOrder('SELL');
      order['setStatus']('filled');
      await order.checkOrder();
      expect(logger.debug).not.toHaveBeenCalledWith('order', expect.stringContaining('Starting checking'));
    });

    it('executes cancel if isCanceling is true', async () => {
      const order = await createOrder('SELL');
      order['id'] = 'order-1';
      order['isCanceling'] = true;
      const cancelSpy = vi.spyOn(order, 'cancel');

      await order.checkOrder();

      expect(cancelSpy).toHaveBeenCalled();
      expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
    });

    it('handles errors during fetch', async () => {
      const order = await createOrder('SELL');
      order['id'] = 'order-1';
      fakeExchange.fetchOrder.mockRejectedValue(new Error('Fetch failed'));
      const erroredSpy = vi.spyOn(order as any, 'orderErrored');

      await order.checkOrder(); // Should catch inside fetchOrder -> handleFetchOrderError

      expect(erroredSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'Fetch failed' }));
    });

    // The move canceled the transaction, and the relaunch placed nothing: nothing of the order is live
    it('ends the order with a single ORDER_ERRORED_EVENT when the relaunch of a move cannot fetch the ticker', async () => {
      const order = await createOrder('BUY');
      fakeExchange.fetchOrder.mockResolvedValue({ ...defaultOrder, price: 102 });
      // The first ticker moves the price (102 -> 202), the second one, fetched by the relaunch, fails
      fakeExchange.fetchTicker.mockResolvedValueOnce({ bid: 200, ask: 210 }).mockRejectedValueOnce(new Error('Network down'));
      const listener = vi.fn();
      order.on(ORDER_ERRORED_EVENT, listener);

      await order.checkOrder();

      expect(listener.mock.calls).toEqual([[{ reason: 'Network down', mayBeLive: false }]]);
    });

    // checkOrder runs in an interval, which ignores its promise: nothing may escape from it, even a failure the handlers missed
    describe.each`
      path        | isCanceling | method
      ${'fetch'}  | ${false}    | ${'fetchOrder'}
      ${'cancel'} | ${true}     | ${'cancel'}
    `('on an unexpected failure of the $path path', ({ isCanceling, method }) => {
      let order: StickyOrder;

      beforeEach(async () => {
        order = await createOrder('SELL');
        order['isCanceling'] = isCanceling;
        vi.spyOn(order as any, method).mockRejectedValue(new Error('unexpected failure'));
      });

      it('resolves instead of rejecting', async () => {
        await expect(order.checkOrder()).resolves.toBeUndefined();
      });

      it('logs the failure', async () => {
        await order.checkOrder();
        expect(logger.error).toHaveBeenCalledWith('order', expect.stringContaining('order check failed: unexpected failure'));
      });
    });
  });

  describe('move', () => {
    it('executes cancel and launch sequence', async () => {
      const order = await createOrder('BUY', 10);
      order['id'] = 'order-1';
      const launchSpy = vi.spyOn(order, 'launch');

      await order['move']();

      expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', 'order-1');
      expect(launchSpy).toHaveBeenCalled();
    });

    it('does not move if canceling', async () => {
      const order = await createOrder('BUY', 10);
      order['isCanceling'] = true;
      const launchSpy = vi.spyOn(order, 'launch');

      await order['move']();

      expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
      expect(launchSpy).not.toHaveBeenCalled();
    });

    // A cancelation that fails for good ends the order in error (see handleCancelOrderError): nothing is placed again
    it('stops move if cancel results in error', async () => {
      const order = await createOrder('BUY', 10);
      order['id'] = 'order-1';
      fakeExchange.cancelOrder.mockRejectedValue(new Error('Cancel failed'));

      await order['move']();

      expect(order['getStatus']()).toBe('error');
    });

    it('resolves when the relaunch cannot fetch the ticker', async () => {
      const order = await createOrder('BUY', 10);
      fakeExchange.fetchTicker.mockRejectedValue(new Error('Network down'));

      await expect(order['move']()).resolves.toBeUndefined();
    });

    it.each`
      flag
      ${'isMoveOutcomeUnknown'}
      ${'isMovePending'}
    `('ends with $flag false once what is left is placed again', async ({ flag }) => {
      const order = await createOrder('BUY', 10);
      await order['move']();
      expect((order as any)[flag]).toBe(false);
    });

    // Failed on the network, the cancelation may have gone through or not: a later poll tells. Answered with the transaction still
    // open, it is accepted: the move waits for the transaction to be seen canceled
    const failOnNetwork = () => fakeExchange.cancelOrder.mockRejectedValue(new ExchangeNetworkError('timeout'));
    const answerOpen = () => fakeExchange.cancelOrder.mockResolvedValue(defaultOrder);
    it.each`
      outcome                                          | answer           | flag                      | value
      ${'fails on the network'}                        | ${failOnNetwork} | ${'isMoveOutcomeUnknown'} | ${true}
      ${'fails on the network'}                        | ${failOnNetwork} | ${'isMovePending'}        | ${false}
      ${'is answered with the transaction still open'} | ${answerOpen}    | ${'isMoveOutcomeUnknown'} | ${false}
      ${'is answered with the transaction still open'} | ${answerOpen}    | ${'isMovePending'}        | ${true}
    `('sets $flag to $value when the cancelation $outcome', async ({ answer, flag, value }) => {
      const order = await createOrder('BUY', 10);
      answer();
      await order['move']();
      expect((order as any)[flag]).toBe(value);
    });

    it.each`
      failure                      | setup
      ${'cannot fetch the ticker'} | ${() => fakeExchange.fetchTicker.mockRejectedValue(new Error('Network down'))}
      ${'rejects unexpectedly'}    | ${(o: StickyOrder) => vi.spyOn(o, 'launch').mockRejectedValue(new Error('unexpected failure'))}
    `('ends the move when the relaunch $failure', async ({ setup }) => {
      const order = await createOrder('BUY', 10);
      setup(order);

      await order['move']().catch(() => undefined);

      expect(order['isMoving']).toBe(false);
    });
  });

  describe('handleCreateOrderSuccess', () => {
    it.each`
      status        | outcome
      ${'closed'}   | ${'orderFilled'}
      ${'canceled'} | ${'orderCanceled'}
    `('calls $outcome when status is $status', async ({ status, outcome }) => {
      const order = await createOrder('BUY');
      const spy = vi.spyOn(order as any, outcome);

      await order['handleCreateOrderSuccess']({ ...defaultOrder, status, filled: 5, remaining: 0 });

      expect(spy).toHaveBeenCalled();
    });

    // Every transaction placed, the first one or the one a move places, is reported open
    it('propagates the open status of a new transaction', async () => {
      const order = await createOrder('BUY');
      const setStatusSpy = vi.spyOn(order as any, 'setStatus');

      await order['handleCreateOrderSuccess']({ ...defaultOrder, id: 'order-2', status: 'open' });

      expect(setStatusSpy).toHaveBeenCalledWith('open');
    });

    it('records the fill of the transaction', async () => {
      const order = await createOrder('BUY');

      await order['handleCreateOrderSuccess']({ ...defaultOrder, status: 'open', filled: 2 });

      expect(order['transactions'].get(defaultOrder.id)?.filled).toBe(2);
    });

    it('emits the fill of the transaction', async () => {
      const order = await createOrder('BUY');
      const listener = vi.fn();
      order.on(ORDER_PARTIALLY_FILLED_EVENT, listener);

      await order['handleCreateOrderSuccess']({ ...defaultOrder, status: 'open', filled: 2 });

      expect(listener.mock.calls).toEqual([[2]]);
    });

    // Unknown, not 0 (see Order.recordOrderUpdate)
    it('records no fill when the creation reports none', async () => {
      fakeExchange.createLimitOrder.mockResolvedValue({ ...defaultOrder, filled: undefined });

      const order = await createOrder('BUY');

      expect(order['transactions'].get(defaultOrder.id)?.filled).toBeUndefined();
    });
  });

  describe('handleCreateOrderError', () => {
    it.each`
      errorType            | errorInstance                                          | partiallyFilled | outcome
      ${'OrderOutOfRange'} | ${new OrderOutOfRangeError('order', 'Range error', 1)} | ${true}         | ${'orderFilled'}
      ${'OrderOutOfRange'} | ${new OrderOutOfRangeError('order', 'Range error', 1)} | ${false}        | ${'orderRejected'}
      ${'InvalidOrder'}    | ${new InvalidOrder('Invalid')}                         | ${false}        | ${'orderRejected'}
      ${'Generic Error'}   | ${new Error('Generic failure')}                        | ${false}        | ${'orderErrored'}
      ${'Network Error'}   | ${new ExchangeNetworkError('timeout')}                 | ${false}        | ${'orderErrored'}
      ${'non-Error value'} | ${'Generic failure'}                                   | ${false}        | ${'orderErrored'}
    `(
      'calls $outcome when error is $errorType and partiallyFilled is $partiallyFilled',
      async ({ errorInstance, partiallyFilled, outcome }) => {
        const order = await createOrder('BUY', 10);
        if (partiallyFilled) {
          order['transactions'].set('prev-order', { id: 'prev', filled: 5, timestamp: Date.now(), status: 'closed' });
        }
        const spy = vi.spyOn(order as any, outcome);

        await order['handleCreateOrderError'](errorInstance);

        expect(spy).toHaveBeenCalled();
      },
    );
  });

  describe('handleCancelOrderSuccess', () => {
    it('calls orderFilled if remaining is 0', async () => {
      const order = await createOrder('BUY');
      const spy = vi.spyOn(order as any, 'orderFilled');
      await order['handleCancelOrderSuccess']({ ...defaultOrder, status: 'canceled', remaining: 0 });
      expect(spy).toHaveBeenCalled();
    });

    // The answer says the transaction canceled, not what is left: the fills, added up in decimal, reach the amount. In binary, 0.7 and
    // 0.1 made 0.7999999999999999, short of an order of 0.8
    it.each`
      amount | previous | canceled
      ${10}  | ${5}     | ${5}
      ${0.8} | ${0.7}   | ${0.1}
    `(
      'calls orderFilled if the $previous filled before and the $canceled of the canceled transaction add up to the amount, $amount',
      async ({ amount, previous, canceled }) => {
        const order = await createOrder('BUY', amount);
        order['transactions'].set('prev', { id: 'prev', filled: previous, timestamp: Date.now(), status: 'closed' });
        const spy = vi.spyOn(order as any, 'orderFilled');
        await order['handleCancelOrderSuccess']({ ...defaultOrder, status: 'canceled', filled: canceled, remaining: undefined });
        expect(spy).toHaveBeenCalled();
      },
    );

    it('calls orderFilled if the transaction is closed', async () => {
      const order = await createOrder('BUY');
      const spy = vi.spyOn(order as any, 'orderFilled');
      await order['handleCancelOrderSuccess']({ ...defaultOrder, status: 'closed', filled: undefined, remaining: undefined });
      expect(spy).toHaveBeenCalled();
    });

    it('calls orderCanceled if not moving and not filled', async () => {
      const order = await createOrder('BUY', 10);
      const spy = vi.spyOn(order as any, 'orderCanceled');
      await order['handleCancelOrderSuccess']({ ...defaultOrder, status: 'canceled', filled: 2, remaining: 8 });
      expect(spy).toHaveBeenCalled();
    });

    // A move whose cancelation is pending, or of unknown outcome, canceled the transaction
    describe.each`
      state                                 | flag
      ${'a move is pending'}                | ${'isMovePending'}
      ${'the outcome of a move is unknown'} | ${'isMoveOutcomeUnknown'}
    `('when $state', ({ flag }) => {
      let order: StickyOrder;

      beforeEach(async () => {
        order = await createOrder('BUY', 10);
        (order as any)[flag] = true;
      });

      it('does NOT call orderCanceled', async () => {
        const spy = vi.spyOn(order as any, 'orderCanceled');
        await order['handleCancelOrderSuccess']({ ...defaultOrder, status: 'canceled', filled: 2 });
        expect(spy).not.toHaveBeenCalled();
      });

      it('places what is left again', async () => {
        await order['handleCancelOrderSuccess']({ ...defaultOrder, status: 'canceled', filled: 2 });
        expect(fakeExchange.createLimitOrder).toHaveBeenLastCalledWith('BTC/USDT', 'BUY', 8, 102, expect.any(Function));
      });

      it('calls orderCanceled if the cancelation of the order was asked', async () => {
        order['isCanceling'] = true;
        const spy = vi.spyOn(order as any, 'orderCanceled');
        await order['handleCancelOrderSuccess']({ ...defaultOrder, status: 'canceled', filled: 2 });
        expect(spy).toHaveBeenCalled();
      });
    });

    // The exchange has accepted the cancelation without completing it yet: the transaction is still live
    it.each`
      outcome
      ${'orderCanceled'}
      ${'orderFilled'}
      ${'launch'}
    `('does not call $outcome if the transaction is still open', async ({ outcome }) => {
      const order = await createOrder('BUY', 10);
      order['isMovePending'] = true;
      const spy = vi.spyOn(order as any, outcome);
      await order['handleCancelOrderSuccess']({ ...defaultOrder, status: 'open', filled: 2, remaining: 8 });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('handleCancelOrderError', () => {
    // A real exchange answers OrderNotFound for an order it no longer knows, executed or already canceled: which one is read back
    it('reads the order back on OrderNotFound', async () => {
      const order = await createOrder('BUY');
      await order['handleCancelOrderError'](new OrderNotFound('Not found'));
      expect(fakeExchange.fetchOrder).toHaveBeenCalledWith('BTC/USDT', 'order-1');
    });

    it('does not call orderFilled on OrderNotFound', async () => {
      const order = await createOrder('BUY');
      const spy = vi.spyOn(order as any, 'orderFilled');
      await order['handleCancelOrderError'](new OrderNotFound('Not found'));
      expect(spy).not.toHaveBeenCalled();
    });

    it('calls orderErrored on OrderNotFound for an order without id', () => {
      const order = new StickyOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', 5, undefined, context);
      const spy = vi.spyOn(order as any, 'orderErrored');
      order['handleCancelOrderError'](new OrderNotFound('Not found'));
      expect(spy).toHaveBeenCalled();
    });

    it('calls orderErrored on other errors', async () => {
      const order = await createOrder('BUY');
      const spy = vi.spyOn(order as any, 'orderErrored');
      await order['handleCancelOrderError'](new Error('Fail'));
      expect(spy).toHaveBeenCalled();
    });

    // Open when its cancelation failed for good, it may still be live
    it('ends the order with the value of a failure that is not an Error as its reason', async () => {
      const order = await createOrder('BUY');
      const listener = vi.fn();
      order.on(ORDER_ERRORED_EVENT, listener);
      await order['handleCancelOrderError']('Fail');
      expect(listener.mock.calls).toEqual([[{ reason: 'Fail', mayBeLive: true }]]);
    });

    it.each`
      outcome
      ${'orderErrored'}
      ${'orderFilled'}
    `('does not call $outcome on an ExchangeNetworkError', async ({ outcome }) => {
      const order = await createOrder('BUY');
      const spy = vi.spyOn(order as any, outcome);
      await order['handleCancelOrderError'](new ExchangeNetworkError('timeout'));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('handleFetchOrderError', () => {
    it.each`
      kind                   | failure                         | reason
      ${'an Error'}          | ${new Error('Invalid API key')} | ${'Invalid API key'}
      ${'a non-Error value'} | ${'Invalid API key'}            | ${'Invalid API key'}
    `('ends the order on $kind, maybe live: it was open when its poll failed', async ({ failure, reason }) => {
      const order = await createOrder('BUY');
      const listener = vi.fn();
      order.on(ORDER_ERRORED_EVENT, listener);
      await order['handleFetchOrderError'](failure);
      expect(listener.mock.calls).toEqual([[{ reason, mayBeLive: true }]]);
    });

    it('keeps the order open on an ExchangeNetworkError', async () => {
      const order = await createOrder('BUY');
      await order['handleFetchOrderError'](new ExchangeNetworkError('timeout'));
      expect(order['getStatus']()).toBe('open');
    });
  });

  // Whichever path ends it, an errored order says what is already filled: that part is executed
  describe('orderErrored', () => {
    it.each`
      filled       | reason
      ${0}         | ${'Invalid API key'}
      ${undefined} | ${'Invalid API key'}
      ${2}         | ${'Invalid API key (2 of 5 already filled)'}
    `('emits ORDER_ERRORED_EVENT with the reason $reason when $filled is filled', async ({ filled, reason }) => {
      const order = await createOrder('BUY', 5);
      order['transactions'].set('order-1', { id: 'order-1', status: 'open', filled, timestamp: Date.now() });
      const listener = vi.fn();
      order.on(ORDER_ERRORED_EVENT, listener);
      order['orderErrored'](new Error('Invalid API key'));
      expect(listener.mock.calls).toEqual([[{ reason, mayBeLive: true }]]);
    });

    it.each`
      mayBeLive
      ${true}
      ${false}
    `('relays mayBeLive $mayBeLive when told, whatever its transaction', async ({ mayBeLive }) => {
      const order = await createOrder('BUY', 5);
      order['transactions'].set('order-1', { id: 'order-1', status: mayBeLive ? 'canceled' : 'open', filled: 2, timestamp: Date.now() });
      const listener = vi.fn();
      order.on(ORDER_ERRORED_EVENT, listener);
      order['orderErrored'](new Error('Invalid API key'), mayBeLive);
      expect(listener.mock.calls).toEqual([[{ reason: 'Invalid API key (2 of 5 already filled)', mayBeLive }]]);
    });

    // A move canceled a transaction 0.02 filled, the one placed after it has filled 0.07: in binary, 0.09000000000000001
    it('says what its transactions filled, added up in decimal', async () => {
      const order = await createOrder('BUY', 0.1);
      order['transactions'].set('order-1', { id: 'order-1', status: 'open', filled: 0.07, timestamp: Date.now() });
      order['transactions'].set('prev', { id: 'prev', status: 'canceled', filled: 0.02, timestamp: Date.now() });
      const listener = vi.fn();
      order.on(ORDER_ERRORED_EVENT, listener);
      order['orderErrored'](new Error('Invalid API key'));
      expect(listener.mock.calls).toEqual([[{ reason: 'Invalid API key (0.09 of 0.1 already filled)', mayBeLive: true }]]);
    });
  });

  describe('handleFetchOrderSuccess', () => {
    it('calls orderFilled when status is closed', async () => {
      const order = await createOrder('BUY');
      const spy = vi.spyOn(order as any, 'orderFilled');
      await order['handleFetchOrderSuccess']({ ...defaultOrder, status: 'closed' });
      expect(spy).toHaveBeenCalled();
    });

    it('calls orderCanceled when status is canceled', async () => {
      const order = await createOrder('BUY');
      const spy = vi.spyOn(order as any, 'orderCanceled');
      await order['handleFetchOrderSuccess']({ ...defaultOrder, status: 'canceled' });
      expect(spy).toHaveBeenCalled();
    });

    // As for every type of order: the fill reported with the end of the transaction is emitted before the order completes
    it('emits the fill, then ORDER_COMPLETED_EVENT, when the transaction is found executed', async () => {
      const order = await createOrder('BUY');
      const events: unknown[][] = [];
      order.on(ORDER_PARTIALLY_FILLED_EVENT, filled => events.push([ORDER_PARTIALLY_FILLED_EVENT, filled]));
      order.on(ORDER_COMPLETED_EVENT, () => events.push([ORDER_COMPLETED_EVENT]));

      await order['handleFetchOrderSuccess']({ ...defaultOrder, status: 'closed', filled: 5, remaining: 0 });

      expect(events).toEqual([[ORDER_PARTIALLY_FILLED_EVENT, 5], [ORDER_COMPLETED_EVENT]]);
    });

    // A move canceled the transaction, and the answer to that cancelation was not final yet, lost on the network, or not found
    it.each`
      state                                 | flag
      ${'a move is pending'}                | ${'isMovePending'}
      ${'the outcome of a move is unknown'} | ${'isMoveOutcomeUnknown'}
    `('places what is left again when status is canceled and $state', async ({ flag }) => {
      const order = await createOrder('BUY');
      (order as any)[flag] = true;
      await order['handleFetchOrderSuccess']({ ...defaultOrder, status: 'canceled', filled: 1 });
      expect(fakeExchange.createLimitOrder).toHaveBeenLastCalledWith('BTC/USDT', 'BUY', 4, 102, expect.any(Function));
    });

    // A move or a cancelation in progress sends its own requests: the read-back of one of them must not start a move within it. A
    // move whose cancelation the exchange has accepted waits for the transaction to end canceled: a new one would cancel it twice
    it.each`
      state                                        | flag
      ${'moving'}                                  | ${'isMoving'}
      ${'canceling'}                               | ${'isCanceling'}
      ${'waiting for the cancelation of its move'} | ${'isMovePending'}
    `('does not price the order again when it is $state', async ({ flag }) => {
      const order = await createOrder('BUY');
      (order as any)[flag] = true;
      fakeExchange.fetchTicker.mockResolvedValue({ bid: 200, ask: 210 });
      await order['handleFetchOrderSuccess']({ ...defaultOrder, status: 'open', price: 102 });
      expect(fakeExchange.fetchTicker).toHaveBeenCalledOnce();
    });

    // Placed at bid + price.min (ask - price.min), the order rests in the book as its best bid (ask): the bid of the ticker is then
    // its own price, which bid + price.min would always pass by one step. It moves, a cancelation sent, only once the market has gone
    // past it: a higher bid for a BUY, a lower ask for a SELL. The price compared is the one the exchange reports for the order.
    it.each`
      side      | price        | bid         | ask        | outcome    | cancelations
      ${'BUY'}  | ${64000.02}  | ${64000.02} | ${64000.1} | ${'stays'} | ${0}
      ${'BUY'}  | ${64000.02}  | ${64000.05} | ${64000.1} | ${'moves'} | ${1}
      ${'BUY'}  | ${64000.02}  | ${64000}    | ${64000.1} | ${'stays'} | ${0}
      ${'SELL'} | ${100}       | ${99.5}     | ${100}     | ${'stays'} | ${0}
      ${'SELL'} | ${100}       | ${99.5}     | ${99.9}    | ${'moves'} | ${1}
      ${'SELL'} | ${100}       | ${99.5}     | ${100.5}   | ${'stays'} | ${0}
      ${'BUY'}  | ${undefined} | ${64000.05} | ${64000.1} | ${'stays'} | ${0}
    `(
      'a $side order the exchange reports open at $price $outcome when the bid is $bid and the ask $ask',
      async ({ side, price, bid, ask, cancelations }) => {
        const order = await createOrder(side);
        fakeExchange.fetchOrder.mockResolvedValue({ ...defaultOrder, price });
        fakeExchange.fetchTicker.mockResolvedValue({ bid, ask });

        await order.checkOrder();

        expect(fakeExchange.cancelOrder).toHaveBeenCalledTimes(cancelations);
      },
    );

    it('logs at debug level that an order reported without its price is not moved', async () => {
      const order = await createOrder('BUY');
      fakeExchange.fetchOrder.mockResolvedValue({ ...defaultOrder, price: undefined });

      await order.checkOrder();

      expect(logger.debug).toHaveBeenCalledWith('order', expect.stringContaining('BUY STICKY order not moved, its price is not reported'));
    });

    it('logs at debug level that an order whose move is pending is not moved', async () => {
      const order = await createOrder('BUY');
      order['isMovePending'] = true;

      await order['handleFetchOrderSuccess']({ ...defaultOrder, status: 'open', price: 102 });

      expect(logger.debug).toHaveBeenCalledWith(
        'order',
        expect.stringContaining('BUY STICKY order not moved, the cancelation of its move is pending'),
      );
    });

    // Still open, the transaction was not canceled by the move whose cancelation failed on the network: the order is priced again
    it.each`
      price
      ${102}
      ${undefined}
    `('clears the unknown outcome of a move when the transaction is open at $price', async ({ price }) => {
      const order = await createOrder('BUY');
      order['isMoveOutcomeUnknown'] = true;
      await order['handleFetchOrderSuccess']({ ...defaultOrder, status: 'open', price });
      expect(order['isMoveOutcomeUnknown']).toBe(false);
    });

    it('moves an order again when the outcome of its move is unknown and the market is past the transaction still open', async () => {
      const order = await createOrder('BUY');
      order['isMoveOutcomeUnknown'] = true;
      fakeExchange.fetchTicker.mockResolvedValue({ bid: 200, ask: 210 });
      await order['handleFetchOrderSuccess']({ ...defaultOrder, status: 'open', price: 102 });
      expect(fakeExchange.cancelOrder).toHaveBeenCalledOnce();
    });

    // The ticker is fetched by the handler of a successful poll, of an order that is live and placed: whatever the failure, on the
    // network or incomplete data, it does not end the order, which is only not moved. Nothing is rethrown either: fetchOrder()
    // would hand it to handleFetchOrderError.
    describe.each`
      entry                        | poll
      ${'handleFetchOrderSuccess'} | ${(o: StickyOrder) => o['handleFetchOrderSuccess']({ ...defaultOrder, status: 'open', price: 102 })}
      ${'fetchOrder'}              | ${(o: StickyOrder) => o['fetchOrder']('order-1')}
      ${'checkOrder'}              | ${(o: StickyOrder) => o.checkOrder()}
    `('when the ticker fetch fails while $entry processes an open order', ({ poll }) => {
      let order: StickyOrder;

      beforeEach(async () => {
        order = await createOrder('BUY');
        fakeExchange.fetchOrder.mockResolvedValue({ ...defaultOrder, price: 102 });
        fakeExchange.fetchTicker.mockRejectedValue(new ExchangeNetworkError('timeout'));
      });

      it('resolves instead of rejecting', async () => {
        await expect(poll(order)).resolves.toBeUndefined();
      });

      it('emits no ORDER_ERRORED_EVENT', async () => {
        const listener = vi.fn();
        order.on(ORDER_ERRORED_EVENT, listener);
        await poll(order);
        expect(listener).not.toHaveBeenCalled();
      });

      it('does not change the status', async () => {
        const listener = vi.fn();
        order.on(ORDER_STATUS_CHANGED_EVENT, listener);
        await poll(order);
        expect(listener).not.toHaveBeenCalled();
      });
    });

    // CCXTExchange throws a GekkoError for a ticker without data. The warning quotes it without its tag, having one of its own
    const incompleteTicker = new GekkoError('exchange', 'Fetch ticker failed to return data for BTC/USDT');
    describe.each`
      kind                         | failure                                | message
      ${'an ExchangeNetworkError'} | ${new ExchangeNetworkError('timeout')} | ${'timeout'}
      ${'a GekkoError'}            | ${incompleteTicker}                    | ${'Fetch ticker failed to return data for BTC/USDT'}
      ${'an Error'}                | ${new Error('Price fail')}             | ${'Price fail'}
      ${'a non-Error value'}       | ${'ticker unavailable'}                | ${'ticker unavailable'}
    `('when the ticker fetch of the poll of an open order fails with $kind', ({ failure, message }) => {
      let order: StickyOrder;

      beforeEach(async () => {
        order = await createOrder('BUY');
        fakeExchange.fetchOrder.mockResolvedValue({ ...defaultOrder, price: 102 });
        fakeExchange.fetchTicker.mockRejectedValue(failure);
      });

      it('keeps the order open', async () => {
        await order.checkOrder();
        expect(order['getStatus']()).toBe('open');
      });

      it('does not move the order', async () => {
        await order.checkOrder();
        expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
      });

      it('logs a warning with the failure', async () => {
        await order.checkOrder();
        expect(logger.warning).toHaveBeenCalledWith(
          'order',
          expect.stringContaining(`order not moved, its new price is unknown: ${message}`),
        );
      });
    });
  });

  // An order that is over stays so: neither the simulated exchange settling it afterwards (the callback given at its creation, in
  // backtest) nor the late answer of a call sent before its end ends it a second time, brings it back to open or moves it
  describe('updates after the end of the order', () => {
    const executed: OrderState = { ...defaultOrder, status: 'closed', filled: 5, remaining: 0 };
    // Open at 90 while the bid is 100: a poll answering so moves an order that is not over
    const outpriced: OrderState = { ...defaultOrder, price: 90 };
    let order: StickyOrder;
    // The callback the order gave the simulated exchange at its creation
    const settle = (state: OrderState) => fakeExchange.createLimitOrder.mock.calls[0][4](state);
    const fail = () => {
      fakeExchange.cancelOrder.mockRejectedValue(new Error('Invalid API key'));
      return order.cancel();
    };

    describe.each`
      end           | finish                    | status
      ${'executed'} | ${() => settle(executed)} | ${'filled'}
      ${'canceled'} | ${() => order.cancel()}   | ${'canceled'}
      ${'errored'}  | ${fail}                   | ${'error'}
    `('once the order is $end', ({ finish, status }) => {
      let transactions: Transaction[];

      beforeEach(async () => {
        order = await createOrder('BUY');
        await finish();
        transactions = structuredClone([...order['transactions'].values()]);
      });

      describe.each`
        update                                                     | apply
        ${'the simulated exchange settles it executed'}            | ${() => settle(executed)}
        ${'a poll answers it executed'}                            | ${() => order['handleFetchOrderSuccess'](executed)}
        ${'a cancelation answers it executed'}                     | ${() => order['handleCancelOrderSuccess'](executed)}
        ${'a poll answers it open at a price the market has left'} | ${() => order['handleFetchOrderSuccess'](outpriced)}
      `('when $update afterwards', ({ apply }) => {
        it('emits nothing', async () => {
          const emitSpy = vi.spyOn(order, 'emit');
          await apply();
          expect(emitSpy).not.toHaveBeenCalled();
        });

        it(`keeps the order ${status}`, async () => {
          await apply();
          expect(order['getStatus']()).toBe(status);
        });

        it('leaves its transactions as they were', async () => {
          await apply();
          expect([...order['transactions'].values()]).toEqual(transactions);
        });

        it('places nothing again', async () => {
          await apply();
          expect(fakeExchange.createLimitOrder).toHaveBeenCalledOnce();
        });
      });
    });
  });

  // 'error' is final: the order is polled and canceled no more. A failure on the network (ExchangeNetworkError) says nothing of the
  // order, which keeps its status: the next check polls, or cancels, again
  describe('failures in realtime', () => {
    const nextCheck = () => vi.advanceTimersByTimeAsync(1000);
    let order: StickyOrder;
    const listen = (...events: string[]) => {
      const listener = vi.fn();
      events.forEach(event => order.on(event, listener));
      return listener;
    };

    beforeEach(() => {
      vi.useFakeTimers();
      mockConfig.getWatch.mockReturnValue({ mode: 'realtime', pairs: [{ symbol: 'BTC/USDT' }] });
      order = new StickyOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', 5, undefined, context);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('when the creation fails on the network', () => {
      let erroredListener: Mock;

      beforeEach(async () => {
        fakeExchange.createLimitOrder.mockRejectedValue(new ExchangeNetworkError('timeout'));
        erroredListener = listen(ORDER_ERRORED_EVENT);
        await order.launch();
      });

      it('emits ORDER_ERRORED_EVENT with a reason saying the outcome is unknown', () => {
        expect(erroredListener).toHaveBeenCalledWith(
          expect.objectContaining({ reason: expect.stringContaining('Outcome unknown: the order may be live on the exchange') }),
        );
      });

      it('says the order may be live', () => {
        expect(erroredListener).toHaveBeenCalledWith(expect.objectContaining({ mayBeLive: true }));
      });

      it('clears the interval polling the order', () => {
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    describe('when a poll fails on the network', () => {
      let terminalListener: Mock;

      beforeEach(async () => {
        await order.launch();
        fakeExchange.fetchOrder.mockRejectedValueOnce(new ExchangeNetworkError('timeout'));
        terminalListener = listen(ORDER_ERRORED_EVENT, ORDER_CANCELED_EVENT, ORDER_COMPLETED_EVENT);
        await nextCheck();
      });

      it('keeps the order open', () => {
        expect(order['getStatus']()).toBe('open');
      });

      it('emits no event', () => {
        expect(terminalListener).not.toHaveBeenCalled();
      });

      it('logs a warning', () => {
        expect(logger.warning).toHaveBeenCalledWith('order', expect.stringContaining('poll failed on the network, it stays open'));
      });

      it('polls again at the next check', async () => {
        await nextCheck();
        expect(fakeExchange.fetchOrder).toHaveBeenCalledTimes(2);
      });
    });

    describe('when a poll fails for good', () => {
      let erroredListener: Mock;

      beforeEach(async () => {
        await order.launch();
        fakeExchange.fetchOrder.mockRejectedValue(new Error('Invalid API key'));
        erroredListener = listen(ORDER_ERRORED_EVENT);
        await nextCheck();
      });

      // Open when its poll failed, it may still be live: nothing follows it any more
      it('emits ORDER_ERRORED_EVENT once, the order maybe live', () => {
        expect(erroredListener.mock.calls).toEqual([[{ reason: 'Invalid API key', mayBeLive: true }]]);
      });

      it('clears the interval polling the order', () => {
        expect(vi.getTimerCount()).toBe(0);
      });

      it('does not poll at a later check', async () => {
        await order.checkOrder();
        expect(fakeExchange.fetchOrder).toHaveBeenCalledOnce();
      });

      it('sends no cancelation when canceled', async () => {
        await order.cancel();
        expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
      });
    });

    describe('when a cancelation fails on the network', () => {
      let terminalListener: Mock;

      beforeEach(async () => {
        await order.launch();
        fakeExchange.cancelOrder.mockRejectedValueOnce(new ExchangeNetworkError('timeout'));
        terminalListener = listen(ORDER_ERRORED_EVENT, ORDER_CANCELED_EVENT, ORDER_COMPLETED_EVENT);
        await order.cancel();
      });

      it('emits no event', () => {
        expect(terminalListener).not.toHaveBeenCalled();
      });

      it('keeps canceling', () => {
        expect(order['isCanceling']).toBe(true);
      });

      it('keeps polling', () => {
        expect(vi.getTimerCount()).toBe(1);
      });

      it('sends the cancelation again at the next check', async () => {
        await nextCheck();
        expect(fakeExchange.cancelOrder).toHaveBeenCalledTimes(2);
      });

      it('is canceled once the cancelation sent again goes through', async () => {
        await nextCheck();
        expect(terminalListener.mock.calls).toEqual([[expect.objectContaining({ status: 'canceled' })]]);
      });
    });

    describe('when a cancelation fails for good', () => {
      let erroredListener: Mock;

      beforeEach(async () => {
        await order.launch();
        fakeExchange.cancelOrder.mockRejectedValue(new Error('Invalid API key'));
        erroredListener = listen(ORDER_ERRORED_EVENT);
        await order.cancel();
      });

      // Not canceled, it may still be live: nothing follows it any more
      it('emits ORDER_ERRORED_EVENT once, the order maybe live', () => {
        expect(erroredListener.mock.calls).toEqual([[{ reason: 'Invalid API key', mayBeLive: true }]]);
      });

      it('clears the interval polling the order', () => {
        expect(vi.getTimerCount()).toBe(0);
      });

      it('sends the cancelation no more', async () => {
        await order.checkOrder();
        await order.cancel();
        expect(fakeExchange.cancelOrder).toHaveBeenCalledOnce();
      });
    });

    // The poll sees the price move from 102 to 202: the move cancels the transaction, then places what is left at the new price
    describe('when the cancelation of a move fails on the network', () => {
      let terminalListener: Mock;

      beforeEach(async () => {
        await order.launch();
        fakeExchange.fetchOrder.mockResolvedValue({ ...defaultOrder, price: 102 });
        fakeExchange.fetchTicker.mockResolvedValue({ bid: 200, ask: 210 });
        fakeExchange.cancelOrder.mockRejectedValueOnce(new ExchangeNetworkError('timeout'));
        terminalListener = listen(ORDER_ERRORED_EVENT, ORDER_CANCELED_EVENT, ORDER_COMPLETED_EVENT);
        await nextCheck();
      });

      it('places nothing beside the transaction that may still be live', () => {
        expect(fakeExchange.createLimitOrder).toHaveBeenCalledOnce();
      });

      it('emits no event', () => {
        expect(terminalListener).not.toHaveBeenCalled();
      });

      it('keeps the order open', () => {
        expect(order['getStatus']()).toBe('open');
      });

      it('moves the order at the next check', async () => {
        await nextCheck();
        expect(fakeExchange.createLimitOrder).toHaveBeenLastCalledWith('BTC/USDT', 'BUY', 5, 202, undefined);
      });
    });

    // The poll records 2 of the 5 filled, the move cancels the transaction, then fails to place the 3 left: nothing is live once the
    // ticker fetch failed, the 3 may be once their creation was lost on the network
    const failTicker = () => fakeExchange.fetchTicker.mockRejectedValueOnce(new ExchangeNetworkError('timeout'));
    const failCreation = () => fakeExchange.createLimitOrder.mockRejectedValueOnce(new ExchangeNetworkError('timeout'));
    describe.each`
      step                  | failRelaunch    | reason                                                           | mayBeLive
      ${'the ticker fetch'} | ${failTicker}   | ${/^timeout \(2 of 5 already filled\)$/}                         | ${false}
      ${'the creation'}     | ${failCreation} | ${/^Outcome unknown: .+ \(timeout\) \(2 of 5 already filled\)$/} | ${true}
    `('when $step of the relaunch of a move fails', ({ failRelaunch, reason, mayBeLive }) => {
      let erroredListener: Mock;

      beforeEach(async () => {
        await order.launch();
        fakeExchange.fetchOrder.mockResolvedValue({ ...defaultOrder, filled: 2, remaining: 3, price: 102 });
        fakeExchange.cancelOrder.mockResolvedValue({ ...defaultOrder, status: 'canceled', filled: 2, remaining: 3, price: 102 });
        fakeExchange.fetchTicker.mockResolvedValueOnce({ bid: 200, ask: 210 });
        failRelaunch();
        erroredListener = listen(ORDER_ERRORED_EVENT);
        await nextCheck();
      });

      it(`emits ORDER_ERRORED_EVENT once, with the part already filled in the reason, mayBeLive ${mayBeLive}`, () => {
        expect(erroredListener.mock.calls).toEqual([[{ reason: expect.stringMatching(reason), mayBeLive }]]);
      });

      it('clears the interval polling the order', () => {
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    // The poll records 2 of the 5 filled and the market runs away: the move cancels the transaction, and the exchange refuses the 3 left
    // (InvalidOrder: a filter of the market, the balance). The order is over with the 2 filled, which its rejection says: the Trader
    // reports that part as a completion (see Trader.reportRejected)
    describe('when the relaunch of a move is refused after a partial fill', () => {
      let invalidListener: Mock;
      let terminalListener: Mock;

      beforeEach(async () => {
        await order.launch();
        fakeExchange.fetchOrder.mockResolvedValue({ ...defaultOrder, filled: 2, remaining: 3, price: 102 });
        fakeExchange.cancelOrder.mockResolvedValue({ ...defaultOrder, status: 'canceled', filled: 2, remaining: 3, price: 102 });
        fakeExchange.fetchTicker.mockResolvedValue({ bid: 200, ask: 210 });
        fakeExchange.createLimitOrder.mockRejectedValueOnce(new InvalidOrder('Filter failure: NOTIONAL'));
        invalidListener = listen(ORDER_INVALID_EVENT);
        terminalListener = listen(ORDER_COMPLETED_EVENT, ORDER_CANCELED_EVENT, ORDER_ERRORED_EVENT);
        await nextCheck();
      });

      it('sends the 3 left at the new price, which the exchange refuses', () => {
        expect(fakeExchange.createLimitOrder).toHaveBeenLastCalledWith('BTC/USDT', 'BUY', 3, 202, undefined);
      });

      it('emits ORDER_INVALID_EVENT once, saying it filled part of what it ordered', () => {
        expect(invalidListener.mock.calls).toEqual([[{ status: 'rejected', filled: true, reason: 'Filter failure: NOTIONAL' }]]);
      });

      it('reports the 2 its canceled transaction filled', () => {
        expect(order.getFilledAmount()).toBe(2);
      });

      it('leaves no transaction open on the exchange', () => {
        expect(Array.from(order['transactions'].values(), ({ status }) => status)).toEqual(['canceled']);
      });

      it('clears the interval polling the order', () => {
        expect(vi.getTimerCount()).toBe(0);
      });

      it('emits no other terminal event', () => {
        expect(terminalListener).not.toHaveBeenCalled();
      });
    });
  });

  // One exchange call at a time: a cancelation is never sent while another call on the order (a poll, a move, a cancelation) is in
  // flight, and one that has to wait is sent as soon as that call has answered. It ends only with the order: an answer that leaves
  // the transaction open is not the end. A move places what is left again only once the transaction is seen canceled.
  describe('cancelation in realtime', () => {
    const nextCheck = () => vi.advanceTimersByTimeAsync(1000);
    const { timestamp } = defaultOrder;
    let order: StickyOrder;
    let terminalEvents: string[];
    let canceledListener: Mock;
    // The poll sees the order placed at 102 while the bid is 200: it is moved, to 202
    const moveAtNextPoll = () => {
      fakeExchange.fetchOrder.mockResolvedValueOnce({ ...defaultOrder, price: 102 });
      fakeExchange.fetchTicker.mockResolvedValue({ bid: 200, ask: 210 });
    };

    beforeEach(async () => {
      vi.useFakeTimers();
      mockConfig.getWatch.mockReturnValue({ mode: 'realtime', pairs: [{ symbol: 'BTC/USDT' }] });
      order = new StickyOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', 5, undefined, context);
      terminalEvents = [];
      [ORDER_COMPLETED_EVENT, ORDER_CANCELED_EVENT, ORDER_ERRORED_EVENT].forEach(event =>
        order.on(event, () => terminalEvents.push(event)),
      );
      canceledListener = vi.fn();
      order.on(ORDER_CANCELED_EVENT, canceledListener);
      await order.launch();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // A cancelation sent again while the first one is in flight would be answered OrderNotFound, the order being canceled already
    describe('while a cancelation is in flight', () => {
      let cancelation: Deferred<OrderState>;

      beforeEach(() => {
        cancelation = deferred();
        fakeExchange.cancelOrder.mockRejectedValue(new OrderNotFound('Unknown order'));
        fakeExchange.cancelOrder.mockReturnValueOnce(cancelation.promise);
        void order.cancel();
      });

      it('sends no second cancelation when canceled again', async () => {
        await order.cancel();
        expect(fakeExchange.cancelOrder).toHaveBeenCalledOnce();
      });

      it('sends no second cancelation at a check', async () => {
        await nextCheck();
        expect(fakeExchange.cancelOrder).toHaveBeenCalledOnce();
      });

      it('does not poll at a check', async () => {
        await nextCheck();
        expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
      });

      it('is only canceled once the cancelation goes through', async () => {
        await order.cancel();
        await nextCheck();
        cancelation.resolve({ ...defaultOrder, status: 'canceled' });
        await nextCheck();
        expect(terminalEvents).toEqual([ORDER_CANCELED_EVENT]);
      });
    });

    // The exchange has accepted the cancelation without completing it yet: the transaction is still live
    describe('when the exchange answers the cancelation with the order still open', () => {
      beforeEach(async () => {
        fakeExchange.cancelOrder.mockResolvedValueOnce(defaultOrder);
        await order.cancel();
      });

      it('emits no event', () => {
        expect(terminalEvents).toEqual([]);
      });

      it('keeps canceling', () => {
        expect(order['isCanceling']).toBe(true);
      });

      it('keeps polling', () => {
        expect(vi.getTimerCount()).toBe(1);
      });

      it('sends the cancelation again at the next check', async () => {
        await nextCheck();
        expect(fakeExchange.cancelOrder).toHaveBeenCalledTimes(2);
      });

      it('is canceled once, when the cancelation sent again goes through', async () => {
        await nextCheck();
        await nextCheck();
        expect(terminalEvents).toEqual([ORDER_CANCELED_EVENT]);
      });
    });

    // A real exchange answers OrderNotFound for an order it no longer knows, executed or already canceled: which one is read back
    describe.each`
      readBack            | fetched                                                           | event
      ${'executed'}       | ${{ ...defaultOrder, status: 'closed', filled: 5, remaining: 0 }} | ${ORDER_COMPLETED_EVENT}
      ${'canceled'}       | ${{ ...defaultOrder, status: 'canceled' }}                        | ${ORDER_CANCELED_EVENT}
      ${'not found, too'} | ${new OrderNotFound('Unknown order')}                             | ${ORDER_ERRORED_EVENT}
    `('when the cancelation is answered OrderNotFound and the order read back is $readBack', ({ fetched, event }) => {
      beforeEach(async () => {
        fakeExchange.cancelOrder.mockRejectedValueOnce(new OrderNotFound('Unknown order'));
        if (fetched instanceof Error) fakeExchange.fetchOrder.mockRejectedValueOnce(fetched);
        else fakeExchange.fetchOrder.mockResolvedValueOnce(fetched);
        await order.cancel();
      });

      it('reads the order back', () => {
        expect(fakeExchange.fetchOrder).toHaveBeenCalledWith('BTC/USDT', 'order-1');
      });

      it(`emits ${event} alone`, () => {
        expect(terminalEvents).toEqual([event]);
      });

      it('clears the interval polling the order', () => {
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    describe('when the cancelation is asked during a poll', () => {
      let poll: Deferred<OrderState>;
      let check: Promise<void>;

      beforeEach(async () => {
        poll = deferred();
        fakeExchange.fetchOrder.mockReturnValueOnce(poll.promise);
        check = order.checkOrder();
        await order.cancel();
      });

      it('sends nothing while the poll is in flight', () => {
        expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
      });

      it('sends the cancelation as soon as the poll has answered', async () => {
        poll.resolve(defaultOrder);
        await check;
        expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', 'order-1');
      });
    });

    describe('when the cancelation is asked during the creation', () => {
      let creation: Deferred<OrderState>;
      let launch: Promise<void>;

      beforeEach(async () => {
        order = new StickyOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', 5, undefined, context);
        creation = deferred();
        fakeExchange.createLimitOrder.mockReturnValueOnce(creation.promise);
        launch = order.launch();
        await order.cancel();
      });

      it('sends nothing before the order has an id', () => {
        expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
      });

      it('sends the cancelation as soon as the creation has answered', async () => {
        creation.resolve({ ...defaultOrder, id: 'order-2' });
        await launch;
        expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', 'order-2');
      });
    });

    // The move has canceled the transaction, 2 of the 5 filled: the order is canceled, nothing is placed again
    describe('when the cancelation is asked during the cancelation of a move', () => {
      beforeEach(async () => {
        moveAtNextPoll();
        const moveCancelation = deferred<OrderState>();
        const sent = whenSent(fakeExchange.cancelOrder, moveCancelation.promise);
        const check = order.checkOrder();
        await sent;
        await order.cancel();
        moveCancelation.resolve({ ...defaultOrder, status: 'canceled', filled: 2, remaining: 3, price: 102 });
        await check;
      });

      it('places nothing again', () => {
        expect(fakeExchange.createLimitOrder).toHaveBeenCalledOnce();
      });

      it('emits ORDER_CANCELED_EVENT once, with what is filled, what is left and the price of the transaction', () => {
        expect(canceledListener.mock.calls).toEqual([[{ status: 'canceled', filled: 2, remaining: 3, price: 102, timestamp }]]);
      });

      it('sends no second cancelation', () => {
        expect(fakeExchange.cancelOrder).toHaveBeenCalledOnce();
      });

      it('clears the interval polling the order', () => {
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    describe('when the cancelation is asked while a move places what is left again', () => {
      let relaunch: Deferred<OrderState>;
      let check: Promise<void>;

      beforeEach(async () => {
        moveAtNextPoll();
        relaunch = deferred();
        const sent = whenSent(fakeExchange.createLimitOrder, relaunch.promise);
        check = order.checkOrder();
        await sent;
        await order.cancel();
      });

      it('sends nothing while the new transaction is being placed', () => {
        expect(fakeExchange.cancelOrder).toHaveBeenCalledOnce();
      });

      it('cancels the new transaction as soon as the poll that moved the order is over', async () => {
        relaunch.resolve({ ...defaultOrder, id: 'order-2', price: 202 });
        await check;
        expect(fakeExchange.cancelOrder).toHaveBeenLastCalledWith('BTC/USDT', 'order-2');
      });

      it('emits ORDER_CANCELED_EVENT alone', async () => {
        relaunch.resolve({ ...defaultOrder, id: 'order-2', price: 202 });
        await check;
        expect(terminalEvents).toEqual([ORDER_CANCELED_EVENT]);
      });
    });

    // Failed on the network, the cancelation of the move may have gone through or not: its outcome is unknown until a poll tells.
    // Answered with the transaction still open, it is accepted: the move is pending. Either way, what is left is placed again once the
    // transaction is seen canceled, unless the order ends meanwhile.
    const failMoveOnNetwork = () => fakeExchange.cancelOrder.mockRejectedValueOnce(new ExchangeNetworkError('timeout'));
    const acceptMove = () => fakeExchange.cancelOrder.mockResolvedValueOnce({ ...defaultOrder, price: 102 });
    // The next poll answers the given state, or fails with the given error
    const atNextPoll = (state: OrderState | Error) => {
      if (state instanceof Error) fakeExchange.fetchOrder.mockRejectedValueOnce(state);
      else fakeExchange.fetchOrder.mockResolvedValueOnce(state);
      return nextCheck();
    };
    describe.each`
      outcome                                          | answer               | flag
      ${'fails on the network'}                        | ${failMoveOnNetwork} | ${'isMoveOutcomeUnknown'}
      ${'is answered with the transaction still open'} | ${acceptMove}        | ${'isMovePending'}
    `('when the cancelation of a move $outcome', ({ answer, flag }) => {
      beforeEach(async () => {
        moveAtNextPoll();
        answer();
        await nextCheck();
      });

      it('places nothing beside the transaction that may still be live', () => {
        expect(fakeExchange.createLimitOrder).toHaveBeenCalledOnce();
      });

      it('emits no event', () => {
        expect(terminalEvents).toEqual([]);
      });

      it(`sets ${flag}`, () => {
        expect((order as any)[flag]).toBe(true);
      });

      describe('then a poll finds the transaction canceled', () => {
        beforeEach(async () => {
          await atNextPoll({ ...defaultOrder, status: 'canceled', price: 102 });
        });

        it('places what is left again at the new price', () => {
          expect(fakeExchange.createLimitOrder).toHaveBeenLastCalledWith('BTC/USDT', 'BUY', 5, 202, undefined);
        });

        it('emits no event', () => {
          expect(terminalEvents).toEqual([]);
        });

        it(`clears ${flag}`, () => {
          expect((order as any)[flag]).toBe(false);
        });
      });

      // Asked by the strategy, the cancelation of the order prevails: whatever canceled the transaction, the order is canceled
      describe.each`
        end                           | finish                                                                              | event
        ${'the strategy cancels it'}  | ${() => order.cancel()}                                                             | ${ORDER_CANCELED_EVENT}
        ${'a poll finds it executed'} | ${() => atNextPoll({ ...defaultOrder, status: 'closed', filled: 5, remaining: 0 })} | ${ORDER_COMPLETED_EVENT}
        ${'a poll fails for good'}    | ${() => atNextPoll(new Error('Invalid API key'))}                                   | ${ORDER_ERRORED_EVENT}
      `('then $end', ({ finish, event }) => {
        beforeEach(async () => {
          await finish();
        });

        it(`emits ${event} alone`, () => {
          expect(terminalEvents).toEqual([event]);
        });

        it('places nothing again', () => {
          expect(fakeExchange.createLimitOrder).toHaveBeenCalledOnce();
        });

        it.each`
          moveFlag
          ${'isMoveOutcomeUnknown'}
          ${'isMovePending'}
        `('leaves $moveFlag false', ({ moveFlag }) => {
          expect((order as any)[moveFlag]).toBe(false);
        });
      });
    });

    // The cancelation of the move did not go through: the transaction is live, and the order is priced again
    describe('when the cancelation of a move fails on the network, then a poll finds the transaction still open', () => {
      beforeEach(async () => {
        moveAtNextPoll();
        failMoveOnNetwork();
        await nextCheck();
        fakeExchange.fetchOrder.mockResolvedValueOnce({ ...defaultOrder, price: 102 });
      });

      // The bid is back at 100, below the order at 102: the order is the best bid again, and stays where it is
      describe('with the market back below its price', () => {
        beforeEach(async () => {
          fakeExchange.fetchTicker.mockResolvedValue({ bid: 100, ask: 105 });
          await nextCheck();
        });

        it('places nothing again', () => {
          expect(fakeExchange.createLimitOrder).toHaveBeenCalledOnce();
        });

        it('sends no other cancelation', () => {
          expect(fakeExchange.cancelOrder).toHaveBeenCalledOnce();
        });

        it.each`
          flag
          ${'isMoveOutcomeUnknown'}
          ${'isMovePending'}
        `('leaves $flag false', ({ flag }) => {
          expect((order as any)[flag]).toBe(false);
        });

        // Canceled by the exchange itself (expired, dead man's switch...), not by the move: the order ends
        describe('then a poll finds the transaction canceled', () => {
          beforeEach(async () => {
            await atNextPoll({ ...defaultOrder, status: 'canceled', filled: 1, remaining: 4, price: 102 });
          });

          it('emits ORDER_CANCELED_EVENT once, with what is filled, what is left and the price of the transaction', () => {
            expect(canceledListener.mock.calls).toEqual([[{ status: 'canceled', filled: 1, remaining: 4, price: 102, timestamp }]]);
          });

          it('places nothing again', () => {
            expect(fakeExchange.createLimitOrder).toHaveBeenCalledOnce();
          });
        });
      });

      // The bid is still at 200, past the order at 102: it moves again
      describe('with the market still past its price', () => {
        beforeEach(async () => {
          await nextCheck();
        });

        it('sends the cancelation of a new move', () => {
          expect(fakeExchange.cancelOrder).toHaveBeenCalledTimes(2);
        });

        it('places what is left again at the new price once that cancelation goes through', () => {
          expect(fakeExchange.createLimitOrder).toHaveBeenLastCalledWith('BTC/USDT', 'BUY', 5, 202, undefined);
        });
      });
    });

    // The exchange has accepted the cancelation of the move: the transaction ends canceled. The bid still at 200, past the order at
    // 102, does not move it meanwhile: the transaction would be canceled a second time
    describe('when the cancelation of a move is answered with the transaction still open, then a poll finds it still open', () => {
      beforeEach(async () => {
        moveAtNextPoll();
        acceptMove();
        await nextCheck();
        await atNextPoll({ ...defaultOrder, price: 102 });
      });

      it('sends no other cancelation', () => {
        expect(fakeExchange.cancelOrder).toHaveBeenCalledOnce();
      });

      it('places nothing again', () => {
        expect(fakeExchange.createLimitOrder).toHaveBeenCalledOnce();
      });

      it('keeps the move pending', () => {
        expect(order['isMovePending']).toBe(true);
      });

      describe('then a poll finds the transaction canceled', () => {
        beforeEach(async () => {
          await atNextPoll({ ...defaultOrder, status: 'canceled', price: 102 });
        });

        it('places what is left again at the new price', () => {
          expect(fakeExchange.createLimitOrder).toHaveBeenLastCalledWith('BTC/USDT', 'BUY', 5, 202, undefined);
        });

        it('emits no event', () => {
          expect(terminalEvents).toEqual([]);
        });
      });
    });

    // Canceled by the exchange itself (expired, dead man's switch...): the order ends
    describe('when a poll finds the transaction canceled with no move pending', () => {
      beforeEach(async () => {
        fakeExchange.fetchOrder.mockResolvedValueOnce({ ...defaultOrder, status: 'canceled', filled: 1, remaining: 4 });
        await nextCheck();
      });

      it('emits ORDER_CANCELED_EVENT once, with what is filled and what is left', () => {
        expect(canceledListener.mock.calls).toEqual([[{ status: 'canceled', filled: 1, remaining: 4, timestamp }]]);
      });

      it('places nothing again', () => {
        expect(fakeExchange.createLimitOrder).toHaveBeenCalledOnce();
      });
    });

    // The read-back applies the state found; open, it starts nothing: a move within the move would send another cancelation
    describe.each`
      readBack      | fetched                                                         | placed | events
      ${'canceled'} | ${{ ...defaultOrder, status: 'canceled', price: 102 }}          | ${2}   | ${[]}
      ${'executed'} | ${{ ...defaultOrder, status: 'closed', filled: 5, price: 102 }} | ${1}   | ${[ORDER_COMPLETED_EVENT]}
      ${'open'}     | ${{ ...defaultOrder, price: 102 }}                              | ${1}   | ${[]}
    `(
      'when the cancelation of a move is answered OrderNotFound and the transaction read back is $readBack',
      ({ fetched, placed, events }) => {
        beforeEach(async () => {
          moveAtNextPoll();
          fakeExchange.cancelOrder.mockRejectedValueOnce(new OrderNotFound('Unknown order'));
          fakeExchange.fetchOrder.mockResolvedValueOnce(fetched);
          await nextCheck();
        });

        it(`places ${placed > 1 ? 'what is left again' : 'nothing again'}`, () => {
          expect(fakeExchange.createLimitOrder).toHaveBeenCalledTimes(placed);
        });

        it('sends one cancelation', () => {
          expect(fakeExchange.cancelOrder).toHaveBeenCalledOnce();
        });

        it(`emits ${events.length ? events.join(', ') : 'no event'}`, () => {
          expect(terminalEvents).toEqual(events);
        });
      },
    );
  });

  // In realtime the creation, each poll and the cancel response all report the cumulative fill of one transaction: a fill seen
  // twice is counted once, and what is left is what no transaction filled
  describe('filled amount in realtime', () => {
    const timestamp = 1_700_000_000_000;
    const state = (id: string, status: OrderState['status'], details: Partial<OrderState> = {}): OrderState => ({
      id,
      status,
      timestamp,
      ...details,
    });

    beforeEach(() => {
      vi.useFakeTimers();
      mockConfig.getWatch.mockReturnValue({ mode: 'realtime', pairs: [{ symbol: 'BTC/USDT' }] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('when a partially filled transaction is canceled', () => {
      let order: StickyOrder;

      beforeEach(async () => {
        fakeExchange.createLimitOrder.mockResolvedValue(state('order-1', 'open', { filled: 0, remaining: 1, price: 102 }));
        order = new StickyOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', 1, undefined, context);
        await order.launch();
      });

      // The poll records the fill, then sees the price move from 102 to 202: the transaction is canceled and what is left placed again
      describe.each`
        polled | canceled | left
        ${0.5} | ${0.5}   | ${0.5}
        ${0.4} | ${0.6}   | ${0.4}
      `('by a move, with $polled filled at the poll and $canceled in the cancel response', ({ polled, canceled, left }) => {
        beforeEach(() => {
          fakeExchange.fetchOrder.mockResolvedValue(state('order-1', 'open', { filled: polled, remaining: 1 - polled, price: 102 }));
          fakeExchange.fetchTicker.mockResolvedValue({ bid: 200, ask: 210 });
          fakeExchange.cancelOrder.mockResolvedValue(
            state('order-1', 'canceled', { filled: canceled, remaining: 1 - canceled, price: 102 }),
          );
          fakeExchange.createLimitOrder.mockResolvedValue(state('order-2', 'open', { filled: 0, remaining: left, price: 202 }));
        });

        it('does not complete the order', async () => {
          const listener = vi.fn();
          order.on(ORDER_COMPLETED_EVENT, listener);
          await order.checkOrder();
          expect(listener).not.toHaveBeenCalled();
        });

        it(`places the ${left} left at the new price`, async () => {
          await order.checkOrder();
          expect(fakeExchange.createLimitOrder).toHaveBeenLastCalledWith('BTC/USDT', 'BUY', left, 202, undefined);
        });
      });

      // The price does not move: the poll only records the fill before the strategy cancels the order. What is left is worked out in
      // decimal: 1 - 0.7 is 0.30000000000000004 in binary
      it.each`
        polled | canceled | filled | remaining
        ${0.3} | ${0.3}   | ${0.3} | ${0.7}
        ${0.3} | ${0.5}   | ${0.5} | ${0.5}
        ${0.7} | ${0.7}   | ${0.7} | ${0.3}
      `(
        'reports $filled filled and $remaining left at 102 when the poll saw $polled filled and the cancel response $canceled',
        async ({ polled, canceled, filled, remaining }) => {
          fakeExchange.fetchOrder.mockResolvedValue(state('order-1', 'open', { filled: polled, remaining: 1 - polled, price: 102 }));
          fakeExchange.cancelOrder.mockResolvedValue(
            state('order-1', 'canceled', { filled: canceled, remaining: 1 - canceled, price: 102 }),
          );
          const listener = vi.fn();
          order.on(ORDER_CANCELED_EVENT, listener);
          await order.checkOrder();

          await order.cancel();

          expect(listener.mock.calls).toEqual([[{ status: 'canceled', filled, remaining, price: 102, timestamp }]]);
        },
      );

      it.each`
        filled
        ${1}
        ${undefined}
      `('completes the order when the cancel response reports nothing left, with $filled filled', async ({ filled }) => {
        fakeExchange.fetchOrder.mockResolvedValue(state('order-1', 'open', { filled: 0.3, remaining: 0.7, price: 102 }));
        fakeExchange.cancelOrder.mockResolvedValue(state('order-1', 'closed', { filled, remaining: 0, price: 102 }));
        const listener = vi.fn();
        order.on(ORDER_COMPLETED_EVENT, listener);
        await order.checkOrder();

        await order.cancel();

        expect(listener).toHaveBeenCalledOnce();
      });

      it('completes the order when the fills of its two transactions add up to its amount', async () => {
        // A move cancels the first transaction, 0.4 filled, and places the 0.6 left again
        fakeExchange.fetchOrder.mockResolvedValue(state('order-1', 'open', { filled: 0.4, remaining: 0.6, price: 102 }));
        fakeExchange.fetchTicker.mockResolvedValue({ bid: 200, ask: 210 });
        fakeExchange.cancelOrder.mockResolvedValue(state('order-1', 'canceled', { filled: 0.4, remaining: 0.6, price: 102 }));
        fakeExchange.createLimitOrder.mockResolvedValue(state('order-2', 'open', { filled: 0, remaining: 0.6, price: 202 }));
        await order.checkOrder();
        // A poll sees the second one 0.2 filled, then its cancel response says 0.6 without saying what is left
        fakeExchange.fetchOrder.mockResolvedValue(state('order-2', 'open', { filled: 0.2, remaining: 0.4, price: 202 }));
        fakeExchange.cancelOrder.mockResolvedValue(state('order-2', 'canceled', { filled: 0.6, price: 202 }));
        await order.checkOrder();
        const listener = vi.fn();
        order.on(ORDER_COMPLETED_EVENT, listener);

        await order.cancel();

        expect(listener).toHaveBeenCalledOnce();
      });
    });

    // No state reported a fill: what the order executed is unknown, which 0 filled and the whole amount left would misstate
    describe('when the exchange never reports a fill', () => {
      beforeEach(() => {
        fakeExchange.createLimitOrder.mockResolvedValue(state('order-1', 'open', { price: 102 }));
        fakeExchange.fetchOrder.mockResolvedValue(state('order-1', 'open', { price: 102 }));
        fakeExchange.cancelOrder.mockResolvedValue(state('order-1', 'canceled'));
      });

      // The order is launched, polled, then canceled by the strategy: the first response saying 'canceled' ends it
      it.each`
        path                                   | response
        ${'the strategy cancels the order'}    | ${fakeExchange.cancelOrder}
        ${'a poll finds the order canceled'}   | ${fakeExchange.fetchOrder}
        ${'the order is canceled at creation'} | ${fakeExchange.createLimitOrder}
      `('reports neither a fill nor what is left when $path', async ({ response }) => {
        response.mockResolvedValue(state('order-1', 'canceled'));
        const order = new StickyOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', 1, undefined, context);
        const listener = vi.fn();
        order.on(ORDER_CANCELED_EVENT, listener);

        await order.launch();
        await order.checkOrder();
        await order.cancel();

        expect(listener.mock.calls).toEqual([[{ status: 'canceled', timestamp }]]);
      });

      it('places the whole amount again when a move cancels the order', async () => {
        const order = new StickyOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', 1, undefined, context);
        await order.launch();
        fakeExchange.fetchTicker.mockResolvedValue({ bid: 200, ask: 210 });

        await order.checkOrder();

        expect(fakeExchange.createLimitOrder).toHaveBeenLastCalledWith('BTC/USDT', 'BUY', 1, 202, undefined);
      });
    });

    // What is left is placed again as worked out in decimal: the exchange truncates an amount to its step and refuses one under its
    // minimum (see CCXTExchange.createLimitOrder). Worked out in binary, 2.5 - 2.2 was 0.2999999999999998, placed as 0.29, and the 0.01
    // left of 0.1 once 0.02 then 0.07 had filled was 0.009999999999999995, placed as nothing: refused, the order was taken for filled
    describe('when a move places what is left again after partial fills', () => {
      let order: StickyOrder;
      let placed: number[];

      // The exchange places an order as CCXTExchange does: its amount truncated to the step of 0.01, then checked against the limits
      const placeAsTheExchange = (minimumAmount: number, minimumCost?: number) =>
        fakeExchange.createLimitOrder.mockImplementation(async (_symbol: string, _side: string, amount: number, price: number) => {
          const truncated = round(amount, 2, 'down');
          const marketData = { amount: { min: minimumAmount }, cost: { min: minimumCost } };
          assertOrderWithinLimits({ tag: 'exchange', amount: truncated, price, marketData });
          placed.push(truncated);
          return state(`order-${placed.length}`, 'open', { filled: 0, remaining: truncated, price });
        });

      // A BUY of `amount` is placed at 102, then for each fill: a poll reports the transaction placed last filled so much, open at 102
      // while the bid is at 200, and the order moves, the cancelation answered with that fill: what is left is placed again at 202
      const moveAfterEachFill = async (amount: number, fills: number[], minimumAmount = 0.01, minimumCost?: number) => {
        placeAsTheExchange(minimumAmount, minimumCost);
        order = new StickyOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', amount, undefined, context);
        await order.launch();
        fakeExchange.fetchTicker.mockResolvedValue({ bid: 200, ask: 210 });
        for (const filled of fills) {
          const id = `order-${placed.length}`;
          fakeExchange.fetchOrder.mockResolvedValueOnce(state(id, 'open', { filled, price: 102 }));
          fakeExchange.cancelOrder.mockResolvedValueOnce(state(id, 'canceled', { filled, price: 102 }));
          await order.checkOrder();
        }
      };

      beforeEach(() => {
        placed = [];
      });

      it.each`
        amount  | fills           | left
        ${2.5}  | ${[2.2]}        | ${0.3}
        ${1}    | ${[0.9]}        | ${0.1}
        ${0.03} | ${[0.01]}       | ${0.02}
        ${0.8}  | ${[0.7]}        | ${0.1}
        ${0.1}  | ${[0.02, 0.07]} | ${0.01}
        ${0.08} | ${[0.01, 0.05]} | ${0.02}
      `('sends exactly the $left left of $amount once its transactions filled $fills', async ({ amount, fills, left }) => {
        await moveAfterEachFill(amount, fills);
        expect(fakeExchange.createLimitOrder).toHaveBeenLastCalledWith('BTC/USDT', 'BUY', left, 202, undefined);
      });

      // Exactly the market's minimum, what is left is placed: in binary it fell a step under it, and was refused
      describe.each`
        amount | fills           | minimum
        ${2.5} | ${[2.2]}        | ${0.3}
        ${0.1} | ${[0.02, 0.07]} | ${0.01}
      `('when the $minimum left of $amount once its transactions filled $fills is the market minimum', ({ amount, fills, minimum }) => {
        beforeEach(async () => {
          await moveAfterEachFill(amount, fills, minimum);
        });

        it(`places the ${minimum} left on the exchange`, () => {
          expect(placed.at(-1)).toBe(minimum);
        });

        it('keeps the order open, not taken for filled', () => {
          expect(order['getStatus']()).toBe('open');
        });
      });

      // Costing exactly the market's minimum, what is left is placed: its cost worked out in binary, 0.3 at 202 cost 60.599999999999994,
      // under a minimum of 60.6, and was refused as out of range, the order taken for filled without it (see handleCreateOrderError)
      describe('when the 0.3 left of 2.5 once its transactions filled 2.2 costs the market minimum of 60.6 at 202', () => {
        beforeEach(async () => {
          await moveAfterEachFill(2.5, [2.2], 0.01, 60.6);
        });

        it('places the 0.3 left on the exchange', () => {
          expect(placed.at(-1)).toBe(0.3);
        });

        it('keeps the order open, not taken for filled', () => {
          expect(order['getStatus']()).toBe('open');
        });
      });

      // The transaction placed last executes what it was placed for: the transactions, one after the other, filled the amount
      it.each`
        amount | fills
        ${2.5} | ${[2.2]}
        ${1}   | ${[0.9]}
        ${0.8} | ${[0.7]}
        ${0.1} | ${[0.02, 0.07]}
      `('fills exactly $amount once the transaction placed after $fills executes', async ({ amount, fills }) => {
        await moveAfterEachFill(amount, fills);
        fakeExchange.fetchOrder.mockResolvedValueOnce(state(`order-${placed.length}`, 'closed', { filled: placed.at(-1), remaining: 0 }));
        await order.checkOrder();
        expect(order.getFilledAmount()).toBe(amount);
      });
    });
  });
});
