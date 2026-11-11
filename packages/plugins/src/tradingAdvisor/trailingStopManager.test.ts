import { TRAILING_STOP_ACTIVATED, TRAILING_STOP_TRIGGERED } from '@gekko/shared/constants/event.const';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { info, warning } from '@gekko/core/logger/logger';
import { UUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TrailingStopManager } from './trailingStopManager';
import { TrailingStopState } from '@gekko/strategies/trailingStopManager.types';

vi.mock('@gekko/core/logger/logger', () => ({ info: vi.fn(), warning: vi.fn() }));

/* -------------------------------------------------------------------------- */
/*                                Test Helpers                                */
/* -------------------------------------------------------------------------- */

// Opens at its low: the stop meets a candle's prices as open, low, high, close, and an open outside the candle (it was 1) met the stop
// at a price the candle never traded
const makeCandle = (high: number, low: number, close: number) => ({ start: 1000, open: low, high, low, close, volume: 1 }) as any;

const makeBucket = (symbol: TradingPair, high: number, low: number, close: number): CandleBucket => {
  const bucket: CandleBucket = new Map();
  bucket.set(symbol, makeCandle(high, low, close));
  return bucket;
};

/** A bucket holding one BTC/USDT candle with these prices, in the usual order */
const ohlc = (open: number, high: number, low: number, close: number): CandleBucket =>
  new Map([['BTC/USDT' as TradingPair, { start: 1000, open, high, low, close, volume: 1 }]]);

const defaultId = 'aaaa-bbbb-cccc-dddd' as UUID;
const defaultOrder = {
  id: defaultId,
  symbol: 'BTC/USDT' as TradingPair,
  amount: 0.5,
  trailing: { percentage: 2, trigger: 50000 },
  createdAt: Date.now(),
};

/* -------------------------------------------------------------------------- */
/*                              Unit Tests                                   */
/* -------------------------------------------------------------------------- */

describe('TrailingStopManager', () => {
  let manager: TrailingStopManager;

  beforeEach(() => {
    manager = new TrailingStopManager();
  });

  /* -------------------------------------------------------------------------- */
  /*                                 addOrder                                   */
  /* -------------------------------------------------------------------------- */

  describe('addOrder', () => {
    it.each`
      desc                              | field                | value
      ${'stores order as dormant'}      | ${'status'}          | ${'dormant'}
      ${'initializes highestPeak to 0'} | ${'highestPeak'}     | ${0}
      ${'initializes stopPrice to 0'}   | ${'stopPrice'}       | ${0}
      ${'sets activation price'}        | ${'activationPrice'} | ${50000}
    `('$desc', ({ field, value }) => {
      manager.addOrder(defaultOrder);
      expect(manager.getOrders().get(defaultId)).toHaveProperty(field, value);
    });

    it('does nothing when trailing config is missing', () => {
      manager.addOrder({ ...defaultOrder, trailing: undefined });
      expect(manager.getOrders().size).toBe(0);
    });

    it('keeps the amount the BUY filled', () => {
      manager.addOrder(defaultOrder);
      expect(manager.getOrders().get(defaultId)?.amount).toBe(0.5);
    });

    it.each`
      amount
      ${0}
      ${-1}
      ${NaN}
      ${Infinity}
    `('refuses an amount of $amount', ({ amount }) => {
      manager.addOrder({ ...defaultOrder, amount });
      expect(manager.getOrders().size).toBe(0);
    });

    // The position the BUY opened is then left without a stop: the warning is all that says so
    it.each`
      amount      | shown
      ${0}        | ${'0'}
      ${-1}       | ${'-1'}
      ${NaN}      | ${'NaN'}
      ${Infinity} | ${'Infinity'}
    `('warns that an amount of $amount is invalid', ({ amount, shown }) => {
      manager.addOrder({ ...defaultOrder, amount });
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        'trailing stop',
        `Cannot create trailing stop without a valid amount, current order amount: ${shown}`,
      );
    });

    it('activates order directly if trigger is undefined', () => {
      manager.addOrder({ ...defaultOrder, trailing: { percentage: 2 } });
      expect(manager.getOrders().get(defaultId)?.status).toBe('active');
    });

    // Leaving the trigger out is the way to ask for a stop active at once: a trigger given must be a price
    it.each`
      trigger      | isArmed
      ${0}         | ${false}
      ${NaN}       | ${false}
      ${-1}        | ${false}
      ${Infinity}  | ${false}
      ${undefined} | ${true}
      ${50000}     | ${true}
    `('arms a stop whose trigger is $trigger: $isArmed', ({ trigger, isArmed }) => {
      manager.addOrder({ ...defaultOrder, trailing: { percentage: 2, trigger } });
      expect(manager.getOrders().has(defaultId)).toBe(isArmed);
    });

    it.each`
      trigger
      ${0}
      ${NaN}
      ${-1}
      ${Infinity}
    `('warns that a trigger of $trigger is invalid', ({ trigger }) => {
      manager.addOrder({ ...defaultOrder, trailing: { percentage: 2, trigger } });
      expect(warning).toHaveBeenCalledWith('trailing stop', `Invalid trigger price: ${trigger}. Must be positive.`);
    });

    // A percentage left undefined (a strategy parameter misspelt) or NaN made a stop price of NaN, which never triggers
    it.each`
      percentage   | isArmed
      ${0}         | ${false}
      ${100}       | ${false}
      ${-1}        | ${false}
      ${NaN}       | ${false}
      ${undefined} | ${false}
      ${2}         | ${true}
    `('arms a stop whose percentage is $percentage: $isArmed', ({ percentage, isArmed }) => {
      manager.addOrder({ ...defaultOrder, trailing: { percentage, trigger: 50000 } });
      expect(manager.getOrders().has(defaultId)).toBe(isArmed);
    });

    it.each`
      percentage   | shown
      ${0}         | ${'0'}
      ${100}       | ${'100'}
      ${-1}        | ${'-1'}
      ${NaN}       | ${'NaN'}
      ${undefined} | ${'undefined'}
    `('warns that a percentage of $percentage is invalid', ({ percentage, shown }) => {
      manager.addOrder({ ...defaultOrder, trailing: { percentage, trigger: 50000 } });
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        'trailing stop',
        `Invalid trailing percentage: ${shown}%. Must be between 0 and 100 exclusive.`,
      );
    });

    it('emits TRAILING_STOP_ACTIVATED with the stop as it adds one without trigger', () => {
      const listener = vi.fn();
      manager.on(TRAILING_STOP_ACTIVATED, listener);
      manager.addOrder({ ...defaultOrder, trailing: { percentage: 2 } });
      expect(listener).toHaveBeenCalledWith({
        id: defaultId,
        symbol: 'BTC/USDT',
        amount: 0.5,
        config: { percentage: 2 },
        status: 'active',
        highestPeak: 0,
        stopPrice: 0,
        activationPrice: undefined,
        createdAt: defaultOrder.createdAt,
      });
    });

    it('emits a copy of the stop it keeps, not the stop itself', () => {
      const listener = vi.fn();
      manager.on(TRAILING_STOP_ACTIVATED, listener);
      manager.addOrder({ ...defaultOrder, trailing: { percentage: 2 } });
      expect(listener.mock.calls[0][0]).not.toBe(manager.getOrders().get(defaultId));
    });

    it.each`
      desc                                   | trailing
      ${'a stop with a trigger'}             | ${{ percentage: 2, trigger: 50000 }}
      ${'a stop without trigger it refuses'} | ${{ percentage: 100 }}
    `('does not emit TRAILING_STOP_ACTIVATED as it adds $desc', ({ trailing }) => {
      const listener = vi.fn();
      manager.on(TRAILING_STOP_ACTIVATED, listener);
      manager.addOrder({ ...defaultOrder, trailing });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  /* -------------------------------------------------------------------------- */
  /*                            update – dormant                                */
  /* -------------------------------------------------------------------------- */

  describe('update (dormant phase)', () => {
    beforeEach(() => {
      manager.addOrder(defaultOrder);
    });

    it.each`
      desc                             | high     | low      | status
      ${'stays dormant below trigger'} | ${49999} | ${49000} | ${'dormant'}
      ${'activates at trigger'}        | ${50000} | ${49500} | ${'active'}
      ${'activates above trigger'}     | ${51000} | ${50500} | ${'active'}
    `('$desc', ({ high, low, status }) => {
      manager.update(makeBucket('BTC/USDT', high, low, low));
      expect(manager.getOrders().get(defaultId)?.status).toBe(status);
    });

    // The stop price is 50000 * 0.98
    it.each`
      desc                                  | high     | low      | field            | value
      ${'sets highestPeak on activation'}   | ${51000} | ${50500} | ${'highestPeak'} | ${51000}
      ${'computes stopPrice on activation'} | ${50000} | ${49500} | ${'stopPrice'}   | ${49000}
    `('$desc', ({ high, low, field, value }) => {
      manager.update(makeBucket('BTC/USDT', high, low, low));
      expect(manager.getOrders().get(defaultId)).toHaveProperty(field, value);
    });

    it('emits TRAILING_STOP_ACTIVATED event on activation', () => {
      const listener = vi.fn();
      manager.on(TRAILING_STOP_ACTIVATED, listener);
      manager.update(makeBucket('BTC/USDT', 50000, 49000, 50000));
      expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: defaultId, status: 'active' }));
    });

    it('does not emit event if remains dormant', () => {
      const listener = vi.fn();
      manager.on(TRAILING_STOP_ACTIVATED, listener);
      manager.update(makeBucket('BTC/USDT', 49999, 49000, 49500));
      expect(listener).not.toHaveBeenCalled();
    });

    it('ignores updates for other symbols', () => {
      manager.update(makeBucket('ETH/USDT', 60000, 59000, 59500));
      expect(manager.getOrders().get(defaultId)?.status).toBe('dormant');
    });

    // Each stop meets the candle of its own pair: a stop whose pair the bucket lacks is skipped, not the stops kept after it
    it('activates a stop on a pair the bucket holds, kept after a stop on a pair it lacks', () => {
      const ethId = 'e7e70000-0000-4000-8000-000000000001' as UUID;
      manager.addOrder({ ...defaultOrder, id: ethId, symbol: 'ETH/USDT', trailing: { percentage: 2, trigger: 3000 } });
      manager.update(makeBucket('ETH/USDT', 3100, 3050, 3050));
      expect(manager.getOrders().get(ethId)?.status).toBe('active');
    });
  });

  /* -------------------------------------------------------------------------- */
  /*                  update – the candle that activates a stop                 */
  /* -------------------------------------------------------------------------- */

  // Its low may have come before its high reached the trigger: the stop meets that candle from its open when the open reached the
  // trigger, else from its high, then its close. Trailed whole, the candle triggered the stop whenever it had opened 2% below its high.
  describe('update (the candle that activates a stop with a trigger)', () => {
    let triggered: Mock;

    beforeEach(() => {
      manager.addOrder(defaultOrder); // Trigger 50000, 2%
      triggered = vi.fn();
      manager.on(TRAILING_STOP_TRIGGERED, triggered);
    });

    it.each`
      desc                                      | open     | high     | low      | close
      ${'opens at its low, closes at its high'} | ${49000} | ${51000} | ${49000} | ${51000}
      ${'goes below the stop price it sets'}    | ${49800} | ${50500} | ${48500} | ${50000}
    `('does not trigger the stop on a candle that $desc', ({ open, high, low, close }) => {
      manager.update(ohlc(open, high, low, close));
      expect(triggered).not.toHaveBeenCalled();
    });

    describe.each`
      desc                                      | open     | high     | low      | close    | peak     | stopPrice
      ${'opens at the trigger, falls 2% below'} | ${50000} | ${50200} | ${48900} | ${49000} | ${50000} | ${49000}
      ${'closes 2% below its high'}             | ${49500} | ${51000} | ${49400} | ${49900} | ${51000} | ${49980}
    `('on a candle that $desc', ({ open, high, low, close, peak, stopPrice }) => {
      beforeEach(() => {
        manager.update(ohlc(open, high, low, close));
      });

      it('triggers the stop', () => {
        expect(triggered).toHaveBeenCalledOnce();
      });

      it(`reports a peak of ${peak} and a stop price of ${stopPrice}, those its price reached`, () => {
        expect(triggered).toHaveBeenCalledWith(expect.objectContaining({ highestPeak: peak, stopPrice }));
      });
    });

    it.each`
      desc                         | open     | peak     | stopPrice
      ${'at or above the trigger'} | ${50100} | ${50100} | ${49098}
      ${'below the trigger'}       | ${49800} | ${50600} | ${49588}
    `('announces the activation by a candle that opened $desc with a peak of $peak', ({ open, peak, stopPrice }) => {
      const activated = vi.fn();
      manager.on(TRAILING_STOP_ACTIVATED, activated);
      manager.update(ohlc(open, 50600, 49700, 50500));
      expect(activated).toHaveBeenCalledWith(expect.objectContaining({ highestPeak: peak, stopPrice }));
    });

    it('triggers on the next candle when its low reaches the stop price the activation set', () => {
      manager.update(ohlc(49000, 51000, 49000, 51000)); // Peak 51000, stop price 49980
      const listener = vi.fn();
      manager.on(TRAILING_STOP_TRIGGERED, listener);
      manager.update(ohlc(51000, 51000, 49980, 50000));
      expect(listener).toHaveBeenCalledOnce();
    });

    // The strategy hears of the activation at once, and may cancel the stop then (tools.cancelTrailingOrder). Both candles would trigger
    // the stop it does not cancel: the first at its close, met after its high, the second at its low, met after its open.
    it.each`
      desc                         | open     | high     | low      | close
      ${'opens below the trigger'} | ${48000} | ${50000} | ${48000} | ${48000}
      ${'opens at the trigger'}    | ${50000} | ${50000} | ${48000} | ${48500}
    `('does not trigger a stop a listener of its activation removed, on a candle that $desc', ({ open, high, low, close }) => {
      manager.on(TRAILING_STOP_ACTIVATED, () => manager.removeOrder(defaultId));
      manager.update(ohlc(open, high, low, close));
      expect(triggered).not.toHaveBeenCalled();
    });
  });

  /* -------------------------------------------------------------------------- */
  /*                            update – active                                 */
  /* -------------------------------------------------------------------------- */

  describe('update (active phase)', () => {
    beforeEach(() => {
      manager.addOrder(defaultOrder);
      // Activated by its high: peak 50000, stop price 49000. After that, the candle that activates a stop only meets its close.
      manager.update(makeBucket('BTC/USDT', 50000, 49500, 50000));
    });

    // A high of 52000 makes a stop price of 50960, which the close (51000) stays above; the low of the other candle (49500) stays
    // above the stop price of 49000
    it.each`
      desc                               | high     | low      | peak
      ${'updates peak when high > peak'} | ${52000} | ${51000} | ${52000}
      ${'keeps peak when high < peak'}   | ${49500} | ${49500} | ${50000}
    `('$desc', ({ high, low, peak }) => {
      manager.update(makeBucket('BTC/USDT', high, low, low));
      expect(manager.getOrders().get(defaultId)?.highestPeak).toBe(peak);
    });

    // As above: neither candle reaches the stop price
    it.each`
      desc                                       | high     | low      | stopPrice
      ${'updates stopPrice when peak increases'} | ${52000} | ${51000} | ${50960}
      ${'keeps stopPrice when peak is same'}     | ${50000} | ${49500} | ${49000}
    `('$desc', ({ high, low, stopPrice }) => {
      manager.update(makeBucket('BTC/USDT', high, low, low));
      expect(manager.getOrders().get(defaultId)?.stopPrice).toBe(stopPrice);
    });

    // Triggered, the stop is kept until its SELL ends (see 'a stop that triggered')
    describe.each`
      desc                                       | low      | times | status
      ${'triggers when low <= stopPrice'}        | ${48000} | ${1}  | ${'selling'}
      ${'does not trigger when low > stopPrice'} | ${49500} | ${0}  | ${'active'}
    `('$desc', ({ low, times, status }) => {
      let listener: Mock;

      beforeEach(() => {
        listener = vi.fn();
        manager.on(TRAILING_STOP_TRIGGERED, listener);
        manager.update(makeBucket('BTC/USDT', 50500, low, 50000));
      });

      it(`emits TRAILING_STOP_TRIGGERED ${times} time(s)`, () => {
        expect(listener).toHaveBeenCalledTimes(times);
      });

      it(`leaves the stop ${status}`, () => {
        expect(manager.getOrders().get(defaultId)?.status).toBe(status);
      });
    });
  });

  /* -------------------------------------------------------------------------- */
  /*               update – a candle after the one that activated it            */
  /* -------------------------------------------------------------------------- */

  // The order of a candle's low and high is unknown: the stop meets them low first, the low tested against the stop price of the peak
  // before it, the open included. Raised to the high first, the peak made a candle that rose more than 2% from its open trigger the
  // stop on its own low.
  describe('update (a candle after the one that activated the stop)', () => {
    let triggered: Mock;

    beforeEach(() => {
      manager.addOrder({ ...defaultOrder, trailing: { percentage: 2, trigger: 100 } });
      manager.update(ohlc(99, 100, 99, 100)); // Peak 100, stop price 98
      triggered = vi.fn();
      manager.on(TRAILING_STOP_TRIGGERED, triggered);
    });

    it.each`
      desc                                      | open   | high   | low    | close
      ${'rises 3% from its open, its low'}      | ${100} | ${103} | ${100} | ${103}
      ${'dips 1%, then rises 10% to its close'} | ${100} | ${110} | ${99}  | ${109.9}
    `('does not trigger the stop on a candle that $desc', ({ open, high, low, close }) => {
      manager.update(ohlc(open, high, low, close));
      expect(triggered).not.toHaveBeenCalled();
    });

    describe.each`
      desc                                      | open   | high     | low     | close    | peak   | stopPrice
      ${'falls below 98 before any new high'}   | ${100} | ${100.5} | ${97.9} | ${98}    | ${100} | ${98}
      ${'gaps above the peak, falls 2% below'}  | ${102} | ${102.5} | ${99.9} | ${100}   | ${102} | ${99.96}
      ${'makes a new high, closes 2% below it'} | ${100} | ${103}   | ${100}  | ${100.5} | ${103} | ${100.94}
      ${'opens below the stop price'}           | ${97}  | ${97.5}  | ${96}   | ${96.5}  | ${100} | ${98}
    `('on a candle that $desc', ({ open, high, low, close, peak, stopPrice }) => {
      beforeEach(() => {
        manager.update(ohlc(open, high, low, close));
      });

      it('triggers the stop', () => {
        expect(triggered).toHaveBeenCalledOnce();
      });

      it(`reports a peak of ${peak} and a stop price of ${stopPrice}, those its price reached`, () => {
        expect(triggered).toHaveBeenCalledWith(expect.objectContaining({ highestPeak: peak, stopPrice }));
      });
    });
  });

  /* -------------------------------------------------------------------------- */
  /*                 update – directly active (undefined trigger)               */
  /* -------------------------------------------------------------------------- */

  describe('update (directly active via undefined trigger)', () => {
    beforeEach(() => {
      manager.addOrder({ ...defaultOrder, trailing: { percentage: 2 } });
    });

    // Its low stays above the stop price of its open (48510), its close above that of its high (49000, 50000 * 0.98)
    it('updates highestPeak and stopPrice on first candle', () => {
      manager.update(makeBucket('BTC/USDT', 50000, 49500, 49500));
      expect(manager.getOrders().get(defaultId)).toEqual(expect.objectContaining({ highestPeak: 50000, stopPrice: 49000 }));
    });

    // Armed before it, the stop meets its first candle from the open: the first peak it trails, with no stop price before it
    it.each`
      outcome               | desc                                      | open     | high     | low      | close    | times
      ${'triggers'}         | ${'falls 2% below its open'}              | ${50000} | ${50000} | ${48000} | ${49500} | ${1}
      ${'does not trigger'} | ${'rises over 2% from its open, its low'} | ${48000} | ${50000} | ${48000} | ${49500} | ${0}
      ${'triggers'}         | ${'closes 2% below its high'}             | ${49000} | ${50000} | ${48900} | ${48950} | ${1}
    `('$outcome the stop on a first candle that $desc', ({ open, high, low, close, times }) => {
      const listener = vi.fn();
      manager.on(TRAILING_STOP_TRIGGERED, listener);
      manager.update(ohlc(open, high, low, close));
      expect(listener).toHaveBeenCalledTimes(times);
    });

    it('does not emit TRAILING_STOP_ACTIVATED again on its first candle', () => {
      const listener = vi.fn();
      manager.on(TRAILING_STOP_ACTIVATED, listener);
      manager.update(makeBucket('BTC/USDT', 50000, 49500, 49500));
      expect(listener).not.toHaveBeenCalled();
    });
  });

  /* -------------------------------------------------------------------------- */
  /*                         the trailing a stop keeps                          */
  /* -------------------------------------------------------------------------- */

  // Kept by reference, the strategy's object, or the config of a state a listener received, moved the stop when changed after the
  // checks of addOrder: a percentage of 150 or NaN made a stop price that never triggered
  describe('the trailing a stop keeps', () => {
    it.each`
      percentage
      ${150}
      ${NaN}
      ${0.5}
    `('does not follow a percentage of $percentage the strategy sets on its object once the stop is armed', ({ percentage }) => {
      const trailing = { percentage: 2, trigger: 50000 };
      manager.addOrder({ ...defaultOrder, trailing });
      trailing.percentage = percentage;
      manager.update(ohlc(49500, 50000, 49500, 50000)); // Activated: peak 50000
      expect(manager.getOrders().get(defaultId)?.stopPrice).toBe(49000);
    });

    it.each`
      announcement                      | trigger
      ${'its arming (no trigger)'}      | ${undefined}
      ${'the candle that activates it'} | ${50000}
    `('keeps its 2% when a listener of $announcement sets the percentage of its state to 150', ({ trigger }) => {
      manager.on(TRAILING_STOP_ACTIVATED, (state: TrailingStopState) => {
        state.config.percentage = 150;
      });
      manager.addOrder({ ...defaultOrder, trailing: { percentage: 2, trigger } });
      manager.update(ohlc(49500, 50000, 49500, 50000)); // Peak 50000
      manager.update(ohlc(50000, 52000, 50000, 51500)); // Peak 52000
      expect(manager.getOrders().get(defaultId)?.stopPrice).toBe(50960);
    });

    // A stop is kept while it sells, and trails again once its SELL fails: the state its trigger was announced with is a copy too
    it('keeps its 2% when a listener of its trigger sets the percentage of its state to 150', () => {
      const sellId = '5e115e11-0000-4000-8000-000000000001' as UUID;
      manager.on(TRAILING_STOP_TRIGGERED, (state: TrailingStopState) => {
        state.config.percentage = 150;
      });
      manager.addOrder({ ...defaultOrder, trailing: { percentage: 2 } }); // Active at once
      manager.update(ohlc(100, 100, 100, 100)); // Peak 100, stop price 98
      manager.update(ohlc(99, 99, 97, 97.5)); // Triggered by its low
      manager.setSellOrderId(defaultId, sellId);
      manager.resumeSellingStop(sellId, 0); // Its SELL failed: active again
      manager.update(ohlc(100, 150, 100, 149)); // Peak 150
      expect(manager.getOrders().get(defaultId)?.stopPrice).toBe(147);
    });
  });

  /* -------------------------------------------------------------------------- */
  /*                          a stop that triggered                             */
  /* -------------------------------------------------------------------------- */

  // Deleted at its trigger, a stop whose SELL failed (refused, an exchange error) left the position held without any stop, through the
  // whole fall: it is kept, selling, until its SELL ends
  describe('a stop that triggered', () => {
    const SELL_ID = '5e115e11-0000-4000-8000-000000000001' as UUID;
    const OTHER_SELL_ID = '5e115e11-0000-4000-8000-000000000002' as UUID;
    const OTHER_ID = '07e40000-0000-4000-8000-000000000003' as UUID;
    let triggered: Mock;

    /** The stop, as the manager keeps it */
    const stop = () => manager.getOrders().get(defaultId);

    beforeEach(() => {
      triggered = vi.fn();
      manager.on(TRAILING_STOP_TRIGGERED, triggered);
      manager.addOrder({ ...defaultOrder, trailing: { percentage: 2 } }); // Active at once, for 0.5
      manager.update(ohlc(100, 100, 100, 100)); // Peak 100, stop price 98
      manager.update(ohlc(99, 99, 97, 97.5)); // Its low goes through 98
    });

    it('is kept, selling', () => {
      expect(stop()?.status).toBe('selling');
    });

    it('announces its trigger with the state it sells in', () => {
      expect(triggered).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: defaultId, status: 'selling', amount: 0.5, highestPeak: 100, stopPrice: 98 }),
      );
    });

    // Its SELL is sent: trailed on, it sent another one on the next candle below its stop price
    it('is not triggered again by a candle that falls further', () => {
      manager.update(ohlc(96, 96, 90, 91));
      expect(triggered).toHaveBeenCalledOnce();
    });

    it('keeps its peak on a candle that rises above it', () => {
      manager.update(ohlc(100, 110, 100, 108));
      expect(stop()?.highestPeak).toBe(100);
    });

    describe('setSellOrderId', () => {
      it('records the SELL sent for it', () => {
        manager.setSellOrderId(defaultId, SELL_ID);
        expect(stop()?.sellOrderId).toBe(SELL_ID);
      });

      it('returns the stop selling through that SELL', () => {
        expect(manager.setSellOrderId(defaultId, SELL_ID)).toEqual(
          expect.objectContaining({ id: defaultId, status: 'selling', sellOrderId: SELL_ID }),
        );
      });

      it('returns a copy of the stop, not the stop it keeps', () => {
        expect(manager.setSellOrderId(defaultId, SELL_ID)).not.toBe(stop());
      });

      it.each`
        desc                         | id
        ${'a stop not selling'}      | ${OTHER_ID}
        ${'a stop it does not keep'} | ${'ffffffff-0000-4000-8000-000000000009'}
      `('returns nothing for $desc', ({ id }) => {
        manager.addOrder({ ...defaultOrder, id: OTHER_ID, trailing: { percentage: 2 } });
        expect(manager.setSellOrderId(id, SELL_ID)).toBeUndefined();
      });

      it('records no SELL on a stop that is not selling', () => {
        manager.addOrder({ ...defaultOrder, id: OTHER_ID, trailing: { percentage: 2 } });
        manager.setSellOrderId(OTHER_ID, SELL_ID);
        expect(manager.getOrders().get(OTHER_ID)).not.toHaveProperty('sellOrderId');
      });
    });

    describe('removeSellingStop, once its SELL completes', () => {
      beforeEach(() => {
        manager.setSellOrderId(defaultId, SELL_ID);
      });

      it('removes it', () => {
        manager.removeSellingStop(SELL_ID);
        expect(manager.getOrders().has(defaultId)).toBe(false);
      });

      it('says it removed one', () => {
        expect(manager.removeSellingStop(SELL_ID)).toBe(true);
      });

      it('keeps it when another SELL completes', () => {
        manager.removeSellingStop(OTHER_SELL_ID);
        expect(stop()?.status).toBe('selling');
      });

      it('says it removed none for another SELL', () => {
        expect(manager.removeSellingStop(OTHER_SELL_ID)).toBe(false);
      });
    });

    // Errored (refused, an exchange error) or canceled, after it sold part of what the stop protected, or nothing reported
    describe.each`
      sold   | amount
      ${0}   | ${0.5}
      ${0.2} | ${0.3}
      ${NaN} | ${0.5}
    `('resumeSellingStop, once its SELL ends without completing, $sold sold', ({ sold, amount }) => {
      let resumed: TrailingStopState | undefined;

      beforeEach(() => {
        manager.setSellOrderId(defaultId, SELL_ID);
        resumed = manager.resumeSellingStop(SELL_ID, sold);
      });

      it('makes it active again', () => {
        expect(stop()?.status).toBe('active');
      });

      it(`leaves it ${amount} to sell, what its SELL did not sell`, () => {
        expect(stop()?.amount).toBe(amount);
      });

      it('keeps the peak and the stop price it triggered at', () => {
        expect(stop()).toEqual(expect.objectContaining({ highestPeak: 100, stopPrice: 98 }));
      });

      it('forgets its SELL', () => {
        expect(stop()).not.toHaveProperty('sellOrderId');
      });

      it('returns the stop active again', () => {
        expect(resumed).toEqual(stop());
      });

      it('returns a copy of the stop, not the stop it keeps', () => {
        expect(resumed).not.toBe(stop());
      });

      it('triggers it again on the open of the next candle at or below its stop price', () => {
        manager.update(ohlc(98, 98.5, 97, 97.5));
        expect(triggered).toHaveBeenCalledTimes(2);
      });

      it('announces that trigger for what its SELL did not sell', () => {
        manager.update(ohlc(98, 98.5, 97, 97.5));
        expect(triggered).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'selling', amount }));
      });

      it('trails again: a new high raises its stop price', () => {
        manager.update(ohlc(100, 150, 100, 149));
        expect(stop()?.stopPrice).toBe(147);
      });
    });

    describe.each`
      sold
      ${0.5}
      ${0.6}
    `('resumeSellingStop, once its SELL ends without completing after selling $sold, all of its 0.5', ({ sold }) => {
      let resumed: TrailingStopState | undefined;

      beforeEach(() => {
        manager.setSellOrderId(defaultId, SELL_ID);
        resumed = manager.resumeSellingStop(SELL_ID, sold);
      });

      it('removes it', () => {
        expect(manager.getOrders().has(defaultId)).toBe(false);
      });

      it('returns nothing', () => {
        expect(resumed).toBeUndefined();
      });

      it('says so at info level', () => {
        expect(info).toHaveBeenCalledExactlyOnceWith(
          'trailing stop',
          `Trailing stop of BUY ${defaultId} over: its SELL ${SELL_ID} sold ${sold}, all of its 0.5`,
        );
      });
    });

    // 0.3 - 0.1 is 0.19999999999999998 in floating point: a SELL of that, truncated to the step of the market, left a step unsold
    it('leaves what its SELL did not sell without the noise of floating point', () => {
      manager.addOrder({ ...defaultOrder, id: OTHER_ID, amount: 0.3, trailing: { percentage: 2 } });
      manager.update(ohlc(100, 100, 100, 100));
      manager.update(ohlc(99, 99, 97, 97.5));
      manager.setSellOrderId(OTHER_ID, OTHER_SELL_ID);
      manager.resumeSellingStop(OTHER_SELL_ID, 0.1);
      expect(manager.getOrders().get(OTHER_ID)?.amount).toBe(0.2);
    });

    it('resumeSellingStop returns nothing for a SELL no stop sells through', () => {
      manager.setSellOrderId(defaultId, SELL_ID);
      expect(manager.resumeSellingStop(OTHER_SELL_ID, 0)).toBeUndefined();
    });

    it('resumeSellingStop leaves as it is the stop selling through another SELL', () => {
      manager.setSellOrderId(defaultId, SELL_ID);
      manager.resumeSellingStop(OTHER_SELL_ID, 0);
      expect(stop()?.status).toBe('selling');
    });

    // Canceled by the strategy while it sold: its SELL is the strategy's
    describe('resumeSellingStop, once its SELL ends after the stop was removed', () => {
      let resumed: TrailingStopState | undefined;

      beforeEach(() => {
        manager.setSellOrderId(defaultId, SELL_ID);
        manager.removeOrder(defaultId);
        resumed = manager.resumeSellingStop(SELL_ID, 0);
      });

      it('returns nothing', () => {
        expect(resumed).toBeUndefined();
      });

      it('does not bring it back', () => {
        expect(manager.getOrders().has(defaultId)).toBe(false);
      });
    });
  });

  /* -------------------------------------------------------------------------- */
  /*                    a stop whose trigger is held back                       */
  /* -------------------------------------------------------------------------- */

  // The StrategyManager holds back the stops of a pair while a SELL the strategy created is pending there: the exchange reserves the
  // asset for that SELL, and a stop that triggered meanwhile had its own SELL refused, minute after minute, until the circuit breaker
  // stopped the bot
  describe('a stop whose trigger is held back', () => {
    let isTriggerHeld: Mock;
    let triggered: Mock;

    beforeEach(() => {
      isTriggerHeld = vi.fn(() => true);
      manager = new TrailingStopManager(isTriggerHeld);
      triggered = vi.fn();
      manager.on(TRAILING_STOP_TRIGGERED, triggered);
    });

    describe('once active', () => {
      /** The stop, as the manager keeps it */
      const stop = () => manager.getOrders().get(defaultId);

      beforeEach(() => {
        manager.addOrder({ ...defaultOrder, trailing: { percentage: 2 } }); // Active at once, for 0.5
        manager.update(ohlc(100, 100, 100, 100)); // Peak 100, stop price 98
      });

      it('is not triggered by a candle that goes through its stop price', () => {
        manager.update(ohlc(99, 99, 97, 97.5));
        expect(triggered).not.toHaveBeenCalled();
      });

      it('stays active', () => {
        manager.update(ohlc(99, 99, 97, 97.5));
        expect(stop()?.status).toBe('active');
      });

      // Met as open, low, high, close: the low is the first of its prices at or below 98
      it('asks the hold first with the stop and the first price that reached its stop price', () => {
        manager.update(ohlc(99, 99, 97, 97.5));
        expect(isTriggerHeld).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: defaultId, highestPeak: 100, stopPrice: 98 }), 97);
      });

      it('asks the hold with a copy of the stop, not the stop it keeps', () => {
        manager.update(ohlc(99, 99, 97, 97.5));
        expect(isTriggerHeld.mock.calls[0][0]).not.toBe(stop());
      });

      it('does not ask the hold while no price reaches its stop price', () => {
        manager.update(ohlc(99, 101, 98.5, 100));
        expect(isTriggerHeld).not.toHaveBeenCalled();
      });

      // The low (97) is held back, then the high raises the peak to 105 and the stop price to 102.9, above the close
      it('trails on: a later price of the candle raises its peak', () => {
        manager.update(ohlc(99, 105, 97, 104));
        expect(stop()?.highestPeak).toBe(105);
      });

      it('is triggered by the next price at or below its stop price once the hold is lifted', () => {
        manager.update(ohlc(99, 99, 97, 97.5));
        isTriggerHeld.mockReturnValue(false);
        manager.update(ohlc(97.9, 98, 97, 97.5));
        expect(triggered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: defaultId, status: 'selling', stopPrice: 98 }));
      });
    });

    // Opens at the trigger and falls 2% below: without a hold, the stop triggers on that very candle (peak 50000, stop price 49000)
    describe('on the candle that activates it', () => {
      beforeEach(() => {
        manager.addOrder(defaultOrder); // Trigger 50000, 2%
        manager.update(ohlc(50000, 50200, 48900, 49000));
      });

      it('activates it', () => {
        expect(manager.getOrders().get(defaultId)?.status).toBe('active');
      });

      it('does not trigger it', () => {
        expect(triggered).not.toHaveBeenCalled();
      });
    });
  });

  /* -------------------------------------------------------------------------- */
  /*                              removeOrder                                   */
  /* -------------------------------------------------------------------------- */

  describe('removeOrder', () => {
    it('removes existing order', () => {
      manager.addOrder(defaultOrder);
      manager.removeOrder(defaultId);
      expect(manager.getOrders().size).toBe(0);
    });

    it('returns true for existing order', () => {
      manager.addOrder(defaultOrder);
      expect(manager.removeOrder(defaultId)).toBe(true);
    });

    it('returns false for non-existent order', () => {
      expect(manager.removeOrder('fake-id' as UUID)).toBe(false);
    });
  });
});
