import type { Candle } from '@models/candle.types';
import type { TradingPair } from '@models/utility.types';
import type { DebugBacktestParams } from '@strategies/debug/debugBacktest.types';
import { beforeEach, describe, expect, it } from 'bun:test';
import { range } from 'lodash-es';
import { rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { clearLogs } from '../mocks/winston.mock';
import {
  filledMarketOrder,
  minute,
  mockBacktestModules,
  numberedTextLines,
  rawMarket,
  refusedMarketOrder,
  runBacktest,
  unreservedRead,
} from './backtestRun.helper';

mockBacktestModules();

/** What a scenario sizes: the balances it starts from, the most BTC one order takes, and the calendar of DebugBacktest */
type Sizing = {
  balances: { BTC: number; ETH?: number; USDT: number };
  btcAmountMax?: number;
  calendar: DebugBacktestParams;
};

/** A backtest of the minutes 00:00 to 00:08 on 1m candles, of BTC alone or of BTC then ETH when the scenario holds an ETH balance */
const backtestOf = ({ balances, btcAmountMax, calendar }: Sizing): RawConfiguration => {
  const assets = Object.keys(balances).filter(asset => asset !== 'USDT') as ('BTC' | 'ETH')[];
  return {
    watch: {
      mode: 'backtest',
      assets,
      currency: 'USDT',
      timeframe: '1m',
      daterange: rawDaterange({ start: minute(0), end: minute(9) - 1 }),
    },
    exchange: {
      name: 'dummy-cex',
      simulationBalance: Object.entries(balances).map(([assetName, balance]) => ({ assetName, balance })),
      marketData: assets.map(asset => rawMarket(`${asset}/USDT`, asset === 'BTC' ? { amountMax: btcAmountMax } : {})),
    },
    storage: { type: 'sqlite', database: ':memory:' },
    plugins: [{ name: 'TradingAdvisor', strategyName: 'DebugBacktest' }, { name: 'Trader' }],
    strategy: { name: 'DebugBacktest', ...calendar },
  };
};

/** The candles of 00:00 to 00:08 at a price that does not move, each high and low 1 ‰ off it: a MARKET order fills at the price */
const flatCandles = (price: number): Candle[] =>
  range(9).map(n => ({ start: minute(n), open: price, high: price * 1.001, low: price * 0.999, close: price, volume: 10 }));

const CANDLES: Record<TradingPair, Candle[]> = { 'BTC/USDT': flatCandles(10000), 'ETH/USDT': flatCandles(2000) };

/** The warnings the Trader logged, oldest first, each order named by its rank among the orders of the run */
const traderWarnings = () =>
  numberedTextLines()
    .filter(({ level, _tag }) => level === 'warn' && _tag === 'TRADER')
    .map(({ message }) => message);

/** How the simulated exchange refuses an order sized to nothing, before its balances are read */
const AMOUNT_OF_0 = "OrderOutOfRangeError: [EXCHANGE] Order 'amount' with value 0 is invalid. Expected a finite number greater than 0.";

describe('E2E: Backtest order sizing', () => {
  beforeEach(() => {
    clearLogs();
  });

  it('sizes the second all-in BUY of a candle from the currency the first leaves, nothing, which the market refuses', async () => {
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({ balances: { BTC: 0, ETH: 0, USDT: 300000 }, calendar: { buyCandleIndex: 1, sellCandleIndex: 3, allIn: true } }),
      CANDLES,
    );

    // The candle of 00:01 asks for an all-in BUY of BTC, then of ETH, in the order of watch.assets: the Trader sizes both from the balance
    // it last read, the BTC BUY taking all it was sized from. The SELLs of 00:03 sell what the BUYs left free, nothing of ETH. Each order
    // goes out with its candle and is dated at its end.
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        // Nothing left of the 300000 USDT once the BTC BUY took them
        '[order 2] All-in BUY MARKET order sized from 0 USDT: 0 ETH sent (300000 USDT free at the last synchronization, less 300000 USDT for the BUYs placed since, the 5 % kept back for their fee included)',
        '[order 4] All-in SELL MARKET order sized from 0 ETH: 0 ETH sent, which the market refuses (0 ETH free at the last synchronization)',
      ],
      orderCalls: [
        // 300000 USDT less the 5 % kept back for the fee, at 10000: 285000 / 10000
        filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 28.5, 1),
        refusedMarketOrder(minute(2), 'ETH/USDT', 'BUY', 0, AMOUNT_OF_0),
        filledMarketOrder(minute(4), 'BTC/USDT', 'SELL', 28.5, 2),
        refusedMarketOrder(minute(4), 'ETH/USDT', 'SELL', 0, AMOUNT_OF_0),
      ],
      // After the TradingAdvisor's and the Trader's reads at start-up and that of the end of the warmup: one synchronization after the
      // orders of each candle, which the BUY's fill and the ETH refusal share
      balanceReads: [
        // 28.5 × 10000 × 1.001 = 285285 spent: of the 5 % kept back, what the fee left
        unreservedRead(minute(2), { BTC: 28.5, ETH: 0, USDT: 14715 }),
        // 28.5 × 10000 × 0.999 = 284715 brought in
        unreservedRead(minute(4), { BTC: 0, ETH: 0, USDT: 299430 }),
      ],
    });
  });

  it('caps an all-in BUY at the most the market takes in one order, the next all-in BUY spending what it leaves, again after a round trip', async () => {
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({
        balances: { BTC: 0, ETH: 0, USDT: 300000 },
        btcAmountMax: 20,
        calendar: { buyCandleIndex: [1, 5], sellCandleIndex: [3, 7], allIn: true },
      }),
      CANDLES,
    );

    // The BTC BUY takes what it may spend at most: 20 BTC at 10000, its cost over the 95 % an all-in BUY spends, 200000 / 0.95. The ETH
    // BUY is sized from the rest, 95 % of it at 2000. The BUYs of 00:05 are sized from the balance the synchronizations after the SELLs
    // read alone: the orders of the first round trip take nothing more from it.
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        // 300000 × 0.95 / 10000
        '[order 1] All-in BUY MARKET order sized from 300000 USDT: 28.5 BTC, above the maximum amount of a MARKET order on BTC/USDT: 20 BTC sent, the rest of the USDT left unspent',
        // 300000 - 210526.31578947368 = 89473.68421052632, of which 95 % at 2000: 85000 / 2000
        '[order 2] All-in BUY MARKET order sized from 89473.68421052632 USDT: 42.5 ETH sent (300000 USDT free at the last synchronization, less 210526.31578947368 USDT for the BUYs placed since, the 5 % kept back for their fee included)',
        // 299430 × 0.95 / 10000
        '[order 5] All-in BUY MARKET order sized from 299430 USDT: 28.44585 BTC, above the maximum amount of a MARKET order on BTC/USDT: 20 BTC sent, the rest of the USDT left unspent',
        // 299430 - 210526.31578947368 = 88903.68421052632, of which 95 % at 2000: 84458.5 / 2000
        '[order 6] All-in BUY MARKET order sized from 88903.68421052632 USDT: 42.22925 ETH sent (299430 USDT free at the last synchronization, less 210526.31578947368 USDT for the BUYs placed since, the 5 % kept back for their fee included)',
      ],
      orderCalls: [
        filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 20, 1),
        filledMarketOrder(minute(2), 'ETH/USDT', 'BUY', 42.5, 2),
        filledMarketOrder(minute(4), 'BTC/USDT', 'SELL', 20, 3),
        filledMarketOrder(minute(4), 'ETH/USDT', 'SELL', 42.5, 4),
        filledMarketOrder(minute(6), 'BTC/USDT', 'BUY', 20, 5),
        filledMarketOrder(minute(6), 'ETH/USDT', 'BUY', 42.22925, 6),
        filledMarketOrder(minute(8), 'BTC/USDT', 'SELL', 20, 7),
        filledMarketOrder(minute(8), 'ETH/USDT', 'SELL', 42.22925, 8),
      ],
      balanceReads: [
        // 20 × 10000 × 1.001 = 200200 and 42.5 × 2000 × 1.001 = 85085 spent: 300000 - 285285
        unreservedRead(minute(2), { BTC: 20, ETH: 42.5, USDT: 14715 }),
        // 199800 and 84915 brought in, 0.999 of 200000 and of 85000: 14715 + 284715
        unreservedRead(minute(4), { BTC: 0, ETH: 0, USDT: 299430 }),
        // 200200 and 42.22925 × 2000 × 1.001 = 84542.9585 spent: 299430 - 284742.9585
        unreservedRead(minute(6), { BTC: 20, ETH: 42.22925, USDT: 14687.0415 }),
        // 199800 and 84458.5 × 0.999 = 84374.0415 brought in: 14687.0415 + 284174.0415
        unreservedRead(minute(8), { BTC: 0, ETH: 0, USDT: 298861.083 }),
      ],
    });
  });

  it('caps a SELL at the most the market takes in one order, the rest held for the next SELL, then at the free balance', async () => {
    // An account holding a position larger than one MARKET order can sell: 1 BTC, where the market takes 0.4 at most
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({ balances: { BTC: 1, USDT: 0 }, btcAmountMax: 0.4, calendar: { buyCandleIndex: [], sellCandleIndex: [1, 2, 3] } }),
      { 'BTC/USDT': CANDLES['BTC/USDT'] },
    );

    // Each SELL of 1 BTC is sized from the balance the synchronization after the SELL before it read
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        '[order 1] SELL MARKET order of 1 BTC above the maximum amount of a MARKET order on BTC/USDT: 0.4 BTC sent, the rest stays held',
        // 0.6 BTC free, more than one order takes
        '[order 2] SELL MARKET order of 1 BTC above the maximum amount of a MARKET order on BTC/USDT: 0.4 BTC sent, the rest stays held',
        '[order 3] SELL MARKET order of 1 BTC above the free balance: 0.2 BTC sent, all that can be sold',
      ],
      orderCalls: [
        filledMarketOrder(minute(2), 'BTC/USDT', 'SELL', 0.4, 1),
        filledMarketOrder(minute(3), 'BTC/USDT', 'SELL', 0.4, 2),
        filledMarketOrder(minute(4), 'BTC/USDT', 'SELL', 0.2, 3),
      ],
      // Each SELL brings in 0.999 of its amount at 10000
      balanceReads: [
        unreservedRead(minute(2), { BTC: 0.6, USDT: 3996 }),
        unreservedRead(minute(3), { BTC: 0.2, USDT: 7992 }),
        unreservedRead(minute(4), { BTC: 0, USDT: 9990 }),
      ],
    });
  });
});
