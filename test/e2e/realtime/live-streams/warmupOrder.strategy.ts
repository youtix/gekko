import type { InitParams, OnCandleEventParams, Strategy } from '@strategies/strategy.types';
import { z } from 'zod';

const warmupOrderSchema = z.strictObject({});

type WarmupOrderParams = z.infer<typeof warmupOrderSchema>;

/**
 * The strategy of the warmup scenario of the realtime live streams, loaded through strategyPath as a strategy file of the user's is: it
 * says which candle its init got, then each candle it sees, by their start and close, and creates a MARKET BUY of 1 on each, the first
 * being a candle of the warmup, which createOrder refuses. It imports only types from Gekko, and zod, as a file loaded at run time can.
 */
export class WarmupOrder implements Strategy<WarmupOrderParams> {
  static schema = warmupOrderSchema;

  init({ candle, tools }: InitParams<WarmupOrderParams>): void {
    for (const [pair, { start, close }] of candle) {
      tools.log('info', `init with the candle ${new Date(start).toISOString()} of ${pair}, closing at ${close}`);
    }
  }

  onEachTimeframeCandle({ candle, tools }: OnCandleEventParams<WarmupOrderParams>, ..._indicators: unknown[]): void {
    for (const [symbol, { start, close }] of candle) {
      tools.log('info', `candle ${new Date(start).toISOString()} of ${symbol}, closing at ${close}`);
      tools.createOrder({ type: 'MARKET', side: 'BUY', amount: 1, symbol });
    }
  }
}
