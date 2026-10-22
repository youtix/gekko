import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatEveryDecimal,
  formatPercent,
  formatRatio,
  formatSignedPercent,
  listInWords,
  pluralize,
  toCamelCase,
  toPlainNumber,
} from './string.utils';

describe('toCamelCase', () => {
  it.each`
    description                                 | words                                | expected
    ${'the setter of an injected service'}      | ${['set', 'exchange']}               | ${'setExchange'}
    ${'the handler of an event'}                | ${['on', 'orderCompleted']}          | ${'onOrderCompleted'}
    ${'the handler of an event of three words'} | ${['on', 'strategyWarmupCompleted']} | ${'onStrategyWarmupCompleted'}
    ${'words split by a space'}                 | ${['order completed']}               | ${'orderCompleted'}
  `('should give $expected for $description', ({ words, expected }) => {
    expect(toCamelCase(...words)).toBe(expected);
  });
});

describe('pluralize', () => {
  it.each`
    description                         | word             | count  | pluralForm   | expected
    ${'a count of 0, in the plural'}    | ${'candle'}      | ${0}   | ${undefined} | ${'candles'}
    ${'a count of 1, in the singular'}  | ${'candle'}      | ${1}   | ${undefined} | ${'candle'}
    ${'a count of 2, in the plural'}    | ${'candle'}      | ${2}   | ${undefined} | ${'candles'}
    ${'a fraction, in the plural'}      | ${'candle'}      | ${0.5} | ${undefined} | ${'candles'}
    ${'a count of -1, in the singular'} | ${'candle'}      | ${-1}  | ${undefined} | ${'candle'}
    ${'a count of -2, in the plural'}   | ${'candle'}      | ${-2}  | ${undefined} | ${'candles'}
    ${'a word ending in s, with es'}    | ${'bus'}         | ${2}   | ${undefined} | ${'buses'}
    ${'a word ending in sh, with es'}   | ${'wish'}        | ${2}   | ${undefined} | ${'wishes'}
    ${'a word ending in ch, with es'}   | ${'match'}       | ${2}   | ${undefined} | ${'matches'}
    ${'a word ending in x, with es'}    | ${'box'}         | ${3}   | ${undefined} | ${'boxes'}
    ${'a word ending in z, with es'}    | ${'buzz'}        | ${2}   | ${undefined} | ${'buzzes'}
    ${'a y after a consonant, as ies'}  | ${'lady'}        | ${4}   | ${undefined} | ${'ladies'}
    ${'a y after a vowel, with s'}      | ${'day'}         | ${2}   | ${undefined} | ${'days'}
    ${'an irregular word'}              | ${'child'}       | ${2}   | ${undefined} | ${'children'}
    ${'an irregular word, unchanged'}   | ${'sheep'}       | ${2}   | ${undefined} | ${'sheep'}
    ${'a capitalised irregular word'}   | ${'Person'}      | ${5}   | ${undefined} | ${'People'}
    ${'a capitalised regular word'}     | ${'Candle'}      | ${2}   | ${undefined} | ${'Candles'}
    ${'a key of Object.prototype'}      | ${'constructor'} | ${2}   | ${undefined} | ${'constructors'}
    ${'the plural given'}               | ${'octopus'}     | ${5}   | ${'octopi'}  | ${'octopi'}
    ${'the plural given, for 0'}        | ${'octopus'}     | ${0}   | ${'octopi'}  | ${'octopi'}
    ${'the singular, a plural given'}   | ${'octopus'}     | ${1}   | ${'octopi'}  | ${'octopus'}
  `('should give $expected for $count $word: $description', ({ word, count, pluralForm, expected }) => {
    expect(pluralize(word, count, pluralForm)).toBe(expected);
  });
});

// The last two joined by 'and', the others by commas, as a line names the pairs, the keys or the options it is about
describe('listInWords', () => {
  it.each`
    description      | items                                               | expected
    ${'no item'}     | ${[]}                                               | ${''}
    ${'one item'}    | ${['BTC/USDT']}                                     | ${'BTC/USDT'}
    ${'two items'}   | ${['amount', 'cost']}                               | ${'amount and cost'}
    ${'three items'} | ${['amount', 'cost', 'allocation']}                 | ${'amount, cost and allocation'}
    ${'four items'}  | ${['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT']} | ${'BTC/USDT, ETH/USDT, SOL/USDT and XRP/USDT'}
  `('should give $expected for $description', ({ items, expected }) => {
    expect(listInWords(items)).toBe(expected);
  });
});

describe('formatRatio', () => {
  it.each`
    value        | expected
    ${null}      | ${''}
    ${undefined} | ${''}
    ${NaN}       | ${''}
    ${Infinity}  | ${''}
    ${-Infinity} | ${''}
    ${0}         | ${'0.00'}
    ${0.004}     | ${'0.00'}
    ${-0.004}    | ${'0.00'}
    ${0.005}     | ${'0.01'}
    ${-0.005}    | ${'-0.01'}
    ${1}         | ${'1.00'}
    ${1.234}     | ${'1.23'}
    ${1.235}     | ${'1.24'}
    ${-2.345}    | ${'-2.35'}
  `('formatRatio($value) -> $expected', ({ value, expected }) => {
    expect(formatRatio(value)).toBe(expected);
  });
});

describe('formatAmount', () => {
  it.each`
    description                                | value           | expected
    ${'a large amount, its thousands grouped'} | ${1234567.5678} | ${'1,234,567.5678'}
    ${'a whole amount, without decimals'}      | ${100}          | ${'100'}
    ${'a tiny price'}                          | ${0.0000012}    | ${'0.0000012'}
    ${'a price below 1e-6, without exponent'}  | ${0.00000012}   | ${'0.00000012'}
    ${'an amount in BTC'}                      | ${0.00042}      | ${'0.00042'}
    ${'a loss in BTC'}                         | ${-0.00042}     | ${'-0.00042'}
    ${'an amount rounded to 8 decimals'}       | ${0.123456789}  | ${'0.12345679'}
    ${'a loss rounded to zero, without sign'}  | ${-0.000000001} | ${'0'}
  `('should write $description as $expected', ({ value, expected }) => {
    expect(formatAmount(value)).toBe(expected);
  });
});

describe('toPlainNumber', () => {
  it.each`
    description                               | value           | expected
    ${'a missing value'}                      | ${undefined}    | ${''}
    ${'a null value'}                         | ${null}         | ${''}
    ${'NaN'}                                  | ${NaN}          | ${''}
    ${'Infinity'}                             | ${Infinity}     | ${''}
    ${'-Infinity'}                            | ${-Infinity}    | ${''}
    ${'zero'}                                 | ${0}            | ${'0'}
    ${'a large amount, without grouping'}     | ${1234567.5678} | ${'1234567.5678'}
    ${'a large loss, without grouping'}       | ${-1234.5}      | ${'-1234.5'}
    ${'a huge amount, without exponent'}      | ${1e21}         | ${'1000000000000000000000'}
    ${'a tiny price'}                         | ${0.0000012}    | ${'0.0000012'}
    ${'a price below 1e-6, without exponent'} | ${0.00000012}   | ${'0.00000012'}
    ${'an amount in BTC'}                     | ${0.00042}      | ${'0.00042'}
    ${'an amount rounded to 8 decimals'}      | ${0.123456789}  | ${'0.12345679'}
    ${'a sum with floating-point noise'}      | ${0.1 + 0.2}    | ${'0.3'}
    ${'a loss rounded to zero, without sign'} | ${-0.000000001} | ${'0'}
  `('should write $description as $expected', ({ value, expected }) => {
    expect(toPlainNumber(value)).toBe(expected);
  });
});

// Every decimal String writes, without its exponent: a value quoted beside the bound it missed must not read as that bound
describe('formatEveryDecimal', () => {
  it.each`
    description                                                       | value                    | expected
    ${'a value String writes with an exponent'}                       | ${1e-7}                  | ${'0.0000001'}
    ${'a price under 1e-6 of several digits'}                         | ${4.5678e-7}             | ${'0.00000045678'}
    ${'a dust balance below 0'}                                       | ${-5e-7}                 | ${'-0.0000005'}
    ${'a cost a hair under a minimum of 0.0001, unrounded'}           | ${0.000099997}           | ${'0.000099997'}
    ${'a balance of 8 decimals'}                                      | ${1080.64224999}         | ${'1080.64224999'}
    ${'a binary sum, its noise kept'}                                 | ${0.1 + 0.2}             | ${'0.30000000000000004'}
    ${'an exact binary tie, the neighbour String picks, not toFixed'} | ${-104563116752869.125}  | ${'-104563116752869.12'}
    ${'an integer past 2 ** 53, the digits String writes'}            | ${181719011963580970000} | ${'181719011963580970000'}
    ${'a number from 1e21 on, without exponent'}                      | ${1.5e21}                | ${'1500000000000000000000'}
    ${'zero'}                                                         | ${0}                     | ${'0'}
    ${'minus zero, as String writes it'}                              | ${-0}                    | ${'0'}
    ${'100 decimals, the most written out'}                           | ${1e-100}                | ${`0.${'0'.repeat(99)}1`}
    ${'more than 100 decimals, with the exponent'}                    | ${5e-324}                | ${'5e-324'}
    ${'NaN'}                                                          | ${NaN}                   | ${'NaN'}
    ${'Infinity'}                                                     | ${Infinity}              | ${'Infinity'}
    ${'-Infinity'}                                                    | ${-Infinity}             | ${'-Infinity'}
  `('should write $description as $expected', ({ value, expected }) => {
    expect(formatEveryDecimal(value)).toBe(expected);
  });
});

describe('formatPercent', () => {
  it.each`
    description                                  | value     | rounding      | expected
    ${'a loss rounded down, away from 0'}        | ${-5.001} | ${'down'}     | ${'-5.01%'}
    ${'a tie rounded down'}                      | ${3.125}  | ${'down'}     | ${'3.12%'}
    ${'a value on its hundredth, as it is'}      | ${10.5}   | ${'down'}     | ${'10.5%'}
    ${'a binary value under its decimal, down'}  | ${8.2}    | ${'down'}     | ${'8.2%'}
    ${'0, without a sign'}                       | ${0}      | ${'down'}     | ${'0%'}
    ${'a loss rounded half to even, toward 0'}   | ${-5.001} | ${'halfEven'} | ${'-5%'}
    ${'a tie rounded half to even, down to 2'}   | ${3.125}  | ${'halfEven'} | ${'3.12%'}
    ${'a tie rounded half to even, up to 4'}     | ${3.135}  | ${'halfEven'} | ${'3.14%'}
    ${'a small loss rounded half to even, to 0'} | ${-0.001} | ${'halfEven'} | ${'0%'}
  `('should write $description: $value as $expected ($rounding)', ({ value, rounding, expected }) => {
    expect(formatPercent(value, rounding)).toBe(expected);
  });
});

describe('formatSignedPercent', () => {
  it.each`
    value        | expected
    ${null}      | ${'n/a'}
    ${undefined} | ${'n/a'}
    ${NaN}       | ${'n/a'}
    ${Infinity}  | ${'n/a'}
    ${-Infinity} | ${'n/a'}
    ${0}         | ${'0%'}
    ${0.004}     | ${'0%'}
    ${1.234}     | ${'+1.23%'}
    ${1.235}     | ${'+1.24%'}
    ${-1.235}    | ${'-1.24%'}
    ${-2.345}    | ${'-2.34%'}
  `('formatSignedPercent($value) -> $expected', ({ value, expected }) => {
    expect(formatSignedPercent(value)).toBe(expected);
  });
});
