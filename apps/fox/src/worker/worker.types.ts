import type { VariantRequest } from '../fox.types';

/**
 * What runWorker posts to a worker: the variant to backtest, and the lock of stdout Fox's main thread shares (shareWriteLock), under
 * which the worker writes its lines (useWriteLock), so that no thread's line lands among the parts of another's.
 */
export type WorkerRequest = VariantRequest & { writeLock: SharedArrayBuffer };
