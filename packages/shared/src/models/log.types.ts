import { LogLevel } from './logLevel.types';
import { Tag } from './tag.types';

/** A log line as the logger keeps it for Supervision, whatever GEKKO_LOG_LEVEL: a warning or an error */
export type BufferedLog = { timestamp: number; level: LogLevel; tag: Tag; message: string };
