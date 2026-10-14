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
import { DEFAULT_FEE_BUFFER } from '@constants/order.const';
import { AdviceOrder } from '@models/advice.types';
import { CandleBucket, OrderCanceledEvent, OrderCompletedEvent, OrderErroredEvent, OrderInitiatedEvent } from '@models/event.types';
import { Portfolio } from '@models/portfolio.types';
import { TradingPair } from '@models/utility.types';
import { Plugin } from '@plugins/plugin';
import { config } from '@services/configuration/configuration';
import { OrderErrorEventPayload, OrderSummary } from '@services/core/order/order.types';
import { debug, error, info, warning } from '@services/logger';
import { getFirstCandleFromBucket } from '@utils/candle/candle.utils';
import { toISOString } from '@utils/date/date.utils';
import { getMarketOrderLimits } from '@utils/market/market.utils';
import { addPrecise, isFiniteNumber } from '@utils/math/math.utils';
import { shiftDecimalPoint } from '@utils/math/round.utils';
import { clonePortfolio, createEmptyPortfolio, getAssetBalance, isFetchedPortfolio } from '@utils/portfolio/portfolio.utils';
import { addMinutes, differenceInMinutes } from 'date-fns';
import { filter, isNil, noop, uniq } from 'lodash-es';
import { UUID } from 'node:crypto';
import { ORDER_FACTORY } from './trader.const';
import { traderSchema } from './trader.schema';
import { CheckOrderSummaryParams, TraderOrderMetadata } from './trader.types';
import {
  computeOrderPricing,
  getAllInBuyAmount,
  getBacktestModeIntervalSyncTime,
  getBuyBudget,
  PortfolioUpdatesConfig,
  shouldEmitPortfolio,
  ShouldEmitPortfolioParams,
} from './trader.utils';

const getErrorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isFinitePositive = (value: number) => Number.isFinite(value) && value > 0;

type OrderInstance = TraderOrderMetadata['orderInstance'];
/** An order, as the events relayed to the strategy describe it */
type RelayedOrder = OrderInitiatedEvent['order'];
/** What an order reports with ORDER_INVALID_EVENT (see Order.orderRejected): `filled` says whether it executed part of its amount */
type OrderRejection = { reason: string; status: string; filled: boolean };
/** What an order reports with ORDER_CANCELED_EVENT (see Order.orderCanceled): relayed as is */
type OrderCancelation = { timestamp: EpochTimeStamp } & Pick<OrderCanceledEvent['order'], 'filled' | 'remaining'>;
/**
 * An order the balance read last may not show (see Trader.unreadOrders): what it takes from the free balance of `assetName`, the asset
 * of a SELL, the currency of a BUY
 */
type UnreadOrder = { assetName: string; amount: number; synchronizationCount: number };
/** The free balance of an asset a SELL can take, or of the currency a BUY can spend (see Trader.getFreeBalanceLeft) */
type FreeBalanceLeft = {
  /** What the last synchronization read */
  read: number;
  /** What the orders placed since take from it: the SELLs of the asset, the BUYs of the currency */
  taken: number;
  /** What is left of it, never below 0 */
  free: number;
};

export class Trader extends Plugin {
  private readonly orders: Map<UUID, TraderOrderMetadata>;
  private readonly portfolioUpdatesConfig: PortfolioUpdatesConfig | null;

  private portfolio: Portfolio = createEmptyPortfolio();
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
   * of the currency (see sizeOrder and sizeAllInBuy). A synchronization started after an order reads a balance that shows it, filled or
   * reserved: the order is forgotten once that synchronization has read the balance. So is an order the strategy cancels: the exchange
   * gets the cancelation before any order sent after it, and releases what the canceled order reserved.
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
    // A balance that shows the orders placed before this synchronization started: they take nothing more from it (see unreadOrders)
    for (const [id, { synchronizationCount }] of this.unreadOrders) {
      if (synchronizationCount < synchronizationNumber) this.unreadOrders.delete(id);
    }
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
   * A synchronization nobody waits for: the first one, and the periodic ones in realtime. Skipped while one is in flight, whose
   * outcome it would only share. A failure is logged rather than thrown, which would make it an unhandled rejection: it is not
   * fatal, the next synchronization tries again.
   */
  private synchronizeInBackground() {
    if (this.synchronization) return debug('trader', 'Synchronization skipped: another one is in flight');
    this.synchronize().catch(err => error('trader', `Impossible to synchronize: ${getErrorMessage(err)}`));
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
          .catch(err => error('trader', `[${id}] Impossible to check the ${side} ${type} order: ${getErrorMessage(err)}`)),
      );
    await Promise.all(checks);
  }

  /* -------------------------------------------------------------------------- */
  /*                             PRIVATE FUNCTIONS                              */
  /* -------------------------------------------------------------------------- */

  /**
   * The amount `advice` is placed with, and what it takes from the free balance the last synchronization read (`balance`, see
   * unreadOrders): of the asset for a SELL, its amount (see sizeSell); of the currency for a BUY, what it may spend (see getBuyBudget),
   * all it was sized from for an all-in BUY (see sizeAllInBuy). A BUY with an amount is placed as asked, never capped: the strategy
   * chose it, and the exchange refuses it when the market does not take it.
   */
  private sizeOrder(advice: AdviceOrder, price: number, balance: FreeBalanceLeft): { amount: number; taken: number } {
    if (advice.side === 'SELL') {
      const amount = this.sizeSell(advice, balance);
      return { amount, taken: amount };
    }
    if (isNil(advice.amount)) return this.sizeAllInBuy(advice, price, balance);
    return { amount: advice.amount, taken: getBuyBudget(advice.amount, price) };
  }

  /**
   * The most the market takes in one order of the type of `advice`, in its asset: the maximum of the amount range of the market
   * (Binance's LOT_SIZE), narrowed for a MARKET order to that of a market order (Binance's MARKET_LOT_SIZE, see getMarketOrderLimits),
   * as the exchanges check an order before they send it. Undefined when the market sets none: a maximum that is not a finite number
   * above 0 sets nothing there either (Binance disables a filter bound by setting it to 0).
   */
  private getMaximumAmount({ symbol, type }: AdviceOrder) {
    const marketData = this.getExchange().getMarketData(symbol);
    const maximum = (type === 'MARKET' ? getMarketOrderLimits(marketData) : marketData).amount?.max;
    return isFiniteNumber(maximum) && maximum > 0 ? maximum : undefined;
  }

  /**
   * The amount a SELL is placed with: the amount asked for, or, for an all-in SELL, what the SELLs placed before it leave of the asset
   * (see getFreeBalanceLeft), capped at two bounds. Above both, it is capped at the lower one, and one warning says which.
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
   * one the SELLs placed before take whole, and a SELL of 0 would be refused anyway.
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
   * is said at warn level, as for that BUY: the refusal names the amount of 0, not its cause.
   */
  private sizeSell(advice: AdviceOrder, balance: FreeBalanceLeft) {
    const { id, type, symbol } = advice;
    const [assetName] = symbol.split('/');
    const { read, taken, free } = balance;
    if (isNil(advice.amount) && !(free > 0)) {
      const sized = `[${id}] All-in SELL ${type} order sized from ${free} ${assetName}: ${free} ${assetName} sent`;
      warning('trader', `${sized}, which the market refuses (${this.getEmptyBalanceCause(balance, assetName, 'SELLs')})`);
      return free;
    }
    const requestedAmount = advice.amount ?? free;
    const isFiniteAmount = Number.isFinite(requestedAmount);
    const isAboveBalance = isFiniteAmount && free > 0 && requestedAmount > free;
    const maximum = this.getMaximumAmount(advice);
    const asked = `[${id}] ${isNil(advice.amount) ? 'All-in SELL' : 'SELL'} ${type} order of ${requestedAmount} ${assetName}`;

    if (isFiniteAmount && !isNil(maximum) && (isAboveBalance ? free : requestedAmount) > maximum) {
      const capped = `the maximum amount of a ${type} order on ${symbol}: ${maximum} ${assetName} sent`;
      warning('trader', `${asked} above ${capped}, the rest stays held`);
      return maximum;
    }
    if (!isAboveBalance) return requestedAmount;
    const sent = `${asked} above the free balance: ${free} ${assetName} sent, all that can be sold`;
    // The amount sent is then less than the free balance read: what the SELLs placed since take is said
    const left = `${read} ${assetName} free at the last synchronization, less ${taken} ${assetName} for the SELLs placed since`;
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
   * Capped at the most the market takes in one order of its type (see getMaximumAmount), with a warning: all-in is as much as the
   * market takes, and above it the BUY was refused at each entry signal, an error counting towards the circuit breaker. It then takes
   * from the currency what it may spend (see getBuyBudget), and leaves the rest to the BUYs after it.
   */
  private sizeAllInBuy(advice: AdviceOrder, price: number, currency: FreeBalanceLeft): { amount: number; taken: number } {
    const { id, type, symbol } = advice;
    const [assetName, currencyName] = symbol.split('/');
    const { read, taken, free } = currency;
    const amount = getAllInBuyAmount(free, price);
    const maximum = this.getMaximumAmount(advice);
    const sized = `[${id}] All-in BUY ${type} order sized from ${free} ${currencyName}`;

    if (Number.isFinite(amount) && !isNil(maximum) && amount > maximum) {
      const capped = `the maximum amount of a ${type} order on ${symbol}: ${maximum} ${assetName} sent`;
      warning('trader', `${sized}: ${amount} ${assetName}, above ${capped}, the rest of the ${currencyName} left unspent`);
      return { amount: maximum, taken: getBuyBudget(maximum, price) };
    }
    if (taken > 0) {
      const placed = `less ${taken} ${currencyName} for the BUYs placed since`;
      const feeBuffer = `the ${shiftDecimalPoint(DEFAULT_FEE_BUFFER, 2)} % kept back for their fee included`;
      const left = `${read} ${currencyName} free at the last synchronization, ${placed}, ${feeBuffer}`;
      warning('trader', `${sized}: ${amount} ${assetName} sent (${left})`);
    } else if (!(read > 0)) {
      const cause = this.getEmptyBalanceCause(currency, currencyName, 'BUYs');
      warning('trader', `${sized}: ${amount} ${assetName} sent, which the market refuses (${cause})`);
    }
    return { amount, taken: free };
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
   * Why an all-in order has nothing to be sized from, which its refusal for an amount of 0 does not say: no balance read from the
   * exchange yet, none of the asset free at the last synchronization, or the orders of its side placed since taking what was
   */
  private getEmptyBalanceCause({ read, taken }: FreeBalanceLeft, assetName: string, placedSince: 'BUYs' | 'SELLs') {
    // Before any synchronization succeeded, the portfolio is the empty one the Trader starts with (see isFetchedPortfolio)
    if (!isFetchedPortfolio(this.portfolio)) return 'no balance read from the exchange yet';
    const free = `${read} ${assetName} free at the last synchronization`;
    return taken > 0 ? `${free}, less ${taken} ${assetName} for the ${placedSince} placed since` : free;
  }

  /**
   * The last price known for a pair, which the events of its orders carry (see ExchangeEvent): the close of the last candle, or the bid
   * of the last synchronization, whichever came last. 0 when none is known, as for a pair that is not watched.
   */
  private getLastPrice(symbol: TradingPair) {
    return this.prices.get(symbol) || 0;
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
    const exchange = { price: this.getLastPrice(symbol), portfolio: this.portfolio };
    return { order, exchange };
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
      reason = `its summary could not be created: ${getErrorMessage(err)}`;
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
   * The price a filled order executed at, estimated (see estimateOrderSummary). A LIMIT or STICKY order places limit orders, which
   * execute at their price, or better: first, the prices the exchange reported for those that filled, weighted by their fills (see
   * Order.getAverageFillPrice). A STICKY order was estimated at the market, which it follows, whatever its transactions filled at: one
   * that rested at 100.01 and filled before the market fell to 99 was reported at 99. Not a MARKET order: the price reported for it can
   * be the bound of its slippage, Hyperliquid placing it as a limit order 5 % beyond the market. Without them, a LIMIT order executed
   * at its price. Any other one at the market: the last price known, else the price the order was created with, which comes with the
   * report (see relayTerminalEvents) whatever the orders the Trader still lists: an estimate never has a price of NaN.
   */
  private estimateExecutionPrice(orderInstance: OrderInstance, { symbol, type }: RelayedOrder, creationPrice: number) {
    const fillPrice = type === 'MARKET' ? undefined : orderInstance.getAverageFillPrice();
    if (!isNil(fillPrice)) return { price: fillPrice, priceSource: 'the prices of its fills, as the exchange reported them' };
    if (type === 'LIMIT') return { price: creationPrice, priceSource: 'its limit price' };

    const marketPrice = this.getLastPrice(symbol);
    if (marketPrice > 0) return { price: marketPrice, priceSource: 'the last market price' };
    return { price: creationPrice, priceSource: 'the price it was created with: no market price known' };
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
      error('trader', `[${order.id}] Impossible to synchronize: ${getErrorMessage(err)}`);
    }
    const exchange = { price: this.getLastPrice(order.symbol), portfolio: this.portfolio };
    this.addDeferredEmit<OrderErroredEvent>(ORDER_ERRORED_EVENT, {
      order: { ...order, reason, orderErrorDate: this.currentTimestamp, filled, mayBeLive },
      exchange,
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
   * bucket are flushed once, as soon as the plugins have processed it (see PluginsStream). Each report is kept in pendingReports:
   * - in backtest, they are awaited before the events are flushed (see processOneMinuteBucket and broadcastDeferredEmit), and so are
   *   the launches and cancelations: the simulated exchange answers within a few ticks. The end of an order it settles with a bucket
   *   is delivered with that bucket, and that of an order it ends at once, created or canceled during the flush of the TradingAdvisor,
   *   in the flush of the Trader that follows. Left to race the flush, a fill reached the strategy and the analyzers one or two
   *   candles late, the count depending on how many ticks each step took (even on the STICKY orders open), and a fill on the last
   *   bucket was never delivered: nothing is flushed after processFinalize.
   * - in realtime, paper trading included, a report waits for the network: awaited, it would hold the bucket, and every plugin, for
   *   as long as the exchange takes to answer. It is delivered with the first flush after it ends.
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

  /** The fill, with its summary, estimated when the exchange cannot give it (see summarizeCompletedOrder), and the portfolio after it */
  private async reportCompleted(orderInstance: OrderInstance, order: RelayedOrder, creationPrice: number) {
    const { id, symbol, side, type, orderCreationDate } = order;
    try {
      orderInstance.removeAllListeners();
      const startedAfter = this.synchronizationCount;
      const summary = await this.summarizeCompletedOrder(orderInstance, order, creationPrice);
      // The portfolio after the fill, best effort (see relayError)
      try {
        await this.synchronize(startedAfter);
      } catch (err) {
        error('trader', `[${id}] Impossible to synchronize: ${getErrorMessage(err)}`);
      }
      const orderCompletedEvent = this.checkOrderSummary({ id, symbol, type, orderCreationDate, summary });
      this.addDeferredEmit<OrderCompletedEvent>(ORDER_COMPLETED_EVENT, orderCompletedEvent);
      this.orders.delete(id);
    } catch (err) {
      error('trader', `[${id}] Impossible to report the completion of the ${side} ${type} order: ${getErrorMessage(err)}`);
    }
  }

  /** The cancelation, whoever canceled the order: the strategy, or the exchange (expired, canceled from its interface) */
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
        error('trader', `[${id}] Impossible to synchronize: ${getErrorMessage(err)}`);
      }
      const exchange = { price: this.getLastPrice(symbol), portfolio: this.portfolio };
      this.addDeferredEmit<OrderCanceledEvent>(ORDER_CANCELED_EVENT, {
        order: { ...order, orderCancelationDate: timestamp, filled, remaining },
        exchange,
      });
    } catch (err) {
      error('trader', `[${id}] Impossible to report the cancelation of the ${side} ${type} order: ${getErrorMessage(err)}`);
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
      error('trader', `[${id}] Impossible to report the error of the ${side} ${type} order: ${getErrorMessage(err)}`);
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
      error('trader', `[${id}] Impossible to report the rejection of the ${side} ${type} order: ${getErrorMessage(err)}`);
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                             EVENT LISTENERS                                */
  /* -------------------------------------------------------------------------- */

  /**
   * Emits the portfolio at the end of the warmup, when the PortfolioAnalyzer starts recording the equity. The bucket that ended the
   * warmup was processed as it arrived, like every bucket: nothing else is left to do. Best effort, like every synchronization of the
   * plugin (see relayError): a rejection leaving the handler would end the run (see PluginsStream), and the next synchronization
   * tries again.
   */
  public async onStrategyWarmupCompleted(_bucket: CandleBucket[]) {
    try {
      await this.synchronize();
    } catch (err) {
      error('trader', `[warmup] Impossible to synchronize: ${getErrorMessage(err)}`);
    }
  }

  public async onStrategyCancelOrder(payloads: UUID[]) {
    // Parallel strategy: process all payloads concurrently. An id asked twice in the same batch is canceled once.
    await Promise.all(
      uniq(payloads).map(async id => {
        const orderMetadata = this.orders.get(id);
        if (!orderMetadata) return warning('trader', `[${id}] Impossible to cancel order: Unknown Order`);
        const { orderInstance, side, amount, type, orderCreationDate, price, requestedPrice, symbol } = orderMetadata;
        // Kept, an order placed since the balance was read went on taking from it: an all-in order sent after the cancelation, to trade at
        // the market instead, left out what the canceled one had reserved, which the exchange releases before that order reaches it
        this.unreadOrders.delete(id);

        // From now on its updates are no longer logged, and its end is relayed as the creation flow relays it: with the price the
        // strategy asked for, if any. Not the price the order was created with (see TraderOrderMetadata), the market price for an
        // order without one, which the strategy and the EventSubscriber would read as a requested limit price: that one only goes to
        // the report, for the estimate of a fill.
        orderInstance.removeAllListeners();
        this.relayTerminalEvents(orderInstance, { id, orderCreationDate, amount, side, type, price: requestedPrice, symbol }, price);

        // Cancel, without waiting: the outcome arrives through the terminal events. A failure is reported as ORDER_ERRORED_EVENT,
        // so a rejection is not expected, but it must not become an unhandled one. Tracked as a report: the simulated exchange
        // answers at once, and its answer ends the order (see relayTerminalEvents).
        this.trackReport(
          orderInstance
            .cancel()
            .catch(err => error('trader', `[${id}] Impossible to cancel the ${side} ${type} order: ${getErrorMessage(err)}`)),
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
          // The amount the strategy asked for, if any. Without one the order was all-in, to be sized as it is placed (a BUY from the
          // price, missing or invalid here): never placed, it ordered nothing, filled nothing, and nothing of it is live.
          const order = {
            ...advice,
            amount: advice.amount ?? 0,
            reason,
            orderErrorDate: this.currentTimestamp,
            filled: 0,
            mayBeLive: false,
          };
          const exchange = { price: this.getLastPrice(symbol), portfolio: this.portfolio };
          this.addDeferredEmit<OrderErroredEvent>(ORDER_ERRORED_EVENT, { order, exchange });
          return;
        }

        // Price cannot be zero here because we call processOneMinuteBucket before events (plugins stream)
        // We delegate the order validation (notional, lot, amount) to the exchange, but for the maximum amount the market takes in one
        // order, which a SELL and an all-in BUY are capped at (see sizeOrder). An all-in SELL sells what the SELLs before it left of the
        // asset, an all-in BUY spends what the BUYs before it left of the currency.
        const [assetName, currencyName] = symbol.split('/');
        const takenFrom = side === 'SELL' ? assetName : currencyName;
        const { amount, taken } = this.sizeOrder(advice, price, this.getFreeBalanceLeft(takenFrom));

        // Emit order initiated event
        const orderInitiated = { ...advice, amount, symbol };
        const exchange = { price: this.getLastPrice(symbol), portfolio: this.portfolio };
        this.addDeferredEmit<OrderInitiatedEvent>(ORDER_INITIATED_EVENT, { order: orderInitiated, exchange });

        // Create order
        const orderInstance = new ORDER_FACTORY[type](symbol, id, side, amount, price);
        this.orders.set(id, { amount, side, orderCreationDate, type, price, requestedPrice: advice.price, orderInstance, symbol });
        // Until the balance is read again, the orders after it can only take what it leaves (see unreadOrders): a SELL its amount of the
        // asset, a BUY what it may spend of the currency, an all-in BUY all it was sized from, unless capped at the maximum of the market.
        // Not an order that cannot be placed, which the exchange refuses.
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
            .catch(err => error('trader', `[${id}] Impossible to launch the ${side} ${type} order: ${getErrorMessage(err)}`)),
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
    // (see PluginsStream). A report settled during the bucket dates an estimated fill, or an error, with it.
    for (const [symbol, candle] of bucket) this.prices.set(symbol, candle.close);
    this.currentTimestamp = addMinutes(firstEntry.start, 1).getTime();

    if (this.mode === 'backtest') {
      // Check the orders before the synchronization, which then sees what a move reserves (see checkStickyOrders)
      await this.checkStickyOrders();

      // Synchronize periodically in backtest mode (order fills are handled by exchange callbacks)
      const minutes = differenceInMinutes(firstEntry.start, 0);
      if (!isFirstBucket && minutes % getBacktestModeIntervalSyncTime(this.timeframe) === 0) await this.synchronize();

      // The ends of orders the simulated exchange settled with this bucket, or the checks above, are queued before its events are
      // flushed, and delivered with it (see relayTerminalEvents)
      await this.settlePendingReports();
    }
  }

  /**
   * Delivers the oldest group of deferred events (see SequentialEventEmitter). In backtest, once the reports in flight are queued: the
   * flush of the TradingAdvisor, which comes first, creates and cancels orders, and the simulated exchange ends some of them at once
   * (see relayTerminalEvents).
   */
  public async broadcastDeferredEmit(): Promise<boolean> {
    if (this.mode === 'backtest') await this.settlePendingReports();
    return super.broadcastDeferredEmit();
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
