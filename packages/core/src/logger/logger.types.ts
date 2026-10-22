import { LogLevel } from '@gekko/shared/models/logLevel.types';
import { Tag } from '@gekko/shared/models/tag.types';

export type LogInput = { tag: Tag; message: unknown; level: LogLevel };
