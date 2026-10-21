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
  flatCandles,
  minute,
  mockBacktestModules,
  numberedTextLines,
  openLimitOrder,
  rawMarket,
  refusedMarketOrder,
  runBacktest,
  unreservedRead,
} from './backtestRun.helper';
import type { OrderStepsParams } from './orderSteps.strategy';

mockBacktestModules();

type Asset = 'BTC' | 'ETH';

/**
 * What a scenario sizes: the balances it starts from, the most of an asset one order takes and the fees of its market (1000 and Binance's
 * 0.1 % unless given), the least an order costs and the least amount it holds on every market, the decimals of their amounts (6 unless
 * given), the last minute read (00:08 unless given), and the orders: the calendar of DebugBacktest with the sizing of its orders, the
 * same on every pair, or the steps of OrderSteps, each order of its own pair, candle and sizing
 */
type Sizing = {
  balances: { BTC: number; ETH?: number; USDT: number };
  amountMax?: Partial<Record<Asset, number>>;
  fees?: Partial<Record<Asset, { maker: number; taker: number }>>;
  costMin?: number;
  amountMin?: number;
  amountDecimals?: number;
  lastMinute?: number;
} & ({ calendar: DebugBacktestParams } | { steps: OrderStepsParams['steps'] });

/** The strategy file of the scenarios whose orders OrderSteps places, loaded as a strategy file of the user's is */
const ORDER_STEPS_PATH = fileURLToPath(new URL('./orderSteps.strategy.ts', import.meta.url));

/** A backtest of the minutes from 00:00 on 1m candles, of BTC alone or of BTC then ETH when the scenario holds an ETH balance */
const backtestOf = (sizing: Sizing): RawConfiguration => {
  const { balances, amountMax = {}, fees = {}, costMin, amountMin, amountDecimals, lastMinute = 8 } = sizing;
  const assets = Object.keys(balances).filter(asset => asset !== 'USDT') as Asset[];
  const marketOf = (asset: Asset) =>
    rawMarket(`${asset}/USDT`, { amountMax: amountMax[asset], fee: fees[asset], costMin, amountMin, amountDecimals });
  // The strategy that places the orders: OrderSteps, loaded from its file, on its steps, or DebugBacktest on its calendar
  const { advisor, strategy } =
    'steps' in sizing
      ? {
          advisor: { name: 'TradingAdvisor', strategyName: 'OrderSteps', strategyPath: ORDER_STEPS_PATH },
          strategy: { name: 'OrderSteps', steps: sizing.steps },
        }
      : { advisor: { name: 'TradingAdvisor', strategyName: 'DebugBacktest' }, strategy: { name: 'DebugBacktest', ...sizing.calendar } };
  return {
    watch: {
      mode: 'backtest',
      assets,
      currency: 'USDT',
      timeframe: '1m',
      daterange: rawDaterange({ start: minute(0), end: minute(lastMinute + 1) - 1 }),
    },
    exchange: {
      name: 'dummy-cex',
      simulationBalance: Object.entries(balances).map(([assetName, balance]) => ({ assetName, balance })),
      marketData: assets.map(marketOf),
    },
    storage: { type: 'sqlite', database: ':memory:' },
    plugins: [advisor, { name: 'Trader' }],
    strategy,
  };
};

const CANDLES: Record<TradingPair, Candle[]> = { 'BTC/USDT': flatCandles(10000), 'ETH/USDT': flatCandles(2000) };

/** The warnings the Trader logged, oldest first, each order named by its rank among the orders of the run */
const traderWarnings = () =>
  numberedTextLines()
    .filter(({ level, _tag }) => level === 'warn' && _tag === 'TRADER')
    .map(({ message }) => message);

/** How the simulated exchange refuses an order sized to nothing, before its balances are read */
const AMOUNT_OF_0 = "OrderOutOfRangeError: [EXCHANGE] Order 'amount' with value 0 is invalid. Expected a finite number greater than 0.";

/** How the simulated exchange refuses an order whose amount, or its cost (the amount at its price), falls out of the range of the market */
const outOfRange = (value: 'amount' | 'cost', figure: number, [minimum, maximum]: [number, number]) =>
  `OrderOutOfRangeError: [EXCHANGE] Order '${value}' with value ${figure} is out of range. Expected a value between ${minimum} and ${maximum}.`;

/** How the simulated exchange refuses an order whose cost falls below a minimum cost of 10 */
const costBelow10 = (cost: number) => outOfRange('cost', cost, [10, 1000000]);

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
        amountMax: { BTC: 20 },
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
      backtestOf({ balances: { BTC: 1, USDT: 0 }, amountMax: { BTC: 0.4 }, calendar: { buyCandleIndex: [], sellCandleIndex: [1, 2, 3] } }),
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
      backtestOf({
        balances: { BTC: 0, ETH: 0, USDT: 300000 },
        fees: { BTC: { maker: 0, taker: 0.001 } },
        lastMinute: 14,
        steps: [
          { candle: 1, symbol: 'BTC/USDT', side: 'BUY', type: 'LIMIT', price: 9500, allocation: 50 },
          { candle: 12, symbol: 'ETH/USDT', side: 'BUY', type: 'MARKET', allocation: 50 },
        ],
      }),
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
    // for the fee, so that one whose budget is the minimum is refused. Each order is sent all the same. The simulator checks a market
    // order at the close, the price the Trader values it at.
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        // 2 % of 500 USDT, of which 95 % at 10000: 9.5 / 10000
        '[order 1] BUY MARKET order of 10 USDT (2 % of 500 USDT): 0.00095 BTC at 10000 sent, a cost of 9.5 USDT once 5 % is kept back for the fee, below the minimum cost of 10 USDT on BTC/USDT, which the market refuses at that price',
        // 2 % of 0.04 BTC, at 10000: 0.0008 × 10000
        '[order 2] SELL MARKET order of 0.0008 BTC (2 % of 0.04 BTC): 0.0008 BTC at 10000 sent, a cost of 8 USDT, below the minimum cost of 10 USDT on BTC/USDT, which the market refuses at that price',
      ],
      orderCalls: [
        refusedMarketOrder(minute(2), 'BTC/USDT', 'BUY', 0.00095, costBelow10(9.5)),
        refusedMarketOrder(minute(4), 'BTC/USDT', 'SELL', 0.0008, costBelow10(8)),
      ],
      // Nothing filled: each synchronization after a refusal reads the balances the account started with
      balanceReads: [unreservedRead(minute(2), { BTC: 0.04, USDT: 500 }), unreservedRead(minute(4), { BTC: 0.04, USDT: 500 })],
    });
  });

  it('warns of a BUY and a SELL whose amount falls below the minimum amount of the market, whatever their cost, which refuses both', async () => {
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({ balances: { BTC: 0.04, USDT: 500 }, amountMin: 0.001, calendar: { buyCandleIndex: 1, sellCandleIndex: 3, cost: 6 } }),
      { 'BTC/USDT': CANDLES['BTC/USDT'] },
    );

    // The exchange checks the amount before the cost: the BUY of 6 USDT buys 0.00057 BTC, the SELL of 6 USDT sells 0.0006 BTC, each
    // under the 0.001 BTC the market takes at least, which no minimum cost would have said
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        // 6 USDT, of which 95 % at 10000: 5.7 / 10000
        '[order 1] BUY MARKET order of 6 USDT: 0.00057 BTC at 10000 sent, below the minimum amount of 0.001 BTC of a MARKET order on BTC/USDT, which the market refuses',
        // 6 / 10000
        '[order 2] SELL MARKET order of 0.0006 BTC (6 USDT at 10000): 0.0006 BTC at 10000 sent, below the minimum amount of 0.001 BTC of a MARKET order on BTC/USDT, which the market refuses',
      ],
      orderCalls: [
        refusedMarketOrder(minute(2), 'BTC/USDT', 'BUY', 0.00057, outOfRange('amount', 0.00057, [0.001, 1000])),
        refusedMarketOrder(minute(4), 'BTC/USDT', 'SELL', 0.0006, outOfRange('amount', 0.0006, [0.001, 1000])),
      ],
      balanceReads: [unreservedRead(minute(2), { BTC: 0.04, USDT: 500 }), unreservedRead(minute(4), { BTC: 0.04, USDT: 500 })],
    });
  });

  it('warns of an all-in BUY as of a BUY allocated 100 % when the step takes the cost of their one amount below the minimum cost', async () => {
    // BTC at 60000 on Binance's amount step of 0.00001 BTC and a minimum cost of 5 USDT, the account holding 5.5 USDT
    const runWith = async (sizing: Pick<DebugBacktestParams, 'allIn' | 'allocation'>) => {
      clearLogs();
      const calendar = { buyCandleIndex: 1, sellCandleIndex: [], ...sizing };
      const backtest = backtestOf({ balances: { BTC: 0, USDT: 5.5 }, costMin: 5, amountDecimals: 5, calendar });
      const { failure, orderCalls, balanceReads } = await runBacktest(backtest, { 'BTC/USDT': flatCandles(60000) });
      return { failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) };
    };
    const allIn = await runWith({ allIn: true });
    const allocated = await runWith({ allocation: 100 });

    // Both buy 5.5 × 0.95 / 60000 = 0.0000870833333333333 BTC, 5.225 USDT, sent as 0.00008 BTC, 4.8 USDT: the market refuses both, and the
    // Trader warns of both before it sends them. Only the BUY allocated 100 % was warned of: the all-in BUY, the BUY of every signal
    // strategy on one pair, was refused without a word.
    const below = (sized: string) =>
      `[order 1] ${sized}: 0.0000870833333333333 BTC at 60000 sent, truncated to 0.00008 BTC on the amount step 0.00001 of the market, a cost of 4.8 USDT once 5 % is kept back for the fee, below the minimum cost of 5 USDT on BTC/USDT, which the market refuses at that price`;
    const refused = {
      failure: undefined,
      orderCalls: [refusedMarketOrder(minute(2), 'BTC/USDT', 'BUY', 0.0000870833333333333, outOfRange('cost', 4.8, [5, 1000000]))],
      // Nothing filled: the synchronization after the refusal reads the balances the account started with
      balanceReads: [unreservedRead(minute(2), { BTC: 0, USDT: 5.5 })],
    };
    expect({ allIn, allocated }).toEqual({
      allIn: { ...refused, warnings: [below('All-in BUY MARKET order sized from 5.5 USDT')] },
      allocated: { ...refused, warnings: [below('BUY MARKET order of 5.5 USDT (100 % of 5.5 USDT)')] },
    });
  });

  it('caps a SELL at what the SELLs placed before it on its candle leave, and sends one they leave nothing of as asked, which the market refuses', async () => {
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({
        balances: { BTC: 1, USDT: 0 },
        steps: range(3).map(() => ({ candle: 1, symbol: 'BTC/USDT', side: 'SELL', type: 'MARKET', amount: 0.8 })),
      }),
      { 'BTC/USDT': CANDLES['BTC/USDT'] },
    );

    // Three SELLs of 0.8 BTC on the candle of 00:01, from the 1 BTC the account holds: each is sized from the balance read at the end of
    // the warmup, less what the SELLs placed since take of it. Capped against the whole of the balance read, two SELLs of one asset on
    // one minute (two trailing stops, or a stop and the strategy) each fitted, while together they sold more than was held.
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        // 1 - 0.8 left
        '[order 2] SELL MARKET order of 0.8 BTC above the free balance: 0.2 BTC sent, all that can be sold (1 BTC free at the last synchronization, less 0.8 BTC for the SELLs placed since)',
        // Nothing left: sent as asked, the SELL goes through should one of those two fail first
        '[order 3] SELL MARKET order of 0.8 BTC: 0.8 BTC sent as asked, which the market refuses unless some of the asset is free by then (1 BTC free at the last synchronization, less 1 BTC for the SELLs placed since)',
      ],
      orderCalls: [
        filledMarketOrder(minute(2), 'BTC/USDT', 'SELL', 0.8, 1),
        filledMarketOrder(minute(2), 'BTC/USDT', 'SELL', 0.2, 2),
        refusedMarketOrder(
          minute(2),
          'BTC/USDT',
          'SELL',
          0.8,
          'InvalidOrder: [EXCHANGE] Insufficient asset balance (portfolio: 0, amount: 0.8)',
        ),
      ],
      // 1 BTC sold at 10000, of which 0.999 brought in
      balanceReads: [unreservedRead(minute(2), { BTC: 0, USDT: 9990 })],
    });
  });

  it('takes from the currency what a BUY of an amount may spend, the 5 % kept back for its fee included, for the all-in BUY after it', async () => {
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({
        balances: { BTC: 0, ETH: 0, USDT: 300000 },
        steps: [
          { candle: 1, symbol: 'BTC/USDT', side: 'BUY', type: 'MARKET', amount: 10 },
          { candle: 1, symbol: 'ETH/USDT', side: 'BUY', type: 'MARKET' },
        ],
      }),
      CANDLES,
    );

    // The BUY of 10 BTC at 10000 may spend 100000 USDT and the 5 % kept back for its fee, 100000 / 0.95: the all-in BUY of ETH on the same
    // candle is sized from what that leaves of the 300000 USDT read at the end of the warmup
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        // 300000 - 105263.15789473684, of 17 digits, which addPrecise subtracts as doubles do: 194736.84210526315, of which 95 % at 2000
        '[order 2] All-in BUY MARKET order sized from 194736.84210526315 USDT: 92.5 ETH sent (300000 USDT free at the last synchronization, less 105263.15789473684 USDT for the BUYs placed since, the 5 % kept back for their fee included)',
      ],
      orderCalls: [filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 10, 1), filledMarketOrder(minute(2), 'ETH/USDT', 'BUY', 92.5, 2)],
      // 10 × 10000 × 1.001 = 100100 and 92.5 × 2000 × 1.001 = 185185 spent: 300000 - 285285
      balanceReads: [unreservedRead(minute(2), { BTC: 10, ETH: 92.5, USDT: 14715 })],
    });
  });

  it('caps a BUY by cost at the currency left and at the most the market takes, in the one line of the maximum, and never a BUY of an amount', async () => {
    // ETH's market takes 20 ETH at most in one order
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({
        balances: { BTC: 0, ETH: 0, USDT: 300000 },
        amountMax: { ETH: 20 },
        steps: [
          { candle: 1, symbol: 'BTC/USDT', side: 'BUY', type: 'MARKET', cost: 200000 },
          { candle: 1, symbol: 'ETH/USDT', side: 'BUY', type: 'MARKET', cost: 200000 },
          { candle: 3, symbol: 'ETH/USDT', side: 'BUY', type: 'MARKET', amount: 30 },
        ],
      }),
      CANDLES,
    );

    // The ETH BUY of 00:01 asks for 200000 USDT, of which the BTC BUY leaves 100000: sized from those, it buys 47.5 ETH, more than the
    // market takes, and is capped at the 20 ETH it does. The BUY of 30 ETH of 00:03, which the strategy sized itself, is sent as asked,
    // for the market to refuse, though the currency would cover it.
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        // 100000 × 0.95 / 2000. Capped twice, it gets one line, the maximum's, which keeps what it was sized from and leaves out the BUYs
        // placed since
        '[order 2] BUY MARKET order of 200000 USDT above the free balance, sized from 100000 USDT: 47.5 ETH, above the maximum amount of a MARKET order on ETH/USDT: 20 ETH sent, the rest of the USDT left unspent',
      ],
      orderCalls: [
        // 200000 × 0.95 / 10000
        filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 19, 1),
        filledMarketOrder(minute(2), 'ETH/USDT', 'BUY', 20, 2),
        // A minimum amount of 0 bounds nothing
        refusedMarketOrder(
          minute(4),
          'ETH/USDT',
          'BUY',
          30,
          "OrderOutOfRangeError: [EXCHANGE] Order 'amount' with value 30 is too high. Maximum allowed is 20.",
        ),
      ],
      balanceReads: [
        // 19 × 10000 × 1.001 = 190190 and 20 × 2000 × 1.001 = 40040 spent: 300000 - 230230
        unreservedRead(minute(2), { BTC: 19, ETH: 20, USDT: 69770 }),
        // Nothing filled: the 30 ETH would have cost 60060
        unreservedRead(minute(4), { BTC: 19, ETH: 20, USDT: 69770 }),
      ],
    });
  });

  it('warns of a BUY all-in, by cost and by allocation when the account holds none of the currency, each sized to 0 and refused', async () => {
    const buy = { symbol: 'BTC/USDT', side: 'BUY', type: 'MARKET' } as const;
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({
        balances: { BTC: 1, USDT: 0 },
        steps: [
          { candle: 1, ...buy },
          { candle: 2, ...buy, cost: 100 },
          { candle: 3, ...buy, allocation: 50 },
        ],
      }),
      { 'BTC/USDT': CANDLES['BTC/USDT'] },
    );

    // An account holding BTC and no USDT: each BUY has nothing to be sized from, which its refusal for an amount of 0 does not say
    const nothing = '0 BTC sent, which the market refuses (0 USDT free at the last synchronization)';
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [
        `[order 1] All-in BUY MARKET order sized from 0 USDT: ${nothing}`,
        `[order 2] BUY MARKET order of 100 USDT: ${nothing}`,
        `[order 3] BUY MARKET order of 0 USDT (50 % of 0 USDT): ${nothing}`,
      ],
      orderCalls: [2, 3, 4].map(n => refusedMarketOrder(minute(n), 'BTC/USDT', 'BUY', 0, AMOUNT_OF_0)),
      balanceReads: [2, 3, 4].map(n => unreservedRead(minute(n), { BTC: 1, USDT: 0 })),
    });
  });

  it('warns of no order by cost whose amount the step cuts to nothing, which the market refuses naming the step', async () => {
    // BTC at 60000 on the amount step of 0.00001 BTC, at 5 USDT at least: a BUY and a SELL of 0.5 USDT
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({
        balances: { BTC: 0.001, USDT: 100 },
        costMin: 5,
        amountDecimals: 5,
        calendar: { buyCandleIndex: 1, sellCandleIndex: 3, cost: 0.5 },
      }),
      { 'BTC/USDT': flatCandles(60000) },
    );

    // The BUY buys 0.5 × 0.95 / 60000 BTC and the SELL sells 0.5 / 60000 BTC, each less than a step: the Trader warns of neither, though
    // both cost less than the minimum of 5 USDT. Truncated to 0 BTC, each is refused for its amount, the refusal naming the amount asked
    // for and the step, where a warning of the minimum cost would have quoted the cost of nothing.
    const roundsTo0 = (amount: string) =>
      `OrderOutOfRangeError: [EXCHANGE] Order 'amount' with value ${amount} rounds to 0 on the amount step 0.00001 of the market. Maximum allowed is 1000.`;
    expect({ failure, warnings: traderWarnings(), orderCalls, balanceReads: balanceReads.slice(3) }).toEqual({
      failure: undefined,
      warnings: [],
      orderCalls: [
        refusedMarketOrder(minute(2), 'BTC/USDT', 'BUY', 0.00000791666666666667, roundsTo0('0.00000791666666666667')),
        refusedMarketOrder(minute(4), 'BTC/USDT', 'SELL', 0.00000833333333333333, roundsTo0('0.00000833333333333333')),
      ],
      // Nothing filled: each synchronization after a refusal reads the balances the account started with
      balanceReads: [unreservedRead(minute(2), { BTC: 0.001, USDT: 100 }), unreservedRead(minute(4), { BTC: 0.001, USDT: 100 })],
    });
  });
});
