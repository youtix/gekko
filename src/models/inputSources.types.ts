import type { INPUT_SOURCES } from '@indicators/indicator.const';

/**
 * A price an indicator reads from each candle, named by its `src` parameter: a key of INPUT_SOURCES, from which it derives. A source is
 * added there only: the indicators' check of `src` (checkInputSource) and the strategies' `src` parameter (inputSourceSchema) read the
 * same keys. Written out by hand next to it, the list let a source added to INPUT_SOURCES alone pass the check but not the compiler,
 * and one added to both was refused by every strategy schema, each listing the sources again.
 */
export type InputSources = keyof typeof INPUT_SOURCES;
