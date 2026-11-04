import { describe, expect, it } from 'vitest';
import { roundToMarketPrecision } from './dummyCentralizedExchange.helper';

// The steps themselves are those of roundToStep and getPriceTick (precision.helper), as ccxt 4.5.39 puts a value on them
describe('roundToMarketPrecision', () => {
  it.each`
    marketData                                                                    | expected                                              | scenario
    ${{ precision: { price: 0.01, amount: 0.00001 } }}                            | ${{ amount: 0.03102, price: 10000.45 }}               | ${'the steps of the market'}
    ${{ precision: { price: 0.01, amount: 0.00001, priceSignificantDigits: 5 } }} | ${{ amount: 0.03102, price: 10000 }}                  | ${'5 significant digits in a price'}
    ${{}}                                                                         | ${{ amount: 0.031028229810094173, price: 10000.445 }} | ${'no precision'}
  `('gives $expected for 0.031028229810094173 at 10000.445 on $scenario', ({ marketData, expected }) => {
    expect(roundToMarketPrecision(0.031028229810094173, 10000.445, marketData)).toEqual(expected);
  });

  // A step that is not one unit of a decimal, as ccxt takes it: GridBot and the PositionTracker kept 1.4 there, the decimals of the step
  it('truncates 1.4 to 1 on an amount step of 0.5', () => {
    expect(roundToMarketPrecision(1.4, 100, { precision: { amount: 0.5 } }).amount).toBe(1);
  });

  // For the limits of the market to refuse it with their own message, as CCXTExchange leaves it: floored, -1.234 would be refused as -1.24
  it.each`
    value
    ${0}
    ${-1.234}
    ${NaN}
    ${Infinity}
  `('leaves an amount and a price of $value as they are', ({ value }) => {
    expect(roundToMarketPrecision(value, value, { precision: { price: 0.01, amount: 0.01 } })).toEqual({ amount: value, price: value });
  });
});
