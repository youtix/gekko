import type { storageSchema } from '@gekko/schemas/configuration/configuration.schema';
import type { z } from 'zod';

export type CandleDateranges = { daterange_start: EpochTimeStamp; daterange_end: EpochTimeStamp };
export type MissingCandleCount = { missingCandleCount: number };

/** The storage section of the configuration, as its schema parses it: the SQLite file and how many minutes are written at once */
export type StorageConfig = z.infer<typeof storageSchema>;
