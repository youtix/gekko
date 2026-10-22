import {
  STRATEGY_CANCEL_ORDER_EVENT,
  STRATEGY_CREATE_ORDER_EVENT,
  STRATEGY_INFO_EVENT,
  STRATEGY_WARMUP_COMPLETED_EVENT,
  TIMEFRAME_CANDLE_EVENT,
} from '@gekko/shared/constants/event.const';
import { TIMEFRAME_TO_MINUTES } from '@gekko/shared/constants/timeframe.const';
import { describeError } from '@gekko/shared/errors/error.helper';
import { AdviceCancelOrder, AdviceOrder } from '@gekko/shared/models/advice.types';
import {
  CandleBucket,
  OrderCanceledEvent,
  OrderCompletedEvent,
  OrderErroredEvent,
  OrderInitiatedEvent,
} from '@gekko/shared/models/event.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { StrategyInfo } from '@gekko/shared/models/strategyInfo.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { Plugin } from '@gekko/core/plugin/plugin';
import type { RunContext } from '@gekko/core/run/runContext.types';
import { CandleBucketBatcher } from '@gekko/core/core/batcher/candleBatcher/candleBucketBatcher';
import { MarketData, OpenOrder } from '@gekko/shared/models/exchange.types';
import { error, info } from '@gekko/core/logger/logger';
import { StrategyManager } from './strategyManager';
import { isFetchedPortfolio } from '@gekko/shared/helpers/portfolio/portfolio.helper';
import { bindAll, filter } from 'lodash-es';
import { tradingAdvisorSchema } from '@gekko/schemas/plugins/tradingAdvisor.schema';
import { TradingAdvisorConfiguration } from './tradingAdvisor.types';

export class TradingAdvisor extends Plugin {
  private bucketBatcher: CandleBucketBatcher;
  private strategyName: string;
  private strategyPath?: string;
  private strategyManager?: StrategyManager;
  private maxConsecutiveErrors: number;

  constructor({ name, strategyName, strategyPath, maxConsecutiveErrors }: TradingAdvisorConfiguration, context: RunContext) {
    super(name, context);
    this.strategyName = strategyName;
    this.strategyPath = strategyPath;
    this.maxConsecutiveErrors = maxConsecutiveErrors;

    const timeframeInMinutes = TIMEFRAME_TO_MINUTES[this.timeframe!]; // Timeframe will always defined in thanks to zod super refine
    this.bucketBatcher = new CandleBucketBatcher(this.pairs, timeframeInMinutes);

    const relayers = filter(Object.getOwnPropertyNames(TradingAdvisor.prototype), p => p.startsWith('relay'));
    bindAll(this, [...relayers]);
  }

  // --- BEGIN INTERNALS ---
  private async setUpStrategy() {
    this.strategyManager = new StrategyManager(this.context.configuration.getStrategy(), this.warmupPeriod, this.maxConsecutiveErrors);
    await this.strategyManager.createStrategy(this.strategyName, this.strategyPath);
  }

  private setUpListeners() {
    this.strategyManager
      ?.on(STRATEGY_WARMUP_COMPLETED_EVENT, this.relayStrategyWarmupCompleted)
      .on(STRATEGY_CREATE_ORDER_EVENT, this.relayCreateOrder)
      .on(STRATEGY_CANCEL_ORDER_EVENT, this.relayCancelOrder)
      .on(STRATEGY_INFO_EVENT, this.relayStrategyInfo);
  }

  /**
   * Gives the strategy the portfolio the last of these order events carries, which the Trader read once the order had ended: the candle
   * hooks get it from the next candle on. Only a portfolio change refreshed it, which the Trader's portfolioUpdates filter holds back
   * for a fill below its threshold: the candle hooks kept the balance from before the fill, and an all-in order sized on it was refused.
   * The last event of a batch carries the latest portfolio: the Trader queues each one with the portfolio it read last.
   */
  private refreshPortfolio(payloads: OrderInitiatedEvent[]) {
    const { portfolio } = payloads[payloads.length - 1].exchange;
    if (isFetchedPortfolio(portfolio)) this.strategyManager?.onPortfolioChange(portfolio);
  }

  /* -------------------------------------------------------------------------- */
  /*                           EVENTS EMITERS                                   */
  /* -------------------------------------------------------------------------- */

  private relayStrategyWarmupCompleted(event: CandleBucket) {
    this.addDeferredEmit<CandleBucket>(STRATEGY_WARMUP_COMPLETED_EVENT, event);
  }

  private relayCancelOrder(advice: AdviceCancelOrder) {
    this.addDeferredEmit<AdviceCancelOrder>(STRATEGY_CANCEL_ORDER_EVENT, advice);
  }

  private relayCreateOrder(advice: AdviceOrder) {
    this.addDeferredEmit<AdviceOrder>(STRATEGY_CREATE_ORDER_EVENT, advice);
  }

  /**
   * Queues a line of the strategy with the events of the bucket, but an error line, delivered at once: tools.log('error') throws, which
   * fails the bucket, and the events a failed bucket queued are dropped (see PluginsStream), so the line saying why the bot stopped
   * never reached the strat_info subscribers. Its listeners get it in an array, as they get the deferred events. A strategy that catches
   * the error and goes on has the line delivered ahead of those it logged before it in the bucket.
   */
  private relayStrategyInfo(strategyInfo: StrategyInfo) {
    if (strategyInfo.level !== 'error') {
      this.addDeferredEmit<StrategyInfo>(STRATEGY_INFO_EVENT, strategyInfo);
      return;
    }
    this.emit<StrategyInfo[]>(STRATEGY_INFO_EVENT, [strategyInfo]).catch((err: unknown) =>
      error('trading advisor', `A listener failed on the error line of the strategy: ${describeError(err)}`),
    );
  }

  /* -------------------------------------------------------------------------- */
  /*                          EVENT LISTENERS                                   */
  /* -------------------------------------------------------------------------- */

  // The order handlers relay their batch one order after the other, in the order the Trader queued it, then the portfolio of its last
  // order. The hooks are synchronous: under an `await Promise.all` they only seemed to run together, and one that throws (the circuit
  // breaker) stops the batch there either way.

  public onOrderCompleted(payloads: OrderCompletedEvent[]) {
    for (const payload of payloads) this.strategyManager?.onOrderCompleted(payload);
    this.refreshPortfolio(payloads);
  }

  public onOrderCanceled(payloads: OrderCanceledEvent[]) {
    for (const payload of payloads) this.strategyManager?.onOrderCanceled(payload);
    this.refreshPortfolio(payloads);
  }

  public onOrderErrored(payloads: OrderErroredEvent[]) {
    for (const payload of payloads) this.strategyManager?.onOrderErrored(payload);
    this.refreshPortfolio(payloads);
  }

  public onPortfolioChange(payloads: Portfolio[]) {
    const portfolio = payloads[payloads.length - 1];
    this.strategyManager?.onPortfolioChange(portfolio);
  }

  /* -------------------------------------------------------------------------- */
  /*                         PLUGIN LIFECYCLE HOOKS                             */
  /* -------------------------------------------------------------------------- */

  protected async processInit() {
    await this.setUpStrategy();
    this.setUpListeners();

    // Set up market data for all watched pairs
    const exchange = this.getExchange();
    const allMarketData = new Map<TradingPair, MarketData>();
    for (const symbol of this.pairs) allMarketData.set(symbol, exchange.getMarketData(symbol));
    this.strategyManager?.setMarketData(allMarketData);

    // The orders open on each watched pair before this run places any, which init gets (see InitParams.openOrders). A strategy keeps
    // its orders in memory: restarted, GridBot could not tell the grid its previous run had left on the exchange, and built a second
    // one beside it, whose fills never reached it, or stopped for want of free funds, again at every restart.
    const openOrders = new Map<TradingPair, OpenOrder[]>();
    for (const symbol of this.pairs) openOrders.set(symbol, await exchange.fetchOpenOrders(symbol));
    this.strategyManager?.setOpenOrders(openOrders);

    const balance = await exchange.fetchBalance();
    this.strategyManager?.onPortfolioChange(balance);
    info('trading advisor', `Using the strategy: ${this.strategyName}`);
  }

  protected processOneMinuteBucket(bucket: CandleBucket) {
    // The strategy's init runs on the first bucket (see StrategyManager.onOneMinuteBucket), before any timeframe candle
    this.strategyManager?.onOneMinuteBucket(bucket);

    const timeframeBucket = this.bucketBatcher.addBucket(bucket);
    if (timeframeBucket) {
      // Queued after the hooks, and so after the warmup event of the same candle, which the PortfolioAnalyzer waits for before it marks
      // a candle. The hooks got their own copy of the bucket (see StrategyManager.onTimeFrameCandle): what they wrote is not in this one.
      this.strategyManager?.onTimeFrameCandle(timeframeBucket);
      this.addDeferredEmit<CandleBucket>(TIMEFRAME_CANDLE_EVENT, timeframeBucket);
    }
  }

  protected processFinalize(failure?: Error) {
    this.strategyManager?.onStrategyEnd(failure);
  }

  /* -------------------------------------------------------------------------- */
  /*                           PLUGIN CONFIGURATION                             */
  /* -------------------------------------------------------------------------- */

  public static getStaticConfiguration() {
    return {
      name: 'TradingAdvisor',
      schema: tradingAdvisorSchema,
      modes: ['realtime', 'backtest'],
      dependencies: [],
      inject: ['exchange'],
      eventsHandlers: filter(Object.getOwnPropertyNames(TradingAdvisor.prototype), p => p.startsWith('on')),
      eventsEmitted: [
        STRATEGY_INFO_EVENT,
        STRATEGY_CREATE_ORDER_EVENT,
        STRATEGY_CANCEL_ORDER_EVENT,
        STRATEGY_WARMUP_COMPLETED_EVENT,
        TIMEFRAME_CANDLE_EVENT,
      ],
    } as const;
  }
}
