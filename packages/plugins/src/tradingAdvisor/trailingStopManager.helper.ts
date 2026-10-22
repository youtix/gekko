import { TrailingStopState } from '@gekko/strategies/trailingStopManager.types';

/** What a listener receives: a copy of the stop, its config included, so that what the listener changes does not reach the stop */
export const copyState = (order: TrailingStopState): TrailingStopState => ({ ...order, config: { ...order.config } });
