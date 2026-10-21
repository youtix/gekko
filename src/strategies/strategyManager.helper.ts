import { ORDER_SIDES, ORDER_TYPES } from '@constants/order.const';
import { copyPayload } from '@helpers/event/event.helper';
import { StrategyOrder } from '@models/advice.types';
import { CandleBucket, ExchangeEvent, OrderInitiatedEvent } from '@models/event.types';
import { TradingPair } from '@models/utility.types';
import { MarketData } from '@services/exchange/exchange.types';
import { isFinitePositive } from '@utils/math/math.utils';
import { listInWords } from '@utils/string/string.utils';
import { isNil, isPlainObject } from 'lodash-es';
import { inspect } from 'node:util';
import { ORDER_KEYS, SIZING_KEYS, TRAILING_KEYS } from './strategyManager.const';
import { TrailingStopState } from './trailingStopManager.types';

/**
 * What is wrong with the pair an order or an indicator names, or undefined when it is watched: a key of `marketData`, which the
 * TradingAdvisor fills with every watched pair before the first candle. Gekko has no candle, price or balance of any other pair.
 */
export const getPairProblem = (symbol: TradingPair, marketData: Map<TradingPair, MarketData>): string | undefined => {
  if (marketData.has(symbol)) return;
  return `symbol must be one of the watched pairs (${[...marketData.keys()].join(', ')}), got ${inspect(symbol)}`;
};

/**
 * What is wrong with the parameters of an indicator, or undefined when nothing is: a plain object of its parameters by name, or none
 * (undefined, or null from an untyped strategy), which addIndicator hands on as {} for the defaults of the indicator. Handed on as they
 * came, null threw a TypeError in every constructor but two, and undefined in most of those whose period has no default, naming
 * neither the indicator nor the parameter. A number, a string, an array or a Map, which only an untyped strategy can pass, was read as
 * an object holding none of the parameters: addIndicator('RSI', pair, 7) built an RSI of 14 without a word, and an ATR said its period
 * was undefined. An instance of a class, not a plain object either, is refused with them: an object literal and the strategy block
 * both are plain objects.
 */
export const getParametersProblem = (parameters: unknown): string | undefined => {
  if (isNil(parameters) || isPlainObject(parameters)) return;
  return `parameters must be a plain object of the indicator's parameters by name, {} to take its defaults, got ${inspect(parameters)}`;
};

/** Values as util.inspect shows them, quoted when they are strings: the case of a side or a type shows */
const showValues = (values: readonly unknown[]) => values.map(value => inspect(value)).join(', ');

/** The keys of `object` that are not among `keys`, in the order `object` holds them, whatever their values: undefined ones included */
const getUnknownKeys = (object: object, keys: readonly string[]) => Object.keys(object).filter(key => !keys.includes(key));

/**
 * What is wrong with the keys of an order, or undefined when it holds none but those of StrategyOrder. The Trader reads those alone,
 * and any other key was relayed and ignored: a LIMIT whose price was misspelt (limitPrice, prise) was placed at the last price of the
 * pair, where it filled at once, a take-profit SELL selling at the market; an amount given as quantity made the order all-in; a
 * trailing stop given under another name was dropped, the BUY going without it. So would a misspelt cost or allocation make the order
 * all-in: a BUY whose share was spelt allocaton would spend all the currency free, not the share it asked for. Refused whatever its
 * value, undefined included: a misspelt key fed from an optional parameter is caught at the first order, not on the first run that
 * sets it. Checked before the fields, a misspelt symbol, side or type is named, not reported as undefined.
 */
export const getKeysProblem = (order: StrategyOrder): string | undefined => {
  const unknownKeys = getUnknownKeys(order, ORDER_KEYS);
  if (unknownKeys.length) return `order keys must be one of ${showValues(ORDER_KEYS)}, got ${showValues(unknownKeys)}`;
};

/**
 * What is wrong with the side, the type, the size or the price of an order, or undefined when nothing is: a side of ORDER_SIDES and a
 * type of ORDER_TYPES as they are spelt there; an amount, a cost and a price above 0, and an allocation above 0 and at most 100, each
 * of them left out otherwise (undefined, or null from an untyped strategy, as the Trader reads them); at most one of amount, cost and
 * allocation, none of them for an all-in order, and no price for the last price of the pair. Each layer below read them its own way.
 * ccxt's 'buy', which only an untyped strategy can pass, was sized by the Trader as a SELL, all the asset held, which the simulator
 * executed as a SELL and Binance as a BUY; 'market' threw a TypeError in the Trader after the order was initiated, which stopped the
 * bot without naming the strategy. An amount or a price of NaN, 0 or below, or quoted, was refused by the Trader or by the exchange as
 * an error counting towards the circuit breaker. So would an order whose cost or allocation is, the Trader working its amount out from
 * them; an allocation above 100 would size a share of more than the balance read, which the Trader caps at what is left with a
 * warning: an all-in order the strategy did not ask for. Given two of amount, cost and allocation, the Trader would size the order from
 * one and ignore the others, without a word.
 */
export const getOrderProblem = (order: StrategyOrder): string | undefined => {
  const { side, type, amount, cost, allocation, price } = order;
  if (!ORDER_SIDES.includes(side)) return `side must be one of ${showValues(ORDER_SIDES)}, got ${inspect(side)}`;
  if (!ORDER_TYPES.includes(type)) return `type must be one of ${showValues(ORDER_TYPES)}, got ${inspect(type)}`;
  if (!isNil(amount) && !isFinitePositive(amount))
    return `amount must be a number above 0, or left out for an all-in order, got ${inspect(amount)}`;
  if (!isNil(cost) && !isFinitePositive(cost))
    return `cost must be a number above 0, in the currency of the pair, or left out, got ${inspect(cost)}`;
  if (!isNil(allocation) && !(isFinitePositive(allocation) && allocation <= 100))
    return `allocation must be a number above 0 and at most 100 (25 for 25 %), or left out, got ${inspect(allocation)}`;
  const sizingKeys = SIZING_KEYS.filter(key => !isNil(order[key]));
  if (sizingKeys.length > 1)
    return `amount, cost and allocation size an order three ways: give at most one, got ${listInWords(sizingKeys)}`;
  if (!isNil(price) && !isFinitePositive(price))
    return `price must be a number above 0, or left out for the last price of the pair, got ${inspect(price)}`;
};

/**
 * What is wrong with the trailing stop an order asks for, or undefined when it asks for none or for a valid one: on a BUY only, with no
 * key but those of TrailingConfig, within the bounds the TrailingStopManager checks again as it arms the stop. A trigger left out
 * (undefined, or null from an untyped strategy) asks for a stop active as soon as it is armed.
 */
export const getTrailingProblem = ({ side, trailing }: StrategyOrder): string | undefined => {
  if (!trailing) return;
  if (side !== 'BUY') return 'trailing applies to BUY orders only: its stop sells what the BUY filled';
  // A misspelt key was ignored: { percentage: 2, triger: 50000 } armed a stop active at once, not one waiting for 50000
  const unknownKeys = getUnknownKeys(trailing, TRAILING_KEYS);
  if (unknownKeys.length) return `trailing keys must be one of ${showValues(TRAILING_KEYS)}, got ${showValues(unknownKeys)}`;
  const { percentage, trigger } = trailing;
  if (!(isFinitePositive(percentage) && percentage < 100))
    return `trailing.percentage must be a number above 0 and below 100 (2.5 for 2.5%), got ${inspect(percentage)}`;
  if (!isNil(trigger) && !isFinitePositive(trigger))
    return `trailing.trigger must be a price above 0, or left out for a stop active as soon as its BUY completes, got ${inspect(trigger)}`;
};

/**
 * The strategy's own copy of a bucket: a timeframe bucket for the candle hooks, the first one-minute bucket for init. A timeframe
 * bucket is the TradingAdvisor's, queued as the timeframe candle event once the hooks have run, and its candles are those the
 * indicators are fed, which some keep (the previous candle of TrueRange, PSAR and ±DM, the window of CCI): a close the strategy
 * overwrote reached the analyzers, the warmup event and every later ATR. A one-minute bucket is the one every plugin receives, which
 * the TradingAdvisor then batches. A candle holds numbers and a flag only, so a spread copies it.
 */
export const copyBucket = (bucket: CandleBucket): CandleBucket => {
  const copy: CandleBucket = new Map();
  for (const [pair, candle] of bucket) copy.set(pair, { ...candle });
  return copy;
};

/**
 * The strategy's own copy of an indicator's result: a number or null as it is, an object or an array copied with what it holds (the
 * array of a ribbon). Handed out as it was, the result was the indicator's own object: a write by one hook reached the hooks after it,
 * and the next candles while the indicator handed that object out again, as MACD and Stochastic did while warming up.
 */
export const copyResult = (result: unknown): unknown => {
  if (Array.isArray(result)) return result.map(copyResult);
  // Not lodash's isPlainObject, which doubled the cost of a copy: a result is declared as numbers, objects and arrays of them
  if (result === null || typeof result !== 'object') return result;
  const source = result as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key in source) copy[key] = copyResult(source[key]);
  return copy;
};

/**
 * The strategy's own copy of an order event: the StrategyManager reads the event again once the hook has run, to arm and settle the
 * trailing stops, and a BUY whose side the strategy rewrote to SELL canceled the stop it had just armed. The event is the
 * TradingAdvisor's own, each listener of a deferred event getting its copy: what the strategy writes reaches no other plugin either
 * way. It holds plain data and a Map, which copyPayload copies by hand: structuredClone took five times as long, on every order end.
 */
export const copyOrderEvent = <O extends OrderInitiatedEvent['order']>(order: O, exchange: ExchangeEvent) =>
  copyPayload({ order, exchange });

/** What a stop sells, and when, as the warnings about it say: its amount, its stop price and the peak that price trails from */
export const describeSale = ({ symbol, amount, stopPrice, highestPeak }: TrailingStopState) => {
  const [asset] = symbol.split('/');
  return `${amount} ${asset} once a price reaches its stop price, ${stopPrice}, trailing from its peak, ${highestPeak}`;
};
