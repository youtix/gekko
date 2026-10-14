import { describeError } from '@errors/error.utils';
import { GekkoError } from '@errors/gekko.error';
import type { Configuration as ConfigurationModel } from '@models/configuration.types';
import { readFileSync } from 'fs';
import { CORE_SCHEMA, load, YAMLException } from 'js-yaml';
import JSON5 from 'json5';
import { find, isNil } from 'lodash-es';
import { extname } from 'path';
import { z } from 'zod';
import { configurationSchema } from './configuration.schema';

type FileFormat = 'JSON' | 'JSON5' | 'YAML';

/** The format a file is read in, by its extension: JSON5, a superset of JSON, reads both kinds of JSON file */
const FORMAT_BY_EXTENSION = new Map<string, FileFormat>([
  ['.json', 'JSON'],
  ['.json5', 'JSON5'],
  ['.yml', 'YAML'],
  ['.yaml', 'YAML'],
]);

/** The error of JSON5.parse, whose message reads "JSON5: <reason> at <line>:<column>", the line and column also given apart */
type Json5SyntaxError = SyntaxError & { lineNumber: number; columnNumber: number };

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
const parseConfigurationFile = (path: string, data: string, format: FileFormat): unknown => {
  try {
    // YAML's core schema, without the timestamps of js-yaml's default one: an unquoted date became a Date before the schema saw it,
    // rolled over when it did not exist (2023-02-29 read as March 1st). Kept as text, it is checked like a quoted one. The default
    // schema's merge key (<<) and its !!binary, !!omap, !!pairs and !!set tags go with it: no configuration has a use for them.
    return format === 'YAML' ? load(data, { schema: CORE_SCHEMA }) : JSON5.parse(data);
  } catch (err) {
    throw new GekkoError('configuration', `Invalid ${format} in configuration file ${path}: ${describeSyntaxError(err)}`);
  }
};

export class Configuration {
  private configuration?: ConfigurationModel;
  constructor() {
    const configFilePath = process.env['GEKKO_CONFIG_FILE_PATH'];
    if (!configFilePath) throw new GekkoError('configuration', 'Missing GEKKO_CONFIG_FILE_PATH environment variable');
    const format = FORMAT_BY_EXTENSION.get(extname(configFilePath).toLowerCase());
    if (!format)
      throw new GekkoError('configuration', `Unsupported file extension: ${configFilePath} (expected .json, .json5, .yml or .yaml)`);
    const content = parseConfigurationFile(configFilePath, readFileSync(configFilePath, 'utf8'), format);
    if (isNil(content)) throw new GekkoError('configuration', `Empty configuration file: ${configFilePath}`);
    const result = configurationSchema.safeParse(content);
    // Not the ZodError itself, whose message, the JSON of its issues, names no file: a GekkoError, which the fatal error report
    // prints as its message alone, here one issue per line with the path of the option at fault
    if (!result.success)
      throw new GekkoError('configuration', `Invalid configuration file ${configFilePath}:\n${z.prettifyError(result.error)}`);
    this.configuration = result.data;
  }

  public showLogo() {
    if (!this.configuration) throw new GekkoError('configuration', 'Empty configuration file');
    return this.configuration.showLogo;
  }

  public getPlugins() {
    if (!this.configuration) throw new GekkoError('configuration', 'Empty configuration file');
    return this.configuration.plugins;
  }

  public getStrategy() {
    if (!this.configuration) throw new GekkoError('configuration', 'Empty configuration file');
    return this.configuration.strategy;
  }

  public getWatch() {
    if (!this.configuration) throw new GekkoError('configuration', 'Empty configuration file');
    return this.configuration.watch;
  }

  public getStorage() {
    if (!this.configuration) throw new GekkoError('configuration', 'Empty configuration file');
    const { watch, plugins } = this.configuration;
    if (this.configuration.storage && (watch.mode === 'backtest' || find(plugins, { name: 'CandleWriter' }))) {
      return this.configuration.storage;
    }
  }

  public getExchange() {
    if (!this.configuration) throw new GekkoError('configuration', 'Empty configuration file');
    return this.configuration.exchange;
  }
}

export const config = new Configuration();
