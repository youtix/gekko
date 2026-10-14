import { MarketData } from '@services/exchange/exchange.types';
import { getPriceTick, roundToStep } from '@utils/market/precision.utils';
import { isFinitePositive } from '@utils/math/math.utils';

/**
 * The amount and the price of an order as CCXTExchange sends them to the exchange (see its roundToMarketPrecision): the amount truncated
 * to the step of the market, the price rounded half up to its tick at that price (see roundToStep and getPriceTick). The simulator
 * checks the limits of the market, books the balances and fills the order on them. It used to take them as they came, and so filled
 * quantities a live run never sends: GridBot's 0.00008595077805222816 BTC on a step of 0.00001, which CCXTExchange sends as 0.00008, or
 * an amount of 17 significant digits, 0.031028229810094173 BTC, what 2000 USDT bought at 61234.56 with 5 % kept back before the Trader
 * sized an all-in BUY to 15 digits (0.0310282298100942), both sent as 0.03102. A value that is not a finite number above 0 is left as
 * it is, as CCXTExchange leaves it, for the limits of the market to refuse it with their own message: floored, -1.234 would be refused
 * as -1.24.
 */
export const roundToMarketPrecision = (amount: number, price: number, { precision }: MarketData) => ({
  amount: isFinitePositive(amount) ? roundToStep(amount, precision?.amount, 'down') : amount,
  price: isFinitePositive(price) ? roundToStep(price, getPriceTick(price, precision), 'up') : price,
});
