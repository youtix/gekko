import { chatIdSchema } from '../bots/telegram.schema';
import { z } from 'zod';

export const eventSubscriberSchema = z.strictObject({
  name: z.string(),
  token: z.string(),
  botUsername: z.string(),
  // The only chat whose commands the bot handles and that gets its messages. Anyone can find a bot by its username, and without
  // it the bot takes the first chat to send it a command after start-up.
  chatId: chatIdSchema.optional(),
});
