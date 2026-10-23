import { addPrecise } from '../utils/math/math.utils';
import { shiftDecimalPoint } from '../utils/math/round.utils';

/** The share of its budget a BUY keeps back for its fee, and for a price above the one it was sized at (see getBuyBudget) */
export const DEFAULT_FEE_BUFFER = 0.05;
/** DEFAULT_FEE_BUFFER in %, as the lines of the Trader and of the PositionBook write it: "once 5 % is kept back for the fee" */
export const FEE_BUFFER_PERCENT = shiftDecimalPoint(DEFAULT_FEE_BUFFER, 2);
/**
 * The share of its budget a BUY spends on its cost, the rest kept back (DEFAULT_FEE_BUFFER), worked out in decimal: an all-in BUY, or
 * one by its cost or its allocation, buys that share of its budget at its price, before the amount step of the market (see
 * getAllInBuyAmount, and getBuyBudget, its inverse), and the PositionBook estimates the cost of a BUY at that share before it skips one
 */
export const BUY_COST_SHARE = addPrecise(1, -DEFAULT_FEE_BUFFER);
/** The sides of an order, the one list of them: OrderSide derives from it, and the StrategyManager refuses an order of any other side */
export const ORDER_SIDES = ['BUY', 'SELL'] as const;
/**
 * The types of an order, the one list of them: OrderType derives from it, the Trader places each with its own order class
 * (ORDER_FACTORY), and the StrategyManager refuses an order of any other type
 */
export const ORDER_TYPES = ['MARKET', 'STICKY', 'LIMIT'] as const;
/**
 * The summary of an order none of whose trades was found (see createOrderSummary): its figures unknown, NaN, which the Trader replaces
 * with an estimate (see Trader.summarizeCompletedOrder), and the fee rate and the asset the fee was taken in undefined, as
 * OrderSummary says unknown ones
 */
export const EMPTY_ORDER_SUMMARY = {
  amount: NaN,
  price: NaN,
  feePercent: undefined,
  feeAsset: undefined,
  orderExecutionDate: NaN,
} as const;
/**
 * The decimals the exchanges book the currency of an order to, as Binance keeps every balance: the simulator books the cost of a BUY,
 * its fee on top, and the proceeds of a SELL, its fee taken off, rounded to them. Booked whole, amount × price × (1 ± fee) had more
 * digits than a double holds beside a balance (up to 20 decimals for the documented market, whose amounts and prices have 8, at a fee of
 * 0.0004), and the currency balances could not be added up in decimal.
 */
export const COST_DECIMALS = 8;
/**
 * The smallest amount of currency the exchanges book, a unit of the last of the COST_DECIMALS: they book the cost of an order rounded
 * to it, while an equity values a holding at amount × price, which has more decimals on a pair such as ETH/BTC (4-decimal amounts at
 * 5-decimal prices). Valued at the price it was bought at, a holding came out up to half a unit, 5e-9, above or below what it cost: a
 * round trip sold back at that price without a fee was a win or a loss, and a peak the sale never regained opened a drawdown that
 * lasted to the end of the run. Two equities less than a unit apart are one amount (see calculateDrawdowns, calculateReturns and the
 * P&L of a round trip, measureRoundTrip).
 */
export const BOOKED_CURRENCY_UNIT = 10 ** -COST_DECIMALS;
