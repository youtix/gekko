import { describe, expect, it } from 'vitest';
import { binanceExchangeSchema } from './binance.schema';

const DEFAULTS = { name: 'binance', exchangeSynchInterval: 600_000, orderSynchInterval: 20_000, sandbox: false, verbose: false };
const PROXY_MESSAGE = 'Proxy must be a valid URL (http://, https://, or socks5://)';

describe('binanceExchangeSchema', () => {
  // The keys are optional: an import reads the markets and the candles through the public client alone
  it.each`
    scenario                                    | exchange                                                                         | expected
    ${'no key, all an import needs'}            | ${{ name: 'binance' }}                                                           | ${DEFAULTS}
    ${'the keys of an account, on the testnet'} | ${{ name: 'binance', apiKey: 'key', secret: 'secret', sandbox: true }}           | ${{ ...DEFAULTS, apiKey: 'key', secret: 'secret', sandbox: true }}
    ${"ccxt's requests logged"}                 | ${{ name: 'binance', verbose: true }}                                            | ${{ ...DEFAULTS, verbose: true }}
    ${'polling periods of their own'}           | ${{ name: 'binance', exchangeSynchInterval: 60_000, orderSynchInterval: 5_000 }} | ${{ ...DEFAULTS, exchangeSynchInterval: 60_000, orderSynchInterval: 5_000 }}
  `('accepts $scenario', ({ exchange, expected }) => {
    expect(binanceExchangeSchema.parse(exchange)).toEqual(expected);
  });

  it.each`
    proxy
    ${'http://127.0.0.1:8080'}
    ${'https://user:password@proxy.example.com:3128'}
    ${'socks5://127.0.0.1:1080'}
  `('accepts the proxy $proxy', ({ proxy }) => {
    expect(binanceExchangeSchema.parse({ name: 'binance', proxy }).proxy).toBe(proxy);
  });

  it.each`
    scenario                         | proxy
    ${'a protocol ccxt cannot use'}  | ${'ftp://proxy.example.com:21'}
    ${'a host without its protocol'} | ${'proxy.example.com:8080'}
    ${'a protocol alone'}            | ${'http://'}
  `('refuses $scenario as proxy', ({ proxy }) => {
    expect(binanceExchangeSchema.safeParse({ name: 'binance', proxy }).error?.issues).toMatchObject([
      { path: ['proxy'], message: PROXY_MESSAGE },
    ]);
  });

  // The strictness of exchangeSchema carries over: dropped, a misspelt sandbox would send the orders of a test to the real exchange
  it.each`
    scenario                               | exchange                                                | path           | message
    ${'a misspelt sandbox (sandobx)'}      | ${{ name: 'binance', sandobx: true }}                   | ${[]}          | ${'Unrecognized key: "sandobx"'}
    ${'key, the former name of apiKey'}    | ${{ name: 'binance', key: 'key', secret: 'secret' }}    | ${[]}          | ${'Unrecognized key: "key"'}
    ${'a key of Hyperliquid (privateKey)'} | ${{ name: 'binance', privateKey: '0x11' }}              | ${[]}          | ${'Unrecognized key: "privateKey"'}
    ${'another name'}                      | ${{ name: 'Binance' }}                                  | ${['name']}    | ${'Invalid input: expected "binance"'}
    ${'a sandbox given as a text'}         | ${{ name: 'binance', sandbox: 'true' }}                 | ${['sandbox']} | ${'Invalid input: expected boolean, received string'}
    ${'an apiKey read as a number'}        | ${{ name: 'binance', apiKey: 12345, secret: 'secret' }} | ${['apiKey']}  | ${'Invalid input: expected string, received number'}
    ${'a secret left empty in YAML'}       | ${{ name: 'binance', apiKey: 'key', secret: null }}     | ${['secret']}  | ${'Invalid input: expected string, received null'}
  `('refuses $scenario', ({ exchange, path, message }) => {
    expect(binanceExchangeSchema.safeParse(exchange).error?.issues).toMatchObject([{ path, message }]);
  });
});
