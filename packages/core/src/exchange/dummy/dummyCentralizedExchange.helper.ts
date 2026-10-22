import { getPriceTick, roundToStep } from '@gekko/shared/helpers/market/precision.helper';
import { OrderSide } from '@gekko/shared/models/order.types';
import { BalanceDetail } from '@gekko/shared/models/portfolio.types';
import { MarketData } from '@gekko/shared/models/exchange.types';
import { addPrecise, isFinitePositive } from '@gekko/shared/utils/math/math.utils';
import { formatEveryDecimal } from '@gekko/shared/utils/string/string.utils';

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

/**
 * Why an order is refused for want of a free balance: what the portfolio holds free and what the order needs of it, the currency a BUY
 * costs, or the amount of the asset a SELL sells, each with every decimal (see formatEveryDecimal). Written by String, a dust balance
 * read 5e-7, and a limit SELL's amount was labelled its order cost.
 */
export const describeShortfall = (side: OrderSide, free: number, need: number) =>
  side === 'BUY'
    ? `Insufficient currency balance (portfolio: ${formatEveryDecimal(free)}, order cost: ${formatEveryDecimal(need)})`
    : `Insufficient asset balance (portfolio: ${formatEveryDecimal(free)}, amount: ${formatEveryDecimal(need)})`;

/**
 * Adds each change to its part of the balance (free, used or total) in decimal, as addPrecise does: an exchange books decimals. Added in
 * binary, the parts drifted from what was booked: 0.05 BTC sold as five SELLs of 0.01 left 0.009999999999999997 free after the fourth,
 * and the fifth was refused; the SELLs of a grid, all canceled, left 8.9e-16 BTC used, and free + used no longer made the total.
 * Exact as long as addPrecise is: up to some 67 million for a balance of 8 decimals (2 ** 26, from where doubles are more than 1e-8 apart).
 */
export const addToBalance = (balance: BalanceDetail, changes: Partial<BalanceDetail>) => {
  for (const [part, change] of Object.entries(changes) as [keyof BalanceDetail, number][])
    balance[part] = addPrecise(balance[part], change);
};
