import { z } from 'zod';
import type { eventSubscriberSchema } from './eventSubscriber.schema';

export const EVENT_NAMES = [
  'strat_info',
  'strat_create',
  'strat_cancel',
  'order_init',
  'order_cancel',
  'order_error',
  'order_complete',
  'roundtrip_complete',
] as const;

export type Event = (typeof EVENT_NAMES)[number];

export type EventSubscriberConfig = z.infer<typeof eventSubscriberSchema>;

/** A message waiting for its turn, with the event it notifies of, which the logs name */
export type PendingNotification = { event: Event; text: string };
