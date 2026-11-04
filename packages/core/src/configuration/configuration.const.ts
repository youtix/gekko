import { FileFormat } from './configuration.types';

/** The format a file is read in, by its extension: JSON5, a superset of JSON, reads both kinds of JSON file */
export const FORMAT_BY_EXTENSION = new Map<string, FileFormat>([
  ['.json', 'JSON'],
  ['.json5', 'JSON5'],
  ['.yml', 'YAML'],
  ['.yaml', 'YAML'],
]);
