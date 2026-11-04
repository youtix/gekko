import { ONE_MINUTE, ONE_SECOND } from '@gekko/shared/constants/time.const';
import { Asset } from '@gekko/shared/models/utility.types';
import { keepDuplicates } from '@gekko/shared/utils/collection/array.utils';
import z from 'zod';

/** setTimeout and setInterval treat a longer delay (2^31 - 1 ms, about 24.8 days) as an overflow and fire after 1 ms instead */
const MAX_TIMER_DELAY = 2_147_483_647;

/** The order and portfolio polling run at most once a second, which keeps clear of the exchanges' rate limits */
const MIN_SYNCH_INTERVAL = ONE_SECOND;

/** A polling period handed to setInterval: 0, a negative or an overflowing delay would poll the exchange every millisecond */
const synchIntervalSchema = (field: string) => {
  const message = `${field} must be an integer number of milliseconds between ${MIN_SYNCH_INTERVAL} and ${MAX_TIMER_DELAY}`;
  return z.number(message).int(message).min(MIN_SYNCH_INTERVAL, message).max(MAX_TIMER_DELAY, message);
};

/** A maker or taker fee, as a fraction of the traded value: 0.001 is a 0.1 % fee */
export const feeRateSchema = (field: string) => {
  const message = `${field} must be a fraction between 0 and 1 (0.001 is a 0.1 % fee)`;
  return z.number(message).min(0, message).max(1, message);
};

export const proxySchema = z
  .string()
  .regex(/^(https?|socks5):\/\/.+/, 'Proxy must be a valid URL (http://, https://, or socks5://)')
  .optional();

/**
 * Refuses a list that repeats a key, for a list the schema reads into a Map by that key: the Map kept the last entry of a key and
 * dropped the others without a word, so a second marketData block for a pair replaced the fees of the first, and a second USDT
 * balance the first balance.
 */
export const refuseRepeatedKeys =
  <Key extends string>(list: string, key: Key) =>
  (entries: Record<Key, string>[], ctx: z.RefinementCtx) => {
    const repeatedKeys = keepDuplicates(entries.map(entry => entry[key]));
    if (repeatedKeys.length) {
      ctx.addIssue({ code: 'custom', message: `${list} must hold one entry per ${key} (repeated: ${repeatedKeys.join(', ')})` });
    }
  };

export const simulationBalanceSchema = z
  .array(
    z.strictObject({
      assetName: z.string(),
      balance: z.number().nonnegative(),
    }),
  )
  .min(1)
  .superRefine(refuseRepeatedKeys('simulationBalance', 'assetName'))
  .transform(balance => new Map<Asset, number>(balance.map(b => [b.assetName, b.balance])));

/** Its strictness carries over to every exchange schema extending it: a misspelt key (sandobx: true) is refused, not dropped */
export const exchangeSchema = z.strictObject({
  name: z.string(),
  exchangeSynchInterval: synchIntervalSchema('exchangeSynchInterval').default(10 * ONE_MINUTE),
  orderSynchInterval: synchIntervalSchema('orderSynchInterval').default(20 * ONE_SECOND),
});
