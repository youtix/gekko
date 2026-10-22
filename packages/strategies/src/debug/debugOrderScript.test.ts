import { LoggedLine, OrderOutcome, OrderRecorder, relayOrderOutcome } from '../helpers/positionTracker/positionTracker.mock';
import type { OrderCanceledEvent, OrderCompletedEvent, OrderErroredEvent } from '@gekko/shared/models/event.types';
import type { TradingPair } from '@gekko/shared/models/utility.types';
import type { Tools } from '../strategy.types';
import { UUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { playCandles, toolsOf } from './debug.mock';
import { debugOrderScriptStrategySchema } from '@gekko/schemas/strategies/debug/debugOrderScript.schema';
import { DebugOrderScript } from './debugOrderScript.strategy';
import { DebugOrderScriptParams } from './debugOrderScript.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
/** A line DebugOrderScript logs at info, which the StrategyManager also relays to the strat_info subscribers */
const infoLine = (message: string): LoggedLine => ({ level: 'info', message });
/** The orders of a block as its schema reads them, an amount of 1 for those that give none */
const scriptOf = (orders: unknown[]) => debugOrderScriptStrategySchema.parse({ orders });

describe('DebugOrderScript', () => {
  let strategy: DebugOrderScript;
  let orders: OrderRecorder;
  let logs: LoggedLine[];
  /** The orders canceled, by number (from 1, see OrderRecorder), with the candle that canceled them */
  let cancellations: { order: number; candle: number }[];
  /** The candle being played, from 0, the first candle after the warmup */
  let candleNumber: number;
  let tools: Tools<DebugOrderScriptParams>;

  /** Plays `count` candles of `pairs` with the strategy block parsed as `params`: see playCandles */
  const play = (count: number, params: DebugOrderScriptParams, pairs: TradingPair[] = [BTC]) => {
    tools = toolsOf(params, {
      log: (level, message) => logs.push({ level, message }),
      createOrder: orders.createOrder,
      cancelOrder: orderId => cancellations.push({ order: orders.ids.indexOf(orderId) + 1, candle: candleNumber }),
    });
    return playCandles(strategy, tools, orders, count, pairs, () => candleNumber++);
  };

  beforeEach(() => {
    strategy = new DebugOrderScript();
    orders = new OrderRecorder();
    logs = [];
    cancellations = [];
    candleNumber = 0;
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    it.each`
      script                                                                                                            | calendar
      ${[{ candle: 0, side: 'BUY', type: 'MARKET' }, { candle: 2, side: 'SELL', type: 'MARKET' }]}                      | ${'B . S'}
      ${[{ candle: 1, side: 'SELL', type: 'LIMIT', price: 110 }, { candle: 1, side: 'BUY', type: 'LIMIT', price: 90 }]} | ${'. SB .'}
      ${[{ candle: 3, side: 'BUY', type: 'STICKY' }]}                                                                   | ${'. . . B .'}
    `('creates each order on its candle, counted from 0, those of a candle in their order: $calendar', ({ script, calendar }) => {
      expect(play(calendar.split(' ').length, scriptOf(script))).toBe(calendar);
    });

    it('creates each order on the first watched pair with its side, its type, its amount (1 by default) and its price', () => {
      const script = [
        { candle: 0, side: 'BUY', type: 'LIMIT', amount: 0.5, price: 90 },
        { candle: 0, side: 'SELL', type: 'MARKET' },
      ];
      play(1, scriptOf(script), [BTC, ETH]);
      expect(orders.advices).toStrictEqual([
        { symbol: BTC, side: 'BUY', type: 'LIMIT', amount: 0.5, price: 90 },
        { symbol: BTC, side: 'SELL', type: 'MARKET', amount: 1 },
      ]);
    });

    it('logs each order it creates under its number in the block, from 0, with its candle, and its price when it has one', () => {
      play(
        2,
        scriptOf([
          { candle: 1, side: 'SELL', type: 'LIMIT', price: 110 },
          { candle: 0, side: 'BUY', type: 'MARKET', amount: 2 },
        ]),
      );
      expect(logs).toEqual([
        infoLine('Order 1 created on candle 0: BUY MARKET of 2 on BTC/USDT'),
        infoLine('Order 0 created on candle 1: SELL LIMIT of 1 on BTC/USDT at 110'),
      ]);
    });
  });

  describe('cancelAfter', () => {
    // One order on the first candle: the cancelations are checked on each candle before its orders
    it.each`
      cancelAfter  | expected
      ${undefined} | ${[]}
      ${1}         | ${[{ order: 1, candle: 1 }]}
      ${3}         | ${[{ order: 1, candle: 3 }]}
    `('cancels an order cancelAfter candles after the one it was created on, once: $cancelAfter', ({ cancelAfter, expected }) => {
      play(5, scriptOf([{ candle: 0, side: 'BUY', type: 'LIMIT', price: 90, cancelAfter }]));
      expect(cancellations).toEqual(expected);
    });

    // What the schema refuses 0 for: given past it, 0 does what 1 does
    it('cancels on the next candle an order given a cancelAfter of 0, the cancelations of a candle running before its orders', () => {
      play(3, { orders: [{ candle: 0, side: 'BUY', type: 'LIMIT', amount: 1, price: 90, cancelAfter: 0 }] });
      expect(cancellations).toEqual([{ order: 1, candle: 1 }]);
    });

    it('logs each cancelation with the number of the order and the candle', () => {
      play(3, scriptOf([{ candle: 0, side: 'BUY', type: 'LIMIT', price: 90, cancelAfter: 2 }]));
      expect(logs.at(-1)).toEqual(infoLine('Order 0 canceled by the strategy on candle 2'));
    });

    it.each`
      outcome
      ${'completed'}
      ${'canceled'}
      ${'errored'}
    `('does not cancel an order once it has ended: $outcome', ({ outcome }: { outcome: OrderOutcome }) => {
      const script = scriptOf([{ candle: 0, side: 'BUY', type: 'LIMIT', price: 90, cancelAfter: 2 }]);
      play(1, script);
      relayOrderOutcome(strategy, outcome, orders.created(1)!, { log: () => undefined });
      play(3, script);
      expect(cancellations).toEqual([]);
    });
  });

  describe('order hooks', () => {
    const order = (id: UUID) => ({ id, symbol: BTC, side: 'BUY' as const, type: 'MARKET' as const, amount: 1, orderCreationDate: 0 });
    const exchange = { portfolio: new Map(), price: 100 };

    it('logs what a completed order reports: its amount, its price, its fee and the date of its execution', () => {
      play(1, scriptOf([{ candle: 0, side: 'BUY', type: 'MARKET' }]));
      const completed: OrderCompletedEvent['order'] = {
        ...order(orders.ids[0]),
        price: 100,
        fee: 0.1,
        feePercent: 0.1,
        effectivePrice: 100.1,
        orderExecutionDate: Date.UTC(2024, 0, 1, 12, 1, 2),
      };
      strategy.onOrderCompleted({ order: completed, exchange, tools });
      expect(logs.at(-1)).toEqual(
        infoLine('Order 0 completed: 1 at 100, fee 0.1 (0.1 %), effective price 100.1, executed at 2024-01-01T12:01:02.000Z'),
      );
    });

    it.each`
      filled       | remaining    | expected
      ${0.4}       | ${0.6}       | ${'Order 0 canceled: filled 0.4, remaining 0.6'}
      ${0}         | ${1}         | ${'Order 0 canceled: filled 0, remaining 1'}
      ${undefined} | ${undefined} | ${'Order 0 canceled: no fill reported'}
    `('logs what a canceled order reports filled: $expected', ({ filled, remaining, expected }) => {
      play(1, scriptOf([{ candle: 0, side: 'BUY', type: 'MARKET' }]));
      const canceled: OrderCanceledEvent['order'] = { ...order(orders.ids[0]), orderCancelationDate: 0, filled, remaining };
      strategy.onOrderCanceled({ order: canceled, exchange, tools });
      expect(logs.at(-1)).toEqual(infoLine(expected));
    });

    it.each`
      mayBeLive | expected
      ${true}   | ${'Order 0 errored: filled 0.2, may be live on the exchange: Outcome unknown'}
      ${false}  | ${'Order 0 errored: filled 0.2, not live on the exchange: Outcome unknown'}
    `('logs what an errored order reports: its fill and whether it may be live, $mayBeLive', ({ mayBeLive, expected }) => {
      play(1, scriptOf([{ candle: 0, side: 'BUY', type: 'MARKET' }]));
      const errored: OrderErroredEvent['order'] = {
        ...order(orders.ids[0]),
        reason: 'Outcome unknown',
        orderErrorDate: 0,
        filled: 0.2,
        mayBeLive,
      };
      strategy.onOrderErrored({ order: errored, exchange, tools });
      expect(logs.at(-1)).toEqual(infoLine(expected));
    });

    it('names unknown an order it did not create', () => {
      play(1, scriptOf([{ candle: 0, side: 'BUY', type: 'MARKET' }]));
      const errored: OrderErroredEvent['order'] = {
        ...order('ffffffff-ffff-ffff-ffff-ffffffffffff'),
        reason: 'refused',
        orderErrorDate: 0,
        filled: 0,
        mayBeLive: false,
      };
      strategy.onOrderErrored({ order: errored, exchange, tools });
      expect(logs.at(-1)).toEqual(infoLine('Order unknown errored: filled 0, not live on the exchange: refused'));
    });
  });
});
