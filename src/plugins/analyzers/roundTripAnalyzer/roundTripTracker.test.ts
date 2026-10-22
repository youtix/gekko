import { ONE_MINUTE } from '@constants/time.const';
import { Candle } from '@models/candle.types';
import { OrderCanceledEvent, OrderCompletedEvent, RoundTrip } from '@models/event.types';
import { OrderSide, OrderType } from '@models/order.types';
import { Portfolio } from '@models/portfolio.types';
import { debug, info, warning } from '@services/logger';
import { beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { OpenRoundTrip } from './roundTrip.types';
import { LATE_FILL_CANDLES } from './roundTripAnalyzer.const';
import { RoundTripTracker } from './roundTripTracker';

vi.mock('@services/logger');

/** A portfolio the Trader read: what it holds of BTC is what the account holds after a SELL (see registerSell) */
const holding = (btc: number): Portfolio =>
  new Map([
    ['BTC', { free: btc, used: 0, total: btc }],
    ['USDT', { free: 1000, used: 0, total: 1000 }],
  ]);
/** The portfolio the orders below carry unless a test gives another: the account holds no BTC after them */
const READ = holding(0);
/** The empty portfolio the Trader starts with, which the end of an order carries until one of its synchronizations succeeds */
const NOT_READ: Portfolio = new Map();

/** An order of BTC/USDT completed at the given minute, with its fee in currency (undefined when the test leaves it out) */
const completed = (side: OrderSide, minute: number, price: number | undefined, amount: number, fee?: number) =>
  ({
    id: `${side}-${minute}`,
    symbol: 'BTC/USDT',
    side,
    type: 'MARKET',
    price,
    amount,
    fee,
    effectivePrice: price,
    orderCreationDate: minute * ONE_MINUTE,
    orderExecutionDate: minute * ONE_MINUTE,
  }) as OrderCompletedEvent['order'];
/**
 * An order of 10 BTC/USDT canceled at the given minute, with the price the strategy asked for, if any: a LIMIT order unless the test
 * gives another type, and the mean price of its fills when the test gives one, as the Trader relays it
 */
const canceled = (
  side: OrderSide,
  minute: number,
  price?: number,
  { type = 'LIMIT', fillPrice }: { type?: OrderType; fillPrice?: number } = {},
) =>
  ({
    id: `${side}-${minute}`,
    symbol: 'BTC/USDT',
    side,
    type,
    price,
    amount: 10,
    fillPrice,
    orderCreationDate: minute * ONE_MINUTE,
    orderCancelationDate: minute * ONE_MINUTE,
  }) as OrderCanceledEvent['order'];
/** The one-minute candle of BTC/USDT of a minute, flat at its close but for its low */
const candleAt = (minute: number, close: number, low = close): Candle => ({
  start: minute * ONE_MINUTE,
  open: close,
  high: close,
  low,
  close,
  volume: 1,
});

describe('RoundTripTracker', () => {
  /** The whole portfolio's value the analyzer gives the tracker: 999.9 whatever the portfolio and the price, unless a test says */
  let valuePortfolio: Mock<(portfolio: Portfolio, price: number) => number>;
  let nextId: number;
  let tracker: RoundTripTracker;

  const buy = (minute: number, price: number | undefined, amount: number, fee?: number, portfolio = READ) =>
    tracker.registerCompleted(completed('BUY', minute, price, amount, fee), portfolio);
  const sell = (minute: number, price: number | undefined, amount: number, fee?: number, portfolio = READ) =>
    tracker.registerCompleted(completed('SELL', minute, price, amount, fee), portfolio);
  const openRoundTrip = () => tracker['openRoundTrip'];

  beforeEach(() => {
    nextId = 0;
    valuePortfolio = vi.fn(() => 999.9);
    tracker = new RoundTripTracker({
      symbol: 'BTC/USDT',
      asset: 'BTC',
      currency: 'USDT',
      valuePortfolio,
      nextRoundTripId: () => nextId++,
    });
  });

  describe('constructor', () => {
    it.each`
      property    | expected
      ${'symbol'} | ${'BTC/USDT'}
      ${'asset'}  | ${'BTC'}
    `('should keep its $property, $expected', ({ property, expected }) => {
      expect(tracker[property as 'symbol' | 'asset']).toBe(expected);
    });

    it.each`
      reader                | expected
      ${'closedRoundTrips'} | ${[]}
      ${'tradeCount'}       | ${0}
    `('should start with $reader $expected', ({ reader, expected }) => {
      expect(tracker[reader as 'closedRoundTrips' | 'tradeCount']).toEqual(expected);
    });
  });

  describe('registerCompleted', () => {
    describe('BUY while flat', () => {
      it('should open a round trip at its date, price and amount, with its cost and its fee, entered with the portfolio before it', () => {
        buy(1, 100, 2, 0.1);
        expect(openRoundTrip()).toEqual({
          entryOrderId: 'BUY-1',
          entryAt: ONE_MINUTE,
          entryPrice: 100,
          // The whole portfolio's value after the BUY, 999.9, plus its fee, which the BUY took from it
          entryEquity: 1000,
          bought: 2,
          sold: 0,
          cost: 200,
          proceeds: 0,
          fees: 0.1,
          exitPrice: 0,
          maxAdverseExcursion: 0,
          excursionDeepenings: [],
        });
      });

      it('should value the portfolio its event carries, read after it, its pair at the price of the BUY', () => {
        buy(1, 100, 2, 0.1, holding(2));
        expect(valuePortfolio).toHaveBeenCalledExactlyOnceWith(holding(2), 100);
      });

      it.each`
        fee          | description
        ${undefined} | ${'an unknown fee'}
        ${NaN}       | ${'a fee that is not a number'}
      `('should count $description as 0, in its fees and in its entry equity', ({ fee }) => {
        buy(1, 100, 2, fee);
        expect({ fees: openRoundTrip()?.fees, entryEquity: openRoundTrip()?.entryEquity }).toEqual({ fees: 0, entryEquity: 999.9 });
      });

      it('should count it as a trade', () => {
        buy(1, 100, 2);
        expect(tracker.tradeCount).toBe(1);
      });

      it('should return no round trip', () => {
        expect(buy(1, 100, 2)).toBeUndefined();
      });

      // The empty portfolio the Trader starts with holds none of the account's balances: valued, it made the entry equity the fee alone,
      // 0.1 for a BUY of 1 BTC at 100, and its round trip, sold at 110, +9,790 %
      describe('when its event carries the empty portfolio of a Trader that had read none yet', () => {
        beforeEach(() => {
          buy(1, 100, 2, 0.1, NOT_READ);
        });

        it('should open the round trip with an unknown entry equity', () => {
          expect(openRoundTrip()?.entryEquity).toBeNaN();
        });

        it('should value no portfolio', () => {
          expect(valuePortfolio).not.toHaveBeenCalled();
        });
      });
    });

    describe('BUY while a round trip is open (scale-in)', () => {
      beforeEach(() => {
        buy(1, 100, 1, 0.1);
        tracker['openRoundTrip']!.maxAdverseExcursion = 5;
        valuePortfolio.mockReturnValue(500);
        buy(3, 130, 2, 0.2);
      });

      it.each`
        field                    | expected      | description
        ${'entryAt'}             | ${ONE_MINUTE} | ${'the date of the first BUY'}
        ${'entryPrice'}          | ${120}        | ${'the mean price of both BUYs, weighted by their amounts'}
        ${'entryEquity'}         | ${1000}       | ${'the portfolio before the first BUY, whatever the second one changed'}
        ${'bought'}              | ${3}          | ${'the amount of both BUYs'}
        ${'cost'}                | ${360}        | ${'1 at 100 and 2 at 130'}
        ${'fees'}                | ${0.3}        | ${'the fees of both BUYs, in decimal: 0.30000000000000004 in binary'}
        ${'maxAdverseExcursion'} | ${5}          | ${'the adverse excursion so far'}
      `('should keep the round trip open with $field $expected: $description', ({ field, expected }) => {
        expect(openRoundTrip()?.[field as keyof OpenRoundTrip]).toBe(expected);
      });

      it('should value no portfolio for it', () => {
        expect(valuePortfolio).toHaveBeenCalledOnce();
      });
    });

    describe('invalid fills', () => {
      it.each`
        price        | amount | description
        ${undefined} | ${1}   | ${'missing price'}
        ${NaN}       | ${1}   | ${'NaN price'}
        ${0}         | ${1}   | ${'zero price'}
        ${-1}        | ${1}   | ${'negative price'}
        ${100}       | ${NaN} | ${'NaN amount'}
        ${100}       | ${0}   | ${'zero amount'}
      `('should warn that an order with a $description is skipped', ({ price, amount }) => {
        buy(1, price, amount);
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          'roundtrip analyzer',
          'Order BUY-1 filled without a valid price or amount. Skipping roundtrip update.',
        );
      });

      it.each`
        side      | price  | amount
        ${'BUY'}  | ${NaN} | ${1}
        ${'BUY'}  | ${100} | ${NaN}
        ${'SELL'} | ${NaN} | ${1}
        ${'SELL'} | ${100} | ${0}
      `('should leave the round trip untouched when a $side has price $price and amount $amount', ({ side, price, amount }) => {
        buy(1, 100, 1);
        const before = structuredClone(openRoundTrip());
        tracker.registerCompleted(completed(side, 2, price, amount), READ);
        expect(openRoundTrip()).toEqual(before);
      });
    });

    describe('SELL of a part of the position', () => {
      let closed: RoundTrip | undefined;
      beforeEach(() => {
        buy(1, 100, 2, 0.2);
        closed = sell(3, 110, 0.5, 0.055, holding(1.5));
      });

      it.each`
        field          | expected | description
        ${'sold'}      | ${0.5}   | ${'what it sold'}
        ${'proceeds'}  | ${55}    | ${'0.5 at 110'}
        ${'fees'}      | ${0.255} | ${'the fees of the BUY and of the SELL'}
        ${'exitPrice'} | ${110}   | ${'the price of the SELL'}
      `('should keep the round trip open with $field $expected: $description', ({ field, expected }) => {
        expect(openRoundTrip()?.[field as keyof OpenRoundTrip]).toBe(expected);
      });

      it('should return no round trip', () => {
        expect(closed).toBeUndefined();
      });

      it('should close none', () => {
        expect(tracker.closedRoundTrips).toEqual([]);
      });
    });

    describe('BUY, BUY, then SELL of both, which closes the round trip', () => {
      let closed: RoundTrip | undefined;
      beforeEach(() => {
        buy(1, 100, 1, 0.1);
        buy(2, 120, 1, 0.12);
        closed = sell(4, 130, 2, 0.26);
      });

      it('should return the round trip, its P&L from its fills', () => {
        expect(closed).toEqual({
          id: 0,
          symbol: 'BTC/USDT',
          entryAt: ONE_MINUTE,
          entryPrice: 110,
          entryEquity: 1000,
          exitAt: 4 * ONE_MINUTE,
          exitPrice: 130,
          // 1 at 100 and 1 at 120
          cost: 220,
          // 2 at 130
          proceeds: 260,
          // 0.1 + 0.12 + 0.26
          fees: 0.48,
          duration: 3 * ONE_MINUTE,
          maxAdverseExcursion: 0,
          // 39.52 in % of 1,000
          profit: 3.952,
          // 260 - 220 - 0.48
          pnl: 39.52,
        });
      });

      it('should keep it among the round trips closed', () => {
        expect(tracker.closedRoundTrips).toEqual([closed]);
      });

      it('should be flat again', () => {
        expect(openRoundTrip()).toBeNull();
      });

      it('should count the three fills as trades', () => {
        expect(tracker.tradeCount).toBe(3);
      });
    });

    describe.each`
      scenario                                   | orders                                                                     | entryPrice | exitAt | exitPrice | cost   | proceeds
      ${'BUY, SELL'}                             | ${() => [buy(1, 100, 1), sell(5, 120, 1)]}                                 | ${100}     | ${5}   | ${120}    | ${100} | ${120}
      ${'BUY, SELL of a part, SELL of the rest'} | ${() => [buy(1, 100, 2), sell(3, 110, 1, 0, holding(1)), sell(5, 130, 1)]} | ${100}     | ${5}   | ${120}    | ${200} | ${240}
      ${'BUY, SELL, SELL'}                       | ${() => [buy(1, 100, 1), sell(5, 120, 1), sell(8, 150, 1)]}                | ${100}     | ${5}   | ${120}    | ${100} | ${120}
    `('after $scenario', ({ orders, entryPrice, exitAt, exitPrice, cost, proceeds }) => {
      beforeEach(() => {
        orders();
      });

      it('should close exactly one round trip', () => {
        expect(tracker.closedRoundTrips).toHaveLength(1);
      });

      it(`should enter at the mean price of the BUYs, weighted by their amounts: ${entryPrice}`, () => {
        expect(tracker.closedRoundTrips[0].entryPrice).toBe(entryPrice);
      });

      it(`should exit at the date of the SELL that leaves it flat: minute ${exitAt}`, () => {
        expect(tracker.closedRoundTrips[0].exitAt).toBe(exitAt * ONE_MINUTE);
      });

      it(`should exit at the mean price of its SELLs, weighted by their amounts: ${exitPrice}`, () => {
        expect(tracker.closedRoundTrips[0].exitPrice).toBe(exitPrice);
      });

      it(`should cost what its BUYs paid, ${cost}`, () => {
        expect(tracker.closedRoundTrips[0].cost).toBe(cost);
      });

      it(`should bring in what its SELLs sold for, ${proceeds}`, () => {
        expect(tracker.closedRoundTrips[0].proceeds).toBe(proceeds);
      });
    });

    describe('amounts and prices with decimals', () => {
      // 0.1 BTC bought at 100.01 and 0.2 at 100.02, then sold, 0.1 at 100.03 and 0.2 at 100.04
      beforeEach(() => {
        buy(1, 100.01, 0.1);
        buy(2, 100.02, 0.2);
        sell(3, 100.03, 0.1, 0, holding(0.2));
        sell(4, 100.04, 0.2);
      });

      it.each`
        field         | expected  | description
        ${'cost'}     | ${30.005} | ${'10.001 + 20.004, in decimal: 30.005000000000003 in binary'}
        ${'proceeds'} | ${30.011} | ${'10.003 + 20.008, in decimal: 30.011000000000003 in binary'}
        ${'pnl'}      | ${0.006}  | ${'30.011 - 30.005'}
      `('should close the round trip with $field $expected: $description', ({ field, expected }) => {
        expect(tracker.closedRoundTrips[0][field as keyof RoundTrip]).toBe(expected);
      });
    });

    describe('SELL while a round trip is open', () => {
      it.each`
        sold     | held        | closes   | description
        ${1}     | ${0}        | ${true}  | ${'sells it all'}
        ${1}     | ${100}      | ${true}  | ${'sells it all, the account still holding what it held before'}
        ${0.995} | ${0.005}    | ${true}  | ${'leaves dust, at most 1 % of the amount bought'}
        ${0.98}  | ${0.02}     | ${false} | ${'leaves more than 1 % of the amount bought'}
        ${0.5}   | ${100}      | ${false} | ${'sells half, the account still holding what it held before'}
        ${0.5}   | ${0}        | ${true}  | ${'sells half, the account holding no more (the other half was sold unseen)'}
        ${0.5}   | ${NOT_READ} | ${false} | ${'sells half, the Trader having read no portfolio: what the account holds is unknown'}
        ${1}     | ${NOT_READ} | ${true}  | ${'sells it all, the Trader having read no portfolio'}
      `('should close the round trip ($closes) when it $description', ({ sold, held, closes }) => {
        buy(1, 100, 1);
        sell(3, 110, sold, 0, typeof held === 'number' ? holding(held) : held);
        expect(tracker.closedRoundTrips).toHaveLength(closes ? 1 : 0);
      });

      it('should start the adverse excursion of the next round trip at 0', () => {
        buy(1, 100, 1);
        tracker['openRoundTrip']!.maxAdverseExcursion = 5;
        sell(3, 110, 1);
        buy(5, 105, 1);
        expect(openRoundTrip()?.maxAdverseExcursion).toBe(0);
      });

      it('should number the round trips it closes with the ids the analyzer draws, one after the other', () => {
        nextId = 7;
        buy(1, 100, 1);
        sell(2, 110, 1);
        buy(3, 100, 1);
        sell(4, 110, 1);
        expect(tracker.closedRoundTrips.map(({ id }) => id)).toEqual([7, 8]);
      });
    });

    describe('break-even and unknown profit', () => {
      it.each`
        sellPrice | sellFee | field       | expected | description
        ${100}    | ${0}    | ${'pnl'}    | ${0}     | ${'sold back at its own price without a fee: a break-even'}
        ${100}    | ${0}    | ${'profit'} | ${0}     | ${'sold back at its own price without a fee: a break-even'}
        ${100}    | ${0.1}  | ${'pnl'}    | ${-0.1}  | ${'sold back at its own price for a fee: a loss of the fee'}
        ${100.1}  | ${0.1}  | ${'pnl'}    | ${0}     | ${'sold for its fee more: a break-even'}
      `(
        'should close a round trip of 1 BTC bought at 100 with $field $expected when $description',
        ({ sellPrice, sellFee, field, expected }) => {
          valuePortfolio.mockReturnValue(1000);
          buy(1, 100, 1);
          sell(2, sellPrice, 1, sellFee);
          expect(tracker.closedRoundTrips[0][field as keyof RoundTrip]).toBe(expected);
        },
      );

      describe('when its BUY carried the empty portfolio of a Trader that had read none yet', () => {
        beforeEach(() => {
          buy(1, 100, 1, 0.1, NOT_READ);
          sell(2, 110, 1, 0.11);
        });

        it.each`
          field            | expected | description
          ${'entryEquity'} | ${NaN}   | ${'unknown'}
          ${'profit'}      | ${NaN}   | ${'unknown, without a base'}
          ${'pnl'}         | ${9.79}  | ${'known from its fills: 110 - 100 - 0.21'}
        `('should close it with $field $expected: $description', ({ field, expected }) => {
          expect(tracker.closedRoundTrips[0][field as keyof RoundTrip]).toBe(expected);
        });

        it('should warn that it is left out of the returns, naming the BUY that opened it', () => {
          expect(warning).toHaveBeenCalledExactlyOnceWith(
            'roundtrip analyzer',
            'Round trip 0 on BTC/USDT left out of the returns, its profit unknown: the Trader had read no portfolio when BUY order BUY-1 opened it.',
          );
        });
      });

      it('should not warn of a round trip whose profit is known', () => {
        buy(1, 100, 1);
        sell(2, 110, 1);
        expect(warning).not.toHaveBeenCalled();
      });
    });

    describe('adverse excursion of the round trip it closes', () => {
      // Two candles deepened its excursion before the SELL was heard: that of minute 1, which closed at minute 2, to 5 %, then that of
      // minute 4, which closed at minute 5, to 20 %
      it.each`
        exitAt | excursion | description
        ${1}   | ${0}      | ${'before either closed: both taken back'}
        ${3}   | ${5}      | ${'between their closes: the second taken back'}
        ${5}   | ${20}     | ${'as the second closed: both kept'}
      `(
        'should close it with an adverse excursion of $excursion % when the SELL filled at minute $exitAt, $description',
        ({ exitAt, excursion }) => {
          buy(0, 100, 1);
          tracker.readCandle(candleAt(1, 100, 95), true);
          tracker.readCandle(candleAt(4, 100, 80), true);
          sell(exitAt, 110, 1);
          expect(tracker.closedRoundTrips[0].maxAdverseExcursion).toBe(excursion);
        },
      );
    });

    describe('SELL while flat', () => {
      it('should skip a SELL before any trade, which sells a position held before: no trade counted', () => {
        sell(1, 100, 1);
        expect(tracker.tradeCount).toBe(0);
      });

      it('should log nothing of a SELL before any trade', () => {
        sell(1, 100, 1);
        expect(debug).not.toHaveBeenCalled();
      });

      it.each`
        flat                                   | before
        ${'after a round trip has ended'}      | ${() => [buy(1, 100, 1), sell(3, 110, 1)]}
        ${'after a BUY skipped for its price'} | ${() => [buy(1, NaN, 1)]}
      `('should skip a SELL $flat with a debug log', ({ before }) => {
        before();
        sell(5, 150, 1);
        expect(debug).toHaveBeenCalledWith('roundtrip analyzer', 'SELL order SELL-5 filled while no round trip is open: skipped.');
      });

      it('should count a SELL skipped after a round trip has ended as a trade', () => {
        buy(1, 100, 1);
        sell(3, 110, 1);
        sell(5, 150, 1);
        expect(tracker.tradeCount).toBe(3);
      });

      it('should open the round trip with a BUY that follows a skipped SELL', () => {
        sell(1, 90, 1);
        buy(2, 100, 1);
        expect(openRoundTrip()?.entryPrice).toBe(100);
      });
    });
  });

  describe('registerCanceled', () => {
    // The last close is 90: the price of a fill without the prices the exchange reported for it, unless a LIMIT order gives its own
    beforeEach(() => {
      tracker.readCandle(candleAt(1, 90), false);
    });
    const FILLS = 'the prices of its fills, as the exchange reported them';

    // A MARKET or a STICKY order fills at the market: the price it carries, 100, is the one the strategy sized it from (a BUY by cost or
    // allocation), at which the part it filled counted, its round trip entering at 100 with coins bought at 95
    describe.each`
      order                                                    | event                                                         | price   | source
      ${'a LIMIT order at 100'}                                | ${canceled('BUY', 2, 100)}                                    | ${100}  | ${'its limit price'}
      ${'a LIMIT order without a price'}                       | ${canceled('BUY', 2)}                                         | ${90}   | ${'the last close'}
      ${'a LIMIT order at 100, its fills at 99.5'}             | ${canceled('BUY', 2, 100, { fillPrice: 99.5 })}               | ${99.5} | ${FILLS}
      ${'a STICKY order sized at 100, its fills at 95'}        | ${canceled('BUY', 2, 100, { type: 'STICKY', fillPrice: 95 })} | ${95}   | ${FILLS}
      ${'a STICKY order sized at 100, no fill price reported'} | ${canceled('BUY', 2, 100, { type: 'STICKY' })}                | ${90}   | ${'the last close'}
      ${'a MARKET order sized at 100, no fill price reported'} | ${canceled('BUY', 2, 100, { type: 'MARKET' })}                | ${90}   | ${'the last close'}
    `('BUY canceled after filling 4 of 10, $order', ({ event, price, source }) => {
      let closed: RoundTrip | undefined;
      beforeEach(() => {
        closed = tracker.registerCanceled(event, 4, READ);
      });

      it(`should open a round trip with the part filled, at ${price}, dated at the cancelation, its fee unknown and counted as 0`, () => {
        expect(openRoundTrip()).toEqual({
          entryOrderId: 'BUY-2',
          entryAt: 2 * ONE_MINUTE,
          entryPrice: price,
          entryEquity: 999.9,
          bought: 4,
          sold: 0,
          cost: 4 * price,
          proceeds: 0,
          fees: 0,
          exitPrice: 0,
          maxAdverseExcursion: 0,
          excursionDeepenings: [],
        });
      });

      it('should value the portfolio after it at the price of the fill', () => {
        expect(valuePortfolio).toHaveBeenCalledExactlyOnceWith(READ, price);
      });

      it('should count the fill as a trade', () => {
        expect(tracker.tradeCount).toBe(1);
      });

      it('should return no round trip', () => {
        expect(closed).toBeUndefined();
      });

      it(`should log the fill at debug, at ${price} (${source})`, () => {
        expect(debug).toHaveBeenCalledWith(
          'roundtrip analyzer',
          `BUY order BUY-2 canceled after a partial fill: its 4 filled count at ${price} (${source}), fee unknown.`,
        );
      });
    });

    // A SELL by cost carries the price the strategy sized it from, 110: its round trip exited there, its P&L off for coins sold at 112
    describe.each`
      order                                                    | event                                                           | price  | pnl
      ${'a LIMIT order at 110'}                                | ${canceled('SELL', 3, 110)}                                     | ${110} | ${40}
      ${'a STICKY order sized at 110, its fills at 112'}       | ${canceled('SELL', 3, 110, { type: 'STICKY', fillPrice: 112 })} | ${112} | ${48}
      ${'a MARKET order sized at 110, no fill price reported'} | ${canceled('SELL', 3, 110, { type: 'MARKET' })}                 | ${90}  | ${-40}
    `('SELL canceled after a partial fill that sells what a round trip bought, $order', ({ event, price, pnl }) => {
      let closed: RoundTrip | undefined;
      beforeEach(() => {
        buy(1, 100, 4);
        closed = tracker.registerCanceled(event, 4, READ);
      });

      it('should end the round trip and return it', () => {
        expect(closed).toBe(tracker.closedRoundTrips[0]);
      });

      it(`should exit at ${price}`, () => {
        expect(closed?.exitPrice).toBe(price);
      });

      it(`should make a P&L of ${pnl}, 4 bought at 100 and sold at ${price}, the fee of the SELL unknown`, () => {
        expect(closed?.pnl).toBe(pnl);
      });
    });

    it('should skip a SELL canceled after a partial fill while flat, before any trade', () => {
      tracker.registerCanceled(canceled('SELL', 2, 100), 4, READ);
      expect(tracker.tradeCount).toBe(0);
    });
  });

  describe('readCandle', () => {
    it('should keep the close of the candle as the last price, before the period too', () => {
      tracker.readCandle(candleAt(1, 90), false);
      expect(tracker['lastClose']).toBe(90);
    });

    describe('in the period', () => {
      it.each`
        excursion | low   | description
        ${25}     | ${75} | ${'deepens to 25 % for a low of 75'}
        ${5}      | ${95} | ${'stays at 5 % for a low of 95, above the deepest so far'}
      `('should count a candle in the adverse excursion of the round trip in progress, which $description', ({ excursion, low }) => {
        buy(1, 100, 1);
        tracker['openRoundTrip']!.maxAdverseExcursion = 5;
        tracker.readCandle(candleAt(1, 90, low), true);
        expect(openRoundTrip()?.maxAdverseExcursion).toBe(excursion);
      });

      it('should measure the adverse excursion from the mean price of the BUYs after a scale-in', () => {
        buy(1, 100, 1);
        buy(1, 80, 1);
        tracker.readCandle(candleAt(1, 85, 81), true);
        // (90 - 81) / 90
        expect(openRoundTrip()?.maxAdverseExcursion).toBeCloseTo(10, 12);
      });

      // Read after the BUY was heard, as a live stream catching up on minutes it fell behind on reads it
      it('should not count a candle that closed by the time the BUY filled', () => {
        buy(3, 100, 1);
        tracker.readCandle(candleAt(2, 90, 80), true);
        expect(openRoundTrip()?.maxAdverseExcursion).toBe(0);
      });

      it('should note a candle that deepens the excursion: when it closed, and the deepest excursion before it', () => {
        buy(1, 100, 1);
        tracker['openRoundTrip']!.maxAdverseExcursion = 5;
        tracker.readCandle(candleAt(1, 90, 80), true);
        expect(openRoundTrip()?.excursionDeepenings).toEqual([{ closeAt: 2 * ONE_MINUTE, previous: 5 }]);
      });

      it(`should keep the last ${LATE_FILL_CANDLES} candles that deepened the excursion`, () => {
        buy(0, 100, 1);
        // Each low lower than the one before: a deepening more than it keeps
        for (let minute = 0; minute <= LATE_FILL_CANDLES; minute++) tracker.readCandle(candleAt(minute, 99 - minute), true);
        expect(openRoundTrip()?.excursionDeepenings).toHaveLength(LATE_FILL_CANDLES);
      });

      // Heard in realtime after the bucket of the minute it filled in: that candle closed after the BUY, and counts once it is heard
      it('should count in the round trip a BUY opens the candles it read since that BUY filled', () => {
        tracker.readCandle(candleAt(1, 100, 70), true);
        tracker.readCandle(candleAt(2, 100, 95), true);
        buy(2, 100, 1);
        expect(openRoundTrip()?.maxAdverseExcursion).toBe(5);
      });
    });

    it('should count no candle before the period, nor keep it for a BUY heard later', () => {
      tracker.readCandle(candleAt(2, 100, 95), false);
      buy(2, 100, 1);
      tracker.readCandle(candleAt(3, 100, 90), false);
      expect(openRoundTrip()?.maxAdverseExcursion).toBe(0);
    });
  });

  describe('startPeriod', () => {
    // The period starts at minute 10, the last close read, 110, its start price
    const START = { at: 10 * ONE_MINUTE, equity: 1100 };

    describe('when a round trip ended during the warmup', () => {
      beforeEach(() => {
        buy(1, 100, 1);
        sell(5, 120, 1);
        tracker.readCandle(candleAt(9, 110), false);
        tracker.startPeriod(START);
      });

      it('should drop it from the round trips closed', () => {
        expect(tracker.closedRoundTrips).toEqual([]);
      });

      it('should count none of its trades', () => {
        expect(tracker.tradeCount).toBe(0);
      });

      it('should log nothing', () => {
        expect(info).not.toHaveBeenCalled();
      });
    });

    describe('when a round trip opened during the warmup is still open', () => {
      // Two BTC bought at 100 for a fee of 1, one sold at 120 for a fee of 0.12, during the warmup
      beforeEach(() => {
        buy(1, 100, 2, 1);
        sell(5, 120, 1, 0.12, holding(1));
        tracker.readCandle(candleAt(9, 110), false);
        tracker.startPeriod(START);
      });

      it('should rebase it at the start of the period, at the start price, for the position it holds then', () => {
        expect(openRoundTrip()).toEqual({
          entryOrderId: 'BUY-1',
          entryAt: 10 * ONE_MINUTE,
          entryPrice: 110,
          entryEquity: 1100,
          // Kept: the rule that ends it needs them, and the mean price of its next SELLs this one
          bought: 2,
          sold: 1,
          exitPrice: 120,
          // The BTC it still holds, 2 - 1, at the start price: what its warmup trading made is left out
          cost: 110,
          proceeds: 0,
          fees: 0,
          maxAdverseExcursion: 0,
          excursionDeepenings: [],
        });
      });

      it('should log that its round trip counts from the start of the period', () => {
        expect(info).toHaveBeenCalledExactlyOnceWith(
          'roundtrip analyzer',
          'Position on BTC/USDT opened during the warmup at 100 USDT on 1970-01-01T00:01:00.000Z: its round trip counts from the start of the period, at the start price of 110 USDT and with the start equity of 1,100 USDT.',
        );
      });

      it('should count none of the trades of the warmup', () => {
        expect(tracker.tradeCount).toBe(0);
      });

      describe('then ended by a SELL of the period, at 125, for a fee of 0.125', () => {
        let closed: RoundTrip | undefined;
        beforeEach(() => {
          closed = sell(12, 125, 1, 0.125);
        });

        it.each`
          field            | expected            | description
          ${'entryAt'}     | ${10 * ONE_MINUTE}  | ${'the start of the period'}
          ${'entryEquity'} | ${1100}             | ${'the start equity'}
          ${'cost'}        | ${110}              | ${'the position at the start price'}
          ${'proceeds'}    | ${125}              | ${'the SELL of the period'}
          ${'fees'}        | ${0.125}            | ${'the fee of the SELL of the period'}
          ${'pnl'}         | ${14.875}           | ${'125 - 110 - 0.125'}
          ${'profit'}      | ${1.35227272727273} | ${'14.875 in % of 1,100, to 15 significant digits'}
          ${'exitPrice'}   | ${122.5}            | ${'the mean of the SELLs of the warmup and of the period'}
          ${'duration'}    | ${2 * ONE_MINUTE}   | ${'from the start of the period to the SELL'}
        `('should close its round trip with $field $expected: $description', ({ field, expected }) => {
          expect(closed?.[field as keyof RoundTrip]).toBe(expected);
        });

        it('should count that SELL, the first trade of the period, which does not sell a position held before it', () => {
          expect(tracker.tradeCount).toBe(1);
        });
      });
    });

    describe('when no start equity was taken by then', () => {
      beforeEach(() => {
        buy(1, 100, 1);
        tracker.readCandle(candleAt(9, 110), false);
        tracker.startPeriod({ at: 10 * ONE_MINUTE, equity: 0 });
        sell(12, 125, 1);
      });

      it('should close the round trip with an unknown profit', () => {
        expect(tracker.closedRoundTrips[0].profit).toBeNaN();
      });

      it('should say so, naming the BUY that opened it', () => {
        expect(warning).toHaveBeenCalledWith(
          'roundtrip analyzer',
          'Round trip 0 on BTC/USDT left out of the returns, its profit unknown: the Trader had read no portfolio when BUY order BUY-1 opened it.',
        );
      });
    });
  });

  describe('exposureIntervals', () => {
    it('should give the spans of the round trips closed, then that of the one still open to the end given', () => {
      buy(1, 100, 1);
      sell(3, 110, 1);
      buy(5, 100, 1);
      expect(tracker.exposureIntervals(9 * ONE_MINUTE)).toEqual([
        { start: ONE_MINUTE, end: 3 * ONE_MINUTE },
        { start: 5 * ONE_MINUTE, end: 9 * ONE_MINUTE },
      ]);
    });

    it('should give none without a round trip', () => {
      expect(tracker.exposureIntervals(9 * ONE_MINUTE)).toEqual([]);
    });
  });

  describe('summarize', () => {
    const PERIOD = { start: 0, end: 10 * ONE_MINUTE };

    it('should sum up a pair with round trips: a win, a loss, a break-even, and one still open', () => {
      valuePortfolio.mockReturnValue(1000);
      // 0.1 BTC from 100 to 110: 1, then from 100 to 98: -0.2, then sold back at its own price: 0
      buy(1, 100, 0.1);
      tracker.readCandle(candleAt(1, 100, 90), true);
      sell(2, 110, 0.1);
      buy(3, 100, 0.1);
      sell(4, 98, 0.1);
      buy(5, 100, 0.1);
      sell(6, 100, 0.1);
      buy(8, 100, 0.1);
      expect(tracker.summarize(PERIOD)).toEqual({
        symbol: 'BTC/USDT',
        roundTripCount: 3,
        winCount: 1,
        // 1 of 3
        winRate: 33.3333333333333,
        tradeCount: 7,
        // 1 - 0.2 + 0, in decimal
        pnl: 0.8,
        // 1 + 1 + 1 minutes closed, then 2 from minute 8 to the end, of 10
        exposurePct: 50,
        // The low of 90 on the first: (100 - 90) / 100
        maxAdverseExcursion: 10,
      });
    });

    it('should sum up a pair without a round trip', () => {
      expect(tracker.summarize(PERIOD)).toEqual({
        symbol: 'BTC/USDT',
        roundTripCount: 0,
        winCount: 0,
        winRate: null,
        tradeCount: 0,
        pnl: 0,
        exposurePct: 0,
        maxAdverseExcursion: 0,
      });
    });

    // A run that ends with the bucket that completed the warmup: nothing to divide the exposure by
    it('should report no exposure over a period of 0 ms', () => {
      buy(1, 100, 1);
      expect(tracker.summarize({ start: ONE_MINUTE, end: ONE_MINUTE }).exposurePct).toBe(0);
    });

    it('should add up the P&L of its round trips in decimal: 0.1 and 0.2 make 0.3', () => {
      buy(1, 1, 1);
      sell(2, 1.1, 1);
      buy(3, 1, 1);
      sell(4, 1.2, 1);
      expect(tracker.summarize(PERIOD).pnl).toBe(0.3);
    });
  });

  describe('logOpenPosition', () => {
    // 2 BTC bought at 100 for a fee of 0.2, 1 sold at 120 for 0.12: what it holds, 1 BTC, is valued at the last close
    const holdOne = (lastClose: number, portfolio = READ) => {
      buy(4, 100, 2, 0.2, portfolio);
      sell(5, 120, 1, 0.12, holding(1));
      tracker.readCandle(candleAt(6, lastClose), true);
    };

    it('should log the position still open, with its entry and its unrealized P&L at the last close', () => {
      valuePortfolio.mockReturnValue(1000);
      holdOne(150);
      tracker.logOpenPosition();
      // 120 + 150 - 200 - 0.32 = 69.68, in % of 1,000.2: 6.9666…, +6.97% rounded half to even
      expect(info).toHaveBeenCalledExactlyOnceWith(
        'roundtrip analyzer',
        'Position still open on BTC/USDT at the end of the period, entered at 100 USDT on 1970-01-01T00:04:00.000Z: unrealized P&L of 69.68 USDT (+6.97%) at the last close, 150 USDT. The final balance and the exposure include it; the win rate, the ratios and the MAEs leave it out.',
      );
    });

    // From an entry equity of 999.8 + 0.2: 120 + the last close - 200.32
    it.each`
      lastClose | portfolio   | unrealized
      ${50}     | ${READ}     | ${'unrealized P&L of -30.32 USDT (-3.03%)'}
      ${80.32}  | ${READ}     | ${'unrealized P&L of 0 USDT (0%)'}
      ${150}    | ${NOT_READ} | ${'unrealized P&L of 69.68 USDT (profit unknown, no portfolio having valued its entry)'}
    `('should log $unrealized at a last close of $lastClose', ({ lastClose, portfolio, unrealized }) => {
      valuePortfolio.mockReturnValue(999.8);
      holdOne(lastClose, portfolio);
      tracker.logOpenPosition();
      expect(info).toHaveBeenCalledWith('roundtrip analyzer', expect.stringContaining(`: ${unrealized} at the last close,`));
    });

    it('should log nothing while flat', () => {
      tracker.logOpenPosition();
      expect(info).not.toHaveBeenCalled();
    });
  });
});
