import { z } from 'zod';

/**
 * The chatId option of the Telegram plugins: the only chat whose commands the bot handles and that gets its messages (see
 * TelegramBot). A Telegram chat id is positive for a private chat and negative for a group, never 0: with 0, the bot would ignore
 * every command, its owner's included, and Telegram would refuse every message it sends ("chat not found").
 */
export const chatIdSchema = z
  .number()
  .int()
  .refine(
    chatId => chatId !== 0,
    'chatId cannot be 0, the id of no Telegram chat: a private chat has a positive id, a group a negative one',
  );

/** The part of a Telegram message the bot reads (https://core.telegram.org/bots/api#message): Telegram sends more, which is dropped */
export const telegramMessageSchema = z.object({
  text: z.string().optional(),
  chat: z.object({
    id: z.number(),
    /** 'private', 'group', 'supergroup' or 'channel' */
    type: z.string().optional(),
    /** The name of a group, a supergroup or a channel */
    title: z.string().optional(),
    /** The username of a private chat's user, a supergroup or a channel, if it has one */
    username: z.string().optional(),
  }),
  /** The sender, which a message posted in a channel has not */
  from: z
    .object({
      username: z.string().optional(),
      first_name: z.string().optional(),
    })
    .optional(),
});

/** An update (https://core.telegram.org/bots/api#update): its id, and its message, which an update of another kind has not */
export const telegramUpdateSchema = z.object({
  update_id: z.number(),
  message: telegramMessageSchema.optional(),
});

/**
 * The answer of getUpdates (https://core.telegram.org/bots/api#getupdates), as the fetcher hands it over: as it came, unchecked, once
 * it has thrown for an answer that says ok: false.
 */
export const getUpdatesAnswerSchema = z.object({
  ok: z.literal(true),
  result: z.array(telegramUpdateSchema),
});
