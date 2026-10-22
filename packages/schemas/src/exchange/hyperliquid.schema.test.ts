import { configurationSchema } from '../configuration/configuration.schema';
import { CORE_SCHEMA, load } from 'js-yaml';
import JSON5 from 'json5';
import { describe, expect, it } from 'vitest';
import { hyperliquidExchangeSchema } from './hyperliquid.schema';

const PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const WALLET_ADDRESS = `0x${'22'.repeat(20)}`;

const DEFAULTS = { name: 'hyperliquid', exchangeSynchInterval: 600_000, orderSynchInterval: 20_000, sandbox: false, verbose: false };

const PAIR_MESSAGE = 'walletAddress is required with privateKey, which signs the orders of the account at that address';
const unquotedMessage = (field: string) => `${field} must be written in quotes ('0x…'): unquoted, 0x… is read as a hexadecimal number`;

/** The exchange section as the configuration loader reads it from a YAML file */
const fromYaml = (...lines: string[]) => load(['name: hyperliquid', ...lines].join('\n'), { schema: CORE_SCHEMA });

describe('hyperliquidExchangeSchema', () => {
  // An import reads the markets and the candles through the public client alone: with the keys required, importing candles had a
  // reader write a wallet's private key into a configuration file. The address alone reads the account, without trading.
  it.each`
    scenario                                               | exchange                                                                           | keys
    ${'no key, all an import needs'}                       | ${{ name: 'hyperliquid' }}                                                         | ${{}}
    ${'the wallet address alone, which reads the account'} | ${{ name: 'hyperliquid', walletAddress: WALLET_ADDRESS }}                          | ${{ walletAddress: WALLET_ADDRESS }}
    ${'both keys'}                                         | ${{ name: 'hyperliquid', privateKey: PRIVATE_KEY, walletAddress: WALLET_ADDRESS }} | ${{ privateKey: PRIVATE_KEY, walletAddress: WALLET_ADDRESS }}
    ${'both keys quoted in YAML'}                          | ${fromYaml(`privateKey: '${PRIVATE_KEY}'`, `walletAddress: '${WALLET_ADDRESS}'`)}  | ${{ privateKey: PRIVATE_KEY, walletAddress: WALLET_ADDRESS }}
  `('accepts $scenario, keeping the keys as written', ({ exchange, keys }) => {
    expect(hyperliquidExchangeSchema.parse(exchange)).toEqual({ ...DEFAULTS, ...keys });
  });

  // ccxt reads the account by its address and refuses an order without one: the key alone serves no call
  it('refuses a private key without its wallet address, in one issue at walletAddress naming both keys', () => {
    const result = hyperliquidExchangeSchema.safeParse({ name: 'hyperliquid', privateKey: PRIVATE_KEY });
    expect(result.error?.issues).toMatchObject([{ path: ['walletAddress'], message: PAIR_MESSAGE }]);
  });

  // Refused with "expected string, received number" alone, which did not say what to change
  it.each`
    scenario                               | exchange                                                                                                  | field
    ${'a private key unquoted in YAML'}    | ${fromYaml(`privateKey: ${PRIVATE_KEY}`, `walletAddress: '${WALLET_ADDRESS}'`)}                           | ${'privateKey'}
    ${'a wallet address unquoted in YAML'} | ${fromYaml(`walletAddress: ${WALLET_ADDRESS}`)}                                                           | ${'walletAddress'}
    ${'a private key unquoted in JSON5'}   | ${JSON5.parse(`{ name: 'hyperliquid', privateKey: ${PRIVATE_KEY}, walletAddress: '${WALLET_ADDRESS}' }`)} | ${'privateKey'}
  `('refuses $scenario, read as a number, with a message saying to quote it', ({ exchange, field }) => {
    const result = hyperliquidExchangeSchema.safeParse(exchange);
    expect(result.error?.issues).toMatchObject([{ path: [field], message: unquotedMessage(field) }]);
  });

  it('keeps the type message for a key left empty in YAML, a null that quotes would not fix', () => {
    const result = hyperliquidExchangeSchema.safeParse(fromYaml('privateKey:', `walletAddress: '${WALLET_ADDRESS}'`));
    expect(result.error?.issues).toMatchObject([{ path: ['privateKey'], message: 'Invalid input: expected string, received null' }]);
  });

  it.each`
    field              | exchange
    ${'privateKey'}    | ${{ name: 'hyperliquid', privateKey: '11'.repeat(32), walletAddress: WALLET_ADDRESS }}
    ${'walletAddress'} | ${{ name: 'hyperliquid', walletAddress: '22'.repeat(20) }}
  `('refuses a $field without its 0x prefix', ({ field, exchange }) => {
    const result = hyperliquidExchangeSchema.safeParse(exchange);
    expect(result.error?.issues).toMatchObject([{ path: [field], code: 'invalid_format', prefix: '0x' }]);
  });
});

// The configuration reads the exchange section through a union discriminated by name, which keeps the checks of its options
describe('a hyperliquid exchange section in the configuration', () => {
  const createImporterConfig = (exchange: Record<string, unknown>) => ({
    watch: { assets: ['UBTC'], currency: 'USDC', mode: 'importer', daterange: { start: '2024-01-01', end: '2024-01-02' } },
    exchange,
    storage: { type: 'sqlite', database: 'db/hyperliquid.sql' },
    plugins: [{ name: 'CandleWriter' }],
  });

  it('accepts an import without keys', () => {
    expect(configurationSchema.safeParse(createImporterConfig({ name: 'hyperliquid' })).error).toBeUndefined();
  });

  it('refuses a private key without its wallet address at exchange.walletAddress', () => {
    const result = configurationSchema.safeParse(createImporterConfig({ name: 'hyperliquid', privateKey: PRIVATE_KEY }));
    expect(result.error?.issues).toMatchObject([{ path: ['exchange', 'walletAddress'], message: PAIR_MESSAGE }]);
  });
});
