import { describe, expect, it } from 'vitest';
import { generateRowId, generateStrategyId, toCsvCell } from './performanceReporter.helper';

describe('generateStrategyId', () => {
  it.each`
    description                                | strategy                                                                             | expected
    ${'a flat block'}                          | ${{ name: 'DEMA', period: 21 }}                                                      | ${'DEMA-21'}
    ${'arrays, each item visited once'}        | ${{ name: 'grid', levels: [1, 2], sides: ['a'] }}                                    | ${'grid-1-2-a'}
    ${'nested arrays, each item visited once'} | ${{ name: 'grid', levels: [1, [2, [3]]] }}                                           | ${'grid-1-2-3'}
    ${'a top-level array'}                     | ${['a', ['b', ['c']]]}                                                               | ${'a-b-c'}
    ${'objects in an array, in order'}         | ${{ name: 'grid', levels: [{ price: 1, side: 'buy' }, { price: 2, side: 'sell' }] }} | ${'grid-1-buy-2-sell'}
    ${'nested objects, in order'}              | ${{ name: 'RSI', period: 21, thresholds: { high: 70, low: 30, persistence: 0 } }}    | ${'RSI-21-70-30-0'}
    ${'null and undefined values, skipped'}    | ${{ name: 'grid', stop: null, levels: [null, 1, undefined], limit: undefined }}      | ${'grid-1'}
    ${'booleans and numbers, kept'}            | ${{ name: 'grid', hedge: true, short: false, size: 0, ratio: -1.5 }}                 | ${'grid-true-false-0--1.5'}
    ${'a lone primitive'}                      | ${'DEMA'}                                                                            | ${'DEMA'}
    ${'an empty block'}                        | ${{}}                                                                                | ${''}
    ${'a missing block'}                       | ${undefined}                                                                         | ${''}
  `('should return $expected for $description', ({ strategy, expected }) => {
    expect(generateStrategyId(strategy)).toBe(expected);
  });
});

describe('generateRowId', () => {
  it.each`
    description                               | strategy                                               | label                     | expected
    ${'the strategy block alone, unlabelled'} | ${{ name: 'DEMA', period: 12, thresholds: { up: 1 } }} | ${undefined}              | ${'DEMA-12-1'}
    ${'the label after the strategy block'}   | ${{ name: 'DEMA', period: 12, thresholds: { up: 1 } }} | ${'--strategy.period 12'} | ${'DEMA-12-1 (--strategy.period 12)'}
    ${'the label alone without a block'}      | ${undefined}                                           | ${'baseline'}             | ${'(baseline)'}
    ${'nothing without either'}               | ${undefined}                                           | ${undefined}              | ${''}
  `('should write $description: $expected', ({ strategy, label, expected }) => {
    expect(generateRowId(strategy, label)).toBe(expected);
  });
});

describe('toCsvCell', () => {
  it.each`
    description                                             | value           | expected
    ${'leave a plain value unchanged'}                      | ${'grid-1-2-a'} | ${'grid-1-2-a'}
    ${'leave an empty value empty'}                         | ${''}           | ${''}
    ${'write a number as it is'}                            | ${-1.5}         | ${'-1.5'}
    ${'leave a comma unquoted'}                             | ${'3,650'}      | ${'3,650'}
    ${'quote a value holding the separator'}                | ${'buy;sell'}   | ${'"buy;sell"'}
    ${'quote a value holding double quotes, doubling them'} | ${'say "hi"'}   | ${'"say ""hi"""'}
    ${'quote a value holding a line feed'}                  | ${'buy\nsell'}  | ${'"buy\nsell"'}
    ${'quote a value holding a carriage return'}            | ${'buy\rsell'}  | ${'"buy\rsell"'}
  `('should $description', ({ value, expected }) => {
    expect(toCsvCell(value)).toBe(expected);
  });
});
