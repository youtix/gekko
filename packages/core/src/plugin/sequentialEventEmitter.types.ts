export type Listener<T = unknown> = (payload: T) => Promise<void> | void;

/**
 * Payloads queued in a row under one event name, which its listeners receive together, as one array. `isCopied`: each was copied as
 * it was queued. One queued while nobody listened to its event is the emitter's own object (see addDeferredEmit).
 */
export type DeferredGroup = { name: string; payloads: unknown[]; isCopied: boolean };
