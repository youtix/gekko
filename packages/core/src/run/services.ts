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
 * paper-binance) and the SQLite storage of the watched pairs. One instance per run, in its RunContext.
 */
export class Services {
  private storageInstance?: Storage;
  private exchangeInstance?: Exchange;

  constructor(private readonly configuration: ConfigurationReader) {}

  public storage() {
    if (this.storageInstance) return this.storageInstance;
    const storageConfig = this.configuration.getStorage();
    if (!storageConfig?.type) throw new GekkoError('injecter', 'Missing or unknown storage.');
    const { pairs } = this.configuration.getWatch();
    this.storageInstance = new SQLiteStorage(pairs.map(({ symbol }) => symbol));
    return this.storageInstance;
  }

  /** Closes the storage if one was created. Unlike storage(), it never creates one, so it never throws for want of a configuration. */
  public closeStorage() {
    this.storageInstance?.close();
  }

  public exchange() {
    if (this.exchangeInstance) return this.exchangeInstance;
    const exchangeConfig = this.configuration.getExchange();
    if (!exchangeConfig?.name) throw new GekkoError('injecter', 'Missing or unknown exchange.');
    switch (exchangeConfig.name) {
      case 'binance':
      case 'hyperliquid':
        this.exchangeInstance = new CCXTExchange(exchangeConfig);
        break;
      case 'dummy-cex':
        this.exchangeInstance = new DummyCentralizedExchange(exchangeConfig);
        break;
      case 'paper-binance':
        this.exchangeInstance = new PaperTradingBinanceExchange(exchangeConfig);
        break;
      default:
        throw new GekkoError('injecter', 'Missing or unknown exchange.');
    }
    return this.exchangeInstance;
  }
}
