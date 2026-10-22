import { symbolSchema } from '../configuration/pairConfig.schema';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { exchangeSchema, feeRateSchema, refuseRepeatedKeys, simulationBalanceSchema } from './exchange.schema';
import z from 'zod';
import { MarketData, Ticker } from '@gekko/shared/models/exchange.types';

const nonNegativeNumberSchema = (field: string) => {
  const message = `${field} must be a number of at least 0`;
  return z.number(message).min(0, message);
};

const positiveNumberSchema = (field: string) => {
  const message = `${field} must be a number greater than 0`;
  return z.number(message).positive(message);
};

/**
 * A precision, configured as a number of decimals (8 for a price or an amount to 0.00000001), handed on as the step that
 * MarketData.precision holds in every mode, as ccxt gives it for Binance and Hyperliquid (TICK_SIZE precision mode): GridBot rounds
 * prices to multiples of it, and amounts down to its decimals. Number('1e-5') is the literal 0.00001, where V8 computes 10 ** -5 a
 * unit below it.
 */
const decimalsToStepSchema = (field: string) => {
  const message = `${field} must be a whole number of decimals of at least 0, not a step (2 for a step of 0.01)`;
  return z
    .number(message)
    .int(message)
    .min(0, message)
    .transform(decimals => Number(`1e-${decimals}`));
};

/**
 * The significant digits a price has at most where the tick depends on the price, as CCXTExchange states it for Hyperliquid (5, see
 * PRICE_SIGNIFICANT_DIGITS), handed on as it is. A backtest rehearses that rule with it: the strategies read it, and the simulator
 * rounds the price of an order to the tick at that price (see getPriceTick). Left out, the tick is precision.price at any price.
 */
const significantDigitsSchema = (field: string) => {
  const message = `${field} must be a whole number of at least 1 (5 on Hyperliquid), left out for a tick that does not depend on the price`;
  return z.number(message).int(message).min(1, message);
};

/**
 * Whether the min of a range does not exceed its max. A bound left out compares nothing, nor does a max of 0 or below: one that sets no
 * maximum (see limitRangeSchema), or a negative one, already reported.
 */
const isMinAtMostMax = ({ min, max }: { min?: number; max?: number }) => min === undefined || max === undefined || max <= 0 || min <= max;

/** The issue of a range whose min exceeds its max, worded for its field */
const minAboveMaxMessage = (field: string) => `${field}.min must not exceed ${field}.max (leave max out for no maximum)`;

/**
 * The lowest and highest order price, amount or cost of a pair. A max left out, or set to 0 as Binance reports a disabled
 * filter, sets no maximum (market.helper counts a bound of 0 as absent), so min is only compared with a max above 0.
 * Zod still runs the refinement after a failed bound: a negative max, already reported, is not compared either.
 */
const limitRangeSchema = (field: string) =>
  z
    .strictObject({
      min: nonNegativeNumberSchema(`${field}.min`),
      max: nonNegativeNumberSchema(`${field}.max`).optional(),
    })
    .refine(isMinAtMostMax, { message: minAboveMaxMessage(field) });

/**
 * The amounts of a market order, which narrow the amount range for a MARKET order (see MarketData.market and getMarketOrderLimits):
 * Binance's MARKET_LOT_SIZE, which paper trading carries from the real market, tens of BTC on BTC/USDT where the amount range goes up to
 * 9000, so that a backtest caps and refuses a MARKET order as Binance does. Left out, a MARKET order takes the amount range. Either bound
 * may be left out, as MarketData states them (Binance leaves the minimum at 0, which sets none), and each is checked as those of the
 * other ranges are (see limitRangeSchema).
 */
const marketOrderRangeSchema = z
  .strictObject({
    min: nonNegativeNumberSchema('market.min').optional(),
    max: nonNegativeNumberSchema('market.max').optional(),
  })
  .refine(isMinAtMostMax, { message: minAboveMaxMessage('market') });

/**
 * The quote of a pair until its first candle. Zod still runs the refinement after a failed bound: an ask of 0 or below,
 * already reported, is not compared.
 */
const tickerSchema = z
  .strictObject({
    bid: positiveNumberSchema('ticker.bid'),
    ask: positiveNumberSchema('ticker.ask'),
  })
  .refine(({ bid, ask }) => ask <= 0 || bid <= ask, { message: 'ticker.bid must not exceed ticker.ask' });

const marketDataSchema = z
  .array(
    z.strictObject({
      symbol: symbolSchema,
      marketData: z.strictObject({
        price: limitRangeSchema('price'),
        amount: limitRangeSchema('amount'),
        cost: limitRangeSchema('cost'),
        market: marketOrderRangeSchema.optional(),
        precision: z.strictObject({
          price: decimalsToStepSchema('precision.price'),
          amount: decimalsToStepSchema('precision.amount'),
          priceSignificantDigits: significantDigitsSchema('precision.priceSignificantDigits').optional(),
        }),
        fee: z.strictObject({
          maker: feeRateSchema('fee.maker'),
          taker: feeRateSchema('fee.taker'),
        }),
      }),
    }),
  )
  .superRefine(refuseRepeatedKeys('marketData', 'symbol'))
  .default([])
  .transform(marketConstraints => new Map<TradingPair, MarketData>(marketConstraints?.map(mc => [mc.symbol, mc.marketData]) ?? []));

const initialTickerSchema = z
  .array(
    z.strictObject({
      symbol: symbolSchema,
      ticker: tickerSchema,
    }),
  )
  .superRefine(refuseRepeatedKeys('initialTicker', 'symbol'))
  .default([])
  .transform(balance => new Map<TradingPair, Ticker>(balance.map(b => [b.symbol, b.ticker])));

export const dummyExchangeSchema = exchangeSchema.extend({
  name: z.literal('dummy-cex'),
  simulationBalance: simulationBalanceSchema,
  marketData: marketDataSchema,
  initialTicker: initialTickerSchema,
});
