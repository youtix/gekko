import { GekkoError } from '@gekko/shared/errors/gekko.error';
import type { TradingPair } from '@gekko/shared/models/utility.types';
import { AskedOrder, fakeTools, LoggedLine, orderId, ScriptedPositions } from '../strategy.mock';
import type { Tools } from '../strategy.types';
import { noop } from 'lodash-es';
import { beforeEach, describe, expect, it } from 'vitest';
import { playCandles } from './debug.mock';
import { debugPositionBookStrategySchema } from '@gekko/schemas/strategies/debug/debugPositionBook.schema';
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
/** The MARKET BUY of `symbol` as the strategy asks tools.positions for it: the position book sizes it */
const buy = (symbol: TradingPair): AskedOrder => ({ type: 'MARKET', side: 'BUY', symbol });
/** The MARKET SELL of `symbol` as the strategy asks tools.positions for it: of all of its asset */
const sell = (symbol: TradingPair): AskedOrder => ({ type: 'MARKET', side: 'SELL', symbol });

describe('DebugPositionBook', () => {
  let strategy: DebugPositionBook;
  let tools: Tools<DebugPositionBookParams>;
  let positions: ScriptedPositions;
  let logs: LoggedLine[];
  /** The pairs watched, those of the bucket init got */
  let pairs: TradingPair[];
  /** The orders asked whose candle is over, the first ones the positions recorded (see settleNewOrders) */
  let settled: number;

  /** Builds the tools of a run that watches `watched`, with the block of `steps` (see fakeTools) */
  const toolsFor = (steps: unknown[], watched: TradingPair[]) => {
    pairs = watched;
    ({ tools, positions, logs } = fakeTools(blockOf(steps), { pairs: watched }));
  };
  /** Runs init as the StrategyManager does on the first one-minute bucket: a candle of each of `watched`, with the block of `steps` */
  const start = (steps: unknown[], watched: TradingPair[] = [BTC]) => {
    toolsFor(steps, watched);
    const candle = new Map(pairs.map(pair => [pair, { start: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]));
    strategy.init({ candle, portfolio: new Map(), tools, addIndicator: noop });
  };
  /** Plays one candle after the warmup */
  const playCandle = () => strategy.onTimeframeCandleAfterWarmup({ candle: new Map(), portfolio: new Map(), tools });
  /**
   * Settles each order asked since the last call as the position book settles an order that completed, which the scripted positions
   * leave to the test: a BUY leaves its pair long, a SELL flat
   */
  const settleNewOrders = () => {
    for (const { side, symbol } of positions.advices.slice(settled)) positions.set(symbol, side === 'BUY' ? 'LONG' : 'FLAT');
    settled = positions.advices.length;
  };
  /** Plays `count` candles after the warmup, each order completing once its candle is over (see playCandles and settleNewOrders) */
  const play = (count: number) => playCandles(strategy, tools, positions, count, pairs, settleNewOrders);

  beforeEach(() => {
    strategy = new DebugPositionBook();
    settled = 0;
  });

  describe('init', () => {
    it.each`
      case           | watched
      ${'one pair'}  | ${[BTC]}
      ${'two pairs'} | ${[BTC, ETH]}
    `('tracks every watched pair, through one call of tools.positions.track without pairs: $case', ({ watched }) => {
      start([{ candle: 0, side: 'BUY' }], watched);
      expect({ trackCalls: positions.trackCalls, pairs: positions.pairs }).toEqual({ trackCalls: [[]], pairs: watched });
    });

    // Played as it is, a step on a pair that is not watched would be skipped on its candle, as if the strategy were long or flat there
    it.each`
      case                                         | steps                                                                                                                    | watched       | expected
      ${'a BUY step on a pair not watched'}        | ${[{ candle: 0, side: 'BUY', symbols: [XRP] }]}                                                                          | ${[BTC, ETH]} | ${'Impossible to play the BUY step of candle 0 on XRP/USDT: symbol must be one of the watched pairs (BTC/USDT, ETH/USDT)'}
      ${'a SELL step naming one after a pair'}     | ${[{ candle: 2, side: 'SELL', symbols: [BTC, XRP] }]}                                                                    | ${[BTC, ETH]} | ${'Impossible to play the SELL step of candle 2 on XRP/USDT: symbol must be one of the watched pairs (BTC/USDT, ETH/USDT)'}
      ${'the first of two steps naming one'}       | ${[{ candle: 0, side: 'BUY' }, { candle: 3, side: 'SELL', symbols: [SOL] }, { candle: 4, side: 'BUY', symbols: [XRP] }]} | ${[BTC, ETH]} | ${'Impossible to play the SELL step of candle 3 on SOL/USDT: symbol must be one of the watched pairs (BTC/USDT, ETH/USDT)'}
      ${'a step on a pair beside the one watched'} | ${[{ candle: 1, side: 'BUY', symbols: [ETH] }]}                                                                          | ${[BTC]}      | ${'Impossible to play the BUY step of candle 1 on ETH/USDT: symbol must be one of the watched pairs (BTC/USDT)'}
    `('refuses $case, naming it and the watched pairs', ({ steps, watched, expected }) => {
      expect(() => start(steps, watched)).toThrow(new GekkoError('strategy', expected));
    });

    // The position book says, at info level, which pairs it tracks: the refusal comes before that line, the bot stopping at start-up
    it('refuses such a step before it tracks a pair', () => {
      try {
        start([{ candle: 0, side: 'BUY', symbols: [XRP] }], [BTC, ETH]);
      } catch {
        // Refused, as the test above asserts
      }
      expect(positions.trackCalls).toEqual([]);
    });
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    // Each order completes once its candle is over: a BUY leaves the pair long, a SELL flat. The steps of a candle are played in the
    // order of the block.
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

    // An order holds no amount, cost or allocation: the position book sizes a BUY, and a SELL sells all of its asset
    it('places a MARKET BUY then a MARKET SELL of the one pair watched through tools.positions', () => {
      start([
        { candle: 0, side: 'BUY' },
        { candle: 1, side: 'SELL' },
      ]);
      play(2);
      expect(positions.advices).toStrictEqual([buy(BTC), sell(BTC)]);
    });

    it.each`
      case                                                    | steps                                                 | position  | expected
      ${'a BUY step without symbols, on every watched pair'}  | ${[{ candle: 0, side: 'BUY' }]}                       | ${'FLAT'} | ${[buy(BTC), buy(ETH)]}
      ${'a BUY step on its symbols, in their order'}          | ${[{ candle: 0, side: 'BUY', symbols: [ETH, BTC] }]}  | ${'FLAT'} | ${[buy(ETH), buy(BTC)]}
      ${'a BUY step on one pair'}                             | ${[{ candle: 0, side: 'BUY', symbols: [ETH] }]}       | ${'FLAT'} | ${[buy(ETH)]}
      ${'a SELL step without symbols, on every watched pair'} | ${[{ candle: 0, side: 'SELL' }]}                      | ${'LONG'} | ${[sell(BTC), sell(ETH)]}
      ${'a SELL step on its symbols, in their order'}         | ${[{ candle: 0, side: 'SELL', symbols: [ETH, BTC] }]} | ${'LONG'} | ${[sell(ETH), sell(BTC)]}
    `('places the orders of two pairs, each $position: $case', ({ steps, position, expected }) => {
      start(steps, [BTC, ETH]);
      positions.set(BTC, position);
      positions.set(ETH, position);
      playCandle();
      expect(positions.advices).toStrictEqual(expected);
    });

    // The position of the pair is read before each step: a BUY needs it flat, a SELL long, with no order of the pair pending. A BUY
    // the position book skips is asked all the same: the book alone says why, the step logging nothing.
    it.each`
      side      | position      | expected
      ${'BUY'}  | ${'FLAT'}     | ${{ advices: [buy(BTC)], logs: [] }}
      ${'BUY'}  | ${'LONG'}     | ${{ advices: [], logs: [infoLine('[BTC/USDT] BUY step of candle 0 skipped: the strategy is long')] }}
      ${'BUY'}  | ${'BUYING'}   | ${{ advices: [], logs: [infoLine('[BTC/USDT] BUY step of candle 0 skipped: an order is pending')] }}
      ${'BUY'}  | ${'SELLING'}  | ${{ advices: [], logs: [infoLine('[BTC/USDT] BUY step of candle 0 skipped: an order is pending')] }}
      ${'BUY'}  | ${'SKIPPING'} | ${{ advices: [{ ...buy(BTC), skipped: true }], logs: [] }}
      ${'SELL'} | ${'LONG'}     | ${{ advices: [sell(BTC)], logs: [] }}
      ${'SELL'} | ${'FLAT'}     | ${{ advices: [], logs: [infoLine('[BTC/USDT] SELL step of candle 0 skipped: the strategy is flat')] }}
      ${'SELL'} | ${'BUYING'}   | ${{ advices: [], logs: [infoLine('[BTC/USDT] SELL step of candle 0 skipped: an order is pending')] }}
      ${'SELL'} | ${'SELLING'}  | ${{ advices: [], logs: [infoLine('[BTC/USDT] SELL step of candle 0 skipped: an order is pending')] }}
    `(
      'plays a $side step on a pair $position as its position allows, said at info level when it skips it',
      ({ side, position, expected }) => {
        start([{ candle: 0, side }]);
        positions.set(BTC, position);
        playCandle();
        expect({ advices: positions.advices, logs }).toStrictEqual(expected);
      },
    );

    it('skips a step on the pair whose position does not allow it alone, naming that pair', () => {
      start([{ candle: 0, side: 'BUY' }], [BTC, ETH]);
      positions.set(BTC, 'LONG');
      playCandle();
      expect({ logs, advices: positions.advices }).toStrictEqual({
        logs: [infoLine('[BTC/USDT] BUY step of candle 0 skipped: the strategy is long')],
        advices: [buy(ETH)],
      });
    });

    // In a run, init tracks the pairs before any candle
    it('plays a step without symbols on the pairs tracked, none before init', () => {
      toolsFor([{ candle: 0, side: 'BUY' }], [BTC, ETH]);
      playCandle();
      expect({ advices: positions.advices, logs }).toEqual({ advices: [], logs: [] });
    });
  });
});

// The scripted positions this suite trades through, which a mock has no suite of its own to pin: a strategy may take tools.positions
// apart (`const { canBuy, buy } = tools.positions`), as it may the StrategyManager's, whose members are closures
describe('ScriptedPositions', () => {
  it('answers, tracks and records through its members taken apart, as through the object, its pairs the same array at each read', () => {
    const { tools, positions } = fakeTools(blockOf([{ candle: 0, side: 'BUY' }]), { pairs: [BTC, ETH] });
    const { track, isLong, isPendingOrder, canBuy, canSell, buy: placeBuy, sell: placeSell } = tools.positions;
    track();
    positions.set(ETH, 'LONG');
    expect({
      answers: [isLong(ETH), isPendingOrder(ETH), canBuy(BTC), canSell(ETH), canBuy(ETH), canSell(BTC)],
      ids: [placeBuy({ type: 'MARKET', symbol: BTC }), placeSell({ type: 'MARKET', symbol: ETH })],
      advices: positions.advices,
      pairs: tools.positions.pairs,
      isSameArray: tools.positions.pairs === tools.positions.pairs,
    }).toStrictEqual({
      answers: [true, false, true, true, false, false],
      ids: [orderId(1), orderId(2)],
      advices: [buy(BTC), sell(ETH)],
      pairs: [BTC, ETH],
      isSameArray: true,
    });
  });
});
