import { GekkoError } from '@errors/gekko.error';
import type { Portfolio } from '@models/portfolio.types';
import type { TradingPair } from '@models/utility.types';
import type { MarketData } from '@services/exchange/exchange.types';
import { BTC_ETH_TRADED_INFO } from '@strategies/positionBook.mock';
import { LoggedLine, logsAtInit, OrderOutcome, OrderRecorder, OutcomeFacts, relayOrderOutcome } from '@strategies/positionTracker.mock';
import type { Tools } from '@strategies/strategy.types';
import { noop } from 'lodash-es';
import { beforeEach, describe, expect, it } from 'vitest';
import { playCandles, toolsOf } from './debug.mock';
import { debugPositionBookStrategySchema } from './debugPositionBook.schema';
import { DebugPositionBook } from './debugPositionBook.strategy';
import { DebugPositionBookParams } from './debugPositionBook.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
const SOL: TradingPair = 'SOL/USDT';
const XRP: TradingPair = 'XRP/USDT';
/** A line DebugPositionBook logs at info, which the StrategyManager also relays to the strat_info subscribers */
const infoLine = (message: string): LoggedLine => ({ level: 'info', message });
/** The block of these steps as its schema reads it */
const blockOf = (steps: unknown[]) => debugPositionBookStrategySchema.parse({ steps });
/** A portfolio holding `free` USDT */
const holdingUsdt = (free: number): Portfolio => new Map([['USDT', { free, used: 0, total: free }]]);

describe('DebugPositionBook', () => {
  let strategy: DebugPositionBook;
  let orders: OrderRecorder;
  let logs: LoggedLine[];
  let tools: Tools<DebugPositionBookParams>;
  /** The pairs watched, those of the bucket init got */
  let pairs: TradingPair[];
  /** The orders whose outcome has been relayed, the first ones the recorder holds */
  let relayed: number;

  /**
   * Runs init as the StrategyManager does on the first one-minute bucket: a candle of each of `watched`, with the block of `steps`, and
   * `marketData` as tools.marketData
   */
  const start = (steps: unknown[], watched: TradingPair[] = [BTC], marketData = new Map<TradingPair, MarketData>()) => {
    pairs = watched;
    tools = toolsOf(blockOf(steps), {
      createOrder: orders.createOrder,
      log: (level, message) => logs.push({ level, message }),
      marketData,
    });
    const candle = new Map(pairs.map(pair => [pair, { start: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
    strategy.init({ candle, portfolio: new Map(), tools, addIndicator: noop });
  };
  /** Plays one candle after the warmup with `portfolio`, which the book estimates the cost of a BUY from on several pairs */
  const playCandle = (portfolio: Portfolio = new Map()) => strategy.onTimeframeCandleAfterWarmup({ candle: new Map(), portfolio, tools });
  /** Relays `outcome` for each order created since the last relay, its event reporting `facts` (see OutcomeFacts) */
  const settleNewOrders = (outcome: OrderOutcome, facts: OutcomeFacts) => {
    for (; relayed < orders.advices.length; relayed++) relayOrderOutcome(strategy, outcome, orders.created(relayed + 1)!, facts);
  };
  /**
   * Plays `count` candles after the warmup with an empty portfolio, which the book skips no BUY on (see playCandles), each order ending
   * as `outcome` once its candle is over, as a backtest settles a MARKET order with the candle that sends it
   */
  const play = (count: number, outcome: OrderOutcome = 'completed', facts: OutcomeFacts = {}) =>
    playCandles(strategy, tools, orders, count, pairs, () => settleNewOrders(outcome, facts));

  beforeEach(() => {
    strategy = new DebugPositionBook();
    orders = new OrderRecorder();
    logs = [];
    relayed = 0;
  });

  describe('init', () => {
    it.each`
      case           | watched       | expected
      ${'one pair'}  | ${[BTC]}      | ${[]}
      ${'two pairs'} | ${[BTC, ETH]} | ${[BTC_ETH_TRADED_INFO]}
    `('tracks every watched pair, the book saying so on several: $case', ({ watched, expected }) => {
      expect(logsAtInit(strategy, watched, blockOf([{ candle: 0, side: 'BUY' }]))).toEqual(expected);
    });

    // Played as it is, a step on a pair that is not watched would be refused by the book only on its candle
    it.each`
      case                                         | steps                                                                                                                    | watched       | expected
      ${'a BUY step on a pair not watched'}        | ${[{ candle: 0, side: 'BUY', symbols: [XRP] }]}                                                                          | ${[BTC, ETH]} | ${'Impossible to play the BUY step of candle 0 on XRP/USDT: symbol must be one of the watched pairs (BTC/USDT, ETH/USDT)'}
      ${'a SELL step naming one after a pair'}     | ${[{ candle: 2, side: 'SELL', symbols: [BTC, XRP] }]}                                                                    | ${[BTC, ETH]} | ${'Impossible to play the SELL step of candle 2 on XRP/USDT: symbol must be one of the watched pairs (BTC/USDT, ETH/USDT)'}
      ${'the first of two steps naming one'}       | ${[{ candle: 0, side: 'BUY' }, { candle: 3, side: 'SELL', symbols: [SOL] }, { candle: 4, side: 'BUY', symbols: [XRP] }]} | ${[BTC, ETH]} | ${'Impossible to play the SELL step of candle 3 on SOL/USDT: symbol must be one of the watched pairs (BTC/USDT, ETH/USDT)'}
      ${'a step on a pair beside the one watched'} | ${[{ candle: 1, side: 'BUY', symbols: [ETH] }]}                                                                          | ${[BTC]}      | ${'Impossible to play the BUY step of candle 1 on ETH/USDT: symbol must be one of the watched pairs (BTC/USDT)'}
    `('refuses $case, naming it and the watched pairs', ({ steps, watched, expected }) => {
      expect(() => start(steps, watched)).toThrow(new GekkoError('strategy', expected));
    });

    it('refuses such a step before it tracks a pair: the book says nothing', () => {
      try {
        start([{ candle: 0, side: 'BUY', symbols: [XRP] }], [BTC, ETH]);
      } catch {
        // Refused, as the test above asserts
      }
      expect(logs).toEqual([]);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // Each order ends completed once its candle is over: a BUY leaves the pair long, a SELL flat. The steps of a candle are played in
    // the order of the block, a SELL after a BUY of the same candle finding that BUY pending.
    it.each`
      steps                                                                                     | calendar
      ${[{ candle: 0, side: 'BUY' }, { candle: 2, side: 'SELL' }]}                              | ${'B . S'}
      ${[{ candle: 3, side: 'SELL' }, { candle: 1, side: 'BUY' }]}                              | ${'. B . S .'}
      ${[{ candle: 0, side: 'BUY' }, { candle: 1, side: 'SELL' }, { candle: 2, side: 'BUY' }]}  | ${'B S B'}
      ${[{ candle: 1, side: 'BUY' }, { candle: 1, side: 'SELL' }, { candle: 2, side: 'SELL' }]} | ${'. B S'}
    `('plays each step on its candle, counted from 0, those of a candle in their order: $calendar', ({ steps, calendar }) => {
      start(steps);
      expect(play(calendar.split(' ').length)).toBe(calendar);
    });

    // An order the book sizes has no sizing key unless the book gives it one: the one pair watched buys all-in, as a single-pair
    // strategy does, and every SELL sells all of its asset
    it('places a MARKET BUY then a MARKET SELL of the one pair watched, all-in, through the book', () => {
      start([
        { candle: 0, side: 'BUY' },
        { candle: 1, side: 'SELL' },
      ]);
      play(2);
      expect(orders.advices).toStrictEqual([
        { type: 'MARKET', side: 'BUY', symbol: BTC },
        { type: 'MARKET', side: 'SELL', symbol: BTC },
      ]);
    });

    // Two pairs flat: each BUY takes half of the currency, the second counting the first, whose BUY is pending. Once one is long, the
    // BUY of the other takes all the currency left.
    it.each`
      case                                                   | steps                                                                                       | expected
      ${'a step without symbols, on every watched pair'}     | ${[{ candle: 0, side: 'BUY' }]}                                                             | ${[{ type: 'MARKET', side: 'BUY', symbol: BTC, allocation: 50 }, { type: 'MARKET', side: 'BUY', symbol: ETH, allocation: 50 }]}
      ${'a step on its symbols, in their order'}             | ${[{ candle: 0, side: 'BUY', symbols: [ETH, BTC] }]}                                        | ${[{ type: 'MARKET', side: 'BUY', symbol: ETH, allocation: 50 }, { type: 'MARKET', side: 'BUY', symbol: BTC, allocation: 50 }]}
      ${'a step on one pair, the other flat'}                | ${[{ candle: 0, side: 'BUY', symbols: [ETH] }]}                                             | ${[{ type: 'MARKET', side: 'BUY', symbol: ETH, allocation: 50 }]}
      ${'the pair left flat once the other is long, all-in'} | ${[{ candle: 0, side: 'BUY', symbols: [ETH] }, { candle: 1, side: 'BUY', symbols: [BTC] }]} | ${[{ type: 'MARKET', side: 'BUY', symbol: ETH, allocation: 50 }, { type: 'MARKET', side: 'BUY', symbol: BTC }]}
      ${'a SELL of each pair long, all-in'}                  | ${[{ candle: 0, side: 'BUY' }, { candle: 1, side: 'SELL', symbols: [ETH, BTC] }]}           | ${[{ type: 'MARKET', side: 'BUY', symbol: BTC, allocation: 50 }, { type: 'MARKET', side: 'BUY', symbol: ETH, allocation: 50 }, { type: 'MARKET', side: 'SELL', symbol: ETH }, { type: 'MARKET', side: 'SELL', symbol: BTC }]}
    `('places the orders of two pairs through the book: $case', ({ steps, expected }) => {
      start(steps, [BTC, ETH]);
      play(2);
      expect(orders.advices).toStrictEqual(expected);
    });

    // The position of the pair is read before each step, an order pending until its candle is over: its outcome comes after it
    it.each`
      case                                       | steps                                                                                     | expected
      ${'a BUY step while long'}                 | ${[{ candle: 0, side: 'BUY' }, { candle: 1, side: 'BUY' }]}                               | ${'[BTC/USDT] BUY step of candle 1 skipped: the strategy is long'}
      ${'a SELL step while flat'}                | ${[{ candle: 0, side: 'SELL' }]}                                                          | ${'[BTC/USDT] SELL step of candle 0 skipped: the strategy is flat'}
      ${'a BUY step while its BUY is pending'}   | ${[{ candle: 0, side: 'BUY' }, { candle: 0, side: 'BUY' }]}                               | ${'[BTC/USDT] BUY step of candle 0 skipped: an order is pending'}
      ${'a SELL step while its BUY is pending'}  | ${[{ candle: 0, side: 'BUY' }, { candle: 0, side: 'SELL' }]}                              | ${'[BTC/USDT] SELL step of candle 0 skipped: an order is pending'}
      ${'a BUY step while its SELL is pending'}  | ${[{ candle: 0, side: 'BUY' }, { candle: 1, side: 'SELL' }, { candle: 1, side: 'BUY' }]}  | ${'[BTC/USDT] BUY step of candle 1 skipped: an order is pending'}
      ${'a SELL step while its SELL is pending'} | ${[{ candle: 0, side: 'BUY' }, { candle: 1, side: 'SELL' }, { candle: 1, side: 'SELL' }]} | ${'[BTC/USDT] SELL step of candle 1 skipped: an order is pending'}
    `('skips $case, said at info level', ({ steps, expected }) => {
      start(steps);
      play(2);
      expect(logs).toEqual([infoLine(expected)]);
    });

    it('skips a step on the pair whose position does not allow it alone, naming that pair', () => {
      start(
        [
          { candle: 0, side: 'BUY', symbols: [BTC] },
          { candle: 1, side: 'BUY' },
        ],
        [BTC, ETH],
      );
      play(2);
      expect({ logs, orders: orders.advices.map(({ side, symbol }) => `${side} ${symbol}`) }).toEqual({
        logs: [BTC_ETH_TRADED_INFO, infoLine('[BTC/USDT] BUY step of candle 1 skipped: the strategy is long')],
        orders: ['BUY BTC/USDT', 'BUY ETH/USDT'],
      });
    });

    // 50 % of the 20 USDT free, less the 5 % kept back for the fee, is 9.5 USDT: below the minimum cost of each market. The book says
    // so, and the step logs nothing more: the signal is spent, as a skipped BUY is for a signal strategy.
    it('sends no BUY the book skips, the book alone saying why', () => {
      const minimumCost = new Map<TradingPair, MarketData>([
        [BTC, { cost: { min: 10 } }],
        [ETH, { cost: { min: 10 } }],
      ]);
      const skipped = (pair: TradingPair) =>
        `[${pair}] BUY skipped: 50 % of the 20 USDT free, 9.5 USDT once 5 % is kept back for the fee, is below the minimum cost of 10 USDT of the market: watch fewer pairs or fund the account; the next skips of this pair are logged at debug level until a BUY of it is placed`;
      start([{ candle: 0, side: 'BUY' }], [BTC, ETH], minimumCost);
      playCandle(holdingUsdt(20));
      expect({ orders: orders.advices, logs }).toEqual({
        orders: [],
        logs: [BTC_ETH_TRADED_INFO, { level: 'warn', message: skipped(BTC) }, { level: 'warn', message: skipped(ETH) }],
      });
    });
  });

  describe('order hooks', () => {
    // Settled by the book, a BUY that ends without a fill leaves the pair flat with nothing pending: its next BUY step buys again
    it.each`
      outcome       | facts                          | calendar
      ${'canceled'} | ${{ filled: 0, remaining: 1 }} | ${'B B'}
      ${'errored'}  | ${{}}                          | ${'B B'}
    `('hands the book a BUY $outcome without a fill, which leaves the pair flat: $calendar', ({ outcome, facts, calendar }) => {
      start([
        { candle: 0, side: 'BUY' },
        { candle: 1, side: 'BUY' },
      ]);
      expect(play(2, outcome, facts)).toBe(calendar);
    });

    // The BUY of BTC completes before the next candle, that of ETH still pends: BTC is long and sells, ETH skips both steps
    it('hands the book the outcome of each order, which settles the position of its pair alone', () => {
      start(
        [
          { candle: 0, side: 'BUY' },
          { candle: 1, side: 'BUY' },
          { candle: 1, side: 'SELL' },
        ],
        [BTC, ETH],
      );
      playCandle();
      relayOrderOutcome(strategy, 'completed', orders.created(1)!);
      playCandle();
      expect({ logs: logs.slice(1), orders: orders.advices.map(({ side, symbol }) => `${side} ${symbol}`) }).toEqual({
        logs: [
          infoLine('[BTC/USDT] BUY step of candle 1 skipped: the strategy is long'),
          infoLine('[ETH/USDT] BUY step of candle 1 skipped: an order is pending'),
          infoLine('[ETH/USDT] SELL step of candle 1 skipped: an order is pending'),
        ],
        orders: ['BUY BTC/USDT', 'BUY ETH/USDT', 'SELL BTC/USDT'],
      });
    });
  });
});
