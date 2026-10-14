import { GekkoError } from '@errors/gekko.error';
import { readFileSync } from 'fs';
import { CORE_SCHEMA, load } from 'js-yaml';
import JSON5 from 'json5';
import { find, isNil } from 'lodash-es';
import { extname } from 'path';
import { z } from 'zod';
import { Configuration as ConfigurationModel } from '../../models/configuration.types';
import { configurationSchema } from './configuration.schema';

export class Configuration {
  private configuration?: ConfigurationModel;
  constructor() {
    const configFilePath = process.env['GEKKO_CONFIG_FILE_PATH'];
    if (!configFilePath) throw new GekkoError('configuration', 'Missing GEKKO_CONFIG_FILE_PATH environment variable');
    const extension = extname(configFilePath).toLowerCase();
    const isJson = extension === '.json' || extension === '.json5';
    const isYaml = extension === '.yml' || extension === '.yaml';
    if (!isJson && !isYaml)
      throw new GekkoError('configuration', `Unsupported file extension: ${configFilePath} (expected .json, .json5, .yml or .yaml)`);
    const data = readFileSync(configFilePath, 'utf8');
    // YAML's core schema, without the timestamps of js-yaml's default one: an unquoted date became a Date before the schema saw it,
    // rolled over when it did not exist (2023-02-29 read as March 1st). Kept as text, it is checked like a quoted one. The default
    // schema's merge key (<<) and its !!binary, !!omap, !!pairs and !!set tags go with it: no configuration has a use for them.
    const content = isJson ? JSON5.parse(data) : load(data, { schema: CORE_SCHEMA });
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
