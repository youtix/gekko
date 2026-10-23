import { INPUT_SOURCES } from '@gekko/shared/constants/inputSources.const';
import type { InputSources } from '@gekko/shared/models/inputSources.types';
import { z } from 'zod';

/**
 * The `src` parameter of a strategy, the price its indicators read from each candle: one of the keys of INPUT_SOURCES, which a refusal
 * lists in their order. Every strategy with a `src` takes it from here: RSI, TMA, SMACrossover and EMARibbon each listed the sources
 * again, which the compiler checked for names it knew, not for one missing, so a source added to the indicators was refused by all four.
 */
export const inputSourceSchema = z.enum(Object.keys(INPUT_SOURCES) as InputSources[]);
