import { MAX_WATCHED_ASSETS } from '@gekko/shared/constants/watch.const';
import { range } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { assetsSchema, currencySchema, symbolSchema } from './pairConfig.schema';

const symbolMessage = (symbol: string) =>
  `Symbol '${symbol}' must be an asset and a currency in upper-case letters and digits, joined by one slash, as in BTC/USDT`;
const tickerMessage = (name: 'Asset' | 'Currency', ticker: string) =>
  `${name} '${ticker}' must be written in upper-case letters and digits, as in BTC or 1INCH`;
/** That many distinct assets, A1 to An */
const tickers = (count: number) => range(1, count + 1).map(n => `A${n}`);

describe('symbolSchema', () => {
  it.each`
    scenario                                     | symbol
    ${'a pair'}                                  | ${'BTC/USDT'}
    ${'an asset starting with a digit'}          | ${'1INCH/USDT'}
    ${'an asset with digits and letters'}        | ${'1000SATS/USDC'}
    ${'an asset named in a script with no case'} | ${'币安人生/USDT'}
  `('accepts $scenario, $symbol', ({ symbol }) => {
    expect(symbolSchema.parse(symbol)).toBe(symbol);
  });

  it.each`
    scenario                | symbol
    ${'no slash'}           | ${'BTCUSDT'}
    ${'an empty symbol'}    | ${''}
    ${'a dash for a slash'} | ${'BTC-USDT'}
  `('refuses $scenario as a symbol without a slash', ({ symbol }) => {
    expect(symbolSchema.safeParse(symbol).error?.issues).toMatchObject([{ path: [], message: 'Symbol must contain a slash' }]);
  });

  // ccxt names a spot market BASE/QUOTE, both upper-cased: any other shape is a market no exchange has, or one read under another name
  it.each`
    scenario                                | symbol
    ${'no currency'}                        | ${'BTC/'}
    ${'no asset'}                           | ${'/USDT'}
    ${'a slash alone'}                      | ${'/'}
    ${'three parts'}                        | ${'A/B/C'}
    ${'a doubled slash'}                    | ${'BTC//USDT'}
    ${'a leading space'}                    | ${' BTC/USDT'}
    ${'a trailing space'}                   | ${'BTC/USDT '}
    ${'spaces around the slash'}            | ${'BTC / USDT'}
    ${'lower case'}                         | ${'btc/usdt'}
    ${'mixed case'}                         | ${'Btc/USDT'}
    ${'full-width capitals'}                | ${'ＢＴＣ/USDT'}
    ${'the settle currency of a perpetual'} | ${'BTC/USDC:USDC'}
  `('refuses $scenario, $symbol, naming the shape it expects', ({ symbol }) => {
    expect(symbolSchema.safeParse(symbol).error?.issues).toMatchObject([{ path: [], message: symbolMessage(symbol) }]);
  });

  it.each`
    type                          | symbol
    ${'a number'}                 | ${1000}
    ${'a boolean'}                | ${true}
    ${'an object'}                | ${{ base: 'BTC', quote: 'USDT' }}
    ${'an array holding a slash'} | ${['/']}
    ${'null'}                     | ${null}
    ${'nothing'}                  | ${undefined}
  `('reports a symbol given as $type as a type issue instead of throwing', ({ symbol }) => {
    expect(symbolSchema.safeParse(symbol).error?.issues).toMatchObject([{ path: [], code: 'invalid_type' }]);
  });
});

describe('currencySchema', () => {
  it.each`
    currency
    ${'USDT'}
    ${'USDC'}
    ${'FDUSD'}
  `('accepts $currency', ({ currency }) => {
    expect(currencySchema.parse(currency)).toBe(currency);
  });

  it.each`
    scenario               | currency      | message
    ${'an empty currency'} | ${''}         | ${'Currency must not be empty'}
    ${'a pair'}            | ${'BTC/USDT'} | ${'Currency must not contain a slash'}
    ${'lower case'}        | ${'usdt'}     | ${tickerMessage('Currency', 'usdt')}
    ${'a trailing space'}  | ${'USDT '}    | ${tickerMessage('Currency', 'USDT ')}
    ${'a dash'}            | ${'USD-T'}    | ${tickerMessage('Currency', 'USD-T')}
  `('refuses $scenario with $message as its only issue', ({ currency, message }) => {
    expect(currencySchema.safeParse(currency).error?.issues).toMatchObject([{ path: [], message }]);
  });
});

describe('assetsSchema', () => {
  it.each`
    scenario                                            | assets
    ${'one asset'}                                      | ${['BTC']}
    ${'two assets'}                                     | ${['BTC', 'ETH']}
    ${`${MAX_WATCHED_ASSETS} assets, the most allowed`} | ${tickers(MAX_WATCHED_ASSETS)}
    ${'assets starting with a digit'}                   | ${['1INCH', '1000SATS']}
  `('accepts $scenario', ({ assets }) => {
    expect(assetsSchema.parse(assets)).toEqual(assets);
  });

  // Accepted, a lower-case asset would read the candles of its capitals: the storage upper-cases the table names
  it.each`
    scenario                                             | assets                                 | issue
    ${'no asset'}                                        | ${[]}                                  | ${{ path: [], message: 'At least one asset is required' }}
    ${`${MAX_WATCHED_ASSETS + 1} assets, reported once`} | ${tickers(MAX_WATCHED_ASSETS + 1)}     | ${{ path: [], message: `Maximum ${MAX_WATCHED_ASSETS} assets allowed` }}
    ${'an empty asset'}                                  | ${['']}                                | ${{ path: [0], message: 'Asset must not be empty' }}
    ${'a pair for an asset'}                             | ${['BTC/USDT']}                        | ${{ path: [0], message: 'Asset must not contain a slash' }}
    ${'a blank asset'}                                   | ${[' ']}                               | ${{ path: [0], message: tickerMessage('Asset', ' ') }}
    ${'a tab'}                                           | ${['\t']}                              | ${{ path: [0], message: tickerMessage('Asset', '\t') }}
    ${'a trailing space'}                                | ${['BTC ']}                            | ${{ path: [0], message: tickerMessage('Asset', 'BTC ') }}
    ${'a lower-case asset'}                              | ${['btc']}                             | ${{ path: [0], message: tickerMessage('Asset', 'btc') }}
    ${'btc beside BTC'}                                  | ${['BTC', 'btc']}                      | ${{ path: [1], message: tickerMessage('Asset', 'btc') }}
    ${'a numeric asset'}                                 | ${['BTC', 1000]}                       | ${{ path: [1], code: 'invalid_type' }}
    ${'a duplicated asset'}                              | ${['BTC', 'ETH', 'BTC']}               | ${{ path: [], message: 'assets must not contain duplicates (repeated: BTC)' }}
    ${'duplicated assets, in the order they repeat'}     | ${['BTC', 'ETH', 'ETH', 'BTC', 'BTC']} | ${{ path: [], message: 'assets must not contain duplicates (repeated: ETH, BTC)' }}
  `('reports $scenario as its only issue', ({ assets, issue }) => {
    expect(assetsSchema.safeParse(assets).error?.issues).toMatchObject([issue]);
  });
});
