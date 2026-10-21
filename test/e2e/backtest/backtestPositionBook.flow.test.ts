import type { Candle } from '@models/candle.types';
import type { LogLevel } from '@models/logLevel.types';
import type { TradingPair } from '@models/utility.types';
import type { DebugPositionBookParams } from '@strategies/debug/debugPositionBook.types';
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
  runBacktest,
  unreservedRead,
} from './backtestRun.helper';

mockBacktestModules();
// The book logs the skips of a pair after the first at debug level, and the Trader how it sized an order by its allocation: the logger
// hands a debug line to winston only when GEKKO_LOG_LEVEL lets it through, and the logger is loaded after this, by the pipeline
process.env.GEKKO_LOG_LEVEL = 'debug';

/** The price each asset trades at, on every minute */
const PRICES = { BTC: 10000, ETH: 2000, SOL: 25, XRP: 0.5 } as const;
type Asset = keyof typeof PRICES;

/**
 * What a scenario runs: the assets watched, in the order of watch.assets, the USDT it starts from, and the amount of each asset held
 * (none unless `held` gives it), the least an order costs on every market, and the steps of DebugPositionBook. Every market takes
 * amounts to the millionth from 0 on, unless `amountDecimals` and `amountMin` say otherwise.
 */
type Book = {
  assets: Asset[];
  usdt: number;
  held?: Partial<Record<Asset, number>>;
  costMin?: number;
  amountDecimals?: number;
  amountMin?: number;
  steps: DebugPositionBookParams['steps'];
};

/** A backtest of the minutes 00:00 to 00:08 on 1m candles, without a warmup: the candle of 00:00 is the first the strategy trades on */
const backtestOf = ({ assets, usdt, held = {}, costMin, amountDecimals = 6, amountMin = 0, steps }: Book): RawConfiguration => ({
  watch: {
    mode: 'backtest',
    assets,
    currency: 'USDT',
    timeframe: '1m',
    daterange: rawDaterange({ start: minute(0), end: minute(9) - 1 }),
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [...assets.map(assetName => ({ assetName, balance: held[assetName] ?? 0 })), { assetName: 'USDT', balance: usdt }],
    // One order takes 1000 units at most by default, and SOL and XRP are bought by the thousand
    marketData: assets.map(asset => {
      const { symbol, marketData } = rawMarket(`${asset}/USDT`, { amountMax: 1000000, costMin });
      const { amount, precision } = marketData;
      return {
        symbol,
        marketData: { ...marketData, amount: { ...amount, min: amountMin }, precision: { ...precision, amount: amountDecimals } },
      };
    }),
  },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [{ name: 'TradingAdvisor', strategyName: 'DebugPositionBook' }, { name: 'Trader' }],
  strategy: { name: 'DebugPositionBook', steps },
});

/** The candles of 00:00 to 00:08 at a price that does not move, each high and low 1 ‰ off it: a MARKET order fills at the price */
const flatCandles = (price: number): Candle[] =>
  range(9).map(n => ({ start: minute(n), open: price, high: price * 1.001, low: price * 0.999, close: price, volume: 10 }));

/** The candles of each of `assets` against USDT, at its price */
const candlesOf = (assets: Asset[]): Record<TradingPair, Candle[]> =>
  Object.fromEntries(assets.map(asset => [`${asset}/USDT`, flatCandles(PRICES[asset])]));

/** The messages logged as text under `tag` at `level`, oldest first, each order named by its rank among the orders of the run */
const messagesOf = (tag: string, level: LogLevel) =>
  numberedTextLines()
    .filter(line => line._tag === tag && line.level === level)
    .map(({ message }) => message);

/** How the Trader sized each order by its allocation: the share, the balance it is a share of, the amount. Nothing for an all-in one. */
const allocationSizings = () => messagesOf('TRADER', 'debug').filter(message => message.includes(' sized to '));

/** Every line of the strategy, the book's and DebugPositionBook's among them, with its level, oldest first */
const strategyLines = () =>
  numberedTextLines()
    .filter(({ _tag }) => _tag === 'STRATEGY')
    .map(({ level, message }) => `${level} | ${message}`);

/** What the book says at start-up of the pairs it trades, `listed` as the line lists them, when it trades several */
const tradingLine = (listed: string) =>
  `info | Trading ${listed}: each BUY takes an equal share of the free currency among the pairs not invested, each SELL sells all of its asset`;

const WARMUP_DONE = 'info | Strategy warmup done ! Sending first candle bucket (2024-01-01T00:00:00.000Z) to strategy';

describe('E2E: Backtest of a position book', () => {
  beforeEach(() => {
    clearLogs();
  });

  it('Scenario A: four pairs flat, two BUYs of 25 % on one candle, one of 50 % of what they leave, the last all-in, then four all-in SELLs', async () => {
    const assets: Asset[] = ['BTC', 'ETH', 'SOL', 'XRP'];
    const steps: DebugPositionBookParams['steps'] = [
      { candle: 1, side: 'BUY', symbols: ['BTC/USDT', 'ETH/USDT'] },
      { candle: 3, side: 'BUY', symbols: ['SOL/USDT'] },
      { candle: 5, side: 'BUY', symbols: ['XRP/USDT'] },
      { candle: 7, side: 'SELL' },
    ];
    const { failure, orderCalls, balanceReads } = await runBacktest(backtestOf({ assets, usdt: 400000, steps }), candlesOf(assets));

    // Each BUY takes 100 / n % of the currency, n the pairs not long, the pair buying among them: four on the candle of 00:01, the ETH BUY
    // counting BTC, whose BUY is pending, so that both are sized from the 400000 USDT read in full; two on that of 00:03, of the balance
    // read after their fills; one on that of 00:05, all-in. Each order goes out with its candle and is dated at its end.
    expect({
      failure,
      strategyLines: strategyLines(),
      traderWarnings: messagesOf('TRADER', 'warn'),
      allocationSizings: allocationSizings(),
      orderCalls,
      balanceReads: balanceReads.slice(3),
    }).toEqual({
      failure: undefined,
      strategyLines: [tradingLine('BTC/USDT, ETH/USDT, SOL/USDT and XRP/USDT'), WARMUP_DONE],
      // Neither BUY of 00:01 asks for more than the other leaves: 100000 each, of 400000
      traderWarnings: [],
      allocationSizings: [
        // 25 % of 400000 USDT, less the 5 % kept back for the fee, at 10000: 95000 / 10000
        '[order 1] BUY MARKET order of 100000 USDT (25 % of 400000 USDT) sized to 9.5 BTC at 10000',
        // 95000 / 2000
        '[order 2] BUY MARKET order of 100000 USDT (25 % of 400000 USDT) sized to 47.5 ETH at 2000',
        // 50 % of the 209810 USDT read after the fills of 00:01, 104905, of which 95 % at 25: 99659.75 / 25
        '[order 3] BUY MARKET order of 104905 USDT (50 % of 209810 USDT) sized to 3986.39 SOL at 25',
      ],
      orderCalls: [
        filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 9.5, 1),
        filledMarketOrder(minute(2), 'ETH/USDT', 'BUY', 47.5, 2),
        filledMarketOrder(minute(4), 'SOL/USDT', 'BUY', 3986.39, 3),
        // All-in, without an allocation: the 110050.59025 USDT read after the SOL fill, of which 95 % at 0.5: 104548.0607375 / 0.5
        filledMarketOrder(minute(6), 'XRP/USDT', 'BUY', 209096.121475, 4),
        // All of each asset
        filledMarketOrder(minute(8), 'BTC/USDT', 'SELL', 9.5, 5),
        filledMarketOrder(minute(8), 'ETH/USDT', 'SELL', 47.5, 6),
        filledMarketOrder(minute(8), 'SOL/USDT', 'SELL', 3986.39, 7),
        filledMarketOrder(minute(8), 'XRP/USDT', 'SELL', 209096.121475, 8),
      ],
      // After the TradingAdvisor's and the Trader's reads at start-up and that of the end of the warmup: one synchronization after the
      // fills of each candle. Each BUY costs its amount at the price and its fee of 0.1 % on top, each SELL brings in the amount at the
      // price less its fee, booked to 8 decimals.
      balanceReads: [
        // 9.5 × 10000 × 1.001 = 95095 and 47.5 × 2000 × 1.001 = 95095 spent: 400000 - 190190
        unreservedRead(minute(2), { BTC: 9.5, ETH: 47.5, SOL: 0, XRP: 0, USDT: 209810 }),
        // 3986.39 × 25 × 1.001 = 99759.40975 spent: 209810 - 99759.40975
        unreservedRead(minute(4), { BTC: 9.5, ETH: 47.5, SOL: 3986.39, XRP: 0, USDT: 110050.59025 }),
        // 209096.121475 × 0.5 × 1.001 = 104652.6087982375, booked 104652.60879824: 110050.59025 - 104652.60879824
        unreservedRead(minute(6), { BTC: 9.5, ETH: 47.5, SOL: 3986.39, XRP: 209096.121475, USDT: 5397.98145176 }),
        // 94905, 94905, 99659.75 × 0.999 = 99560.09025 and 104548.0607375 × 0.999 = 104443.5126767625, booked 104443.51267676, brought
        // in: 5397.98145176 + 393813.60292676
        unreservedRead(minute(8), { BTC: 0, ETH: 0, SOL: 0, XRP: 0, USDT: 399211.58437852 }),
      ],
    });
  });

  it('Scenario A: three pairs flat, three BUYs of 33.333333 % on one candle, the share rounded down, each sized in full', async () => {
    const assets: Asset[] = ['BTC', 'ETH', 'SOL'];
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({ assets, usdt: 300000, steps: [{ candle: 1, side: 'BUY' }] }),
      candlesOf(assets),
    );

    // 100 / 3 as a double, 33.333333333333336 %, of 300000 USDT is 100000.00000000001: sent three times, the third would ask for more
    // than the 99999.99999999997 the first two leave of the balance read, and the Trader would cap it, with a warning. Rounded down to 6
    // decimals, the three shares take 99999.999 each, 0.003 USDT less than the balance read between them.
    expect({
      failure,
      strategyLines: strategyLines(),
      traderWarnings: messagesOf('TRADER', 'warn'),
      allocationSizings: allocationSizings(),
      orderCalls,
      balanceReads: balanceReads.slice(3),
    }).toEqual({
      failure: undefined,
      strategyLines: [tradingLine('BTC/USDT, ETH/USDT and SOL/USDT'), WARMUP_DONE],
      // The third BUY asks for 99999.999 of the 100000.002 the first two leave
      traderWarnings: [],
      allocationSizings: [
        // 33.333333 % of 300000 USDT, of which 95 %, 94999.99905, at 10000
        '[order 1] BUY MARKET order of 99999.999 USDT (33.333333 % of 300000 USDT) sized to 9.499999905 BTC at 10000',
        // 94999.99905 / 2000
        '[order 2] BUY MARKET order of 99999.999 USDT (33.333333 % of 300000 USDT) sized to 47.499999525 ETH at 2000',
        // 94999.99905 / 25
        '[order 3] BUY MARKET order of 99999.999 USDT (33.333333 % of 300000 USDT) sized to 3799.999962 SOL at 25',
      ],
      orderCalls: [
        filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 9.499999905, 1),
        filledMarketOrder(minute(2), 'ETH/USDT', 'BUY', 47.499999525, 2),
        filledMarketOrder(minute(2), 'SOL/USDT', 'BUY', 3799.999962, 3),
      ],
      balanceReads: [
        // Each amount filled truncated to the step of the market, a millionth: 9.499999 × 10000 × 1.001 = 95094.98999,
        // 47.499999 × 2000 × 1.001 = 95094.997998 and 3799.999962 × 25 × 1.001 = 95094.99904905 spent: 300000 - 285284.98703705
        unreservedRead(minute(2), { BTC: 9.499999, ETH: 47.499999, SOL: 3799.999962, USDT: 14715.01296295 }),
      ],
    });
  });

  it('Scenario B: skips every BUY whose share is below the minimum cost, sending nothing, then buys each pair once the share passes', async () => {
    const assets: Asset[] = ['BTC', 'ETH'];
    const steps: DebugPositionBookParams['steps'] = [
      { candle: 1, side: 'BUY' },
      { candle: 2, side: 'BUY' },
      { candle: 3, side: 'BUY' },
    ];
    /** What a run on `usdt` sent, read and logged */
    const runOn = async (usdt: number) => {
      clearLogs();
      const { failure, orderCalls, balanceReads } = await runBacktest(backtestOf({ assets, usdt, costMin: 10, steps }), candlesOf(assets));
      const traderWarnings = messagesOf('TRADER', 'warn');
      return { failure, strategyLines: strategyLines(), traderWarnings, orderCalls, balanceReads: balanceReads.slice(3) };
    };
    const tooLittle = await runOn(20);
    const enough = await runOn(40);

    // Each BUY of a candle takes 50 % of the USDT free in the portfolio, the BTC BUY counting ETH, flat, and the ETH BUY counting BTC,
    // whose BUY was skipped. On 20 USDT, that is 10 USDT, less the 5 % kept back for the fee: 9.5 USDT, below the minimum cost of 10.
    // Sent, each BUY would be refused by the market for its cost, an error counting towards the circuit breaker, and the fifth, on the
    // candle of 00:03, would stop the run. On 40 USDT, the share costs 19 USDT.
    const skipped = (pair: TradingPair) =>
      `[${pair}] BUY skipped: 50 % of the 20 USDT free, 9.5 USDT once 5 % is kept back for the fee, is below the minimum cost of 10 USDT of the market: watch fewer pairs or fund the account`;
    const nextSkips = '; the next skips of this pair are logged at debug level until a BUY of it is placed';
    expect({ tooLittle, enough }).toEqual({
      tooLittle: {
        failure: undefined,
        strategyLines: [
          tradingLine('BTC/USDT and ETH/USDT'),
          WARMUP_DONE,
          // The first skip of each pair, at warn level, then its skips at debug level, the currency unchanged
          `warn | ${skipped('BTC/USDT')}${nextSkips}`,
          `warn | ${skipped('ETH/USDT')}${nextSkips}`,
          `debug | ${skipped('BTC/USDT')}`,
          `debug | ${skipped('ETH/USDT')}`,
          `debug | ${skipped('BTC/USDT')}`,
          `debug | ${skipped('ETH/USDT')}`,
        ],
        traderWarnings: [],
        // No order sent, none errored: nothing read after the start-up
        orderCalls: [],
        balanceReads: [],
      },
      enough: {
        failure: undefined,
        strategyLines: [
          tradingLine('BTC/USDT and ETH/USDT'),
          WARMUP_DONE,
          // Both long after the BUYs of 00:01
          'info | [BTC/USDT] BUY step of candle 2 skipped: the strategy is long',
          'info | [ETH/USDT] BUY step of candle 2 skipped: the strategy is long',
          'info | [BTC/USDT] BUY step of candle 3 skipped: the strategy is long',
          'info | [ETH/USDT] BUY step of candle 3 skipped: the strategy is long',
        ],
        // Each costs 19 USDT on the step of its market: above the minimum
        traderWarnings: [],
        orderCalls: [
          // 50 % of 40 USDT, of which 95 % at 10000: 19 / 10000
          filledMarketOrder(minute(2), 'BTC/USDT', 'BUY', 0.0019, 1),
          // 19 / 2000
          filledMarketOrder(minute(2), 'ETH/USDT', 'BUY', 0.0095, 2),
        ],
        // 19 × 1.001 = 19.019 spent on each pair: 40 - 38.038
        balanceReads: [unreservedRead(minute(2), { BTC: 0.0019, ETH: 0.0095, USDT: 1.962 })],
      },
    });
  });

  it('Scenario C: skips a SELL step while flat, a step while an order of the pair is pending, a BUY step while long', async () => {
    const assets: Asset[] = ['BTC', 'ETH'];
    const steps: DebugPositionBookParams['steps'] = [
      { candle: 0, side: 'SELL' },
      { candle: 1, side: 'BUY', symbols: ['BTC/USDT'] },
      { candle: 1, side: 'SELL', symbols: ['BTC/USDT'] },
      { candle: 2, side: 'BUY' },
      { candle: 3, side: 'SELL' },
    ];
    const { failure, orderCalls, balanceReads } = await runBacktest(backtestOf({ assets, usdt: 300000, steps }), candlesOf(assets));

    // Both pairs start flat: the SELLs of 00:00 are skipped. The BTC BUY of 00:01 pends until the candle is over: the SELL after it is
    // skipped. Long once it filled, BTC skips the BUY of 00:02, which ETH, the one pair not invested, sends all-in. Each SELL of 00:03
    // sells all of its asset.
    expect({
      failure,
      strategyLines: strategyLines(),
      traderWarnings: messagesOf('TRADER', 'warn'),
      allocationSizings: allocationSizings(),
      orderCalls,
      balanceReads: balanceReads.slice(3),
    }).toEqual({
      failure: undefined,
      strategyLines: [
        tradingLine('BTC/USDT and ETH/USDT'),
        WARMUP_DONE,
        'info | [BTC/USDT] SELL step of candle 0 skipped: the strategy is flat',
        'info | [ETH/USDT] SELL step of candle 0 skipped: the strategy is flat',
        'info | [BTC/USDT] SELL step of candle 1 skipped: an order is pending',
        'info | [BTC/USDT] BUY step of candle 2 skipped: the strategy is long',
      ],
      traderWarnings: [],
      // Only the BTC BUY carries an allocation, ETH flat beside it: 50 % of 300000 USDT, of which 95 % at 10000, 142500 / 10000
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

  it('Scenario D: skips every BUY whose amount, truncated to the step, is below a minimum of the market, sending nothing', async () => {
    const assets: Asset[] = ['BTC', 'ETH'];
    const steps: DebugPositionBookParams['steps'] = range(5).map(candle => ({ candle, side: 'BUY', symbols: ['BTC/USDT'] }));
    /** What a run sent, read and logged, BTC at `btcPrice` on markets taking amounts to 0.00001 from `amountMin` on, at 5 USDT at least */
    const runAt = async (btcPrice: number, amountMin?: number) => {
      clearLogs();
      const backtest = backtestOf({ assets, usdt: 12, costMin: 5, amountDecimals: 5, amountMin, steps });
      const candles = { 'BTC/USDT': flatCandles(btcPrice), 'ETH/USDT': flatCandles(PRICES.ETH) };
      const { failure, orderCalls, balanceReads } = await runBacktest(backtest, candles);
      return {
        failure,
        strategyLines: strategyLines(),
        traderWarnings: messagesOf('TRADER', 'warn'),
        orderCalls,
        balanceReads: balanceReads.slice(3),
      };
    };
    const belowMinimumCost = await runAt(97654.32);
    const belowMinimumAmount = await runAt(10000, 0.001);

    // Each BTC BUY takes 50 % of the 12 USDT free, ETH flat beside it: 6 USDT, 5.7 USDT once 5 % is kept back for the fee, above the
    // minimum cost of 5. At 97654.32 that buys 0.0000583691535612557 BTC, sent as 0.00005 BTC on the step of the market, 4.882716 USDT:
    // under the minimum cost. At 10000, 0.00057 BTC, under a minimum amount of 0.001 BTC. Sent, each BUY would be refused by the market,
    // an error counting towards the circuit breaker, and the fifth, on the candle of 00:04, would stop the run.
    const skipped = (sent: string) =>
      `[BTC/USDT] BUY skipped: 50 % of the 12 USDT free, 5.7 USDT once 5 % is kept back for the fee, ${sent}: watch fewer pairs or fund the account`;
    const nextSkips = '; the next skips of this pair are logged at debug level until a BUY of it is placed';
    /** The lines of a run whose five BUYs are skipped, `sent` saying why: the first at warn level, the next ones at debug level */
    const skippedFiveTimes = (sent: string) => [
      tradingLine('BTC/USDT and ETH/USDT'),
      WARMUP_DONE,
      `warn | ${skipped(sent)}${nextSkips}`,
      ...range(4).map(() => `debug | ${skipped(sent)}`),
    ];
    const truncated = 'once truncated to the amount step 0.00001 of the market';
    expect({ belowMinimumCost, belowMinimumAmount }).toEqual({
      belowMinimumCost: {
        failure: undefined,
        strategyLines: skippedFiveTimes(
          `0.00005 BTC at 97654.32 ${truncated}, a cost of 4.882716 USDT, is below the minimum cost of 5 USDT of the market`,
        ),
        traderWarnings: [],
        // No order sent, none errored: nothing read after the start-up
        orderCalls: [],
        balanceReads: [],
      },
      belowMinimumAmount: {
        failure: undefined,
        strategyLines: skippedFiveTimes(`0.00057 BTC at 10000 ${truncated}, is below the minimum amount of 0.001 BTC of the market`),
        traderWarnings: [],
        orderCalls: [],
        balanceReads: [],
      },
    });
  });

  it('Scenario E: restarted long on both pairs with too little USDT to buy, takes each holding for the position and sells it', async () => {
    const assets: Asset[] = ['BTC', 'ETH'];
    const steps: DebugPositionBookParams['steps'] = [
      { candle: 1, side: 'BUY' },
      { candle: 3, side: 'SELL' },
    ];
    const backtest = backtestOf({ assets, usdt: 4, held: { BTC: 0.002, ETH: 0.05 }, costMin: 5, steps });
    const { failure, orderCalls, balanceReads } = await runBacktest(backtest, candlesOf(assets));

    // The BTC BUY takes 50 % of the 4 USDT free, 1.9 USDT once 5 % is kept back for the fee, and the ETH BUY, BTC long by then, all of
    // it, 3.8 USDT: both below the minimum cost of 5, so neither is sent. Each pair holds enough to sell at the close, 0.002 BTC at 10000
    // being worth 20 USDT and 0.05 ETH at 2000 100 USDT: each holding is the position, which the SELLs of 00:03 sell. A holding present
    // at start-up was learnt only from a BUY sent and refused: skipped, the strategy stayed flat beside both, and skipped the SELL steps.
    const adopted = (pair: TradingPair, share: string, held: string) =>
      `info | [${pair}] BUY skipped: ${share}, is below the minimum cost of 5 USDT of the market, but ${held} is free in the portfolio, enough to sell: the strategy is long`;
    expect({
      failure,
      strategyLines: strategyLines(),
      traderWarnings: messagesOf('TRADER', 'warn'),
      orderCalls,
      balanceReads: balanceReads.slice(3),
    }).toEqual({
      failure: undefined,
      strategyLines: [
        tradingLine('BTC/USDT and ETH/USDT'),
        WARMUP_DONE,
        adopted('BTC/USDT', '50 % of the 4 USDT free, 1.9 USDT once 5 % is kept back for the fee', '0.002 BTC'),
        adopted('ETH/USDT', 'all of the 4 USDT free, 3.8 USDT once 5 % is kept back for the fee', '0.05 ETH'),
      ],
      traderWarnings: [],
      // All of each asset
      orderCalls: [filledMarketOrder(minute(4), 'BTC/USDT', 'SELL', 0.002, 1), filledMarketOrder(minute(4), 'ETH/USDT', 'SELL', 0.05, 2)],
      // 0.002 × 10000 × 0.999 = 19.98 and 0.05 × 2000 × 0.999 = 99.9 brought in: 4 + 119.88
      balanceReads: [unreservedRead(minute(4), { BTC: 0, ETH: 0, USDT: 123.88 })],
    });
  });
});
