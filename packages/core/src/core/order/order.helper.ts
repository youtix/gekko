import { EMPTY_ORDER_SUMMARY } from '@gekko/shared/constants/order.const';
import { ONE_SECOND } from '@gekko/shared/constants/time.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { FeeTakenInAsset } from '@gekko/shared/models/event.types';
import { OrderSide, OrderType } from '@gekko/shared/models/order.types';
import { Trade } from '@gekko/shared/models/trade.types';
import { Asset, TradingPair } from '@gekko/shared/models/utility.types';
import { Exchange } from '@gekko/shared/models/exchange.types';
import { toPercent } from '@gekko/shared/helpers/finance/stats.helper';
import { debug } from '../../logger/logger';
import { toISOString } from '@gekko/shared/utils/date/date.utils';
import { shiftDecimalPoint } from '@gekko/shared/utils/math/round.utils';
import { addPrecise, isFiniteNumber, multiplyPrecise, toSignificantDigits } from '@gekko/shared/utils/math/math.utils';
import { compact, filter, isNil, last, map, min, sortBy, uniq } from 'lodash-es';
import { UUID } from 'node:crypto';
import { OrderSummary, Transaction } from './order.types';

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

/** What a trade cost, in currency: its amount times its price, multiplied as they are written (see multiplyPrecise) */
const getTradeCost = ({ amount, price }: Trade) => multiplyPrecise(amount, price);

/**
 * Whether the fee of a trade was taken in a third asset, neither the asset nor the currency of the pair (`pair`, the two names of its
 * symbol): BNB with Binance's fee discount, whose rate the exchange gives none of (see Trade.fee.rate)
 */
const isTakenInThirdAsset = ({ fee }: Trade, pair: string[]) => !!fee?.currency && !pair.includes(fee.currency);

/**
 * The asset the fee of an order was taken in: the one that every trade of the order which names the currency of its fee names (see
 * Trade.fee.currency), whatever its rate. Undefined when none names one, or when they name several, as the trades of an order filled
 * as the BNB that paid the fees of the first ones ran out: what the others took of the asset is then the order's feeTakenInAsset (see
 * getFeeTakenInAsset). The Trader relays it beside the fee, which it reports in currency whatever the asset (see
 * Trader.checkOrderSummary).
 */
const getFeeAsset = (trades: Trade[]): Asset | undefined => {
  const assets = uniq(compact(trades.map(({ fee }) => fee?.currency)));
  return assets.length === 1 ? assets[0] : undefined;
};

/**
 * What the fee of a trade taken in the asset of the pair took of it, in the asset: its cost as the exchange reports it, else its rate of
 * the amount of the trade, worked out in decimal; 0 when it gives neither, unknown
 */
const getAmountTakenByFee = ({ amount, fee }: Trade) => {
  if (isFiniteNumber(fee?.cost)) return fee.cost;
  return isFiniteNumber(fee?.rate) ? multiplyPrecise(amount, shiftDecimalPoint(fee.rate, -2)) : 0;
};

/**
 * What the fees of an order took of the asset of its pair (`assetName`, see OrderSummary.feeTakenInAsset): over the trades that name the
 * asset as the currency of their fee, the amount each fee took (see getAmountTakenByFee) and its value at the price of its trade, each
 * added up in decimal; undefined when no trade took its fee in the asset. The round trip of a BUY holds that much less of the asset, and
 * leaves that value, the part of the fee of the order it is, out of its fees (see RoundTripTracker.countBuyFee): worked back from the
 * fee in currency, as it was while the order named the asset alone, it missed the part a BUY whose BNB ran out partway took in the asset.
 */
const getFeeTakenInAsset = (trades: Trade[], assetName: string): FeeTakenInAsset | undefined => {
  const takingTrades = trades.filter(({ fee }) => fee?.currency === assetName);
  if (!takingTrades.length) return undefined;
  return takingTrades.reduce(
    ({ amount, value }, trade) => {
      const taken = getAmountTakenByFee(trade);
      return { amount: addPrecise(amount, taken), value: addPrecise(value, multiplyPrecise(taken, trade.price)) };
    },
    { amount: 0, value: 0 },
  );
};

/**
 * The fee of a trade whose rate is known (see Trade.fee.rate), in the currency of its pair (`pair`, the asset and the currency of its
 * symbol), as the exchange reports it, worked out in decimal: one taken in the asset, what it took of it (see getAmountTakenByFee) at the
 * price of the trade, the part of the feeTakenInAsset of the order it adds; one taken in the currency, its cost as it is; else its rate
 * of the cost of the trade, for a fee the exchange gives the rate of alone (the simulator), or one taken in a third asset at a rate given.
 * Not the rate whatever the fee: ccxt gives a fee by its cost, which mapCcxtTradeToTrade turns into a rate, a quotient rounded to 15
 * significant digits, so that the cost of the trade times that rate missed a Binance commission rounded to 8 decimals (0.07531851 USDT
 * on 0.00123 BTC at 61234.56 came back as 0.0753185100000001).
 */
const getTradeFee = (trade: RatedTrade, [assetName, currencyName]: string[]) => {
  const { fee, price } = trade;
  if (fee.currency === assetName) return multiplyPrecise(getAmountTakenByFee(trade), price);
  if (fee.currency === currencyName && isFiniteNumber(fee.cost)) return fee.cost;
  return multiplyPrecise(getTradeCost(trade), shiftDecimalPoint(fee.rate, -2));
};

/**
 * The fee of an order, in the currency of its pair, and its rate, in % (see OrderSummary.fee and OrderSummary.feePercent): the fees of its
 * trades added up in decimal, each as the exchange reports it (see getTradeFee), whatever the currency it was taken in, 0 for one taken
 * in a third asset without a rate (BNB with Binance's discount), which no rate converts; and that fee over what the trades it counts
 * cost, the one quotient, to 15 significant digits (see toPercent), a trade whose fee went in BNB weighing all the same. A trade that
 * says nothing of its fee (no rate, and no currency or one of the pair) is left out of both: its fee counts 0, as an unknown fee does,
 * and the rate is that of the others. Both unknown when no trade with a known rate cost anything: none has one (an order whose fees all
 * went in BNB), or theirs were of nothing; or when what the trades cost is not a finite number.
 *
 * The rate was the mean of the rates of the trades weighted by their costs, and the Trader worked the fee back out of it, the cost of
 * the order times that rate, which rounded to 15 significant digits made a fee off the fees of the trades: 0.050010000000000006 for
 * trades of 0.5 at 100 and at 100.02 that paid 0.05001, the first in BNB, and 0.22650000000000078 for trades of 1 at 100 and 2 at 101
 * that paid 0.2265 at one rate, the mean of their prices rounded too. Weighted by the amounts of the trades with a known rate alone,
 * before it, the rate of those trades was taken for that of the whole order: a BUY whose BNB ran out after paying the fees of half its
 * trades was charged the rate of the asset on all of it.
 */
const getOrderFee = (trades: Trade[], pair: string[]): Pick<OrderSummary, 'fee' | 'feePercent'> => {
  const ratedTrades = trades.filter((trade): trade is RatedTrade => isFiniteNumber(trade.fee?.rate));
  const unconvertedTrades = trades.filter(trade => !isFiniteNumber(trade.fee?.rate) && isTakenInThirdAsset(trade, pair));
  const fee = ratedTrades.reduce((sum, trade) => addPrecise(sum, getTradeFee(trade, pair)), 0);
  const cost = [...ratedTrades, ...unconvertedTrades].reduce((sum, trade) => addPrecise(sum, getTradeCost(trade)), 0);
  const feePercent = toPercent(fee, cost);
  const isKnown = ratedTrades.some(trade => getTradeCost(trade) > 0) && isFiniteNumber(feePercent);
  return isKnown ? { fee, feePercent } : { fee: undefined, feePercent: undefined };
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
  const pair = symbol.split('/');
  return {
    amount: trades.reduce((sum, { amount }) => addPrecise(sum, amount), 0),
    price: getWeightedAverage(map(trades, 'price'), map(trades, 'amount')),
    ...getOrderFee(trades, pair),
    feeAsset: getFeeAsset(trades),
    feeTakenInAsset: getFeeTakenInAsset(trades, pair[0]),
    side,
    orderExecutionDate,
  };
};
