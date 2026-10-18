import { TIMEFRAME_TO_MINUTES } from '@constants/timeframe.const';
import { FileFormat } from './configuration.types';

type Timeframe = keyof typeof TIMEFRAME_TO_MINUTES;

/** The timeframes a config can watch: the keys of TIMEFRAME_TO_MINUTES, in its order (z.enum needs a non-empty tuple) */
export const TIMEFRAMES = Object.keys(TIMEFRAME_TO_MINUTES) as [Timeframe, ...Timeframe[]];

/** The format a file is read in, by its extension: JSON5, a superset of JSON, reads both kinds of JSON file */
export const FORMAT_BY_EXTENSION = new Map<string, FileFormat>([
  ['.json', 'JSON'],
  ['.json5', 'JSON5'],
  ['.yml', 'YAML'],
  ['.yaml', 'YAML'],
]);
