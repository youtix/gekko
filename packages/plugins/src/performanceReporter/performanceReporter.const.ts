import { DEFAULT_STALE_MS } from '@gekko/core/fs/fs.service';
import { PerformanceReport } from './performanceReporter.types';

/** Written at the start of a UTF-8 file by the spreadsheets that save it back on Windows (Excel, LibreOffice). */
export const BYTE_ORDER_MARK = '\uFEFF';

/** The value of the `report type` column, for each report this plugin writes. */
export const REPORT_TYPES: Record<PerformanceReport['id'], string> = {
  'PORTFOLIO PROFIT REPORT': 'Portfolio',
  'TRADING REPORT': 'Trading',
};

/**
 * The bounds of the delay between two attempts at the lock of the file, drawn once per row: with the same delay, the runs that miss the
 * lock together would retry together, and only a few would get it each time.
 */
export const LOCK_RETRY_DELAY_MS = { min: 25, max: 75 };

/**
 * How long a row keeps trying for the lock of its file. Sized for a sweep: the variants Fox runs side by side can end together, as many
 * as the machine has cores, each holding the lock for the milliseconds of its write, hundreds of them on a slow disk, so the last one
 * can wait seconds. Twice the age at which lock takes over a lock left behind by a run killed while writing: such a lock is taken
 * over within the wait, and only a live run holding the lock for that long, or a file system refusing the lock file, still loses a row.
 */
export const LOCK_WAIT_MS = 2 * DEFAULT_STALE_MS;
