import { z } from 'zod';
import type { telegramMessageSchema, telegramUpdateSchema } from './telegram.schema';

export type TelegramMessage = z.infer<typeof telegramMessageSchema>;
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
