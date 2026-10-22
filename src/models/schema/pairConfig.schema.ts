import { MAX_WATCHED_ASSETS } from '@constants/watch.const';
import { TradingPair } from '@models/utility.types';
import { keepDuplicates } from '@utils/collection/array.utils';
import { z } from 'zod';

/**
 * An asset or a currency as ccxt names it: the exchange's code upper-cased, so Latin capitals and digits (BTC, 1INCH), or letters of
 * a script without case (a Chinese name). Lower case is refused rather than read as its capitals: the storage upper-cases the table
 * names, so the pairs of BTC and btc read the one table of BTC. Whitespace and every other character are refused too: ccxt knows no
 * such market, and an initialTicker entry for a malformed symbol was never read, without a word.
 */
const TICKER_PATTERN = /^[A-Z0-9\p{Lo}]+$/u;
const SYMBOL_PATTERN = /^[A-Z0-9\p{Lo}]+\/[A-Z0-9\p{Lo}]+$/u;

/** The last check only runs its pattern on a name neither empty nor split by a slash, which have their own message: one issue each */
const tickerSchema = (name: 'Asset' | 'Currency') =>
  z
    .string()
    .min(1, `${name} must not be empty`)
    .refine(ticker => !ticker.includes('/'), `${name} must not contain a slash`)
    .refine(ticker => !ticker || ticker.includes('/') || TICKER_PATTERN.test(ticker), {
      error: ({ input }) => `${name} '${input}' must be written in upper-case letters and digits, as in BTC or 1INCH`,
    });

export const symbolSchema = z
  .string()
  .refine(symbol => symbol.includes('/'), 'Symbol must contain a slash')
  .refine(symbol => !symbol.includes('/') || SYMBOL_PATTERN.test(symbol), {
    error: ({ input }) =>
      `Symbol '${input}' must be an asset and a currency in upper-case letters and digits, joined by one slash, as in BTC/USDT`,
  })
  .transform(symbol => symbol as TradingPair);

export const currencySchema = tickerSchema('Currency');

export const assetsSchema = z
  .array(tickerSchema('Asset'))
  .min(1, 'At least one asset is required')
  .max(MAX_WATCHED_ASSETS, `Maximum ${MAX_WATCHED_ASSETS} assets allowed`)
  .superRefine((assets, ctx) => {
    const repeatedAssets = keepDuplicates(assets);
    if (repeatedAssets.length) {
      ctx.addIssue({ code: 'custom', message: `assets must not contain duplicates (repeated: ${repeatedAssets.join(', ')})` });
    }
  });
