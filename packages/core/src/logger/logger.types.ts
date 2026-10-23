import { LogLevel } from '@gekko/shared/models/logLevel.types';
import { Tag } from '@gekko/shared/models/tag.types';

export type LogInput = { tag: Tag; message: unknown; level: LogLevel };

/**
 * The lock of a descriptor several threads write to (Fox's main thread and its workers): one value, 0 while free, else the lease of
 * its holder (see acquireWriteLock), over a SharedArrayBuffer every thread views.
 */
export type WriteLock = BigInt64Array<SharedArrayBuffer>;
