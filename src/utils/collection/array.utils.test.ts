import { range } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { keepDuplicates } from './array.utils';

describe('keepDuplicates', () => {
  it.each`
    scenario                                    | values                                 | expected
    ${'no value'}                               | ${[]}                                  | ${[]}
    ${'values that never repeat'}               | ${[1, 2, 3, 4]}                        | ${[]}
    ${'one pair'}                               | ${[1, 2, 2, 3]}                        | ${[2]}
    ${'a value held three times'}               | ${[2, 1, 2, 3, 2]}                     | ${[2]}
    ${'two pairs'}                              | ${[1, 2, 2, 3, 4, 4]}                  | ${[2, 4]}
    ${'values listed in the order they repeat'} | ${['BTC', 'ETH', 'ETH', 'BTC', 'BTC']} | ${['ETH', 'BTC']}
    ${'two spellings of one name'}              | ${['BTC', 'btc']}                      | ${[]}
    ${'NaN twice, equal to itself as in a Set'} | ${[NaN, 1, NaN]}                       | ${[NaN]}
  `('returns $expected for $scenario', ({ values, expected }) => {
    expect(keepDuplicates(values)).toEqual(expected);
  });

  // The lodash xor it replaced grew with the square of the length: 3.5 to 5.4 s for 4000 values
  it('returns the 2500 repeated values of 5000 values within a second', () => {
    const values = range(5000).map(value => value % 2500);
    expect(keepDuplicates(values)).toEqual(range(2500));
  }, 1000);
});
