import type { BalanceDetail, Portfolio } from '@models/portfolio.types';
import type { Asset, TradingPair } from '@models/utility.types';
import { addPrecise, multiplyPrecise } from '@utils/math/math.utils';
import { isNil, uniq } from 'lodash-es';

const ZERO_BALANCE: BalanceDetail = { free: 0, used: 0, total: 0 };

export const createEmptyPortfolio = (): Portfolio => new Map();

export const initializePortfolio = (pairs: TradingPair[], initialAmounts?: Map<Asset, number>): Portfolio => {
  const assets = uniq(pairs.flatMap(pair => pair.split('/')));
  return new Map(
    assets.map(asset => [
      asset,
      {
        free: initialAmounts?.get(asset) ?? 0,
        used: 0,
        total: initialAmounts?.get(asset) ?? 0,
      },
    ]),
  );
};

export const getAssetBalance = (portfolio: Portfolio, asset: Asset): BalanceDetail => {
  return portfolio.get(asset) ?? { ...ZERO_BALANCE };
};

export const updateAssetBalance = (portfolio: Portfolio, asset: Asset, balance: BalanceDetail): void => {
  portfolio.set(asset, balance);
};

/**
 * Whether a portfolio was read from the exchange. The end of an order carries the portfolio the Trader read last, which is the empty
 * one it starts with (createEmptyPortfolio) until one of its synchronizations succeeds, while the balance of an exchange lists the asset
 * and the currency of every watched pair, at 0 included. Taken as the latest, that empty one read as an account holding nothing. Its
 * balances cannot tell: an account read from the exchange may hold nothing too.
 */
export const isFetchedPortfolio = (portfolio: Portfolio): boolean => portfolio.size > 0;

/**
 * value + amount × price in decimal (addPrecise, multiplyPrecise), as the exchanges book the balances: the analyzers compare the
 * equities made of it exactly. Made in binary, a position marked at its buy price came out an ulp off the currency it cost, so that
 * round trips sold back at their buy price without a fee counted as wins or losses (3.8 % of 2000 won), an equity an ulp above the
 * start opened a drawdown that never ended, and the Sharpe and Sortino ratios of returns all 0 divided by that noise. The helpers read
 * strings, a cost paid on every timeframe candle here: an amount of 0 at a finite price (0 × NaN is NaN), what is neither held nor
 * reserved on most candles, adds nothing without it.
 */
const addValue = (value: number, amount: number, price: number): number =>
  amount === 0 && Number.isFinite(price) ? value : addPrecise(value, multiplyPrecise(amount, price));

/**
 * The equity of a trading pair in its currency, part by part: the asset at `price` plus the currency, `total` counting what open
 * orders reserve (`used`) with what is `free`. A balance the portfolio lacks counts as 0. In decimal (see addValue).
 */
export const calculatePairEquity = (portfolio: Portfolio, pair: TradingPair, price: number): BalanceDetail => {
  const [asset, currency] = pair.split('/');
  const assetBalance = getAssetBalance(portfolio, asset);
  const currencyBalance = getAssetBalance(portfolio, currency);
  const total = addValue(currencyBalance.total, assetBalance.total, price);
  // With no open order, as on most candles, the free balances are the totals: valued once
  const isAllFree = assetBalance.free === assetBalance.total && currencyBalance.free === currencyBalance.total;

  return {
    free: isAllFree ? total : addValue(currencyBalance.free, assetBalance.free, price),
    used: addValue(currencyBalance.used, assetBalance.used, price),
    total,
  };
};

/**
 * The value of a portfolio in `currency`: its balance of the currency, plus each of `assets` at the price of its pair with the
 * currency, `total` counting what open orders reserve. An asset without a price adds nothing, the currency is counted once even when
 * listed among `assets`, and a balance the portfolio lacks counts as 0. In decimal (see addValue). `pairs`, when given, holds the pair
 * of each of `assets` with the currency, in the same order (Plugin.pairs for Plugin.assets): a caller valuing the portfolio on every
 * timeframe candle spares building them on each call.
 */
export const calculatePortfolioTotalValue = (
  portfolio: Portfolio,
  prices: Map<TradingPair, number>,
  currency: Asset,
  assets: Asset[],
  pairs?: TradingPair[],
): number => {
  let totalValue = getAssetBalance(portfolio, currency).total;
  for (let index = 0; index < assets.length; index++) {
    const asset = assets[index];
    if (asset === currency) continue;
    const price = prices.get(pairs?.[index] ?? `${asset}/${currency}`);
    if (!isNil(price)) totalValue = addValue(totalValue, getAssetBalance(portfolio, asset).total, price);
  }
  return totalValue;
};

/**
 * A copy of a portfolio whose balances can be written without changing the original's. Copied field by field, ten to twenty times
 * faster than structuredClone (0.3 µs against 4 µs for two assets under Bun 1.3, against 7 µs under Node 22).
 */
export const clonePortfolio = (portfolio: Portfolio): Portfolio => {
  const cloned: Portfolio = new Map();
  for (const [asset, balance] of portfolio.entries()) {
    cloned.set(asset, {
      free: balance.free,
      used: balance.used,
      total: balance.total,
    });
  }
  return cloned;
};
