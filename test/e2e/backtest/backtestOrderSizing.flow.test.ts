import type { Candle } from '@models/candle.types';
import type { TradingPair } from '@models/utility.types';
import type { DebugBacktestParams } from '@strategies/debug/debugBacktest.types';
import { beforeEach, describe, expect, it } from 'bun:test';
import { range } from 'lodash-es';
import { fileURLToPath } from 'node:url';
import { rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { clearLogs } from '../mocks/winston.mock';
import {
  filledMarketOrder,
  minute,
  mockBacktestModules,
  numberedTextLines,
  openLimitOrder,
  rawMarket,
  refusedMarketOrder,
  runBacktest,
  unreservedRead,
} from './backtestRun.helper';

mockBacktestModules();

/**
 * What a scenario sizes: the balances it starts from, the most BTC one order takes, the least an order costs on every market, and the
 * calendar of DebugBacktest with the sizing of its orders
 */
type Sizing = {
  balances: { BTC: number; ETH?: number; USDT: number };
  btcAmountMax?: number;
  costMin?: number;
  calendar: DebugBacktestParams;
};

/** A backtest of the minutes 00:00 to 00:08 on 1m candles, of BTC alone or of BTC then ETH when the scenario holds an ETH balance */
const backtestOf = ({ balances, btcAmountMax, costMin, calendar }: Sizing): RawConfiguration => {
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
      marketData: assets.map(asset => rawMarket(`${asset}/USDT`, { amountMax: asset === 'BTC' ? btcAmountMax : undefined, costMin })),
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

/** The strategy file of the scenarios whose pairs order on candles of their own, loaded as a strategy file of the user's is */
const ORDER_STEPS_PATH = fileURLToPath(new URL('./orderSteps.strategy.ts', import.meta.url));

/** The warnings the Trader logged, oldest first, each order named by its rank among the orders of the run */
const traderWarnings = () =>
  numberedTextLines()
    .filter(({ level, _tag }) => level === 'warn' && _tag === 'TRADER')
    .map(({ message }) => message);

/** How the simulated exchange refuses an order sized to nothing, before its balances are read */
const AMOUNT_OF_0 = "OrderOutOfRangeError: [EXCHANGE] Order 'amount' with value 0 is invalid. Expected a finite number greater than 0.";

/** How the simulated exchange refuses an order whose cost, its amount at its price, falls below a minimum cost of 10 */
const costBelow10 = (cost: number) =>
  `OrderOutOfRangeError: [EXCHANGE] Order 'cost' with value ${cost} is out of range. Expected a value between 10 and 1000000.`;

/**
 * What the BUYs of 00:01 and the SELLs of 00:03 send and read when each spends, or sells, the whole balance, on BTC then ETH from 300000
 * USDT: all-in, or allocated 100 %. The BTC BUY takes all the currency, which leaves the ETH BUY nothing and the ETH SELL no ETH: sized
 * to 0, the market refuses both. The BTC SELL sells what the BTC BUY bought. Each order goes out with its candle and is dated at its end.
 */
const WHOLE_BALANCE = {
  orderCalls: [
    // 300000 USDT less the 5 % kept back for the fee, at 10000: 285000 / 10000
    filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 28.5, 1),
    refusedMarketOrder(minute(2), 'ETH/USDT', 'BUY', 0, AMOUNT_OF_0),
    filledMarketOrder(minute(4), 'BTC/USDT', 'SELL', 28.5, 2),
    refusedMarketOrder(minute(4), 'ETH/USDT', 'SELL', 0, AMOUNT_OF_0),
  ],
  // After the TradingAdvisor's and the Trader's reads at start-up and that of the end of the warmup: one synchronization after the orders
  // of each candle, which the BUY's fill and the ETH refusal share
  balanceReads: [
    // 28.5 × 10000 × 1.001 = 285285 spent: of the 5 % kept back, what the fee left
    unreservedRead(minute(2), { BTC: 28.5, ETH: 0, USDT: 14715 }),
    // 28.5 × 10000 × 0.999 = 284715 brought in
    unreservedRead(minute(4), { BTC: 0, ETH: 0, USDT: 299430 }),
  ],
};

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
    // it last read, the BTC BUY taking all it was sized from. The SELLs of 00:03 sell what the BUYs left free, nothing of ETH.
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        // Nothing left of the 300000 USDT once the BTC BUY took them
        '[order 2] All-in BUY MARKET order sized from 0 USDT: 0 ETH sent (300000 USDT free at the last synchronization, less 300000 USDT for the BUYs placed since, the 5 % kept back for their fee included)',
        '[order 4] All-in SELL MARKET order sized from 0 ETH: 0 ETH sent, which the market refuses (0 ETH free at the last synchronization)',
      ],
      orderCalls: WHOLE_BALANCE.orderCalls,
      balanceReads: WHOLE_BALANCE.balanceReads,
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

  it('sizes the BUYs and the SELLs allocated 100 % as all-in ones: the same orders and balances, warned of for the same orders', async () => {
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({ balances: { BTC: 0, ETH: 0, USDT: 300000 }, calendar: { buyCandleIndex: 1, sellCandleIndex: 3, allocation: 100 } }),
      CANDLES,
    );

    // 100 % of the 300000 USDT read is all an all-in BUY is sized from: the BTC BUY takes it all, and the ETH BUY, which asks for the same
    // share of the same read, is capped at what that leaves, nothing. The SELLs of 00:03 sell 100 % of the 28.5 BTC and of the 0 ETH read
    // after the BUYs. The warnings name the allocation where those of all-in orders say all-in.
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        // 300000 - 300000 left, the budget of the BTC BUY
        '[order 2] BUY MARKET order of 300000 USDT (100 % of 300000 USDT): 0 ETH sent, which the market refuses (300000 USDT free at the last synchronization, less 300000 USDT for the BUYs placed since)',
        // 100 % of the 0 ETH the refused BUY left
        '[order 4] SELL MARKET order of 0 ETH (100 % of 0 ETH): 0 ETH sent, which the market refuses (0 ETH free at the last synchronization)',
      ],
      orderCalls: WHOLE_BALANCE.orderCalls,
      balanceReads: WHOLE_BALANCE.balanceReads,
    });
  });

  it('sizes each BUY allocated 50 % from the currency read, the second as the first, then each SELL allocated 50 % from its asset read', async () => {
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({ balances: { BTC: 0, ETH: 0, USDT: 300000 }, calendar: { buyCandleIndex: 1, sellCandleIndex: 3, allocation: 50 } }),
      CANDLES,
    );

    // A share is of the balance the last synchronization read, not of what the orders placed since leave: the ETH BUY is sized from the
    // 300000 USDT read, as the BTC BUY is, and the 150000 the BTC BUY leaves cover it, so that neither is warned of. Sized from what is
    // left, it would have bought half as much.
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [],
      orderCalls: [
        // 50 % of 300000 USDT, 150000, less the 5 % kept back for the fee: 142500 / 10000
        filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 14.25, 1),
        // 142500 / 2000
        filledMarketOrder(minute(2), 'ETH/USDT', 'BUY', 71.25, 2),
        // 50 % of the 14.25 BTC and of the 71.25 ETH read after the BUYs
        filledMarketOrder(minute(4), 'BTC/USDT', 'SELL', 7.125, 3),
        filledMarketOrder(minute(4), 'ETH/USDT', 'SELL', 35.625, 4),
      ],
      balanceReads: [
        // 142500 × 1.001 = 142642.5 spent on each pair: 300000 - 285285
        unreservedRead(minute(2), { BTC: 14.25, ETH: 71.25, USDT: 14715 }),
        // 7.125 × 10000 and 35.625 × 2000, 71250 each, of which 0.999 brought in, 71178.75: 14715 + 142357.5
        unreservedRead(minute(4), { BTC: 7.125, ETH: 35.625, USDT: 157072.5 }),
      ],
    });
  });

  it('caps a BUY by cost at what the BUY before it leaves, then sells by cost the notional at the price, capped at the free balance', async () => {
    // An account holding 2 BTC already and no ETH: the BTC SELL finds more than it sells, the ETH SELL less
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({ balances: { BTC: 2, ETH: 0, USDT: 300000 }, calendar: { buyCandleIndex: 1, sellCandleIndex: 3, cost: 200000 } }),
      CANDLES,
    );

    // A BUY may spend its cost, the 5 % kept back for the fee included, a SELL sells its cost over the price, the fee coming out of what it
    // brings in: the BUY of 200000 USDT of BTC buys 19 BTC, the SELL of 200000 USDT sells 20
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        // 300000 - 200000 left, of which 95 % at 2000: 95000 / 2000
        '[order 2] BUY MARKET order of 200000 USDT above the free balance, sized from 100000 USDT: 47.5 ETH sent (300000 USDT free at the last synchronization, less 200000 USDT for the BUYs placed since, the 5 % kept back for their fee included)',
        // 200000 / 2000, of which the account holds the 47.5 ETH bought
        '[order 4] SELL MARKET order of 100 ETH (200000 USDT at 2000) above the free balance: 47.5 ETH sent, all that can be sold',
      ],
      orderCalls: [
        // 200000 USDT less the 5 % kept back for the fee, at 10000: 190000 / 10000
        filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 19, 1),
        filledMarketOrder(minute(2), 'ETH/USDT', 'BUY', 47.5, 2),
        // 200000 / 10000, of the 21 BTC held
        filledMarketOrder(minute(4), 'BTC/USDT', 'SELL', 20, 3),
        filledMarketOrder(minute(4), 'ETH/USDT', 'SELL', 47.5, 4),
      ],
      balanceReads: [
        // 190000 × 1.001 = 190190 and 95000 × 1.001 = 95095 spent: 300000 - 285285
        unreservedRead(minute(2), { BTC: 21, ETH: 47.5, USDT: 14715 }),
        // 200000 × 0.999 = 199800 and 95000 × 0.999 = 94905 brought in: 14715 + 294705
        unreservedRead(minute(4), { BTC: 1, ETH: 0, USDT: 309420 }),
      ],
    });
  });

  it('sizes a BUY allocated 50 % from the currency read and what a BUY resting at that read holds, as on the candle of that BUY', async () => {
    // From 300000 USDT, the BTC BUY of 00:01 is a LIMIT BUY at 9500 allocated 50 %, which rests below the market of 10000 to the end; the
    // ETH BUY of 00:12, allocated 50 % too, comes after the synchronization of 00:10. BTC's maker fee is 0, so that the simulator reserves
    // what Binance reserves for a resting BUY, its amount at its price: it reserves a maker fee in the currency too, where Binance takes
    // the fee from what the BUY brings in.
    const minutes = range(15);
    const { failure, orderCalls, balanceReads } = await runBacktest(
      {
        watch: {
          mode: 'backtest',
          assets: ['BTC', 'ETH'],
          currency: 'USDT',
          timeframe: '1m',
          daterange: rawDaterange({ start: minute(0), end: minute(15) - 1 }),
        },
        exchange: {
          name: 'dummy-cex',
          simulationBalance: [
            { assetName: 'BTC', balance: 0 },
            { assetName: 'ETH', balance: 0 },
            { assetName: 'USDT', balance: 300000 },
          ],
          marketData: [rawMarket('BTC/USDT', { fee: { maker: 0, taker: 0.001 } }), rawMarket('ETH/USDT')],
        },
        storage: { type: 'sqlite', database: ':memory:' },
        plugins: [{ name: 'TradingAdvisor', strategyName: 'OrderSteps', strategyPath: ORDER_STEPS_PATH }, { name: 'Trader' }],
        strategy: {
          name: 'OrderSteps',
          steps: [
            { candle: 1, symbol: 'BTC/USDT', side: 'BUY', type: 'LIMIT', price: 9500, allocation: 50 },
            { candle: 12, symbol: 'ETH/USDT', side: 'BUY', type: 'MARKET', allocation: 50 },
          ],
        },
      },
      {
        'BTC/USDT': minutes.map(n => ({ start: minute(n), open: 10000, high: 10010, low: 9990, close: 10000, volume: 10 })),
        'ETH/USDT': minutes.map(n => ({ start: minute(n), open: 2000, high: 2002, low: 1998, close: 2000, volume: 10 })),
      },
    );

    // The read of 00:10 shows the BTC BUY's cost reserved, 142500 USDT, the 157500 left free. The PositionBook counts the BTC pair among
    // those it shares the currency between while its BUY rests, so the ETH BUY's share is of what the read shows free and of what that BUY
    // holds: 150000 USDT, as on the candle of the BTC BUY, before the read. A share of the 157500 read free alone bought 37.40625 ETH, and
    // left a quarter of the capital idle.
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [],
      orderCalls: [
        // 50 % of 300000 USDT, 150000, less the 5 % kept back for the fee, at 9500: 142500 / 9500
        openLimitOrder(minute(2), 'BTC/USDT', 'BUY', 15, 9500, 1),
        // 50 % of the 157500 USDT read free and the 142500 the BTC BUY holds, 150000, of which 95 % at 2000: 142500 / 2000
        filledMarketOrder(minute(13), 'ETH/USDT', 'BUY', 71.25, 2),
      ],
      balanceReads: [
        // The synchronization of 00:10, dated by the clock of the simulator, the end of that minute
        {
          at: minute(11),
          balance: {
            BTC: { free: 0, used: 0, total: 0 },
            ETH: { free: 0, used: 0, total: 0 },
            USDT: { free: 157500, used: 142500, total: 300000 },
          },
        },
        // After the ETH BUY: 71.25 × 2000 × 1.001 = 142642.5 spent, the BTC BUY still resting
        {
          at: minute(13),
          balance: {
            BTC: { free: 0, used: 0, total: 0 },
            ETH: { free: 71.25, used: 0, total: 71.25 },
            USDT: { free: 14857.5, used: 142500, total: 157357.5 },
          },
        },
      ],
    });
  });

  it('warns of a BUY and a SELL whose cost falls below the minimum cost of the market, which refuses both', async () => {
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({ balances: { BTC: 0.04, USDT: 500 }, costMin: 10, calendar: { buyCandleIndex: 1, sellCandleIndex: 3, allocation: 2 } }),
      { 'BTC/USDT': CANDLES['BTC/USDT'] },
    );

    // The Trader compares the cost of the order, its amount at its price, with the minimum: a BUY costs its budget less the 5 % kept back
    // for the fee, so that one whose budget is the minimum is refused. Each order is sent all the same.
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        // 2 % of 500 USDT, of which 95 % at 10000: 9.5 / 10000
        '[order 1] BUY MARKET order of 10 USDT (2 % of 500 USDT): 0.00095 BTC at 10000 sent, a cost of 9.5 USDT once 5 % is kept back for the fee, below the minimum cost of 10 USDT on BTC/USDT, which the market refuses',
        // 2 % of 0.04 BTC, at 10000: 0.0008 × 10000
        '[order 2] SELL MARKET order of 0.0008 BTC (2 % of 0.04 BTC): 0.0008 BTC at 10000 sent, a cost of 8 USDT, below the minimum cost of 10 USDT on BTC/USDT, which the market refuses',
      ],
      orderCalls: [
        refusedMarketOrder(minute(2), 'BTC/USDT', 'BUY', 0.00095, costBelow10(9.5)),
        refusedMarketOrder(minute(4), 'BTC/USDT', 'SELL', 0.0008, costBelow10(8)),
      ],
      // Nothing filled: each synchronization after a refusal reads the balances the account started with
      balanceReads: [unreservedRead(minute(2), { BTC: 0.04, USDT: 500 }), unreservedRead(minute(4), { BTC: 0.04, USDT: 500 })],
    });
  });
});
