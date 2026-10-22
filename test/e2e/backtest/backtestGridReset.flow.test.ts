import type { Candle } from '@models/candle.types';
import type { gridBotStrategySchema } from '@strategies/gridBot/gridBot.schema';
import { beforeEach, describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import { rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { clearLogs, numberedTextLines } from '../mocks/winston.mock';
import {
  canceledLimitOrder,
  minute,
  mockBacktestModules,
  openLimitOrder,
  type OrderCall,
  rawMarket,
  runBacktest,
  unreservedRead,
} from './backtestRun.helper';

mockBacktestModules();
// GridBot counts a close towards a reset at debug level: the logger hands a debug line to winston only when GEKKO_LOG_LEVEL lets it
// through, and the logger is loaded after this, by the pipeline
process.env.GEKKO_LOG_LEVEL = 'debug';

/** GridBot's block as a configuration file writes it, without its name */
type GridBlock = z.input<typeof gridBotStrategySchema>;

type Fee = { maker: number; taker: number };

/** No fee: 5 BTC and 462.5 USDT fund each level of a grid 5 apart around 100 with 2.5, and the figures of a reset are exact */
const NO_FEE: Fee = { maker: 0, taker: 0 };

/** Binance's regular fee, 0.1 %: the least step of an atr grid is the one at which each of its levels breaks even on the maker fee */
const BINANCE_FEE: Fee = { maker: 0.001, taker: 0.001 };

/** Two buy and two sell levels 5 apart, the grid reset once two timeframe candles in a row close above it */
const FIXED_UP: GridBlock = {
  buyLevels: 2,
  sellLevels: 2,
  spacingType: 'fixed',
  spacingValue: 5,
  resetMode: 'up',
  resetConfirmCandles: 2,
};

/**
 * Two buy and two sell levels 2.5 ATRs apart, the ATR of a single candle being its true range, the grid reset by the first close above
 * it
 */
const ATR_UP: GridBlock = {
  buyLevels: 2,
  sellLevels: 2,
  spacingType: 'atr',
  spacingValue: 2.5,
  atrPeriod: 1,
  resetMode: 'up',
  resetConfirmCandles: 1,
};

/**
 * A backtest of GridBot on BTC, on 1m candles, of the minutes 00:00 to the one `lastMinute` minutes after 00:00, from 5 BTC and `usdt`
 * USDT: the grid starts on the first candle after a warmup of `candleCount`. Prices tick by 0.01, which a STICKY order is placed off the
 * close by (price.min), and amounts by a millionth.
 */
const backtestOf = ({
  lastMinute,
  candleCount = 0,
  usdt,
  fee,
  grid,
}: {
  lastMinute: number;
  candleCount?: number;
  usdt: number;
  fee: Fee;
  grid: GridBlock;
}): RawConfiguration => ({
  watch: {
    mode: 'backtest',
    assets: ['BTC'],
    currency: 'USDT',
    timeframe: '1m',
    warmup: { candleCount },
    daterange: rawDaterange({ start: minute(0), end: minute(lastMinute + 1) - 1 }),
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [
      { assetName: 'BTC', balance: 5 },
      { assetName: 'USDT', balance: usdt },
    ],
    marketData: [rawMarket('BTC/USDT', { priceMin: 0.01, fee })],
  },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [{ name: 'TradingAdvisor', strategyName: 'GridBot' }, { name: 'Trader' }],
  strategy: { name: 'GridBot', ...grid },
});

/** The candle of the minute `n` minutes after 00:00, of these prices */
const candleOf = (n: number, open: number, high: number, low: number, close: number): Candle => ({
  start: minute(n),
  open,
  high,
  low,
  close,
  volume: 10,
});

/** Every line of the strategy, GridBot's and the StrategyManager's, with its level, oldest first */
const strategyLines = () =>
  numberedTextLines()
    .filter(({ _tag }) => _tag === 'STRATEGY')
    .map(({ level, message }) => `${level} | ${message}`);

/**
 * The fixed grid of 00:00 around 100, [90, 110], 2.5 a level: the price rises through its SELLs, then closes above it on 00:04 and on
 * 00:05, which resets it, and stays at 112 while the reset rebalances and builds the new grid
 */
const BREAKOUT_UP = [
  candleOf(0, 100, 100.5, 99.5, 100),
  candleOf(1, 100, 100.5, 99.5, 100),
  // Its high fills the SELL at 105
  candleOf(2, 100, 105, 99.5, 104),
  // Its high fills the SELL at 110
  candleOf(3, 104, 110, 103.5, 109),
  candleOf(4, 109, 111.5, 108.5, 111),
  candleOf(5, 111, 112.5, 110.5, 112),
  candleOf(6, 112, 112.5, 111.5, 112),
  // Its low fills the rebalance, a STICKY BUY at 112.01
  candleOf(7, 112, 112.5, 111.5, 112),
  candleOf(8, 112, 112.5, 111.5, 112),
];

/** What GridBot says of BREAKOUT_UP, from its first grid to the one its reset builds, each figure worked out in its comment */
const FIRST_RESET_LINES = [
  'info | Strategy warmup done ! Sending first candle bucket (2024-01-01T00:00:00.000Z) to strategy',
  // The 5 BTC fund its two SELLs with 2.5 each, and the 462.5 USDT its BUYs at 90 and 95, 2.5 × (90 + 95): no rebalance
  'info | GridBot: Grid built around 100 with 2 buy / 2 sell levels, qty=2.5',
  // Heard in the flush of 00:03: both SELLs filled, every level holds a BUY
  'warn | GridBot: Only one side of the grid remains active',
  // 00:04 closes at 111, above 110: the first close counted, and warned of once
  'debug | GridBot: Price 111 closed above grid range [90, 110]: 1 of 2 consecutive timeframe candles towards a reset',
  'warn | GridBot: Price 111 is out of grid range [90, 110]: the grid is reset once 2 consecutive timeframe candles close above it (resetConfirmCandles), its orders waiting for the price to come back to 105 until then',
  // 00:05 closes at 112, the second in a row: the reset, in place of the warning
  'info | GridBot: Price 112 closed above grid range [90, 110] for 2 consecutive timeframe candles (resetConfirmCandles): reset 1, its 4 open orders are canceled and a new grid is built around the price once they have ended',
  // Once the last of the four is heard canceled, in the flush of 00:05, around the price its event carries, the close of 00:05: the
  // SELLs brought 2.5 × 105 + 2.5 × 110, so the portfolio holds 462.5 + 537.5 = 1000 USDT and no BTC. The grid around 112 takes q BTC
  // for each of its two SELLs and q × (107 + 102) = 209q USDT for its BUYs, and the STICKY BUY pays 112 + 0.01 a BTC:
  // 1000 = 209q + 2q × 112.01, q = 1000 / 433.02 = 2.3093621..., a BUY of 2q = 4.6187243..., 4.618724 on the amount step
  'info | GridBot: Rebalancing - BUY 4.618724 (STICKY order)',
  // Its fill on 00:07 heard in that flush: the grid around the close of 00:07, 112. 4.618724 BTC fund 2.309362 a SELL, and the
  // 1000 - 4.618724 × 112.01 = 482.65672476 USDT left 482.65672476 / 209 = 2.3093623... a BUY: 2.309362, the smaller
  'info | GridBot: Rebalance complete, building grid',
  'info | GridBot: Grid built around 112 with 2 buy / 2 sell levels, qty=2.309362',
];

/** The cancels of the reset of BREAKOUT_UP: its four BUYs, in the order of their levels, the lowest first, heard in the flush of 00:05 */
const FIRST_RESET_CANCELS = [
  canceledLimitOrder(minute(6), 1),
  canceledLimitOrder(minute(6), 2),
  canceledLimitOrder(minute(6), 5),
  canceledLimitOrder(minute(6), 6),
];

/**
 * The start of an atr grid: a warmup of two candles, then the grid of 00:02 around 100, spaced by 2.5 × 2 = 5, its ATR of period 1 being
 * the true range of 00:02, 101 - 99 (far above the least step at 100 on the maker fee of 0.1 %, 0.21): [90, 110], 2.5 a level, the price
 * rising through its SELLs
 */
const ATR_START = [
  // No true range: no previous close
  candleOf(0, 100, 101, 99, 100),
  candleOf(1, 100, 101, 99, 100),
  candleOf(2, 100, 101, 99, 100),
  // Its high fills the SELL at 105
  candleOf(3, 100, 105, 99.5, 104),
];

/** What GridBot says of ATR_START once its SELL at 110 has filled */
const ATR_START_LINES = [
  'info | Strategy warmup done ! Sending first candle bucket (2024-01-01T00:02:00.000Z) to strategy',
  // With the fee, 462.9625 USDT, 2.5 × (90 + 95) × 1.001, fund the BUYs with 2.5, as the 5 BTC fund the SELLs: no rebalance
  'info | GridBot: Grid built around 100 with 2 buy / 2 sell levels, qty=2.5',
  'warn | GridBot: Only one side of the grid remains active',
];

/**
 * The order calls of the atr grid of ATR_START until a reset on 00:06: its grid, sent with 00:02; the BUY at 100 its SELL at 105, filled
 * on 00:03, turns to, sent with 00:04; the BUY at 105 its SELL at 110, filled on 00:04, turns to, sent with 00:05; then the cancels of its
 * four BUYs, in the order of their levels, the lowest first, heard in the flush of 00:06
 */
const ATR_RESET_CALLS: OrderCall[] = [
  openLimitOrder(minute(3), 'BTC/USDT', 'BUY', 2.5, 90, 1),
  openLimitOrder(minute(3), 'BTC/USDT', 'BUY', 2.5, 95, 2),
  openLimitOrder(minute(3), 'BTC/USDT', 'SELL', 2.5, 105, 3),
  openLimitOrder(minute(3), 'BTC/USDT', 'SELL', 2.5, 110, 4),
  openLimitOrder(minute(5), 'BTC/USDT', 'BUY', 2.5, 100, 5),
  openLimitOrder(minute(6), 'BTC/USDT', 'BUY', 2.5, 105, 6),
  canceledLimitOrder(minute(7), 1),
  canceledLimitOrder(minute(7), 2),
  canceledLimitOrder(minute(7), 5),
  canceledLimitOrder(minute(7), 6),
];

// How a minute of a backtest runs (see PluginsStream), which dates every call below: the simulated exchange settles the candle of 00:mm
// first, its clock at the candle's close, 00:mm+1; then the strategy's candle hooks run, then the events are flushed, the TradingAdvisor's
// first, then the Trader's. The orders and the cancels a candle hook asks for reach the Trader in the TradingAdvisor's turn, which sends
// them: dated 00:mm+1, an order is first checked against the candle of 00:mm+1. The Trader awaits its reports in a backtest: the fills of
// the candle, and the cancels it has just sent, which the simulated exchange answers at once, reach the order hooks in its own turn of
// that flush. What an order hook places waits for the next flush, the TradingAdvisor's turn being over: the order a fill turns its level
// to, the rebalance a reset plans once its cancels are heard and the grid built once the rebalance has filled each go out with the next
// candle, dated 00:mm+2. A STICKY order rests one price.min off the close of the candle it goes out with, a limit order of its own.
describe('E2E: Backtest of the resets of a GridBot grid', () => {
  beforeEach(() => {
    clearLogs();
  });

  it('Scenario A: a fixed grid the price leaves upwards is reset after two closes above it: its BUYs canceled, the currency rebalanced, a new grid built around the price', async () => {
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({ lastMinute: 8, usdt: 462.5, fee: NO_FEE, grid: FIXED_UP }),
      { 'BTC/USDT': BREAKOUT_UP },
    );

    expect({ failure, strategyLines: strategyLines(), orderCalls, lastRead: balanceReads.at(-1) }).toEqual({
      failure: undefined,
      strategyLines: FIRST_RESET_LINES,
      orderCalls: [
        // The grid of 00:00, sent with it
        openLimitOrder(minute(1), 'BTC/USDT', 'BUY', 2.5, 90, 1),
        openLimitOrder(minute(1), 'BTC/USDT', 'BUY', 2.5, 95, 2),
        openLimitOrder(minute(1), 'BTC/USDT', 'SELL', 2.5, 105, 3),
        openLimitOrder(minute(1), 'BTC/USDT', 'SELL', 2.5, 110, 4),
        // The SELL at 105, filled on 00:02, turns its level to a BUY one step below, sent with 00:03
        openLimitOrder(minute(4), 'BTC/USDT', 'BUY', 2.5, 100, 5),
        // The SELL at 110, filled on 00:03: a BUY at 105, sent with 00:04
        openLimitOrder(minute(5), 'BTC/USDT', 'BUY', 2.5, 105, 6),
        ...FIRST_RESET_CANCELS,
        // The rebalance, sent with 00:06, at its close plus price.min
        openLimitOrder(minute(7), 'BTC/USDT', 'BUY', 4.618724, 112.01, 7),
        // The new grid, 5 apart around 112, sent with 00:08
        openLimitOrder(minute(9), 'BTC/USDT', 'BUY', 2.309362, 102, 8),
        openLimitOrder(minute(9), 'BTC/USDT', 'BUY', 2.309362, 107, 9),
        openLimitOrder(minute(9), 'BTC/USDT', 'SELL', 2.309362, 117, 10),
        openLimitOrder(minute(9), 'BTC/USDT', 'SELL', 2.309362, 122, 11),
      ],
      // The synchronization after the rebalance's fill, which the new grid is built on: 1000 - 4.618724 × 112.01 USDT, without a fee
      lastRead: unreservedRead(minute(8), { BTC: 4.618724, USDT: 482.65672476 }),
    });
  });

  it('Scenario B: the grid a reset built stays in place for its cooldown, its closes above it not counted, then two closes above it reset it again', async () => {
    const candles = [
      ...BREAKOUT_UP.slice(0, 8),
      // Every close from 00:08 on is above the new grid, [102, 122]: 00:08, 00:09 and 00:10 are its cooldown, counted down and not
      // towards a reset, 00:11 is the first counted, 00:12 the second
      candleOf(8, 112, 123.5, 111.5, 123),
      // Its high fills the SELLs at 117 and 122, sent with 00:08: their levels turn to BUYs at 112 and 117
      candleOf(9, 123, 124.5, 122.5, 124),
      candleOf(10, 124, 125.5, 123.5, 125),
      candleOf(11, 125, 126.5, 124.5, 126),
      candleOf(12, 126, 127.5, 125.5, 127),
    ];
    const { failure, orderCalls } = await runBacktest(
      backtestOf({ lastMinute: 12, usdt: 462.5, fee: NO_FEE, grid: { ...FIXED_UP, resetCooldownCandles: 3 } }),
      { 'BTC/USDT': candles },
    );

    expect({ failure, strategyLines: strategyLines(), cancels: orderCalls.filter(({ call }) => call === 'cancelOrder') }).toEqual({
      failure: undefined,
      strategyLines: [
        // The first build is not followed by a cooldown: scenario A's lines
        ...FIRST_RESET_LINES,
        // 00:08, the first candle of the new grid: 3 - 1 left of the cooldown
        'warn | GridBot: Price 123 is out of grid range [102, 122]: the grid stays in place for the 2 timeframe candles left of its cooldown (resetCooldownCandles 3), its orders waiting for the price to come back to 117',
        // Heard in the flush of 00:09: both SELLs filled, every level holds a BUY
        'warn | GridBot: Only one side of the grid remains active',
        // 00:09 and 00:10 end the cooldown in silence, the price out on the same side: 00:11 is the first close counted
        'debug | GridBot: Price 126 closed above grid range [102, 122]: 1 of 2 consecutive timeframe candles towards a reset',
        'info | GridBot: Price 127 closed above grid range [102, 122] for 2 consecutive timeframe candles (resetConfirmCandles): reset 2, its 4 open orders are canceled and a new grid is built around the price once they have ended',
        // The SELLs brought 2.309362 × (117 + 122) = 551.937518: 482.65672476 + 551.937518 = 1034.59424276 USDT, and no BTC. Around the
        // close of 00:12, 127, the BUYs at 122 and 117 take 239q, and the STICKY BUY pays 127 + 0.01 a BTC: 1034.59424276 = 239q +
        // 2q × 127.01, q = 1034.59424276 / 493.02 = 2.0984833..., a BUY of 2q = 4.1969666..., 4.196966
        'info | GridBot: Rebalancing - BUY 4.196966 (STICKY order)',
      ],
      cancels: [
        ...FIRST_RESET_CANCELS,
        // Asked on 00:12, sent and heard in its flush: the BUYs at 102 and 107 of the new grid, then those at 112 and 117 its filled
        // levels turned to, sent with 00:10
        canceledLimitOrder(minute(13), 8),
        canceledLimitOrder(minute(13), 9),
        canceledLimitOrder(minute(13), 12),
        canceledLimitOrder(minute(13), 13),
      ],
    });
  });

  it('Scenario C: a fixed grid the price leaves downwards is reset after two closes below it: its SELLs canceled, the asset rebalanced, a new grid built lower', async () => {
    const candles = [
      candleOf(0, 100, 100.5, 99.5, 100),
      candleOf(1, 100, 100.5, 99.5, 100),
      // Its low fills the BUY at 95
      candleOf(2, 100, 100.5, 95, 96),
      // Its low fills the BUY at 90
      candleOf(3, 96, 96.5, 90, 91),
      candleOf(4, 91, 91.5, 88.5, 89),
      candleOf(5, 89, 89.5, 87.5, 88),
      candleOf(6, 88, 88.5, 87.5, 88),
      // Its high fills the rebalance, a STICKY SELL at 87.99
      candleOf(7, 88, 88.5, 87.5, 88),
      candleOf(8, 88, 88.5, 87.5, 88),
    ];
    const { failure, orderCalls } = await runBacktest(
      backtestOf({ lastMinute: 8, usdt: 462.5, fee: NO_FEE, grid: { ...FIXED_UP, resetMode: 'down' } }),
      { 'BTC/USDT': candles },
    );

    expect({ failure, strategyLines: strategyLines(), orderCalls }).toEqual({
      failure: undefined,
      strategyLines: [
        'info | Strategy warmup done ! Sending first candle bucket (2024-01-01T00:00:00.000Z) to strategy',
        'info | GridBot: Grid built around 100 with 2 buy / 2 sell levels, qty=2.5',
        // Heard in the flush of 00:03: both BUYs filled, every level holds a SELL
        'warn | GridBot: Only one side of the grid remains active',
        'debug | GridBot: Price 89 closed below grid range [90, 110]: 1 of 2 consecutive timeframe candles towards a reset',
        'warn | GridBot: Price 89 is out of grid range [90, 110]: the grid is reset once 2 consecutive timeframe candles close below it (resetConfirmCandles), its orders waiting for the price to come back to 95 until then',
        'info | GridBot: Price 88 closed below grid range [90, 110] for 2 consecutive timeframe candles (resetConfirmCandles): reset 1, its 4 open orders are canceled and a new grid is built around the price once they have ended',
        // The BUYs spent 2.5 × 95 + 2.5 × 90 = 462.5: 10 BTC, and no USDT. The grid around 88 takes 2q BTC for its SELLs and
        // q × (83 + 78) = 161q USDT for its BUYs, and the STICKY SELL brings in 88 - 0.01 a BTC: 10 × 87.99 = 161q + 2q × 87.99,
        // q = 879.9 / 336.98 = 2.6111341..., a SELL of 10 - 2q = 4.7777316..., 4.777731
        'info | GridBot: Rebalancing - SELL 4.777731 (STICKY order)',
        // Filled on 00:07, around its close, 88: the 10 - 4.777731 = 5.222269 BTC left fund 2.611134 a SELL (2.6111345 on the step),
        // and the 4.777731 × 87.99 = 420.39255069 USDT 420.39255069 / 161 = 2.6111338... a BUY: 2.611133, the smaller
        'info | GridBot: Rebalance complete, building grid',
        'info | GridBot: Grid built around 88 with 2 buy / 2 sell levels, qty=2.611133',
      ],
      orderCalls: [
        openLimitOrder(minute(1), 'BTC/USDT', 'BUY', 2.5, 90, 1),
        openLimitOrder(minute(1), 'BTC/USDT', 'BUY', 2.5, 95, 2),
        openLimitOrder(minute(1), 'BTC/USDT', 'SELL', 2.5, 105, 3),
        openLimitOrder(minute(1), 'BTC/USDT', 'SELL', 2.5, 110, 4),
        // The BUY at 95, filled on 00:02, turns its level to a SELL one step above, sent with 00:03
        openLimitOrder(minute(4), 'BTC/USDT', 'SELL', 2.5, 100, 5),
        // The BUY at 90, filled on 00:03: a SELL at 95, sent with 00:04
        openLimitOrder(minute(5), 'BTC/USDT', 'SELL', 2.5, 95, 6),
        // The second close below 90, 00:05's: the four SELLs canceled in the order of their levels, the lowest first
        canceledLimitOrder(minute(6), 6),
        canceledLimitOrder(minute(6), 5),
        canceledLimitOrder(minute(6), 3),
        canceledLimitOrder(minute(6), 4),
        // The rebalance, sent with 00:06, at its close less price.min
        openLimitOrder(minute(7), 'BTC/USDT', 'SELL', 4.777731, 87.99, 7),
        // The new grid, 5 apart around 88, sent with 00:08
        openLimitOrder(minute(9), 'BTC/USDT', 'BUY', 2.611133, 78, 8),
        openLimitOrder(minute(9), 'BTC/USDT', 'BUY', 2.611133, 83, 9),
        openLimitOrder(minute(9), 'BTC/USDT', 'SELL', 2.611133, 93, 10),
        openLimitOrder(minute(9), 'BTC/USDT', 'SELL', 2.611133, 98, 11),
      ],
    });
  });

  it('Scenario D: an atr grid is rebuilt with the step of the candle that resets it, 2.5 × its true range of 4, 10 apart', async () => {
    const candles = [
      ...ATR_START,
      // Its high fills the SELL at 110
      candleOf(4, 104, 110, 103.5, 109),
      // Quiet: the BUY at 105 the SELL at 110 turned to goes out with it
      candleOf(5, 109, 109.5, 108.5, 109),
      // Closes above 110, the reset: its true range, the ATR of period 1, is 113 - 109 = 4
      candleOf(6, 109, 113, 109, 112),
      candleOf(7, 112, 112.5, 111.5, 112),
      // Its low fills the rebalance, a STICKY BUY at 112.01
      candleOf(8, 112, 112.5, 111.5, 112),
      candleOf(9, 112, 112.5, 111.5, 112),
    ];
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({ lastMinute: 9, candleCount: 2, usdt: 462.9625, fee: BINANCE_FEE, grid: ATR_UP }),
      { 'BTC/USDT': candles },
    );

    // The step of the new grid is 2.5 × 4 = 10, above the least step at 112, 112 × 2 × 0.001 / (1 - 3 × 0.001) = 0.2246..., 0.23 on
    // the tick: no line names it, the checks of the grid passing, and its prices show it
    expect({ failure, strategyLines: strategyLines(), orderCalls, lastRead: balanceReads.at(-1) }).toEqual({
      failure: undefined,
      strategyLines: [
        ...ATR_START_LINES,
        // resetConfirmCandles 1: the first close above the grid resets it, without a warning
        'info | GridBot: Price 112 closed above grid range [90, 110] for 1 consecutive timeframe candle (resetConfirmCandles): reset 1, its 4 open orders are canceled and a new grid is built around the price once they have ended',
        // The SELLs brought 2.5 × 105 × 0.999 + 2.5 × 110 × 0.999 = 262.2375 + 274.725: 999.925 USDT, and no BTC. Around 112, the
        // BUYs at 102 and 92 take q × 194 × 1.001 = 194.194q, and the STICKY BUY pays 112.01 × 1.001 = 112.12201 a BTC:
        // 999.925 = 194.194q + 2q × 112.12201, q = 999.925 / 418.43802 = 2.3896609..., a BUY of 2q = 4.7793219..., 4.779321
        'info | GridBot: Rebalancing - BUY 4.779321 (STICKY order)',
        // Filled on 00:08, around its close, 112: the 4.779321 BTC fund 2.38966 a SELL (2.3896605 on the step), and the 464.05792304
        // USDT left 464.05792304 / 194.194 = 2.3896614... a BUY: 2.38966, the smaller
        'info | GridBot: Rebalance complete, building grid',
        'info | GridBot: Grid built around 112 with 2 buy / 2 sell levels, qty=2.38966',
      ],
      orderCalls: [
        ...ATR_RESET_CALLS,
        openLimitOrder(minute(8), 'BTC/USDT', 'BUY', 4.779321, 112.01, 7),
        // 10 apart around 112
        openLimitOrder(minute(10), 'BTC/USDT', 'BUY', 2.38966, 92, 8),
        openLimitOrder(minute(10), 'BTC/USDT', 'BUY', 2.38966, 102, 9),
        openLimitOrder(minute(10), 'BTC/USDT', 'SELL', 2.38966, 122, 10),
        openLimitOrder(minute(10), 'BTC/USDT', 'SELL', 2.38966, 132, 11),
      ],
      // 4.779321 × 112.01 × 1.001 = 535.86707695521, booked 535.86707696: 999.925 - 535.86707696
      lastRead: unreservedRead(minute(9), { BTC: 4.779321, USDT: 464.05792304 }),
    });
  });

  it('Scenario E: an atr grid reset by a candle of a true range of 0.02 is rebuilt on the least step at which each of its levels breaks even on the maker fee', async () => {
    const candles = [
      ...ATR_START,
      // Its high fills the SELL at 110, on which it closes: a bound is in the range
      candleOf(4, 104, 110, 103.5, 110),
      // Quiet: the BUY at 105 the SELL at 110 turned to goes out with it
      candleOf(5, 110, 110, 109.5, 110),
      // Closes above 110 by a tick, the reset: its true range, the ATR of period 1, is 110.02 - 110, 0.01999999999999602 in binary
      candleOf(6, 110, 110.02, 110, 110.01),
      candleOf(7, 110.01, 110.02, 110, 110.01),
      // Its low fills the rebalance, a STICKY BUY at 110.02
      candleOf(8, 110.01, 110.02, 110, 110.01),
      candleOf(9, 110.01, 110.02, 110, 110.01),
    ];
    const { failure, orderCalls, balanceReads } = await runBacktest(
      backtestOf({ lastMinute: 9, candleCount: 2, usdt: 462.9625, fee: BINANCE_FEE, grid: ATR_UP }),
      { 'BTC/USDT': candles },
    );

    expect({ failure, strategyLines: strategyLines(), orderCalls, lastRead: balanceReads.at(-1) }).toEqual({
      failure: undefined,
      strategyLines: [
        ...ATR_START_LINES,
        'info | GridBot: Price 110.01 closed above grid range [90, 110] for 1 consecutive timeframe candle (resetConfirmCandles): reset 1, its 4 open orders are canceled and a new grid is built around the price once they have ended',
        // Around the close of the reset, 110.01: 2.5 × 0.02 is 0.05 on the tick. A level loses money when it sells less than
        // r = 2 × 0.001 / 0.999 above its buy, and the highest, which buys at 110.01 + step, earns the least for the step:
        // step ≥ 110.01 × r / (1 - r) = 110.01 × 0.002 / 0.997 = 0.2206820..., 0.23 rounded up to the tick, where it sells at 110.47,
        // 110.47 × 0.999 = 110.35953, above its buy at 110.24, 110.24 × 1.001 = 110.35024
        'warn | GridBot: ATR spacing: spacingValue 2.5 × ATR 0.02 is a step of 0.05 on the price tick 0.01, under 0.23, the minimum step at which every level of the grid breaks even on the maker fee of 0.001 (fee.maker): the grid is spaced by 0.23 instead',
        // 999.925 USDT, as in scenario D. Around 110.01, the BUYs at 109.78 and 109.55 take q × 219.33 × 1.001 = 219.54933q, and the
        // STICKY BUY pays 110.02 × 1.001 = 110.13002 a BTC: 999.925 = 219.54933q + 2q × 110.13002, q = 999.925 / 439.80937 =
        // 2.2735418..., a BUY of 2q = 4.5470836..., 4.547083
        'info | GridBot: Rebalancing - BUY 4.547083 (STICKY order)',
        // Filled on 00:08, around its close, 110.01, on the step of the reset: the 4.547083 BTC fund 2.273541 a SELL (2.2735415 on the
        // step), and the 499.15465827 USDT left 499.15465827 / 219.54933 = 2.2735421... a BUY: 2.273541, the smaller
        'info | GridBot: Rebalance complete, building grid',
        'info | GridBot: Grid built around 110.01 with 2 buy / 2 sell levels, qty=2.273541',
      ],
      orderCalls: [
        ...ATR_RESET_CALLS,
        openLimitOrder(minute(8), 'BTC/USDT', 'BUY', 4.547083, 110.02, 7),
        // 0.23 apart around 110.01
        openLimitOrder(minute(10), 'BTC/USDT', 'BUY', 2.273541, 109.55, 8),
        openLimitOrder(minute(10), 'BTC/USDT', 'BUY', 2.273541, 109.78, 9),
        openLimitOrder(minute(10), 'BTC/USDT', 'SELL', 2.273541, 110.24, 10),
        openLimitOrder(minute(10), 'BTC/USDT', 'SELL', 2.273541, 110.47, 11),
      ],
      // 4.547083 × 110.02 × 1.001 = 500.77034173166, booked 500.77034173: 999.925 - 500.77034173
      lastRead: unreservedRead(minute(9), { BTC: 4.547083, USDT: 499.15465827 }),
    });
  });

  it('Scenario F: an atr grid whose ATR has no value on the first candle after the warmup stops the run there, before any order', async () => {
    const { failure, orderCalls } = await runBacktest(
      backtestOf({ lastMinute: 1, candleCount: 0, usdt: 462.9625, fee: BINANCE_FEE, grid: ATR_UP }),
      { 'BTC/USDT': ATR_START.slice(0, 2) },
    );

    // Without a warmup, the first candle after it is the first of the run, 00:00, which has no previous close for a true range
    const refusal =
      "GridBot: The ATR has no value yet on the first candle after the warmup: with atrPeriod 1 it needs 2 timeframe candles, the warmup's and the first after it, so set watch.warmup.candleCount to 1 or more";
    expect({ failure: failure && { name: failure.name, message: failure.message }, strategyLines: strategyLines(), orderCalls }).toEqual({
      failure: { name: 'GekkoError', message: `[STRATEGY] ${refusal}` },
      strategyLines: [
        'info | Strategy warmup done ! Sending first candle bucket (2024-01-01T00:00:00.000Z) to strategy',
        `error | ${refusal}`,
      ],
      orderCalls: [],
    });
  });
});
