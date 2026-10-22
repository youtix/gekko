import { describe, expect, it } from 'vitest';

import type { BalanceDetail, Portfolio } from '../../models/portfolio.types';
import type { Asset, TradingPair } from '../../models/utility.types';
import {
  calculatePortfolioTotalValue,
  clonePortfolio,
  createEmptyPortfolio,
  getAssetBalance,
  initializePortfolio,
  isFetchedPortfolio,
} from './portfolio.helper';

// ─────────────────────────────────────────────────────────────────────────────
// Test Data Factories
// ─────────────────────────────────────────────────────────────────────────────

const balance = (free: number, used: number, total: number): BalanceDetail => ({ free, used, total });
/** The balances given, in their order, an amount standing for a balance no open order reserves any of */
const portfolioOf = (balances: Record<Asset, number | BalanceDetail>): Portfolio =>
  new Map(Object.entries(balances).map(([asset, value]) => [asset, typeof value === 'number' ? balance(value, 0, value) : value]));
/** The price of each asset in USDT */
const pricesOf = (prices: Record<Asset, number>): Map<TradingPair, number> =>
  new Map(Object.entries(prices).map(([asset, price]) => [`${asset}/USDT`, price]));

// An open LIMIT or STICKY order moves what it reserves from free to used, in the simulator and on the exchanges alike: 40 USDT for a
// BUY and 0.5 BTC for a SELL here. The equity counts it all the same, through the totals.
const withOpenOrders = (): Portfolio => portfolioOf({ USDT: balance(60, 40, 100), BTC: balance(0.5, 0.5, 1) });
// 14743.23 USDT, then a BUY of 0.22547 BTC at 57595.73 without a fee, booked as the simulator books it: 12986.1092431 USDT spent
const AFTER_BUY = portfolioOf({ BTC: 0.22547, USDT: 1757.1207569 });

// ─────────────────────────────────────────────────────────────────────────────
// initializePortfolio
// ─────────────────────────────────────────────────────────────────────────────

describe('initializePortfolio', () => {
  it('returns a Map', () => {
    expect(initializePortfolio([])).toBeInstanceOf(Map);
  });

  it.each`
    pairs                       | assets                    | description
    ${[]}                       | ${[]}                     | ${'no pair'}
    ${['ETH/EUR']}              | ${['ETH', 'EUR']}         | ${'one pair'}
    ${['BTC/USDT', 'ETH/USDT']} | ${['BTC', 'USDT', 'ETH']} | ${'two pairs sharing their currency'}
  `('lists $assets for $description', ({ pairs, assets }) => {
    expect([...initializePortfolio(pairs).keys()]).toEqual(assets);
  });

  it.each`
    initialAmounts              | asset     | expected                | description
    ${undefined}                | ${'BTC'}  | ${balance(0, 0, 0)}     | ${'no initial amount'}
    ${new Map([['BTC', 5]])}    | ${'BTC'}  | ${balance(5, 0, 5)}     | ${'the initial amount of the asset'}
    ${new Map([['USDT', 100]])} | ${'USDT'} | ${balance(100, 0, 100)} | ${'the initial amount of the currency'}
    ${new Map([['ETH', 10]])}   | ${'BTC'}  | ${balance(0, 0, 0)}     | ${'an initial amount of ETH alone'}
  `('gives $asset $expected.total, all of it free, from $description', ({ initialAmounts, asset, expected }) => {
    expect(initializePortfolio(['BTC/USDT'], initialAmounts).get(asset)).toEqual(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAssetBalance
// ─────────────────────────────────────────────────────────────────────────────

describe('getAssetBalance', () => {
  it('returns the balance of an asset the portfolio holds', () => {
    expect(getAssetBalance(portfolioOf({ BTC: balance(1, 0.5, 1.5) }), 'BTC')).toEqual(balance(1, 0.5, 1.5));
  });

  it('returns a zero balance for an asset the portfolio lacks', () => {
    expect(getAssetBalance(createEmptyPortfolio(), 'UNKNOWN')).toEqual(balance(0, 0, 0));
  });

  // One zero balance shared by every call would carry what a caller wrote to it into the balance of every missing asset after
  it('returns a zero balance of its own on each call', () => {
    const portfolio = createEmptyPortfolio();
    getAssetBalance(portfolio, 'UNKNOWN').free = 5;
    expect(getAssetBalance(portfolio, 'UNKNOWN')).toEqual(balance(0, 0, 0));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isFetchedPortfolio
// ─────────────────────────────────────────────────────────────────────────────

describe('isFetchedPortfolio', () => {
  // The balance of an exchange lists every watched asset and currency, at 0 included: an account holding nothing was fetched too
  it.each`
    portfolio                                                                | fetched  | description
    ${createEmptyPortfolio()}                                                | ${false} | ${'the empty one the Trader starts with'}
    ${initializePortfolio(['BTC/USDT'])}                                     | ${true}  | ${'an account holding nothing'}
    ${initializePortfolio(['BTC/USDT'], new Map([['BTC', 1], ['USDT', 5]]))} | ${true}  | ${'an account holding BTC and USDT'}
  `('returns $fetched for $description', ({ portfolio, fetched }) => {
    expect(isFetchedPortfolio(portfolio)).toBe(fetched);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// calculatePortfolioTotalValue
// ─────────────────────────────────────────────────────────────────────────────

describe('calculatePortfolioTotalValue', () => {
  // The last three come out an ulp off in binary: 7.999999999999999, 0.6000000000000001 and 14743.230000000001
  it.each`
    portfolio                                         | prices                                | assets            | total       | description
    ${createEmptyPortfolio()}                         | ${pricesOf({ BTC: 1000, ETH: 3000 })} | ${['BTC', 'ETH']} | ${0}        | ${'an empty portfolio'}
    ${portfolioOf({ USDT: 100 })}                     | ${pricesOf({ BTC: 1000, ETH: 3000 })} | ${['BTC', 'ETH']} | ${100}      | ${'the currency alone'}
    ${portfolioOf({ USDT: 100, BTC: 1 })}             | ${pricesOf({ BTC: 1000 })}            | ${['BTC']}        | ${1100}     | ${'an asset at its price'}
    ${portfolioOf({ USDT: 100, BTC: 0.5, ETH: 10 })}  | ${pricesOf({ BTC: 1000, ETH: 3000 })} | ${['BTC', 'ETH']} | ${30600}    | ${'two assets at their prices'}
    ${portfolioOf({ USDT: 100, BTC: 1, XRP: 1000 })}  | ${pricesOf({ BTC: 1000 })}            | ${['BTC', 'XRP']} | ${1100}     | ${'an asset without a price, left out'}
    ${portfolioOf({ USDT: 100 })}                     | ${pricesOf({ USDT: 1 })}              | ${['USDT']}       | ${100}      | ${'USDT among the assets, counted once'}
    ${portfolioOf({ USDT: 100 })}                     | ${pricesOf({ BTC: 1000 })}            | ${['BTC']}        | ${100}      | ${'no balance of an asset, as 0'}
    ${withOpenOrders()}                               | ${pricesOf({ BTC: 1000 })}            | ${['BTC']}        | ${1100}     | ${'reserves of open orders'}
    ${portfolioOf({ USDT: 100, BTC: 0 })}             | ${pricesOf({ BTC: NaN })}             | ${['BTC']}        | ${NaN}      | ${'no BTC at a price not a number'}
    ${portfolioOf({ USDT: 1, BTC: 0.00007 })}         | ${pricesOf({ BTC: 100000 })}          | ${['BTC']}        | ${8}        | ${'0.00007 BTC and 1 USDT'}
    ${portfolioOf({ USDT: 0.1, BTC: 0.2, ETH: 0.1 })} | ${pricesOf({ BTC: 1, ETH: 3 })}       | ${['BTC', 'ETH']} | ${0.6}      | ${'0.1 USDT, 0.2 BTC at 1, 0.1 ETH at 3'}
    ${AFTER_BUY}                                      | ${pricesOf({ BTC: 57595.73 })}        | ${['BTC']}        | ${14743.23} | ${'a position at its buy price'}
  `('gives $total for $description', ({ portfolio, prices, assets, total }) => {
    expect(calculatePortfolioTotalValue(portfolio, prices, 'USDT', assets)).toBe(total);
  });

  // The pairs a plugin keeps (Plugin.pairs), one for each asset, in the order of the assets
  it.each`
    assets             | pairs                        | total    | description
    ${['BTC']}         | ${['XBT/USDT']}              | ${1100}  | ${'the price of the pair given'}
    ${['USDT', 'BTC']} | ${['USDT/USDT', 'BTC/USDT']} | ${50100} | ${'USDT among the assets, counted once'}
  `('gives $total with the pairs given, from $description', ({ assets, pairs, total }) => {
    const prices = pricesOf({ BTC: 50000, XBT: 1000, USDT: 1 });
    expect(calculatePortfolioTotalValue(portfolioOf({ USDT: 100, BTC: 1 }), prices, 'USDT', assets, pairs)).toBe(total);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clonePortfolio
// ─────────────────────────────────────────────────────────────────────────────

describe('clonePortfolio', () => {
  it('gives a portfolio equal to the original, reserves included', () => {
    expect(clonePortfolio(withOpenOrders())).toStrictEqual(withOpenOrders());
  });

  it('gives a new Map', () => {
    const portfolio = withOpenOrders();
    expect(clonePortfolio(portfolio)).not.toBe(portfolio);
  });

  it('keeps the order of the assets', () => {
    expect([...clonePortfolio(withOpenOrders()).keys()]).toEqual(['USDT', 'BTC']);
  });

  it('leaves the balance of the original as it was when the copy is written', () => {
    const portfolio = withOpenOrders();
    clonePortfolio(portfolio).get('BTC')!.free = 0;
    expect(portfolio.get('BTC')).toEqual(balance(0.5, 0.5, 1));
  });
});
