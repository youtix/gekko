declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface IndicatorRegistry {}

  /**
   * Milliseconds since the epoch. lib.dom declared it, and tsconfig.json no longer loads lib.dom: Bun has no DOM, whose declarations
   * typed Response.json() as any and let a stray `document`, `length` or `status` type-check, to throw a ReferenceError under Bun.
   */
  type EpochTimeStamp = number;
}
export {};
