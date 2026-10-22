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
import { OrderSide, OrderState } from '@gekko/shared/models/order.types';
import { ExchangeNetworkError, InvalidOrder, OrderNotFound, OrderOutcomeUnknown } from '../../../exchange/exchange.error';
import * as Logger from '../../../logger/logger';
import { createRunContextMock } from '../../../run/runContext.mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Transaction } from '../order.types';
import { MarketOrder } from './marketOrder';

vi.mock('../../../logger/logger', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

const fakeExchange = {
  createMarketOrder: vi.fn(),
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

describe('MarketOrder', () => {
  let order: MarketOrder;
  const orderId = 'ee21e130-48bc-405f-be0c-46e9bf17b52e';
  const side: OrderSide = 'BUY';
  const amount = 1;
  const open: OrderState = { id: 'ex-1', status: 'open', filled: 0, remaining: 1, timestamp: 1000 };
  const executed: OrderState = { ...open, status: 'closed', filled: 1, remaining: 0, timestamp: 2000 };
  const canceled: OrderState = { ...open, status: 'canceled', timestamp: 2000 };

  const setMode = (mode: 'backtest' | 'realtime') => mockConfig.getWatch.mockReturnValue({ mode, pairs: [{ symbol: 'BTC/USDT' }] });
  // The next check of an order polled in realtime, every orderSynchInterval
  const nextCheck = () => vi.advanceTimersByTimeAsync(1000);
  // The terminal events of the order, in the order it emits them
  const recordTerminalEvents = () => {
    const events: string[] = [];
    [ORDER_COMPLETED_EVENT, ORDER_CANCELED_EVENT, ORDER_ERRORED_EVENT].forEach(event => order.on(event, () => events.push(event)));
    return events;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    setMode('backtest');
    mockConfig.getExchange.mockReturnValue({ orderSynchInterval: 1000 });
    order = new MarketOrder('BTC/USDT', orderId, side, amount, undefined, context);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('launch', () => {
    it('should call exchange.createMarketOrder with correct parameters', async () => {
      fakeExchange.createMarketOrder.mockResolvedValue({
        id: 'ex-1',
        status: 'open',
        timestamp: 1000,
        filled: 0,
        remaining: 1,
      });

      await order.launch();

      expect(fakeExchange.createMarketOrder).toHaveBeenCalledWith('BTC/USDT', side, amount);
    });

    it('should handle successful order creation (open)', async () => {
      fakeExchange.createMarketOrder.mockResolvedValue({
        id: 'ex-1',
        status: 'open',
        timestamp: 1000,
        filled: 0,
        remaining: 1,
      });

      const spyEmit = vi.spyOn(order, 'emit');

      await order.launch();

      expect(spyEmit).toHaveBeenCalledWith(ORDER_STATUS_CHANGED_EVENT, { status: 'open', reason: undefined });
    });
  });

  describe('handleCreateOrderError', () => {
    // Both exchanges throw OrderOutOfRangeError before sending the order: a SELL of an empty balance (amount 0), a BUY under the
    // minimum notional. InvalidOrder is the exchange refusing it: unknown pair, insufficient balance, malformed request.
    describe.each`
      kind                                    | rejection
      ${'an InvalidOrder'}                    | ${new InvalidOrder('invalid order parameters')}
      ${'an OrderOutOfRangeError (amount 0)'} | ${new OrderOutOfRangeError('exchange', 'amount', 0, 0.00001, 9000)}
      ${'an OrderOutOfRangeError (low cost)'} | ${new OrderOutOfRangeError('exchange', 'cost', 1, 5)}
    `('when the creation rejects with $kind', ({ rejection }) => {
      beforeEach(() => {
        fakeExchange.createMarketOrder.mockRejectedValue(rejection);
      });

      it('should emit ORDER_INVALID_EVENT with the error message as reason', async () => {
        const spyEmit = vi.spyOn(order, 'emit');
        await order.launch();
        expect(spyEmit).toHaveBeenCalledWith(ORDER_INVALID_EVENT, { status: 'rejected', filled: false, reason: rejection.untaggedMessage });
      });

      it('should set the status to rejected', async () => {
        await order.launch();
        expect((order as any).getStatus()).toBe('rejected');
      });

      it('should not emit ORDER_ERRORED_EVENT', async () => {
        const spyEmit = vi.spyOn(order, 'emit');
        await order.launch();
        expect(spyEmit).not.toHaveBeenCalledWith(ORDER_ERRORED_EVENT, expect.anything());
      });
    });

    // A creation is never sent twice: after a failure on the network its outcome is unknown, and so it is once the exchange created the
    // order without anything to follow it by (OrderOutcomeUnknown). The reason says so, and the order may be live; any other failure
    // placed nothing
    const outcomeUnknown = (failure: string) =>
      `Outcome unknown: the order may be live on the exchange, check it before placing it again (${failure})`;
    const notReadBack = 'Order 42 was created on hyperliquid for BTC/USDT, but its state could not be read back: timeout';
    describe.each`
      kind                         | rejection                                           | message                        | mayBeLive
      ${'an Error'}                | ${new Error('Network error')}                       | ${'Network error'}             | ${false}
      ${'a GekkoError'}            | ${new GekkoError('exchange', 'Unexpected failure')} | ${'Unexpected failure'}        | ${false}
      ${'a non-Error value'}       | ${'some string error'}                              | ${'some string error'}         | ${false}
      ${'an ExchangeNetworkError'} | ${new ExchangeNetworkError('timeout')}              | ${outcomeUnknown('timeout')}   | ${true}
      ${'an OrderOutcomeUnknown'}  | ${new OrderOutcomeUnknown(notReadBack)}             | ${outcomeUnknown(notReadBack)} | ${true}
    `('when the creation rejects with $kind', ({ rejection, message, mayBeLive }) => {
      beforeEach(() => {
        fakeExchange.createMarketOrder.mockRejectedValue(rejection);
      });

      it('should resolve instead of rejecting', async () => {
        await expect(order.launch()).resolves.toBeUndefined();
      });

      it(`should emit ORDER_ERRORED_EVENT with the error message, mayBeLive ${mayBeLive}`, async () => {
        const spyEmit = vi.spyOn(order, 'emit');
        await order.launch();
        expect(spyEmit).toHaveBeenCalledWith(ORDER_ERRORED_EVENT, { reason: message, mayBeLive });
      });

      it('should set the status to error', async () => {
        await order.launch();
        expect((order as any).getStatus()).toBe('error');
      });

      it('should not emit ORDER_INVALID_EVENT', async () => {
        const spyEmit = vi.spyOn(order, 'emit');
        await order.launch();
        expect(spyEmit).not.toHaveBeenCalledWith(ORDER_INVALID_EVENT, expect.anything());
      });
    });
  });

  describe('cancel', () => {
    it('should send nothing before the order has an id', async () => {
      await order.cancel();
      expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
    });

    it('should do nothing if isOrderCompleted returns true', async () => {
      // Simulate completed order
      fakeExchange.createMarketOrder.mockResolvedValue({
        id: 'ex-1',
        status: 'closed',
        filled: 1,
        remaining: 0,
        timestamp: 1000,
      });
      await order.launch(); // Order becomes 'filled' (completed)

      await order.cancel();

      expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
    });

    it('should call exchange.cancelOrder if order is active and has ID', async () => {
      fakeExchange.createMarketOrder.mockResolvedValue({
        id: 'ex-1',
        status: 'open',
        filled: 0,
        remaining: 1,
        timestamp: 1000,
      });
      await order.launch(); // Order is open

      fakeExchange.cancelOrder.mockResolvedValue({
        id: 'ex-1',
        status: 'canceled',
        filled: 0,
        remaining: 1,
        timestamp: 2000,
      });

      await order.cancel();

      expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', 'ex-1');
    });
  });

  describe('handleCancelOrderError', () => {
    beforeEach(async () => {
      // Setup an open order to cancel
      fakeExchange.createMarketOrder.mockResolvedValue({
        id: 'ex-1',
        status: 'open',
        filled: 0,
        remaining: 1,
        timestamp: 1000,
      });
      await order.launch();
    });

    describe.each`
      kind                   | rejection                     | message
      ${'an Error'}          | ${new Error('Cancel failed')} | ${'Cancel failed'}
      ${'a non-Error value'} | ${'string error'}             | ${'string error'}
    `('when the cancelation rejects with $kind', ({ rejection, message }) => {
      beforeEach(() => {
        fakeExchange.cancelOrder.mockRejectedValue(rejection);
      });

      it('should resolve instead of rejecting', async () => {
        await expect(order.cancel()).resolves.toBeUndefined();
      });

      // Open when its cancelation failed for good, it may still be live: nothing follows it any more
      it('should emit ORDER_ERRORED_EVENT with the error message, the order maybe live', async () => {
        const spyEmit = vi.spyOn(order, 'emit');
        await order.cancel();
        expect(spyEmit).toHaveBeenCalledWith(ORDER_ERRORED_EVENT, { reason: message, mayBeLive: true });
      });

      it('should set the status to error', async () => {
        await order.cancel();
        expect((order as any).getStatus()).toBe('error');
      });

      it('should send no cancelation once errored', async () => {
        await order.cancel();
        await order.cancel();
        expect(fakeExchange.cancelOrder).toHaveBeenCalledOnce();
      });
    });

    // A failure on the network says nothing of the order: it keeps its status
    describe('when the cancelation fails on the network', () => {
      beforeEach(() => {
        fakeExchange.cancelOrder.mockRejectedValue(new ExchangeNetworkError('timeout'));
      });

      it('should not emit ORDER_ERRORED_EVENT', async () => {
        const spyEmit = vi.spyOn(order, 'emit');
        await order.cancel();
        expect(spyEmit).not.toHaveBeenCalledWith(ORDER_ERRORED_EVENT, expect.anything());
      });

      it('should keep the order open', async () => {
        await order.cancel();
        expect((order as any).getStatus()).toBe('open');
      });

      it('should log a warning', async () => {
        await order.cancel();
        expect(Logger.warning).toHaveBeenCalledWith('order', expect.stringContaining('cancelation failed on the network, it stays open'));
      });
    });
  });

  // A market order is executed at its creation. One the exchange answers still open (not matched yet, its fill not reported yet, a
  // status unknown to Gekko) is polled until it ends, as a limit order is: the strategy waits for the end of every order it created
  describe('polling in realtime', () => {
    let terminalEvents: string[];

    beforeEach(() => {
      setMode('realtime');
      fakeExchange.fetchOrder.mockResolvedValue(open);
      order = new MarketOrder('BTC/USDT', orderId, side, amount, undefined, context);
      terminalEvents = recordTerminalEvents();
    });

    describe('when the creation answers the order executed', () => {
      beforeEach(async () => {
        fakeExchange.createMarketOrder.mockResolvedValue(executed);
        await order.launch();
      });

      it('emits ORDER_COMPLETED_EVENT alone', () => {
        expect(terminalEvents).toEqual([ORDER_COMPLETED_EVENT]);
      });

      it('starts no interval', () => {
        expect(vi.getTimerCount()).toBe(0);
      });

      it('never polls the order', async () => {
        await nextCheck();
        expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
      });

      it('logs no warning', () => {
        expect(Logger.warning).not.toHaveBeenCalled();
      });
    });

    describe('when the creation answers the order open', () => {
      beforeEach(async () => {
        fakeExchange.createMarketOrder.mockResolvedValue(open);
        await order.launch();
      });

      it('logs a warning', () => {
        expect(Logger.warning).toHaveBeenCalledWith('order', expect.stringContaining('BUY MARKET order still open after its creation'));
      });

      it('emits no terminal event yet', () => {
        expect(terminalEvents).toEqual([]);
      });

      it('polls nothing before orderSynchInterval has elapsed', async () => {
        await vi.advanceTimersByTimeAsync(999);
        expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
      });

      it('polls the order at the next check', async () => {
        await nextCheck();
        expect(fakeExchange.fetchOrder).toHaveBeenCalledWith('BTC/USDT', 'ex-1');
      });

      it('polls it again while it stays open', async () => {
        await nextCheck();
        await nextCheck();
        expect(fakeExchange.fetchOrder).toHaveBeenCalledTimes(2);
      });

      describe.each`
        found         | state       | event
        ${'executed'} | ${executed} | ${ORDER_COMPLETED_EVENT}
        ${'canceled'} | ${canceled} | ${ORDER_CANCELED_EVENT}
      `('when a poll finds it $found', ({ state, event }) => {
        beforeEach(async () => {
          fakeExchange.fetchOrder.mockResolvedValue(state);
          await nextCheck();
        });

        it(`emits ${event} alone`, () => {
          expect(terminalEvents).toEqual([event]);
        });

        it('clears the interval polling the order', () => {
          expect(vi.getTimerCount()).toBe(0);
        });
      });

      describe('when a poll fails on the network', () => {
        beforeEach(async () => {
          fakeExchange.fetchOrder.mockRejectedValueOnce(new ExchangeNetworkError('timeout'));
          await nextCheck();
        });

        it('keeps the order open', () => {
          expect((order as any).getStatus()).toBe('open');
        });

        it('emits no terminal event', () => {
          expect(terminalEvents).toEqual([]);
        });

        it('polls again at the next check', async () => {
          await nextCheck();
          expect(fakeExchange.fetchOrder).toHaveBeenCalledTimes(2);
        });
      });

      describe('when a poll fails for good', () => {
        beforeEach(async () => {
          fakeExchange.fetchOrder.mockRejectedValue(new Error('Invalid API key'));
          await nextCheck();
        });

        it('emits ORDER_ERRORED_EVENT alone', () => {
          expect(terminalEvents).toEqual([ORDER_ERRORED_EVENT]);
        });

        it('clears the interval polling the order', () => {
          expect(vi.getTimerCount()).toBe(0);
        });
      });

      // The exchange expires what the book did not fill, and may answer that without the fill: what an earlier poll reported is kept.
      // The order used to relay that answer alone, its missing amounts as 0, which a strategy read as nothing executed
      it('reports the fill an earlier poll saw once a poll finds it expired, answered without its fill', async () => {
        const listener = vi.fn();
        order.on(ORDER_CANCELED_EVENT, listener);
        fakeExchange.fetchOrder.mockResolvedValueOnce({ ...open, filled: 0.4, remaining: 0.6 });
        await nextCheck();
        fakeExchange.fetchOrder.mockResolvedValueOnce({ id: 'ex-1', status: 'canceled', timestamp: 3000 });
        await nextCheck();
        expect(listener.mock.calls).toEqual([[{ status: 'canceled', filled: 0.4, remaining: 0.6, timestamp: 3000 }]]);
      });
    });
  });

  // One exchange call at a time: a cancelation is never sent while another call on the order is in flight, and one that has to wait
  // is sent as soon as that call has answered. It ends only with the order: an answer that leaves the order open, or a failure on the
  // network, is not the end, and the next check sends the cancelation again.
  describe('cancelation in realtime', () => {
    let terminalEvents: string[];

    beforeEach(async () => {
      setMode('realtime');
      fakeExchange.createMarketOrder.mockResolvedValue(open);
      fakeExchange.fetchOrder.mockResolvedValue(open);
      fakeExchange.cancelOrder.mockResolvedValue(canceled);
      order = new MarketOrder('BTC/USDT', orderId, side, amount, undefined, context);
      terminalEvents = recordTerminalEvents();
      await order.launch();
    });

    describe('when the cancelation goes through', () => {
      beforeEach(async () => {
        await order.cancel();
      });

      it('sends the cancelation', () => {
        expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', 'ex-1');
      });

      it('emits ORDER_CANCELED_EVENT alone', () => {
        expect(terminalEvents).toEqual([ORDER_CANCELED_EVENT]);
      });

      it('clears the interval polling the order', () => {
        expect(vi.getTimerCount()).toBe(0);
      });

      it('sends no second cancelation when canceled again', async () => {
        await order.cancel();
        expect(fakeExchange.cancelOrder).toHaveBeenCalledOnce();
      });
    });

    describe('when the cancelation fails on the network', () => {
      beforeEach(async () => {
        fakeExchange.cancelOrder.mockRejectedValueOnce(new ExchangeNetworkError('timeout'));
        await order.cancel();
      });

      it('emits no terminal event', () => {
        expect(terminalEvents).toEqual([]);
      });

      it('keeps polling', () => {
        expect(vi.getTimerCount()).toBe(1);
      });

      it('sends the cancelation again at the next check', async () => {
        await nextCheck();
        expect(fakeExchange.cancelOrder).toHaveBeenCalledTimes(2);
      });

      it('does not poll the order while canceling it', async () => {
        await nextCheck();
        expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
      });

      it('is canceled once the cancelation sent again goes through', async () => {
        await nextCheck();
        expect(terminalEvents).toEqual([ORDER_CANCELED_EVENT]);
      });
    });

    // The exchange has accepted the cancelation without completing it yet: the order is still live
    describe('when the exchange answers the cancelation with the order still open', () => {
      beforeEach(async () => {
        fakeExchange.cancelOrder.mockResolvedValueOnce(open);
        await order.cancel();
      });

      it('emits no terminal event', () => {
        expect(terminalEvents).toEqual([]);
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
      readBack            | fetched                               | event
      ${'executed'}       | ${executed}                           | ${ORDER_COMPLETED_EVENT}
      ${'canceled'}       | ${canceled}                           | ${ORDER_CANCELED_EVENT}
      ${'not found, too'} | ${new OrderNotFound('Unknown order')} | ${ORDER_ERRORED_EVENT}
    `('when the cancelation is answered OrderNotFound and the order read back is $readBack', ({ fetched, event }) => {
      beforeEach(async () => {
        fakeExchange.cancelOrder.mockRejectedValue(new OrderNotFound('Unknown order'));
        if (fetched instanceof Error) fakeExchange.fetchOrder.mockRejectedValue(fetched);
        else fakeExchange.fetchOrder.mockResolvedValue(fetched);
        await order.cancel();
      });

      it('reads the order back', () => {
        expect(fakeExchange.fetchOrder).toHaveBeenCalledWith('BTC/USDT', 'ex-1');
      });

      it(`emits ${event} alone`, () => {
        expect(terminalEvents).toEqual([event]);
      });

      it('clears the interval polling the order', () => {
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    describe('when the cancelation is answered OrderNotFound and the read-back fails on the network', () => {
      beforeEach(async () => {
        fakeExchange.cancelOrder.mockRejectedValueOnce(new OrderNotFound('Unknown order'));
        fakeExchange.fetchOrder.mockRejectedValueOnce(new ExchangeNetworkError('timeout'));
        await order.cancel();
      });

      it('emits no terminal event', () => {
        expect(terminalEvents).toEqual([]);
      });

      it('sends the cancelation again at the next check', async () => {
        await nextCheck();
        expect(fakeExchange.cancelOrder).toHaveBeenCalledTimes(2);
      });
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

      it('is canceled once, when the cancelation goes through', async () => {
        await order.cancel();
        await nextCheck();
        cancelation.resolve(canceled);
        await nextCheck();
        expect(terminalEvents).toEqual([ORDER_CANCELED_EVENT]);
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
        poll.resolve(open);
        await check;
        expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', 'ex-1');
      });

      it('sends no cancelation when the poll finds the order executed', async () => {
        poll.resolve(executed);
        await check;
        expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
      });
    });
  });

  // Before the creation has answered, the order has no id to cancel: the cancelation waits for it, then is sent at once (there is no
  // check in backtest to send it later)
  describe.each`
    mode
    ${'backtest'}
    ${'realtime'}
  `('when the cancelation is asked during the creation in $mode mode', ({ mode }) => {
    let creation: Deferred<OrderState>;
    let launch: Promise<void>;

    beforeEach(async () => {
      setMode(mode);
      fakeExchange.cancelOrder.mockResolvedValue(canceled);
      order = new MarketOrder('BTC/USDT', orderId, side, amount, undefined, context);
      creation = deferred();
      fakeExchange.createMarketOrder.mockReturnValueOnce(creation.promise);
      launch = order.launch();
      await order.cancel();
    });

    it('sends nothing before the order has an id', () => {
      expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
    });

    it('sends the cancelation as soon as the creation has answered', async () => {
      creation.resolve(open);
      await launch;
      expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', 'ex-1');
    });

    it('sends no cancelation when the order is executed at its creation', async () => {
      creation.resolve(executed);
      await launch;
      expect(fakeExchange.cancelOrder).not.toHaveBeenCalled();
    });
  });

  // The simulated exchange executes a market order at its creation: nothing polls a market order in backtest
  describe('in backtest', () => {
    it.each`
      answer        | state
      ${'executed'} | ${executed}
      ${'open'}     | ${open}
    `('starts no interval when the creation answers the order $answer', async ({ state }) => {
      fakeExchange.createMarketOrder.mockResolvedValue(state);
      await order.launch();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // What the interval runs, with the guards of a limit order
  describe('checkOrder', () => {
    beforeEach(() => {
      setMode('realtime');
      fakeExchange.createMarketOrder.mockResolvedValue(open);
      fakeExchange.fetchOrder.mockResolvedValue(open);
      fakeExchange.cancelOrder.mockResolvedValue(canceled);
      order = new MarketOrder('BTC/USDT', orderId, side, amount, undefined, context);
    });

    it('polls nothing before the creation has answered', async () => {
      await order.checkOrder();
      expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
    });

    // A status Gekko does not know leaves the order initializing (see applyOrderUpdate)
    it('polls nothing while the order is initializing', async () => {
      fakeExchange.createMarketOrder.mockResolvedValue({ ...open, status: undefined });
      await order.launch();
      await order.checkOrder();
      expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
    });

    it('polls nothing while another call on the order is in flight', async () => {
      await order.launch();
      order['isChecking'] = true;
      await order.checkOrder();
      expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
    });

    it('polls the order otherwise', async () => {
      await order.launch();
      await order.checkOrder();
      expect(fakeExchange.fetchOrder).toHaveBeenCalledWith('BTC/USDT', 'ex-1');
    });

    it('sends the cancelation instead of polling when the order is canceling', async () => {
      await order.launch();
      order['isCanceling'] = true;
      await order.checkOrder();
      expect(fakeExchange.cancelOrder).toHaveBeenCalledWith('BTC/USDT', 'ex-1');
    });

    // Every end of a market order clears its interval: the check clears it too, should one be missed
    describe('once the order is over', () => {
      beforeEach(async () => {
        await order.launch();
        order['setStatus']('filled');
        await order.checkOrder();
      });

      it('clears the interval polling the order', () => {
        expect(vi.getTimerCount()).toBe(0);
      });

      it('polls it no more', () => {
        expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
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
        order['isCanceling'] = isCanceling;
        vi.spyOn(order as any, method).mockRejectedValue(new Error('unexpected failure'));
      });

      it('resolves instead of rejecting', async () => {
        await expect(order.checkOrder()).resolves.toBeUndefined();
      });

      it('logs the failure', async () => {
        await order.checkOrder();
        expect(Logger.error).toHaveBeenCalledWith('order', expect.stringContaining('order check failed: unexpected failure'));
      });
    });
  });

  describe('Handlers Coverage', () => {
    // These methods are protected/inherited but we want to ensure coverage of MarketOrder specific implementation
    // Using cast to any to access protected methods for direct testing of specific flows

    it('should handle fetch success via handleFetchOrderSuccess', () => {
      const spyApply = vi.spyOn(order as any, 'applyOrderUpdate');
      const orderState: OrderState = { id: 'ex-1', status: 'open', timestamp: 1000 };

      (order as any).handleFetchOrderSuccess(orderState);

      expect(spyApply).toHaveBeenCalledWith(orderState);
    });

    describe.each`
      kind                   | value                        | message
      ${'an Error'}          | ${new Error('Fetch failed')} | ${'Fetch failed'}
      ${'a non-Error value'} | ${'string error'}            | ${'string error'}
    `('when handleFetchOrderError is given $kind', ({ value, message }) => {
      it('should not throw', () => {
        expect(() => (order as any).handleFetchOrderError(value)).not.toThrow();
      });

      it('should emit ORDER_ERRORED_EVENT with the error message', () => {
        const spyEmit = vi.spyOn(order, 'emit');
        (order as any).handleFetchOrderError(value);
        expect(spyEmit).toHaveBeenCalledWith(ORDER_ERRORED_EVENT, expect.objectContaining({ reason: message }));
      });

      it('should set the status to error', () => {
        (order as any).handleFetchOrderError(value);
        expect((order as any).getStatus()).toBe('error');
      });
    });

    describe('when handleFetchOrderError is given an ExchangeNetworkError', () => {
      it('should not emit ORDER_ERRORED_EVENT', () => {
        const spyEmit = vi.spyOn(order, 'emit');
        (order as any).handleFetchOrderError(new ExchangeNetworkError('timeout'));
        expect(spyEmit).not.toHaveBeenCalledWith(ORDER_ERRORED_EVENT, expect.anything());
      });

      it('should keep the status', () => {
        (order as any).handleFetchOrderError(new ExchangeNetworkError('timeout'));
        expect((order as any).getStatus()).toBe('initializing');
      });
    });

    // An order without an id has nothing to read back
    describe('when handleCancelOrderError is given an OrderNotFound before the order has an id', () => {
      it('should emit ORDER_ERRORED_EVENT with the error message', () => {
        const spyEmit = vi.spyOn(order, 'emit');
        (order as any).handleCancelOrderError(new OrderNotFound('gone'));
        expect(spyEmit).toHaveBeenCalledWith(ORDER_ERRORED_EVENT, expect.objectContaining({ reason: 'gone' }));
      });

      it('should not read the order back', () => {
        (order as any).handleCancelOrderError(new OrderNotFound('gone'));
        expect(fakeExchange.fetchOrder).not.toHaveBeenCalled();
      });
    });

    it('should handle create error via handleCreateOrderSuccess', () => {
      // already covered in launch, but ensuring direct call works too
      const spyApply = vi.spyOn(order as any, 'applyOrderUpdate');
      const orderState: OrderState = { id: 'ex-1', status: 'open', timestamp: 1000 };

      (order as any).handleCreateOrderSuccess(orderState);

      expect(spyApply).toHaveBeenCalledWith(orderState);
    });

    it('should handle cancel success via handleCancelOrderSuccess', () => {
      const spyApply = vi.spyOn(order as any, 'applyOrderUpdate');
      const orderState: OrderState = { id: 'ex-1', status: 'canceled', timestamp: 1000 };

      (order as any).handleCancelOrderSuccess(orderState);

      expect(spyApply).toHaveBeenCalledWith(orderState);
    });
  });

  describe('applyOrderUpdate logic', () => {
    // We can test this by triggering an event that calls applyOrderUpdate, e.g. handleFetchOrderSuccess

    it('should return early if order has no ID', () => {
      const spyEmit = vi.spyOn(order, 'emit');
      (order as any).applyOrderUpdate({ status: 'open', timestamp: 1000 } as OrderState); // No ID
      expect(spyEmit).not.toHaveBeenCalled();
    });

    it('should emit ORDER_PARTIALLY_FILLED_EVENT if filled > 0', () => {
      const spyEmit = vi.spyOn(order, 'emit');
      (order as any).applyOrderUpdate({ id: 'ex-1', status: 'open', filled: 0.5, timestamp: 1000 } as OrderState);
      expect(spyEmit).toHaveBeenCalledWith(ORDER_PARTIALLY_FILLED_EVENT, 0.5);
    });

    it.each`
      status        | expectedEvent            | payload
      ${'closed'}   | ${ORDER_COMPLETED_EVENT} | ${{ status: 'filled', filled: true }}
      ${'canceled'} | ${ORDER_CANCELED_EVENT}  | ${{ status: 'canceled', filled: 0, remaining: 1, timestamp: 1000 }}
    `('should emit $expectedEvent when status is $status', ({ status, expectedEvent, payload }) => {
      const spyEmit = vi.spyOn(order, 'emit');
      const orderState = { id: 'ex-1', status, filled: 0, remaining: 1, timestamp: 1000 };

      (order as any).applyOrderUpdate(orderState);

      expect(spyEmit).toHaveBeenCalledWith(expectedEvent, expect.objectContaining(payload));
    });

    it('should emit ORDER_STATUS_CHANGED_EVENT only if status changed for open orders', () => {
      // First update sets it to open
      (order as any).applyOrderUpdate({ id: 'ex-1', status: 'open', timestamp: 1000 });
      const spyEmit = vi.spyOn(order, 'emit');
      spyEmit.mockClear();

      // Second update same status
      (order as any).applyOrderUpdate({ id: 'ex-1', status: 'open', timestamp: 1001 });
      expect(spyEmit).not.toHaveBeenCalledWith(ORDER_STATUS_CHANGED_EVENT, expect.anything());

      // Third update changes status (not possible for 'open' really unless re-opening, but technically possible flow)
      // Let's manually manipulate internal state to 'completed' and back to 'open' to see change?
      // Or better, initializing -> open (happens once). Open -> Open (no emit).
    });

    // As for every type of order: the price of the transaction, when the exchange reports it
    it('should report the price of the transaction when it is canceled', () => {
      const spyEmit = vi.spyOn(order, 'emit');
      (order as any).applyOrderUpdate({ ...canceled, price: 100.5 });
      expect(spyEmit).toHaveBeenCalledWith(ORDER_CANCELED_EVENT, expect.objectContaining({ price: 100.5 }));
    });
  });

  // An order that is over stays so: the late answer of a call sent before its end neither ends it a second time nor brings it back
  // to open
  describe('updates after the end of the order', () => {
    const execute = () => {
      fakeExchange.createMarketOrder.mockResolvedValue(executed);
      return order.launch();
    };
    const cancel = async () => {
      fakeExchange.createMarketOrder.mockResolvedValue(open);
      fakeExchange.cancelOrder.mockResolvedValue(canceled);
      await order.launch();
      await order.cancel();
    };
    const fail = async () => {
      fakeExchange.createMarketOrder.mockResolvedValue(open);
      fakeExchange.cancelOrder.mockRejectedValue(new Error('Invalid API key'));
      await order.launch();
      await order.cancel();
    };

    describe.each`
      end           | finish     | status
      ${'executed'} | ${execute} | ${'filled'}
      ${'canceled'} | ${cancel}  | ${'canceled'}
      ${'errored'}  | ${fail}    | ${'error'}
    `('once the order is $end', ({ finish, status }) => {
      let transactions: Transaction[];

      beforeEach(async () => {
        await finish();
        transactions = structuredClone([...order['transactions'].values()]);
      });

      describe.each`
        update                                 | apply
        ${'a poll answers it executed'}        | ${() => (order as any).handleFetchOrderSuccess(executed)}
        ${'a cancelation answers it executed'} | ${() => (order as any).handleCancelOrderSuccess(executed)}
        ${'a poll answers it open'}            | ${() => (order as any).handleFetchOrderSuccess(open)}
      `('when $update afterwards', ({ apply }) => {
        it('emits nothing', () => {
          const spyEmit = vi.spyOn(order, 'emit');
          apply();
          expect(spyEmit).not.toHaveBeenCalled();
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

  describe('createSummary', () => {
    it('should throw GekkoError if order is not completed', async () => {
      await expect(order.createSummary()).rejects.toThrow(GekkoError);
    });

    // An errored order is over, but what it executed is unknown
    it('should throw GekkoError if order errored', async () => {
      fakeExchange.createMarketOrder.mockRejectedValue(new Error('Invalid API key'));
      await order.launch();
      await expect(order.createSummary()).rejects.toThrow('order is not completed');
    });

    it('should return summary if order is completed', async () => {
      // Complete the order
      fakeExchange.createMarketOrder.mockResolvedValue({
        id: 'ex-1',
        status: 'closed',
        filled: 1,
        remaining: 0,
        timestamp: 1000,
      });
      fakeExchange.fetchMyTrades.mockResolvedValue([
        { id: 'ex-1', order: 'ex-1', amount: 1, price: 100, fee: { cost: 1, currency: 'USD' }, timestamp: 1000 },
      ]);

      await order.launch();

      const summary = await order.createSummary();

      expect(summary).toBeDefined();
      expect(summary.side).toBe(side);
    });

    // The trades of the order are fetched from its first timestamp: the answer to a cancelation may carry the time of the
    // cancelation, or no time at all (read as now), after the fills
    it('should fetch the trades from the creation when the answer to the cancelation carries another time', async () => {
      fakeExchange.createMarketOrder.mockResolvedValue({ id: 'ex-1', status: 'open', filled: 0.4, remaining: 0.6, timestamp: 1000 });
      fakeExchange.cancelOrder.mockResolvedValue({ id: 'ex-1', status: 'canceled', filled: 0.4, remaining: 0.6, timestamp: 5000 });
      fakeExchange.fetchMyTrades.mockResolvedValue([]);
      await order.launch();
      await order.cancel();

      await order.createSummary();

      expect(fakeExchange.fetchMyTrades).toHaveBeenCalledWith('BTC/USDT', 1000);
    });
  });
});
