import { UUID } from 'node:crypto';
import { Candle } from './candle.types';
import { OrderSide, OrderType } from './order.types';
import { Portfolio } from './portfolio.types';
import { TradingPair } from './utility.types';

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
   * The amount of the asset the order was placed with: the amount the strategy asked for, or the Trader's for an all-in order. A SELL is
   * capped at the free balance of its asset, and a SELL or an all-in BUY at the most the market takes in one order, the rest then held
   * or unspent (see Trader.sizeOrder). An order the Trader could not place carries the amount asked for, 0 for an all-in one. A
   * completed order carries the amount it executed (see OrderCompletedEvent).
   */
  amount: number;
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
 * when the exchange cannot give them (see Trader.summarizeCompletedOrder). Every figure is a finite number, but the fee rate, undefined
 * when unknown.
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
  };
};

export type RoundTrip = {
  id: number;
  entryAt: number;
  entryPrice: number;
  entryEquity: number;
  exitAt: number;
  exitPrice: number;
  exitEquity: number;
  duration: number;
  maxAdverseExcursion: number;
  profit: number;
  pnl: number;
};

export type Report = {
  /** Unique identifier for the report type */
  id: 'TRADING REPORT' | 'PORTFOLIO PROFIT REPORT';
  /** Why the run stopped before its end, when it did: the report then covers a partial period */
  interruption?: string;
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
  /** Human-readable string representing the elapsed time (e.g., "3 months, 2 days") */
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
