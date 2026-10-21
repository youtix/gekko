import type { Candle } from '@models/candle.types';
import type { DebugAdviceParams } from '@strategies/debug/debugAdvice.types';
import { beforeEach, describe, expect, it } from 'bun:test';
import { range } from 'lodash-es';
import { rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { clearLogs } from '../mocks/winston.mock';
import {
  canceledLimitOrder,
  minute,
  mockBacktestModules,
  numberedTextLines,
  openLimitOrder,
  rawMarket,
  runBacktest,
  unreservedRead,
} from './backtestRun.helper';

mockBacktestModules();

/**
 * A backtest of BTC, from an account holding 1 BTC and 300000 USDT, of the minutes 00:00 to the one `lastMinute` minutes after 00:00, on
 * 1m candles: DebugAdvice advises a STICKY order of 1, a SELL first. The price ticks by 0.01, and the fees are Binance's VIP 1: 0.09 %
 * for a maker, a limit order, which every transaction of a STICKY order is, and 0.1 % for a taker, a MARKET order.
 */
const backtestOf = (lastMinute: number, calendar: DebugAdviceParams | Omit<DebugAdviceParams, 'wait'>): RawConfiguration => ({
  watch: {
    mode: 'backtest',
    assets: ['BTC'],
    currency: 'USDT',
    timeframe: '1m',
    daterange: rawDaterange({ start: minute(0), end: minute(lastMinute + 1) - 1 }),
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [
      { assetName: 'BTC', balance: 1 },
      { assetName: 'USDT', balance: 300000 },
    ],
    marketData: [rawMarket('BTC/USDT', { priceMin: 0.01, fee: { maker: 0.0009, taker: 0.001 } })],
  },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [{ name: 'TradingAdvisor', strategyName: 'DebugAdvice' }, { name: 'Trader' }],
  strategy: { name: 'DebugAdvice', ...calendar },
});

type Prices = Pick<Candle, 'open' | 'high' | 'low' | 'close'>;
/** BTC at 10000, 5 either side, every minute that `prices` does not list */
const candlesOf = (lastMinute: number, prices: Record<number, Prices>): Candle[] =>
  range(lastMinute + 1).map(n => ({
    start: minute(n),
    volume: 10,
    ...(prices[n] ?? { open: 10000, high: 10005, low: 9995, close: 10000 }),
  }));

/**
 * The lines of the Trader and of the strategy that say how each order ended, oldest first, each order named by its rank in the run. Of
 * those two alone: at debug level, the line an order logs as its transaction is canceled matched too.
 */
const orderEnds = () =>
  numberedTextLines()
    .filter(
      ({ _tag, message }) =>
        ['TRADER', 'STRATEGY'].includes(_tag) && /order summary|order canceled|Order (Completed|Canceled)/.test(message),
    )
    .map(({ _tag, message }) => `${_tag} | ${message}`);

describe('E2E: Backtest STICKY orders', () => {
  beforeEach(() => {
    clearLogs();
  });

  it('moves a STICKY order once the market has gone past it, a candle filling it at its new price, the maker fee charged', async () => {
    // The SELL of 00:00 rests at 9999.99, one tick under the close: the candle of 00:01 never reaches it and closes below it, at 9990.
    // The BUY of 00:03 rests at 9990.01: the candle of 00:04 never reaches it and closes above it, at 10005. The SELL of 00:06 rests at
    // 9999.99, which the next candle reaches.
    const runAway: Record<number, Prices> = {
      1: { open: 9995, high: 9995, low: 9985, close: 9990 },
      2: { open: 9990, high: 9995, low: 9985, close: 9990 },
      3: { open: 9990, high: 9995, low: 9985, close: 9990 },
      4: { open: 10000, high: 10010, low: 9995, close: 10005 },
      5: { open: 10005, high: 10010, low: 9990, close: 10000 },
    };
    const { failure, orderCalls, balanceReads } = await runBacktest(backtestOf(7, { each: 3 }), { 'BTC/USDT': candlesOf(7, runAway) });

    // The Trader checks its STICKY orders on every bucket, once the simulated exchange has settled it: an order the close went past is
    // moved, its transaction canceled, then what is left placed again one tick beyond that close. Each transaction is a limit order,
    // filled at its own price once a candle reaches it.
    expect({ failure, orderCalls, orderEnds: orderEnds(), balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      orderCalls: [
        openLimitOrder(minute(1), 'BTC/USDT', 'SELL', 1, 9999.99, 1),
        // The close of 00:01, 9990, is below the SELL: moved to 9990 - 0.01
        canceledLimitOrder(minute(2), 1),
        openLimitOrder(minute(2), 'BTC/USDT', 'SELL', 1, 9989.99, 2),
        // Filled by the high of 00:02, 9995; the BUY rests at the close of 00:03 plus a tick
        openLimitOrder(minute(4), 'BTC/USDT', 'BUY', 1, 9990.01, 3),
        // The close of 00:04, 10005, is above the BUY: moved to 10005 + 0.01
        canceledLimitOrder(minute(5), 3),
        openLimitOrder(minute(5), 'BTC/USDT', 'BUY', 1, 10005.01, 4),
        // Filled by the low of 00:05, 9990; the SELL of 00:06 is filled by the high of 00:07, 10005
        openLimitOrder(minute(7), 'BTC/USDT', 'SELL', 1, 9999.99, 5),
      ],
      // Each fill dated at the end of the minute that filled it, at the price of its transaction, less or plus the maker fee
      orderEnds: [
        // 9989.99 × 0.0009 = 8.990991 of fee: 9989.99 - 8.990991
        'TRADER | [order 1] SELL STICKY order summary for BTC/USDT: Completed at: 2024-01-01T00:03:00.000Z Order amount: 1, Effective price: 9980.999009, Fee: 8.990991, Fee percent: 0.09,',
        'STRATEGY | Order Completed: order 1',
        // 10005.01 × 0.0009 = 9.004509: 10005.01 + 9.004509
        'TRADER | [order 2] BUY STICKY order summary for BTC/USDT: Completed at: 2024-01-01T00:06:00.000Z Order amount: 1, Effective price: 10014.014509, Fee: 9.004509, Fee percent: 0.09,',
        'STRATEGY | Order Completed: order 2',
        // 9999.99 × 0.0009 = 8.999991: 9999.99 - 8.999991
        'TRADER | [order 3] SELL STICKY order summary for BTC/USDT: Completed at: 2024-01-01T00:08:00.000Z Order amount: 1, Effective price: 9990.990009, Fee: 8.999991, Fee percent: 0.09,',
        'STRATEGY | Order Completed: order 3',
      ],
      // After the TradingAdvisor's and the Trader's reads at start-up and the one of the end of the warmup: one after each fill
      balanceReads: [
        // 300000 + 9980.999009
        unreservedRead(minute(3), { BTC: 0, USDT: 309980.999009 }),
        // 309980.999009 - 10014.014509
        unreservedRead(minute(6), { BTC: 1, USDT: 299966.9845 }),
        // 299966.9845 + 9990.990009
        unreservedRead(minute(8), { BTC: 0, USDT: 309957.974509 }),
      ],
    });
  });

  it('moves a STICKY order the strategy cancels on the bucket the market runs away from it, then cancels the move, releasing the BTC', async () => {
    // The SELL of 00:00 rests at 9999.99: the candle of 00:01 never reaches it and closes below it, at 9990. The strategy cancels each of
    // its orders a candle after it advised it.
    const runAway: Record<number, Prices> = { 1: { open: 9995, high: 9995, low: 9985, close: 9990 } };
    const { failure, orderCalls, balanceReads } = await runBacktest(backtestOf(2, { each: 10, cancelAfter: 1 }), {
      'BTC/USDT': candlesOf(2, runAway),
    });

    // The simulated exchange settles the bucket of 00:01, then the plugins process it: the Trader moves the SELL, the strategy asks for its
    // cancelation, which reaches the Trader as the events of the bucket are flushed, after the move
    expect({ failure, orderCalls, orderEnds: orderEnds(), balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      orderCalls: [
        openLimitOrder(minute(1), 'BTC/USDT', 'SELL', 1, 9999.99, 1),
        canceledLimitOrder(minute(2), 1),
        openLimitOrder(minute(2), 'BTC/USDT', 'SELL', 1, 9989.99, 2),
        canceledLimitOrder(minute(2), 2),
      ],
      orderEnds: ['TRADER | [order 1] SELL STICKY order canceled (filled: 0, remaining: 1)', 'STRATEGY | Order Canceled: order 1'],
      // The synchronization after the cancelation: the BTC each transaction reserved is free again
      balanceReads: [unreservedRead(minute(2), { BTC: 1, USDT: 300000 })],
    });
  });
});
