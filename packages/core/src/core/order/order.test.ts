import {
  ORDER_CANCELED_EVENT,
  ORDER_COMPLETED_EVENT,
  ORDER_ERRORED_EVENT,
  ORDER_INVALID_EVENT,
  ORDER_PARTIALLY_FILLED_EVENT,
  ORDER_STATUS_CHANGED_EVENT,
} from '@gekko/shared/constants/event.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { OrderState } from '@gekko/shared/models/order.types';
import { ExchangeNetworkError, OrderNotFound, OrderOutcomeUnknown } from '../../exchange/exchange.error';
import * as logger from '../../logger/logger';
import type { Mock, MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Order } from './order';

vi.mock('../../logger/logger', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../configuration/configuration', () => ({
  config: {
    getWatch: () => ({ mode: 'backtest', pairs: [{ symbol: 'BTC/USDT' }] }),
  },
}));

const fakeExchange = {
  createLimitOrder: vi.fn(),
  createMarketOrder: vi.fn(),
  cancelOrder: vi.fn(),
  fetchOrder: vi.fn(),
  fetchTicker: vi.fn(),
  getInterval: vi.fn(() => 50),
};

vi.mock('../../injecter/injecter', () => ({
  inject: {
    exchange: () => fakeExchange,
  },
}));

class TestOrder extends Order {
  public handleCancelOrderSuccess = vi.fn();
  public handleCancelOrderError = vi.fn();
  public handleCreateOrderSuccess = vi.fn();
  public handleCreateOrderError = vi.fn();
  public handleFetchOrderSuccess = vi.fn();
  public handleFetchOrderError = vi.fn();
  public cancel = vi.fn();
  public createSummary = vi.fn();
  public checkOrder = vi.fn();
  public launch = vi.fn();
}

describe('order', () => {
  let testOrder: TestOrder;

  beforeEach(() => {
    Object.values(fakeExchange).forEach(value => {
      if (typeof value === 'function') value.mockReset?.();
    });
    testOrder = new TestOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', 'STICKY', 10);
  });

  it('should have status "initializing" upon creation', () => {
    expect(testOrder['getStatus']()).toBe('initializing');
  });

  it('should return the id the strategy gave the order', () => {
    expect(testOrder.getGekkoOrderId()).toBe('ee21e130-48bc-405f-be0c-46e9bf17b52e');
  });

  describe('setStatus', () => {
    it('should update status when setStatus is called', () => {
      testOrder['setStatus']('open');
      expect(testOrder['getStatus']()).toBe('open');
    });

    it('should emit a ORDER_STATUS_CHANGED_EVENT when setStatus is called', () => {
      const spy = vi.spyOn(testOrder, 'emit');
      testOrder['setStatus']('open');
      expect(spy).toHaveBeenCalledWith(ORDER_STATUS_CHANGED_EVENT, {
        status: 'open',
        reason: undefined,
      });
    });

    // Whichever path ends the order, it is polled no more
    describe('with an interval polling the order', () => {
      beforeEach(() => {
        vi.useFakeTimers();
        testOrder['interval'] = setInterval(() => undefined, 1000);
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it.each`
        status            | outcome             | timers
        ${'initializing'} | ${'still polled'}   | ${1}
        ${'open'}         | ${'still polled'}   | ${1}
        ${'filled'}       | ${'polled no more'} | ${0}
        ${'canceled'}     | ${'polled no more'} | ${0}
        ${'rejected'}     | ${'polled no more'} | ${0}
        ${'error'}        | ${'polled no more'} | ${0}
      `('is $outcome once its status is $status', ({ status, timers }) => {
        testOrder['setStatus'](status);
        expect(vi.getTimerCount()).toBe(timers);
      });
    });
  });

  describe('orderCanceled', () => {
    it('should call setStatus with "canceled" and emit ORDER_CANCELED_EVENT on orderCanceled', () => {
      const spy = vi.spyOn(testOrder, 'emit');
      testOrder['orderCanceled']({ filled: 100, remaining: 5, price: 10, timestamp: 0 });
      expect(spy).toHaveBeenCalledWith(ORDER_CANCELED_EVENT, {
        status: 'canceled',
        filled: 100,
        remaining: 5,
        price: 10,
        timestamp: 0,
      });
    });
  });

  // `filled` says whether the order executed part of what it ordered before its refusal, as a STICKY order whose relaunch after a move
  // is refused may have: its earlier transaction canceled, with what it filled
  describe('orderRejected', () => {
    it.each`
      kind                | states                                                             | filled
      ${'no fill'}        | ${[]}                                                              | ${false}
      ${'a partial fill'} | ${[{ id: 'tx1', status: 'canceled', filled: 2, timestamp: 1000 }]} | ${true}
    `('sets the status "rejected" and emits ORDER_INVALID_EVENT with filled $filled and the reason, given $kind', ({ states, filled }) => {
      states.forEach((state: OrderState) => testOrder['recordOrderUpdate'](state));
      const spy = vi.spyOn(testOrder, 'emit');
      testOrder['orderRejected']('error reason');
      expect(spy).toHaveBeenCalledWith(ORDER_INVALID_EVENT, { status: 'rejected', filled, reason: 'error reason' });
    });
  });

  describe('orderPartiallyFilled', () => {
    it('should emit ORDER_PARTIALLY_FILLED_EVENT with filled amount on orderPartiallyFilled', () => {
      const spy = vi.spyOn(testOrder, 'emit');
      testOrder['orderPartiallyFilled'](10);
      expect(spy).toHaveBeenCalledWith(ORDER_PARTIALLY_FILLED_EVENT, 10);
    });
  });

  describe('orderFilled', () => {
    it('should set status to "filled" and emit ORDER_COMPLETED_EVENT with filled true on orderFilled', () => {
      const spy = vi.spyOn(testOrder, 'emit');
      testOrder['orderFilled']();
      expect(spy).toHaveBeenCalledWith(ORDER_COMPLETED_EVENT, { status: 'filled', filled: true });
    });
  });

  describe('orderErrored', () => {
    it('should set status to "error" and emit ORDER_ERRORED_EVENT event on orderErrored', () => {
      const error = new Error('test error');
      const spy = vi.spyOn(testOrder, 'emit');
      // Error events are treated as a special case in node.
      // If there is no listener for it, then the default action is to print a stack trace and exit the program.
      // So we need to declare an error listener
      testOrder.on('error', () => {});
      testOrder['orderErrored'](error);
      expect(spy).toHaveBeenCalledWith(ORDER_ERRORED_EVENT, { reason: 'test error', mayBeLive: false });
    });

    it('sets the status "error"', () => {
      testOrder['orderErrored'](new Error('test error'));
      expect(testOrder['getStatus']()).toBe('error');
    });

    // Whether the order may still be live on the exchange, where nothing follows it once it errored: by default, whether its current
    // transaction is open as the exchange last reported it, as when a poll or a cancelation fails for good
    it.each`
      kind                                              | states                                                                                                  | mayBeLive
      ${'no transaction'}                               | ${[]}                                                                                                   | ${false}
      ${'its transaction open'}                         | ${[{ id: 'tx1', status: 'open', timestamp: 1000 }]}                                                     | ${true}
      ${'its transaction canceled (a STICKY relaunch)'} | ${[{ id: 'tx1', status: 'canceled', timestamp: 1000 }]}                                                 | ${false}
      ${'a transaction canceled, then another open'}    | ${[{ id: 'tx1', status: 'canceled', timestamp: 1000 }, { id: 'tx2', status: 'open', timestamp: 2000 }]} | ${true}
    `('says mayBeLive $mayBeLive by default given $kind', ({ states, mayBeLive }) => {
      states.forEach((state: OrderState) => testOrder['recordOrderUpdate'](state));
      const listener = vi.fn();
      testOrder.on(ORDER_ERRORED_EVENT, listener);
      testOrder['orderErrored'](new Error('Invalid API key'));
      expect(listener.mock.calls).toEqual([[{ reason: 'Invalid API key', mayBeLive }]]);
    });

    it.each`
      mayBeLive
      ${true}
      ${false}
    `('says mayBeLive $mayBeLive when told, whatever its transaction', ({ mayBeLive }) => {
      testOrder['recordOrderUpdate']({ id: 'tx1', status: mayBeLive ? 'canceled' : 'open', timestamp: 1000 });
      const listener = vi.fn();
      testOrder.on(ORDER_ERRORED_EVENT, listener);
      testOrder['orderErrored'](new Error('Invalid API key'), mayBeLive);
      expect(listener.mock.calls).toEqual([[{ reason: 'Invalid API key', mayBeLive }]]);
    });
  });

  describe('isOrderCompleted', () => {
    it.each`
      status            | expected
      ${'initializing'} | ${false}
      ${'open'}         | ${false}
      ${'filled'}       | ${true}
      ${'canceled'}     | ${true}
      ${'rejected'}     | ${true}
      ${'error'}        | ${true}
    `('returns $expected when the status is $status', ({ status, expected }) => {
      testOrder['setStatus'](status);
      expect(testOrder['isOrderCompleted']()).toBe(expected);
    });
  });

  // A state reported after the end of the order (the simulated exchange settling it, a late answer) is ignored
  describe('isLateUpdate', () => {
    it.each`
      status            | expected
      ${'initializing'} | ${false}
      ${'open'}         | ${false}
      ${'filled'}       | ${true}
      ${'canceled'}     | ${true}
      ${'rejected'}     | ${true}
      ${'error'}        | ${true}
    `('returns $expected when the order is $status', ({ status, expected }) => {
      testOrder['setStatus'](status);
      expect(testOrder['isLateUpdate']({ id: 'tx1', status: 'closed' })).toBe(expected);
    });

    it('logs the update ignored and the status the order keeps', () => {
      testOrder['setStatus']('canceled');
      testOrder['isLateUpdate']({ id: 'tx1', status: 'closed' });
      expect(logger.debug).toHaveBeenCalledWith(
        'order',
        '[ee21e130-48bc-405f-be0c-46e9bf17b52e] BUY STICKY order update ignored (transaction tx1 closed), the order is already canceled',
      );
    });

    it('logs nothing for an order that is not over', () => {
      testOrder['setStatus']('open');
      testOrder['isLateUpdate']({ id: 'tx1', status: 'closed' });
      expect(logger.debug).not.toHaveBeenCalledWith('order', expect.stringContaining('update ignored'));
    });
  });

  // Every state the exchange reports for the order (creation, poll, cancelation, settlement in backtest) is recorded on its transaction
  describe('recordOrderUpdate', () => {
    const state: OrderState = { id: 'tx1', status: 'open', filled: 2, remaining: 8, price: 100, timestamp: 1000 };
    const record = (update: Partial<OrderState> = {}) => testOrder['recordOrderUpdate']({ ...state, ...update });
    const getTransaction = () => testOrder['transactions'].get('tx1');

    // A state without an id cannot be followed, and an order that is over stays so
    describe.each`
      kind                                    | update               | setup
      ${'a state without an id'}              | ${{ id: undefined }} | ${() => undefined}
      ${'a state after the end of the order'} | ${{}}                | ${() => testOrder['setStatus']('canceled')}
    `('given $kind', ({ update, setup }) => {
      beforeEach(() => {
        setup();
      });

      it('returns false', () => {
        expect(record(update)).toBe(false);
      });

      it('records nothing', () => {
        record(update);
        expect(testOrder['transactions'].size).toBe(0);
      });

      it('emits nothing', () => {
        const spy = vi.spyOn(testOrder, 'emit');
        record(update);
        expect(spy).not.toHaveBeenCalled();
      });
    });

    describe('given the first state of a transaction', () => {
      it('returns true', () => {
        expect(record()).toBe(true);
      });

      it('records the transaction', () => {
        record();
        expect(getTransaction()).toEqual({ id: 'tx1', status: 'open', filled: 2, price: 100, timestamp: 1000 });
      });

      // The price of a limit order, at which it fills: the Trader estimates a fill from it when the exchange cannot give its trades
      it.each`
        kind              | price        | recorded
        ${'a price'}      | ${100}       | ${100}
        ${'no price'}     | ${undefined} | ${undefined}
        ${'a price of 0'} | ${0}         | ${undefined}
        ${'a NaN price'}  | ${NaN}       | ${undefined}
      `('records a price of $recorded when the state reports $kind', ({ price, recorded }) => {
        record({ price });
        expect(getTransaction()?.price).toBe(recorded);
      });

      it('makes it the transaction of the order', () => {
        record();
        expect(testOrder['id']).toBe('tx1');
      });

      // Not 0: a fill never reported is unknown, which a canceled order reports as such (see getCancelationFill)
      it.each`
        kind                    | filled       | recorded
        ${'no fill'}            | ${undefined} | ${undefined}
        ${'a fill that is NaN'} | ${NaN}       | ${undefined}
        ${'a fill of 0'}        | ${0}         | ${0}
      `('records a fill of $recorded when the state reports $kind', ({ filled, recorded }) => {
        record({ filled });
        expect(getTransaction()?.filled).toBe(recorded);
      });

      it.each`
        kind             | filled       | outcome       | calls
        ${'a fill of 2'} | ${2}         | ${'the fill'} | ${[[2]]}
        ${'a fill of 0'} | ${0}         | ${'nothing'}  | ${[]}
        ${'no fill'}     | ${undefined} | ${'nothing'}  | ${[]}
      `('emits $outcome with ORDER_PARTIALLY_FILLED_EVENT when the state reports $kind', ({ filled, calls }) => {
        const listener = vi.fn();
        testOrder.on(ORDER_PARTIALLY_FILLED_EVENT, listener);
        record({ filled });
        expect(listener.mock.calls).toEqual(calls);
      });

      it('logs the state at debug level', () => {
        record();
        expect(logger.debug).toHaveBeenCalledWith(
          'order',
          expect.stringContaining('BUY STICKY order update: transaction tx1 open, filled: 2, remaining: 8, price: 100, at '),
        );
      });
    });

    // The fill of a transaction is cumulative, and its first timestamp the bound its trades are fetched from (createOrderSummary)
    describe('given a later state of the transaction', () => {
      beforeEach(() => {
        record();
      });

      it('keeps the first timestamp', () => {
        record({ timestamp: 5000 });
        expect(getTransaction()?.timestamp).toBe(1000);
      });

      it('records the new status', () => {
        record({ status: 'canceled' });
        expect(getTransaction()?.status).toBe('canceled');
      });

      it.each`
        kind              | price        | recorded
        ${'a new price'}  | ${101}       | ${101}
        ${'no price'}     | ${undefined} | ${100}
        ${'a price of 0'} | ${0}         | ${100}
      `('records a price of $recorded given $kind', ({ price, recorded }) => {
        record({ price });
        expect(getTransaction()?.price).toBe(recorded);
      });

      it.each`
        kind                | filled       | recorded
        ${'a larger fill'}  | ${5}         | ${5}
        ${'the same fill'}  | ${2}         | ${2}
        ${'a smaller fill'} | ${1}         | ${2}
        ${'no fill'}        | ${undefined} | ${2}
      `('records a fill of $recorded given $kind', ({ filled, recorded }) => {
        record({ filled });
        expect(getTransaction()?.filled).toBe(recorded);
      });

      // The first state reported none: the first one that does is the fill, and a fill of it
      it.each`
        kind             | filled       | recorded     | calls
        ${'a fill of 3'} | ${3}         | ${3}         | ${[[3]]}
        ${'a fill of 0'} | ${0}         | ${0}         | ${[]}
        ${'no fill'}     | ${undefined} | ${undefined} | ${[]}
      `('records $recorded, and emits $calls, given $kind after a state without fill', ({ filled, recorded, calls }) => {
        testOrder['transactions'].clear();
        record({ filled: undefined });
        const listener = vi.fn();
        testOrder.on(ORDER_PARTIALLY_FILLED_EVENT, listener);
        record({ filled });
        expect({ recorded: getTransaction()?.filled, calls: listener.mock.calls }).toEqual({ recorded, calls });
      });

      it.each`
        kind                | filled       | outcome           | calls
        ${'a larger fill'}  | ${5}         | ${'the new fill'} | ${[[5]]}
        ${'the same fill'}  | ${2}         | ${'nothing'}      | ${[]}
        ${'a smaller fill'} | ${1}         | ${'nothing'}      | ${[]}
        ${'no fill'}        | ${undefined} | ${'nothing'}      | ${[]}
      `('emits $outcome with ORDER_PARTIALLY_FILLED_EVENT given $kind', ({ filled, calls }) => {
        const listener = vi.fn();
        testOrder.on(ORDER_PARTIALLY_FILLED_EVENT, listener);
        record({ filled });
        expect(listener.mock.calls).toEqual(calls);
      });
    });
  });

  // What the order executed as the exchange reported it, which the Trader estimates the summary of a fill from when the exchange
  // cannot give one: the cumulative fill of each transaction, added up over the transactions (a STICKY order places several)
  describe('getFilledAmount', () => {
    const record = (states: Partial<OrderState>[]) =>
      states.forEach(state => testOrder['recordOrderUpdate']({ id: 'tx1', status: 'open', timestamp: 1000, ...state }));

    it.each`
      kind                                       | states                                                                   | expected
      ${'no state'}                              | ${[]}                                                                    | ${0}
      ${'a state without fill'}                  | ${[{ filled: undefined }]}                                               | ${0}
      ${'a fill'}                                | ${[{ filled: 2 }]}                                                       | ${2}
      ${'a transaction filled further'}          | ${[{ filled: 2 }, { filled: 5, status: 'closed' }]}                      | ${5}
      ${'a fill, then a state without fill'}     | ${[{ filled: 2 }, { filled: undefined, status: 'closed' }]}              | ${2}
      ${'the fills of two transactions'}         | ${[{ filled: 2 }, { id: 'tx2', filled: 3 }]}                             | ${5}
      ${'a transaction without fill and a fill'} | ${[{ filled: undefined, status: 'canceled' }, { id: 'tx2', filled: 3 }]} | ${3}
      ${'fills of 0.02 and 0.07, in decimal'}    | ${[{ filled: 0.02 }, { id: 'tx2', filled: 0.07 }]}                       | ${0.09}
    `('returns $expected given $kind', ({ states, expected }) => {
      record(states);
      expect(testOrder.getFilledAmount()).toBe(expected);
    });

    // recordOrderUpdate records no fill until a state reports one: such a transaction counts as nothing filled, not as NaN
    it('counts a transaction recorded without a fill as 0', () => {
      testOrder['transactions'].set('tx1', { id: 'tx1', status: 'closed', timestamp: 1000 });
      expect(testOrder.getFilledAmount()).toBe(0);
    });
  });

  // The price the Trader estimates a fill at when the exchange cannot give its trades (see Trader.estimateExecutionPrice): the price
  // the exchange reported for each transaction that filled, weighted by that fill
  describe('getAverageFillPrice', () => {
    const record = (states: Partial<OrderState>[]) =>
      states.forEach(state => testOrder['recordOrderUpdate']({ id: 'tx1', status: 'open', timestamp: 1000, ...state }));

    it.each`
      kind                                               | states                                                                         | expected
      ${'no state'}                                      | ${[]}                                                                          | ${undefined}
      ${'a transaction priced, without fill'}            | ${[{ price: 100 }]}                                                            | ${undefined}
      ${'a transaction priced, filled 0'}                | ${[{ price: 100, filled: 0 }]}                                                 | ${undefined}
      ${'a fill at 100.01'}                              | ${[{ price: 100.01, filled: 2 }]}                                              | ${100.01}
      ${'a fill priced in binary at 101.2 + 0.01'}       | ${[{ price: 101.21000000000001, filled: 1 }]}                                  | ${101.21}
      ${'two transactions filled at 104.44 and 104.46'}  | ${[{ price: 104.44, filled: 0.3 }, { id: 'tx2', price: 104.46, filled: 0.3 }]} | ${104.45}
      ${'a fill, and a transaction priced without fill'} | ${[{ price: 100, filled: 2 }, { id: 'tx2', price: 105 }]}                      | ${100}
      ${'a fill without its price'}                      | ${[{ filled: 2 }]}                                                             | ${undefined}
      ${'a fill priced, and a fill without its price'}   | ${[{ price: 100, filled: 2 }, { id: 'tx2', filled: 1 }]}                       | ${undefined}
    `('returns $expected given $kind', ({ states, expected }) => {
      record(states);
      expect(testOrder.getAverageFillPrice()).toBe(expected);
    });
  });

  // The state recorded, the order follows its transaction: filled, canceled or open
  describe('applyOrderUpdate', () => {
    const state: OrderState = { id: 'tx1', status: 'open', filled: 2, remaining: 8, price: 100, timestamp: 1000 };
    const apply = (update: Partial<OrderState> = {}) => testOrder['applyOrderUpdate']({ ...state, ...update });
    const listen = (event: string) => {
      const listener = vi.fn();
      testOrder.on(event, listener);
      return listener;
    };

    it.each`
      status        | expected
      ${'closed'}   | ${'filled'}
      ${'canceled'} | ${'canceled'}
      ${'open'}     | ${'open'}
    `('sets the order $expected when the transaction is $status', ({ status, expected }) => {
      apply({ status });
      expect(testOrder['getStatus']()).toBe(expected);
    });

    it('emits ORDER_COMPLETED_EVENT when the transaction is closed', () => {
      const listener = listen(ORDER_COMPLETED_EVENT);
      apply({ status: 'closed' });
      expect(listener.mock.calls).toEqual([[{ status: 'filled', filled: true }]]);
    });

    // The same payload for every type of order: what the order filled, what is left of its amount (10), its price when known, and
    // the time. Neither amount while no state reported a fill: unknown, not 0 filled and 0 remaining
    it.each`
      kind                       | update                                         | payload
      ${'with all its details'}  | ${{}}                                          | ${{ status: 'canceled', filled: 2, remaining: 8, price: 100, timestamp: 1000 }}
      ${'without fill nor rest'} | ${{ filled: undefined, remaining: undefined }} | ${{ status: 'canceled', price: 100, timestamp: 1000 }}
      ${'without its price'}     | ${{ price: undefined }}                        | ${{ status: 'canceled', filled: 2, remaining: 8, timestamp: 1000 }}
    `('emits ORDER_CANCELED_EVENT when the transaction is canceled $kind', ({ update, payload }) => {
      const listener = listen(ORDER_CANCELED_EVENT);
      apply({ status: 'canceled', ...update });
      expect(listener.mock.calls).toEqual([[payload]]);
    });

    // A MARKET or LIMIT order relayed the answer to the cancelation alone, an amount it left out as 0: a fill an earlier poll had
    // reported was lost, and a cancelation answered without its fill read as 0 filled and 0 remaining
    it.each`
      kind                                                        | states                                                                              | filled       | remaining
      ${'a poll reported 2, the cancelation none'}                | ${[{ filled: 2 }, { status: 'canceled', filled: undefined, remaining: undefined }]} | ${2}         | ${8}
      ${'a poll reported 2, the cancelation 1'}                   | ${[{ filled: 2 }, { status: 'canceled', filled: 1, remaining: 9 }]}                 | ${2}         | ${8}
      ${'a poll reported 2, the cancelation 3'}                   | ${[{ filled: 2 }, { status: 'canceled', filled: 3, remaining: 7 }]}                 | ${3}         | ${7}
      ${'the creation reported 0, the cancelation none'}          | ${[{ filled: 0 }, { status: 'canceled', filled: undefined, remaining: undefined }]} | ${0}         | ${10}
      ${'no state reported any'}                                  | ${[{ filled: undefined }, { status: 'canceled', filled: undefined }]}               | ${undefined} | ${undefined}
      ${'9.7, which leaves 0.3 in decimal (0.3000000000000007)'}  | ${[{ status: 'canceled', filled: 9.7 }]}                                            | ${9.7}       | ${0.3}
      ${'more than the amount ordered, the exchange rounding up'} | ${[{ status: 'canceled', filled: 10.5 }]}                                           | ${10.5}      | ${0}
      ${'two transactions reported 3 and 2 (a STICKY order)'}     | ${[{ filled: 3 }, { id: 'tx2', status: 'canceled', filled: 2 }]}                    | ${5}         | ${5}
    `('reports what the order filled when $kind: $filled filled, $remaining remaining', ({ states, filled, remaining }) => {
      const listener = listen(ORDER_CANCELED_EVENT);
      states.forEach((update: Partial<OrderState>) => apply(update));
      const [payload] = listener.mock.calls.at(-1) ?? [];
      expect({ filled: payload?.filled, remaining: payload?.remaining }).toEqual({ filled, remaining });
    });

    // Added up in binary, the two fills made 0.09000000000000001 filled and 0.009999999999999995 remaining
    it.each`
      field          | expected
      ${'filled'}    | ${0.09}
      ${'remaining'} | ${0.01}
    `('reports $expected $field for an order of 0.1 whose two transactions filled 0.02 and 0.07', ({ field, expected }) => {
      const order = new TestOrder('BTC/USDT', 'ee21e130-48bc-405f-be0c-46e9bf17b52e', 'BUY', 'STICKY', 0.1);
      const listener = vi.fn();
      order.on(ORDER_CANCELED_EVENT, listener);
      order['applyOrderUpdate']({ id: 'tx1', status: 'open', filled: 0.02, timestamp: 1000 });
      order['applyOrderUpdate']({ id: 'tx2', status: 'canceled', filled: 0.07, timestamp: 2000 });
      const [payload] = listener.mock.calls.at(-1) ?? [];
      expect(payload?.[field]).toBe(expected);
    });

    // Reported once per transaction: a poll of a transaction that stays open changes nothing
    it.each`
      kind                                       | updates                      | changes
      ${'a first state open'}                    | ${[{}]}                      | ${1}
      ${'a later state of the transaction open'} | ${[{}, { timestamp: 2000 }]} | ${1}
      ${'the first state of another one open'}   | ${[{}, { id: 'tx2' }]}       | ${2}
    `('emits ORDER_STATUS_CHANGED_EVENT $changes time(s) given $kind', ({ updates, changes }) => {
      const listener = listen(ORDER_STATUS_CHANGED_EVENT);
      updates.forEach((update: Partial<OrderState>) => apply(update));
      expect(listener).toHaveBeenCalledTimes(changes);
    });

    it('leaves the order as it is given a state to ignore', () => {
      apply({ id: undefined, status: 'closed' });
      expect(testOrder['getStatus']()).toBe('initializing');
    });
  });

  // An ExchangeNetworkError says nothing of the order: a poll or a cancelation that fails so leaves it as it was
  describe('isTransientFailure', () => {
    it.each`
      kind                         | failure                                    | expected
      ${'an ExchangeNetworkError'} | ${new ExchangeNetworkError('timeout')}     | ${true}
      ${'an OrderNotFound'}        | ${new OrderNotFound('unknown order')}      | ${false}
      ${'a GekkoError'}            | ${new GekkoError('exchange', 'no ticker')} | ${false}
      ${'an Error'}                | ${new Error('Invalid API key')}            | ${false}
      ${'a non-Error value'}       | ${'Invalid API key'}                       | ${false}
    `('returns $expected for $kind', ({ failure, expected }) => {
      expect(testOrder['isTransientFailure'](failure, 'poll')).toBe(expected);
    });

    // The failure without its tag, as describeError writes it: the warning has a tag of its own, and showed two
    it('logs a warning naming the action and the status the order keeps for an ExchangeNetworkError', () => {
      testOrder['setStatus']('open');
      testOrder['isTransientFailure'](new ExchangeNetworkError('timeout'), 'cancelation');
      expect(logger.warning).toHaveBeenCalledWith(
        'order',
        '[ee21e130-48bc-405f-be0c-46e9bf17b52e] BUY STICKY order cancelation failed on the network, it stays open: timeout',
      );
    });

    it('logs no warning for any other failure', () => {
      testOrder['isTransientFailure'](new Error('Invalid API key'), 'poll');
      expect(logger.warning).not.toHaveBeenCalled();
    });
  });

  // A creation is sent once and never replayed: one whose outcome is unknown may have placed the order
  describe('orderErroredAtCreation', () => {
    let listener: Mock;
    let orderErroredSpy: MockInstance;

    beforeEach(() => {
      listener = vi.fn();
      testOrder.on(ORDER_ERRORED_EVENT, listener);
      orderErroredSpy = vi.spyOn(testOrder as any, 'orderErrored');
    });

    it.each`
      kind                         | failure                                                                                                                   | reason
      ${'an ExchangeNetworkError'} | ${new ExchangeNetworkError('timeout')}                                                                                    | ${'(timeout)'}
      ${'an OrderOutcomeUnknown'}  | ${new OrderOutcomeUnknown('Order 42 was created on binance for BTC/USDT, but its state could not be read back: timeout')} | ${'(Order 42 was created on binance for BTC/USDT, but its state could not be read back: timeout)'}
    `('says the outcome of a creation that failed with $kind is unknown, the order maybe live', ({ failure, reason }) => {
      testOrder['orderErroredAtCreation'](failure);
      expect(listener.mock.calls).toEqual([
        [{ reason: `Outcome unknown: the order may be live on the exchange, check it before placing it again ${reason}`, mayBeLive: true }],
      ]);
    });

    it('keeps the failure as the cause', () => {
      const networkError = new ExchangeNetworkError('timeout');
      testOrder['orderErroredAtCreation'](networkError);
      expect(orderErroredSpy.mock.calls[0][0].cause).toBe(networkError);
    });

    // Its reason is the failure without its tag (see describeError): the Trader's error line and the Telegram notification have a tag of
    // their own, and showed two
    it.each`
      kind                   | failure                                                                              | reason
      ${'an Error'}          | ${new Error('Invalid API key')}                                                      | ${'Invalid API key'}
      ${'a GekkoError'}      | ${new GekkoError('exchange', 'Market order not sent: ticker unavailable (timeout)')} | ${'Market order not sent: ticker unavailable (timeout)'}
      ${'an OrderNotFound'}  | ${new OrderNotFound('unknown order')}                                                | ${'unknown order'}
      ${'a non-Error value'} | ${'Invalid API key'}                                                                 | ${'Invalid API key'}
    `('ends the order with the reason of $kind, which placed nothing', ({ failure, reason }) => {
      testOrder['orderErroredAtCreation'](failure);
      expect(listener.mock.calls).toEqual([[{ reason, mayBeLive: false }]]);
    });

    it('ends the order with an Error as it is', () => {
      const failure = new Error('Invalid API key');
      testOrder['orderErroredAtCreation'](failure);
      expect(orderErroredSpy.mock.calls[0][0]).toBe(failure);
    });
  });

  describe('createLimitOrder', () => {
    it('should call exchange.createLimitOrder and then handleCreateOrderSuccess on success', async () => {
      const orderResponse = { id: 'order1', status: 'open', filled: 0, price: 100 };
      fakeExchange.createLimitOrder.mockResolvedValue(orderResponse);
      await testOrder['createLimitOrder']('BUY', 10, 99);
      expect(testOrder.handleCreateOrderSuccess).toHaveBeenCalledWith(orderResponse);
    });

    it('should call handleCreateOrderError when exchange.createLimitOrder rejects', async () => {
      const error = new Error('create failed');
      fakeExchange.createLimitOrder.mockRejectedValue(error);
      await testOrder['createLimitOrder']('BUY', 10, 100);
      expect(testOrder.handleCreateOrderError).toHaveBeenCalledWith(error);
    });

    // In backtest the simulated exchange reports the fill through the callback given at the creation
    describe('with an onSettled callback', () => {
      const onSettled = vi.fn();

      beforeEach(async () => {
        fakeExchange.createLimitOrder.mockResolvedValue({ id: 'order1', status: 'open', filled: 0, price: 99 });
        await testOrder['createLimitOrder']('BUY', 10, 99, onSettled);
      });

      it('should pass the callback to exchange.createLimitOrder', () => {
        expect(fakeExchange.createLimitOrder).toHaveBeenCalledWith('BTC/USDT', 'BUY', 10, 99, onSettled);
      });

      it('should log the creation of the order', () => {
        expect(logger.info).toHaveBeenCalledWith(
          'order',
          '[ee21e130-48bc-405f-be0c-46e9bf17b52e] Creating BUY limit order with amount: 10 and price 99',
        );
      });
    });
  });

  describe('createMarketOrder', () => {
    it('should call exchange.createMarketOrder and then handleCreateOrderSuccess on success', async () => {
      const orderResponse = { id: 'order1', status: 'closed', filled: 10, price: 100 };
      fakeExchange.createMarketOrder.mockResolvedValue(orderResponse);
      await testOrder['createMarketOrder']('BUY', 10);
      expect(testOrder.handleCreateOrderSuccess).toHaveBeenCalledWith(orderResponse);
    });

    it('should call handleCreateOrderError when exchange.createMarketOrder rejects', async () => {
      const error = new Error('create failed');
      fakeExchange.createMarketOrder.mockRejectedValue(error);
      await testOrder['createMarketOrder']('BUY', 10);
      expect(testOrder.handleCreateOrderError).toHaveBeenCalledWith(error);
    });

    it('should log the creation of the order', async () => {
      fakeExchange.createMarketOrder.mockResolvedValue({ id: 'order1', status: 'closed', filled: 10, price: 100 });
      await testOrder['createMarketOrder']('BUY', 10);
      expect(logger.info).toHaveBeenCalledWith('order', '[ee21e130-48bc-405f-be0c-46e9bf17b52e] Creating BUY market order with amount: 10');
    });
  });

  describe('cancelOrder', () => {
    it('should call exchange.cancelOrder and then handleCancelOrderSuccess on success', async () => {
      const orderResponse = { id: 'order1', filled: 0, remaining: 10 };
      fakeExchange.cancelOrder.mockResolvedValue(orderResponse);
      await testOrder['cancelOrder']('order1');
      expect(testOrder.handleCancelOrderSuccess).toHaveBeenCalledWith(orderResponse);
    });

    it('should call handleCancelOrderError when exchange.cancelOrder rejects', async () => {
      const error = new Error('cancel failed');
      fakeExchange.cancelOrder.mockRejectedValue(error);
      await testOrder['cancelOrder']('order1');
      expect(testOrder.handleCancelOrderError).toHaveBeenCalledWith(error);
    });

    // Nobody awaits cancel(): a failure goes to handleCancelOrderError, it never rejects
    it('should resolve instead of rejecting when the cancelation failed', async () => {
      fakeExchange.cancelOrder.mockRejectedValue(new ExchangeNetworkError('timeout'));
      await expect(testOrder['cancelOrder']('order1')).resolves.toBeUndefined();
    });
  });

  describe('fetchOrder', () => {
    it('should call exchange.fetchOrder and then handleFetchOrderSuccess on success', async () => {
      const orderResponse = { id: 'order1', status: 'open', filled: 0, price: 100 };
      fakeExchange.fetchOrder.mockResolvedValue(orderResponse);
      await testOrder['fetchOrder']('order1');
      expect(testOrder.handleFetchOrderSuccess).toHaveBeenCalledWith(orderResponse);
    });

    it('should call handleFetchOrderError when exchange.fetchOrder rejects', async () => {
      const error = new Error('fetch failed');
      fakeExchange.fetchOrder.mockRejectedValue(error);
      await testOrder['fetchOrder']('order1');
      expect(testOrder.handleFetchOrderError).toHaveBeenCalledWith(error);
    });
  });
});
