import { Timeframe, Watch } from '@gekko/schemas/configuration/configuration.types';
import { CandleBucket } from '@gekko/shared/models/event.types';
import { Asset, TradingPair } from '@gekko/shared/models/utility.types';
import type { RunContext } from '../run/runContext.types';
import { Exchange } from '@gekko/shared/models/exchange.types';
import { Storage } from '../storage/storage';
import { SequentialEventEmitter } from './sequentialEventEmitter';
import { PluginMissingServiceError } from './plugin.error';

/**
 * The base of every plugin. The pipeline builds each one (createPlugins) from its options, the output of its own schema, and from the
 * run's context: the configuration, of which the base keeps the watch (its timeframe, warmup, mode, pairs, assets and currency) and the
 * strategy block, and the services the run shares. A plugin reads its configuration there, never from a module, and hands the context,
 * or what it reads of it, to what it builds: the Trader the context to its orders, the TradingAdvisor the strategy block to its
 * StrategyManager. The services its static configuration names in `inject` are handed to it by the pipeline once it is built, through
 * setExchange and setStorage: getExchange and getStorage return them from processInit onwards.
 */
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

  constructor(pluginName: string, context: RunContext) {
    super(pluginName);
    this.context = context;
    const { timeframe, warmup, mode, pairs, assets, currency } = context.configuration.getWatch();

    this.strategySettings = context.configuration.getStrategy();

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
