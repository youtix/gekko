import {
  ORDER_CANCELED_EVENT,
  ORDER_COMPLETED_EVENT,
  ORDER_ERRORED_EVENT,
  ORDER_INVALID_EVENT,
  ORDER_PARTIALLY_FILLED_EVENT,
} from '@gekko/shared/constants/event.const';
import { OrderOutOfRangeError } from '@gekko/shared/errors/orderOutOfRange.error';
import { Exchange } from '@gekko/shared/models/exchange.types';
import { OrderState } from '@gekko/shared/models/order.types';
import { ExchangeNetworkError, InvalidOrder, OrderNotFound, OrderOutcomeUnknown } from '../../../exchange/exchange.error';
import * as logger from '../../../logger/logger';
import { createRunContextMock } from '../../../run/runContext.mock';
import { toTimestamp } from '@gekko/shared/utils/date/date.utils';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Transaction } from '../order.types';
import { LimitOrder } from './limitOrder';

vi.mock('../../../logger/logger', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

const fakeExchange = {
  createLimitOrder: vi.fn(),
  cancelOrder: vi.fn(),
  fetchOrder: vi.fn(),
  fetchMyTrades: vi.fn(),
};

// The run the orders belong to: the watch and the exchange section mockConfig returns (set by each test), fakeExchange as its exchange
const mockConfig = { getWatch: vi.fn(), getExchange: vi.fn() };
const context = createRunContextMock({
  configuration: mockConfig,
  services: { exchange: () => fakeExchange as unknown as Exchange },
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
// A response the test settles itself, to act while the exchange call is in flight
const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(res => (resolve = res));
  return { promise, resolve };
};

describe('LimitOrder', () => {
  const defaultOrderId = 'order-1';
  const defaultGekkoId = 'ee21e130-48bc-405f-be0c-46e9bf17b52e';
  const defaultOrder: OrderState = {
    id: defaultOrderId,
    status: 'open',
    filled: 0,
    remaining: 1,
    price: 100,
    timestamp: toTimestamp('2025'),
  };

  let order: LimitOrder;

  // The terminal events of the order, in the order it emits them
  const recordTerminalEvents = () => {
    const events: string[] = [];
    [ORDER_COMPLETED_EVENT, ORDER_CANCELED_EVENT, ORDER_ERRORED_EVENT].forEach(event => order.on(event, () => events.push(event)));
    return events;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockConfig.getWatch.mockReturnValue({ mode: 'backtest', pairs: [{ symbol: 'BTC/USDT' }] });
    mockConfig.getExchange.mockReturnValue({ orderSynchInterval: 1000 });
    Object.values(fakeExchange).forEach(value => {
      if (typeof value === 'function') value.mockReset();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it.each`
      mode          | shouldSetInterval
      ${'backtest'} | ${false}
      ${'realtime'} | ${true}
    `('initializes correctly in $mode mode (interval: $shouldSetInterval)', ({ mode, shouldSetInterval }) => {
      mockConfig.getWatch.mockReturnValue({ mode, pairs: [{ symbol: 'BTC/USDT' }] });
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1, 100, context);

      if (shouldSetInterval) {
        expect(setIntervalSpy).toHaveBeenCalled();
      } else {
        expect(setIntervalSpy).not.toHaveBeenCalled();
      }
    });
  });

  describe('launch', () => {
    it('creates a limit order and handles success', async () => {
      fakeExchange.createLimitOrder.mockResolvedValue(defaultOrder);
      order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1.5, 101, context);

      await order.launch();

      expect(fakeExchange.createLimitOrder).toHaveBeenCalledWith('BTC/USDT', 'BUY', 1.5, 101, expect.any(Function));
      expect([...order['transactions'].values()]).toEqual([
        expect.objectContaining({
          id: defaultOrderId,
          status: 'open',
        }),
      ]);
    });

    // Nothing polls the order in backtest: the simulated exchange reports the fill through the callback given at the creation
    describe.each`
      mode          | callback                  | onSettled
      ${'backtest'} | ${'a callback'}           | ${expect.any(Function)}
      ${'realtime'} | ${'no callback (polled)'} | ${undefined}
    `('in $mode mode', ({ mode, callback, onSettled }) => {
      beforeEach(async () => {
        mockConfig.getWatch.mockReturnValue({ mode, pairs: [{ symbol: 'BTC/USDT' }] });
        fakeExchange.createLimitOrder.mockResolvedValue(defaultOrder);
        order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1.5, 101, context);
        await order.launch();
      });

      it('logs the creation of the order', () => {
        expect(logger.info).toHaveBeenCalledWith('order', `[${defaultGekkoId}] Creating BUY limit order with amount: 1.5 and price 101`);
      });

      it(`gives the exchange ${callback}`, () => {
        expect(fakeExchange.createLimitOrder).toHaveBeenCalledWith('BTC/USDT', 'BUY', 1.5, 101, onSettled);
      });
    });

    it('completes the order when the simulated exchange settles it through the callback', async () => {
      fakeExchange.createLimitOrder.mockResolvedValue(defaultOrder);
      order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1, 100, context);
      await order.launch();
      const terminalEvents = recordTerminalEvents();
      fakeExchange.createLimitOrder.mock.calls[0][4]({ ...defaultOrder, status: 'closed', filled: 1, remaining: 0 });
      expect(terminalEvents).toEqual([ORDER_COMPLETED_EVENT]);
    });

    it.each`
      error                                                   | reason
      ${new InvalidOrder('too small')}                        | ${'too small'}
      ${new OrderOutOfRangeError('order', 'out of range', 1)} | ${'out of range'}
    `('rejects order on known error: $error.name', async ({ error, reason }) => {
      fakeExchange.createLimitOrder.mockRejectedValue(error);
      order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 2, 105, context);
      const emitSpy = vi.spyOn(order as any, 'emit');

      await order.launch();

      expect(emitSpy).toHaveBeenCalledWith(
        ORDER_INVALID_EVENT,
        expect.objectContaining({
          status: 'rejected',
          reason: expect.stringContaining(reason),
        }),
      );
    });

    describe.each`
      mode
      ${'backtest'}
      ${'realtime'}
    `('on an unknown error during creation in $mode mode', ({ mode }) => {
      beforeEach(() => {
        mockConfig.getWatch.mockReturnValue({ mode, pairs: [{ symbol: 'BTC/USDT' }] });
        fakeExchange.createLimitOrder.mockRejectedValue(new Error('Unknown error'));
        order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 2, 105, context);
      });

      it('resolves instead of rejecting', async () => {
        await expect(order.launch()).resolves.toBeUndefined();
      });

      // Any failure but one of unknown outcome is taken for one that placed nothing
      it('emits ORDER_ERRORED_EVENT with the error message, the order not live', async () => {
        const emitSpy = vi.spyOn(order as any, 'emit');
        await order.launch();
        expect(emitSpy).toHaveBeenCalledWith(ORDER_ERRORED_EVENT, { reason: 'Unknown error', mayBeLive: false });
      });

      it('sets the status to error', async () => {
        await order.launch();
        expect((order as any).getStatus()).toBe('error');
      });

      it('does not reject the order', async () => {
        const emitSpy = vi.spyOn(order as any, 'emit');
        await order.launch();
        expect(emitSpy).not.toHaveBeenCalledWith(ORDER_INVALID_EVENT, expect.anything());
      });
    });
  });

  describe('cancel', () => {
    beforeEach(() => {
      fakeExchange.createLimitOrder.mockResolvedValue(defaultOrder);
      order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1, 100, context);
    });

    it('does nothing if order is already completed', async () => {
      await order.launch();
      // Simulate completion
      (order as any).handleFetchOrderSuccess({ ...defaultOrder, status: 'closed' });
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      await order.cancel();

      expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it('does nothing if order id is missing or initializing', async () => {
      // Not launched yet, so no ID and status is initializing
      await order.cancel();
      expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
    });

    it('cancels order successfully', async () => {
      await order.launch();
      fakeExchange.cancelOrder.mockResolvedValue({
        ...defaultOrder,
        status: 'canceled',
      });

      await order.cancel();

      expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', defaultOrderId);
    });

    // A real exchange answers OrderNotFound for an order it no longer knows, executed or already canceled: which one is read back
    describe.each`
      readBack            | fetched                                                           | event
      ${'executed'}       | ${{ ...defaultOrder, status: 'closed', filled: 1, remaining: 0 }} | ${ORDER_COMPLETED_EVENT}
      ${'canceled'}       | ${{ ...defaultOrder, status: 'canceled' }}                        | ${ORDER_CANCELED_EVENT}
      ${'not found, too'} | ${new OrderNotFound('Unknown order')}                             | ${ORDER_ERRORED_EVENT}
    `('when the cancelation is answered OrderNotFound and the order read back is $readBack', ({ fetched, event }) => {
      let terminalEvents: string[];

      beforeEach(async () => {
        await order.launch();
        fakeExchange.cancelOrder.mockRejectedValue(new OrderNotFound('Unknown order'));
        if (fetched instanceof Error) fakeExchange.fetchOrder.mockRejectedValue(fetched);
        else fakeExchange.fetchOrder.mockResolvedValue(fetched);
        terminalEvents = recordTerminalEvents();
        await order.cancel();
      });

      it('reads the order back', () => {
        expect(fakeExchange.fetchOrder).toHaveBeenCalledWith('BTC/USDT', defaultOrderId);
      });

      it(`emits ${event} alone`, () => {
        expect(terminalEvents).toEqual([event]);
      });
    });

    describe('on an unknown error during cancel', () => {
      beforeEach(async () => {
        await order.launch();
        fakeExchange.cancelOrder.mockRejectedValue(new Error('Network error'));
      });

      it('resolves instead of rejecting', async () => {
        await expect(order.cancel()).resolves.toBeUndefined();
      });

      // The order was open when its cancelation failed for good: nothing follows it any more
      it('emits ORDER_ERRORED_EVENT with the error message, the order maybe live', async () => {
        const emitSpy = vi.spyOn(order as any, 'emit');
        await order.cancel();
        expect(emitSpy).toHaveBeenCalledWith(ORDER_ERRORED_EVENT, { reason: 'Network error', mayBeLive: true });
      });

      it('sets the status to error', async () => {
        await order.cancel();
        expect((order as any).getStatus()).toBe('error');
      });
    });
  });

  describe('checkOrder', () => {
    beforeEach(() => {
      mockConfig.getWatch.mockReturnValue({ mode: 'realtime', pairs: [{ symbol: 'BTC/USDT' }] });
      fakeExchange.createLimitOrder.mockResolvedValue(defaultOrder);
      order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1, 100, context);
    });

    it('stops checking if order is completed', async () => {
      await order.launch();
      (order as any).handleFetchOrderSuccess({ ...defaultOrder, status: 'closed' });
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      fakeExchange.fetchOrder.mockClear();

      await order.checkOrder();

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
    });

    it('skips if initializing or no id or already checking', async () => {
      // initializing case
      await order.checkOrder();
      expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();

      await order.launch();

      // isChecking case
      (order as any).isChecking = true;
      await order.checkOrder();
      expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
    });

    it('prioritizes cancellation if isCanceling is true', async () => {
      await order.launch();
      (order as any).isCanceling = true;
      fakeExchange.cancelOrder.mockResolvedValue({ ...defaultOrder, status: 'canceled' });

      await order.checkOrder();

      expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', defaultOrderId);
      expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
    });

    it('fetches order and updates state', async () => {
      await order.launch();
      fakeExchange.fetchOrder.mockResolvedValue({
        ...defaultOrder,
        filled: 0.5,
        remaining: 0.5,
      });
      const emitSpy = vi.spyOn(order as any, 'emit');

      await order.checkOrder();

      expect(fakeExchange.fetchOrder).toHaveBeenCalledWith('BTC/USDT', defaultOrderId);
      expect(emitSpy).toHaveBeenCalledWith(ORDER_PARTIALLY_FILLED_EVENT, 0.5);
    });

    describe('on a fetch error', () => {
      beforeEach(async () => {
        await order.launch();
        fakeExchange.fetchOrder.mockRejectedValue(new Error('Fetch failed'));
      });

      it('resolves instead of rejecting', async () => {
        await expect(order.checkOrder()).resolves.toBeUndefined();
      });

      // The order was open when its poll failed for good: nothing follows it any more
      it('emits ORDER_ERRORED_EVENT with the error message, the order maybe live', async () => {
        const emitSpy = vi.spyOn(order as any, 'emit');
        await order.checkOrder();
        expect(emitSpy).toHaveBeenCalledWith(ORDER_ERRORED_EVENT, { reason: 'Fetch failed', mayBeLive: true });
      });

      it('sets the status to error', async () => {
        await order.checkOrder();
        expect((order as any).getStatus()).toBe('error');
      });

      it('releases the check for the next interval tick', async () => {
        await order.checkOrder();
        expect((order as any).isChecking).toBe(false);
      });
    });

    // checkOrder runs in an interval, which ignores its promise: nothing may escape from it, even a failure the handlers missed
    describe.each`
      path        | isCanceling | method
      ${'fetch'}  | ${false}    | ${'fetchOrder'}
      ${'cancel'} | ${true}     | ${'cancel'}
    `('on an unexpected failure of the $path path', ({ isCanceling, method }) => {
      beforeEach(async () => {
        await order.launch();
        (order as any).isCanceling = isCanceling;
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

  // 'error' is final: the order is polled and canceled no more. A failure on the network (ExchangeNetworkError) says nothing of the
  // order, which keeps its status: the next check polls, or cancels, again
  describe('failures in realtime', () => {
    const nextCheck = () => vi.advanceTimersByTimeAsync(1000);
    const listen = (...events: string[]) => {
      const listener = vi.fn();
      events.forEach(event => order.on(event, listener));
      return listener;
    };

    beforeEach(() => {
      mockConfig.getWatch.mockReturnValue({ mode: 'realtime', pairs: [{ symbol: 'BTC/USDT' }] });
      fakeExchange.createLimitOrder.mockResolvedValue(defaultOrder);
      fakeExchange.fetchOrder.mockResolvedValue(defaultOrder);
      fakeExchange.cancelOrder.mockResolvedValue({ ...defaultOrder, status: 'canceled' });
      order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1, 100, context);
    });

    // CCXTExchange throws OrderOutcomeUnknown for a creation it cannot follow: answered with neither a status nor an id, or created and
    // not read back. The read-back's own failure used to reach the order: an InvalidOrder made the order created a refusal
    describe.each`
      failure                                                                                                              | kind
      ${new ExchangeNetworkError('timeout')}                                                                               | ${'fails on the network'}
      ${new OrderOutcomeUnknown('Order 42 was created on hyperliquid for BTC/USDT, but its state could not be read back')} | ${'leaves the order without a state to follow it by'}
    `('when the creation $kind', ({ failure }) => {
      let erroredListener: Mock;

      beforeEach(async () => {
        fakeExchange.createLimitOrder.mockRejectedValue(failure);
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
        expect((order as any).getStatus()).toBe('open');
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
        expect((order as any).isCanceling).toBe(true);
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

    describe('when the cancelation is answered OrderNotFound and the read-back fails on the network', () => {
      let terminalListener: Mock;

      beforeEach(async () => {
        await order.launch();
        fakeExchange.cancelOrder.mockRejectedValueOnce(new OrderNotFound('Unknown order'));
        fakeExchange.fetchOrder.mockRejectedValueOnce(new ExchangeNetworkError('timeout'));
        terminalListener = listen(ORDER_ERRORED_EVENT, ORDER_CANCELED_EVENT, ORDER_COMPLETED_EVENT);
        await order.cancel();
      });

      it('emits no event', () => {
        expect(terminalListener).not.toHaveBeenCalled();
      });

      it('keeps canceling', () => {
        expect((order as any).isCanceling).toBe(true);
      });

      it('sends the cancelation again at the next check', async () => {
        await nextCheck();
        expect(fakeExchange.cancelOrder).toHaveBeenCalledTimes(2);
      });
    });
  });

  // One exchange call at a time: a cancelation is never sent while another call on the order is in flight, and one that has to wait
  // is sent as soon as that call has answered. It ends only with the order: an answer that leaves the order open is not the end.
  describe('cancelation in realtime', () => {
    const nextCheck = () => vi.advanceTimersByTimeAsync(1000);
    let terminalEvents: string[];

    beforeEach(() => {
      mockConfig.getWatch.mockReturnValue({ mode: 'realtime', pairs: [{ symbol: 'BTC/USDT' }] });
      fakeExchange.createLimitOrder.mockResolvedValue(defaultOrder);
      fakeExchange.fetchOrder.mockResolvedValue(defaultOrder);
      fakeExchange.cancelOrder.mockResolvedValue({ ...defaultOrder, status: 'canceled' });
      order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1, 100, context);
      terminalEvents = recordTerminalEvents();
    });

    // A cancelation sent again while the first one is in flight would be answered OrderNotFound, the order being canceled already
    describe('while a cancelation is in flight', () => {
      let cancelation: Deferred<OrderState>;

      beforeEach(async () => {
        await order.launch();
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

    // The exchange has accepted the cancelation without completing it yet: the order is still live
    describe('when the exchange answers the cancelation with the order still open', () => {
      beforeEach(async () => {
        await order.launch();
        fakeExchange.cancelOrder.mockResolvedValueOnce(defaultOrder);
        await order.cancel();
      });

      it('emits no event', () => {
        expect(terminalEvents).toEqual([]);
      });

      it('keeps canceling', () => {
        expect((order as any).isCanceling).toBe(true);
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

    describe('when the cancelation is asked during a poll', () => {
      let poll: Deferred<OrderState>;
      let check: Promise<void>;

      beforeEach(async () => {
        await order.launch();
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
        expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', defaultOrderId);
      });

      it('sends no cancelation when the poll finds the order executed', async () => {
        poll.resolve({ ...defaultOrder, status: 'closed', filled: 1, remaining: 0 });
        await check;
        expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
      });
    });

    // There is no check in backtest: a cancelation asked before the order has an id would never be sent
    describe.each`
      mode
      ${'backtest'}
      ${'realtime'}
    `('when the cancelation is asked during the creation in $mode mode', ({ mode }) => {
      let creation: Deferred<OrderState>;
      let launch: Promise<void>;

      beforeEach(async () => {
        mockConfig.getWatch.mockReturnValue({ mode, pairs: [{ symbol: 'BTC/USDT' }] });
        order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1, 100, context);
        creation = deferred();
        fakeExchange.createLimitOrder.mockReturnValueOnce(creation.promise);
        launch = order.launch();
        await order.cancel();
      });

      it('sends nothing before the order has an id', () => {
        expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
      });

      it('sends the cancelation as soon as the creation has answered', async () => {
        creation.resolve(defaultOrder);
        await launch;
        expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', defaultOrderId);
      });

      it('sends no cancelation when the order is executed at its creation', async () => {
        creation.resolve({ ...defaultOrder, status: 'closed', filled: 1, remaining: 0 });
        await launch;
        expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
      });
    });
  });

  describe('Event Handling & State Updates', () => {
    beforeEach(async () => {
      fakeExchange.createLimitOrder.mockResolvedValue(defaultOrder);
      order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1, 100, context);
      await order.launch();
    });

    it.each`
      status        | event                    | payload
      ${'closed'}   | ${ORDER_COMPLETED_EVENT} | ${{ status: 'filled' }}
      ${'canceled'} | ${ORDER_CANCELED_EVENT}  | ${{ status: 'canceled' }}
    `('handles $status status by emitting $event', ({ status, event, payload }) => {
      const emitSpy = vi.spyOn(order as any, 'emit');
      (order as any).handleFetchOrderSuccess({
        ...defaultOrder,
        status,
        filled: status === 'closed' ? 1 : 0,
      });

      expect(emitSpy).toHaveBeenCalledWith(event, expect.objectContaining(payload));
    });

    // A canceled order is over: a late answer saying it is open does not bring it back
    it('keeps a canceled order canceled when a later update says it is open', () => {
      (order as any).handleFetchOrderSuccess({ ...defaultOrder, status: 'canceled' });
      (order as any).handleFetchOrderSuccess(defaultOrder);
      expect((order as any).getStatus()).toBe('canceled');
    });

    // The trades of the order are fetched from its first timestamp: a later answer, which may carry the time of its last update, or
    // no time at all (read as now), must not move that bound after the fills
    it('fetches the trades of its summary from its creation when a later answer carries another time', async () => {
      fakeExchange.fetchMyTrades.mockResolvedValue([]);
      (order as any).handleFetchOrderSuccess({ ...defaultOrder, status: 'closed', filled: 1, remaining: 0, timestamp: 1_800_000_000_000 });
      await order.createSummary();
      expect(fakeExchange.fetchMyTrades).toHaveBeenCalledWith('BTC/USDT', defaultOrder.timestamp);
    });

    // As for every type of order: the price of the transaction, as the exchange reports it, rather than the price asked for
    it('reports the price of the transaction when it is canceled', () => {
      const listener = vi.fn();
      order.on(ORDER_CANCELED_EVENT, listener);
      (order as any).handleCancelOrderSuccess({ ...defaultOrder, status: 'canceled', price: 99.99 });
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ price: 99.99 }));
    });

    it('ignores update if order id is missing', async () => {
      // Accessing private map to verify no change
      const initialSize = order['transactions'].size;
      (order as any).handleFetchOrderSuccess({ ...defaultOrder, id: undefined });
      expect(order['transactions'].size).toBe(initialSize);
    });
  });

  // What the order filled is the largest fill any of its states reported. It used to relay the answer to its cancelation alone, an
  // amount it left out as 0: a fill an earlier poll had reported was lost, and an answer without its fill read as nothing filled
  describe('what a canceled order reports it filled', () => {
    const cancelAfter = async (creation: Partial<OrderState>, polls: Partial<OrderState>[], cancelation: Partial<OrderState>) => {
      fakeExchange.createLimitOrder.mockResolvedValue({ ...defaultOrder, ...creation });
      order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1, 100, context);
      await order.launch();
      polls.forEach(poll => (order as any).handleFetchOrderSuccess({ ...defaultOrder, ...poll }));
      const listener = vi.fn();
      order.on(ORDER_CANCELED_EVENT, listener);
      fakeExchange.cancelOrder.mockResolvedValue({ ...defaultOrder, status: 'canceled', ...cancelation });
      await order.cancel();
      const [payload] = listener.mock.calls[0] ?? [];
      return { filled: payload?.filled, remaining: payload?.remaining };
    };
    const noFill = { filled: undefined, remaining: undefined };

    it.each`
      kind                                                               | creation  | polls                                | cancelation                        | expected
      ${'a poll reported 0.4, the cancelation answered without it'}      | ${{}}     | ${[{ filled: 0.4, remaining: 0.6 }]} | ${noFill}                          | ${{ filled: 0.4, remaining: 0.6 }}
      ${'a poll reported 0.4, the cancelation 0.7 (1 - 0.7 in decimal)'} | ${{}}     | ${[{ filled: 0.4, remaining: 0.6 }]} | ${{ filled: 0.7, remaining: 0.3 }} | ${{ filled: 0.7, remaining: 0.3 }}
      ${'its creation reported 0, the cancelation nothing'}              | ${{}}     | ${[]}                                | ${noFill}                          | ${{ filled: 0, remaining: 1 }}
      ${'no state reported a fill'}                                      | ${noFill} | ${[]}                                | ${noFill}                          | ${noFill}
    `(
      'reports $expected.filled filled and $expected.remaining remaining when $kind',
      async ({ creation, polls, cancelation, expected }) => {
        expect(await cancelAfter(creation, polls, cancelation)).toEqual(expected);
      },
    );
  });

  // An order that is over stays so: neither the simulated exchange settling it afterwards (the callback given at its creation, in
  // backtest) nor the late answer of a call sent before its end ends it a second time or brings it back to open
  describe('updates after the end of the order', () => {
    const executed: OrderState = { ...defaultOrder, status: 'closed', filled: 1, remaining: 0 };
    // The callback the order gave the simulated exchange at its creation
    const settle = (state: OrderState) => fakeExchange.createLimitOrder.mock.calls[0][4](state);
    const cancel = () => {
      fakeExchange.cancelOrder.mockResolvedValue({ ...defaultOrder, status: 'canceled' });
      return order.cancel();
    };
    const fail = () => {
      fakeExchange.cancelOrder.mockRejectedValue(new Error('Invalid API key'));
      return order.cancel();
    };

    describe.each`
      end           | finish                    | status
      ${'executed'} | ${() => settle(executed)} | ${'filled'}
      ${'canceled'} | ${cancel}                 | ${'canceled'}
      ${'errored'}  | ${fail}                   | ${'error'}
    `('once the order is $end', ({ finish, status }) => {
      let transactions: Transaction[];

      beforeEach(async () => {
        fakeExchange.createLimitOrder.mockResolvedValue(defaultOrder);
        order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1, 100, context);
        await order.launch();
        await finish();
        transactions = structuredClone([...order['transactions'].values()]);
      });

      describe.each`
        update                                          | apply
        ${'the simulated exchange settles it executed'} | ${() => settle(executed)}
        ${'a poll answers it executed'}                 | ${() => (order as any).handleFetchOrderSuccess(executed)}
        ${'a cancelation answers it executed'}          | ${() => (order as any).handleCancelOrderSuccess(executed)}
        ${'a poll answers it open'}                     | ${() => (order as any).handleFetchOrderSuccess(defaultOrder)}
      `('when $update afterwards', ({ apply }) => {
        it('emits nothing', () => {
          const emitSpy = vi.spyOn(order, 'emit');
          apply();
          expect(emitSpy).not.toHaveBeenCalled();
        });

        it(`keeps the order ${status}`, () => {
          apply();
          expect((order as any).getStatus()).toBe(status);
        });

        it('leaves its transaction as it was', () => {
          apply();
          expect([...order['transactions'].values()]).toEqual(transactions);
        });
      });
    });
  });

  describe('Error Handling Edge Cases', () => {
    describe.each`
      handler                     | kind                                      | value                         | message
      ${'handleCreateOrderError'} | ${'an Error'}                             | ${new Error('Exchange down')} | ${'Exchange down'}
      ${'handleCreateOrderError'} | ${'a non-Error value'}                    | ${'some string error'}        | ${'some string error'}
      ${'handleCancelOrderError'} | ${'an Error'}                             | ${new Error('Exchange down')} | ${'Exchange down'}
      ${'handleCancelOrderError'} | ${'a non-Error value'}                    | ${'some string error'}        | ${'some string error'}
      ${'handleCancelOrderError'} | ${'an OrderNotFound before the order id'} | ${new OrderNotFound('gone')}  | ${'gone'}
      ${'handleFetchOrderError'}  | ${'an Error'}                             | ${new Error('Exchange down')} | ${'Exchange down'}
      ${'handleFetchOrderError'}  | ${'a non-Error value'}                    | ${'some string error'}        | ${'some string error'}
    `('$handler given $kind', ({ handler, value, message }) => {
      beforeEach(() => {
        order = new LimitOrder('BTC/USDT', defaultGekkoId, 'BUY', 1, 100, context);
      });

      it('does not throw', () => {
        expect(() => (order as any)[handler](value)).not.toThrow();
      });

      it('emits ORDER_ERRORED_EVENT with the error message', () => {
        const emitSpy = vi.spyOn(order as any, 'emit');
        (order as any)[handler](value);
        expect(emitSpy).toHaveBeenCalledWith(ORDER_ERRORED_EVENT, expect.objectContaining({ reason: message }));
      });

      it('sets the status to error', () => {
        (order as any)[handler](value);
        expect((order as any).getStatus()).toBe('error');
      });
    });
  });
});
