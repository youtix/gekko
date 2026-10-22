import { Timeframe, Watch } from '@gekko/schemas/configuration/configuration.types';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { Asset, TradingPair } from '@gekko/shared/models/utility.types';
import type { RunContext } from '../run/runContext.types';
import { transitionalContext } from './plugin.helper';
import { Exchange } from '@gekko/shared/models/exchange.types';
import { Storage } from '../storage/storage';
import { SequentialEventEmitter } from './sequentialEventEmitter';
import { PluginMissingServiceError } from './plugin.error';

export abstract class Plugin extends SequentialEventEmitter {
  private storage?: Storage;
  private exchange?: Exchange;
  protected readonly timeframe: Timeframe;
  protected readonly warmupPeriod: number;
  protected readonly pluginName: string;
  protected readonly strategySettings: unknown;
  protected readonly mode: Watch['mode'];
  protected readonly pairs: TradingPair[];
  protected readonly assets: Asset[];
  protected readonly currency: Asset;
  /** The run's configuration and services, which a plugin hands to what it builds (the Trader to its orders) */
  protected readonly context: RunContext;

  // `context` is optional during the monorepo wave only: a plugin not yet converted runs on the transitional singletons
  constructor(pluginName: string, context?: RunContext) {
    super(pluginName);
    this.context = context ?? transitionalContext();
    const { timeframe, warmup, mode, pairs, assets, currency } = this.context.configuration.getWatch();

    this.strategySettings = this.context.configuration.getStrategy();

    this.pluginName = pluginName;
    this.timeframe = timeframe;
    this.warmupPeriod = warmup.candleCount;
    this.mode = mode;
    this.pairs = pairs.map(pair => pair.symbol);
    this.assets = assets;
    this.currency = currency;
  }

  /* -------------------------------------------------------------------------- */
  /*                         PLUGIN SERVICE ACCESSORS                           */
  /* -------------------------------------------------------------------------- */

  public setStorage(storage: Storage) {
    this.storage = storage;
  }

  public setExchange(exchange: Exchange) {
    this.exchange = exchange;
  }

  public getStorage() {
    if (!this.storage) throw new PluginMissingServiceError(this.pluginName, 'storage');
    return this.storage;
  }

  public getExchange() {
    if (!this.exchange) throw new PluginMissingServiceError(this.pluginName, 'exchange');
    return this.exchange;
  }

  /* -------------------------------------------------------------------------- */
  /*                         PLUGIN LIFECYCLE HOOKS                             */
  /* -------------------------------------------------------------------------- */

  /** Invoked once immediately after plugin instantiation before any candles are processed. */
  public async processInitStream() {
    await this.processInit();
  }

  /** Executed for every new CandleBucket after it passes through the stream pipeline. */
  public async processInputStream(bucket: CandleBucket) {
    await this.processOneMinuteBucket(bucket);
  }

  /** Invoked once when the stream pipeline terminates, with the error that stops the run before its end, if any. */
  public async processCloseStream(failure?: Error) {
    await this.processFinalize(failure);
  }

  protected abstract processInit(): void;
  protected abstract processOneMinuteBucket(bucket: CandleBucket): void;
  /** `failure` is set when the run stops on an error (an ApplicationStopError included): the run is then partial. */
  protected abstract processFinalize(failure?: Error): void;
}
