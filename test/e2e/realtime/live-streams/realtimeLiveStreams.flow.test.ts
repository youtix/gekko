import { ONE_MINUTE, ONE_SECOND } from '@constants/time.const';
import type { SQLiteStorage } from '@services/storage/sqlite.storage';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { pick, range } from 'lodash-es';
import { fileURLToPath } from 'node:url';
import { generateSyntheticCandle } from '../../fixtures/syntheticData';
import { advanceClock, startFakeClock } from '../../helpers/clock.helper';
import { mockConfiguration, paperExchange, type RawConfiguration } from '../../helpers/configuration.helper';
import { readCandles } from '../../helpers/database.helper';
import {
  endRealtimeRun,
  mockRealtimeModules,
  runRealtimeFor,
  runRealtimeUntil,
  runRealtimeUntilEnd,
  startRealtimeRun,
} from '../../helpers/realtimeRun.helper';
import { MockCCXTExchange } from '../../mocks/ccxt.mock';
import { clearLogs, findLoggedObject, findTextLine, findTextLines, isTextLine, logStore } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// 1. Mock winston, ccxt and the fetcher. Each test runs on real minutes under the fake clock, from 12:00:30, and ends its run before
// the next test starts (see realtimeRun.helper)
mockRealtimeModules();
// The strategy's lines are read from the winston mock: the logger hands a debug line to winston only when GEKKO_LOG_LEVEL lets it
// through, and the logger is loaded after this, by the pipeline
process.env.GEKKO_LOG_LEVEL = 'debug';

// 2. Mock Configuration: each scenario sets the configuration of its run
let configuration: RawConfiguration;
mockConfiguration(() => configuration);

// --------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------

/** The start of the minute hh:mm of the day the runs start on, 2024-01-01 (see REALTIME_START) */
const minute = (hours: number, minutes: number) => Date.UTC(2024, 0, 1, hours, minutes);

/** The candles the ccxt mock serves for BTC/USDT, `count` of them from the minute `from` on, as the exchange delivers them */
const exchangeCandles = (from: number, count: number) =>
  range(count).map(index => generateSyntheticCandle('BTC/USDT', from + index * ONE_MINUTE));

/** The close of the BTC/USDT candle of the minute `start`, as the ccxt mock serves it */
const closeOf = (start: number) => generateSyntheticCandle('BTC/USDT', start).close;

/** The warnings and errors the streams logged, oldest first, each after its level */
const streamLines = () =>
  logStore
    .filter(isTextLine)
    .filter(({ _tag, level }) => _tag === 'STREAM' && (level === 'warn' || level === 'error'))
    .map(({ level, message }) => `${level}: ${message}`);

/** The lines the strategy and its manager logged, oldest first, each after its level */
const strategyLines = () =>
  logStore
    .filter(isTextLine)
    .filter(({ _tag }) => _tag === 'STRATEGY')
    .map(({ level, message }) => `${level}: ${message}`);

/** The storage of the run, the CandleWriter's: kept open once the run is over, for the scenario to read what it holds */
const openStorage = async () => {
  const { inject } = await import('@services/injecter/injecter');
  const storage = inject.storage() as SQLiteStorage;
  storage.close = () => {};
  return storage;
};

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Realtime live streams', () => {
  beforeEach(async () => {
    const { inject } = await import('@services/injecter/injecter');
    inject.reset();
    clearLogs();
    MockCCXTExchange.reset();
    startFakeClock();
  });

  // A realtime run never ends by itself: each test ends its own, plugins finalised and orders stopped, before the next one starts
  afterEach(() => endRealtimeRun());

  it('Scenario A: ETH unserved after 12:01 stops the run at 12:07:02, its 5th tick without a candle, the report says why', async () => {
    configuration = {
      watch: { mode: 'realtime', assets: ['BTC', 'ETH'], currency: 'USDT', timeframe: '1m', warmup: { candleCount: 0 } },
      exchange: paperExchange([
        { assetName: 'BTC', balance: 1 },
        { assetName: 'ETH', balance: 1 },
        { assetName: 'USDT', balance: 1000 },
      ]),
      // DebugAdvice waiting 1000 candles before its first advice: the run trades nothing
      plugins: [{ name: 'TradingAdvisor', strategyName: 'DebugAdvice' }, { name: 'Trader' }, { name: 'PortfolioAnalyzer' }],
      strategy: { name: 'DebugAdvice', each: 1, wait: 1000 },
    };
    // Delisted: the exchange has no ETH candle from 12:02 on, while BTC trades on
    MockCCXTExchange.simulatedGaps = { 'ETH/USDT': [{ start: minute(12, 2), end: Infinity }] };

    const failure = (await runRealtimeUntilEnd({ maxMinutes: 10 })) as Error;

    // The ticks at 12:01:02 and 12:02:02 fetch the minutes 12:00 and 12:01 of both pairs. From 12:03:02 every ETH tick asks for 12:02
    // again and gets nothing, while BTC's go on: a bucket waits for a candle of every pair, so that none reaches the plugins after
    // 12:01, BTC's minutes held with it. The 5th tick without an ETH candle, at 12:07:02, ends the stream with the error that stops
    // the run, which the plugins are finalised with: the report covers the two minutes the plugins got, and names why it stopped.
    const stop =
      '[STREAM] No 1m candle received for ETH/USDT for 5 minutes (last one @ 2024-01-01T12:01:00.000Z): the pair no longer delivers.';
    expect({
      failure: pick(failure, ['name', 'message']),
      endedAt: Date.now(),
      streamLines: streamLines(),
      report: pick(
        findLoggedObject(message => message.id === 'PORTFOLIO PROFIT REPORT'),
        ['periodStartAt', 'periodEndAt', 'equityCurveLength', 'interruption'],
      ),
    }).toEqual({
      failure: { name: 'GekkoError', message: stop },
      endedAt: minute(12, 7) + 2 * ONE_SECOND,
      streamLines: [
        ...Array(5).fill('warn: Received undefined candle for ETH/USDT @ 2024-01-01T12:02:00.000Z'),
        `error: Gekko is closing the application due to an error: ${stop}`,
      ],
      // From the close of 12:00, the candle that completed the warmup, to that of 12:01, the last bucket: a point at each
      report: { periodStartAt: minute(12, 1), periodEndAt: minute(12, 2), equityCurveLength: 2, interruption: stop },
    });
  });

  it.each([
    [
      'three NetworkErrors: its own retries get 12:01 within the tick, 4.6 s late, without a warning',
      { errors: 3, storedAfterTheTick: [minute(12, 0), minute(12, 1)], streamLines: [] },
    ],
    [
      'four NetworkErrors: the tick gives up, warns, and the next one fetches 12:01 with 12:02',
      {
        errors: 4,
        storedAfterTheTick: [minute(12, 0)],
        streamLines: [
          'warn: Failed to fetch the 1m candles of BTC/USDT from 2024-01-01T12:01:00.000Z, ' +
            'retrying on the next tick: Simulated Network Error',
        ],
      },
    ],
  ])(
    'Scenario B: the fetch of 12:01 failing on %s; nothing made up',
    async (_title, { errors, storedAfterTheTick, streamLines: lines }) => {
      configuration = {
        watch: { mode: 'realtime', assets: ['BTC'], currency: 'USDT', timeframe: '1m', warmup: { candleCount: 0 } },
        exchange: { name: 'binance' },
        storage: { type: 'sqlite', database: ':memory:' },
        plugins: [{ name: 'CandleWriter' }],
      };
      const storage = await openStorage();
      const storedStarts = () => readCandles(storage, 'BTC/USDT').map(({ start }) => start);

      // To 12:01:30, past the tick that stored 12:00; then the next calls to the exchange fail on the network, those of the tick of
      // 12:02:02 and of its retries, 1000, 1585 and 2000 ms apart: three are retried within the tick, a fourth is the read's last attempt.
      // Read at 12:02:30, after that tick, then at 12:03:30, after the next one.
      await runRealtimeFor({ minutes: 1 });
      MockCCXTExchange.networkErrorsToThrow = errors;
      await runRealtimeFor({ minutes: 1 });
      const afterTheTick = storedStarts();
      await runRealtimeFor({ minutes: 1 });

      // By then the minutes 12:00 to 12:02 are stored as the exchange served them, each once: a failed fetch is asked again, never made
      // up, nor skipped (the gap filler would then have warned, and stored a flat 12:01)
      expect({ afterTheTick, afterTheNextTick: readCandles(storage, 'BTC/USDT'), streamLines: streamLines() }).toEqual({
        afterTheTick: storedAfterTheTick,
        afterTheNextTick: exchangeCandles(minute(12, 0), 3),
        streamLines: lines,
      });
    },
  );

  it('Scenario C: on 5m after a warmup of 1, 11:55-11:59 read at start-up, the live minutes after, the first trade on 12:00', async () => {
    configuration = {
      watch: { mode: 'realtime', assets: ['BTC'], currency: 'USDT', timeframe: '5m', warmup: { candleCount: 1, tickrate: 100 } },
      exchange: { name: 'binance' },
      storage: { type: 'sqlite', database: ':memory:' },
      plugins: [{ name: 'TradingAdvisor', strategyName: 'DebugRealtime' }, { name: 'CandleWriter' }],
      strategy: { name: 'DebugRealtime' },
    };
    const storage = await openStorage();

    // The pipeline reads 12:00 as the minute in progress: the warmup history holds the 5m candle before it, 11:55 to 11:59, then the
    // closed minutes of the candle in progress, none yet, and the live streams start with 12:00, so that the two meet without a gap or
    // an overlap. The history is read at start-up: by 12:00:59, before the first live tick, it is stored.
    await startRealtimeRun();
    await advanceClock(29 * ONE_SECOND);
    const startUp = { stored: readCandles(storage, 'BTC/USDT'), strategyLines: strategyLines() };

    // The 5m candle of 12:00 closes with the minute 12:04, fetched at 12:05:02: the warmup's one candle was 11:55's, so it is the first
    // the strategy trades on
    await runRealtimeUntil(() => findTextLine('Strategy warmup done') !== undefined, { maxMinutes: 10 });
    const warmupDone = { at: Date.now(), stored: readCandles(storage, 'BTC/USDT'), strategyLines: strategyLines() };
    await runRealtimeUntil(() => findTextLine('Iteration: 1') !== undefined, { maxMinutes: 10 });

    expect({ startUp, warmupDone, secondCandleAt: Date.now(), streamLines: streamLines() }).toEqual({
      startUp: { stored: exchangeCandles(minute(11, 55), 5), strategyLines: [] },
      // In the minute ending at 12:05:59, after the tick of 12:05:02: the history, then one live minute a tick
      warmupDone: {
        at: minute(12, 5) + 59 * ONE_SECOND,
        stored: exchangeCandles(minute(11, 55), 10),
        strategyLines: [
          'info: Strategy warmup done ! Sending first candle bucket (2024-01-01T12:00:00.000Z) to strategy',
          'debug: Iteration: 0 for BTC/USDT',
          'debug: Trigger BUY for BTC/USDT',
        ],
      },
      // The candle of 12:05 closes with 12:09, fetched at 12:10:02
      secondCandleAt: minute(12, 10) + 59 * ONE_SECOND,
      // Neither a minute twice, the last of the history and the first live one, nor a minute between them made up
      streamLines: [],
    });
  });

  it('Scenario D: an order on a warmup candle stops the run at start-up, never reaching the Trader; init on the first minute', async () => {
    configuration = {
      watch: { mode: 'realtime', assets: ['BTC'], currency: 'USDT', timeframe: '5m', warmup: { candleCount: 1, tickrate: 100 } },
      exchange: paperExchange([
        { assetName: 'BTC', balance: 1 },
        { assetName: 'USDT', balance: 1000 },
      ]),
      plugins: [
        // A strategy file of the scenario's, which orders on every candle, the candles of its warmup included
        {
          name: 'TradingAdvisor',
          strategyName: 'WarmupOrder',
          strategyPath: fileURLToPath(new URL('./warmupOrder.strategy.ts', import.meta.url)),
        },
        { name: 'Trader' },
      ],
      strategy: { name: 'WarmupOrder' },
    };

    const failure = await runRealtimeUntilEnd({ maxMinutes: 1 });

    // The warmup history, 11:55 to 11:59, is replayed at start-up with the Trader live, as the live minutes will be: an order created on
    // one of its candles would go to the exchange at a close of the past. init runs on its first one-minute bucket, 11:55, its candle
    // closing as that minute does. The first 5m candle, 11:55's, closing as 11:59 does, completes with the bucket of 11:59: the order
    // the strategy creates on it is refused before it is relayed, and the error stops the run there, before any live minute, its
    // strategy ended without a trade.
    const refusal =
      '[STRATEGY] Orders are not available until the warmup is over: create them from onTimeframeCandleAfterWarmup, log or an order ' +
      'hook, never from init';
    const orderLines = logStore.filter(isTextLine).filter(({ _tag }) => _tag === 'ORDER');
    const liveCandles = findTextLines('1m candle from', 'debug');
    expect({ failure: pick(failure, ['name', 'message']), liveCandles, strategyLines: strategyLines(), orderLines }).toEqual({
      failure: { name: 'GekkoError', message: refusal },
      liveCandles: [],
      strategyLines: [
        `info: init with the candle 2024-01-01T11:55:00.000Z of BTC/USDT, closing at ${closeOf(minute(11, 55))}`,
        `info: candle 2024-01-01T11:55:00.000Z of BTC/USDT, closing at ${closeOf(minute(11, 59))}`,
        'error: Strategy ended before its warmup was over, so it never traded: 0 timeframe candles processed, 2 needed ' +
          '(warmup.candleCount: 1, then one to trade on)',
      ],
      orderLines: [],
    });
  });
});
