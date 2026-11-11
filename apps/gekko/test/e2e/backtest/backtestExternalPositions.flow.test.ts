import type { Candle } from '@gekko/shared/models/candle.types';
import type { LogLevel } from '@gekko/shared/models/logLevel.types';
import type { TradingPair } from '@gekko/shared/models/utility.types';
import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { clearLogs, numberedTextLines } from '../mocks/winston.mock';
import {
  candleOf,
  filledMarketOrder,
  flatCandles,
  minute,
  mockBacktestModules,
  rawMarket,
  runBacktest,
  unreservedRead,
} from './backtestRun.helper';
import type { PositionStepsParams } from './positionSteps.strategy';

mockBacktestModules();
// The book logs the skips of a pair after the first at debug level, and the Trader how it sized an order by its allocation: the logger
// hands a debug line to winston only when GEKKO_LOG_LEVEL lets it through, and the logger is loaded after this, by the pipeline
process.env.GEKKO_LOG_LEVEL = 'debug';

/** The strategy file of the flow, loaded as a strategy file of the user's is */
const POSITION_STEPS_PATH = fileURLToPath(new URL('./positionSteps.strategy.ts', import.meta.url));

/**
 * What a scenario runs: the block of PositionSteps (the pairs it tracks, the period of its SMA, its steps), the USDT it starts from,
 * 300000 unless given, without any asset, and the least an order costs on both markets, nothing unless given
 */
type Scenario = PositionStepsParams & { usdt?: number; costMin?: number };

/**
 * A backtest of BTC and ETH against USDT, of the minutes 00:00 to 00:08 on 1m candles, without a warmup: the candle of 00:00 is the
 * first the strategy trades on, and no periodic synchronization, every 10 minutes, falls in the range. Each market takes amounts to the
 * millionth from 0 on, at Binance's fee of 0.1 % (see rawMarket).
 */
const backtestOf = ({ usdt = 300000, costMin, ...block }: Scenario): RawConfiguration => ({
  watch: {
    mode: 'backtest',
    assets: ['BTC', 'ETH'],
    currency: 'USDT',
    timeframe: '1m',
    daterange: rawDaterange({ start: minute(0), end: minute(9) - 1 }),
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [
      { assetName: 'BTC', balance: 0 },
      { assetName: 'ETH', balance: 0 },
      { assetName: 'USDT', balance: usdt },
    ],
    marketData: [rawMarket('BTC/USDT', { costMin }), rawMarket('ETH/USDT', { costMin })],
  },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [{ name: 'TradingAdvisor', strategyName: 'PositionSteps', strategyPath: POSITION_STEPS_PATH }, { name: 'Trader' }],
  strategy: { name: 'PositionSteps', ...block },
});

/** BTC at 10000 and ETH at 2000 on every minute, each high and low 1 ‰ off it (see flatCandles): a MARKET order fills at the price */
const CANDLES: Record<TradingPair, Candle[]> = { 'BTC/USDT': flatCandles(10000), 'ETH/USDT': flatCandles(2000) };

/** The candles of 00:00 to 00:08 at these prices, by minute, each opening, closing and trading at its price alone */
const candlesAt = (prices: number[]): Candle[] => prices.map((price, n) => candleOf(n, price, price, price, price));

/** The messages logged as text under `tag` at `level`, oldest first, each order named by its rank among the orders of the run */
const messagesOf = (tag: string, level: LogLevel) =>
  numberedTextLines()
    .filter(line => line._tag === tag && line.level === level)
    .map(({ message }) => message);

/**
 * What a run of `scenario` stopped with, undefined when it reached its end; every line of the strategy, the book's, the StrategyManager's
 * and PositionSteps' among them, with its level, oldest first; the warnings of the Trader; how it sized each order by its allocation (the
 * share, the balance it is a share of, the amount: nothing for an all-in one); the order calls the simulated exchange was sent; and the
 * balances it was read, after the TradingAdvisor's and the Trader's reads at start-up and that of the end of the warmup
 */
const runOf = async (scenario: Scenario, candles = CANDLES) => {
  const { failure, orderCalls, balanceReads } = await runBacktest(backtestOf(scenario), candles);
  return {
    failure: failure && { name: failure.name, message: failure.message },
    strategyLines: numberedTextLines()
      .filter(({ _tag }) => _tag === 'STRATEGY')
      .map(({ level, message }) => `${level} | ${message}`),
    traderWarnings: messagesOf('TRADER', 'warn'),
    allocationSizings: messagesOf('TRADER', 'debug').filter(message => message.includes(' sized to ')),
    orderCalls,
    balanceReads: balanceReads.slice(3),
  };
};

/** What the book says at start-up of the pairs it trades, `listed` as the line lists them, when it tracks several */
const tradingLine = (listed: string) =>
  `info | Trading ${listed}: each BUY takes an equal share of the free currency among the pairs not invested, each SELL sells all of its asset`;

const WARMUP_DONE = 'info | Strategy warmup done ! Sending first candle bucket (2024-01-01T00:00:00.000Z) to strategy';

describe('E2E: Backtest of a strategy file trading through tools.positions', () => {
  beforeEach(() => {
    clearLogs();
  });

  it('Scenario A: two pairs flat, both bought on one candle at 50 % each, a BUY step while long skipped, each sold on its own candle', async () => {
    const run = await runOf({
      sma: 2,
      steps: [
        { candle: 1, side: 'BUY', type: 'MARKET' },
        { candle: 2, side: 'BUY', symbols: ['BTC/USDT'], type: 'MARKET' },
        { candle: 3, side: 'SELL', symbols: ['BTC/USDT'], type: 'MARKET' },
        { candle: 4, side: 'SELL', symbols: ['ETH/USDT'], type: 'MARKET' },
      ],
    });

    // init has the book track every watched pair, BTC then ETH, and adds an SMA of 2 closes on each: tools.indicatorsBySymbol gives each
    // pair its own, at its price once two candles are in. Each BUY of 00:01 takes 100 / n % of the currency, n the pairs not long, the
    // pair buying among them: the ETH BUY counts BTC, whose BUY is pending, so that both are sized from the 300000 USDT read in full.
    // The book settles each order before the hook of its end, which reads the position after it: no hook relays anything to it.
    expect(run).toEqual({
      failure: undefined,
      strategyLines: [
        tradingLine('BTC/USDT and ETH/USDT'),
        WARMUP_DONE,
        'info | [BTC/USDT] BUY step of candle 1: order 1 placed (SMA 10000)',
        'info | [ETH/USDT] BUY step of candle 1: order 2 placed (SMA 2000)',
        // Heard with the bucket they fill in, one after the other
        'info | [BTC/USDT] BUY order 1 completed: isLong true, isPendingOrder false',
        'info | [ETH/USDT] BUY order 2 completed: isLong true, isPendingOrder false',
        'info | [BTC/USDT] BUY step of candle 2 skipped: the strategy is long',
        'info | [BTC/USDT] SELL step of candle 3: order 3 placed (SMA 10000)',
        // All of the BTC free sold: the portfolio after the SELL shows none, too little to sell
        'info | [BTC/USDT] SELL order 3 completed: isLong false, isPendingOrder false',
        'info | [ETH/USDT] SELL step of candle 4: order 4 placed (SMA 2000)',
        'info | [ETH/USDT] SELL order 4 completed: isLong false, isPendingOrder false',
      ],
      // Neither BUY of 00:01 asks for more than the other leaves: 150000 each, of 300000
      traderWarnings: [],
      allocationSizings: [
        // 50 % of 300000 USDT, less the 5 % kept back for the fee, at 10000: 142500 / 10000
        '[order 1] BUY MARKET order of 150000 USDT (50 % of 300000 USDT) sized to 14.25 BTC at 10000',
        // 142500 / 2000
        '[order 2] BUY MARKET order of 150000 USDT (50 % of 300000 USDT) sized to 71.25 ETH at 2000',
      ],
      // Each order goes out with its candle, filled at its close and dated at its end
      orderCalls: [
        filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 14.25, 1),
        filledMarketOrder(minute(2), 'ETH/USDT', 'BUY', 71.25, 2),
        // All of each asset, without an amount, a cost or an allocation: the Trader sells what it read free
        filledMarketOrder(minute(4), 'BTC/USDT', 'SELL', 14.25, 3),
        filledMarketOrder(minute(5), 'ETH/USDT', 'SELL', 71.25, 4),
      ],
      // One synchronization after the fills of each candle. Each BUY costs its amount at the price and its fee of 0.1 % on top, each
      // SELL brings in the amount at the price less its fee.
      balanceReads: [
        // 14.25 × 10000 × 1.001 = 142642.5 and 71.25 × 2000 × 1.001 = 142642.5 spent: 300000 - 285285
        unreservedRead(minute(2), { BTC: 14.25, ETH: 71.25, USDT: 14715 }),
        // 14.25 × 10000 × 0.999 = 142357.5 brought in: 14715 + 142357.5
        unreservedRead(minute(4), { BTC: 0, ETH: 71.25, USDT: 157072.5 }),
        // 71.25 × 2000 × 0.999 = 142357.5 brought in: 157072.5 + 142357.5
        unreservedRead(minute(5), { BTC: 0, ETH: 0, USDT: 299430 }),
      ],
    });
  });

  it('Scenario B: the last pair not invested buys all-in, without an allocation, from what the share of the first left', async () => {
    const run = await runOf({
      steps: [
        { candle: 1, side: 'BUY', symbols: ['BTC/USDT'], type: 'MARKET' },
        { candle: 2, side: 'BUY', symbols: ['ETH/USDT'], type: 'MARKET' },
        { candle: 3, side: 'SELL', type: 'MARKET' },
      ],
    });

    // The BTC BUY of 00:01 takes 50 % of the currency, ETH flat beside it. Once BTC is long, ETH is the one pair not invested: its BUY
    // of 00:02 goes all-in, the Trader sizing it from the currency it read after the BTC fill. The SELLs of 00:03 sell all of each asset.
    expect(run).toEqual({
      failure: undefined,
      strategyLines: [
        tradingLine('BTC/USDT and ETH/USDT'),
        WARMUP_DONE,
        'info | [BTC/USDT] BUY step of candle 1: order 1 placed',
        'info | [BTC/USDT] BUY order 1 completed: isLong true, isPendingOrder false',
        'info | [ETH/USDT] BUY step of candle 2: order 2 placed',
        'info | [ETH/USDT] BUY order 2 completed: isLong true, isPendingOrder false',
        'info | [BTC/USDT] SELL step of candle 3: order 3 placed',
        'info | [ETH/USDT] SELL step of candle 3: order 4 placed',
        'info | [BTC/USDT] SELL order 3 completed: isLong false, isPendingOrder false',
        'info | [ETH/USDT] SELL order 4 completed: isLong false, isPendingOrder false',
      ],
      traderWarnings: [],
      // Only the BTC BUY carries an allocation: 50 % of 300000 USDT, of which 95 % at 10000, 142500 / 10000
      allocationSizings: ['[order 1] BUY MARKET order of 150000 USDT (50 % of 300000 USDT) sized to 14.25 BTC at 10000'],
      orderCalls: [
        filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 14.25, 1),
        // The 157357.5 USDT read after the BTC fill, of which 95 % at 2000: 149489.625 / 2000
        filledMarketOrder(minute(3), 'ETH/USDT', 'BUY', 74.7448125, 2),
        filledMarketOrder(minute(4), 'BTC/USDT', 'SELL', 14.25, 3),
        // All the ETH free: the BUY filled 74.744812, its amount truncated to the step of the market, a millionth
        filledMarketOrder(minute(4), 'ETH/USDT', 'SELL', 74.744812, 4),
      ],
      balanceReads: [
        // 142500 × 1.001 = 142642.5 spent: 300000 - 142642.5
        unreservedRead(minute(2), { BTC: 14.25, ETH: 0, USDT: 157357.5 }),
        // 74.744812 × 2000 × 1.001 = 149639.113624 spent: 157357.5 - 149639.113624
        unreservedRead(minute(3), { BTC: 14.25, ETH: 74.744812, USDT: 7718.386376 }),
        // 14.25 × 10000 × 0.999 = 142357.5 and 149489.624 × 0.999 = 149340.134376 brought in: 7718.386376 + 291697.634376
        unreservedRead(minute(4), { BTC: 0, ETH: 0, USDT: 299416.020752 }),
      ],
    });
  });

  it("Scenario C: a BUY's trailing stop triggers, the book adopts its SELL before the hook, and the pair, flat once it fills, buys again", async () => {
    const run = await runOf(
      {
        steps: [
          { candle: 0, side: 'BUY', symbols: ['BTC/USDT'], type: 'MARKET', trailing: { percentage: 10 } },
          { candle: 2, side: 'SELL', symbols: ['BTC/USDT'], type: 'MARKET' },
          { candle: 3, side: 'BUY', symbols: ['BTC/USDT'], type: 'MARKET' },
        ],
      },
      // BTC at 10000 on 00:00 and 00:01, then at 8000
      { 'BTC/USDT': candlesAt([10000, 10000, 8000, 8000, 8000, 8000, 8000, 8000, 8000]), 'ETH/USDT': flatCandles(2000) },
    );

    // The BUY of 00:00, 50 % of the currency with ETH flat beside it, asks for a stop 10 % under the highest price it meets, active at
    // once: armed as the BUY completes, for the 14.25 BTC it filled, it trails from 00:01, its peak 10000, its stop price 9000. The open
    // of 00:02, 8000, reaches it: the StrategyManager sends its MARKET SELL of 14.25 and the book adopts it before onTrailingStopTriggered
    // runs, which reads it pending, as the SELL step of that candle does. Filled at the close of 00:02, the SELL leaves no BTC free: the
    // book reads BTC flat before the hook of its end, and canBuy lets the BUY step of 00:03 through. No hook relays anything to the book.
    expect(run).toEqual({
      failure: undefined,
      strategyLines: [
        tradingLine('BTC/USDT and ETH/USDT'),
        WARMUP_DONE,
        'info | [BTC/USDT] BUY step of candle 0: order 1 placed',
        'info | [BTC/USDT] BUY order 1 completed: isLong true, isPendingOrder false',
        // Right after the hook of its BUY's end, a stop without a trigger being active as soon as it is armed
        'info | [BTC/USDT] Trailing stop of BUY order 1 activated: isLong true, isPendingOrder false',
        // As 00:02 arrives, before the candle hooks: 10000 less 10 %
        'info | [BTC/USDT] Trailing stop of BUY order 1 triggered at its stop price of 9000, its SELL order 2 sent: isLong true, isPendingOrder true',
        'info | [BTC/USDT] SELL step of candle 2 skipped: an order is pending',
        'info | [BTC/USDT] SELL order 2 completed: isLong false, isPendingOrder false',
        'info | [BTC/USDT] BUY step of candle 3: order 3 placed',
        'info | [BTC/USDT] BUY order 3 completed: isLong true, isPendingOrder false',
      ],
      // The SELL of the stop, of the 14.25 BTC its BUY filled, all of the BTC free
      traderWarnings: [],
      allocationSizings: [
        // 50 % of 300000 USDT, of which 95 % at 10000: 142500 / 10000
        '[order 1] BUY MARKET order of 150000 USDT (50 % of 300000 USDT) sized to 14.25 BTC at 10000',
        // ETH flat still: 50 % of the 271243.5 USDT read after the SELL of the stop, 135621.75, of which 95 % at 8000: 128840.6625 / 8000
        '[order 3] BUY MARKET order of 135621.75 USDT (50 % of 271243.5 USDT) sized to 16.1050828125 BTC at 8000',
      ],
      orderCalls: [
        filledMarketOrder(minute(1), 'BTC/USDT', 'BUY', 14.25, 1),
        // Sent with the bucket of 00:02, filled at its close
        filledMarketOrder(minute(3), 'BTC/USDT', 'SELL', 14.25, 2),
        filledMarketOrder(minute(4), 'BTC/USDT', 'BUY', 16.1050828125, 3),
      ],
      balanceReads: [
        // 14.25 × 10000 × 1.001 = 142642.5 spent: 300000 - 142642.5
        unreservedRead(minute(1), { BTC: 14.25, ETH: 0, USDT: 157357.5 }),
        // 14.25 × 8000 × 0.999 = 113886 brought in: 157357.5 + 113886
        unreservedRead(minute(3), { BTC: 0, ETH: 0, USDT: 271243.5 }),
        // The BUY filled 16.105082, its amount truncated to the step of the market, whose 16.105082 × 8000 × 1.001 = 128969.496656 are
        // spent: 271243.5 - 128969.496656
        unreservedRead(minute(4), { BTC: 16.105082, ETH: 0, USDT: 142274.003344 }),
      ],
    });
  });

  it('Scenario D: tracking one pair of the two watched, the pair tracked trades all-in as on one pair, the other is not tracked', async () => {
    const run = await runOf({
      track: ['ETH/USDT'],
      steps: [
        { candle: 1, side: 'BUY', symbols: ['BTC/USDT', 'ETH/USDT'], type: 'MARKET' },
        { candle: 3, side: 'SELL', type: 'MARKET' },
      ],
    });

    // The book tracks ETH alone: it says nothing of the pairs it trades, it shares the currency with no other pair, and canBuy is false
    // for BTC, watched but not tracked, which the strategy then leaves. The ETH BUY goes all-in, without an allocation, and a SELL step
    // naming no pair trades the pair tracked.
    expect(run).toEqual({
      failure: undefined,
      strategyLines: [
        WARMUP_DONE,
        'info | [BTC/USDT] BUY step of candle 1 skipped: the pair is not tracked',
        'info | [ETH/USDT] BUY step of candle 1: order 1 placed',
        'info | [ETH/USDT] BUY order 1 completed: isLong true, isPendingOrder false',
        'info | [ETH/USDT] SELL step of candle 3: order 2 placed',
        'info | [ETH/USDT] SELL order 2 completed: isLong false, isPendingOrder false',
      ],
      traderWarnings: [],
      allocationSizings: [],
      orderCalls: [
        // The 300000 USDT read, less the 5 % kept back for the fee, at 2000: 285000 / 2000
        filledMarketOrder(minute(2), 'ETH/USDT', 'BUY', 142.5, 1),
        filledMarketOrder(minute(4), 'ETH/USDT', 'SELL', 142.5, 2),
      ],
      balanceReads: [
        // 142.5 × 2000 × 1.001 = 285285 spent: 300000 - 285285
        unreservedRead(minute(2), { BTC: 0, ETH: 142.5, USDT: 14715 }),
        // 142.5 × 2000 × 0.999 = 284715 brought in: 14715 + 284715
        unreservedRead(minute(4), { BTC: 0, ETH: 0, USDT: 299430 }),
      ],
    });
  });

  it('Scenario E: skips a BUY whose share is below the minimum cost, sending nothing, said at warn level, then at debug level', async () => {
    const run = await runOf({
      usdt: 20,
      costMin: 10,
      // Both pairs, in an order of their own, which the book's line follows
      track: ['ETH/USDT', 'BTC/USDT'],
      steps: [
        { candle: 1, side: 'BUY', symbols: ['BTC/USDT'], type: 'MARKET' },
        { candle: 2, side: 'BUY', symbols: ['BTC/USDT'], type: 'MARKET' },
      ],
    });

    // Each BTC BUY takes 50 % of the 20 USDT free, ETH flat beside it: 10 USDT, less the 5 % kept back for the fee, 9.5 USDT, below the
    // minimum cost of 10. Sent, each would be refused by the market, an error counting towards the circuit breaker. tools.positions.buy
    // returns no id, and nothing is pending: the next BUY step is played on BTC again.
    const skipped =
      '[BTC/USDT] BUY skipped: 50 % of the 20 USDT free, 9.5 USDT once 5 % is kept back for the fee, is below the minimum cost of 10 USDT of the market: watch fewer pairs or fund the account';
    expect(run).toEqual({
      failure: undefined,
      strategyLines: [
        tradingLine('ETH/USDT and BTC/USDT'),
        WARMUP_DONE,
        `warn | ${skipped}; the next skips of this pair are logged at debug level until a BUY of it is placed`,
        'info | [BTC/USDT] BUY step of candle 1: nothing placed, the position book skipped the BUY',
        `debug | ${skipped}`,
        'info | [BTC/USDT] BUY step of candle 2: nothing placed, the position book skipped the BUY',
      ],
      traderWarnings: [],
      allocationSizings: [],
      // No order sent, none errored: nothing read after the end of the warmup
      orderCalls: [],
      balanceReads: [],
    });
  });

  it('Scenario F: stops the run on a BUY of a pair the book does not track, and at init on a pair track is given that is not watched', async () => {
    // A forced step asks neither canBuy nor canSell, as tools.positions.buy does not
    const untracked = await runOf({
      track: ['ETH/USDT'],
      steps: [{ candle: 0, side: 'BUY', symbols: ['BTC/USDT'], type: 'MARKET', force: true }],
    });
    clearLogs();
    const unwatched = await runOf({ track: ['XRP/USDT'], steps: [] });

    // The BUY is checked as createOrder checks it, BTC/USDT watched, then refused by the book, which tracks ETH alone: nothing is sent.
    // A pair that is not watched is refused by track, on the first minute, before the warmup is over.
    expect({ untracked, unwatched }).toEqual({
      untracked: {
        failure: {
          name: 'GekkoError',
          message:
            '[STRATEGY] Impossible to place the BUY MARKET order on BTC/USDT: the position book does not track it (it tracks ETH/USDT)',
        },
        strategyLines: [WARMUP_DONE],
        traderWarnings: [],
        allocationSizings: [],
        orderCalls: [],
        balanceReads: [],
      },
      unwatched: {
        failure: {
          name: 'GekkoError',
          message:
            "[STRATEGY] Impossible to track positions on XRP/USDT: symbol must be one of the watched pairs (BTC/USDT, ETH/USDT), got 'XRP/USDT'",
        },
        strategyLines: [
          'error | Strategy ended before its warmup was over, so it never traded: 0 timeframe candles processed, 1 needed (warmup.candleCount: 0, then one to trade on)',
        ],
        traderWarnings: [],
        allocationSizings: [],
        orderCalls: [],
        balanceReads: [],
      },
    });
  });

  it('imports no code of Gekko: the strategy file loads zod alone, Bun dropping its imports of types', () => {
    // The modules Bun loads with the file, once it has dropped its imports of types (Bun.Transpiler.scanImports): a value imported from
    // Gekko would be listed, which the compiled executable does not resolve in a file it loads at run time
    const loaded = new Bun.Transpiler({ loader: 'ts' }).scanImports(readFileSync(POSITION_STEPS_PATH, 'utf8')).map(({ path }) => path);

    expect(loaded).toEqual(['zod']);
  });
});
