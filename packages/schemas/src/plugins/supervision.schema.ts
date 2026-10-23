import { ONE_MINUTE, ONE_SECOND } from '@gekko/shared/constants/time.const';
import { chatIdSchema } from '../bots/telegram.schema';
import { z } from 'zod';

/** setInterval treats a longer delay (2^31 - 1 ms, about 24.8 days) as an overflow and fires after 1 ms instead */
const MAX_TIMER_DELAY = 2_147_483_647;

/** The checks run at most once a second: a period of a few milliseconds would keep the bot busy measuring itself and flood Telegram */
const MIN_CHECK_INTERVAL = ONE_SECOND;

/** A check period handed to setInterval, bounded like the exchange polling periods */
const checkIntervalSchema = (field: string) => {
  const message = `${field} must be an integer number of milliseconds between ${MIN_CHECK_INTERVAL} and ${MAX_TIMER_DELAY}`;
  return z.number(message).int(message).min(MIN_CHECK_INTERVAL, message).max(MAX_TIMER_DELAY, message);
};

/**
 * A bucket comes once a minute, so the last one is up to a minute old before the next one: a stale threshold of a minute or less would
 * report the candles as stopped, then as coming again, between every two of them.
 */
const CANDLE_STALE_THRESHOLD_MESSAGE = `candleStaleThreshold must be an integer number of milliseconds above ${ONE_MINUTE}: the 1-minute candles come once a minute`;

export const supervisionSchema = z.strictObject({
  name: z.string(),
  token: z.string(),
  botUsername: z.string(),
  // The only chat whose commands the bot handles and that gets its messages. Anyone can find a bot by its username, and without
  // it the bot takes the first chat to send it a command after start-up.
  chatId: chatIdSchema.optional(),
  cpuThreshold: z.number().positive().default(80),
  memoryThreshold: z.number().positive().default(1024),
  cpuCheckInterval: checkIntervalSchema('cpuCheckInterval').default(10 * ONE_SECOND),
  memoryCheckInterval: checkIntervalSchema('memoryCheckInterval').default(10 * ONE_SECOND),
  logMonitoringInterval: checkIntervalSchema('logMonitoringInterval').default(ONE_MINUTE),
  /** How often the candle check looks at the age of the last 1-minute bucket received */
  candleCheckInterval: checkIntervalSchema('candleCheckInterval').default(ONE_MINUTE),
  /** Age of the last 1-minute bucket beyond which the candle check alerts that the candles stopped coming */
  candleStaleThreshold: z
    .number(CANDLE_STALE_THRESHOLD_MESSAGE)
    .int(CANDLE_STALE_THRESHOLD_MESSAGE)
    .gt(ONE_MINUTE, CANDLE_STALE_THRESHOLD_MESSAGE)
    .default(3 * ONE_MINUTE),
});
