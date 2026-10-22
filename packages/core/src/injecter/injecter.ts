import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { config } from '../configuration/configuration';
import { CCXTExchange } from '../exchange/ccxtExchange';
import { DummyCentralizedExchange } from '../exchange/dummy/dummyCentralizedExchange';
import { Exchange } from '@gekko/shared/models/exchange.types';
import { PaperTradingBinanceExchange } from '../exchange/paper/paperTradingBinanceExchange';
import { SQLiteStorage } from '../storage/sqlite.storage';
import { Storage } from '../storage/storage';

class Injecter {
  private storageInstance?: Storage;
  private exchangeInstance?: Exchange;

  public storage() {
    if (this.storageInstance) return this.storageInstance;
    const storageConfig = config.getStorage();
    if (!storageConfig?.type) throw new GekkoError('injecter', 'Missing or unknown storage.');
    const { pairs } = config.getWatch();
    this.storageInstance = new SQLiteStorage(pairs.map(({ symbol }) => symbol));
    return this.storageInstance;
  }

  /** Closes the storage if one was created. Unlike storage(), it never creates one, so it never throws for want of a configuration. */
  public closeStorage() {
    this.storageInstance?.close();
  }

  public exchange() {
    if (this.exchangeInstance) return this.exchangeInstance;
    const exchangeConfig = config.getExchange();
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

  /** Reset all singleton instances. Use only in tests. */
  public reset() {
    this.storageInstance = undefined;
    this.exchangeInstance = undefined;
  }
}

export const inject = new Injecter();
