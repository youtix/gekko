import { describeError } from '@gekko/shared/errors/error.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { CORE_SCHEMA, load, YAMLException } from 'js-yaml';
import JSON5 from 'json5';
import { FileFormat, Json5SyntaxError } from './configuration.types';

const isJson5SyntaxError = (err: unknown): err is Json5SyntaxError =>
  err instanceof SyntaxError && Number.isInteger(Reflect.get(err, 'lineNumber')) && Number.isInteger(Reflect.get(err, 'columnNumber'));

const atPosition = (line: number, column: number) => `at line ${line}, column ${column}`;

/**
 * What the parser found wrong in a file, and where, quoting none of the file. Not js-yaml's message, which quotes the lines around the
 * fault, three before and two after, each cut around the column of the fault: a typo near the Telegram token or the API keys printed
 * them at error level, whole or cut short.
 */
const describeSyntaxError = (err: unknown) => {
  // js-yaml counts lines and columns from 0, and gives no position to a stream of several documents, refused once all are read
  if (err instanceof YAMLException) return err.mark ? `${err.reason} ${atPosition(err.mark.line + 1, err.mark.column + 1)}` : err.reason;
  if (isJson5SyntaxError(err))
    return `${err.message.replace(/^JSON5: | at \d+:\d+$/g, '')} ${atPosition(err.lineNumber, err.columnNumber)}`;
  // A nesting too deep for js-yaml's recursion: the engine's RangeError, which quotes nothing
  return describeError(err);
};

/**
 * The content of a configuration file, read by the parser of its format. A file that does not parse is refused with what the parser
 * found wrong and where, in a GekkoError without a cause: the fatal error report prints a cause in full, and the parser's error holds
 * the file (js-yaml's message quotes the lines around the fault, its mark holds the whole text).
 */
export const parseConfigurationFile = (path: string, data: string, format: FileFormat): unknown => {
  try {
    // YAML's core schema, without the timestamps of js-yaml's default one: an unquoted date became a Date before the schema saw it,
    // rolled over when it did not exist (2023-02-29 read as March 1st). Kept as text, it is checked like a quoted one. The default
    // schema's merge key (<<) and its !!binary, !!omap, !!pairs and !!set tags go with it: no configuration has a use for them.
    return format === 'YAML' ? load(data, { schema: CORE_SCHEMA }) : JSON5.parse(data);
  } catch (err) {
    throw new GekkoError('configuration', `Invalid ${format} in configuration file ${path}: ${describeSyntaxError(err)}`);
  }
};
