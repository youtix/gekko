import { z } from 'zod';
import type { candleWriterSchema } from '@gekko/schemas/plugins/candleWriter.schema';

export type CandleWriterConfig = z.infer<typeof candleWriterSchema>;
