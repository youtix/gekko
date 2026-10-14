import { Report } from '@models/event.types';
import { OrderSide } from '@models/order.types';
import { Portfolio } from '@models/portfolio.types';
import { UUID } from 'node:crypto';

export interface TradingReport extends Report {
  /** Percentage of the period spent in round trips, including the one still open at the end */
  exposurePct: number;
  /** Pair equity at the end of the period: the latest portfolio at the last close, a position still open included */
  finalBalance: number;
  /** Type of the report */
  id: 'TRADING REPORT';
  /**
   * The share of the round trips closed during the period that ended in profit, in % (60 for 60 %), counted over those whose P&L is
   * known (see RoundTrip.pnl); null without one. Not rounded: the printers round it, once.
   */
  winRate: number | null;
  /** Initial portfolio balance at the start of the period */
  startBalance: number;
  /** List of the top 10 largest Max Adverse Excursions (MAE) encountered */
  topMAEs: number[];
  /** Total number of trades executed during the period: the orders completed, and the canceled ones that filled in part */
  tradeCount: number;
}

/**
 * The pair equity the period starts from, and the portfolio it values. It is the latest portfolio received when the warmup completes,
 * valued at the close of the candle that completed it: the start price, which the market return starts from too. A portfolio
 * received during the warmup must not give it at the price of its own minute: the price moves until the warmup completes, and the
 * return of the run would count that move. Without a portfolio by then, it is the first one received after the warmup, valued at
 * the price known then.
 */
export type Start = {
  equity: number;
  /** Null until the start is taken */
  portfolio: Portfolio | null;
};

/**
 * The round trip in progress, from the BUY that opened it while flat to the SELL that leaves it flat again. The BUYs in between add
 * to its position (scale-in), the SELLs in between reduce it. One still open when the warmup completes is rebased at the start of the
 * period: its entry date, entry price and entry equity become those of the start (see RoundTripAnalyzer.leaveOutWarmupTrading).
 */
export type OpenRoundTrip = {
  /** Execution date of its first BUY */
  entryAt: EpochTimeStamp;
  /** Mean price of its BUYs, weighted by their amounts */
  entryPrice: number;
  /**
   * Pair equity before its first BUY, at the price of that BUY: the pair equity after it plus its fee, which the BUY took from the
   * pair, in currency or in the asset bought. The exit equity is read after the SELL that ends the round trip, its fee paid, so that
   * the pnl and the profit of the round trip are net of the fees of all its orders: those of its later BUYs (scale-in) and of its
   * other SELLs are in the exit equity already. An unknown fee counts as 0 (see Fill). NaN while unknown: the first BUY filled before
   * the Trader had read any portfolio, and no order has ended with one since (see pendingEntry).
   */
  entryEquity: number;
  /** Set while the entry equity is unknown: what values it once an order ends with a portfolio read (see PendingEntry) */
  pendingEntry?: PendingEntry;
  /** Amount of asset its BUYs bought */
  bought: number;
  /** Amount of asset its SELLs have sold so far */
  sold: number;
  /** Mean price of its SELLs so far, weighted by their amounts (0 before the first one) */
  exitPrice: number;
  /** Deepest fall of a candle low below the entry price since it opened, in % of the entry price, measured after the warmup only */
  maxAdverseExcursion: number;
};

/**
 * What the entry equity of a round trip is worked out from when the BUY that opened it filled before the Trader had read any portfolio:
 * its event carried the empty portfolio the Trader starts with, which holds none of the account's balances (see isFetchedPortfolio).
 * The first portfolio an order ends with afterwards was read after every fill heard so far: the pair equity it shows at the price of
 * that BUY, less what those fills changed it by, is the pair equity before the BUY (see RoundTripAnalyzer.valueEntryEquity).
 */
export type PendingEntry = {
  /** The BUY that opened the round trip */
  orderId: UUID;
  /** Its price: the price the entry equity is valued at */
  price: number;
  /**
   * What the fills of the round trip have changed the pair equity by, valued at that price, in currency: each one its fee, and the
   * asset it moved valued at that price less the currency it moved for it (see getEquityChange). Valued at its own price, a fill
   * changes the pair equity by its fee alone.
   */
  change: number;
};

/** What an order filled, as the Trader reports it: a completed order, or the part of a canceled one that filled */
export type OrderFill = {
  id: UUID;
  side: OrderSide;
  /** When it filled: the execution date of a completed order, the cancelation date of a canceled one */
  date: EpochTimeStamp;
  /**
   * The price it filled at: that of a completed order, which the Trader always sets (optional in the event type only); for a canceled
   * one, its own price, else the last close (see RoundTripAnalyzer.onOrderCanceled)
   */
  price?: number;
  amount: number;
  /** Its fee in currency: a completed order's, 0 when the exchange gives no fee rate; NaN for a canceled one, whose fee is unknown */
  fee: number;
};

/** An order fill with a valid price and amount, and the pair equity right after it, at its price (see registerRoundtripPart) */
export type Fill = {
  id: UUID;
  date: EpochTimeStamp;
  price: number;
  amount: number;
  /** Its fee in currency, 0 when unknown */
  fee: number;
  /** NaN when its event carried the empty portfolio of a Trader that had read none yet (see PendingEntry) */
  equity: number;
};

export type DateRange = {
  start: EpochTimeStamp;
  end: EpochTimeStamp;
};
