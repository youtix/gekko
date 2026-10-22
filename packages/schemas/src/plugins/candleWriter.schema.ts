import { z } from 'zod';

export const candleWriterSchema = z.strictObject({ name: z.string() });
