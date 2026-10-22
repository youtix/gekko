import { UUID } from 'node:crypto';
import { Candle } from './candle.types';
import { OrderSide, OrderType } from './order.types';
import { Portfolio } from './portfolio.types';
import { Asset, TradingPair } from './utility.types';

export type CandleBucket = Map<TradingPair, Candle>;

type OrderEvent = {
  /** Order Id */
  id: UUID;
  /** Trading Pair */
  symbol: TradingPair;
  /** Order side (SELL | BUY)*/
  side: OrderSide;
  /** Order type ('MARKET' | 'STICKY' | 'LIMIT')*/
  type: OrderType;
  /**
   * The amount of the asset the order was placed with: the amount the strategy asked for, or the Trader's for an order without one,
   * sized from its cost, its allocation or all-in. A SELL is capped at the free balance of its asset, a BUY sized from a cost or an
   * allocation at the currency the BUYs placed since the last synchronization leave, and a SELL or a BUY without an amount at the most
   * the market takes in one order, the rest then held or unspent (see Trader.sizeOrder). An order the Trader could not place carries
   * the amount asked for, 0 for one without. A completed order carries the amount it executed (see OrderCompletedEvent).
   */
  amount: number;
  /**
   * The cost the strategy gave the order, in currency, as it gave it (see StrategyOrder.cost), which the Trader sized the order from:
   * undefined for an order sized otherwise
   */
  cost?: number;
  /**
   * The share the strategy gave the order, in percent, as it gave it (see StrategyOrder.allocation), which the Trader sized the order
   * from: undefined for an order sized otherwise
   */
  allocation?: number;
  /**
   * The price the strategy asked for, in currency: undefined for an order without one (a MARKET or STICKY order, a LIMIT order placed
   * at the market price). A completed order carries the price it executed at (see OrderCompletedEvent).
   */
  price?: number;
};

export type ExchangeEvent = {
  /**
   * The balances of the account, as the Trader read them last: the empty portfolio it starts with until one of its synchronizations
   * succeeds (see isFetchedPortfolio)
   */
  portfolio: Portfolio;
  /** The last price of the pair of the order, in currency: 0 when the Trader knows none, a price being above 0 */
  price: number;
  /**
   * When the Trader read these balances, in epoch milliseconds: the wall clock once the exchange answered the read, in a backtest too,
   * whose orders are dated on the clock of the simulated exchange. Undefined for the empty portfolio it starts with, before any read; an
   * end whose read failed carries the last read and its time. The EventSubscriber dates the balances of /portfolio with it. Only the
   * events of the orders carry it: portfolioChange is a bare Portfolio, queued as the Trader reads it.
   */
  portfolioReadAt?: EpochTimeStamp;
};

export type OrderInitiatedEvent = {
  order: OrderEvent & {
    /** Order Creation date */
    orderCreationDate: EpochTimeStamp;
  };
  exchange: ExchangeEvent;
};

export type OrderCanceledEvent = OrderInitiatedEvent & {
  order: OrderEvent & {
    /** Order Cancelation date */
    orderCancelationDate: EpochTimeStamp;
    /**
     * What the order executed before it was canceled, as far as the exchange reported it: the largest fill any of its states reported,
     * the polls and its creation as much as the answer to the cancelation, added up over the transactions of a STICKY order.
     * Undefined when no state of the order reported a fill, which tells nothing of what it executed: it is not 0 filled.
     */
    filled?: number;
    /** What was left of its amount: the amount less `filled`, never below 0. Undefined with `filled` */
    remaining?: number;
    /**
     * The mean price of the fills the exchange reported for a LIMIT or a STICKY order, in currency, weighted by them (see
     * Trader.getFillPrice): left out when it reported none with a price, and for a MARKET order, whose reported price can be the bound
     * of its slippage (Hyperliquid places it as a limit order 5 % beyond the market). Not `price`, the one the order asked for: a STICKY
     * order fills at the market, a LIMIT order at its price or better.
     */
    fillPrice?: number;
  };
};

export type OrderErroredEvent = OrderInitiatedEvent & {
  order: OrderEvent & {
    /** Order error reason */
    reason: string;
    /** Order error date */
    orderErrorDate: EpochTimeStamp;
    /**
     * What the order executed before its error, as far as the exchange reported it (see Order.getFilledAmount): an error may follow
     * fills, those of a STICKY order whose relaunch failed, or of an order whose poll or cancelation failed for good. 0 when none was
     * reported, which does not prove that nothing executed when the order may still be live (see mayBeLive).
     */
    filled: number;
    /**
     * Whether the order may still be live on the exchange, where nothing follows it any more, the Trader forgetting an order once it
     * errored: its creation's outcome is unknown (lost on the network, created and not read back, or failed by the exchange without a
     * refusal), or a poll, a cancelation or the read-back of one failed for good while it was open. It may then have executed more than
     * `filled`, or execute later, and no event will tell: placed again, it could be doubled. False when the exchange refused it, or when
     * nothing of it was open (a STICKY order whose relaunch failed before it was placed). Set by the order, and relayed by the Trader.
     */
    mayBeLive: boolean;
  };
};
/**
 * The fill of an order, as the Trader summarizes it: from the trades of the order, or estimated from what the order and the Trader know
 * when the exchange cannot give them (see Trader.summarizeCompletedOrder). Every figure is a finite number, but the fee rate and the
 * asset the fee was taken in, undefined when unknown.
 */
export type OrderCompletedEvent = OrderInitiatedEvent & {
  order: OrderEvent & {
    /** When the order executed: the time of its last trade, else the end of the last minute processed */
    orderExecutionDate: EpochTimeStamp;
    /** The amount executed, in the asset: what its trades add up to, else the fill the order reported, else the amount placed */
    amount: number;
    /**
     * The price it executed at, in currency: the mean of the prices of its trades weighted by their amounts, else an estimate (see
     * Trader.estimateExecutionPrice). The Trader always sets it: optional in the type only as the requested price of the other order
     * events is.
     */
    price?: number;
    /** The price plus its share of the fee for a BUY, less it for a SELL, in currency */
    effectivePrice: number;
    /** The fee, in currency: the cost times the fee rate, 0 when the rate is unknown */
    fee: number;
    /** The fee rate in % (0.1 for 0.1 %), undefined when unknown */
    feePercent?: number;
    /**
     * The asset the exchange took the fee in, as the trades of the order name it (see OrderSummary.feeAsset): the asset bought for a
     * BUY on Binance unless the fees are paid in BNB, the currency for a SELL there and for every order on the simulators, BNB with
     * the discount. `fee` is in currency whatever the asset: converted through its rate for a fee taken in the asset of the pair, 0
     * for one taken in a third asset, whose rate is unknown. Undefined when no trade names the currency of its fee, when they name
     * several, or for a summary the Trader estimated.
     */
    feeAsset?: Asset;
  };
};

/**
 * A round trip the RoundTripAnalyzer closed (ROUNDTRIP_COMPLETED_EVENT) on one of the watched pairs: from the BUY that opened a position
 * on its pair while flat to the SELL that left it flat again, the BUYs and SELLs in between included. Its P&L comes from its own fills,
 * what its SELLs brought in less what its BUYs cost and the fees of all of them (but a BUY fee taken in the asset bought, which the
 * smaller amount sold carries: see fees), so that an asset held before it, or the fills of another pair, count in none of it; its
 * profit is that P&L in % of the whole portfolio's value before it opened. One still open when the warmup completed counts from the
 * start of the period: its entry date, price and equity are then those of the start, and its cost that of the position it held then,
 * at the start price. Its profit is unknown, NaN, when the Trader had read no portfolio when its BUY filled: the RoundTripAnalyzer
 * leaves it out of the returns, not of the win rate, and the outputs write "unknown".
 */
export type RoundTrip = {
  /** Its number, counted from 0 in the order the round trips of the run close, every pair together */
  id: number;
  /** Its pair: the RoundTripAnalyzer tracks a round trip on each watched pair */
  symbol: TradingPair;
  /** When the BUY that opened it filled: its execution date, or its cancelation date for a BUY canceled after a partial fill */
  entryAt: number;
  /** The mean price of its BUYs, weighted by their amounts, in currency */
  entryPrice: number;
  /**
   * The whole portfolio's value in the currency before the BUY that opened it, the base of its profit: the portfolio the Trader read
   * after that BUY, the asset of its pair valued at the BUY's price and every other watched asset at its latest close, plus the BUY's
   * fee, whatever the asset it was taken in (an unknown fee counting as 0), which the BUY took from the portfolio. Two fills whose
   * reports share one synchronization of the Trader, as the BUYs of two pairs on one candle do in a backtest, carry the same portfolio,
   * read after both: the entry equity of each then includes the other (its fee, and the gap between its price and the last close of its
   * pair). NaN when that BUY's event carried the empty portfolio of a Trader that had read none yet. The start equity for one rebased at
   * the start of the period (0 when none was taken by then).
   */
  entryEquity: number;
  /** When the SELL that closed it filled */
  exitAt: number;
  /** The mean price of its SELLs, weighted by their amounts, in currency */
  exitPrice: number;
  /**
   * What its BUYs cost, in currency, fees left out: their amounts times their prices, added up in decimal. For one rebased at the start
   * of the period, the position it held then, at the start price.
   */
  cost: number;
  /** What its SELLs brought in, in currency, fees left out: their amounts times their prices, added up in decimal */
  proceeds: number;
  /**
   * The fees of its BUYs and SELLs, in currency as the Trader reports them, added up in decimal, but the fee of a BUY that the exchange
   * took in the asset of the pair, out of the amount bought (`feeAsset` on the order event: Binance does so unless the fees are paid in
   * BNB): the SELLs sell that much less, and the smaller proceeds carry it already, so that added here too it counted twice, and the
   * P&L was understated by it. An unknown fee counts as 0: that of the part a canceled order filled, and one the Trader does not
   * convert, taken in a third asset (BNB), which it reports as 0 with its rate unknown, the P&L then overstated by it. Those of the
   * warmup are left out for one rebased at the start of the period.
   */
  fees: number;
  /** exitAt less entryAt, in milliseconds */
  duration: number;
  /**
   * The deepest fall of a one-minute low below the entry price, in % of that price (5 for 5 %), 0 when no low fell below it: over the
   * candles that closed after the BUY that opened it filled, up to the one that closed when or before the SELL that closed it filled
   * (see countCandle, roundTripAnalyzer.helper.ts). Measured after the warmup only.
   */
  maxAdverseExcursion: number;
  /**
   * Its P&L in % of its entry equity (5 for 5 %), to 15 significant digits, as the total return of a report is worked out: 0 for a
   * break-even (see pnl); NaN when the entry equity is unknown or not above 0
   */
  profit: number;
  /**
   * What it made, in currency: its proceeds less its cost and its fees, worked out in decimal. 0 for a break-even: less than a booked
   * unit from 0 (see BOOKED_CURRENCY_UNIT), or proceeds equal to the cost and the fees together within a billionth.
   */
  pnl: number;
};

export type Report = {
  /** Unique identifier for the report type */
  id: 'TRADING REPORT' | 'PORTFOLIO PROFIT REPORT';
  /** Why the run stopped before its end, when it did: the report then covers a partial period */
  interruption?: string;
  /**
   * The asset whose price gives marketReturnPct, startPrice and endPrice: the benchmarkAsset option of the analyzer, else BTC when it is
   * watched, else the first asset of watch.assets (see pickBenchmarkAsset); '' in an empty report, which measures nothing
   */
  benchmarkAsset: Asset;
  /** Performance relative to the benchmark market return (Excess Return) */
  alpha: number;
  /** Downside deviation of the returns: root mean square of the negative ones, positive ones counting as 0 (Sortino ratio) */
  downsideDeviation: number;
  /** Timestamp indicating when the reporting period ended */
  periodEndAt: EpochTimeStamp;
  /** Timestamp indicating when the reporting period started */
  periodStartAt: EpochTimeStamp;
  /** Percentage of time the portfolio was exposed to market risk */
  exposurePct: number;
  /** Overall market performance during the same period (%) */
  marketReturnPct: number;
  /** Total net profit expressed in currency units */
  netProfit: number;
  /** Total return on investment for the entire period (%) */
  totalReturnPct: number;
  /** Annualized return on investment (%) */
  annualizedReturnPct: number;
  /** Sharpe Ratio: measure of risk-adjusted return using total volatility */
  sharpeRatio: number;
  /** Sortino Ratio: measure of risk-adjusted return focus on downside deviation */
  sortinoRatio: number;
  /** Volatility of the returns: of the round trips for the RoundTripAnalyzer, of the timeframe candles for the PortfolioAnalyzer (%) */
  volatility: number;
  /** Asset price at the beginning of the period */
  startPrice: number;
  /** Asset price at the end of the period */
  endPrice: number;
  /**
   * The length of the period as date-fns's formatDuration writes it: its years, months, days, hours, minutes and seconds that are not
   * 0, largest first, without commas ("2 months 2 days 5 hours 59 minutes"). Empty for a period of 0
   */
  formattedDuration: string;
  /** Net profit normalized to a one-year timeframe (currency units) */
  annualizedNetProfit: number;
};

export interface EquitySnapshot {
  /** Timestamp of the snapshot */
  date: EpochTimeStamp;
  /** Total portfolio value in Numéraire (e.g., USDT) */
  totalValue: number;
}
