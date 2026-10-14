import { z } from 'zod';
import type { candleWriterSchema } from './candleWriter.schema';

export type CandleWriterConfig = z.infer<typeof candleWriterSchema>;
