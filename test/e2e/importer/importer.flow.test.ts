import { ONE_MINUTE } from '@constants/time.const';
import type { Candle } from '@models/candle.types';
import type { TradingPair } from '@models/utility.types';
import type { SQLiteStorage } from '@services/storage/sqlite.storage';
import { afterEach, beforeEach, describe, expect, it, mock, setSystemTime } from 'bun:test';
import { last } from 'lodash-es';
import { generateSyntheticCandle } from '../fixtures/syntheticData';
import { mockConfiguration, rawDaterange } from '../helpers/configuration.helper';
import { candleTables, readCandles, seedDatabaseWithCandles } from '../helpers/database.helper';
import { createCcxtModuleMock, type Gap, MockCCXTExchange, MockNetworkError } from '../mocks/ccxt.mock';
import { MockWinston, clearLogs, isTextLine, logStore } from '../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

mock.module('winston', () => MockWinston);

/** A range of minutes, both bounds included, as watch.daterange reads */
type Range = { start: number; end: number };

/** 2023-11-14T22:13:00.000Z, where every range imported starts, but on the stopped clock of scenario J */
const START = 1700000000000 - (1700000000000 % ONE_MINUTE);
/** The minute `n` minutes after START */
const minute = (n: number) => START + n * ONE_MINUTE;
/** That minute, as the log lines write it */
const at = (n: number) => new Date(minute(n)).toISOString();
/** 61 minutes, both bounds included: the range most scenarios import */
const HOUR = { start: START, end: minute(60) };

/** Under load, the first import of a run pays for the cold imports of the whole pipeline */
const TIMEOUT = 60_000;

// The configuration of the next import, which setUpImport sets: the schema parses it on every read
let mockAssets = ['BTC'];
let mockDaterange: Range = HOUR;

mockConfiguration(() => ({
  watch: {
    mode: 'importer',
    assets: mockAssets,
    currency: 'USDT',
    daterange: rawDaterange(mockDaterange),
    tickrate: 100,
    warmup: { candleCount: 0 },
  },
  exchange: { name: 'binance' }, // Matches key in mocking below
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [{ name: 'CandleWriter' }], // Enable writing to DB
}));

mock.module('ccxt', () => createCcxtModuleMock());

// --------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------

/** What a scenario imports: the assets it watches, its range, and the minutes the exchange has no candle for (see simulatedGaps) */
type ImportSetup = { assets: string[]; daterange: Range; gaps?: typeof MockCCXTExchange.simulatedGaps };

/**
 * Sets the configuration of the scenario's import, then builds its storage, which creates the tables of the pairs it is built for. The
 * beforeEach built it before the scenario set its pairs, for the pairs of the scenario before: B found the ETH table A had created, and
 * A failed when it ran after a scenario of BTC alone.
 */
const setUpImport = async ({ assets, daterange, gaps = [] }: ImportSetup) => {
  mockAssets = assets;
  mockDaterange = daterange;
  MockCCXTExchange.simulatedGaps = gaps;
  const { inject } = await import('@services/injecter/injecter');
  inject.reset();
  const storage = inject.storage() as SQLiteStorage;
  // CandleWriter closes the storage at the end of an import: the candles are inserted, and the in-memory database kept for the assertions
  storage.close = () => storage['flush']();
  return storage;
};

/**
 * Runs an import, over `daterange` when one is given, into the storage setUpImport built, to its end: the error it failed with, and
 * undefined when it completed. Caught rather than asserted through `rejects`, which Bun waits on past the test's timeout: an import
 * that froze would hang the suite instead of failing its scenario.
 */
const runImport = async (daterange?: Range) => {
  if (daterange) mockDaterange = daterange;
  const { gekkoPipeline } = await import('@services/core/pipeline/pipeline');
  return gekkoPipeline().then(
    () => undefined,
    (error: Error) => error,
  );
};

/** What a scenario asserts of a failure: its class, its message and its cause */
const describeFailure = (error?: Error) => error && { name: error.name, message: error.message, cause: error.cause };

/** The lines logged at warn level since the beforeEach, oldest first */
const warnings = () =>
  logStore
    .filter(isTextLine)
    .filter(({ level }) => level === 'warn')
    .map(({ message }) => message);

/** The candles stored for each of the assets, against USDT */
const storedCandles = (storage: SQLiteStorage, assets: string[]) =>
  Object.fromEntries(assets.map(asset => [asset, readCandles(storage, `${asset}/USDT`)]));

/**
 * The candles an import of `range` stores for the pair: the exchange's, but none for the minutes `missing` holds, and for those `filled`
 * holds a flat candle at the last close, without volume, as the gap filler makes them up
 */
const expectedCandles = (pair: TradingPair, range: Range = HOUR, { filled, missing }: { filled?: Gap; missing?: Gap } = {}) => {
  const holds = (gap: Gap | undefined, start: number) => gap !== undefined && start >= gap.start && start < gap.end;
  const candles: Candle[] = [];
  for (let start = range.start; start <= range.end; start += ONE_MINUTE) {
    if (holds(missing, start)) continue;
    if (!holds(filled, start)) {
      candles.push(generateSyntheticCandle(pair, start));
      continue;
    }
    const { close } = last(candles)!; // A gap is filled from the candle before it: a row filling the first minute is wrong
    candles.push({ start, open: close, high: close, low: close, close, volume: 0 });
  }
  return candles;
};

/** What a scenario asserts of an import, the error it failed with written as describeFailure writes it */
type ImportOutcome = { failure: ReturnType<typeof describeFailure>; candles: Candle[] };

/** Whether a stored candle looks made up, as the storage tells one: flat, without volume */
const isMadeUp = ({ open, high, low, close, volume }: Candle) => volume === 0 && open === high && high === low && low === close;

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Importer (Synthetic)', () => {
  beforeEach(() => {
    clearLogs();
    MockCCXTExchange.reset();
  });

  it(
    'Scenario A: imports two pairs, every minute of the range as the exchange serves it',
    async () => {
      const storage = await setUpImport({ assets: ['BTC', 'ETH'], daterange: HOUR });
      const failure = await runImport();
      expect({ failure, candles: storedCandles(storage, ['BTC', 'ETH']), warnings: warnings() }).toEqual({
        failure: undefined,
        candles: { BTC: expectedCandles('BTC/USDT'), ETH: expectedCandles('ETH/USDT') },
        warnings: [],
      });
    },
    TIMEOUT,
  );

  it(
    'Scenario B: imports one pair, into a database that holds its table alone',
    async () => {
      const storage = await setUpImport({ assets: ['BTC'], daterange: HOUR });
      const failure = await runImport();
      expect({ failure, tables: candleTables(storage), candles: storedCandles(storage, ['BTC']) }).toEqual({
        failure: undefined,
        tables: ['CANDLES_BTC_USDT'],
        candles: { BTC: expectedCandles('BTC/USDT') },
      });
    },
    TIMEOUT,
  );

  // The second page is asked for from the millisecond after the last candle of the first: it must start at the next minute, and the
  // range end with its last minute, without a minute twice or off the minute boundaries
  it(
    'Scenario C: imports a range of two exchange pages (1001 candles)',
    async () => {
      const range = { start: START, end: minute(1000) };
      const storage = await setUpImport({ assets: ['BTC'], daterange: range });
      const failure = await runImport();
      expect({ failure, candles: storedCandles(storage, ['BTC']) }).toEqual({
        failure: undefined,
        candles: { BTC: expectedCandles('BTC/USDT', range) },
      });
    },
    TIMEOUT,
  );

  // CCXTExchange sends a read again after a ccxt NetworkError, three more times, 1000, 1585 and 2000 ms apart, then throws an
  // ExchangeNetworkError caused by it: a lasting fault waits 4.6 s of real time. Any other ccxt error fails the read at once, as ccxt
  // threw it. The mock threw a plain Error, which no retry met: the scenario pinned the path of an error that is not a NetworkError, and
  // a fetchOHLCV without its retry passed it. Earlier, it also accepted a normal end without a row as well as any error, so it passed
  // when the candle streams' relay took the failure for the end of the pair's stream (an import that completes without its candles) or
  // lost it behind another error.
  it.each<{ fault: string; outcome: string; setFault: () => void; expected: ImportOutcome }>([
    {
      fault: 'a NetworkError on the first call, then the candles',
      outcome: 'retried, every minute imported',
      setFault: () => (MockCCXTExchange.networkErrorsToThrow = 1),
      expected: { failure: undefined, candles: expectedCandles('BTC/USDT') },
    },
    {
      fault: 'a NetworkError on every call',
      outcome: 'an ExchangeNetworkError after three retries, nothing imported',
      setFault: () => (MockCCXTExchange.shouldThrowError = true),
      expected: {
        failure: {
          name: 'ExchangeNetworkError',
          message: '[EXCHANGE] Simulated Network Error',
          cause: expect.any(MockNetworkError),
        },
        candles: [],
      },
    },
    {
      fault: 'an ExchangeError',
      outcome: 'the ExchangeError at once, nothing imported',
      setFault: () => (MockCCXTExchange.shouldThrowExchangeError = true),
      expected: { failure: { name: 'ExchangeError', message: 'Simulated Exchange Error', cause: undefined }, candles: [] },
    },
  ])(
    'Scenario D: an import whose exchange fails to serve the candles ($fault): $outcome',
    async ({ setFault, expected }) => {
      const storage = await setUpImport({ assets: ['BTC'], daterange: HOUR });
      setFault();
      const failure = await runImport();
      expect({ failure: describeFailure(failure), candles: readCandles(storage, 'BTC/USDT') }).toEqual(expected);
    },
    TIMEOUT,
  );

  it(
    'Scenario E: imports the same range twice without storing a minute twice',
    async () => {
      const storage = await setUpImport({ assets: ['BTC'], daterange: HOUR });
      const first = await runImport();
      const afterFirst = readCandles(storage, 'BTC/USDT');
      const second = await runImport();
      expect({ failures: [first, second], afterFirst, afterSecond: readCandles(storage, 'BTC/USDT') }).toEqual({
        failures: [undefined, undefined],
        afterFirst: expectedCandles('BTC/USDT'),
        afterSecond: expectedCandles('BTC/USDT'),
      });
    },
    TIMEOUT,
  );

  it(
    'Scenario F: imports a range that overlaps one imported before, the minutes they share once',
    async () => {
      // Range F1, from START to START + 30 minutes, then range F2, from START + 15 to START + 45 minutes: 46 minutes in all
      const storage = await setUpImport({ assets: ['BTC'], daterange: { start: START, end: minute(30) } });
      const first = await runImport();
      const second = await runImport({ start: minute(15), end: minute(45) });
      expect({ failures: [first, second], candles: storedCandles(storage, ['BTC']) }).toEqual({
        failures: [undefined, undefined],
        candles: { BTC: expectedCandles('BTC/USDT', { start: START, end: minute(45) }) },
      });
    },
    TIMEOUT,
  );

  // The minutes the exchange has no candle for, on the pages ccxt serves (the first candles at or after `since`): the history of a pair
  // jumps over a gap, and the gap filler meets the jump. It makes up the minutes a pair misses between two of its candles, flat at its
  // last close, in a partial gap (the other pairs trade) as in a total gap (every pair missing), and leaves out those before the pair's
  // first candle and after its last, which an import keeps missing, so that a backtest of them is refused. The minutes the exchange
  // skips at the end of the range, though it has later ones, were dropped without a word, and so were those before the first candle
  // of a pair listed during the range: the history warns about both. A pair whose
  // history ended before the range did (the last row) was filled to its end, a delisted pair for weeks, which a backtest then traded
  // on, and the import ended on a partial gap still filled "until it comes back": its last minutes stay missing, as when it is imported
  // alone. The warnings are every line logged at that level.
  const LAST_TEN = { start: minute(51), end: minute(61) };
  const trailingGap = (pair: TradingPair) =>
    [
      `[${pair}] The exchange has no candle from ${at(51)} to ${at(60)}, the end of the range, its next one being at ${at(61)}:`,
      'ending the history of this pair early, without its last 10 minutes.',
    ].join(' ');
  const FIRST_TEN = { start: START, end: minute(10) };
  const leadingGap = (pair: TradingPair) =>
    [
      `[${pair}] The exchange has no candle from ${at(0)}, the start of the range, to ${at(9)}, its first one being at ${at(10)}:`,
      'starting the history of this pair late, without its first 10 minutes.',
    ].join(' ');
  it.each<{ title: string; assets: string[]; gaps: Gap[] | Record<string, Gap[]>; candles: Record<string, Candle[]>; warnings: string[] }>([
    {
      title: 'a partial gap, ETH missing 10 minutes while BTC trades: filled',
      assets: ['BTC', 'ETH'],
      gaps: { 'ETH/USDT': [{ start: minute(25), end: minute(35) }] },
      candles: {
        BTC: expectedCandles('BTC/USDT'),
        ETH: expectedCandles('ETH/USDT', HOUR, { filled: { start: minute(25), end: minute(35) } }),
      },
      warnings: [
        `Partial gap: no ETH/USDT candle at ${at(25)}, filling with empty candles until it comes back`,
        `Partial gap closed: ETH/USDT is back at ${at(35)}, 10 minutes filled with empty candles from ${at(25)}`,
      ],
    },
    {
      title: 'a total gap, both pairs missing the same 10 minutes: filled',
      assets: ['BTC', 'ETH'],
      gaps: [{ start: minute(25), end: minute(35) }],
      candles: {
        BTC: expectedCandles('BTC/USDT', HOUR, { filled: { start: minute(25), end: minute(35) } }),
        ETH: expectedCandles('ETH/USDT', HOUR, { filled: { start: minute(25), end: minute(35) } }),
      },
      warnings: [`Total gap detected: filling 10 minutes for all assets from ${at(25)}`],
    },
    {
      title: 'a leading gap, BTC alone without the first 10 minutes of the range: not filled, warned',
      assets: ['BTC'],
      gaps: { 'BTC/USDT': [FIRST_TEN] },
      candles: { BTC: expectedCandles('BTC/USDT', HOUR, { missing: FIRST_TEN }) },
      warnings: [leadingGap('BTC/USDT')],
    },
    {
      title: 'a pair listed during the range, ETH without the first 10 minutes BTC trades: not filled, warned',
      assets: ['BTC', 'ETH'],
      gaps: { 'ETH/USDT': [FIRST_TEN] },
      candles: {
        BTC: expectedCandles('BTC/USDT'),
        ETH: expectedCandles('ETH/USDT', HOUR, { missing: FIRST_TEN }),
      },
      warnings: [leadingGap('ETH/USDT')],
    },
    {
      title: 'a trailing gap, BTC alone without the last 10 minutes of the range: not filled, warned',
      assets: ['BTC'],
      gaps: { 'BTC/USDT': [LAST_TEN] },
      candles: { BTC: expectedCandles('BTC/USDT', HOUR, { missing: LAST_TEN }) },
      warnings: [trailingGap('BTC/USDT')],
    },
    {
      title: 'a trailing gap of BTC, ETH trading to the end: not filled, warned',
      assets: ['BTC', 'ETH'],
      gaps: { 'BTC/USDT': [LAST_TEN] },
      candles: { BTC: expectedCandles('BTC/USDT', HOUR, { missing: LAST_TEN }), ETH: expectedCandles('ETH/USDT') },
      warnings: [trailingGap('BTC/USDT')],
    },
    {
      title: 'a trailing gap of both pairs: not filled, warned for each',
      assets: ['BTC', 'ETH'],
      gaps: [LAST_TEN],
      candles: {
        BTC: expectedCandles('BTC/USDT', HOUR, { missing: LAST_TEN }),
        ETH: expectedCandles('ETH/USDT', HOUR, { missing: LAST_TEN }),
      },
      warnings: [trailingGap('BTC/USDT'), trailingGap('ETH/USDT')],
    },
    {
      title: 'the history of ETH ending at minute 30 while BTC trades to the end: not filled, warned',
      assets: ['BTC', 'ETH'],
      gaps: { 'ETH/USDT': [{ start: minute(30), end: Infinity }] },
      candles: {
        BTC: expectedCandles('BTC/USDT'),
        ETH: expectedCandles('ETH/USDT', HOUR, { missing: { start: minute(30), end: Infinity } }),
      },
      warnings: [
        [
          `[ETH/USDT] The exchange returned no candle after ${at(29)}, the last minute received, although the range ends at ${at(60)}:`,
          'ending the history of this pair early, without its last 31 minutes.',
        ].join(' '),
      ],
    },
  ])(
    'Scenario G: an import of the minutes an exchange has no candle for ($title)',
    async ({ assets, gaps, candles, warnings: expectedWarnings }) => {
      const storage = await setUpImport({ assets, daterange: HOUR, gaps });
      const failure = await runImport();
      expect({ failure, candles: storedCandles(storage, assets), warnings: warnings() }).toEqual({
        failure: undefined,
        candles,
        warnings: expectedWarnings,
      });
    },
    TIMEOUT,
  );

  // A pair the exchange has no candle for over more than the gap filler fills (7 days, MAX_GAP_FILL_MINUTES) while another trades: the
  // history of the pair refuses the gap as it reads the candle after it, before the gap filler makes up any of it. Only a total gap was
  // bounded: an ETH suspended for 8 days was filled minute after minute, and the import completed with 11520 flat candles.
  it(
    'Scenario H: refuses a gap of a pair longer than the gap filler fills, before a candle of it is made up',
    async () => {
      const gap = { start: minute(1000), end: minute(1000 + 8 * 24 * 60) };
      const storage = await setUpImport({
        assets: ['BTC', 'ETH'],
        daterange: { start: START, end: minute(10 * 24 * 60) },
        gaps: { 'ETH/USDT': [gap] },
      });
      const failure = await runImport();
      // The buckets on their way to the storage when the history failed may go unwritten: what was stored is checked, not how much
      const stored = (pair: TradingPair) => {
        const candles = readCandles(storage, pair);
        return { madeUp: candles.filter(isMadeUp).length, fromTheGap: candles.filter(({ start }) => start >= gap.start).length };
      };
      expect({
        failure: describeFailure(failure),
        BTC: stored('BTC/USDT'),
        ETH: stored('ETH/USDT'),
        warnings: warnings(),
      }).toEqual({
        failure: {
          name: 'GekkoError',
          message: [
            `[STREAM] The exchange has no ETH/USDT candle from ${at(1000)} to ${at(12519)} (11520 minutes):`,
            'refusing to fill more than 10080 minutes with empty candles.',
          ].join(' '),
          cause: undefined,
        },
        BTC: { madeUp: 0, fromTheGap: 0 },
        ETH: { madeUp: 0, fromTheGap: 0 },
        warnings: [],
      });
    },
    TIMEOUT,
  );

  // An import has the last word over the candles stored, but for those it makes up: a candle it makes up for a minute the exchange
  // lacks replaces only a stored candle made up too (flat, without volume), never one that traded. The database keeps no synthetic flag:
  // the gap filler sets it, and CandleWriter and the storage carry it to the insert, which no scenario saw. A CandleWriter that dropped
  // it had the import overwrite a traded candle with a flat one, and passed every suite.
  it(
    'Scenario I: replaces the stored candles with those of the exchange, and with its own made-up candles only those made up',
    async () => {
      const storage = await setUpImport({
        assets: ['BTC'],
        daterange: HOUR,
        gaps: { 'BTC/USDT': [{ start: minute(20), end: minute(22) }] },
      });
      const traded = { start: minute(20), open: 1, high: 2, low: 0.5, close: 1.5, volume: 7 };
      const madeUp = (n: number) => ({ start: minute(n), open: 3, high: 3, low: 3, close: 3, volume: 0 });
      seedDatabaseWithCandles(storage, 'BTC/USDT', [
        traded, // The exchange lacks minute 20: the candle the import makes up for it leaves this one as it is
        madeUp(21), // Nor has it minute 21: the import's own made-up candle replaces this one
        madeUp(30), // A minute a realtime run made up, which the exchange's candle replaces
        { start: minute(40), open: 4, high: 5, low: 3, close: 4.5, volume: 9 }, // Traded, and replaced too: the import has the last word
      ]);
      const failure = await runImport();
      expect({ failure, candles: storedCandles(storage, ['BTC']) }).toEqual({
        failure: undefined,
        candles: {
          BTC: expectedCandles('BTC/USDT', HOUR, { filled: { start: minute(20), end: minute(22) } }).map(candle =>
            candle.start === traded.start ? traded : candle,
          ),
        },
      });
    },
    TIMEOUT,
  );

  // The importer stores closed minutes only: it clamps daterange.end to the last closed minute, as the exchange serves the minute in
  // progress as an unfinished candle (and Binance none after it). The clamp reads the clock when the pipeline is built, the exchange
  // each time it serves a page: on the running clock, a minute ending between the setup and the build moved both, and the end now
  // logged the clamp's line only when none did. The clock is stopped halfway through a minute instead, which makes the rows exact where
  // they were bounds. No row logs "Rejecting future bucket": without the clamp, or with a clamp one minute late, RejectFutureCandle
  // dropped the minute in progress, which the rows stored did not show.
  describe('on a clock stopped at 2023-11-20T12:00:30.000Z', () => {
    const NOW = Date.UTC(2023, 10, 20, 12, 0, 30);
    const LAST_CLOSED_MINUTE = Date.UTC(2023, 10, 20, 11, 59);
    const SINCE = LAST_CLOSED_MINUTE - 30 * ONE_MINUTE;
    const clamp = (end: string) =>
      `daterange.end ${end} is not a closed minute yet: importing up to the last closed minute, 2023-11-20T11:59:00.000Z.`;

    beforeEach(() => {
      setSystemTime(NOW);
    });

    afterEach(() => {
      setSystemTime();
    });

    it.each<{ title: string; daterange: Range; candles: Candle[]; warnings: string[] }>([
      {
        title: 'daterange.end now: the candle in progress is not imported',
        daterange: { start: SINCE, end: NOW },
        candles: expectedCandles('BTC/USDT', { start: SINCE, end: LAST_CLOSED_MINUTE }),
        warnings: [clamp('2023-11-20T12:00:30.000Z')],
      },
      {
        title: 'daterange.end in the future: the import stops at the last closed minute',
        daterange: { start: SINCE, end: NOW + 30 * ONE_MINUTE },
        candles: expectedCandles('BTC/USDT', { start: SINCE, end: LAST_CLOSED_MINUTE }),
        warnings: [clamp('2023-11-20T12:30:30.000Z')],
      },
      {
        title: 'the whole daterange in the future: nothing to import, the import completes',
        daterange: { start: NOW + 60 * ONE_MINUTE, end: NOW + 120 * ONE_MINUTE },
        candles: [],
        warnings: [clamp('2023-11-20T14:00:30.000Z')],
      },
    ])(
      'Scenario J: an import up to the minute in progress or after it ($title)',
      async ({ daterange, candles, warnings: expectedWarnings }) => {
        const storage = await setUpImport({ assets: ['BTC'], daterange });
        const failure = await runImport();
        expect({ failure, candles: readCandles(storage, 'BTC/USDT'), warnings: warnings() }).toEqual({
          failure: undefined,
          candles,
          warnings: expectedWarnings,
        });
      },
      TIMEOUT,
    );
  });
});
