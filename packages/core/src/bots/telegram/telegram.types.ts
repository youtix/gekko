import { z } from 'zod';
import type { telegramMessageSchema, telegramUpdateSchema } from '@gekko/schemas/bots/telegram.schema';

export type TelegramMessage = z.infer<typeof telegramMessageSchema>;
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
