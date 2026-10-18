import { GekkoError } from '@errors/gekko.error';
import type { Configuration as ConfigurationModel } from '@models/configuration.types';
import { readFileSync } from 'fs';
import { find, isNil } from 'lodash-es';
import { extname } from 'path';
import { z } from 'zod';
import { FORMAT_BY_EXTENSION } from './configuration.const';
import { parseConfigurationFile } from './configuration.helper';
import { configurationSchema } from './configuration.schema';

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
