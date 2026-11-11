export type HeartOptions = {
  /** How long after each multiple of the tick rate (in epoch time) a tick fires, in ms. Must stay below the tick rate. */
  gracePeriod?: number;
};
