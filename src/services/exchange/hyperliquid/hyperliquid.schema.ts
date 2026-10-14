import { z } from 'zod';
import { exchangeSchema, proxySchema } from '../exchange.schema';

/**
 * privateKey or walletAddress: text starting with 0x. Unquoted, YAML and JSON5 read 0x and hexadecimal digits as a number (a private
 * key as 3.4e76), which was refused with "expected string, received number" alone, without saying what to change.
 */
const credentialSchema = (field: 'privateKey' | 'walletAddress') => {
  const unquotedMessage = `${field} must be written in quotes ('0x…'): unquoted, 0x… is read as a hexadecimal number`;
  return z
    .string({ error: ({ input }) => (typeof input === 'number' ? unquotedMessage : undefined) })
    .startsWith('0x')
    .optional();
};

/**
 * Both keys are optional, as Binance's are: an import reads the markets and the candles through the public client alone, and with the
 * keys required, importing candles had a reader write a wallet's private key into a configuration file. ccxt reads the account (its
 * balance, its orders) at walletAddress and signs its orders with privateKey, and does not work the address out from the key:
 * privateKey alone serves no call, and is refused here. The keys a realtime run needs depend on its plugins, which the configuration
 * checks: walletAddress for a TradingAdvisor, which only reads, and both for a Trader.
 */
export const hyperliquidExchangeSchema = exchangeSchema
  .extend({
    name: z.literal('hyperliquid'),
    privateKey: credentialSchema('privateKey'),
    walletAddress: credentialSchema('walletAddress'),
    sandbox: z.boolean().default(false),
    verbose: z.boolean().default(false),
    proxy: proxySchema,
  })
  .refine(({ privateKey, walletAddress }) => privateKey === undefined || walletAddress !== undefined, {
    path: ['walletAddress'],
    message: 'walletAddress is required with privateKey, which signs the orders of the account at that address',
  });
