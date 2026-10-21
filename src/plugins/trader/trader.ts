import {
  ORDER_CANCELED_EVENT,
  ORDER_COMPLETED_EVENT,
  ORDER_ERRORED_EVENT,
  ORDER_INITIATED_EVENT,
  ORDER_INVALID_EVENT,
  ORDER_PARTIALLY_FILLED_EVENT,
  ORDER_STATUS_CHANGED_EVENT,
  PORTFOLIO_CHANGE_EVENT,
} from '@constants/event.const';
import { FEE_BUFFER_PERCENT } from '@constants/order.const';
import { ONE_MINUTE } from '@constants/time.const';
import { describeError } from '@errors/error.helper';
import { getFirstCandleFromBucket } from '@helpers/candle/candle.helper';
import { getMarketOrderLimits, getSentCost, toBound } from '@helpers/market/market.helper';
import { getAllInBuyAmount, getAllocatedShare, getBuyBudget, getSellAmountOfCost } from '@helpers/order/sizing.helper';
import { clonePortfolio, createEmptyPortfolio, getAssetBalance, isFetchedPortfolio } from '@helpers/portfolio/portfolio.helper';
import { AdviceCancelOrder, AdviceOrder } from '@models/advice.types';
import {
  CandleBucket,
  ExchangeEvent,
  OrderCanceledEvent,
  OrderCompletedEvent,
  OrderErroredEvent,
  OrderInitiatedEvent,
} from '@models/event.types';
import { OrderType } from '@models/order.types';
import { Portfolio } from '@models/portfolio.types';
import { TradingPair } from '@models/utility.types';
import { Plugin } from '@plugins/plugin';
import { config } from '@services/configuration/configuration';
import { OrderErrorEventPayload, OrderSummary } from '@services/core/order/order.types';
import { debug, error, info, warning } from '@services/logger';
import { toISOString } from '@utils/date/date.utils';
import { addPrecise, isFiniteNumber, isFinitePositive, multiplyPrecise } from '@utils/math/math.utils';
import { formatEveryDecimal } from '@utils/string/string.utils';
import { filter, isNil, noop, pick, uniqBy } from 'lodash-es';
import { UUID } from 'node:crypto';
import { ORDER_FACTORY, SIZING_KEYS } from './trader.const';
import {
  computeOrderPricing,
  describeAllocationBase,
  describeBuysPlacedSince,
  describeMaximumSent,
  getBacktestModeIntervalSyncTime,
  PortfolioUpdatesConfig,
  shouldEmitPortfolio,
  ShouldEmitPortfolioParams,
} from './trader.helper';
import { traderSchema } from './trader.schema';
import {
  Budget,
  CheckOrderSummaryParams,
  FreeBalanceLeft,
  OrderCancelation,
  OrderInstance,
  OrderRejection,
  RelayedOrder,
  TraderOrderMetadata,
  UnreadOrder,
} from './trader.types';

export class Trader extends Plugin {
  private readonly orders: Map<UUID, TraderOrderMetadata>;
  private readonly portfolioUpdatesConfig: PortfolioUpdatesConfig | null;

  private portfolio: Portfolio = createEmptyPortfolio();
  /**
   * When the Trader read the portfolio, which the events of the orders carry beside it (see ExchangeEvent.portfolioReadAt): the wall
   * clock once the exchange answered, in a backtest too. Undefined for the empty portfolio it starts with, before any read.
   */
  private portfolioReadAt?: EpochTimeStamp;
  /**
   * What the Trader's own BUYs held of each currency at the last balance read, by currency: what that read shows taken from it, reserved
   * or spent (see readHeldByOpenBuys). A BUY by its allocation asks for its share of the currency read and of this (see getBudget).
   */
  private heldByOpenBuys = new Map<string, number>();
  private prices: Map<TradingPair, number> = new Map();
  private currentTimestamp: EpochTimeStamp = 0;
  private syncInterval: NodeJS.Timeout | null = null;
  private lastEmittedPortfolio: Portfolio | null = null;
  /** The synchronization in flight, if any (see synchronize) */
  private synchronization: Promise<void> | null = null;
  /** How many synchronizations have started: whoever notes the count knows which ones read the exchange after that moment */
  private synchronizationCount = 0;
  /**
   * What may still queue the end of an order: the reports in flight (see relayTerminalEvents), and the launches and cancelations
   * sent, whose answer may end the order and so start a report. Each one leaves the set once settled. None rejects: each catches
   * its own failures.
   */
  private readonly pendingReports = new Set<Promise<void>>();
  /**
   * The orders placed since the balance was read, by id: what each one takes from a free balance that read does not show, and the
   * count of synchronizations started when it was placed. A SELL takes its amount of the asset (see sizeSell), a BUY what it may spend
   * of the currency (see sizeOrder, sizeAllInBuy and sizeBudgetBuy). A synchronization started after an order reads a balance that
   * shows it, filled or reserved: the order is forgotten once that synchronization has read the balance. An order the strategy cancels
   * takes no more than what it filled before the cancelation, as far as the exchange reported it (see onStrategyCancelOrder): the
   * exchange gets the cancelation before any order sent after it, and releases what the order reserved for the rest, not what it spent
   * or sold.
   */
  private readonly unreadOrders = new Map<UUID, UnreadOrder>();

  constructor(parameters?: { portfolioUpdates?: PortfolioUpdatesConfig }) {
    // Not Trader.name: a minified build (bun build --minify) renames the class, and the Trader logged its events and failures as "GO"
    super('Trader');
    this.orders = new Map();
    this.portfolioUpdatesConfig = parameters?.portfolioUpdates ?? null;
  }

  /* -------------------------------------------------------------------------- */
  /*                              SYNCHRONIZATION                               */
  /* -------------------------------------------------------------------------- */

  /**
   * Reads the portfolio and the prices from the exchange again, and emits the portfolio. One synchronization at a time: two in
   * flight could end in any order, the older one overwriting what the newer one read, and each would emit the portfolio. A call made
   * while one is in flight joins it, and shares its outcome.
   *
   * Unless it started too early for the caller. An order that ended filled or canceled changed the portfolio (a fill, the release of
   * what the order reserved), and so may one that ended in error or refused (see relayError): its event carries the portfolio after
   * that change. `startedAfter` is then the count of synchronizations started when the order ended, and one started before may have
   * read the exchange too early. The caller waits for it to end, then joins the next one, which all such callers share.
   *
   * Not async, so that the promise returned is the synchronization itself, and a caller resumes right after it ends.
   */
  private synchronize(startedAfter = 0): Promise<void> {
    if (!this.synchronization) return this.startSynchronization();
    if (this.synchronizationCount > startedAfter) return this.synchronization;
    return this.synchronizeOnceEnded(this.synchronization, startedAfter);
  }

  private startSynchronization() {
    this.synchronizationCount++;
    const synchronization = this.runSynchronization();
    this.synchronization = synchronization;
    // Registered first, it runs before the callers resume, and before any other synchronization can start. Its own promise always
    // fulfils: no unhandled rejection here, the failure is the callers' to handle.
    const release = () => {
      this.synchronization = null;
    };
    synchronization.then(release, release);
    return synchronization;
  }

  /** Waits for a synchronization to end, whatever its outcome (the failure is the callers' it was shared with), then synchronizes */
  private async synchronizeOnceEnded(synchronization: Promise<void>, startedAfter: number) {
    await synchronization.catch(noop);
    return this.synchronize(startedAfter);
  }

  private async runSynchronization() {
    const exchange = this.getExchange();
    // The number of this synchronization, which startSynchronization has just counted
    const synchronizationNumber = this.synchronizationCount;
    info('trader', `Synchronizing data with ${exchange.getExchangeName()}`);

    // Update portfolio, balance and prices
    this.portfolio = await exchange.fetchBalance();
    this.portfolioReadAt = Date.now();
    // A balance that shows the orders placed before this synchronization started: they take nothing more from it (see unreadOrders)
    for (const [id, { synchronizationCount }] of this.unreadOrders) {
      if (synchronizationCount < synchronizationNumber) this.unreadOrders.delete(id);
    }
    this.heldByOpenBuys = this.readHeldByOpenBuys(synchronizationNumber);
    const tickers = await exchange.fetchTickers(this.pairs);
    for (const symbol of this.pairs) {
      const price = tickers[symbol].bid;
      this.prices.set(symbol, price);
    }

    // Emit portfolio events if changes are detected. The filter holds back a change below its threshold, that of a fill included: the
    // end of an order carries the portfolio after it all the same (see relayError), which the TradingAdvisor and the analyzers take as
    // the latest
    if (this.portfolioUpdatesConfig) {
      const params: ShouldEmitPortfolioParams = {
        current: this.portfolio,
        lastEmitted: this.lastEmittedPortfolio,
        prices: this.prices,
        pairs: this.pairs,
        portfolioConfig: this.portfolioUpdatesConfig,
      };
      if (shouldEmitPortfolio(params)) {
        this.addDeferredEmit<Portfolio>(PORTFOLIO_CHANGE_EVENT, this.portfolio);
        this.lastEmittedPortfolio = clonePortfolio(this.portfolio);
      }
    } else {
      this.addDeferredEmit<Portfolio>(PORTFOLIO_CHANGE_EVENT, this.portfolio);
    }
  }

  /**
   * What the Trader's own BUYs held of each currency at the read of synchronization `synchronizationNumber`, by currency, which the read
   * shows taken from it: those placed before that synchronization started, but those whose completion had been heard by then, the read
   * showing them filled (see TraderOrderMetadata). Each holds its amount at the price it was created with, in decimal (see
   * multiplyPrecise), what it had filled included: the exchange reserves what is left of a resting BUY (Binance its amount at its price),
   * and its fills spent the rest. One the strategy had canceled before the read started holds what it had filled, as far as its fills
   * reported then: the exchange got the cancelation first, and released the rest. A STICKY or a MARKET BUY is counted at the market price
   * it was created at, which its moves and its fills may have left since.
   */
  private readHeldByOpenBuys(synchronizationNumber: number) {
    const held = new Map<string, number>();
    // A synchronization started after a count was noted reads a balance that shows what happened then
    const isRead = (count?: number) => !isNil(count) && count < synchronizationNumber;
    for (const order of this.orders.values()) {
      if (order.side !== 'BUY' || !isRead(order.synchronizationCount) || isRead(order.endSynchronizationCount)) continue;
      const holding = isRead(order.cancelSynchronizationCount) ? order.orderInstance.getFilledAmount() : order.amount;
      const cost = multiplyPrecise(holding, order.price);
      if (!isFinitePositive(cost)) continue;
      const [, currencyName] = order.symbol.split('/');
      held.set(currencyName, addPrecise(held.get(currencyName) ?? 0, cost));
    }
    return held;
  }

  /**
   * A synchronization nobody waits for: the first one, and the periodic ones in realtime. Skipped while one is in flight, whose
   * outcome it would only share. A failure is logged rather than thrown, which would make it an unhandled rejection: it is not
   * fatal, the next synchronization tries again.
   */
  private synchronizeInBackground() {
    if (this.synchronization) return debug('trader', 'Synchronization skipped: another one is in flight');
    this.synchronize().catch(err => error('trader', `Impossible to synchronize: ${describeError(err)}`));
  }

  /* -------------------------------------------------------------------------- */
  /*                               ORDER CHECKS                                 */
  /* -------------------------------------------------------------------------- */

  /**
   * In backtest, runs once per bucket the check an interval runs every orderSynchInterval in realtime, which nothing else runs there.
   * Only a STICKY order needs it: the check moves the order once the market has gone past its price, as live. Unchecked, it stayed at
   * the price of the minute it was placed at: never filled once the market had run away from it, or filled when the market came back,
   * at a better price than live. A LIMIT order rests at its price and a MARKET order executes at its creation: the simulated exchange
   * settles both through the callback of their creation, and a check would only read back what it reported, for every open order at
   * every minute (a grid keeps dozens open).
   * The simulated exchange settles the bucket before the plugins run (see PluginsStream): the check sees the fills of the minute, and
   * the close as the ticker. An order already over, whose report has not removed it yet, is still listed: its check does nothing. A
   * check reports its failures through the events of the order and never rejects: a rejection would only be logged, not fail the bucket.
   */
  private async checkStickyOrders() {
    const checks = [...this.orders]
      .filter(([, { type }]) => type === 'STICKY')
      .map(([id, { orderInstance, side, type }]) =>
        orderInstance
          .checkOrder()
          .catch(err => error('trader', `[${id}] Impossible to check the ${side} ${type} order: ${describeError(err)}`)),
      );
    await Promise.all(checks);
  }

  /* -------------------------------------------------------------------------- */
  /*                             PRIVATE FUNCTIONS                              */
  /* -------------------------------------------------------------------------- */

  /**
   * The amount `advice` is placed with, and what it takes from the free balance the last synchronization read (`balance`, see
   * unreadOrders): of the asset for a SELL, its amount (see sizeSell); of the currency for a BUY, what it may spend (see getBuyBudget),
   * all it was sized from for an all-in BUY (see sizeAllInBuy), its budget for one sized by its cost or by its allocation (see
   * sizeBudgetBuy). A BUY with an amount is placed as asked, never capped: the strategy chose it, and the exchange refuses it when the
   * market does not take it. How an order sized by its cost or by its allocation came out is then reported (see reportBudgetSizing), and
   * one the market refuses for its minimum amount or its minimum cost is warned of, as an all-in BUY is (see warnOfMarketMinimums).
   */
  private sizeOrder(advice: AdviceOrder, price: number, balance: FreeBalanceLeft): { amount: number; taken: number } {
    const budget = this.getBudget(advice, price, balance);
    if (advice.side === 'SELL') {
      const amount = this.sizeSell(advice, balance, budget);
      if (budget) this.reportBudgetSizing(advice, price, budget, amount);
      return { amount, taken: amount };
    }
    if (budget) {
      const sized = this.sizeBudgetBuy(advice, price, balance, budget);
      this.reportBudgetSizing(advice, price, budget, sized.amount);
      return sized;
    }
    if (isNil(advice.amount)) return this.sizeAllInBuy(advice, price, balance);
    return { amount: advice.amount, taken: getBuyBudget(advice.amount, price) };
  }

  /**
   * What an order sized by its cost or by its allocation asks for (see Budget), undefined for an order with an amount or an all-in one:
   * createOrder lets through one of the three at most. A BUY asks for the currency it may spend, the share DEFAULT_FEE_BUFFER keeps back
   * for the fee included: its cost, or its allocation of the currency the last synchronization read and of what the Trader's own BUYs
   * open at that read held of it (see readHeldByOpenBuys). A SELL asks for an amount of the asset: its allocation of the asset read, or
   * its cost over the price of the order, nothing kept back, the fee coming out of what it brings in. All worked out in decimal (see
   * getAllocatedShare and getSellAmountOfCost). A share is of the balance read, not of what the orders placed since leave: two BUYs of
   * 50 % on one candle are both sized from the whole of it, the second not from half of the rest.
   *
   * Nor of what the BUYs open at the read took from the currency, which the share of a BUY would otherwise depend on whether a
   * synchronization came between it and the BUYs before it: two pairs buying a candle apart, the first a STICKY or LIMIT BUY resting
   * across a synchronization, gave the second a share of what the first left, while the PositionBook counts the first pair, its BUY
   * pending, among those it shares the currency between, and a quarter of the capital stayed idle on two pairs. What such a BUY had
   * filled counts too, spent on its behalf: left out, the share of the next BUY shrank with every fill of the one resting. A SELL by its
   * allocation stays a share of the asset read: what a SELL open on it holds is not there to sell, and no strategy shares an asset
   * between SELLs as the PositionBook shares the currency between BUYs, its SELLs selling all of their asset.
   */
  private getBudget(advice: AdviceOrder, price: number, { read }: FreeBalanceLeft): Budget | undefined {
    const { id, side, type, symbol, cost, allocation } = advice;
    const [assetName, currencyName] = symbol.split('/');
    const order = `[${id}] ${side} ${type} order of`;
    if (!isNil(allocation)) {
      const unit = side === 'BUY' ? currencyName : assetName;
      const held = side === 'BUY' ? (this.heldByOpenBuys.get(currencyName) ?? 0) : 0;
      const asked = getAllocatedShare(held > 0 ? addPrecise(read, held) : read, allocation);
      const share = `${formatEveryDecimal(allocation)} % of ${describeAllocationBase(read, held, unit)}`;
      return { asked, label: `${order} ${formatEveryDecimal(asked)} ${unit} (${share})` };
    }
    if (isNil(cost)) return;
    if (side === 'BUY') return { asked: cost, label: `${order} ${formatEveryDecimal(cost)} ${currencyName}` };
    const asked = getSellAmountOfCost(cost, price);
    const notional = `${formatEveryDecimal(cost)} ${currencyName} at ${formatEveryDecimal(price)}`;
    return { asked, label: `${order} ${formatEveryDecimal(asked)} ${assetName} (${notional})` };
  }

  /**
   * The most the market takes in one order of the type of `advice`, in its asset: the maximum of the amount range of the market
   * (Binance's LOT_SIZE), narrowed for a MARKET order to that of a market order (Binance's MARKET_LOT_SIZE, see getMarketOrderLimits),
   * as the exchanges check an order before they send it. Undefined when the market sets none: a maximum that is not a finite number
   * above 0 sets nothing there either (see toBound: Binance disables a filter bound by setting it to 0).
   */
  private getMaximumAmount({ symbol, type }: AdviceOrder) {
    const marketData = this.getExchange().getMarketData(symbol);
    return toBound((type === 'MARKET' ? getMarketOrderLimits(marketData) : marketData).amount?.max);
  }

  /**
   * The amount a SELL is placed with: the amount asked for, that of a SELL sized by its cost or by its allocation (see getBudget), or,
   * for an all-in SELL, what the SELLs placed before it leave of the asset (see getFreeBalanceLeft), capped at two bounds. Above both,
   * it is capped at the lower one, and one warning says which, naming the cost or the allocation the amount came from.
   *
   * The free balance of its asset, which the exchange refuses to exceed. A strategy may ask for more without knowing it: the amount a
   * BUY filled, which the trailing stop of that BUY sells (see StrategyManager), is the amount of its trades, and the exchange may have
   * taken the fee of the BUY from the asset bought, as Binance does unless the fees are paid in BNB. The account then holds that amount
   * less the fee: the SELL of the whole was refused, an error counting towards the circuit breaker, the position left unprotected. The
   * simulated exchange takes its fees in the currency: a backtest never showed it. The balance is the one the last synchronization
   * read, which followed the end of the last order (see reportCompleted): the Trader does not read it again before placing an order.
   * Read once, it is the balance of every SELL placed until the next synchronization, less what the SELLs placed before take from it
   * (see getFreeBalanceLeft). Each SELL was capped against the whole of it: two SELLs of one asset, two trailing stops triggering on the
   * same minute or a stop's and the strategy's, each fitted while together they sold more than was held, and the second was refused,
   * its position left unprotected. Any amount is left as asked for while the balance is 0: maybe a portfolio not synchronized yet, or
   * one the SELLs placed before take whole, and a SELL of 0 would be refused anyway. The second is said at warn level with that cause, as
   * for an all-in SELL sized from nothing: the refusal names the balance, not the SELLs that took it, and an amount, a cost or an
   * allocation was sent unwarned while an all-in SELL was warned of. Left as asked, the SELL still goes through should one of those SELLs
   * be refused or canceled before it reaches the exchange, which a SELL of 0 never does.
   *
   * The most the market takes in one order of its type (see getMaximumAmount). LIMIT and STICKY BUYs can build a position larger than
   * one MARKET order can sell (Binance's MARKET_LOT_SIZE: tens of BTC on BTCUSDT, against 9000 for LOT_SIZE): the SELL of the whole,
   * the strategy's or its trailing stop's, was refused, and sent again at each signal or minute until the circuit breaker stopped the
   * bot, the position unsold. Capped, it sells what one order can, and the rest stays held, for the SELLs after it.
   *
   * An amount that is not a finite number is left as asked for: refused as before, rather than turned into the sale of every unit held,
   * or of the most the market takes.
   *
   * An all-in SELL sized from nothing (none of the asset free at the last synchronization, the SELLs placed since taking what was, or
   * no balance read yet) is sent for 0, which the limits of the market refuse, as they refuse an all-in BUY sized from no currency. It
   * is said at warn level, as for that BUY: the refusal names the amount of 0, not its cause. So is a SELL allocated a share of no asset.
   */
  private sizeSell(advice: AdviceOrder, balance: FreeBalanceLeft, budget?: Budget) {
    const { id, type, symbol } = advice;
    const [assetName] = symbol.split('/');
    const { read, taken, free } = balance;
    const requestedAmount = budget?.asked ?? advice.amount ?? free;
    if (isNil(advice.amount) && !(requestedAmount > 0)) {
      const sized = budget?.label ?? `[${id}] All-in SELL ${type} order sized from ${formatEveryDecimal(free)} ${assetName}`;
      const cause = this.getEmptyBalanceCause(balance, assetName, 'SELLs');
      warning('trader', `${sized}: ${formatEveryDecimal(requestedAmount)} ${assetName} sent, which the market refuses (${cause})`);
      return requestedAmount;
    }
    const isFiniteAmount = Number.isFinite(requestedAmount);
    const isAboveBalance = isFiniteAmount && free > 0 && requestedAmount > free;
    const maximum = this.getMaximumAmount(advice);
    const order = `${isNil(advice.amount) ? 'All-in SELL' : 'SELL'} ${type} order of ${formatEveryDecimal(requestedAmount)} ${assetName}`;
    const asked = budget?.label ?? `[${id}] ${order}`;

    if (isFiniteAmount && !isNil(maximum) && (isAboveBalance ? free : requestedAmount) > maximum) {
      warning('trader', `${asked} above ${describeMaximumSent(advice, maximum)}, the rest stays held`);
      return maximum;
    }
    if (!isAboveBalance) {
      if (isFinitePositive(requestedAmount) && read > 0 && !(free > 0)) {
        const sent = `${formatEveryDecimal(requestedAmount)} ${assetName} sent as asked`;
        const cause = this.getEmptyBalanceCause(balance, assetName, 'SELLs');
        warning('trader', `${asked}: ${sent}, which the market refuses unless some of the asset is free by then (${cause})`);
      }
      return requestedAmount;
    }
    const sent = `${asked} above the free balance: ${formatEveryDecimal(free)} ${assetName} sent, all that can be sold`;
    // The amount sent is then less than the free balance read: what the SELLs placed since take is said
    const placed = `less ${formatEveryDecimal(taken)} ${assetName} for the SELLs placed since`;
    const left = `${formatEveryDecimal(read)} ${assetName} free at the last synchronization, ${placed}`;
    warning('trader', taken > 0 ? `${sent} (${left})` : sent);
    return free;
  }

  /**
   * The amount of an all-in BUY, and what it takes from the currency read (see unreadOrders): what the currency left buys at the price
   * of the order, less the share DEFAULT_FEE_BUFFER keeps back for the fee, worked out in decimal (see getAllInBuyAmount): a whole
   * number of steps of the market comes out as that number, where the exchange truncating the amount to its step placed it one step
   * short. Left is the currency the last synchronization read, less what the BUYs placed since may spend of it (see getBuyBudget), an
   * all-in BUY all it was sized from. Each all-in BUY was sized from the whole of the currency read: two of them on one candle (two
   * entry signals, or two pairs of one currency), or a BUY then an all-in BUY, each fitted while together they spent more than was
   * held, and the second was refused, an error counting towards the circuit breaker. Sized from less than was read, it is said at warn
   * level. Once nothing is left, it is sized to 0, which the limits of the market refuse, as they refuse an all-in SELL once the SELLs
   * before it take the asset whole. Sized from no currency at all (none on the account, or no balance read yet), it is said at warn
   * level too: the refusal names the amount of 0, not its cause.
   *
   * Capped at the most the market takes in one order of its type (see capBuyAtMaximum), with a warning: all-in is as much as the market
   * takes, and above it the BUY was refused at each entry signal, an error counting towards the circuit breaker. It then takes from the
   * currency what it may spend (see getBuyBudget), and leaves the rest to the BUYs after it.
   *
   * Below a minimum of the market, its amount or its cost, it is warned of before it is sent, as a BUY sized by its cost or by its
   * allocation is (see warnOfMarketMinimums). An all-in BUY is the BUY of the signal strategies on one pair, and that of the last pair to
   * buy on several: refused unwarned, its reason named a cost the strategy never chose, the share kept back for the fee and the step
   * taken off, while a BUY allocated 100 %, sized to the same amount, was warned of.
   */
  private sizeAllInBuy(advice: AdviceOrder, price: number, currency: FreeBalanceLeft): { amount: number; taken: number } {
    const { id, type, symbol } = advice;
    const [assetName, currencyName] = symbol.split('/');
    const { read, taken, free } = currency;
    const amount = getAllInBuyAmount(free, price);
    const sized = `[${id}] All-in BUY ${type} order sized from ${formatEveryDecimal(free)} ${currencyName}`;
    const capped = this.capBuyAtMaximum(advice, price, sized, amount);
    if (capped) return capped;

    if (taken > 0) {
      warning('trader', `${sized}: ${formatEveryDecimal(amount)} ${assetName} sent (${describeBuysPlacedSince(currency, currencyName)})`);
    } else if (!(read > 0)) {
      const cause = this.getEmptyBalanceCause(currency, currencyName, 'BUYs');
      warning('trader', `${sized}: ${formatEveryDecimal(amount)} ${assetName} sent, which the market refuses (${cause})`);
    }
    this.warnOfMarketMinimums(advice, price, sized, amount);
    return { amount, taken: free };
  }

  /**
   * The amount of a BUY sized by its cost or by its allocation, and what it takes from the currency read (see unreadOrders): what its
   * budget buys at the price of the order, less the share DEFAULT_FEE_BUFFER keeps back for the fee, worked out in decimal as for an
   * all-in BUY (see getAllInBuyAmount). The budget is what the order asks for (see getBudget), capped at what the BUYs placed since the
   * last synchronization leave of the currency (see getFreeBalanceLeft), with a warning: above it, the BUY would be refused for want of
   * funds, an error counting towards the circuit breaker, where what is left still buys something. Capped at nothing, or a share of
   * nothing, it is sized to 0, which the limits of the market refuse, said at warn level with its cause, as for an all-in BUY: the
   * refusal names the amount of 0, not its cause.
   *
   * Capped at the most the market takes in one order of its type (see capBuyAtMaximum), with a warning, as an all-in BUY is: it then
   * takes from the currency what it may spend (see getBuyBudget), and leaves the rest to the BUYs after it. Otherwise it takes its
   * budget. An allocation of 100 % is an all-in BUY: the same amount, taking as much of the currency, warned of in the same cases, but
   * when the last synchronization read BUYs of the Trader open: its share, of what they held too, is then above what is left, and capped
   * at it with a warning (see getBudget).
   */
  private sizeBudgetBuy(advice: AdviceOrder, price: number, currency: FreeBalanceLeft, { asked, label }: Budget) {
    const [assetName, currencyName] = advice.symbol.split('/');
    const isCapped = asked > currency.free;
    const budget = isCapped ? currency.free : asked;
    const amount = getAllInBuyAmount(budget, price);
    const sized = isCapped ? `${label} above the free balance, sized from ${formatEveryDecimal(budget)} ${currencyName}` : label;
    const capped = this.capBuyAtMaximum(advice, price, sized, amount);
    if (capped) return capped;

    if (!(budget > 0)) {
      const cause = this.getEmptyBalanceCause(currency, currencyName, 'BUYs');
      warning('trader', `${label}: ${formatEveryDecimal(amount)} ${assetName} sent, which the market refuses (${cause})`);
    } else if (isCapped) {
      const sent = `${sized}: ${formatEveryDecimal(amount)} ${assetName} sent`;
      warning('trader', currency.taken > 0 ? `${sent} (${describeBuysPlacedSince(currency, currencyName)})` : sent);
    }
    return { amount, taken: budget };
  }

  /**
   * The sizing of a BUY without an amount (all-in, or sized by its cost or by its allocation) whose `amount` is above the most the market
   * takes in one order of its type (see getMaximumAmount): capped at it, with a warning that names the order and its sizing (`sized`),
   * what it buys and the maximum sent, it takes from the currency what that maximum may spend at its price (see getBuyBudget), and leaves
   * the rest to the BUYs after it. Undefined when the market takes the amount, sets no maximum, or the amount is not a finite number,
   * left as it is for the exchange to refuse, as a SELL of one is (see sizeSell): at a price so small that the currency buys an infinite
   * amount (5e-324, which the checks of a price let through), a BUY by its cost or its allocation was capped at the maximum, at that
   * price, where an all-in BUY was sent as it was.
   */
  private capBuyAtMaximum(advice: AdviceOrder, price: number, sized: string, amount: number) {
    const maximum = this.getMaximumAmount(advice);
    if (!Number.isFinite(amount) || isNil(maximum) || !(amount > maximum)) return;
    const [assetName, currencyName] = advice.symbol.split('/');
    const bought = `${formatEveryDecimal(amount)} ${assetName}, above ${describeMaximumSent(advice, maximum)}`;
    warning('trader', `${sized}: ${bought}, the rest of the ${currencyName} left unspent`);
    return { amount: maximum, taken: getBuyBudget(maximum, price) };
  }

  /**
   * Says at debug level how an order sized by its cost or by its allocation came out, its label (what it asks for, and of what) beside
   * the amount sized and its price, then warns of it before it is sent when the market refuses it for one of its minimums (see
   * warnOfMarketMinimums)
   */
  private reportBudgetSizing(advice: AdviceOrder, price: number, { label }: Budget, amount: number) {
    const [assetName] = advice.symbol.split('/');
    debug('trader', `${label} sized to ${formatEveryDecimal(amount)} ${assetName} at ${formatEveryDecimal(price)}`);
    this.warnOfMarketMinimums(advice, price, label, amount);
  }

  /**
   * Warns before it is sent of an order whose amount the Trader worked out, from its cost, from its allocation or all-in for a BUY, and
   * which the market refuses for one of its minimums, as both exchanges check them before they send an order (see
   * assertOrderWithinLimits): the amount, truncated to the amount step of the market as they send it, against the minimum amount, that of
   * a market order for a MARKET one (see getMarketOrderLimits), then its cost at the price of the order, worked out in decimal, against
   * the minimum cost (see getSentCost and toBound). `sized` names the order and its sizing, as its other lines do. Refused, the order is
   * an error counting towards the circuit breaker, whose reason names its amount or its cost, not the budget, the share or the currency
   * it was sized from. Valued as sized, an order the truncation took under the minimum cost was refused unwarned: 0.0000870833333333333
   * BTC at 60000 is 5.225 USDT, above a minimum of 5, and is sent as 0.00008 BTC, 4.8 USDT; the warning then says the amount truncated
   * and the step. A BUY costs less than its budget, the share DEFAULT_FEE_BUFFER keeps back for the fee: one whose budget is the minimum
   * cost is refused. One whose budget covered the minimum cost, but bought less than the minimum amount, was refused unwarned too: 6 USDT
   * at 10000 buy 0.00057 BTC, under a minimum of 0.001. One line at most, of the minimum the exchanges check first: an amount below both
   * is refused for its amount.
   *
   * The amount refused is the one sent, whatever price the exchange checks the order at. Its cost is valued at the price of the order: for
   * a MARKET or a STICKY order, the last close, or the bid of the last synchronization, while an exchange checks a market order at its
   * ticker as it creates it (the ask for a BUY, the bid for a SELL), and a limit order at its price rounded to its tick. In realtime the
   * two can lie on either side of the minimum: a BUY of 5.3 USDT at a close of 62499 is sent as 0.00008 BTC, 4.99992 USDT, under a minimum
   * of 5, which passes at an ask of 62501. So the line says that the market refuses that cost at that price, the one it names. In a
   * backtest the simulator checks a market order at the close.
   *
   * Not an order sized to 0, which is warned of with its cause (see sizeSell, sizeAllInBuy and sizeBudgetBuy), nor one the step cuts to 0,
   * whose refusal names the step. Nor an order with an amount, whose refusal names the amount the strategy chose, nor an all-in SELL,
   * whose amount is the asset free.
   */
  private warnOfMarketMinimums({ side, type, symbol }: AdviceOrder, price: number, sized: string, amount: number) {
    const [assetName, currencyName] = symbol.split('/');
    const marketData = this.getExchange().getMarketData(symbol);
    const limits = type === 'MARKET' ? getMarketOrderLimits(marketData) : marketData;
    const { sent, cost } = getSentCost(amount, price, limits);
    if (!(sent > 0)) return;
    const step = toBound(limits.precision?.amount);
    // An amount the step cuts is also said as the exchange takes it, the one its refusal names, or whose cost it names
    const onStep =
      isNil(step) || sent === amount
        ? ''
        : `, truncated to ${formatEveryDecimal(sent)} ${assetName} on the amount step ${formatEveryDecimal(step)} of the market`;
    const order = `${sized}: ${formatEveryDecimal(amount)} ${assetName} at ${formatEveryDecimal(price)} sent${onStep}`;

    const minimumAmount = toBound(limits.amount?.min);
    if (!isNil(minimumAmount) && sent < minimumAmount) {
      const below = `below the minimum amount of ${formatEveryDecimal(minimumAmount)} ${assetName} of a ${type} order on ${symbol}`;
      return warning('trader', `${order}, ${below}, which the market refuses`);
    }
    const minimumCost = toBound(limits.cost?.min);
    if (isNil(minimumCost) || !(cost < minimumCost)) return;
    const feeBuffer = side === 'BUY' ? ` once ${FEE_BUFFER_PERCENT} % is kept back for the fee` : '';
    const costSent = `a cost of ${formatEveryDecimal(cost)} ${currencyName}${feeBuffer}`;
    const below = `below the minimum cost of ${formatEveryDecimal(minimumCost)} ${currencyName} on ${symbol}`;
    warning('trader', `${order}, ${costSent}, ${below}, which the market refuses at that price`);
  }

  /**
   * The free balance of an asset a SELL can take, or of the currency a BUY can spend: the one the last synchronization read, less what
   * the orders placed since take from it (see unreadOrders), never below 0
   */
  private getFreeBalanceLeft(assetName: string): FreeBalanceLeft {
    const read = getAssetBalance(this.portfolio, assetName).free;
    const taken = filter([...this.unreadOrders.values()], { assetName }).reduce((sum, { amount }) => addPrecise(sum, amount), 0);
    return { read, taken, free: taken > 0 ? Math.max(addPrecise(read, -taken), 0) : read };
  }

  /**
   * Why an all-in order, or one sized by its cost or by its allocation, has nothing to be sized from, which its refusal for an amount of
   * 0 does not say: no balance read from the exchange yet, none of the asset free at the last synchronization, or the orders of its side
   * placed since taking what was
   */
  private getEmptyBalanceCause({ read, taken }: FreeBalanceLeft, assetName: string, placedSince: 'BUYs' | 'SELLs') {
    // Before any synchronization succeeded, the portfolio is the empty one the Trader starts with (see isFetchedPortfolio)
    if (!isFetchedPortfolio(this.portfolio)) return 'no balance read from the exchange yet';
    const free = `${formatEveryDecimal(read)} ${assetName} free at the last synchronization`;
    return taken > 0 ? `${free}, less ${formatEveryDecimal(taken)} ${assetName} for the ${placedSince} placed since` : free;
  }

  /**
   * The last price known for a pair, which the events of its orders carry (see ExchangeEvent): the close of the last candle, or the bid
   * of the last synchronization, whichever came last. 0 when none is known, as for a pair that is not watched.
   */
  private getLastPrice(symbol: TradingPair) {
    return this.prices.get(symbol) || 0;
  }

  /**
   * What the events of an order of `symbol` say of the exchange (see ExchangeEvent): the last price of the pair, the portfolio the
   * Trader read last, and when it read it, undefined before any read
   */
  private getExchangeEvent(symbol: TradingPair): ExchangeEvent {
    return { price: this.getLastPrice(symbol), portfolio: this.portfolio, portfolioReadAt: this.portfolioReadAt };
  }

  /**
   * The completed event of an order from its summary, whose figures are usable numbers: the exchange's, checked, or an estimate (see
   * summarizeCompletedOrder). Only the fee rate may be unknown, the fee then taken as 0 (see computeOrderPricing).
   */
  private checkOrderSummary({ id, symbol, type, orderCreationDate, summary }: CheckOrderSummaryParams): OrderCompletedEvent {
    const { amount, price, feePercent, side, orderExecutionDate } = summary;
    const { effectivePrice, fee } = computeOrderPricing(side, price, amount, feePercent);

    if (!isFiniteNumber(feePercent)) warning('trader', 'Exchange did not provide fee information, assuming no fees.');
    info(
      'trader',
      [
        `[${id}] ${side} ${type} order summary for ${symbol}:`,
        `Completed at: ${toISOString(orderExecutionDate)}`,
        `Order amount: ${amount},`,
        `Effective price: ${effectivePrice},`,
        `Fee: ${fee},`,
        `Fee percent: ${feePercent},`,
      ].join(' '),
    );

    const order = { ...summary, id, orderCreationDate, type, fee, effectivePrice, symbol };
    return { order, exchange: this.getExchangeEvent(symbol) };
  }

  /**
   * The summary of a completed order. A fill is a fact: the order executed, and the position changed on the exchange. When the
   * exchange cannot summarize it (its trades out of reach once the retries are spent, or any failure after the fill), the summary is
   * estimated instead (see estimateOrderSummary), and the strategy still hears of a fill. Relayed as an error, it counted towards
   * the circuit breaker, dropped the trailing stop of the position the order opened, and let a strategy place the order again.
   *
   * So is a summary without a usable amount, price or execution date: createOrderSummary resolves with NaN ones when none of the
   * trades of the account matches the order (fetched from a bound past its fills, beyond the pages fetched, or not listed yet by the
   * exchange). Relayed as they were, they armed the trailing stop of the position with an amount of NaN, whose SELL was refused,
   * and the analyzers skipped or misdated the fill.
   */
  private async summarizeCompletedOrder(orderInstance: OrderInstance, order: RelayedOrder, creationPrice: number) {
    let reason: string;
    try {
      const summary = await orderInstance.createSummary();
      const { amount, price, orderExecutionDate } = summary;
      if (isFinitePositive(amount) && isFinitePositive(price) && Number.isFinite(orderExecutionDate)) return summary;
      reason = `its trades were not found, or not usable (amount ${amount}, price ${price}, executed at ${toISOString(orderExecutionDate)})`;
    } catch (err) {
      reason = `its summary could not be created: ${describeError(err)}`;
    }
    return this.estimateOrderSummary(orderInstance, order, reason, creationPrice);
  }

  /**
   * A summary of a filled order estimated from what the Trader and the order know, for when the exchange gives none. It is logged
   * as an error, with `reason`, which completes "order filled, but", and the source of each figure:
   * - amount: the fills the order recorded, as the exchange reported them. Without any, the amount ordered, which a filled order
   *   executed in full, up to the lot rounding of the exchange.
   * - price: see estimateExecutionPrice.
   * - fee: unknown, which computeOrderPricing takes as no fee.
   * - execution date: the order does not know when it was filled: the end of the last minute processed.
   */
  private estimateOrderSummary(orderInstance: OrderInstance, order: RelayedOrder, reason: string, creationPrice: number): OrderSummary {
    const { id, side, type } = order;
    const filledAmount = orderInstance.getFilledAmount();
    const isFillReported = filledAmount > 0;
    const amount = isFillReported ? filledAmount : order.amount;
    const amountSource = isFillReported
      ? 'the fill reported'
      : 'the amount ordered: no fill reported, and a filled order executed it in full, up to lot rounding';
    const { price, priceSource } = this.estimateExecutionPrice(orderInstance, order, creationPrice);

    error(
      'trader',
      [
        `[${id}] ${side} ${type} order filled, but ${reason}. Its summary is estimated:`,
        `amount ${amount} (${amountSource}),`,
        `price ${price} (${priceSource}),`,
        'fee unknown,',
        `executed at ${toISOString(this.currentTimestamp)} (the end of the last minute processed)`,
      ].join(' '),
    );
    return { amount, price, side, feePercent: undefined, orderExecutionDate: this.currentTimestamp };
  }

  /**
   * The price a filled order executed at, estimated (see estimateOrderSummary): first, the price of its fills, for a LIMIT or STICKY
   * order (see getFillPrice). A STICKY order was estimated at the market, which it follows, whatever its transactions filled at: one that
   * rested at 100.01 and filled before the market fell to 99 was reported at 99. Without them, a LIMIT order executed at its price. Any
   * other one at the market: the last price known, else the price the order was created with, which comes with the report (see
   * relayTerminalEvents) whatever the orders the Trader still lists: an estimate never has a price of NaN.
   */
  private estimateExecutionPrice(orderInstance: OrderInstance, { symbol, type }: RelayedOrder, creationPrice: number) {
    const fillPrice = this.getFillPrice(orderInstance, type);
    if (!isNil(fillPrice)) return { price: fillPrice, priceSource: 'the prices of its fills, as the exchange reported them' };
    if (type === 'LIMIT') return { price: creationPrice, priceSource: 'its limit price' };

    const marketPrice = this.getLastPrice(symbol);
    if (marketPrice > 0) return { price: marketPrice, priceSource: 'the last market price' };
    return { price: creationPrice, priceSource: 'the price it was created with: no market price known' };
  }

  /**
   * The price of what an order filled, as the exchange reported its fills, weighted by them (see Order.getAverageFillPrice), for a LIMIT
   * or a STICKY order: both place limit orders, which execute at their price, or better. Not for a MARKET order: the price reported for
   * it can be the bound of its slippage, Hyperliquid placing it as a limit order 5 % beyond the market. Undefined when none is known.
   */
  private getFillPrice(orderInstance: OrderInstance, type: OrderType) {
    return type === 'MARKET' ? undefined : orderInstance.getAverageFillPrice();
  }

  /**
   * Forgets an order that ended in error, or that the exchange refused, then relays ORDER_ERRORED_EVENT with the portfolio from a
   * synchronization started after that end (`startedAfter`, see synchronize), as every report does. Either may follow a change of
   * the portfolio: an error may come after the order executed, in part or in full (a STICKY order reports what it had already
   * filled, a poll can fail for good after a fill, a creation whose outcome is unknown may be live), and the relaunch of a STICKY
   * order is refused once its move has canceled the transaction before, releasing what it reserved. The synchronization is best
   * effort, here as in every report: a failure is logged, and the event leaves with the portfolio known, since the strategy waits
   * for it whatever happens.
   * The event carries what the order had filled (`filled`, see Order.getFilledAmount): only a STICKY order's reason told it, in words,
   * and a BUY that errored after a fill lost the trailing stop of the coins it had bought (see StrategyManager.onOrderErrored). It
   * carries `mayBeLive` as the order said it (see Order.orderErrored), false for a refusal: GridBot could only read it from the words of
   * a creation lost on the network.
   */
  private async relayError(order: RelayedOrder, reason: string, startedAfter: number, filled: number, mayBeLive: boolean) {
    this.orders.delete(order.id);
    try {
      await this.synchronize(startedAfter);
    } catch (err) {
      error('trader', `[${order.id}] Impossible to synchronize: ${describeError(err)}`);
    }
    this.addDeferredEmit<OrderErroredEvent>(ORDER_ERRORED_EVENT, {
      order: { ...order, reason, orderErrorDate: this.currentTimestamp, filled, mayBeLive },
      exchange: this.getExchangeEvent(order.symbol),
    });
  }

  /* -------------------------------------------------------------------------- */
  /*                            ORDER TERMINAL EVENTS                           */
  /* -------------------------------------------------------------------------- */

  /**
   * Relays the end of an order to the strategy, which waits for an ORDER_COMPLETED_EVENT, an ORDER_CANCELED_EVENT or an
   * ORDER_ERRORED_EVENT of every order it created. The four ways an order ends are listened to in both flows, creation and
   * cancelation: an order the strategy waits to see filled can be canceled by the exchange (expired, canceled from its interface),
   * and the creation a cancelation waits for can be refused.
   *
   * An EventEmitter ignores the promise an async listener returns: each report catches its own failures, which would otherwise
   * become unhandled rejections. Each one starts by removing every listener of the order, synchronously, before its first await:
   * the first terminal event an order emits is the only one relayed, a later one (a fill after an error, an error repeated) is
   * ignored, and the strategy hears once of each order. Doing so while the order emits is safe: an EventEmitter calls a copy of the
   * listeners it had when emit began, and the status and fill logs come first, emitted before the terminal event.
   *
   * A report queues its event several exchange calls after the order ended (the summary, the synchronization), and the events of a
   * bucket are flushed as soon as the plugins have processed it, and in realtime once more before they process the next (see
   * PluginsStream.deliversQueuedFirst). Each report is kept in pendingReports:
   * - in backtest, they are awaited before the events are flushed (see processOneMinuteBucket and broadcastDeferredEmit), and so are
   *   the launches and cancelations: the simulated exchange answers within a few ticks. The end of an order it settles with a bucket
   *   is delivered with that bucket, and that of an order it ends at once, created or canceled during the flush of the TradingAdvisor,
   *   in the flush of the Trader that follows. Left to race the flush, a fill reached the strategy and the analyzers one or two
   *   candles late, the count depending on how many ticks each step took (even on the STICKY orders open), and a fill on the last
   *   bucket was never delivered: nothing is flushed after processFinalize.
   * - in realtime, paper trading included, a report waits for the network: awaited, it would hold the bucket, and every plugin, for
   *   as long as the exchange takes to answer. It is delivered by the first delivery after it ends: as the next bucket arrives, before
   *   its hooks, when it ends between two buckets.
   *
   * `creationPrice` is the price the order was created with (see TraderOrderMetadata), which estimates the price of a fill the
   * exchange cannot summarize (see estimateExecutionPrice).
   */
  private relayTerminalEvents(orderInstance: OrderInstance, order: RelayedOrder, creationPrice: number) {
    orderInstance.once(ORDER_COMPLETED_EVENT, () => this.trackReport(this.reportCompleted(orderInstance, order, creationPrice)));
    orderInstance.once(ORDER_CANCELED_EVENT, (cancelation: OrderCancelation) =>
      this.trackReport(this.reportCanceled(orderInstance, order, cancelation)),
    );
    orderInstance.once(ORDER_ERRORED_EVENT, (failure: OrderErrorEventPayload) =>
      this.trackReport(this.reportErrored(orderInstance, order, failure)),
    );
    orderInstance.once(ORDER_INVALID_EVENT, (rejection: OrderRejection) =>
      this.trackReport(this.reportRejected(orderInstance, order, rejection, creationPrice)),
    );
  }

  /** Keeps a report, or a call that may start one, in pendingReports until it settles. It is returned as is. */
  private trackReport(report: Promise<void>) {
    this.pendingReports.add(report);
    const release = () => this.pendingReports.delete(report);
    report.then(release, release);
    return report;
  }

  /** Waits until no report is in flight: the one awaited may start another (a launch ends in a fill, which is then reported) */
  private async settlePendingReports() {
    while (this.pendingReports.size) await Promise.all(this.pendingReports);
  }

  /**
   * The fill, with its summary, estimated when the exchange cannot give it (see summarizeCompletedOrder), the portfolio after it, and
   * the cost or the allocation the strategy sized the order by, as the other events of the order relay them
   */
  private async reportCompleted(orderInstance: OrderInstance, order: RelayedOrder, creationPrice: number) {
    const { id, symbol, side, type, orderCreationDate } = order;
    try {
      orderInstance.removeAllListeners();
      const startedAfter = this.synchronizationCount;
      // Listed until its end is queued, it is no BUY open at the reads started from now on, which show its fill (see readHeldByOpenBuys)
      const metadata = this.orders.get(id);
      if (metadata) metadata.endSynchronizationCount = startedAfter;
      const summary = await this.summarizeCompletedOrder(orderInstance, order, creationPrice);
      // The portfolio after the fill, best effort (see relayError)
      try {
        await this.synchronize(startedAfter);
      } catch (err) {
        error('trader', `[${id}] Impossible to synchronize: ${describeError(err)}`);
      }
      const { order: completed, exchange } = this.checkOrderSummary({ id, symbol, type, orderCreationDate, summary });
      this.addDeferredEmit<OrderCompletedEvent>(ORDER_COMPLETED_EVENT, { order: { ...completed, ...pick(order, SIZING_KEYS) }, exchange });
      this.orders.delete(id);
    } catch (err) {
      error('trader', `[${id}] Impossible to report the completion of the ${side} ${type} order: ${describeError(err)}`);
    }
  }

  /**
   * The cancelation, whoever canceled the order: the strategy, or the exchange (expired, canceled from its interface), with what it
   * filled before, as far as the exchange reported it, and the price of that fill when one is known (see getFillPrice). Not `price`, the
   * one the strategy asked for, which a MARKET or a STICKY order is only sized by: the RoundTripAnalyzer booked such a fill at it.
   */
  private async reportCanceled(orderInstance: OrderInstance, order: RelayedOrder, cancelation: OrderCancelation) {
    const { id, symbol, side, type } = order;
    try {
      orderInstance.removeAllListeners();
      const startedAfter = this.synchronizationCount;
      const { timestamp, filled, remaining } = cancelation;
      // Left out by an order whose fill no answer of the exchange reported (see Order.getCancelationFill)
      const fill = isNil(filled) ? 'no fill reported' : `filled: ${filled}, remaining: ${remaining}`;
      info('trader', `[${id}] ${side} ${type} order canceled (${fill})`);
      this.orders.delete(id);
      // The portfolio once what the order reserved is released, best effort (see relayError)
      try {
        await this.synchronize(startedAfter);
      } catch (err) {
        error('trader', `[${id}] Impossible to synchronize: ${describeError(err)}`);
      }
      const fillPrice = this.getFillPrice(orderInstance, type);
      this.addDeferredEmit<OrderCanceledEvent>(ORDER_CANCELED_EVENT, {
        order: { ...order, orderCancelationDate: timestamp, filled, remaining, ...(!isNil(fillPrice) && { fillPrice }) },
        exchange: this.getExchangeEvent(symbol),
      });
    } catch (err) {
      error('trader', `[${id}] Impossible to report the cancelation of the ${side} ${type} order: ${describeError(err)}`);
    }
  }

  /**
   * The error, what the order filled before it, whether it may still be live, and the portfolio after it: the order may have executed
   * before (see relayError). One that may be live is said so: nothing follows it on the exchange any more.
   */
  private async reportErrored(orderInstance: OrderInstance, order: RelayedOrder, { reason, mayBeLive }: OrderErrorEventPayload) {
    const { id, side, type } = order;
    try {
      orderInstance.removeAllListeners();
      const startedAfter = this.synchronizationCount;
      const live = mayBeLive ? ', it may still be live on the exchange, where Gekko follows it no more' : '';
      error('trader', `[${id}] ${side} ${type} order: ${reason} (status: ERROR)${live}`);
      await this.relayError(order, reason, startedAfter, orderInstance.getFilledAmount(), mayBeLive);
    } catch (err) {
      error('trader', `[${id}] Impossible to report the error of the ${side} ${type} order: ${describeError(err)}`);
    }
  }

  /**
   * The refusal of the order by the exchange, which the strategy hears of as an error. Unless the order had executed part of what it
   * ordered: a STICKY order whose relaunch after a move is refused (see StickyOrder.handleCreateOrderError) is over with what its
   * earlier transactions filled, each of them seen canceled, nothing left on the exchange. That part is reported as a completion,
   * its summary created, or estimated (see reportCompleted), as when what is left is out of the limits of the market, which the
   * order takes for its fill (OrderOutOfRangeError). Relayed as an error, the strategy never heard of the fill, the trailing stop of
   * the position was not armed, and the analyzers missed it. The amount the order filled is read from it (see
   * Order.getFilledAmount): its rejection only says whether it filled anything.
   */
  private async reportRejected(orderInstance: OrderInstance, order: RelayedOrder, rejection: OrderRejection, creationPrice: number) {
    const { id, side, type, amount } = order;
    try {
      orderInstance.removeAllListeners();
      const startedAfter = this.synchronizationCount;
      const { reason, status, filled } = rejection;
      const filledAmount = orderInstance.getFilledAmount();
      if (filledAmount > 0) {
        const fill = `after ${filledAmount} of ${amount} filled: that part is reported as a completion`;
        warning('trader', `[${id}] ${side} ${type} order: ${reason} (status: ${status}), ${fill}`);
        await this.reportCompleted(orderInstance, order, creationPrice);
        return;
      }
      info('trader', `[${id}] ${side} ${type} order: ${reason} (filled: ${filled}, status: ${status})`);
      // Refused, it left nothing on the exchange
      await this.relayError(order, reason, startedAfter, filledAmount, false);
    } catch (err) {
      error('trader', `[${id}] Impossible to report the rejection of the ${side} ${type} order: ${describeError(err)}`);
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                             EVENT LISTENERS                                */
  /* -------------------------------------------------------------------------- */

  /**
   * Synchronizes with the exchange at the end of the warmup: the orders that follow are sized from the balance it reads. Like every
   * synchronization, it emits the portfolio unless the portfolioUpdates filter holds it back. That filter emits the first portfolio read
   * (at the start, see processInit), then a portfolio only when it moved since the last one emitted: an asset crossed the dust (a value
   * in the currency) either way, or the quantity of an asset held changed by more than the threshold, in % (see shouldEmitPortfolio).
   * With it, a balance that has not moved since is not emitted again. An emitted portfolio reaches the PortfolioAnalyzer once the
   * analyzer has taken its start equity, from the portfolio it held when the warmup completed. The bucket that ended the warmup was
   * processed as it arrived, like every bucket: nothing else is left to do. Best effort, like every synchronization of the plugin (see
   * relayError): a rejection leaving the handler would end the run (see PluginsStream), and the next synchronization tries again.
   */
  public async onStrategyWarmupCompleted(_bucket: CandleBucket[]) {
    try {
      await this.synchronize();
    } catch (err) {
      error('trader', `[warmup] Impossible to synchronize: ${describeError(err)}`);
    }
  }

  public async onStrategyCancelOrder(payloads: AdviceCancelOrder[]) {
    // Parallel strategy: process all payloads concurrently. An id asked twice in the same batch is canceled once: the payloads are
    // compared by their ids, each being a copy of its own (see copyPayload), which uniq, comparing references, would let through twice.
    await Promise.all(
      uniqBy(payloads, 'id').map(async ({ id }) => {
        const orderMetadata = this.orders.get(id);
        if (!orderMetadata) return warning('trader', `[${id}] Impossible to cancel order: Unknown Order`);
        const { orderInstance, side, amount, type, orderCreationDate, price, requestedPrice, symbol } = orderMetadata;
        // The exchange gets the cancelation before any order sent after it, and releases what the order reserved: kept whole, an order
        // placed since the balance was read went on taking from it, and an all-in order sent after the cancelation, to trade at the
        // market instead, left that out. Not what it filled before, spent (a BUY's currency) or sold (a SELL's asset), which that read
        // does not show either: forgotten, a SELL of the asset sent on the candle that canceled a LIMIT SELL which had sold 0.4 of its
        // 1 BTC was sized from the whole of it, and refused for want of funds, an error counting towards the circuit breaker
        const unread = this.unreadOrders.get(id);
        const filled = orderInstance.getFilledAmount();
        if (unread && filled > 0) {
          const spent = side === 'SELL' ? filled : getBuyBudget(filled, price);
          this.unreadOrders.set(id, { ...unread, amount: Math.min(unread.amount, spent) });
        } else this.unreadOrders.delete(id);
        // A BUY holds no more than that fill of the currency at a read started from now on (see readHeldByOpenBuys)
        orderMetadata.cancelSynchronizationCount = this.synchronizationCount;

        // From now on its updates are no longer logged, and its end is relayed as the creation flow relays it: with the price the
        // strategy asked for, if any, and the cost or the allocation it sized the order by. Not the price the order was created with
        // (see TraderOrderMetadata), the market price for an order without one, which the strategy and the EventSubscriber would read
        // as a requested limit price: that one only goes to the report, for the estimate of a fill.
        orderInstance.removeAllListeners();
        const relayed = { id, orderCreationDate, amount, side, type, price: requestedPrice, symbol, ...pick(orderMetadata, SIZING_KEYS) };
        this.relayTerminalEvents(orderInstance, relayed, price);

        // Cancel, without waiting: the outcome arrives through the terminal events. A failure is reported as ORDER_ERRORED_EVENT,
        // so a rejection is not expected, but it must not become an unhandled one. Tracked as a report: the simulated exchange
        // answers at once, and its answer ends the order (see relayTerminalEvents).
        this.trackReport(
          orderInstance
            .cancel()
            .catch(err => error('trader', `[${id}] Impossible to cancel the ${side} ${type} order: ${describeError(err)}`)),
        );
      }),
    );
  }

  public async onStrategyCreateOrder(payloads: AdviceOrder[]) {
    // Parallel strategy: process all payloads concurrently
    await Promise.all(
      payloads.map(async advice => {
        const { id, side, orderCreationDate, type, symbol } = advice;
        const price = advice.price ?? this.prices.get(symbol);
        // Unknown (a pair not watched), 0, negative or NaN: the order can be neither sized nor placed. The strategy already holds its
        // id and waits for a terminal event of it: it hears of it as an error, like an order the exchange refused. Nothing was
        // initiated and nothing changed on the exchange: no ORDER_INITIATED_EVENT, no synchronization, the event leaves with the
        // portfolio known.
        if (!price || price <= 0) {
          const reason = isNil(advice.price) ? `no price known for ${symbol}` : `invalid requested price ${advice.price}`;
          warning('trader', `[${id}] Impossible to create the ${side} ${type} order: ${reason}`);
          // The amount the strategy asked for, if any. Without one the order was to be sized as it is placed, all-in or from its cost or
          // its allocation (a BUY, and a SELL of a cost, from the price, missing or invalid here): never placed, it ordered nothing,
          // filled nothing, and nothing of it is live. Its cost or its allocation goes with it as asked.
          const order = {
            ...advice,
            amount: advice.amount ?? 0,
            reason,
            orderErrorDate: this.currentTimestamp,
            filled: 0,
            mayBeLive: false,
          };
          this.addDeferredEmit<OrderErroredEvent>(ORDER_ERRORED_EVENT, { order, exchange: this.getExchangeEvent(symbol) });
          return;
        }

        // Price cannot be zero here because we call processOneMinuteBucket before events (plugins stream)
        // We delegate the order validation (notional, lot, amount) to the exchange, but for the maximum amount the market takes in one
        // order, which a SELL and a BUY without an amount are capped at, and the minimum amount and cost an order sized by its cost or by
        // its allocation, or an all-in BUY, is warned of (see sizeOrder). An all-in SELL sells what the SELLs before it left of the asset,
        // an all-in BUY spends what the BUYs before it left of the currency, and a BUY sized by its cost or by its allocation its budget,
        // capped at that.
        const [assetName, currencyName] = symbol.split('/');
        const takenFrom = side === 'SELL' ? assetName : currencyName;
        const { amount, taken } = this.sizeOrder(advice, price, this.getFreeBalanceLeft(takenFrom));

        // Emit order initiated event
        const orderInitiated = { ...advice, amount, symbol };
        this.addDeferredEmit<OrderInitiatedEvent>(ORDER_INITIATED_EVENT, {
          order: orderInitiated,
          exchange: this.getExchangeEvent(symbol),
        });

        // Create order
        const orderInstance = new ORDER_FACTORY[type](symbol, id, side, amount, price);
        // With the cost or the allocation the strategy sized it by, if any, which the events of its cancelation flow relay as asked
        this.orders.set(id, {
          amount,
          side,
          orderCreationDate,
          type,
          price,
          requestedPrice: advice.price,
          orderInstance,
          symbol,
          synchronizationCount: this.synchronizationCount,
          ...pick(advice, SIZING_KEYS),
        });
        // Until the balance is read again, the orders after it can only take what it leaves (see unreadOrders): a SELL its amount of the
        // asset, a BUY what it may spend of the currency, an all-in BUY all it was sized from and a BUY sized by its cost or by its
        // allocation its budget, unless capped at the maximum of the market. Not an order that cannot be placed, which the exchange
        // refuses.
        if (isFinitePositive(amount) && isFinitePositive(taken)) {
          this.unreadOrders.set(id, { assetName: takenFrom, amount: taken, synchronizationCount: this.synchronizationCount });
        }

        // UPDATE EVENTS
        orderInstance.on(ORDER_PARTIALLY_FILLED_EVENT, filled =>
          info('trader', `[${id}] ${side} ${type} order fill, total filled: ${filled}`),
        );

        orderInstance.on(ORDER_STATUS_CHANGED_EVENT, ({ status, reason }) => {
          const secondPart = `, reason: ${reason}`;
          return info('trader', `[${id}] Status changed: ${status.toUpperCase()}${reason ? secondPart : ''}`);
        });

        // TERMINAL EVENTS, relayed with the order as initiated
        this.relayTerminalEvents(orderInstance, orderInitiated, price);

        // Launch the order, without waiting: the outcome arrives through the terminal events. A failure is reported as
        // ORDER_ERRORED_EVENT, so a rejection is not expected, but it must not become an unhandled one. Tracked as a report: the
        // simulated exchange may end the order at its launch, a MARKET order filled at once (see relayTerminalEvents).
        this.trackReport(
          orderInstance
            .launch()
            .catch(err => error('trader', `[${id}] Impossible to launch the ${side} ${type} order: ${describeError(err)}`)),
        );
      }),
    );
  }

  /* -------------------------------------------------------------------------- */
  /*                           PLUGIN LIFECYCLE HOOKS                           */
  /* -------------------------------------------------------------------------- */

  protected processInit(): void {
    if (this.mode === 'realtime') {
      const exchangeSync = config.getExchange().exchangeSynchInterval;
      this.syncInterval = setInterval(() => this.synchronizeInBackground(), exchangeSync);
    }
    this.synchronizeInBackground();
  }

  protected async processOneMinuteBucket(bucket: CandleBucket) {
    // Throw error if bucket is empty
    const firstEntry = getFirstCandleFromBucket(bucket);
    // The first execution, which the backtest mode sync below skips
    const isFirstBucket = !this.currentTimestamp;

    // Update all candle bucket prices, and the time: the end of the minute, where the clock of the simulated exchange already is
    // (see PluginsStream). A report settled during the bucket dates an estimated fill, or an error, with it. In epoch milliseconds:
    // date-fns' addMinutes built a Date on every bucket for this sum.
    for (const [symbol, candle] of bucket) this.prices.set(symbol, candle.close);
    this.currentTimestamp = firstEntry.start + ONE_MINUTE;

    if (this.mode === 'backtest') {
      // Check the orders before the synchronization, which then sees what a move reserves (see checkStickyOrders). Not without an order
      // listed: nothing to check, and awaited all the same, it cost a turn of the microtask queue on most buckets of a backtest. With
      // one listed, STICKY or not, it is awaited as before: the reports of the orders the bucket filled run meanwhile.
      if (this.orders.size) await this.checkStickyOrders();

      // Synchronize periodically in backtest mode (order fills are handled by exchange callbacks), on the minutes since the epoch that
      // are a multiple of the interval: counted as differenceInMinutes counted them, truncated, without the two Dates it built
      const minutes = Math.trunc(firstEntry.start / ONE_MINUTE);
      if (!isFirstBucket && minutes % getBacktestModeIntervalSyncTime(this.timeframe) === 0) await this.synchronize();

      // The ends of orders the simulated exchange settled with this bucket, or the checks above, are queued before its events are
      // flushed, and delivered with it (see relayTerminalEvents)
      if (this.pendingReports.size) await this.settlePendingReports();
    }
  }

  /**
   * Delivers the oldest group of deferred events (see SequentialEventEmitter). In backtest, once the reports in flight are queued: the
   * flush of the TradingAdvisor, which comes first, creates and cancels orders, and the simulated exchange ends some of them at once
   * (see relayTerminalEvents).
   */
  public async broadcastDeferredEmit(): Promise<boolean> {
    // Awaited only when a report is in flight: the stream calls this at least once per bucket, most often with none
    if (this.mode === 'backtest' && this.pendingReports.size) await this.settlePendingReports();
    return super.broadcastDeferredEmit();
  }

  /**
   * Whether a broadcast has something to deliver: in backtest, a report in flight too, which queues the end of its order before the
   * broadcast delivers it (see broadcastDeferredEmit)
   */
  public hasDeferredEvents(): boolean {
    return (this.mode === 'backtest' && this.pendingReports.size > 0) || super.hasDeferredEvents();
  }

  protected async processFinalize() {
    if (this.syncInterval) clearInterval(this.syncInterval);
    // Nothing is flushed any more, but in backtest the reports in flight end before the run does, their logs complete
    if (this.mode === 'backtest') await this.settlePendingReports();
  }

  /* -------------------------------------------------------------------------- */
  /*                           PLUGIN CONFIGURATION                             */
  /* -------------------------------------------------------------------------- */

  public static getStaticConfiguration() {
    return {
      name: 'Trader',
      schema: traderSchema,
      modes: ['realtime', 'backtest'],
      dependencies: [],
      inject: ['exchange'],
      eventsHandlers: filter(Object.getOwnPropertyNames(Trader.prototype), p => p.startsWith('on')),
      eventsEmitted: [PORTFOLIO_CHANGE_EVENT, ORDER_CANCELED_EVENT, ORDER_COMPLETED_EVENT, ORDER_ERRORED_EVENT, ORDER_INITIATED_EVENT],
    } as const;
  }
}
