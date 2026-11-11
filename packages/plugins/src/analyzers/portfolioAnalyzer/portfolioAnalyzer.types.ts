import { EquitySnapshot, Report } from '@gekko/shared/models/event.types';

export interface PortfolioReport extends Report {
  id: 'PORTFOLIO PROFIT REPORT';
  /**
   * Equity curve: the portfolio marked to market at the close of every timeframe candle of the period, then at its end with the
   * latest portfolio at the last prices
   */
  equityCurve: EquitySnapshot[];
  /** Maximum drawdown percentage (peak-to-trough) */
  maxDrawdownPct: number;
  /** Longest drawdown duration in milliseconds */
  longestDrawdownMs: number;
  /** Initial portfolio value in Numéraire */
  startEquity: number;
  /** Final portfolio value in Numéraire */
  endEquity: number;
  /** Total number of portfolio change events */
  portfolioChangeCount: number;
}
