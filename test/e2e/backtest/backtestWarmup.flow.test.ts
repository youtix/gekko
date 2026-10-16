import type { Candle } from '@models/candle.types';
import { beforeEach, describe, expect, it } from 'bun:test';
import { range } from 'lodash-es';
import { rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { clearLogs, findTextLines } from '../mocks/winston.mock';
import { filledMarketOrder, minute, mockBacktestModules, rawMarket, runBacktest, unreservedRead } from './backtestRun.helper';

mockBacktestModules();

/** The 1-minute candles of the minutes `first` to `last`, each closing at the price `priceAt` gives it, opening there too, 50 either side */
const candlesOf = (first: number, last: number, priceAt: (n: number) => number): Candle[] =>
  range(first, last + 1).map(n => ({
    start: minute(n),
    open: priceAt(n),
    high: priceAt(n) + 50,
    low: priceAt(n) - 50,
    close: priceAt(n),
    volume: 10,
  }));

/** A strategy block: the strategy's name, which the TradingAdvisor selects it by, and its parameters */
type StrategyBlock = { name: string; [parameter: string]: unknown };

/** A backtest on 5-minute candles, after a warmup of two, of the minutes from 00:03 to the one `lastMinute` minutes after 00:00 */
const backtestOf = (lastMinute: number, assets: ('BTC' | 'ETH')[], strategy: StrategyBlock): RawConfiguration => ({
  watch: {
    mode: 'backtest',
    assets,
    currency: 'USDT',
    timeframe: '5m',
    warmup: { candleCount: 2 },
    daterange: rawDaterange({ start: minute(3), end: minute(lastMinute + 1) - 1 }),
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [...assets.map(assetName => ({ assetName, balance: 0 })), { assetName: 'USDT', balance: 300000 }],
    marketData: assets.map(asset => rawMarket(`${asset}/USDT`)),
  },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [{ name: 'TradingAdvisor', strategyName: strategy.name }, { name: 'Trader' }],
  strategy,
});

/** The lines logged as text at `level`, oldest first, with their tag: only the warnings of the run, or only its strategy's lines */
const linesAt = (level: 'warn' | 'info', tag?: string) =>
  findTextLines('', level)
    .filter(({ _tag }) => tag === undefined || _tag === tag)
    .map(({ _tag, message }) => `${_tag} | ${message}`);

describe('E2E: Backtest warmup', () => {
  beforeEach(() => {
    clearLogs();
  });

  it('runs init on the first minute, reads the SMA through the warmup and buys on the first candle after it, all-in', async () => {
    // BTC trades at 10000, but for the 5-minute candles of 00:10 at 9900 and of 00:20 at 10100: each minute of a candle closes at its
    // price. ETH, watched beside it, trades at 2000.
    const btcPrices = [10000, 9900, 10000, 10100, 10000];
    const btc = candlesOf(3, 29, n => (n < 5 ? 10000 : btcPrices[Math.floor((n - 5) / 5)]));
    const eth = candlesOf(3, 29, () => 2000);

    const { failure, orderCalls, balanceReads } = await runBacktest(backtestOf(29, ['BTC', 'ETH'], { name: 'SMACrossover', period: 2 }), {
      'BTC/USDT': btc,
      'ETH/USDT': eth,
    });

    // The minutes 00:03 and 00:04 come before the first 5-minute boundary: the strategy gets the candles of 00:05 to 00:25, the first two
    // its warmup, which the SMA of two closes reads all the same. Ready on the candle of 00:10, it puts the price below it, 9900 under
    // (10000 + 9900) / 2: the candle of 00:15, the first after the warmup, crosses it, 10000 above 9950, and the strategy buys. The candle
    // of 00:25 crosses it back, 10000 below (10100 + 10000) / 2, and the strategy sells.
    expect({
      failure,
      warnings: linesAt('warn'),
      strategyLines: linesAt('info', 'STRATEGY'),
      orderCalls,
      balanceReads: balanceReads.slice(2),
    }).toEqual({
      failure: undefined,
      warnings: [
        'STREAM | BACKTESTING FEATURE NEEDS PROPER TESTING, ACT ON THESE NUMBERS AT YOUR OWN RISK!',
        // init picks the pair it trades on the first minute read, 00:03, before the batcher reads it: the batcher warns once a minute
        // starts on a boundary, at 00:05, one batcher per pair, neither naming its pair
        'STRATEGY | The strategy trades BTC/USDT only, the first pair watched (watch.assets): it ignores ETH/USDT, whose candles are still required every minute',
        'CORE | Skipped 2 one-minute candles from 2024-01-01T00:03:00.000Z: the first 5-minute candle starts on the first boundary, 2024-01-01T00:05:00.000Z',
        'CORE | Skipped 2 one-minute candles from 2024-01-01T00:03:00.000Z: the first 5-minute candle starts on the first boundary, 2024-01-01T00:05:00.000Z',
      ],
      strategyLines: [
        // On the candle of 00:10, the last of the warmup
        'STRATEGY | Initial state: price below SMA',
        'STRATEGY | Strategy warmup done ! Sending first candle bucket (2024-01-01T00:15:00.000Z) to strategy',
        'STRATEGY | SMA crossed DOWN price (9950.00000 < 10000.00000) => BUY',
        'STRATEGY | SMA crossed UP price (10050.00000 > 10000.00000) => SELL',
      ],
      // Each order goes out with the last minute of its candle, filled at its close and dated at its end
      orderCalls: [
        // The 300000 USDT read at the end of the warmup, less the 5 % kept back for the fee, at 10000: 285000 / 10000
        filledMarketOrder(minute(20), 'BTC/USDT', 'BUY', 28.5, 1),
        // All the BTC free
        filledMarketOrder(minute(30), 'BTC/USDT', 'SELL', 28.5, 2),
      ],
      // After the TradingAdvisor's and the Trader's reads at start-up: the synchronization on the minute 00:10, a multiple of 10, then
      // that of the end of the warmup, which the BUY is sized from, and those after each fill and on the minute 00:20
      balanceReads: [
        unreservedRead(minute(11), { BTC: 0, ETH: 0, USDT: 300000 }),
        unreservedRead(minute(20), { BTC: 0, ETH: 0, USDT: 300000 }),
        // 28.5 × 10000 × 1.001 = 285285 spent
        unreservedRead(minute(20), { BTC: 28.5, ETH: 0, USDT: 14715 }),
        unreservedRead(minute(21), { BTC: 28.5, ETH: 0, USDT: 14715 }),
        // 28.5 × 10000 × 0.999 = 284715 brought in
        unreservedRead(minute(30), { BTC: 0, ETH: 0, USDT: 299430 }),
      ],
    });
  });

  it('refuses a range that holds no more whole candles than the warmup, and trades the one candle after it of the shortest it accepts', async () => {
    const strategy = { name: 'DebugBacktest', buyCandleIndex: 0, sellCandleIndex: [] };
    const btc = { 'BTC/USDT': candlesOf(3, 19, () => 10000) };
    const warmupLines = () => findTextLines('Strategy warmup done', 'info').map(({ message }) => message);
    const refused = await runBacktest(backtestOf(18, ['BTC'], strategy), btc);
    const oneMinuteShort = { failure: refused.failure?.message, warmupLines: warmupLines(), orderCalls: refused.orderCalls };
    clearLogs();
    const shortest = await runBacktest(backtestOf(19, ['BTC'], strategy), btc);

    // From 00:03, the whole 5-minute candles start at 00:05: the warmup takes those of 00:05 and 00:10, and the strategy trades from the
    // one of 00:15, which ends with the minute 00:19. A range one minute shorter would end the run with the warmup: the configuration
    // refuses it, as the loader refuses its file, before any candle is read.
    expect({
      oneMinuteShort,
      shortest: { failure: shortest.failure, warmupLines: warmupLines(), orderCalls: shortest.orderCalls },
    }).toEqual({
      oneMinuteShort: {
        // The harness reads the configuration through the schema, as the loader does (see mockConfiguration)
        failure: [
          'Invalid configuration of the flow:',
          '✖ watch.daterange must hold more whole 5m candles than warmup.candleCount (2), or the warmup never ends and the strategy never trades: it holds 2 from 2024-01-01T00:05:00.000Z, its first 5m boundary, so it must end at 2024-01-01T00:19:00.000Z or later',
          '  → at watch.daterange',
        ].join('\n'),
        warmupLines: [],
        orderCalls: [],
      },
      shortest: {
        failure: undefined,
        warmupLines: ['Strategy warmup done ! Sending first candle bucket (2024-01-01T00:15:00.000Z) to strategy'],
        // The BUY of its first candle after the warmup, filled at the close of the last minute read
        orderCalls: [filledMarketOrder(minute(20), 'BTC/USDT', 'BUY', 1, 1)],
      },
    });
  });
});
