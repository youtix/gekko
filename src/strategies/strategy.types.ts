import { IndicatorNames, IndicatorParameters } from '@indicators/indicator.types';
import { StrategyOrder } from '@models/advice.types';
import { CandleBucket, ExchangeEvent, OrderCanceledEvent, OrderCompletedEvent, OrderErroredEvent } from '@models/event.types';
import { LogLevel } from '@models/logLevel.types';
import { Portfolio } from '@models/portfolio.types';
import { TradingPair } from '@models/utility.types';
import { MarketData, OpenOrder } from '@services/exchange/exchange.types';
import { UUID } from 'node:crypto';
import { z } from 'zod';
import { TrailingStopState } from './trailingStopManager.types';

/**
 * What an indicator gives the hooks, in the order of the addIndicator calls: its results and its pair. `results` is the strategy's own
 * copy, made once per timeframe candle and shared by the hooks of that candle, then by the order hooks until the next one: writing to
 * it changes nothing in the indicator.
 */
export type IndicatorResults<T = unknown> = { results: T; symbol: TradingPair };
/**
 * Registers an indicator on a pair. It returns nothing: the StrategyManager keeps the indicator and feeds it, and its results reach
 * the hooks as their indicator arguments, in the order of the addIndicator calls.
 *
 * `symbol` must be a watched pair, a key of `tools.marketData`: an indicator on any other pair would never get a candle, its results
 * null for the whole run. Any other symbol throws a GekkoError naming it and the watched pairs: the bot stops.
 *
 * `parameters` holds the parameters of the indicator by name, `{}` for its defaults (`undefined` for TrueRange, which takes none; an
 * untyped strategy may also leave them out, or pass null). The indicator checks them as it is built: a value it refuses, or a
 * parameter it requires left out, throws a GekkoError naming the indicator and the parameter, and the bot stops. Anything but a plain
 * object, which only an untyped strategy can pass (7 for a period, an array, a Map), throws a GekkoError before the indicator is
 * built: such a value used to build most indicators with their defaults, without a word.
 *
 * Available in init only: called once init has returned, kept from it, it throws a GekkoError and the bot stops. An indicator added
 * later would only be fed from then on, and would give every hook one more argument.
 */
export type AddIndicatorFn = <T extends IndicatorNames>(name: T, symbol: TradingPair, parameters: IndicatorParameters<T>) => void;
/**
 * Logs a message under the strategy tag, printed if GEKKO_LOG_LEVEL lets its level through.
 *
 * 'info', 'warn' and 'error' lines are also relayed, whatever GEKKO_LOG_LEVEL, as the strategy info the EventSubscriber sends its
 * strat_info subscribers: log a signal or an order outcome at info. 'debug' lines are not relayed: a subscriber does not want the
 * indicator values of every candle. Below GEKKO_LOG_LEVEL a 'debug' line costs nothing but the message the strategy built.
 *
 * 'error' does not return: it relays the line, then throws a GekkoError, which stops the bot. The line is relayed at once, not with
 * the other events of its minute, which the stop drops: the subscribers learn why the bot stopped. A level outside these, which only
 * an untyped strategy can pass, is logged and relayed at info, after one warning per level.
 *
 * A message that is not a string, which only an untyped strategy can pass too, is written as util.inspect shows it, the objects it
 * holds two levels deep: on one line, but for an Error, written with its stack.
 * It used to reach the logs and the subscribers as "[object Object]", and one holding a function (`tools` itself) failed its bucket.
 */
export type LoggerFn = (level: LogLevel, msg: string) => void;
export type Tools<T> = {
  /**
   * The parameters of the strategy: the output of its class's schema (see StrategyConstructor), or, for a class without one, the
   * whole top-level `strategy:` block, `name` included. The strategy's own copy, made when the strategy is created: writing to it
   * changes neither the configuration nor what the other plugins read there (the run id of the PerformanceReporter).
   */
  strategyParams: T;
  /**
   * The limits, precision and fees of each watched pair, by pair: its keys are the pairs createOrder and addIndicator accept. The
   * strategy's own copy, made before the first candle: writing to it changes neither the exchange (the fees and limits its simulator
   * applies in backtest and paper trading) nor the pairs those two accept.
   */
  marketData: Map<TradingPair, MarketData>;
  log: LoggerFn;
  /**
   * Relays an order to the Trader and returns its id at once: the outcome arrives through onOrderCompleted, onOrderCanceled or
   * onOrderErrored. The order is dated (`orderCreationDate`) with the end of the minute being processed.
   *
   * Available once the warmup is over: from log and onTimeframeCandleAfterWarmup on the candle that completes it (the first one
   * with `warmup.candleCount: 0`), then from every hook. Before that, and so always in init, it throws a GekkoError: the bot stops.
   *
   * The order holds no key but those of StrategyOrder: `symbol`, `side`, `type`, `amount`, `cost`, `allocation`, `price` and
   * `trailing`. Any other, whatever its value, throws a GekkoError naming it, and the order is not sent: the bot stops. The Trader
   * reads those keys alone and ignored any other: a LIMIT whose price was misspelt (`limitPrice`, `prise`) went at the last price of
   * the pair, an amount given as `quantity` made the order all-in, a stop given under another name was dropped. The order of an event,
   * passed as it is, holds keys of its own, such as `id` and `orderCreationDate`: build the order from its fields.
   *
   * `symbol` must be a watched pair, a key of `marketData`: Gekko has no candle, price or balance of any other pair, so it could
   * neither follow the position nor trail its stop, while a live exchange would still execute the order. Any other symbol throws a
   * GekkoError naming it and the watched pairs, and the order is not sent: the bot stops.
   *
   * `side` must be 'BUY' or 'SELL', and `type` 'MARKET', 'STICKY' or 'LIMIT', in upper case: ccxt spells them in lower case, which
   * only an untyped strategy can pass.
   *
   * At most one of `amount`, `cost` and `allocation` sizes the order, each a number above 0 or left out, `allocation` at most 100. The
   * Trader works out the amount of an order sized otherwise than by an amount from the free balances its last synchronization read (at
   * start-up, at the end of the warmup, after the end of every order, and periodically: every exchangeSynchInterval in realtime, every
   * timeframe candle in a backtest, 10 minutes at least), at the price of the order, else the last price of the pair:
   * - `amount`, in the asset: a BUY with an amount is placed as asked.
   * - `cost`, in the currency of the pair (the USDT of BTC/USDT): a BUY spends at most that, the 5 % kept back for its fee included
   *   (DEFAULT_FEE_BUFFER), so it buys cost × 0.95 / price, and a cost of all the currency free is an all-in BUY; a SELL sells
   *   cost / price, its fee taken from what it brings in.
   * - `allocation`, a share in percent (25 for 25 %) of the currency free for a BUY, of the asset free for a SELL, as that
   *   synchronization read them, not of what the orders placed since leave: two BUYs of 50 % on one candle are both sized from the
   *   whole, and a BUY of 100 % is an all-in BUY.
   * - none of them: the order is all-in. A BUY spends the currency free, less what the BUYs placed since then may spend (a BUY of an
   *   amount its cost at the price of its order plus the 5 % kept back for its fee, any other BUY all it was sized from), keeping back
   *   5 % of it for the fee; a SELL sells the asset free, less what the SELLs placed since then take. An all-in order the orders before
   *   it leave nothing to is sized to 0, and refused by the limits of the market (onOrderErrored).
   *
   * A BUY sized from a cost or an allocation is capped, with a warning, at the currency the BUYs placed since then leave: with nothing
   * left to spend (none free, no balance read yet, or the BUYs placed since taking it all), it is sized to 0 and refused, as an all-in
   * BUY is, with a warning that says why. A SELL so sized is capped as a SELL of an amount is, at the asset free less what the SELLs
   * placed since then take. Every SELL, and every BUY without an amount, is also capped at the most the market takes in one order of
   * its type, with a warning, the rest held or left unspent. An order sized by a cost or an allocation whose amount, truncated to the
   * amount step of the market as the exchange takes it, costs less at its price than the minimum cost of the market (a BUY costs 95 % of
   * its budget at most) is warned of before it is sent, and the exchange refuses it (onOrderErrored, which counts towards the circuit
   * breaker); one the step cuts to 0 is refused for its amount, its reason naming the step.
   *
   * A price left out is the last price of the pair: the limit of a LIMIT order, and what a BUY without an amount, or a SELL of a cost,
   * is sized at. Anything else (NaN, 0, a negative number, Infinity, a quoted number, an allocation above 100) throws a GekkoError
   * naming the field and what it accepts, and so do two of `amount`, `cost` and `allocation`, naming them: the order is not sent, and
   * the bot stops, even for an amount a strategy computed as 0, which used to come back as an order error.
   *
   * The events of the order carry the amount it was placed with (once completed, the amount it executed), and its `cost` or its
   * `allocation` as the strategy gave them (see OrderInitiatedEvent).
   *
   * A `trailing` is checked before anything is relayed: on a BUY only, with a percentage above 0 and below 100, a trigger above 0 or
   * left out, and no other key (a trigger misspelt `triger` armed a stop active at once). Anything else throws a GekkoError and the
   * order is not sent: the bot stops. The stop is armed, once the BUY completes, from a copy taken here: changing the object
   * afterwards moves nothing.
   *
   * A stop protects the position its BUY opened until the strategy sells on that pair: once a SELL the strategy created completes
   * there, every stop armed on the pair is canceled, whatever the amount sold, with a line at info level. So a strategy that scales
   * out loses its stops at its first SELL. The SELL a stop sends cancels no other stop, and a stop whose BUY has not completed yet is
   * kept: it protects the position that BUY opens.
   *
   * While a SELL the strategy created is pending on a pair, the stops of that pair trail on but do not trigger (said once per stop,
   * at info level): the exchange reserves the asset for that SELL, and the SELL of a stop would be refused. Canceled or errored, with
   * no other SELL of the strategy pending there, that SELL releases them (at info level too): from the next minute, a price at or
   * below a stop price triggers that stop. So a SELL left pending, a take-profit LIMIT above the market for instance, leaves the
   * position without a working stop for as long as it pends, the part of the position it does not reserve included.
   *
   * A BUY that errors after filling part of its amount (`order.filled` in onOrderErrored) gets its stop for that part, with a
   * warning. One that errors with no fill reported loses it, with a warning too. When the BUY may still be live on the exchange
   * (`order.mayBeLive`), the warning adds that what it may still fill, or may have executed unreported, has no stop. A BUY canceled
   * loses its stop, even after a partial fill.
   */
  createOrder: (order: StrategyOrder) => UUID;
  cancelOrder: (orderId: UUID) => void;
  /**
   * Cancels the trailing stop of the BUY `orderId` (TrailingStopState.id), before or after the BUY completes, and while the stop
   * sells: the SELL it sent is then the strategy's alone, and its failure no longer brings the stop back (see
   * Strategy.onTrailingStopTriggered). A strategy that exits need not call it: while its SELL is pending the stops of the pair do not
   * trigger, once that SELL completes they are canceled, and if it fails they protect the position again (see createOrder).
   */
  cancelTrailingOrder: (orderId: UUID) => void;
};
export type OnCandleEventParams<T> = {
  /** The timeframe candle of every watched pair: the strategy's own copy, made once per candle and shared by the hooks of that candle */
  candle: CandleBucket;
  /**
   * The latest portfolio, as of the candle: the balance the TradingAdvisor reads at start-up, then the one the Trader sends with a
   * portfolio change or the end of an order (read after that order ended, whatever the Trader's portfolioUpdates filter). The
   * strategy's own copy, made when it was received and kept until the next one
   */
  portfolio: Portfolio;
  tools: Tools<T>;
};
/**
 * What init gets: the portfolio and the tools every timeframe candle hook gets (see OnCandleEventParams), a one-minute candle of every
 * watched pair, addIndicator, and the orders open on the exchange at start-up
 */
export type InitParams<T> = Omit<OnCandleEventParams<T>, 'candle'> & {
  /**
   * The candles of the first one-minute bucket, which init runs on (see Strategy.init): the strategy's own copy. Its pairs are those of
   * every timeframe candle, in the order of watch.assets. Its prices are that minute's, in realtime a minute of the warmup history: a
   * price to start trading from is that of the first candle after the warmup (see Strategy.onTimeframeCandleAfterWarmup)
   */
  candle: CandleBucket;
  /** Available here only (see AddIndicatorFn) */
  addIndicator: AddIndicatorFn;
  /**
   * The orders open on each watched pair when the run started, before it placed any: placed by a previous run, by hand or by another
   * bot. The run does not follow them: the Trader follows the orders of this run only, so no hook hears of their fills or of their
   * end. Read from the exchange once, at start-up, and never refreshed: the strategy's own copy. None in a backtest or a paper session,
   * whose simulator starts empty. The StrategyManager always gives it: it is optional for the code that builds these parameters itself,
   * as a strategy's tests do.
   */
  openOrders?: Map<TradingPair, OpenOrder[]>;
};
/** What an order hook gets */
type OrderEventParams<Order, T> = {
  /** The order: the strategy's own copy of the event, which every other plugin listening to it receives as it was */
  order: Order;
  /** The portfolio after the order and the price of its pair, in that copy too */
  exchange: ExchangeEvent;
  tools: Tools<T>;
};
export type OnOrderCompletedEventParams<T> = OrderEventParams<OrderCompletedEvent['order'], T>;
export type OnOrderCanceledEventParams<T> = OrderEventParams<OrderCanceledEvent['order'], T>;
export type OnOrderErroredEventParams<T> = OrderEventParams<OrderErroredEvent['order'], T>;
/**
 * The hooks of a strategy, each optional, which the StrategyManager calls.
 *
 * What a hook receives is the strategy's own copy: the candles, the portfolio, the indicator results, the order and the exchange event
 * of an order hook, the state of a trailing stop, the orders open at start-up, `tools.strategyParams` and `tools.marketData`. Writing
 * to it changes nothing elsewhere: not the configuration, the exchange or its simulator, the indicators, the other plugins (the
 * analyzers, the reporters), nor what the StrategyManager itself goes by. Where each is declared says when its copy is made.
 */
export interface Strategy<T> {
  /**
   * Executed once, on the first one-minute bucket, before any timeframe candle: in realtime the first minute of the warmup history,
   * replayed at start-up (with no history to replay, the first live minute, once it closes), in a backtest the first minute of
   * watch.daterange. The place to pick the pairs and to register the indicators, addIndicator being refused once it has returned: an
   * indicator misspelt there, or a parameter refused there, stops the bot at start-up, not when the first timeframe candle closes, up
   * to a day later on 1d without warmup. The warmup is not over: no orders here (see Tools.createOrder).
   */
  init?(params: InitParams<T>): void;
  /**
   * On each timeframe candle from the beginning, the warmup included, before log and onTimeframeCandleAfterWarmup: it can create
   * orders from the candle after the one that completes the warmup (see Tools.createOrder).
   */
  onEachTimeframeCandle?(params: OnCandleEventParams<T>, ...indicators: IndicatorResults[]): void;
  /** On each timeframe candle from the warmup event */
  onTimeframeCandleAfterWarmup?(params: OnCandleEventParams<T>, ...indicators: IndicatorResults[]): void;
  /** Let you log everything you need, called every timeframe candle after warmup */
  log?(params: OnCandleEventParams<T>, ...indicators: IndicatorResults[]): void;
  /** On each order completed successfully by the exchange */
  onOrderCompleted?(params: OnOrderCompletedEventParams<T>, ...indicators: IndicatorResults[]): void;
  /**
   * On each order canceled, by the strategy (tools.cancelOrder) or by the exchange (expired, canceled from its interface). It may have
   * executed part of its amount first: `order.filled` is the largest fill any answer of the exchange reported for it, a poll before
   * the cancelation included, and `order.remaining` what was left of its amount. A number, 0 included, is a fact: 0 filled means that
   * nothing executed. Both are undefined when no answer reported a fill: unknown, not 0 filled, and the portfolio after the order
   * (`exchange.portfolio`) tells what is held.
   */
  onOrderCanceled?(params: OnOrderCanceledEventParams<T>, ...indicators: IndicatorResults[]): void;
  /**
   * On each order errored, or rejected by the exchange. It may have executed part of its amount first: `order.filled` is what the
   * exchange reported it filled, 0 when it reported nothing.
   *
   * `order.mayBeLive` says whether the order may still be live on the exchange, where Gekko follows it no more: its creation's outcome
   * is unknown (its answer lost on the network, the order created but its state not read back, or the creation failed by the exchange
   * without a refusal), or a poll or a cancelation failed for good while it was open. It may then have executed more than
   * `order.filled`, or execute later, and no event will tell: placed again, it may be doubled. Check it on the exchange before placing
   * it again, or go by the portfolio the next hooks get, rather than take the error for the end of the order. False when the exchange
   * refused it, or nothing of it was left open: what it executed is `order.filled`, as far as the exchange reported.
   */
  onOrderErrored?(params: OnOrderErroredEventParams<T>, ...indicators: IndicatorResults[]): void;
  /**
   * On each trailing stop activated: when the high of a one-minute candle reaches its trigger, or, for a stop without one, as soon
   * as it is armed, right after the hook of its BUY's end: onOrderCompleted, or onOrderErrored for a BUY that errored after a reported
   * fill, whose stop is armed for that fill (see Tools.createOrder). The latter has not trailed any candle yet: its highestPeak and
   * stopPrice are still 0. The former's peak is that candle's open when the open reached the trigger, else its high; the rest of the
   * candle is trailed after this hook (see TrailingStopState.highestPeak), unless the stop is canceled here
   * (tools.cancelTrailingOrder(state.id), state.id being its BUY's id).
   *
   * `tools` is the object every other hook gets, passed last so that a hook written with the state alone still fits.
   */
  onTrailingStopActivated?(state: TrailingStopState, tools: Tools<T>): void;
  /**
   * On each trailing stop triggered: when a price of a one-minute candle, met as open, low, high, close, reaches the stop price (see
   * TrailingStopState.highestPeak). The state holds the peak and the stop price of that moment.
   *
   * `orderId` is the MARKET SELL the StrategyManager has just created for the stop, of the amount the stop protects (state.amount). From
   * now on it is an order of the strategy's own: its outcome comes through onOrderCompleted, onOrderCanceled or onOrderErrored, under
   * that id, and a strategy that tracks its position adopts it as its pending SELL (PositionTracker.adoptSell, or
   * PositionBook.adoptSell(orderId, state.symbol) for the tracker of the stop's pair). Not adopted, it leaves the strategy long once
   * the stop has sold everything, and the SELL the strategy advises next is refused: nothing is left.
   *
   * The stop sells until that SELL ends (state.status 'selling', state.sellOrderId). Completed for all the stop sells, the stop is
   * over. So it is when that SELL errors or is canceled after a reported fill (order.filled) of all of it, said at info level under
   * the 'trailing stop' tag, not the strategy's (`Trailing stop of BUY <id> over: its SELL <id> sold 0.5, all of its 0.5`). Completed
   * for less (the Trader caps a SELL to the free balance and to the most the market takes in one order, and the exchange truncates its
   * amount to the step of the market), errored or canceled for less, the stop is active again for what that SELL did not sell,
   * with a warning and without onTrailingStopActivated, from the peak and the stop price it triggered at: the next price at or below
   * that stop price triggers it again, and this hook announces its new SELL, under a new id.
   *
   * Unless that rest is too little to sell at the minimums of the market, those of a MARKET order in tools.marketData, its cost
   * worked out in decimal (see isSellable), whatever else the account holds, and may that SELL still be live or not: the stop is then
   * over, said at info level (`Trailing stop of BUY <id> over: its SELL <id> errored after selling 0.4999 BTC (<reason>), and the
   * rest, 0.0001 BTC, is too little to sell at the minimums of the market`). Nor when the portfolio after that SELL shows too little
   * of the asset free to sell at those minimums, while no SELL the strategy created is pending on the pair: nothing is left to
   * protect, and the stop is over, said at info level after a SELL that completed, with a warning after one that errored or was
   * canceled.
   *
   * A SELL that errored while it may still be live on the exchange (`order.mayBeLive` in onOrderErrored) makes the stop active again
   * all the same for a rest it can sell, with a warning to check that SELL there: a MARKET SELL rests on no book, it may only have
   * executed. If it did, the portfolio after it shows the asset gone and the stop is removed, or the next SELL of the stop is refused
   * for lack of anything to sell and its refusal removes the stop; unless the account holds other coins of the asset free, which that
   * next SELL sells, up to the stop's amount. If it did not, the stop still protects the position. A SELL refused every time with the
   * asset still free (an API key refused, a cost above the maximum of the market) is so sent again on each such minute, each refusal
   * counting towards the circuit breaker, which stops the bot. A strategy that takes over, with a SELL of its own once that one
   * failed, may leave the stop: its SELL holds the stop back until it ends (see Tools.createOrder). To drop the stop, cancel it
   * (tools.cancelTrailingOrder(state.id)), not its SELL: canceled, its SELL makes it active again.
   *
   * `tools` is the object every other hook gets, passed last so that a hook written without it still fits.
   */
  onTrailingStopTriggered?(orderId: UUID, state: TrailingStopState, tools: Tools<T>): void;
  /**
   * Executed once, at the end of the run, or when an error stops it before its end (a crash, missing candles, the circuit breaker):
   * `interruption` is then the message of that error, as the analyzers give it in their reports, and undefined when the run reached
   * its end. Not executed when a signal (SIGINT, SIGTERM) or an uncaught exception ends Gekko at once.
   */
  end?(interruption?: string): void;
}

/**
 * A strategy class, as the TradingAdvisor's `strategyName` selects it: an export of `strategies/index.ts`, or, with `strategyPath`,
 * a named export of that file. The StrategyManager constructs it without arguments.
 *
 * Its optional static `schema` validates the top-level `strategy:` block once, when the strategy is created, before any candle:
 * - it receives the block without its `name` key, which only labels the run and which the configuration schema checks against
 *   `strategyName`, so it does not declare `name`;
 * - it should be a `z.strictObject`, nested objects included, so that a misspelt key is refused instead of leaving its parameter
 *   undefined;
 * - its output, defaults applied, is exactly what the strategy gets as `tools.strategyParams`, without `name`: deriving `T` from it
 *   (`z.infer<typeof schema>`) keeps the two in step.
 *
 * Any issue refuses the run with a GekkoError listing them all. A class without a schema gets the whole block, `name` included,
 * unvalidated.
 */
export type StrategyConstructor<T = object> = {
  new (): Strategy<T>;
  schema?: z.ZodType<T>;
};
