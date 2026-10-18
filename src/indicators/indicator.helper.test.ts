import { GekkoError } from '@errors/gekko.error';
import { describe, expect, it } from 'vitest';
import { checkAtMost, checkBelow, checkInputSource, checkInteger, checkNumber, checkOneOf, getInputSource } from './indicator.helper';
import { MOVING_AVERAGE_TYPES } from './movingAverages/movingAverages.const';

describe('getInputSource', () => {
  // Seven different prices, so that a source read from the wrong field cannot pass
  const candle = { start: 0, open: 13, high: 20, low: 4, close: 18, volume: 100 };
  it.each`
    src          | price
    ${'open'}    | ${13}
    ${'high'}    | ${20}
    ${'low'}     | ${4}
    ${'close'}   | ${18}
    ${'hl2'}     | ${12}
    ${'hlc3'}    | ${14}
    ${'ohlc4'}   | ${13.75}
    ${undefined} | ${18}
  `('should read $price from the candle when src is $src', ({ src, price }) => {
    expect(getInputSource(src)(candle)).toBe(price);
  });
});

describe('checkInteger', () => {
  it.each`
    value  | minimum
    ${1}   | ${1}
    ${30}  | ${1}
    ${2}   | ${2}
    ${1e6} | ${1}
  `('should accept $value when the minimum is $minimum', ({ value, minimum }) => {
    expect(() => checkInteger('EMA', 'period', value, minimum)).not.toThrow();
  });

  // A string, null or NaN read from a configuration block used to reach the indicator as its period
  it.each`
    value        | minimum | shown
    ${0}         | ${1}    | ${'0'}
    ${-3}        | ${1}    | ${'-3'}
    ${2.5}       | ${1}    | ${'2.5'}
    ${NaN}       | ${1}    | ${'NaN'}
    ${Infinity}  | ${1}    | ${'Infinity'}
    ${'5'}       | ${1}    | ${'"5"'}
    ${null}      | ${1}    | ${'null'}
    ${undefined} | ${1}    | ${'undefined'}
    ${true}      | ${1}    | ${'true'}
    ${1}         | ${2}    | ${'1'}
  `('should refuse $value when the minimum is $minimum, naming the indicator and the key', ({ value, minimum, shown }) => {
    expect(() => checkInteger('EMA', 'period', value, minimum)).toThrow(
      new GekkoError('strategy', `Indicator EMA: period must be a whole number, at least ${minimum}, got ${shown}`),
    );
  });

  it('should say why after the refusal when given a reason', () => {
    expect(() => checkInteger('CCI', 'period', 1, 2, 'the CCI of a single candle is always 0')).toThrow(
      new GekkoError(
        'strategy',
        'Indicator CCI: period must be a whole number, at least 2, got 1 (the CCI of a single candle is always 0)',
      ),
    );
  });
});

describe('checkNumber', () => {
  it.each`
    value      | bound
    ${0}       | ${{ atLeast: 0 }}
    ${2.5}     | ${{ atLeast: 0 }}
    ${0.02}    | ${{ above: 0 }}
    ${1000000} | ${{ above: 0 }}
  `('should accept $value within $bound', ({ value, bound }) => {
    expect(() => checkNumber('BollingerBands', 'stdevUp', value, bound)).not.toThrow();
  });

  it.each`
    value        | bound             | expected
    ${-2}        | ${{ atLeast: 0 }} | ${'at least 0, got -2'}
    ${NaN}       | ${{ atLeast: 0 }} | ${'at least 0, got NaN'}
    ${Infinity}  | ${{ atLeast: 0 }} | ${'at least 0, got Infinity'}
    ${'2'}       | ${{ atLeast: 0 }} | ${'at least 0, got "2"'}
    ${null}      | ${{ atLeast: 0 }} | ${'at least 0, got null'}
    ${0}         | ${{ above: 0 }}   | ${'above 0, got 0'}
    ${-0.02}     | ${{ above: 0 }}   | ${'above 0, got -0.02'}
    ${Infinity}  | ${{ above: 0 }}   | ${'above 0, got Infinity'}
    ${undefined} | ${{ above: 0 }}   | ${'above 0, got undefined'}
  `('should refuse $value outside $bound', ({ value, bound, expected }) => {
    expect(() => checkNumber('BollingerBands', 'stdevUp', value, bound)).toThrow(
      new GekkoError('strategy', `Indicator BollingerBands: stdevUp must be a number, ${expected}`),
    );
  });
});

describe('checkOneOf', () => {
  it.each`
    value
    ${'sma'}
    ${'ema'}
    ${'dema'}
    ${'wma'}
  `('should accept $value', ({ value }) => {
    expect(() => checkOneOf('BollingerBands', 'maType', value, MOVING_AVERAGE_TYPES)).not.toThrow();
  });

  it.each`
    value         | shown
    ${'smma'}     | ${'"smma"'}
    ${'SMA'}      | ${'"SMA"'}
    ${null}       | ${'null'}
    ${undefined}  | ${'undefined'}
    ${'toString'} | ${'"toString"'}
  `('should refuse $value, listing the accepted names', ({ value, shown }) => {
    expect(() => checkOneOf('BollingerBands', 'maType', value, MOVING_AVERAGE_TYPES)).toThrow(
      new GekkoError('strategy', `Indicator BollingerBands: maType must be one of "sma", "ema", "dema", "wma", got ${shown}`),
    );
  });
});

describe('checkInputSource', () => {
  it.each`
    src
    ${'open'}
    ${'high'}
    ${'low'}
    ${'close'}
    ${'hl2'}
    ${'hlc3'}
    ${'ohlc4'}
    ${undefined}
  `('should accept $src', ({ src }) => {
    expect(() => checkInputSource('SMA', src)).not.toThrow();
  });

  // An unknown src used to be taken, then throw `getPrice is not a function` at the first candle; a key of every object, such as
  // constructor, read the candle object as a price
  it.each`
    src              | shown
    ${'Close'}       | ${'"Close"'}
    ${'hlc'}         | ${'"hlc"'}
    ${''}            | ${'""'}
    ${null}          | ${'null'}
    ${'constructor'} | ${'"constructor"'}
    ${4}             | ${'4'}
  `('should refuse $src, listing the price sources', ({ src, shown }) => {
    expect(() => checkInputSource('SMA', src)).toThrow(
      new GekkoError('strategy', `Indicator SMA: src must be one of "open", "high", "low", "close", "hl2", "hlc3", "ohlc4", got ${shown}`),
    );
  });
});

describe('checkBelow', () => {
  const why = 'swapped periods give the opposite MACD, equal ones a MACD of 0';

  it('should accept a first parameter below the second', () => {
    expect(() => checkBelow('MACD', 'short', 12, 'long', 26, why)).not.toThrow();
  });

  it.each`
    short | long
    ${26} | ${12}
    ${12} | ${12}
  `('should refuse short $short and long $long, saying why', ({ short, long }) => {
    expect(() => checkBelow('MACD', 'short', short, 'long', long, why)).toThrow(
      new GekkoError('strategy', `Indicator MACD: short must be below long, got short ${short} and long ${long} (${why})`),
    );
  });
});

describe('checkAtMost', () => {
  const why = 'the factor would restart above its maximum after every reversal';

  it.each`
    relation      | acceleration | maxAcceleration
    ${'below'}    | ${0.02}      | ${0.2}
    ${'equal to'} | ${0.2}       | ${0.2}
  `('should accept a first parameter $relation the second', ({ acceleration, maxAcceleration }) => {
    expect(() => checkAtMost('PSAR', 'acceleration', acceleration, 'maxAcceleration', maxAcceleration, why)).not.toThrow();
  });

  it.each`
    acceleration | maxAcceleration
    ${0.3}       | ${0.2}
    ${0.2000001} | ${0.2}
  `('should refuse acceleration $acceleration above maxAcceleration $maxAcceleration, saying why', ({ acceleration, maxAcceleration }) => {
    expect(() => checkAtMost('PSAR', 'acceleration', acceleration, 'maxAcceleration', maxAcceleration, why)).toThrow(
      new GekkoError(
        'strategy',
        `Indicator PSAR: acceleration must be at most maxAcceleration, got acceleration ${acceleration} and maxAcceleration ${maxAcceleration} (${why})`,
      ),
    );
  });
});
