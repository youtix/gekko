import { exchangeSchema, proxySchema } from './exchange.schema';
import z from 'zod';

export const binanceExchangeSchema = exchangeSchema.extend({
  name: z.literal('binance'),
  apiKey: z.string().optional(), // Optional for importer mode
  secret: z.string().optional(), // Optional for importer mode
  sandbox: z.boolean().default(false),
  verbose: z.boolean().default(false),
  proxy: proxySchema,
});
