import { TrailingConfig } from '@models/advice.types';
import { TradingPair } from '@models/utility.types';
import { UUID } from 'node:crypto';

export type TrailingStopState = {
  id: UUID;
  symbol: TradingPair;
  /**
   * What the MARKET SELL the stop sends when triggered sells, not the whole balance: the amount its BUY filled, as its
   * ORDER_COMPLETED_EVENT reports it (an all-in BUY included), or as the ORDER_ERRORED_EVENT of a BUY that errored after a fill
   * does. A SELL of the stop that sold part of it, completed for less or ended without completing, leaves the rest (see status).
   */
  amount: number;
  /** The BUY's `trailing`, copied as the stop is armed: a later change to the strategy's object, or to a state's, moves nothing */
  config: TrailingConfig;
  /**
   * - dormant: armed with a trigger the price has not reached yet.
   * - active: trailing the price, from its arming without trigger, from the candle that reached its trigger, or again once its SELL
   *   ended without selling all of it. While its trigger is held back (see TriggerHold) it trails on, its peak still rising, but a
   *   price at or below its stop price does not trigger it.
   * - selling: triggered, its MARKET SELL (sellOrderId) sent and not ended yet. It trails no more, and is kept until that SELL ends:
   *   completed for all the stop sells, the stop is over; completed for less, errored or canceled, it is active again, from the peak
   *   and the stop price it triggered at, for what that SELL left unsold. The StrategyManager ends it instead when that rest is too
   *   little to sell at the minimums of the market (at info level), or when the portfolio after that SELL shows too little of the
   *   asset free while no SELL the strategy created is pending on the pair (at info level after a completed SELL, with a warning
   *   after an errored or canceled one).
   */
  status: 'dormant' | 'active' | 'selling';
  /**
   * The highest price the stop has met while active, 0 until it meets one. The order of a candle's low and high is unknown, so the
   * stop meets a candle's prices as open, low, high, close, testing each against stopPrice before it raises the peak: it triggers on a
   * price the candle reached after the peak whatever that order. The candle that activates a stop with a trigger is met from its open
   * when the open reached the trigger, else from its high, then its close, since its low may have come before the activation.
   */
  highestPeak: number;
  /**
   * highestPeak less config.percentage. A triggered stop reports the peak and the stop price in force when the price reached the
   * stop, not those a later price of the candle would have made.
   */
  stopPrice: number;
  activationPrice?: number;
  createdAt: number;
  /** The MARKET SELL the stop sent when it triggered, while it is selling */
  sellOrderId?: UUID;
};

/**
 * Asked by the TrailingStopManager whenever a price reaches the stop price of an active stop, with a copy of the stop and that price:
 * true holds the trigger back, and the stop trails on as if the price had not reached it, a later price of the candle still raising
 * its peak. The StrategyManager holds back the stops of a pair while a SELL the strategy created is pending there: the exchange
 * reserves the asset for that SELL, and a stop that triggered meanwhile had its own SELL refused, sent again each minute the price
 * stayed under its stop price, until the circuit breaker stopped the bot. Nothing is held back when no hold is given.
 */
export type TriggerHold = (stop: TrailingStopState, price: number) => boolean;
