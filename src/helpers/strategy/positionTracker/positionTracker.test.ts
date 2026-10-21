import { StrategyOrder } from '@models/advice.types';
import { Portfolio } from '@models/portfolio.types';
import { TradingPair } from '@models/utility.types';
import { MarketData } from '@services/exchange/exchange.types';
import { LoggerFn } from '@strategies/strategy.types';
import { UUID } from 'node:crypto';
import { beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { PositionTracker } from './positionTracker';
import { holding, OrderOutcome, OrderRecorder, OutcomeFacts, playSteps, relayOrderOutcome, UNKNOWN_ORDER_ID } from './positionTracker.mock';

const symbol = 'BTC/USDT';
const ORDER_ID: UUID = '00000000-0000-0000-0000-000000000042';

describe('PositionTracker', () => {
  let tracker: PositionTracker;
  let orders: OrderRecorder;

  /**
   * Plays the steps (see playSteps): 'buy' and 'sell' place an order through the tracker, 'sell2' a SELL of 2 BTC, 'sellHalf' a SELL
   * of 50 % of the BTC, 'sellCost' a SELL of 50 USDT of BTC, 'stop' is the SELL of a trailing stop, which the StrategyManager creates
   * and the tracker adopts, 'unadopted' such a SELL left unadopted
   */
  const play = (steps: string) =>
    playSteps(steps, tracker, orders, step => {
      if (step === 'buy') tracker.buy(orders.createOrder, { type: 'STICKY', symbol });
      else if (step === 'sell') tracker.sell(orders.createOrder, { type: 'STICKY', symbol });
      else if (step === 'sell2') tracker.sell(orders.createOrder, { type: 'STICKY', symbol, amount: 2 });
      else if (step === 'sellHalf') tracker.sell(orders.createOrder, { type: 'STICKY', symbol, allocation: 50 });
      else if (step === 'sellCost') tracker.sell(orders.createOrder, { type: 'STICKY', symbol, cost: 50 });
      else if (step === 'stop') tracker.adoptSell(orders.createOrder({ type: 'MARKET', side: 'SELL', symbol }));
      else if (step === 'unadopted') orders.createOrder({ type: 'MARKET', side: 'SELL', symbol });
      else throw new Error(`Unknown step: ${step}`);
    });

  // At 100 USDT the minimum cost, 5 USDT, is 0.05 BTC, above the minimum amount, 0.001 BTC; a market order takes 0.2 BTC at least.
  // Amounts are sent truncated to 0.0001 BTC.
  const PRICE = 100;
  const limits: MarketData = { amount: { min: 0.001 }, cost: { min: 5 }, market: { min: 0.2 }, precision: { amount: 0.0001 } };
  const marketData = new Map<TradingPair, MarketData>([[symbol, limits]]);
  const LONG = 'buy completed:1 sell';
  const STOP = 'buy completed:1 stop';

  /** Relays the outcome of the last order placed, its event reporting the facts given, at 100 USDT on the market above by default */
  const relayLast = (outcome: OrderOutcome, facts: OutcomeFacts) =>
    relayOrderOutcome(tracker, outcome, orders.created(orders.ids.length)!, { price: PRICE, marketData, ...facts });

  beforeEach(() => {
    tracker = new PositionTracker();
    orders = new OrderRecorder();
  });

  describe('position', () => {
    // The outcomes played here report nothing of an execution (see OutcomeFacts): an order that did not complete changes nothing
    it.each`
      case                                                          | steps                                                | isLong   | isPendingOrder
      ${'nothing placed: flat'}                                     | ${''}                                                | ${false} | ${false}
      ${'a BUY placed: flat, the BUY pending'}                      | ${'buy'}                                             | ${false} | ${true}
      ${'a BUY completed: long'}                                    | ${'buy completed:1'}                                 | ${true}  | ${false}
      ${'a BUY canceled, nothing reported: flat'}                   | ${'buy canceled:1'}                                  | ${false} | ${false}
      ${'a BUY errored, nothing reported: flat'}                    | ${'buy errored:1'}                                   | ${false} | ${false}
      ${'a SELL placed: long, the SELL pending'}                    | ${'buy completed:1 sell'}                            | ${true}  | ${true}
      ${'a SELL completed: flat'}                                   | ${'buy completed:1 sell completed:2'}                | ${false} | ${false}
      ${'a SELL canceled, nothing reported: long'}                  | ${'buy completed:1 sell canceled:2'}                 | ${true}  | ${false}
      ${'a SELL errored, nothing reported: long'}                   | ${'buy completed:1 sell errored:2'}                  | ${true}  | ${false}
      ${'another order completed: the BUY still pending'}           | ${'buy completed:unknown'}                           | ${false} | ${true}
      ${'another order canceled: the BUY still pending'}            | ${'buy canceled:unknown'}                            | ${false} | ${true}
      ${'another order errored: the BUY still pending'}             | ${'buy errored:unknown'}                             | ${false} | ${true}
      ${'another order completed: the SELL still pending'}          | ${'buy completed:1 sell completed:unknown'}          | ${true}  | ${true}
      ${'the BUY reported completed again: the SELL still pending'} | ${'buy completed:1 sell completed:1'}                | ${true}  | ${true}
      ${'a BUY canceled, then reported completed: flat'}            | ${'buy canceled:1 completed:1'}                      | ${false} | ${false}
      ${'a SELL errored, then reported completed: long'}            | ${'buy completed:1 sell errored:2 completed:2'}      | ${true}  | ${false}
      ${'a stop SELL adopted: long, the SELL pending'}              | ${'buy completed:1 stop'}                            | ${true}  | ${true}
      ${'a stop SELL completed: flat'}                              | ${'buy completed:1 stop completed:2'}                | ${false} | ${false}
      ${'a stop SELL canceled, nothing reported: long'}             | ${'buy completed:1 stop canceled:2'}                 | ${true}  | ${false}
      ${'a stop SELL errored, nothing reported: long'}              | ${'buy completed:1 stop errored:2'}                  | ${true}  | ${false}
      ${'a stop SELL not adopted, completed: still long'}           | ${'buy completed:1 unadopted completed:2'}           | ${true}  | ${false}
      ${'its own SELL completed beside a stop SELL: flat, pending'} | ${'buy completed:1 sell stop completed:2'}           | ${false} | ${true}
      ${'a stop SELL completed, then its own SELL refused: flat'}   | ${'buy completed:1 sell stop completed:3 errored:2'} | ${false} | ${false}
    `('tracks $case', ({ steps, isLong, isPendingOrder }) => {
      play(steps);
      expect({ isLong: tracker.isLong, isPendingOrder: tracker.isPendingOrder }).toEqual({ isLong, isPendingOrder });
    });
  });

  describe('position after an order that did not complete', () => {
    // A step that is not a power of ten, unlike those of Binance and Hyperliquid, which CCXTExchange truncates an amount to as to any
    // other: 0.05269 BTC is sent as 0. Only a power of ten used to be truncated to, and 0.05269 BTC read as enough to sell
    const quarterStep = new Map<TradingPair, MarketData>([[symbol, { ...limits, precision: { amount: 0.25 } }]]);

    describe('the fill a cancelation reports', () => {
      // Without a portfolio that lists BTC, what a SELL left unsold is all that is known to be held (see 'a SELL canceled after a fill')
      it.each`
        case                                                               | steps    | filled    | remaining | isLong
        ${'a BUY that filled 0.9 of 1: long'}                              | ${'buy'} | ${0.9}    | ${0.1}    | ${true}
        ${'a BUY that filled 0.01, too little to sell: flat'}              | ${'buy'} | ${0.01}   | ${0.99}   | ${false}
        ${'a BUY that filled nothing: flat'}                               | ${'buy'} | ${0}      | ${1}      | ${false}
        ${'a SELL that left 0.5 of 1 unsold: long'}                        | ${LONG}  | ${0.5}    | ${0.5}    | ${true}
        ${'a SELL that sold nothing: long'}                                | ${LONG}  | ${0}      | ${1}      | ${true}
        ${'a SELL that left 0.0001, too little to sell: flat'}             | ${LONG}  | ${0.9999} | ${0.0001} | ${false}
        ${'a SELL that sold everything: flat'}                             | ${LONG}  | ${1}      | ${0}      | ${false}
        ${'a MARKET SELL (a stop) that left 0.1, under its minimum: flat'} | ${STOP}  | ${0.9}    | ${0.1}    | ${false}
        ${'a STICKY SELL that left 0.1: long'}                             | ${LONG}  | ${0.9}    | ${0.1}    | ${true}
      `('reads $case', ({ steps, filled, remaining, isLong }) => {
        play(steps);
        relayLast('canceled', { filled, remaining });
        expect(tracker.isLong).toBe(isLong);
      });

      // What a BUY filled is the position it opened, whatever else the portfolio shows: a holding present at start-up, or the portfolio
      // known before the order when the read after it failed
      it.each`
        case                                                            | filled | remaining | free | isLong
        ${'a BUY that filled nothing, the portfolio holding 1: flat'}   | ${0}   | ${1}      | ${1} | ${false}
        ${'a BUY that filled 0.9, the portfolio holding nothing: long'} | ${0.9} | ${0.1}    | ${0} | ${true}
      `('reads the fill of a BUY before the portfolio: $case', ({ filled, remaining, free, isLong }) => {
        play('buy');
        relayLast('canceled', { filled, remaining, portfolio: holding(symbol, free) });
        expect(tracker.isLong).toBe(isLong);
      });
    });

    // What a SELL left unsold is what is left of the order, and the holding only when the order was for all of it: an amount the
    // strategy chose, sent as asked, which the tracker takes for the position. Read so, a SELL of a share of the asset, one capped at the
    // most the market takes in one order, all-in or not, or an adopted one, canceled once it had sold all but dust, left the strategy
    // flat beside the rest of the asset, while the same SELL completed read it long. Those are read from the portfolio after them, as when
    // they complete, never below what they left unsold, which the cancelation released: a portfolio that shows less was read before.
    describe('a SELL canceled after a fill', () => {
      const HALF = 'buy completed:1 sellHalf';
      const COST = 'buy completed:1 sellCost';
      const SELL2 = 'buy completed:1 sell2';
      let log: Mock<LoggerFn>;

      /**
       * Relays the cancelation of the last order placed, sent for `sent`, after it filled `filled` and left `remaining` unsold, the
       * portfolio after it holding `free` BTC, or not listing BTC when it is left out, at 100 USDT
       */
      const cancelLast = ({ sent, filled, remaining, free }: { sent: number; filled: number; remaining: number; free?: number }) =>
        relayOrderOutcome(
          tracker,
          'canceled',
          { ...orders.created(orders.ids.length)!, amount: sent },
          { price: PRICE, marketData, log, filled, remaining, portfolio: free === undefined ? undefined : holding(symbol, free) },
        );

      beforeEach(() => {
        log = vi.fn();
      });

      // A SELL of 50 % and one of 50 USDT at 100 USDT are each sent for 0.5 BTC, an all-in SELL capped at a maximum of 0.6 BTC for 0.6,
      // a SELL of 2 BTC capped at a maximum of 1 BTC for 1, a stop's SELL for the 0.5 BTC its BUY filled: each leaves the rest of the
      // asset held. A SELL of 2 sent as asked is the position, whatever else is held. A portfolio known from before the order, its read
      // after it having failed, still shows what the order sold: an all-in SELL is then read long, as when it completes, the position
      // settled by the next SELL, refused for lack of anything to sell. 0 filled and 0 remaining used to stand for no fill reported,
      // which the order now leaves out: reported, it is a fact, nothing left unsold.
      it.each`
        case                                                                                      | steps    | sent   | filled    | remaining | free         | isLong
        ${'a SELL of 50 %, 0.0001 left unsold, 0.5001 BTC free: long'}                            | ${HALF}  | ${0.5} | ${0.4999} | ${0.0001} | ${0.5001}    | ${true}
        ${'a SELL of 50 USDT, 0.0001 left unsold, 0.5001 BTC free: long'}                         | ${COST}  | ${0.5} | ${0.4999} | ${0.0001} | ${0.5001}    | ${true}
        ${'an all-in SELL capped at 0.6, 0.0001 left unsold, 0.4001 BTC free: long'}              | ${LONG}  | ${0.6} | ${0.5999} | ${0.0001} | ${0.4001}    | ${true}
        ${'a SELL of 2 capped at 1, 0.0001 left unsold, 1.0001 BTC free: long'}                   | ${SELL2} | ${1}   | ${0.9999} | ${0.0001} | ${1.0001}    | ${true}
        ${'an adopted stop SELL of 0.5, 0.0001 left unsold, 0.5001 BTC free: long'}               | ${STOP}  | ${0.5} | ${0.4999} | ${0.0001} | ${0.5001}    | ${true}
        ${'an all-in SELL, 0.0001 left unsold, the portfolio holding 1: long'}                    | ${LONG}  | ${1}   | ${0.9999} | ${0.0001} | ${1}         | ${true}
        ${'an all-in SELL that left 0 of 0, the portfolio holding 1: long'}                       | ${LONG}  | ${0}   | ${0}      | ${0}      | ${1}         | ${true}
        ${'an all-in SELL of 1, 0.0001 left unsold, as much free: flat'}                          | ${LONG}  | ${1}   | ${0.9999} | ${0.0001} | ${0.0001}    | ${false}
        ${'an all-in SELL of 1, 0.5 left unsold, 0 BTC free in a portfolio read before it: long'} | ${LONG}  | ${1}   | ${0.5}    | ${0.5}    | ${0}         | ${true}
        ${'a SELL of 50 %, 0.0001 left unsold, the portfolio without BTC: flat'}                  | ${HALF}  | ${0.5} | ${0.4999} | ${0.0001} | ${undefined} | ${false}
        ${'an all-in SELL that left 0 of 0, the portfolio without BTC: flat'}                     | ${LONG}  | ${0}   | ${0}      | ${0}      | ${undefined} | ${false}
        ${'a SELL of 2 sent as asked, 0.0001 left unsold, 1.0001 BTC free: flat'}                 | ${SELL2} | ${2}   | ${1.9999} | ${0.0001} | ${1.0001}    | ${false}
        ${'a SELL of 2 sent as asked, 0.5 left unsold, no BTC free: long'}                        | ${SELL2} | ${2}   | ${1.5}    | ${0.5}    | ${0}         | ${true}
      `('reads $case', ({ steps, sent, filled, remaining, free, isLong }) => {
        play(steps);
        cancelLast({ sent, filled, remaining, free });
        expect(tracker.isLong).toBe(isLong);
      });

      it.each`
        case                                       | steps   | sent   | filled    | remaining | free      | message
        ${'a SELL of 50 %, 0.0002 BTC free'}       | ${HALF} | ${0.5} | ${0.4999} | ${0.0001} | ${0.0002} | ${'[00000000-0000-0000-0000-000000000002] SELL order canceled: 0.0002 BTC free in the portfolio after it, too little to sell: the strategy is flat'}
        ${'an all-in SELL of 1, as much BTC free'} | ${LONG} | ${1}   | ${0.9999} | ${0.0001} | ${0.0001} | ${'[00000000-0000-0000-0000-000000000002] SELL order canceled: 0.0001 BTC left unsold, too little to sell: the strategy is flat'}
      `('logs the position read after $case, which changes it', ({ steps, sent, filled, remaining, free, message }) => {
        play(steps);
        cancelLast({ sent, filled, remaining, free });
        expect(log.mock.calls).toEqual([['info', message]]);
      });

      it('logs nothing after a SELL of 50 % with 0.5001 BTC free, which keeps the position', () => {
        play(HALF);
        cancelLast({ sent: 0.5, filled: 0.4999, remaining: 0.0001, free: 0.5001 });
        expect(log).not.toHaveBeenCalled();
      });
    });

    describe('the portfolio after it, without a fill reported', () => {
      it.each`
        case                                                    | steps    | outcome       | free   | used | isLong
        ${'a SELL errored, no BTC left: flat'}                  | ${LONG}  | ${'errored'}  | ${0}   | ${0} | ${false}
        ${'a SELL errored, 1 BTC left: long'}                   | ${LONG}  | ${'errored'}  | ${1}   | ${0} | ${true}
        ${'a SELL errored, 1 BTC left but reserved: flat'}      | ${LONG}  | ${'errored'}  | ${0}   | ${1} | ${false}
        ${'a BUY errored, 0.5 BTC bought: long'}                | ${'buy'} | ${'errored'}  | ${0.5} | ${0} | ${true}
        ${'a BUY errored, no BTC bought: flat'}                 | ${'buy'} | ${'errored'}  | ${0}   | ${0} | ${false}
        ${'a BUY canceled without its fill, 0.4 BTC bought'}    | ${'buy'} | ${'canceled'} | ${0.4} | ${0} | ${true}
        ${'a SELL canceled without its fill, no BTC left'}      | ${LONG}  | ${'canceled'} | ${0}   | ${0} | ${false}
        ${'a MARKET SELL (a stop) errored, 0.1 BTC left: flat'} | ${STOP}  | ${'errored'}  | ${0.1} | ${0} | ${false}
        ${'a STICKY SELL errored, 0.1 BTC left: long'}          | ${LONG}  | ${'errored'}  | ${0.1} | ${0} | ${true}
      `('reads $case', ({ steps, outcome, free, used, isLong }) => {
        play(steps);
        relayLast(outcome, { portfolio: holding(symbol, free, used) });
        expect(tracker.isLong).toBe(isLong);
      });

      it.each`
        case                                                  | steps    | filled       | remaining    | free   | isLong
        ${'a BUY canceled, its fill missing, 0.4 BTC bought'} | ${'buy'} | ${undefined} | ${0.6}       | ${0.4} | ${true}
        ${'a SELL canceled, its remainder missing, 0.5 left'} | ${LONG}  | ${0.5}       | ${undefined} | ${0.5} | ${true}
        ${'a SELL canceled, no fill reported, nothing left'}  | ${LONG}  | ${undefined} | ${undefined} | ${0}   | ${false}
      `('reads $case from the portfolio', ({ steps, filled, remaining, free, isLong }) => {
        play(steps);
        relayLast('canceled', { filled, remaining, portfolio: holding(symbol, free) });
        expect(tracker.isLong).toBe(isLong);
      });

      it.each`
        case                                                            | free       | price    | data           | isLong
        ${'0.1 BTC, enough to sell'}                                    | ${0.1}     | ${PRICE} | ${marketData}  | ${true}
        ${'0.05 BTC, the minimum cost exactly'}                         | ${0.05}    | ${PRICE} | ${marketData}  | ${true}
        ${'0.001 BTC at an unknown price, the minimum amount exactly'}  | ${0.001}   | ${0}     | ${marketData}  | ${true}
        ${'0.01 BTC, above the minimum amount, under the minimum cost'} | ${0.01}    | ${PRICE} | ${marketData}  | ${false}
        ${'0.01 BTC at an unknown price, the cost unchecked'}           | ${0.01}    | ${0}     | ${marketData}  | ${true}
        ${'0.0005 BTC at an unknown price, under the minimum amount'}   | ${0.0005}  | ${0}     | ${marketData}  | ${false}
        ${'0.0001 BTC on a market without data, without minimums'}      | ${0.0001}  | ${PRICE} | ${new Map()}   | ${true}
        ${'no BTC on a market without data'}                            | ${0}       | ${PRICE} | ${new Map()}   | ${false}
        ${'0.05269 BTC at 95 USDT, sent as 0.0526 BTC: 4.997 USDT'}     | ${0.05269} | ${95}    | ${marketData}  | ${false}
        ${'0.0527 BTC at 95 USDT, 5.0065 USDT'}                         | ${0.0527}  | ${95}    | ${marketData}  | ${true}
        ${'0.05269 BTC at 95 USDT on a step of 0.25 BTC, sent as 0'}    | ${0.05269} | ${95}    | ${quarterStep} | ${false}
        ${'0.3 BTC at 95 USDT on a step of 0.25 BTC, sent as 0.25'}     | ${0.3}     | ${95}    | ${quarterStep} | ${true}
      `('reads a SELL errored with $case as long ($isLong)', ({ free, price, data, isLong }) => {
        play(LONG);
        relayLast('errored', { portfolio: holding(symbol, free), price, marketData: data });
        expect(tracker.isLong).toBe(isLong);
      });
    });

    describe('nothing reported', () => {
      // Missing from the portfolio, the asset is unknown: the portfolio was not read yet
      const withoutBTC: Portfolio = new Map([['USDT', { free: 100, used: 0, total: 100 }]]);

      it.each`
        case                       | steps    | outcome       | isLong
        ${'a BUY canceled: flat'}  | ${'buy'} | ${'canceled'} | ${false}
        ${'a BUY errored: flat'}   | ${'buy'} | ${'errored'}  | ${false}
        ${'a SELL canceled: long'} | ${LONG}  | ${'canceled'} | ${true}
        ${'a SELL errored: long'}  | ${LONG}  | ${'errored'}  | ${true}
      `('keeps the position after $case, the portfolio without BTC', ({ steps, outcome, isLong }) => {
        play(steps);
        relayLast(outcome, { portfolio: withoutBTC });
        expect(tracker.isLong).toBe(isLong);
      });
    });

    describe('facts it does not read', () => {
      it('reads a BUY completed as long, even with no BTC in the portfolio', () => {
        play('buy');
        relayLast('completed', { portfolio: holding(symbol, 0) });
        expect(tracker.isLong).toBe(true);
      });

      it('ignores the facts of another order', () => {
        play('buy completed:1');
        relayOrderOutcome(
          tracker,
          'errored',
          { id: UNKNOWN_ORDER_ID, symbol },
          { price: PRICE, marketData, portfolio: holding(symbol, 0) },
        );
        expect(tracker.isLong).toBe(true);
      });

      it('ignores the facts of an order already settled', () => {
        play('buy completed:1 sell errored:2');
        relayLast('errored', { portfolio: holding(symbol, 0) });
        expect(tracker.isLong).toBe(true);
      });
    });

    describe('log', () => {
      let log: Mock<LoggerFn>;

      beforeEach(() => {
        log = vi.fn();
      });

      it.each`
        case                                  | steps    | outcome       | facts                                    | message
        ${'a SELL errored, no BTC left'}      | ${LONG}  | ${'errored'}  | ${{ portfolio: holding(symbol, 0) }}     | ${'[00000000-0000-0000-0000-000000000002] SELL order errored: 0 BTC free in the portfolio after it, too little to sell: the strategy is flat'}
        ${'a BUY errored, 0.5 BTC bought'}    | ${'buy'} | ${'errored'}  | ${{ portfolio: holding(symbol, 0.5) }}   | ${'[00000000-0000-0000-0000-000000000001] BUY order errored: 0.5 BTC free in the portfolio after it, enough to sell: the strategy is long'}
        ${'a BUY canceled after filling 0.9'} | ${'buy'} | ${'canceled'} | ${{ filled: 0.9, remaining: 0.1 }}       | ${'[00000000-0000-0000-0000-000000000001] BUY order canceled: 0.9 BTC filled, enough to sell: the strategy is long'}
        ${'a SELL canceled with 0.0001 left'} | ${LONG}  | ${'canceled'} | ${{ filled: 0.9999, remaining: 0.0001 }} | ${'[00000000-0000-0000-0000-000000000002] SELL order canceled: 0.0001 BTC left unsold, too little to sell: the strategy is flat'}
      `('logs the position read from $case, which changes it', ({ steps, outcome, facts, message }) => {
        play(steps);
        relayLast(outcome, { ...facts, log });
        expect(log.mock.calls).toEqual([['info', message]]);
      });

      it.each`
        case                                  | steps    | outcome       | facts
        ${'a SELL errored, 1 BTC left'}       | ${LONG}  | ${'errored'}  | ${{ portfolio: holding(symbol, 1) }}
        ${'a BUY canceled, nothing filled'}   | ${'buy'} | ${'canceled'} | ${{ filled: 0, remaining: 1 }}
        ${'a SELL errored, nothing reported'} | ${LONG}  | ${'errored'}  | ${{}}
      `('logs nothing after $case, which keeps the position', ({ steps, outcome, facts }) => {
        play(steps);
        relayLast(outcome, { ...facts, log });
        expect(log).not.toHaveBeenCalled();
      });
    });
  });

  // The Trader caps a SELL to the free balance and to the most the market takes in one order: read flat once its first SELL had
  // completed, a position bought above that maximum was held while the strategy ignored its SELL signals and followed its BUY signals
  describe('position after a SELL that completed', () => {
    const SELL2 = 'buy completed:1 sell2';
    let log: Mock<LoggerFn>;

    /** Relays the fill of the last order placed for `sold`, the portfolio after it holding `free` BTC, if given, at 100 USDT */
    const completeLast = (sold: number, free?: number) =>
      relayOrderOutcome(
        tracker,
        'completed',
        { ...orders.created(orders.ids.length)!, amount: sold },
        { price: PRICE, marketData, log, portfolio: free === undefined ? undefined : holding(symbol, free) },
      );

    beforeEach(() => {
      log = vi.fn();
    });

    it.each`
      case                                                                       | steps    | sold      | free         | isLong
      ${'an all-in SELL that left nothing free: flat'}                           | ${LONG}  | ${1}      | ${0}         | ${false}
      ${'an all-in SELL that left 0.0001 BTC free, too little to sell: flat'}    | ${LONG}  | ${1}      | ${0.0001}    | ${false}
      ${'an all-in SELL capped, 0.5 BTC left free: long'}                        | ${LONG}  | ${1}      | ${0.5}       | ${true}
      ${'an all-in SELL, the portfolio without BTC: flat'}                       | ${LONG}  | ${1}      | ${undefined} | ${false}
      ${'a SELL of 2 that sold 2, 1 BTC left free: flat'}                        | ${SELL2} | ${2}      | ${1}         | ${false}
      ${'a SELL of 2 capped at 1, 1 BTC left free: long'}                        | ${SELL2} | ${1}      | ${1}         | ${true}
      ${'a SELL of 2 capped at 1.9999, 0.0001 BTC left free: flat'}              | ${SELL2} | ${1.9999} | ${0.0001}    | ${false}
      ${'a SELL of 2 capped at 1, the portfolio without BTC: flat'}              | ${SELL2} | ${1}      | ${undefined} | ${false}
      ${'an adopted stop SELL capped, 0.5 BTC left free: long'}                  | ${STOP}  | ${1}      | ${0.5}       | ${true}
      ${'an adopted stop SELL, 0.1 BTC left free, under a MARKET minimum: flat'} | ${STOP}  | ${1}      | ${0.1}       | ${false}
    `('reads $case', ({ steps, sold, free, isLong }) => {
      play(steps);
      completeLast(sold, free);
      expect(tracker.isLong).toBe(isLong);
    });

    it.each`
      case                         | steps    | sold | free   | message
      ${'an all-in SELL capped'}   | ${LONG}  | ${1} | ${0.5} | ${'[00000000-0000-0000-0000-000000000002] SELL order completed after selling 1 BTC: 0.5 BTC free in the portfolio after it, enough to sell: the strategy is long'}
      ${'a SELL of 2 capped at 1'} | ${SELL2} | ${1} | ${1}   | ${'[00000000-0000-0000-0000-000000000002] SELL order completed after selling 1 of the 2 BTC it asked for: 1 BTC free in the portfolio after it, enough to sell: the strategy is long'}
    `('logs the position it reads long after $case', ({ steps, sold, free, message }) => {
      play(steps);
      completeLast(sold, free);
      expect(log.mock.calls).toEqual([['info', message]]);
    });

    it.each`
      case                                  | steps    | sold | free
      ${'an all-in SELL that left nothing'} | ${LONG}  | ${1} | ${0}
      ${'a SELL of 2 that sold 2'}          | ${SELL2} | ${2} | ${1}
    `('logs nothing after $case, which makes it flat', ({ steps, sold, free }) => {
      play(steps);
      completeLast(sold, free);
      expect(log).not.toHaveBeenCalled();
    });

    // canSell: long, nothing pending
    it('lets the strategy sell again after a SELL capped', () => {
      play(LONG);
      completeLast(1, 0.5);
      expect(tracker.canSell()).toBe(true);
    });
  });

  describe('canBuy and canSell', () => {
    it.each`
      case                           | steps                     | canBuy   | canSell
      ${'flat, nothing pending'}     | ${''}                     | ${true}  | ${false}
      ${'flat, a BUY pending'}       | ${'buy'}                  | ${false} | ${false}
      ${'flat, a stop SELL pending'} | ${'stop'}                 | ${false} | ${false}
      ${'long, nothing pending'}     | ${'buy completed:1'}      | ${false} | ${true}
      ${'long, a SELL pending'}      | ${'buy completed:1 sell'} | ${false} | ${false}
    `('allows a BUY ($canBuy) and a SELL ($canSell) when $case', ({ steps, canBuy, canSell }) => {
      play(steps);
      expect({ canBuy: tracker.canBuy(), canSell: tracker.canSell() }).toEqual({ canBuy, canSell });
    });
  });

  describe('order hooks', () => {
    it.each`
      outcome        | order                         | steps                          | n            | isOwn
      ${'completed'} | ${'its BUY'}                  | ${'buy'}                       | ${1}         | ${true}
      ${'canceled'}  | ${'its BUY'}                  | ${'buy'}                       | ${1}         | ${true}
      ${'errored'}   | ${'its BUY'}                  | ${'buy'}                       | ${1}         | ${true}
      ${'completed'} | ${'its SELL'}                 | ${'buy completed:1 sell'}      | ${2}         | ${true}
      ${'completed'} | ${'an adopted stop SELL'}     | ${'buy completed:1 stop'}      | ${2}         | ${true}
      ${'completed'} | ${'another order'}            | ${'buy'}                       | ${'unknown'} | ${false}
      ${'canceled'}  | ${'another order'}            | ${'buy'}                       | ${'unknown'} | ${false}
      ${'errored'}   | ${'another order'}            | ${'buy'}                       | ${'unknown'} | ${false}
      ${'completed'} | ${'an order already settled'} | ${'buy completed:1'}           | ${1}         | ${false}
      ${'canceled'}  | ${'an order already settled'} | ${'buy canceled:1'}            | ${1}         | ${false}
      ${'errored'}   | ${'an order already settled'} | ${'buy errored:1'}             | ${1}         | ${false}
      ${'completed'} | ${'a stop SELL not adopted'}  | ${'buy completed:1 unadopted'} | ${2}         | ${false}
    `('says whether $order, $outcome, was its own ($isOwn)', ({ outcome, steps, n, isOwn }) => {
      play(steps);
      expect(relayOrderOutcome(tracker, outcome, n === 'unknown' ? { id: UNKNOWN_ORDER_ID } : orders.created(n)!)).toBe(isOwn);
    });
  });

  describe('buy and sell', () => {
    let createOrder: Mock<(order: StrategyOrder) => UUID>;

    beforeEach(() => {
      createOrder = vi.fn((_order: StrategyOrder) => ORDER_ID);
    });

    it.each`
      action    | order                                                                           | created
      ${'buy'}  | ${{ type: 'STICKY', symbol }}                                                   | ${{ type: 'STICKY', symbol, side: 'BUY' }}
      ${'buy'}  | ${{ type: 'LIMIT', symbol, amount: 2, price: 90, trailing: { percentage: 5 } }} | ${{ type: 'LIMIT', symbol, amount: 2, price: 90, trailing: { percentage: 5 }, side: 'BUY' }}
      ${'sell'} | ${{ type: 'MARKET', symbol }}                                                   | ${{ type: 'MARKET', symbol, side: 'SELL' }}
      ${'sell'} | ${{ type: 'LIMIT', symbol, amount: 2, price: 110 }}                             | ${{ type: 'LIMIT', symbol, amount: 2, price: 110, side: 'SELL' }}
    `('$action creates the order once, as given, with its side: $created', ({ action, order, created }) => {
      tracker[action as 'buy' | 'sell'](createOrder, order);
      expect(createOrder.mock.calls).toStrictEqual([[created]]);
    });

    it.each`
      action
      ${'buy'}
      ${'sell'}
    `('$action returns the id of the order created', ({ action }) => {
      expect(tracker[action as 'buy' | 'sell'](createOrder, { type: 'MARKET', symbol })).toBe(ORDER_ID);
    });
  });
});
