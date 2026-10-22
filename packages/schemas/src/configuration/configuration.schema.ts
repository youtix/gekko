import { ONE_MINUTE, ONE_SECOND } from '@gekko/shared/constants/time.const';
import { TIMEFRAME_TO_MINUTES } from '@gekko/shared/constants/timeframe.const';
import { assetsSchema, currencySchema } from './pairConfig.schema';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { CandleSize } from '@gekko/shared/models/candleSize.types';
import { binanceExchangeSchema } from '../exchange/binance.schema';
import { dummyExchangeSchema } from '../exchange/dummyCentralizedExchange.schema';
import { hyperliquidExchangeSchema } from '../exchange/hyperliquid.schema';
import { paperBinanceExchangeSchema } from '../exchange/paperTradingBinanceExchange.schema';
import { getCandleStart, getCandleTimeOffset } from '@gekko/shared/helpers/candle/candle.helper';
import { startOfMinuteUTC, toISOString, toTimestamp } from '@gekko/shared/utils/date/date.utils';
import { difference, find, some } from 'lodash-es';
import { z } from 'zod';
import { TIMEFRAMES } from './configuration.const';

const disclaimerField = 'I understand that Gekko only automates MY OWN trading strategies' as const;

/**
 * A bound of watch.daterange, as text: a day, from its midnight UTC (2024-01-01), or a day and a time with Z or an offset
 * (2024-01-01T00:00:00Z, 2024-01-01T02:00:00+02:00). zod's ISO patterns check it against the calendar before Date reads it: Date rolls
 * a day that does not exist over (2023-02-29 to March 1st, 24:00 to the next day), as js-yaml did with an unquoted one until the loader
 * kept YAML timestamps as text, so a range written with such a day ran from another one, without a word.
 */
const ISO_DAY_PATTERN = z.regexes.date;
const ISO_DATETIME_PATTERN = z.regexes.datetime({ offset: true });

const dateBoundSchema = (bound: 'start' | 'end') =>
  z.string().refine(value => ISO_DAY_PATTERN.test(value) || ISO_DATETIME_PATTERN.test(value), {
    error: ({ input }) =>
      `watch.daterange.${bound} '${input}' must be a date that exists, in ISO 8601: a day (2024-01-01, from its midnight UTC), or a day and a time with Z or an offset (2024-01-01T00:00:00Z, 2024-01-01T02:00:00+02:00)`,
  });

/**
 * Both bounds are included, each read as the minute holding it (the backtest reader, the importer): equal bounds are a one-minute
 * range, and an end earlier in the minute of the start reads that minute. Checked in milliseconds once the configuration was loaded,
 * the range of a one-minute re-import was refused, with a message in epoch milliseconds.
 */
const daterangeSchema = z
  .strictObject({
    start: dateBoundSchema('start'),
    end: dateBoundSchema('end'),
  })
  .transform(({ start, end }) => ({ start: toTimestamp(start), end: toTimestamp(end) }))
  .superRefine(({ start, end }, ctx) => {
    if (startOfMinuteUTC(end) < startOfMinuteUTC(start)) {
      ctx.addIssue({
        code: 'custom',
        message: `watch.daterange must end in the minute of its start or later: it starts at ${toISOString(start)} and ends at ${toISOString(end)}`,
      });
    }
  });

// tickrate and warmup.tickrate space the requests of a history download (the importer's, the realtime warmup's): the least delay,
// in ms, between the starts of two of them
const MIN_TICKRATE = 100;

const integerAtLeast = (field: string, min: number) => {
  const message = `${field} must be an integer of at least ${min}`;
  return z.number(message).int(message).min(min, message);
};

const integerBetween = (field: string, min: number, max: number, reason: string) => {
  const message = `${field} must be an integer between ${min} and ${max} (${reason})`;
  return z.number(message).int(message).min(min, message).max(max, message);
};

// A backtest reads each batch of candles into memory at once, for every pair: 31 days of 1-minute candles is ample.
const MAX_BATCH_SIZE = 31 * 24 * 60;

const warmupSchema = z
  .strictObject({
    tickrate: integerAtLeast('warmup.tickrate', MIN_TICKRATE).default(ONE_SECOND),
    candleCount: integerAtLeast('warmup.candleCount', 0).default(0),
  })
  .default({ tickrate: ONE_SECOND, candleCount: 0 });

export const watchSchema = z
  .strictObject({
    assets: assetsSchema,
    currency: currencySchema,
    timeframe: z.enum(TIMEFRAMES).optional(),
    tickrate: integerAtLeast('tickrate', MIN_TICKRATE).default(ONE_SECOND),
    mode: z.enum(['realtime', 'backtest', 'importer']),
    warmup: warmupSchema,
    daterange: daterangeSchema.optional(),
    batchSize: integerBetween(
      'batchSize',
      1,
      MAX_BATCH_SIZE,
      'minutes, 31 days at most: each batch is read into memory at once',
    ).optional(),
  })
  .transform(data => ({
    ...data,
    pairs: data.assets.map(asset => ({
      symbol: `${asset}/${data.currency}` as TradingPair,
    })),
  }))
  .superRefine((data, ctx) => {
    if (data.assets.includes(data.currency)) {
      ctx.addIssue({ code: 'custom', path: ['assets'], message: `assets must not contain the currency (${data.currency})` });
    }
  })
  .superRefine((data, ctx) => {
    const requiresDaterange = data.mode === 'importer' || data.mode === 'backtest';
    if (requiresDaterange && !data.daterange) {
      ctx.addIssue({
        code: 'custom',
        path: ['daterange'],
        message: 'daterange is required for importer and backtest modes',
      });
    }
  })
  .superRefine((data, ctx) => {
    if (data.mode !== 'importer' && !data.timeframe) {
      ctx.addIssue({
        code: 'custom',
        path: ['timeframe'],
        message: 'timeframe is required for backtest and realtime modes',
      });
    }
  });

/**
 * The timeframe candles a backtest of `daterange` hands the strategy, as the candle batcher makes them from the minutes the backtest
 * reads (from the minute of `start` to that of `end`, both included): the minutes before the first timeframe boundary are skipped, and
 * the candle the end of the range cuts is never completed. `endOfCandle(n)` is the end of the n-th candle, the start of the next one.
 */
const getBacktestCandles = (candleSize: CandleSize, { start, end }: { start: EpochTimeStamp; end: EpochTimeStamp }) => {
  const firstMinute = startOfMinuteUTC(start);
  const endOfRange = startOfMinuteUTC(end) + ONE_MINUTE;
  const firstCandleStart = getCandleTimeOffset(candleSize, firstMinute) ? getCandleStart(candleSize, firstMinute, -1) : firstMinute;
  const endOfCandle = (count: number) => getCandleStart(candleSize, firstCandleStart, -count);
  // Counted at the nominal length of a candle, then moved to the calendar: exact already but for the candles of whole months, whose
  // length varies (a 1M candle lasts 28 to 31 days, not 30)
  let count = Math.max(0, Math.floor((endOfRange - firstCandleStart) / (candleSize * ONE_MINUTE)));
  while (count > 0 && endOfCandle(count) > endOfRange) count--;
  while (endOfCandle(count + 1) <= endOfRange) count++;
  return { firstCandleStart, count, endOfCandle };
};

// Storage holds insertThreshold minutes of candles in memory (about 1.6 KB a minute for 5 pairs), then writes them in one
// synchronous transaction per pair, which blocks the event loop (with 5 pairs: 0.1 s for a day, 0.6 to 1.2 s for a week), and a
// process killed before the storage is closed (SIGKILL, a power cut) loses all it holds. A day is the most, above the importer's
// default of 1000.
const MAX_INSERT_THRESHOLD = 24 * 60;

export const storageSchema = z.strictObject({
  type: z.literal('sqlite'),
  // Bun opens an in-memory database for an empty path: the candles would be lost on exit, without a word
  database: z.string().trim().min(1, 'storage.database must not be empty'),
  insertThreshold: integerBetween(
    'storage.insertThreshold',
    1,
    MAX_INSERT_THRESHOLD,
    'minutes, a day at most: the candles are held in memory until they are written',
  ).optional(),
});

export const configurationSchema = z
  .strictObject({
    showLogo: z.boolean().default(true),
    watch: watchSchema,
    exchange: z.discriminatedUnion('name', [
      dummyExchangeSchema,
      binanceExchangeSchema,
      hyperliquidExchangeSchema,
      paperBinanceExchangeSchema,
    ]),
    storage: storageSchema.nullable().optional().default(null),
    // Loose on purpose, unlike the rest of the configuration: the pipeline parses each plugin entry again with the strict schema
    // of the plugin its name selects, and the StrategyManager parses the strategy block, without its name, with the schema of the
    // strategy class strategyName selects. Every built-in strategy declares one; a class without one gets the block unchecked.
    plugins: z.array(z.looseObject({ name: z.string() })),
    strategy: z.looseObject({ name: z.string() }).optional(),
    [disclaimerField]: z.boolean().nullable().default(null),
  })
  .superRefine((data, ctx) => {
    // Zod also runs this refinement after a non-aborting issue in a section (a failed refine or bound), with the transforms that
    // build watch.pairs and the marketData Map skipped. Counted before the rules below add issues of their own.
    const hasSectionIssues = ctx.issues.length > 0;

    // Checked here rather than when the storage is first used: the backtest reads its candles from it at once, but a
    // CandleWriter would only need it after the markets are loaded from the exchange.
    const hasCandleWriter = some(data.plugins, { name: 'CandleWriter' });
    if (!data.storage && (data.watch.mode === 'backtest' || hasCandleWriter)) {
      ctx.addIssue({
        code: 'custom',
        path: ['storage'],
        message: `storage is required ${data.watch.mode === 'backtest' ? 'in backtest mode, which reads the candles from it' : 'by the CandleWriter plugin, which writes the candles to it'}`,
      });
    }

    // Only the simulator fills orders from replayed candles: any other exchange, sandbox included, would receive the
    // backtest's orders. The importer needs a real exchange to download candles from.
    const exchangesByMode: Record<typeof data.watch.mode, Array<typeof data.exchange.name>> = {
      backtest: ['dummy-cex'],
      importer: ['binance', 'hyperliquid'],
      realtime: ['binance', 'hyperliquid', 'paper-binance'],
    };
    const allowedExchanges = exchangesByMode[data.watch.mode];
    if (!allowedExchanges.includes(data.exchange.name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['exchange', 'name'],
        message: `Exchange ${data.exchange.name} cannot be used in ${data.watch.mode} mode (allowed: ${allowedExchanges.join(', ')})`,
      });
    }

    // Disclaimer validation for real exchanges (exclude dummy-cex and paper-binance)
    const hasTraderPlugin = some(data.plugins, plugin => plugin.name?.toLowerCase() === 'trader');
    const isSimulatedExchange = data.exchange.name === 'dummy-cex' || data.exchange.name === 'paper-binance';
    const isUsingRealExchange = data.exchange && !isSimulatedExchange && !('sandbox' in data.exchange && data.exchange.sandbox);
    const isDisclaimerIgnored = !data[disclaimerField];
    // The message names the key and where it goes: it sent the reader to a "settings app" Gekko does not have, and the exchange
    // section, where the key would seem to belong, refuses it as an unrecognized key
    if (hasTraderPlugin && isUsingRealExchange && isDisclaimerIgnored) {
      ctx.addIssue({
        code: 'custom',
        path: [disclaimerField],
        message: `These settings enable Trader with a real exchange and may spend real money, leading to severe losses. Confirm by setting '${disclaimerField}': true at the top level of the configuration file.`,
      });
    }

    // Hyperliquid's keys are optional, an import reading the public client alone, but a realtime TradingAdvisor reads the open orders
    // and the balance of the account at walletAddress at start-up, and the Trader reads them too and signs its orders with privateKey.
    // Without the address, the run would stop at start-up on ccxt's ArgumentsRequired; without the key, ccxt would refuse every order
    // until the circuit breaker stopped the run. Like the marketData rule, it only checks a configuration whose sections have no issue:
    // a privateKey without walletAddress is already refused in the exchange section.
    if (data.exchange.name === 'hyperliquid' && data.watch.mode === 'realtime' && !hasSectionIssues) {
      const { privateKey, walletAddress } = data.exchange;
      const hasTradingAdvisor = some(data.plugins, { name: 'TradingAdvisor' });
      if (walletAddress === undefined && (hasTraderPlugin || hasTradingAdvisor)) {
        ctx.addIssue({
          code: 'custom',
          path: ['exchange', 'walletAddress'],
          message: `walletAddress is required by the ${hasTraderPlugin ? 'Trader' : 'TradingAdvisor'}, which reads the balance and the orders of the account at that address`,
        });
      }
      if (privateKey === undefined && hasTraderPlugin) {
        ctx.addIssue({
          code: 'custom',
          path: ['exchange', 'privateKey'],
          message: 'privateKey is required by the Trader, which signs its orders with it',
        });
      }
    }

    // marketData is dummy-cex's only source of fees and order limits, looked up by exact symbol: a watched pair without an
    // entry would trade free of both, and an entry for any other symbol (a typo, a swapped asset) would never be read.
    // The rule reads watch.pairs and the marketData Map, so it only checks a configuration whose sections have no issue.
    if (data.exchange.name === 'dummy-cex' && !hasSectionIssues) {
      const watchedSymbols = data.watch.pairs.map(({ symbol }) => symbol);
      const marketDataSymbols = [...data.exchange.marketData.keys()];
      const missingSymbols = difference(watchedSymbols, marketDataSymbols);
      const unwatchedSymbols = difference(marketDataSymbols, watchedSymbols);
      if (missingSymbols.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['exchange', 'marketData'],
          message: `Each watched pair needs a marketData entry, or dummy-cex fills its orders with no fees and no order limits (missing: ${missingSymbols.join(', ')})`,
        });
      }
      if (unwatchedSymbols.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['exchange', 'marketData'],
          message: `Each marketData symbol must match a watched pair (not watched: ${unwatchedSymbols.join(', ')})`,
        });
      }
    }

    // The simulator holds the asset and the currency of each watched pair, nothing else (initializePortfolio), and dropped the balance
    // of any other asset without a word: `usdt` for USDT started a backtest without its currency, its BUYs refused until the circuit
    // breaker stopped it, and `btc` for BTC ran it from the currency alone. The rule reads the simulationBalance Map, so like the
    // marketData rule it only checks a configuration whose sections have no issue, a repeated asset among them: the Map then holds the
    // entries of the list in its order, one each, and the index of a key is that of its entry.
    if ('simulationBalance' in data.exchange && !hasSectionIssues) {
      const watchedAssets = [...data.watch.assets, data.watch.currency];
      [...data.exchange.simulationBalance.keys()].forEach((assetName, index) => {
        if (!watchedAssets.includes(assetName)) {
          ctx.addIssue({
            code: 'custom',
            path: ['exchange', 'simulationBalance', index, 'assetName'],
            message: `simulationBalance assetName '${assetName}' must name a watched asset or the currency (${watchedAssets.join(', ')}), the only balances the simulator holds`,
          });
        }
      });
    }

    // strategyName selects the strategy class, strategy.name only labels the run (backtest log, PerformanceReporter rows): a
    // strategy block left over from another strategy would file the results under that strategy's name. Plugin entries are
    // loose objects, so a strategyName that is not a string is left to the TradingAdvisor schema, applied by the pipeline.
    const strategyName = find(data.plugins, { name: 'TradingAdvisor' })?.strategyName;
    if (typeof strategyName === 'string' && data.strategy && data.strategy.name !== strategyName) {
      ctx.addIssue({
        code: 'custom',
        path: ['strategy', 'name'],
        message: `strategy.name '${data.strategy.name}' must equal the TradingAdvisor strategyName '${strategyName}', which selects the strategy class`,
      });
    }

    // The warmup takes warmup.candleCount timeframe candles and the strategy trades from the next one: a backtest whose range held no
    // more ended normally without a trade, its reports empty and nothing naming the warmup. Like the marketData rule, it only checks a
    // configuration whose sections have no issue: zod leaves a range with an issue as written, not in epoch milliseconds.
    const { mode, timeframe, daterange, warmup } = data.watch;
    if (mode === 'backtest' && some(data.plugins, { name: 'TradingAdvisor' }) && timeframe && daterange && !hasSectionIssues) {
      const { firstCandleStart, count, endOfCandle } = getBacktestCandles(TIMEFRAME_TO_MINUTES[timeframe], daterange);
      if (count <= warmup.candleCount) {
        const lastMinuteNeeded = endOfCandle(warmup.candleCount + 1) - ONE_MINUTE;
        ctx.addIssue({
          code: 'custom',
          path: ['watch', 'daterange'],
          message: `watch.daterange must hold more whole ${timeframe} candles than warmup.candleCount (${warmup.candleCount}), or the warmup never ends and the strategy never trades: it holds ${count} from ${toISOString(firstCandleStart)}, its first ${timeframe} boundary, so it must end at ${toISOString(lastMinuteNeeded)} or later`,
        });
      }
    }
  });
