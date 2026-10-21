import type { Candle } from '@models/candle.types';
import { beforeEach, describe, expect, it } from 'bun:test';
import { rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { clearLogs, numberedTextLines } from '../mocks/winston.mock';
import { filledMarketOrder, minute, mockBacktestModules, rawMarket, runBacktest, unreservedRead } from './backtestRun.helper';

mockBacktestModules();
// DebugTrailingStop logs the life of its stop at debug level: the logger hands a debug line to winston only when GEKKO_LOG_LEVEL lets it
// through, and the logger is loaded after this, by the pipeline
process.env.GEKKO_LOG_LEVEL = 'debug';

/** A backtest of BTC on 1m candles, of the minutes 00:00 to 00:04, from 300000 USDT: DebugTrailingStop buys 1 BTC on 00:00 with a stop */
const BACKTEST: RawConfiguration = {
  watch: {
    mode: 'backtest',
    assets: ['BTC'],
    currency: 'USDT',
    timeframe: '1m',
    daterange: rawDaterange({ start: minute(0), end: minute(5) - 1 }),
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [
      { assetName: 'BTC', balance: 0 },
      { assetName: 'USDT', balance: 300000 },
    ],
    marketData: [rawMarket('BTC/USDT')],
  },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [{ name: 'TradingAdvisor', strategyName: 'DebugTrailingStop' }, { name: 'Trader' }],
  // Dormant until a high reaches 9930, then 0.1 % under the highest price met
  strategy: { name: 'DebugTrailingStop', trigger: 9930, percentage: 0.1 },
};

/** The candle of the minute `n` minutes after 00:00, of these prices */
const candleOf = (n: number, open: number, high: number, low: number, close: number): Candle => ({
  start: minute(n),
  open,
  high,
  low,
  close,
  volume: 10,
});

describe('E2E: Backtest of a trailing stop', () => {
  beforeEach(() => {
    clearLogs();
  });

  it('arms the stop of a BUY as it fills, activates it at its trigger, then sells at the open under its stop price, the stop over', async () => {
    const candles = [
      // The BUY of 1 BTC, sent with this candle, fills at its close: its completion, heard with the bucket it fills in, arms its stop
      candleOf(0, 9500, 9500, 9500, 9500),
      // Below the trigger: the stop stays dormant
      candleOf(1, 9500, 9500, 9500, 9500),
      // Opens at 10000, above the trigger: active from the open, its peak 10000 and its stop price 0.1 % below, 9990, which the low of
      // 9995 stays above
      candleOf(2, 10000, 10000, 9995, 10000),
      // Opens at 9800, under the stop price: the stop triggers, and its MARKET SELL of the 1 BTC the BUY filled fills at the close
      candleOf(3, 9800, 9800, 9800, 9800),
      candleOf(4, 9800, 9800, 9800, 9800),
    ];
    const { failure, orderCalls, balanceReads } = await runBacktest(BACKTEST, { 'BTC/USDT': candles });

    // A backtest delivers an order's end with the bucket the order fills in, where a realtime run delivers it with the next one: the
    // stop is armed on the bucket of its BUY and trails from the next candle, and the SELL of its trigger ends on the bucket that sent
    // it. Once the run has ended, the strategy names the stops still armed or selling: none.
    expect({
      failure,
      strategyLines: numberedTextLines()
        .filter(({ _tag }) => _tag === 'STRATEGY')
        .map(({ level, message }) => `${level} | ${message}`),
      orderCalls,
      balanceReads: balanceReads.slice(3),
    }).toEqual({
      failure: undefined,
      strategyLines: [
        'info | Strategy warmup done ! Sending first candle bucket (2024-01-01T00:00:00.000Z) to strategy',
        'debug | Trailing stop BUY order created',
        'debug | Trailing stop order completed: order 1',
        'debug | Trailing stop activated: BUY order 1 on BTC/USDT, peak 10000, stop price 9990',
        'debug | Trailing stop triggered: BUY order 1 on BTC/USDT at stop price 9990, its MARKET SELL order 2 of 1 sent',
        'debug | Trailing stop order completed: order 2',
      ],
      // Each order goes out with its candle, filled at its close and dated at its end
      orderCalls: [filledMarketOrder(minute(1), 'BTC/USDT', 'BUY', 1, 1), filledMarketOrder(minute(4), 'BTC/USDT', 'SELL', 1, 2)],
      balanceReads: [
        // 9500 × 1.001 = 9509.5 spent
        unreservedRead(minute(1), { BTC: 1, USDT: 290490.5 }),
        // 9800 × 0.999 = 9790.2 brought in: 290490.5 + 9790.2
        unreservedRead(minute(4), { BTC: 0, USDT: 300280.7 }),
      ],
    });
  });
});
