import { EMPTY_ORDER_SUMMARY } from '@constants/order.const';
import { ONE_SECOND } from '@constants/time.const';
import { GekkoError } from '@errors/gekko.error';
import { OrderSide, OrderType } from '@models/order.types';
import { Trade } from '@models/trade.types';
import { TradingPair } from '@models/utility.types';
import { Exchange } from '@services/exchange/exchange.types';
import { debug } from '@services/logger';
import { toISOString } from '@utils/date/date.utils';
import { addPrecise, isFiniteNumber, multiplyPrecise, toSignificantDigits } from '@utils/math/math.utils';
import { filter, isNil, last, map, min, sortBy } from 'lodash-es';
import { UUID } from 'node:crypto';
import { OrderSummary, Transaction } from './order.types';

/**
 * Nobody awaits launch(), cancel() or checkOrder() (the Trader floats them, an interval runs checkOrder), so an order reports a failure
 * through orderErrored and never throws: a thrown value that is not an Error is wrapped in one rather than dropped, so that the order
 * still ends with ORDER_ERRORED_EVENT. The order classes import it from here.
 */
export { toError } from '@errors/error.utils';

/**
 * The mean of `values` weighted by `weights`, worked out in decimal: the products and the sums exactly (see multiplyPrecise and
 * addPrecise), the one division to 15 significant digits (see toSignificantDigits). Values all the same give that value. Worked out
 * in binary, the mean of a single price came out off it (104.44 for 2.5 gave 104.44000000000001), and so did a mean as short as the
 * prices (104.44 and 104.46 for 0.3 each gave 104.44999999999999). NaN when the lists differ in length, are empty, or when the
 * weights add up to 0 or to no finite number.
 */
export const getWeightedAverage = (values: number[], weights: number[]): number => {
  if (values.length !== weights.length || !values.length) return NaN;
  const totalWeight = weights.reduce((sum, weight) => addPrecise(sum, weight), 0);
  if (!isFiniteNumber(totalWeight) || totalWeight === 0) return NaN;
  if (values.every(value => value === values[0])) return toSignificantDigits(values[0]);
  const total = values.reduce((sum, value, index) => addPrecise(sum, multiplyPrecise(value, weights[index])), 0);
  return toSignificantDigits(total / totalWeight);
};

type CreateOrderSummaryParams = {
  id: UUID;
  symbol: TradingPair;
  exchange: Exchange;
  type: OrderType;
  side: OrderSide;
  transactions: Transaction[];
};

/**
 * The bound the trades of an order are fetched from: the start of the second of its oldest transaction, which is not always the
 * first one listed (a timestamp may be the last update of the exchange order, or the time its state was read). Only finite
 * timestamps count. Without any, undefined: the exchange then returns its latest trades, where a NaN bound found none.
 * The second is floored in epoch milliseconds: date-fns' startOfSecond works in local time, where a wall-clock time of the hour
 * repeated when DST ends resolves to its first pass, so the trades of a transaction of the second pass were fetched from an hour
 * earlier.
 */
const getTradesStart = (transactions: Transaction[]) => {
  const oldestTimestamp = min(filter(map(transactions, 'timestamp'), timestamp => Number.isFinite(timestamp)));
  return isNil(oldestTimestamp) ? undefined : Math.floor(oldestTimestamp / ONE_SECOND) * ONE_SECOND;
};

type RatedTrade = Trade & { fee: { rate: number } };

/**
 * The fee rate of an order, in %: the mean of the rates of its trades, each weighted by its own amount, over the trades whose rate
 * is known (a finite number; 0 is a trade without fees). Undefined, for unknown, when no rate is known or their trades weigh nothing.
 */
const getFeePercent = (trades: Trade[]) => {
  const ratedTrades = trades.filter((trade): trade is RatedTrade => Number.isFinite(trade.fee?.rate));
  const feePercent = getWeightedAverage(
    ratedTrades.map(({ fee }) => fee.rate),
    map(ratedTrades, 'amount'),
  );
  return Number.isFinite(feePercent) ? feePercent : undefined;
};

export const createOrderSummary = async ({
  id,
  symbol,
  exchange,
  type,
  side,
  transactions,
}: CreateOrderSummaryParams): Promise<OrderSummary> => {
  if (!transactions.length) throw new GekkoError('core', `[${id}] Order is not completed`);

  const from = getTradesStart(transactions);
  const myTrades = await exchange.fetchMyTrades(symbol, from);
  const orderIDs = map(transactions, 'id');
  const trades = sortBy(
    filter(myTrades, trade => orderIDs.includes(trade.id)),
    'timestamp',
  );
  const orderExecutionDate = last(trades)?.timestamp;

  debug(
    'core',
    [`[${id}] ${trades.length} trades used to fill ${side} ${type} order.`, `First trade started at: ${toISOString(from)}.`].join(' '),
  );

  if (!trades.length || !orderExecutionDate) return { ...EMPTY_ORDER_SUMMARY, side };

  // The trades' amounts added up, and their prices averaged, in decimal (see getWeightedAverage): the price of a LIMIT order filled
  // at 104.44 came out as 104.44000000000001, and two trades of 0.1 and 0.2 made an amount of 0.30000000000000004
  return {
    amount: trades.reduce((sum, { amount }) => addPrecise(sum, amount), 0),
    price: getWeightedAverage(map(trades, 'price'), map(trades, 'amount')),
    feePercent: getFeePercent(trades),
    side,
    orderExecutionDate,
  };
};
