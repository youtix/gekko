import { BUY_COST_SHARE, FEE_BUFFER_PERCENT } from '@constants/order.const';
import { getMarketOrderLimits, getSentCost, toBound } from '@helpers/market/market.helper';
import { getAllInBuyAmount } from '@helpers/order/sizing.helper';
import { MarketData } from '@services/exchange/exchange.types';
import { isFinitePositive, multiplyPrecise } from '@utils/math/math.utils';
import { formatEveryDecimal } from '@utils/string/string.utils';
import { BuyOrder } from './positionBook.types';

/**
 * Why the market would refuse the BUY `order`, sized from `budget` of the currency, as the line of its skip says it (see
 * PositionBook.buy), undefined when it would take it. The Trader sizes such a BUY as an all-in BUY of its budget at the price of the
 * order, else the last price of the pair (see getAllInBuyAmount), and the exchange truncates that amount to the amount step of the
 * market, then checks it against the minimum amount of the market (that of a market order for a MARKET one, see getMarketOrderLimits)
 * and its cost against the minimum cost (see getSentCost). Two estimates, in this order:
 * - the budget, less the share DEFAULT_FEE_BUFFER keeps back for the fee, worked out in decimal, against the minimum cost: the most
 *   the BUY can cost;
 * - the amount the Trader sends at `order.price`, else at `close`, the close of the candle (the last price the Trader knows in a
 *   backtest), truncated to the amount step, against the minimum amount, then its cost against the minimum cost. Estimated before the
 *   step alone, a budget that covered the minimum cost was sent, though the step took the amount sent under it, and refused at every
 *   signal of its pair until the refusals stopped the bot: 5.7 USDT at 97654.32 is 0.0000583691535612557 BTC, sent as 0.00005 BTC,
 *   4.882716 USDT, under a minimum of 5. So was one whose amount was under the minimum amount of the market, whatever its cost.
 * Without a price that is a finite number above 0, which the Trader refuses the order for, the second estimate is not made; without a
 * minimum cost or amount on the market, neither is.
 */
export const getBuyRefusal = (
  order: BuyOrder,
  budget: number,
  close: number | undefined,
  marketData: MarketData = {},
): string | undefined => {
  const [asset, currency] = order.symbol.split('/');
  const limits = order.type === 'MARKET' ? getMarketOrderLimits(marketData) : marketData;
  const minimumCost = toBound(limits.cost?.min);
  const minimumAmount = toBound(limits.amount?.min);
  if (minimumCost === undefined && minimumAmount === undefined) return;

  const estimate = multiplyPrecise(budget, BUY_COST_SHARE);
  const keptBack = `${formatEveryDecimal(estimate)} ${currency} once ${FEE_BUFFER_PERCENT} % is kept back for the fee`;
  const belowCost = (minimum: number) => `is below the minimum cost of ${formatEveryDecimal(minimum)} ${currency} of the market`;
  if (minimumCost !== undefined && estimate < minimumCost) return `${keptBack}, ${belowCost(minimumCost)}`;

  const price = order.price ?? close;
  if (!isFinitePositive(price)) return;
  const { sent, cost } = getSentCost(getAllInBuyAmount(budget, price), price, limits);
  const step = toBound(limits.precision?.amount);
  const onStep = step === undefined ? '' : ` once truncated to the amount step ${formatEveryDecimal(step)} of the market`;
  const amountSent = `${formatEveryDecimal(sent)} ${asset} at ${formatEveryDecimal(price)}${onStep}`;
  if (minimumAmount !== undefined && sent < minimumAmount) {
    return `${keptBack}, ${amountSent}, is below the minimum amount of ${formatEveryDecimal(minimumAmount)} ${asset} of the market`;
  }
  if (minimumCost !== undefined && cost < minimumCost) {
    return `${keptBack}, ${amountSent}, a cost of ${formatEveryDecimal(cost)} ${currency}, ${belowCost(minimumCost)}`;
  }
};
