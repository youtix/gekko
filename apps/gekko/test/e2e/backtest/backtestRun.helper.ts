import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { describeError } from '@gekko/shared/errors/error.helper';
import type { Candle } from '@gekko/shared/models/candle.types';
import type { OrderSide, OrderState } from '@gekko/shared/models/order.types';
import type { BalanceDetail } from '@gekko/shared/models/portfolio.types';
import type { Asset, TradingPair } from '@gekko/shared/models/utility.types';
import type { DummyCentralizedExchange } from '@gekko/core/exchange/dummy/dummyCentralizedExchange';
import type { MarketData } from '@gekko/shared/models/exchange.types';
import type { RunContext } from '@gekko/core/run/runContext.types';
import type { SQLiteStorage } from '@gekko/core/storage/sqlite.storage';
import { mock } from 'bun:test';
import { mapValues, range } from 'lodash-es';
import { createFlowContext, type RawConfiguration } from '../helpers/configuration.helper';
import { seedDatabaseWithCandles } from '../helpers/database.helper';
import { createCcxtModuleMock } from '../mocks/ccxt.mock';
import { MockWinston } from '../mocks/winston.mock';

/** The first minute the backtests of this directory can read, 2024-01-01 at midnight UTC */
const START = Date.parse('2024-01-01T00:00:00Z');

/** The start of the minute `n` minutes after START */
export const minute = (n: number) => START + n * ONE_MINUTE;

/** The candle of the minute `n` minutes after START, opening at `open`, its high and its low `spread` above and below its close */
export const candleAt = (
  n: number,
  { open, close, spread, volume }: { open: number; close: number; spread: number; volume: number },
): Candle => ({
  start: minute(n),
  open,
  high: close + spread,
  low: close - spread,
  close,
  volume,
});

/**
 * The candles of 00:00 to 00:08, opening every minute at `open` and closing there, but at the prices `closes` lists by minute, each high
 * and low `spread` off its close: those of BTC at 10000, 100 either side, unless the options give others
 */
export const candlesClosingAt = (
  closes: Record<number, number> = {},
  { open = 10000, spread = 100, volume = 10 }: { open?: number; spread?: number; volume?: number } = {},
): Candle[] => range(9).map(n => candleAt(n, { open, close: closes[n] ?? open, spread, volume }));

/** The candles of 00:00 to 00:08 at a price that does not move, each high and low 1 ‰ off it: a MARKET order fills at the price */
export const flatCandles = (price: number): Candle[] =>
  range(9).map(n => ({ start: minute(n), open: price, high: price * 1.001, low: price * 0.999, close: price, volume: 10 }));

/**
 * Mocks what the backtest flows mock, to be called at the top of the file, before anything imports the pipeline: winston, whose lines
 * the flows read; and ccxt, which the run's services load with CCXTExchange though a backtest builds no exchange client (the mock spares
 * the load of the real one, which backtestMissingCandles.flow.test.ts keeps). Not the configuration: runBacktest builds the context of
 * each run from the configuration it is given (createFlowContext).
 *
 * It also sets the log level of the flows, info. The logger reads GEKKO_LOG_LEVEL once, as the pipeline loads it, and hands winston a
 * debug line only when the level lets it through: inherited from the shell, a level of debug exported for a run of the bot added lines
 * that the flows did not expect, and three scenarios failed for it (a set-up import's line counted among those of the backtest it
 * prepared, a debug line of an order taken for one of its ends). A flow that reads debug lines sets debug after the call. Under
 * `bun test --isolate`, the environment of each file is its own.
 */
export const mockBacktestModules = () => {
  process.env.GEKKO_LOG_LEVEL = 'info';
  mock.module('winston', () => MockWinston);
  mock.module('ccxt', () => createCcxtModuleMock());
};

/** A balance read from the simulated exchange, dated by its clock: the close of the last candle it had processed */
export type BalanceRead = { at: EpochTimeStamp; balance: Record<Asset, BalanceDetail> };

/** What an order call asked of the simulated exchange: an order of the pair, or the cancelation of one of its transactions by id */
type OrderRequest =
  | { call: 'createMarketOrder'; symbol: TradingPair; side: OrderSide; amount: number }
  | { call: 'createLimitOrder'; symbol: TradingPair; side: OrderSide; amount: number; price: number }
  | { call: 'cancelOrder'; id: string };

/**
 * An order call the simulated exchange was sent, dated by its clock, with the transaction it answered, its id and its status (each
 * transaction of a STICKY order is a limit order of its own), or the error it refused the call with
 */
export type OrderCall = { at: EpochTimeStamp } & OrderRequest & ({ answer: Pick<OrderState, 'id' | 'status'> } | { refused: string });

/** A MARKET order the simulated exchange filled as it took it, the `n`-th it filled: what it answered, its transaction closed */
export const filledMarketOrder = (at: EpochTimeStamp, symbol: TradingPair, side: OrderSide, amount: number, n: number): OrderCall => ({
  at,
  call: 'createMarketOrder',
  symbol,
  side,
  amount,
  answer: { id: `market-order-${n}`, status: 'closed' },
});

/** A MARKET order the simulated exchange refused, with the error it threw */
export const refusedMarketOrder = (
  at: EpochTimeStamp,
  symbol: TradingPair,
  side: OrderSide,
  amount: number,
  refused: string,
): OrderCall => ({
  at,
  call: 'createMarketOrder',
  symbol,
  side,
  amount,
  refused,
});

/** A limit order the simulated exchange took, the `n`-th, open until a candle reaches its price */
export const openLimitOrder = (
  at: EpochTimeStamp,
  symbol: TradingPair,
  side: OrderSide,
  amount: number,
  price: number,
  n: number,
): OrderCall => ({
  at,
  call: 'createLimitOrder',
  symbol,
  side,
  amount,
  price,
  answer: { id: `limit-order-${n}`, status: 'open' },
});

/** The cancelation of the `n`-th limit order, which the simulated exchange answered canceled */
export const canceledLimitOrder = (at: EpochTimeStamp, n: number): OrderCall => ({
  at,
  call: 'cancelOrder',
  id: `limit-order-${n}`,
  answer: { id: `limit-order-${n}`, status: 'canceled' },
});

/** A balance read with nothing reserved, each asset all free: the amounts it holds, by asset */
export const unreservedRead = (at: EpochTimeStamp, amounts: Record<Asset, number>): BalanceRead => ({
  at,
  balance: mapValues(amounts, amount => ({ free: amount, used: 0, total: amount })),
});

/**
 * What a run left: the error it stopped with, undefined when it reached the end of its range, what the exchange was asked, and the
 * context it ran on, its configuration and its services (the storage it read, to close as main() does), undefined when the schema
 * refused its configuration
 */
export type BacktestRun = { failure?: Error; balanceReads: BalanceRead[]; orderCalls: OrderCall[]; context?: RunContext };

/** Records each balance read and each order call the pipeline makes of the simulated exchange, as it makes them */
const recordExchange = (exchange: DummyCentralizedExchange, run: BacktestRun) => {
  const clock = (): EpochTimeStamp => exchange['currentTimestamp'];
  const record = async (request: OrderRequest, sent: Promise<OrderState>) => {
    const at = clock();
    try {
      const { id, status } = await sent;
      run.orderCalls.push({ at, ...request, answer: { id, status } });
    } catch (error) {
      // Its class too: OrderOutOfRangeError for an order out of the limits of the market, InvalidOrder for one refused otherwise
      run.orderCalls.push({ at, ...request, refused: error instanceof Error ? `${error.name}: ${error.message}` : describeError(error) });
    }
    return sent;
  };

  const fetchBalance = exchange.fetchBalance.bind(exchange);
  exchange.fetchBalance = async () => {
    const balance = await fetchBalance();
    run.balanceReads.push({ at: clock(), balance: Object.fromEntries(balance) });
    return balance;
  };
  const createMarketOrder = exchange.createMarketOrder.bind(exchange);
  exchange.createMarketOrder = (symbol, side, amount) =>
    record({ call: 'createMarketOrder', symbol, side, amount }, createMarketOrder(symbol, side, amount));
  const createLimitOrder = exchange.createLimitOrder.bind(exchange);
  exchange.createLimitOrder = (symbol, side, amount, price, onSettled) =>
    record({ call: 'createLimitOrder', symbol, side, amount, price }, createLimitOrder(symbol, side, amount, price, onSettled));
  const cancelOrder = exchange.cancelOrder.bind(exchange);
  exchange.cancelOrder = (symbol, id) => record({ call: 'cancelOrder', id }, cancelOrder(symbol, id));
};

/**
 * Builds the context of the run from its configuration, then the storage and the exchange of its services, which the pipeline is given
 * in turn, the services keeping the ones they built first, then runs the pipeline on that context
 */
const startBacktest = async (backtest: RawConfiguration, candles: Record<TradingPair, Candle[]>, run: BacktestRun) => {
  const context = await createFlowContext(backtest);
  run.context = context;
  // An in-memory database is one of its own, built with the services of the run: it creates the tables of its pairs. A database file
  // is left to the pipeline, which opens it as a backtest does.
  const pairs = Object.entries(candles) as [TradingPair, Candle[]][];
  if (pairs.length) {
    const storage = context.services.storage() as SQLiteStorage;
    for (const [symbol, pairCandles] of pairs) seedDatabaseWithCandles(storage, symbol, pairCandles);
  }
  recordExchange(context.services.exchange() as DummyCentralizedExchange, run);
  const { gekkoPipeline } = await import('@gekko/core/core/pipeline/pipeline');
  const plugins = await import('@gekko/plugins/index');
  await gekkoPipeline({ context, plugins });
};

/**
 * Runs the backtest of `backtest` on a context of its own (createFlowContext), the 1-minute candles of each pair seeded in its in-memory
 * database first, to its end: the error it stopped with, undefined when it completed, every balance read and order call made of the
 * simulated exchange, and the context. Caught rather than asserted through `rejects`, which Bun waits on past the test's timeout: a
 * backtest that froze would hang the suite instead of failing its scenario. So is a configuration the schema refuses, whose GekkoError
 * createFlowContext throws before the run starts.
 */
export const runBacktest = async (backtest: RawConfiguration, candles: Record<TradingPair, Candle[]> = {}): Promise<BacktestRun> => {
  const run: BacktestRun = { balanceReads: [], orderCalls: [] };
  run.failure = await startBacktest(backtest, candles, run).then(
    () => undefined,
    (error: Error) => error,
  );
  return run;
};

type Fee = { maker: number; taker: number };

/**
 * The market of a pair as dummy-cex takes it: prices to the cent, amounts to the millionth, and Binance's regular fee of 0.1 %. No
 * minimum cost unless `costMin` sets one, which the simulated exchange refuses an order below, nor minimum amount unless `amountMin` sets
 * one; `amountDecimals` sets another amount step, which the simulated exchange truncates an amount to. No range of a market order either
 * unless `market` gives one, Binance's MARKET_LOT_SIZE, which narrows the amount range for a MARKET order (see getMarketOrderLimits).
 */
export const rawMarket = (
  symbol: TradingPair,
  {
    amountMax = 1000,
    amountMin = 0,
    amountDecimals = 6,
    priceMin = 0,
    costMin = 0,
    fee = { maker: 0.001, taker: 0.001 },
    market,
  }: {
    amountMax?: number;
    amountMin?: number;
    amountDecimals?: number;
    priceMin?: number;
    costMin?: number;
    fee?: Fee;
    market?: MarketData['market'];
  } = {},
) => ({
  symbol,
  marketData: {
    price: { min: priceMin, max: 1000000 },
    amount: { min: amountMin, max: amountMax },
    cost: { min: costMin, max: 1000000 },
    ...(market && { market }),
    precision: { price: 2, amount: amountDecimals },
    fee,
  },
});
