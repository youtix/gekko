import { Candle } from '@models/candle.types';
import { Report } from '@models/event.types';
import { OrderSide } from '@models/order.types';
import { Portfolio } from '@models/portfolio.types';
import { Asset, TradingPair } from '@models/utility.types';
import { UUID } from 'node:crypto';

/**
 * The report of the RoundTripAnalyzer: run-wide, every watched pair together, its balances the whole portfolio's value in the currency,
 * with a breakdown by pair (see pairs)
 */
export interface TradingReport extends Report {
  /**
   * Percentage of the period spent in a round trip, on any pair, the ones still open at the end included: the round trips of two pairs
   * that overlap count the time they share once
   */
  exposurePct: number;
  /** The whole portfolio's value at the end of the period: the latest portfolio at the last closes, the positions still open included */
  finalBalance: number;
  /** Type of the report */
  id: 'TRADING REPORT';
  /**
   * The share of the round trips closed during the period, every pair together, that ended with a P&L above 0, in % (60 for 60 %);
   * null without one. Not rounded: the printers round it, once.
   */
  winRate: number | null;
  /** The whole portfolio's value at the start of the period (see Start) */
  startBalance: number;
  /** The 10 largest maximum adverse excursions (MAE) of the round trips closed during the period, every pair together, largest first */
  topMAEs: number[];
  /**
   * Total number of trades executed during the period, every pair together: the orders completed, and the canceled ones that filled in
   * part
   */
  tradeCount: number;
  /**
   * The round trips of each watched pair: one entry per pair, in the order of watch.assets, a pair without any included; none in an
   * empty report
   */
  pairs: PairTradingSummary[];
}

/** The round trips of one pair over the period, as the breakdown of a TradingReport gives them */
export type PairTradingSummary = {
  symbol: TradingPair;
  /** The round trips closed during the period */
  roundTripCount: number;
  /** Those with a P&L above 0 */
  winCount: number;
  /** winCount over roundTripCount, in % (60 for 60 %), null without a round trip; not rounded */
  winRate: number | null;
  /** The trades of the period on this pair (see TradingReport.tradeCount) */
  tradeCount: number;
  /** The P&L of its closed round trips added up, in currency, in decimal */
  pnl: number;
  /** The share of the period spent in its round trips, the one still open included (%) */
  exposurePct: number;
  /** The deepest adverse excursion of its closed round trips (%), 0 without one */
  maxAdverseExcursion: number;
};

/**
 * The whole portfolio's value the period starts from, and the portfolio it values. It is the latest portfolio received when the warmup
 * completes, valued at the closes of the bucket that completed it: the start prices, which the market return starts from too. A
 * portfolio received during the warmup must not give it at the prices of its own minute: the prices move until the warmup completes,
 * and the return of the run would count that move. Without a portfolio by then, it is the first one received after the warmup, valued
 * at the prices known then.
 */
export type Start = {
  equity: number;
  /** Null until the start is taken */
  portfolio: Portfolio | null;
};

/**
 * The round trip in progress on a pair, from the BUY that opened it while flat to the SELL that leaves it flat again. The BUYs in between
 * add to its position (scale-in), the SELLs in between reduce it. Its P&L is worked out from its fills alone (see RoundTrip.pnl). One
 * still open when the warmup completes is rebased at the start of the period: its entry date, entry price and entry equity become those
 * of the start, and its cost that of the position it holds then, at the start price (see RoundTripTracker.startPeriod).
 */
export type OpenRoundTrip = {
  /** The BUY that opened it: named when its profit is unknown (see entryEquity) */
  entryOrderId: UUID;
  /** Execution date of its first BUY */
  entryAt: EpochTimeStamp;
  /** Mean price of its BUYs, weighted by their amounts */
  entryPrice: number;
  /**
   * The whole portfolio's value before its first BUY, the base of its profit (see RoundTrip.entryEquity): NaN when that BUY's event
   * carried the empty portfolio of a Trader that had read none yet
   */
  entryEquity: number;
  /** Amount of asset its BUYs bought, added up in decimal */
  bought: number;
  /** Amount of asset its SELLs have sold so far, added up in decimal */
  sold: number;
  /** What its BUYs cost, in currency, in decimal: their amounts times their prices, fees left out (see RoundTrip.cost) */
  cost: number;
  /** What its SELLs have brought in so far, in currency, in decimal: their amounts times their prices, fees left out */
  proceeds: number;
  /** The fees of its BUYs and SELLs so far, in currency, in decimal, an unknown one counting as 0 (see RoundTrip.fees) */
  fees: number;
  /** Mean price of its SELLs so far, weighted by their amounts (0 before the first one) */
  exitPrice: number;
  /**
   * Deepest fall of a candle low below the entry price, in % of the entry price, over the one-minute candles counted so far: those
   * that closed after its first BUY filled, after the warmup only (see countCandle). In realtime they can include candles that closed
   * after the SELL that ends it, counted before that SELL was heard: the round trip ends with the excursion of the candles closed by
   * its SELL (see excursionDeepenings).
   */
  maxAdverseExcursion: number;
  /**
   * The candles that deepened its adverse excursion, in the order they closed, the last LATE_FILL_CANDLES of them: what the SELL that
   * ends it takes back of the candles that closed after it (see measureAdverseExcursion)
   */
  excursionDeepenings: ExcursionDeepening[];
};

/**
 * A one-minute candle that deepened the adverse excursion of a round trip: when it closed, and the deepest excursion before it, which
 * the round trip ends with when its SELL filled before that close
 */
export type ExcursionDeepening = {
  closeAt: EpochTimeStamp;
  /** The deepest excursion of the candles counted before it, in % of the entry price */
  previous: number;
};

/** What the adverse excursion reads of a one-minute candle: its start, which dates its close a minute later, and its low */
export type ExcursionCandle = Pick<Candle, 'start' | 'low'>;

/** What an order filled, as the Trader reports it: a completed order, or the part of a canceled one that filled */
export type OrderFill = {
  id: UUID;
  side: OrderSide;
  /** When it filled: the execution date of a completed order, the cancelation date of a canceled one */
  date: EpochTimeStamp;
  /**
   * The price it filled at: that of a completed order, which the Trader always sets (optional in the event type only); for a canceled
   * one, the mean price of its fills, else an estimate (see priceCanceledFill)
   */
  price?: number;
  amount: number;
  /** Its fee in currency: a completed order's, 0 when the exchange gives no fee rate; NaN for a canceled one, whose fee is unknown */
  fee: number;
};

/** An order fill with a valid price and amount (see RoundTripTracker.registerRoundtripPart) */
export type Fill = {
  id: UUID;
  date: EpochTimeStamp;
  price: number;
  amount: number;
  /** Its fee in currency, 0 when unknown */
  fee: number;
};

export type DateRange = {
  start: EpochTimeStamp;
  end: EpochTimeStamp;
};

/** What the RoundTripAnalyzer builds the RoundTripTracker of a watched pair with */
export type RoundTripTrackerSetup = {
  symbol: TradingPair;
  /** The asset of the pair */
  asset: Asset;
  /** The currency of the pair: watch.currency, which every pair shares */
  currency: Asset;
  /**
   * The whole portfolio's value in the currency: its currency, the asset of the tracker's pair at `price` and every other watched asset
   * at its latest close (see RoundTripAnalyzer.valuePortfolio). The tracker values the entry equity of a round trip with it: the
   * analyzer holds the prices of every pair.
   */
  valuePortfolio: (portfolio: Portfolio, price: number) => number;
  /** Draws the id of the next round trip to close in the run, every pair together (see RoundTripAnalyzer.nextRoundTripId) */
  nextRoundTripId: () => number;
};
