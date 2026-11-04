import type { Configuration as ConfigurationModel } from '@gekko/schemas/configuration/configuration.types';
import { find } from 'lodash-es';

/**
 * The configuration of one run, as the schema outputs it (parseConfiguration): a getter per section. Built
 * by createRunContext and read through the RunContext the plugins and the orders receive; the streams, the exchanges and the storage
 * receive the sections they read instead (see Services). The file helpers (loadConfigurationFile, parseConfiguration) are
 * beside it, in configuration.helper.ts.
 */
export class Configuration {
  constructor(private readonly configuration: ConfigurationModel) {}

  public showLogo() {
    return this.configuration.showLogo;
  }

  public getPlugins() {
    return this.configuration.plugins;
  }

  public getStrategy() {
    return this.configuration.strategy;
  }

  public getWatch() {
    return this.configuration.watch;
  }

  /** The storage section, in backtest mode or with a CandleWriter: the only two users of a storage. Undefined otherwise. */
  public getStorage() {
    const { watch, plugins, storage } = this.configuration;
    if (storage && (watch.mode === 'backtest' || find(plugins, { name: 'CandleWriter' }))) {
      return storage;
    }
  }

  public getExchange() {
    return this.configuration.exchange;
  }
}
