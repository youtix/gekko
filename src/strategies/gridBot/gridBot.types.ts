import { OrderSide } from '@models/order.types';
import { UUID } from 'node:crypto';
import { z } from 'zod';
import type { gridBotStrategySchema } from './gridBot.schema';

/** Strategy configuration parameters: the output of GridBot.schema, retryOnError defaulted */
export type GridBotStrategyParams = z.infer<typeof gridBotStrategySchema>;

/** The spacing types the configuration offers, atr included (see gridBotStrategySchema) */
export type GridSpacingOption = GridBotStrategyParams['spacingType'];

/**
 * The spacing a grid is built with: the configured one as it is, or the fixed step an atr spacing resolves to around the center price
 * (see resolveSpacing), which the helpers compute the prices of the grid from. None of them ever sees 'atr'.
 */
export interface GridSpacing {
  spacingType: 'percent' | 'fixed' | 'logarithmic';
  spacingValue: number;
  /** How a message names the spacing (see describeSpacing): `spacingValue 1 (percent)` when left out, an atr step's origin otherwise */
  description?: string;
}

/** The spacing types a grid is built with (see GridSpacing) */
export type GridSpacingType = GridSpacing['spacingType'];

/** The levels and the spacing a grid is built with: the strategy parameters, their spacing resolved (see GridSpacing) */
export type GridLayout = Pick<GridBotStrategyParams, 'buyLevels' | 'sellLevels'> & GridSpacing;

/** When the grid is reset around a price out of its range: never, above it, below it or either way (see gridBotStrategySchema) */
export type GridResetMode = GridBotStrategyParams['resetMode'];

/**
 * State of a single grid level: two adjacent prices of the grid, between which the level trades its quantity back and forth with
 * one order at a time, a BUY at the lower price or a SELL at the upper one. The two levels next to the center price share it.
 */
export interface LevelState {
  /** Level index: negative below the center price, positive above */
  index: number;
  /** Lower price of the level, where it buys */
  buyPrice: number;
  /** Upper price of the level, where it sells */
  sellPrice: number;
  /**
   * Side of the order placed last on the level, the live one while orderId is set. A level below the center price starts with its
   * BUY, a level above it with its SELL, and each fill turns the level to the other side.
   */
  side: OrderSide;
  /**
   * Amount of the order placed last on the level: the quantity of every level, or what was left of it once an order was canceled
   * after a partial fill. A fill turns the level to the other side with the whole quantity again.
   */
  amount: number;
  /**
   * Active order ID if order is placed. None for good once the level gave up on an order that failed at every attempt, or left an
   * order whose outcome is unknown, which may be live on the exchange.
   */
  orderId?: UUID;
}

/** The grid the free balances fund (see deriveLevelQuantity) */
export interface GridSize {
  /** Amount of every order of the grid: 0 when the free balances fund no level */
  quantity: number;
  /** Buy levels funded, the nearest to the center price: the farthest of the configured ones are left out first */
  buyLevels: number;
  /** Sell levels funded, the nearest to the center price */
  sellLevels: number;
  /** Smallest amount the market takes at the lowest price of the grid, which the quantity is at least */
  minimumAmount: number;
}

/** Grid price boundaries */
export interface GridBounds {
  /** Lowest grid price (bottom buy level) */
  min: number;
  /** Highest grid price (top sell level) */
  max: number;
}

/** The side of the grid a price is out on: under its lowest price, or over its highest */
export type OutOfRangeSide = 'below' | 'above';

/** Rebalance plan, computed when the grid starts, after the warmup (and again after a failed attempt) */
export interface RebalancePlan {
  /** Side of rebalance order */
  side: OrderSide;
  /** Amount to trade */
  amount: number;
  /** Estimated notional value */
  estimatedNotional: number;
  /** Current center price used for calculation */
  centerPrice: number;
}
