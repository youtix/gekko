import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { Exchange } from '@gekko/shared/models/exchange.types';
import { CCXTExchange } from '../exchange/ccxtExchange';
import { DummyCentralizedExchange } from '../exchange/dummy/dummyCentralizedExchange';
import { PaperTradingBinanceExchange } from '../exchange/paper/paperTradingBinanceExchange';
import { SQLiteStorage } from '../storage/sqlite.storage';
import { Storage } from '../storage/storage';
import type { ConfigurationReader } from './runContext.types';

/**
 * The services of one run, built from its configuration the first time they are asked for and shared from then on: the exchange the
 * configuration names (CCXTExchange for binance and hyperliquid, the backtest simulator for dummy-cex, the paper exchange for
 * paper-binance) and the SQLite storage of the watched pairs. One instance per run, in its RunContext. Receives the configuration of
 * the run, and hands each service the sections it reads: its own (the exchange section, the storage section) and the watch section.
 */
export class Services {
  private storageInstance?: Storage;
  private exchangeInstance?: Exchange;

  constructor(private readonly configuration: ConfigurationReader) {}

  public storage() {
    if (this.storageInstance) return this.storageInstance;
    const storageConfig = this.configuration.getStorage();
    if (!storageConfig?.type) throw new GekkoError('configuration', 'Missing or unknown storage.');
    this.storageInstance = new SQLiteStorage(storageConfig, this.configuration.getWatch());
    return this.storageInstance;
  }

  /** Closes the storage if one was created. Unlike storage(), it never creates one, so it never throws for want of a configuration. */
  public closeStorage() {
    this.storageInstance?.close();
  }

  public exchange() {
    if (this.exchangeInstance) return this.exchangeInstance;
    const exchangeConfig = this.configuration.getExchange();
    const watch = this.configuration.getWatch();
    // A section left out, or naming no exchange Gekko knows, falls through to the default: each case narrows the section to its own
    switch (exchangeConfig?.name) {
      case 'binance':
      case 'hyperliquid':
        this.exchangeInstance = new CCXTExchange(exchangeConfig, watch);
        break;
      case 'dummy-cex':
        this.exchangeInstance = new DummyCentralizedExchange(exchangeConfig, watch);
        break;
      case 'paper-binance':
        this.exchangeInstance = new PaperTradingBinanceExchange(exchangeConfig, watch);
        break;
      default:
        throw new GekkoError('configuration', 'Missing or unknown exchange.');
    }
    return this.exchangeInstance;
  }
}
