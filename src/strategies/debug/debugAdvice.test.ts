import { LoggedLine, OrderOutcome, OrderRecorder, relayOrderOutcome } from '@helpers/strategy/positionTracker/positionTracker.mock';
import type { TradingPair } from '@models/utility.types';
import { beforeEach, describe, expect, it } from 'vitest';
import { playCandles, toolsOf } from './debug.mock';
import { DebugAdvice } from './debugAdvice.strategy';
import { DebugAdviceParams } from './debugAdvice.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
/** A line DebugAdvice logs at debug, printed only: one per candle and pair */
const debugLine = (message: string): LoggedLine => ({ level: 'debug', message });
/** A line DebugAdvice logs at info, which the StrategyManager also relays to the strat_info subscribers: its advices and order outcomes */
const infoLine = (message: string): LoggedLine => ({ level: 'info', message });

describe('DebugAdvice', () => {
  let strategy: DebugAdvice;
  let orders: OrderRecorder;
  let logs: LoggedLine[];
  /** The orders canceled, by number (from 1, see OrderRecorder), with the candle that canceled them */
  let cancellations: { order: number; candle: number }[];
  /** The candle being played, from 0, the first candle after the warmup */
  let candleNumber: number;

  /** Plays `count` candles of `pairs` with the strategy block parsed as `params`: see playCandles */
  const play = (count: number, params: DebugAdviceParams, pairs: TradingPair[] = [BTC]) => {
    const tools = toolsOf(params, {
      log: (level, message) => logs.push({ level, message }),
      createOrder: orders.createOrder,
      cancelOrder: orderId => cancellations.push({ order: orders.ids.indexOf(orderId) + 1, candle: candleNumber }),
    });
    return playCandles(strategy, tools, orders, count, pairs, () => candleNumber++);
  };

  beforeEach(() => {
    strategy = new DebugAdvice();
    orders = new OrderRecorder();
    logs = [];
    cancellations = [];
    candleNumber = 0;
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // The BUY came at each / 2 after each SELL, which no candle reaches when each is odd: 1, 3, 5… only ever sold
    it.each`
      each | wait | calendar
      ${1} | ${0} | ${'S B S B S B'}
      ${2} | ${0} | ${'S . B . S . B .'}
      ${3} | ${0} | ${'S . . B . . S . . B'}
      ${4} | ${0} | ${'S . . . B . . . S'}
      ${5} | ${0} | ${'S . . . . B . . . . S'}
      ${1} | ${2} | ${'. . S B S B'}
      ${2} | ${1} | ${'. S . B . S'}
      ${3} | ${2} | ${'. . S . . B . . S'}
    `('advises every each candles from the candle wait, a SELL then a BUY: each $each, wait $wait', ({ each, wait, calendar }) => {
      expect(play(calendar.split(' ').length, { each, wait })).toBe(calendar);
    });

    it('advises a STICKY order of 1 unit', () => {
      play(2, { each: 1, wait: 0 });
      expect(orders.advices).toStrictEqual([
        { type: 'STICKY', side: 'SELL', amount: 1, symbol: BTC },
        { type: 'STICKY', side: 'BUY', amount: 1, symbol: BTC },
      ]);
    });

    it('advises every watched pair on the same candle, on the same side', () => {
      play(2, { each: 1, wait: 0 }, [BTC, ETH]);
      expect(orders.advices.map(({ side, symbol }) => `${side} ${symbol}`)).toEqual([
        'SELL BTC/USDT',
        'SELL ETH/USDT',
        'BUY BTC/USDT',
        'BUY ETH/USDT',
      ]);
    });

    // The e2e flows look for these lines: from the candle wait on, each candle logs its index for each pair
    const SELL_NOTHING_BUY = [
      debugLine('Iteration: 0 for BTC/USDT'),
      infoLine('Trigger SHORT for BTC/USDT'),
      debugLine('Iteration: 1 for BTC/USDT'),
      debugLine('Iteration: 2 for BTC/USDT'),
      infoLine('Trigger LONG for BTC/USDT'),
    ];
    const WAIT_THEN_SELL = [debugLine('Iteration: 2 for BTC/USDT'), infoLine('Trigger SHORT for BTC/USDT')];
    const TWO_PAIRS = [
      debugLine('Iteration: 0 for BTC/USDT'),
      infoLine('Trigger SHORT for BTC/USDT'),
      debugLine('Iteration: 0 for ETH/USDT'),
      infoLine('Trigger SHORT for ETH/USDT'),
    ];
    it.each`
      case                       | each | wait | pairs         | count | expected
      ${'an advice, none, one'}  | ${2} | ${0} | ${[BTC]}      | ${3}  | ${SELL_NOTHING_BUY}
      ${'nothing before wait'}   | ${1} | ${2} | ${[BTC]}      | ${3}  | ${WAIT_THEN_SELL}
      ${'two pairs, one candle'} | ${1} | ${0} | ${[BTC, ETH]} | ${1}  | ${TWO_PAIRS}
    `('logs each candle and each advice: $case', ({ each, wait, pairs, count, expected }) => {
      play(count, { each, wait }, pairs);
      expect(logs).toEqual(expected);
    });
  });

  describe('cancelAfter', () => {
    // One advice on the first candle, the next one on the fifth: the cancellations are checked on each candle before its advice
    it.each`
      cancelAfter  | expected
      ${undefined} | ${[]}
      ${0}         | ${[{ order: 1, candle: 1 }]}
      ${1}         | ${[{ order: 1, candle: 1 }]}
      ${2}         | ${[{ order: 1, candle: 2 }]}
      ${3}         | ${[{ order: 1, candle: 3 }]}
    `('cancels an order cancelAfter candles after it was created, once: $cancelAfter', ({ cancelAfter, expected }) => {
      play(4, { each: 4, wait: 0, cancelAfter });
      expect(cancellations).toEqual(expected);
    });

    it('logs each cancellation with the index of the candle', () => {
      play(3, { each: 4, wait: 0, cancelAfter: 2 });
      expect(logs.filter(({ message }) => message.startsWith('Cancelling'))).toEqual([
        infoLine(`Cancelling order ${orders.ids[0]} at index 2`),
      ]);
    });

    it.each`
      outcome
      ${'completed'}
      ${'canceled'}
      ${'errored'}
    `('does not cancel an order once it has ended: $outcome', ({ outcome }) => {
      play(1, { each: 4, wait: 0, cancelAfter: 2 });
      relayOrderOutcome(strategy, outcome, orders.created(1)!);
      play(3, { each: 4, wait: 0, cancelAfter: 2 });
      expect(cancellations).toEqual([]);
    });
  });

  // The screener e2e flow counts the "Order Errored" lines that reach Telegram
  it.each`
    outcome        | message
    ${'completed'} | ${'Order Completed'}
    ${'canceled'}  | ${'Order Canceled'}
    ${'errored'}   | ${'Order Errored'}
  `('logs the outcome of each order: $outcome', ({ outcome, message }: { outcome: OrderOutcome; message: string }) => {
    play(1, { each: 1, wait: 0 });
    const outcomeLogs: LoggedLine[] = [];
    relayOrderOutcome(strategy, outcome, orders.created(1)!, { log: (level, line) => outcomeLogs.push({ level, message: line }) });
    expect(outcomeLogs).toEqual([infoLine(`${message}: ${orders.ids[0]}`)]);
  });
});
