import { GekkoError } from '@errors/gekko.error';
import { Candle } from '@models/candle.types';
import { InputSources } from '@models/inputSources.types';
import { RingBuffer } from '@helpers/collection/ringBuffer';
import { describe, expect, it, vi } from 'vitest';
import * as indicators from './index';
import { Indicator } from './indicator';
import { INPUT_SOURCES } from './indicator.const';

const price = (index: number) => 100 + 10 * Math.sin(index / 3) + 5 * Math.sin(index / 7);
// A zigzag without a flat window, so that the readiness below is that of a market that moves
const candles: Candle[] = Array.from({ length: 150 }, (_, index) => {
  const open = price(index - 1);
  const close = price(index);
  return {
    start: index * 60_000,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 100 + ((index * 37) % 50),
  };
});

/** A complete result is a number, or an object whose fields are all numbers (arrays of numbers for the ribbons) */
const readiness = (result: unknown) => {
  if (result === null) return 'null';
  const values = typeof result === 'number' ? [result] : Object.values(result as object).flat();
  return values.every(Number.isFinite) ? 'complete' : 'partial';
};

const create = (name: string, parameters?: object) =>
  new (indicators[name as keyof typeof indicators] as unknown as new (parameters?: object) => Indicator)(parameters);

const series = (indicator: Indicator) =>
  candles.map(candle => {
    indicator.onNewCandle(candle);
    return structuredClone(indicator.getResult());
  });

// What the refusals list as accepted for src and for a moving-average kind
const SOURCES = '"open", "high", "low", "close", "hl2", "hlc3", "ohlc4"';
const MA_TYPES = '"sma", "ema", "dema", "wma"';
// Why DX, ADX and the ADX ribbon refuse period 1
const SINGLE_CANDLE_DX = 'the DX of a single candle is 100, or 0/0 when it has no directional movement';
const SINGLE_CANDLE_ADX = 'the ADX of a single candle is 100, or 0/0 when it has no directional movement';
// Why RSI and Stochastic RSI refuse period 1, which they used to take: the RSI of each unchanged close was 0, the most oversold reading
const SINGLE_CHANGE_RSI = 'the RSI of a single change is 100 on a rise, and 0 on a fall or an unchanged close';
const SINGLE_CHANGE_STOCHASTIC_RSI = 'the RSI of a single change is only ever 0 or 100, and so is fastK';

describe('Indicator', () => {
  it.each`
    name                 | parameters                                                                 | firstComplete
    ${'ADX'}             | ${{ period: 14 }}                                                          | ${28}
    ${'ADX'}             | ${{ period: 2 }}                                                           | ${4}
    ${'ADXRibbon'}       | ${{}}                                                                      | ${132}
    ${'DX'}              | ${{ period: 14 }}                                                          | ${15}
    ${'DX'}              | ${{ period: 2 }}                                                           | ${3}
    ${'MinusDI'}         | ${{ period: 14 }}                                                          | ${15}
    ${'MinusDI'}         | ${{ period: 1 }}                                                           | ${2}
    ${'MinusDM'}         | ${{ period: 14 }}                                                          | ${14}
    ${'MinusDM'}         | ${{ period: 1 }}                                                           | ${2}
    ${'PlusDI'}          | ${{ period: 14 }}                                                          | ${15}
    ${'PlusDI'}          | ${{ period: 1 }}                                                           | ${2}
    ${'PlusDM'}          | ${{ period: 14 }}                                                          | ${14}
    ${'PlusDM'}          | ${{ period: 1 }}                                                           | ${2}
    ${'MACD'}            | ${{}}                                                                      | ${34}
    ${'PSAR'}            | ${{}}                                                                      | ${2}
    ${'ROC'}             | ${{ period: 10 }}                                                          | ${11}
    ${'ROC'}             | ${{ period: 1 }}                                                           | ${2}
    ${'Stochastic'}      | ${{}}                                                                      | ${9}
    ${'Stochastic'}      | ${{ fastKPeriod: 1, slowKPeriod: 3, slowKMaType: 'dema', slowDPeriod: 1 }} | ${5}
    ${'Stochastic'}      | ${{ fastKPeriod: 1, slowKPeriod: 1, slowDPeriod: 3, slowDMaType: 'dema' }} | ${5}
    ${'Stochastic'}      | ${{ slowKMaType: 'dema' }}                                                 | ${11}
    ${'Stochastic'}      | ${{ slowDMaType: 'dema' }}                                                 | ${11}
    ${'Stochastic'}      | ${{ slowKMaType: 'dema', slowDMaType: 'dema' }}                            | ${13}
    ${'StochasticRSI'}   | ${{}}                                                                      | ${21}
    ${'StochasticRSI'}   | ${{ slowMaType: 'dema' }}                                                  | ${23}
    ${'StochasticRSI'}   | ${{ fastKPeriod: 2, fastDPeriod: 5, slowMaType: 'dema' }}                  | ${24}
    ${'StochasticRSI'}   | ${{ period: 2, fastKPeriod: 2, fastDPeriod: 1 }}                           | ${4}
    ${'TRIX'}            | ${{}}                                                                      | ${89}
    ${'WilliamsR'}       | ${{}}                                                                      | ${14}
    ${'DEMA'}            | ${{ period: 10 }}                                                          | ${19}
    ${'EMA'}             | ${{}}                                                                      | ${30}
    ${'EMARibbon'}       | ${{}}                                                                      | ${66}
    ${'SMA'}             | ${{}}                                                                      | ${30}
    ${'SMMA'}            | ${{ period: 14 }}                                                          | ${14}
    ${'TEMA'}            | ${{ period: 10 }}                                                          | ${28}
    ${'WilderSmoothing'} | ${{}}                                                                      | ${14}
    ${'WMA'}             | ${{ period: 10 }}                                                          | ${10}
    ${'AO'}              | ${{}}                                                                      | ${34}
    ${'CCI'}             | ${{}}                                                                      | ${14}
    ${'RSI'}             | ${{}}                                                                      | ${15}
    ${'RSI'}             | ${{ period: 2 }}                                                           | ${3}
    ${'ATR'}             | ${{ period: 14 }}                                                          | ${15}
    ${'ATRCD'}           | ${{}}                                                                      | ${35}
    ${'BollingerBands'}  | ${{}}                                                                      | ${5}
    ${'BollingerBands'}  | ${{ maType: 'dema' }}                                                      | ${9}
    ${'TrueRange'}       | ${undefined}                                                               | ${2}
    ${'EFI'}             | ${{}}                                                                      | ${14}
    ${'EFI'}             | ${{ maType: 'dema' }}                                                      | ${26}
    ${'EFI'}             | ${{ maType: 'sma', src: 'hl2' }}                                           | ${14}
    ${'OBV'}             | ${{}}                                                                      | ${14}
    ${'OBV'}             | ${{ maType: 'dema' }}                                                      | ${27}
  `(
    'should return null until candle $firstComplete, then only complete results, for $name $parameters',
    ({ name, parameters, firstComplete }) => {
      const IndicatorClass = indicators[name as keyof typeof indicators] as unknown as new (parameters?: object) => Indicator;
      const indicator = new IndicatorClass(parameters);
      const results = [
        indicator.getResult(),
        ...candles.map(candle => {
          indicator.onNewCandle(candle);
          return indicator.getResult();
        }),
      ];
      expect(results.map(readiness)).toEqual(results.map((_, candleCount) => (candleCount < firstComplete ? 'null' : 'complete')));
    },
  );

  // src names the price an indicator reads in place of the close. DEMA, TEMA, WMA, SMMA and Wilder's smoothing used to ignore it, and
  // EFI took the close for its force whatever src said, then smoothed NaN with an sma or an ema
  it.each`
    name                 | parameters                          | src
    ${'SMA'}             | ${{ period: 5 }}                    | ${'open'}
    ${'EMA'}             | ${{ period: 5 }}                    | ${'hl2'}
    ${'DEMA'}            | ${{ period: 5 }}                    | ${'hlc3'}
    ${'TEMA'}            | ${{ period: 5 }}                    | ${'ohlc4'}
    ${'WMA'}             | ${{ period: 5 }}                    | ${'high'}
    ${'SMMA'}            | ${{ period: 5 }}                    | ${'low'}
    ${'WilderSmoothing'} | ${{ period: 5 }}                    | ${'open'}
    ${'EMARibbon'}       | ${{ count: 3, start: 2, step: 2 }}  | ${'hl2'}
    ${'RSI'}             | ${{ period: 5 }}                    | ${'hlc3'}
    ${'MACD'}            | ${{ short: 3, long: 6, signal: 3 }} | ${'ohlc4'}
    ${'EFI'}             | ${{ period: 5, maType: 'sma' }}     | ${'hl2'}
    ${'EFI'}             | ${{ period: 5, maType: 'ema' }}     | ${'high'}
    ${'EFI'}             | ${{ period: 5, maType: 'dema' }}    | ${'open'}
    ${'EFI'}             | ${{ period: 5, maType: 'wma' }}     | ${'low'}
  `('should read the $src price as it reads the close, for $name $parameters', ({ name, parameters, src }) => {
    const IndicatorClass = indicators[name as keyof typeof indicators] as unknown as new (parameters?: object) => Indicator;
    const results = (indicator: Indicator, series: Candle[]) =>
      series.map(candle => {
        indicator.onNewCandle(candle);
        return structuredClone(indicator.getResult());
      });
    const priceAsClose = candles.map(candle => ({ ...candle, close: INPUT_SOURCES[src as InputSources](candle) }));
    expect(results(new IndicatorClass({ ...parameters, src }), candles)).toEqual(results(new IndicatorClass(parameters), priceAsClose));
  });

  // An indicator built on another feeds it numbers through update. Each value used to go in as the close of a made-up candle cast to
  // Candle, a cast that hid from tsc which fields the inner indicator read: given another src, an average read one that candle lacked
  it.each`
    name                 | parameters
    ${'SMA'}             | ${{ period: 5, src: 'hl2' }}
    ${'EMA'}             | ${{ period: 5, src: 'open' }}
    ${'DEMA'}            | ${{ period: 5, src: 'hlc3' }}
    ${'TEMA'}            | ${{ period: 5, src: 'ohlc4' }}
    ${'WMA'}             | ${{ period: 5, src: 'high' }}
    ${'SMMA'}            | ${{ period: 5, src: 'low' }}
    ${'WilderSmoothing'} | ${{ period: 5 }}
    ${'ROC'}             | ${{ period: 5 }}
    ${'BollingerBands'}  | ${{ period: 5 }}
    ${'BollingerBands'}  | ${{ period: 5, maType: 'dema' }}
  `('should take through update the price it reads from each candle, for $name $parameters', ({ name, parameters }) => {
    const read = INPUT_SOURCES[(parameters.src ?? 'close') as InputSources];
    const fed = create(name, parameters) as Indicator & { update: (value: number) => void };
    const updated = candles.map(candle => {
      fed.update(read(candle));
      return structuredClone(fed.getResult());
    });
    expect(updated).toEqual(series(create(name, parameters)));
  });

  // StochasticRSI feeds its RSI to a Stochastic: a series without a range within a candle, each value its own high, low and close
  it.each`
    parameters
    ${{}}
    ${{ fastKPeriod: 3, slowKPeriod: 2, slowKMaType: 'dema', slowDPeriod: 2, slowDMaType: 'wma' }}
  `('should take a value through update as its own high, low and close, for Stochastic $parameters', ({ parameters }) => {
    const fed = create('Stochastic', parameters) as Indicator & { update: (value: number) => void };
    const updated = candles.map(({ close }) => {
      fed.update(close);
      return structuredClone(fed.getResult());
    });
    const indicator = create('Stochastic', parameters);
    const onCloses = candles.map(candle => {
      indicator.onNewCandle({ ...candle, high: candle.close, low: candle.close });
      return structuredClone(indicator.getResult());
    });
    expect(updated).toEqual(onCloses);
  });

  // The indicators on a window of candles read it in place. ROC, WilliamsR and TRIX read the oldest or newest value of theirs through a
  // copy of the whole window, and CCI and BollingerBands summed a copy of theirs, on every candle
  it.each`
    name                | parameters
    ${'ROC'}            | ${{ period: 5 }}
    ${'WilliamsR'}      | ${{ period: 5 }}
    ${'TRIX'}           | ${{ period: 3 }}
    ${'CCI'}            | ${{ period: 5 }}
    ${'BollingerBands'} | ${{ period: 5 }}
    ${'OBV'}            | ${{ period: 5 }}
    ${'Stochastic'}     | ${{}}
    ${'StochasticRSI'}  | ${{}}
  `('should read its window in place rather than copy it on every candle, for $name $parameters', ({ name, parameters }) => {
    const toArray = vi.spyOn(RingBuffer.prototype, 'toArray');

    series(create(name, parameters));

    expect(toArray).not.toHaveBeenCalled();
  });
});

// Constructors used to take any parameter and fail later: a missing or fractional period fell back to a default, never seeded, or gave
// NaN or ±Infinity forever, a ribbon of 0 averages was never null, swapped periods gave the opposite line, an unknown src threw
// `getPrice is not a function` at the first candle and an unknown maType "undefined is not a constructor". They now refuse such a
// parameter at once, naming the indicator, the key and what it accepts.
describe('Indicator parameters', () => {
  const expectRefusal = ({ name, parameters, refusal }: { name: string; parameters?: object; refusal: string }) => {
    expect(() => create(name, parameters)).toThrow(new GekkoError('strategy', `Indicator ${name}: ${refusal}`));
  };

  it.each`
    name                 | parameters                       | refusal
    ${'SMA'}             | ${{ period: 0 }}                 | ${'period must be a whole number, at least 1, got 0'}
    ${'SMA'}             | ${{ period: 20.5 }}              | ${'period must be a whole number, at least 1, got 20.5'}
    ${'SMA'}             | ${{ src: 'Close' }}              | ${`src must be one of ${SOURCES}, got "Close"`}
    ${'EMA'}             | ${{ period: '5' }}               | ${'period must be a whole number, at least 1, got "5"'}
    ${'EMA'}             | ${{ period: null }}              | ${'period must be a whole number, at least 1, got null'}
    ${'EMA'}             | ${{ src: null }}                 | ${`src must be one of ${SOURCES}, got null`}
    ${'DEMA'}            | ${{}}                            | ${'period must be a whole number, at least 1, got undefined'}
    ${'DEMA'}            | ${{ period: 3, src: 'hlc' }}     | ${`src must be one of ${SOURCES}, got "hlc"`}
    ${'TEMA'}            | ${{ period: -1 }}                | ${'period must be a whole number, at least 1, got -1'}
    ${'TEMA'}            | ${{ period: 3, src: 'typical' }} | ${`src must be one of ${SOURCES}, got "typical"`}
    ${'WMA'}             | ${{ period: undefined }}         | ${'period must be a whole number, at least 1, got undefined'}
    ${'WMA'}             | ${{ period: 2.5 }}               | ${'period must be a whole number, at least 1, got 2.5'}
    ${'WMA'}             | ${{ period: 3, src: 'Open' }}    | ${`src must be one of ${SOURCES}, got "Open"`}
    ${'SMMA'}            | ${{}}                            | ${'period must be a whole number, at least 1, got undefined'}
    ${'SMMA'}            | ${undefined}                     | ${'period must be a whole number, at least 1, got undefined'}
    ${'SMMA'}            | ${{ period: NaN }}               | ${'period must be a whole number, at least 1, got NaN'}
    ${'SMMA'}            | ${{ period: 3, src: 'Close' }}   | ${`src must be one of ${SOURCES}, got "Close"`}
    ${'WilderSmoothing'} | ${{ period: 0 }}                 | ${'period must be a whole number, at least 1, got 0'}
    ${'WilderSmoothing'} | ${{ src: 'constructor' }}        | ${`src must be one of ${SOURCES}, got "constructor"`}
    ${'EMARibbon'}       | ${{ count: 0 }}                  | ${'count must be a whole number, at least 1, got 0'}
    ${'EMARibbon'}       | ${{ start: 1.5 }}                | ${'start must be a whole number, at least 1, got 1.5'}
    ${'EMARibbon'}       | ${{ step: 1.5 }}                 | ${'step must be a whole number, at least 1, got 1.5'}
    ${'EMARibbon'}       | ${{ step: 0 }}                   | ${'step must be a whole number, at least 1, got 0'}
    ${'EMARibbon'}       | ${{ src: 'Close' }}              | ${`src must be one of ${SOURCES}, got "Close"`}
  `('should refuse $parameters for the moving average $name', expectRefusal);

  it.each`
    name               | parameters                   | refusal
    ${'MACD'}          | ${{ short: 26, long: 12 }}   | ${'short must be below long, got short 26 and long 12 (swapped periods give the opposite MACD, equal ones a MACD of 0)'}
    ${'MACD'}          | ${{ short: 12, long: 12 }}   | ${'short must be below long, got short 12 and long 12 (swapped periods give the opposite MACD, equal ones a MACD of 0)'}
    ${'MACD'}          | ${{ long: 5 }}               | ${'short must be below long, got short 12 and long 5 (swapped periods give the opposite MACD, equal ones a MACD of 0)'}
    ${'MACD'}          | ${{ short: 0 }}              | ${'short must be a whole number, at least 1, got 0'}
    ${'MACD'}          | ${{ long: 26.5 }}            | ${'long must be a whole number, at least 1, got 26.5'}
    ${'MACD'}          | ${{ signal: null }}          | ${'signal must be a whole number, at least 1, got null'}
    ${'MACD'}          | ${{ src: 'Close' }}          | ${`src must be one of ${SOURCES}, got "Close"`}
    ${'PSAR'}          | ${{ acceleration: 0 }}       | ${'acceleration must be a number, above 0, got 0'}
    ${'PSAR'}          | ${{ acceleration: '0.02' }}  | ${'acceleration must be a number, above 0, got "0.02"'}
    ${'PSAR'}          | ${{ maxAcceleration: -0.2 }} | ${'maxAcceleration must be a number, above 0, got -0.2'}
    ${'PSAR'}          | ${{ acceleration: 0.3 }}     | ${'acceleration must be at most maxAcceleration, got acceleration 0.3 and maxAcceleration 0.2 (the factor would restart above its maximum after every reversal)'}
    ${'PSAR'}          | ${{ maxAcceleration: 0.01 }} | ${'acceleration must be at most maxAcceleration, got acceleration 0.02 and maxAcceleration 0.01 (the factor would restart above its maximum after every reversal)'}
    ${'ROC'}           | ${{}}                        | ${'period must be a whole number, at least 1, got undefined'}
    ${'ROC'}           | ${{ period: 0 }}             | ${'period must be a whole number, at least 1, got 0'}
    ${'Stochastic'}    | ${{ fastKPeriod: 2.5 }}      | ${'fastKPeriod must be a whole number, at least 1, got 2.5'}
    ${'Stochastic'}    | ${{ fastKPeriod: NaN }}      | ${'fastKPeriod must be a whole number, at least 1, got NaN'}
    ${'Stochastic'}    | ${{ slowKPeriod: 0 }}        | ${'slowKPeriod must be a whole number, at least 1, got 0'}
    ${'Stochastic'}    | ${{ slowKMaType: 'smma' }}   | ${`slowKMaType must be one of ${MA_TYPES}, got "smma"`}
    ${'Stochastic'}    | ${{ slowDPeriod: 2.5 }}      | ${'slowDPeriod must be a whole number, at least 1, got 2.5'}
    ${'Stochastic'}    | ${{ slowDMaType: null }}     | ${`slowDMaType must be one of ${MA_TYPES}, got null`}
    ${'StochasticRSI'} | ${{ period: 0 }}             | ${`period must be a whole number, at least 2, got 0 (${SINGLE_CHANGE_STOCHASTIC_RSI})`}
    ${'StochasticRSI'} | ${{ period: 1 }}             | ${`period must be a whole number, at least 2, got 1 (${SINGLE_CHANGE_STOCHASTIC_RSI})`}
    ${'StochasticRSI'} | ${{ fastKPeriod: 1 }}        | ${'fastKPeriod must be a whole number, at least 2, got 1 (the range of a single RSI value is 0, so fastK would always be 0)'}
    ${'StochasticRSI'} | ${{ fastDPeriod: 1.5 }}      | ${'fastDPeriod must be a whole number, at least 1, got 1.5'}
    ${'StochasticRSI'} | ${{ slowMaType: 'SMA' }}     | ${`slowMaType must be one of ${MA_TYPES}, got "SMA"`}
    ${'TRIX'}          | ${{ period: 0 }}             | ${'period must be a whole number, at least 1, got 0'}
    ${'WilliamsR'}     | ${{ period: '14' }}          | ${'period must be a whole number, at least 1, got "14"'}
  `('should refuse $parameters for the momentum indicator $name', expectRefusal);

  it.each`
    name           | parameters          | refusal
    ${'ADX'}       | ${{}}               | ${`period must be a whole number, at least 2, got undefined (${SINGLE_CANDLE_ADX})`}
    ${'ADX'}       | ${{ period: 0 }}    | ${`period must be a whole number, at least 2, got 0 (${SINGLE_CANDLE_ADX})`}
    ${'ADX'}       | ${{ period: 1 }}    | ${`period must be a whole number, at least 2, got 1 (${SINGLE_CANDLE_ADX})`}
    ${'ADXRibbon'} | ${{ count: 0 }}     | ${'count must be a whole number, at least 1, got 0'}
    ${'ADXRibbon'} | ${{ start: 0 }}     | ${`start must be a whole number, at least 2, got 0 (${SINGLE_CANDLE_ADX})`}
    ${'ADXRibbon'} | ${{ start: 1 }}     | ${`start must be a whole number, at least 2, got 1 (${SINGLE_CANDLE_ADX})`}
    ${'ADXRibbon'} | ${{ step: 1.5 }}    | ${'step must be a whole number, at least 1, got 1.5'}
    ${'DX'}        | ${{ period: 2.5 }}  | ${`period must be a whole number, at least 2, got 2.5 (${SINGLE_CANDLE_DX})`}
    ${'DX'}        | ${{ period: 1 }}    | ${`period must be a whole number, at least 2, got 1 (${SINGLE_CANDLE_DX})`}
    ${'MinusDI'}   | ${{ period: null }} | ${'period must be a whole number, at least 1, got null'}
    ${'PlusDI'}    | ${{}}               | ${'period must be a whole number, at least 1, got undefined'}
    ${'MinusDM'}   | ${{ period: -14 }}  | ${'period must be a whole number, at least 1, got -14'}
    ${'PlusDM'}    | ${{ period: '14' }} | ${'period must be a whole number, at least 1, got "14"'}
  `('should refuse $parameters for the directional movement indicator $name', expectRefusal);

  it.each`
    name     | parameters                | refusal
    ${'AO'}  | ${{ short: 34, long: 5 }} | ${'short must be below long, got short 34 and long 5 (swapped periods give the opposite AO, equal ones an AO of 0)'}
    ${'AO'}  | ${{ short: 5, long: 5 }}  | ${'short must be below long, got short 5 and long 5 (swapped periods give the opposite AO, equal ones an AO of 0)'}
    ${'AO'}  | ${{ short: 0 }}           | ${'short must be a whole number, at least 1, got 0'}
    ${'AO'}  | ${{ long: 34.5 }}         | ${'long must be a whole number, at least 1, got 34.5'}
    ${'CCI'} | ${{ period: 1 }}          | ${'period must be a whole number, at least 2, got 1 (the CCI of a single candle is always 0)'}
    ${'CCI'} | ${{ period: 0 }}          | ${'period must be a whole number, at least 2, got 0 (the CCI of a single candle is always 0)'}
    ${'RSI'} | ${{ period: 0 }}          | ${`period must be a whole number, at least 2, got 0 (${SINGLE_CHANGE_RSI})`}
    ${'RSI'} | ${{ period: 1 }}          | ${`period must be a whole number, at least 2, got 1 (${SINGLE_CHANGE_RSI})`}
    ${'RSI'} | ${{ src: 'hlc' }}         | ${`src must be one of ${SOURCES}, got "hlc"`}
  `('should refuse $parameters for the oscillator $name', expectRefusal);

  it.each`
    name                | parameters                 | refusal
    ${'ATR'}            | ${{}}                      | ${'period must be a whole number, at least 1, got undefined'}
    ${'ATR'}            | ${{ period: 0 }}           | ${'period must be a whole number, at least 1, got 0'}
    ${'ATRCD'}          | ${{ short: 26, long: 12 }} | ${'short must be below long, got short 26 and long 12 (swapped periods give the opposite ATRCD, equal ones an ATRCD of 0)'}
    ${'ATRCD'}          | ${{ signal: 0 }}           | ${'signal must be a whole number, at least 1, got 0'}
    ${'BollingerBands'} | ${{ period: 1 }}           | ${'period must be a whole number, at least 2, got 1 (the bands of a single candle are its close: its deviation is 0)'}
    ${'BollingerBands'} | ${{ stdevUp: -2 }}         | ${'stdevUp must be a number, at least 0, got -2'}
    ${'BollingerBands'} | ${{ stdevDown: NaN }}      | ${'stdevDown must be a number, at least 0, got NaN'}
    ${'BollingerBands'} | ${{ maType: 'smma' }}      | ${`maType must be one of ${MA_TYPES}, got "smma"`}
  `('should refuse $parameters for the volatility indicator $name', expectRefusal);

  it.each`
    name     | parameters              | refusal
    ${'EFI'} | ${{ period: 0 }}        | ${'period must be a whole number, at least 1, got 0'}
    ${'EFI'} | ${{ maType: 'SMA' }}    | ${`maType must be one of ${MA_TYPES}, got "SMA"`}
    ${'EFI'} | ${{ src: 'Close' }}     | ${`src must be one of ${SOURCES}, got "Close"`}
    ${'OBV'} | ${{ period: 1 }}        | ${'period must be a whole number, at least 2, got 1 (the bands of a single candle are the OBV itself: its deviation is 0)'}
    ${'OBV'} | ${{ stdevDown: -2 }}    | ${'stdevDown must be a number, at least 0, got -2'}
    ${'OBV'} | ${{ maType: 'wilder' }} | ${`maType must be one of ${MA_TYPES}, got "wilder"`}
  `('should refuse $parameters for the volume indicator $name', expectRefusal);

  it.each`
    name                 | parameters
    ${'SMA'}             | ${{ period: 1, src: undefined }}
    ${'EMA'}             | ${{ period: 1 }}
    ${'DEMA'}            | ${{ period: 1 }}
    ${'TEMA'}            | ${{ period: 1 }}
    ${'WMA'}             | ${{ period: 1 }}
    ${'SMMA'}            | ${{ period: 1 }}
    ${'WilderSmoothing'} | ${{ period: 1 }}
    ${'EMARibbon'}       | ${{ count: 1, start: 1, step: 1 }}
    ${'MACD'}            | ${{ short: 1, long: 2, signal: 1 }}
    ${'PSAR'}            | ${{ acceleration: 0.001, maxAcceleration: 0.001 }}
    ${'ROC'}             | ${{ period: 1 }}
    ${'Stochastic'}      | ${{ fastKPeriod: 1, slowKPeriod: 1, slowDPeriod: 1 }}
    ${'StochasticRSI'}   | ${{ period: 2, fastKPeriod: 2, fastDPeriod: 1 }}
    ${'TRIX'}            | ${{ period: 1 }}
    ${'WilliamsR'}       | ${{ period: 1 }}
    ${'ADX'}             | ${{ period: 2 }}
    ${'ADXRibbon'}       | ${{ count: 1, start: 2, step: 1 }}
    ${'DX'}              | ${{ period: 2 }}
    ${'MinusDI'}         | ${{ period: 1 }}
    ${'PlusDI'}          | ${{ period: 1 }}
    ${'MinusDM'}         | ${{ period: 1 }}
    ${'PlusDM'}          | ${{ period: 1 }}
    ${'AO'}              | ${{ short: 1, long: 2 }}
    ${'CCI'}             | ${{ period: 2 }}
    ${'RSI'}             | ${{ period: 2 }}
    ${'ATR'}             | ${{ period: 1 }}
    ${'ATRCD'}           | ${{ short: 1, long: 2, signal: 1 }}
    ${'BollingerBands'}  | ${{ period: 2, stdevUp: 0, stdevDown: 0 }}
    ${'TrueRange'}       | ${undefined}
    ${'EFI'}             | ${{ period: 1 }}
    ${'OBV'}             | ${{ period: 2, stdevUp: 0, stdevDown: 0 }}
  `('should accept $parameters for $name, the smallest values it takes', ({ name, parameters }) => {
    expect(() => create(name, parameters)).not.toThrow();
  });

  // A strategy may hand an indicator a block of its own parameters, keys the indicator does not take included
  it('should ignore the keys an indicator does not take', () => {
    expect(() => create('EMARibbon', { count: 5, start: 5, step: 2, src: 'ohlc4', spreadThreshold: 100, separator: 2 })).not.toThrow();
  });

  // The defaults the indicators document, which a strategy gets for every key it leaves out
  it.each`
    name                 | defaults
    ${'SMA'}             | ${{ period: 30, src: 'close' }}
    ${'EMA'}             | ${{ period: 30, src: 'close' }}
    ${'WilderSmoothing'} | ${{ period: 14, src: 'close' }}
    ${'EMARibbon'}       | ${{ count: 22, start: 3, step: 3, src: 'close' }}
    ${'MACD'}            | ${{ short: 12, long: 26, signal: 9, src: 'close' }}
    ${'PSAR'}            | ${{ acceleration: 0.02, maxAcceleration: 0.2 }}
    ${'Stochastic'}      | ${{ fastKPeriod: 5, slowKPeriod: 3, slowKMaType: 'sma', slowDPeriod: 3, slowDMaType: 'sma' }}
    ${'StochasticRSI'}   | ${{ period: 14, fastKPeriod: 5, fastDPeriod: 3, slowMaType: 'sma' }}
    ${'TRIX'}            | ${{ period: 30 }}
    ${'WilliamsR'}       | ${{ period: 14 }}
    ${'ADXRibbon'}       | ${{ count: 19, start: 12, step: 3 }}
    ${'AO'}              | ${{ short: 5, long: 34 }}
    ${'CCI'}             | ${{ period: 14 }}
    ${'RSI'}             | ${{ period: 14, src: 'close' }}
    ${'ATRCD'}           | ${{ short: 12, long: 26, signal: 9 }}
    ${'BollingerBands'}  | ${{ period: 5, stdevUp: 2, stdevDown: 2, maType: 'sma' }}
    ${'EFI'}             | ${{ period: 13, maType: 'ema', src: 'close' }}
    ${'OBV'}             | ${{ period: 14, stdevUp: 2, stdevDown: 2, maType: 'sma' }}
  `('should take $defaults when $name is given no parameter', ({ name, defaults }) => {
    expect(series(create(name, {}))).toEqual(series(create(name, defaults)));
  });

  // Given no parameter block at all rather than an empty one, an indicator takes the same defaults: the block defaults to an empty one
  it.each`
    name
    ${'SMA'}
    ${'EMA'}
    ${'WilderSmoothing'}
    ${'EMARibbon'}
    ${'MACD'}
    ${'PSAR'}
    ${'Stochastic'}
    ${'StochasticRSI'}
    ${'TRIX'}
    ${'WilliamsR'}
    ${'ADXRibbon'}
    ${'AO'}
    ${'CCI'}
    ${'RSI'}
    ${'ATRCD'}
    ${'BollingerBands'}
    ${'EFI'}
    ${'OBV'}
  `('should take its defaults when $name is given no parameter block at all', ({ name }) => {
    expect(series(create(name))).toEqual(series(create(name, {})));
  });
});

// Each name a maType key takes stands for the moving average of that name. BollingerBands, EFI and Stochastic used to map the names to
// the classes in a copy each, where a wrong class compiled unnoticed: each of their keys is checked here against that class, by name.
// OBV and StochasticRSI hand theirs on, to the bands of their OBV and to the Stochastic of their RSI, and are checked the same way
describe.each`
  maType    | average
  ${'sma'}  | ${'SMA'}
  ${'ema'}  | ${'EMA'}
  ${'dema'} | ${'DEMA'}
  ${'wma'}  | ${'WMA'}
`('Indicator maType $maType', ({ maType, average }) => {
  /** What an indicator gets back from the average it feeds a value on each candle, null where it feeds none */
  const smooth = (name: string, period: number, values: (number | null)[]) => {
    const smoother = create(name, { period });
    return values.map((value, index) => {
      if (value === null) return null;
      smoother.onNewCandle({ ...candles[index], close: value });
      return smoother.getResult() as number | null;
    });
  };
  // What they feed their averages: the close, the force from the second candle, and the raw %K of the last 3 candles from the third,
  // which a flat range never makes 0 here since the zigzag has none
  const closes = candles.map(({ close }) => close);
  const forces = candles.map((candle, index) => (index === 0 ? null : (candle.close - candles[index - 1].close) * candle.volume));
  const rawKs = candles.map((candle, index) => {
    if (index < 2) return null;
    const window = candles.slice(index - 2, index + 1);
    const lowest = Math.min(...window.map(({ low }) => low));
    const highest = Math.max(...window.map(({ high }) => high));
    return ((candle.close - lowest) / (highest - lowest)) * 100;
  });
  /** Stochastic's k and d with 3-candle averages of these classes, published together once d is ready */
  const stochastic = (kAverage: string, dAverage: string) => {
    const ks = smooth(kAverage, 3, rawKs);
    const ds = smooth(dAverage, 3, ks);
    return { k: ks.map((k, index) => (ds[index] === null ? null : k)), d: ds };
  };
  // And what OBV and StochasticRSI feed theirs: the OBV, the first volume then each volume added on a higher close and taken off on a
  // lower one, which the zigzag never leaves unchanged, and the raw %K of the last 3 RSI values, which never hold still here either.
  // StochasticRSI averages that raw %K over 1 candle into fastK, then fastK over fastDPeriod into fastD, both with its kind
  const obvs: number[] = [];
  candles.forEach(({ close, volume }, index) =>
    obvs.push(index === 0 ? volume : obvs[index - 1] + Math.sign(close - candles[index - 1].close) * volume),
  );
  const rsis = series(create('RSI', { period: 5 })) as (number | null)[];
  const rsiRawKs = rsis.map((rsi, index) => {
    const window = rsis.slice(Math.max(0, index - 2), index + 1);
    if (rsi === null || window.length < 3 || window.includes(null)) return null;
    const lowest = Math.min(...(window as number[]));
    const highest = Math.max(...(window as number[]));
    return ((rsi - lowest) / (highest - lowest)) * 100;
  });

  it.each`
    name                | key              | parameters                                            | field         | expected
    ${'BollingerBands'} | ${'maType'}      | ${{ period: 5 }}                                      | ${'middle'}   | ${() => smooth(average, 5, closes)}
    ${'EFI'}            | ${'maType'}      | ${{ period: 5 }}                                      | ${'smoothed'} | ${() => smooth(average, 5, forces)}
    ${'Stochastic'}     | ${'slowKMaType'} | ${{ fastKPeriod: 3, slowKPeriod: 3, slowDPeriod: 3 }} | ${'k'}        | ${() => stochastic(average, 'SMA').k}
    ${'Stochastic'}     | ${'slowDMaType'} | ${{ fastKPeriod: 3, slowKPeriod: 3, slowDPeriod: 3 }} | ${'d'}        | ${() => stochastic('SMA', average).d}
    ${'OBV'}            | ${'maType'}      | ${{ period: 5 }}                                      | ${'ma'}       | ${() => smooth(average, 5, obvs)}
    ${'StochasticRSI'}  | ${'slowMaType'}  | ${{ period: 5, fastKPeriod: 3, fastDPeriod: 3 }}      | ${'fastD'}    | ${() => smooth(average, 3, smooth(average, 1, rsiRawKs))}
  `('should smooth the $field of $name with the class its $key names', ({ name, key, parameters, field, expected }) => {
    const indicator = create(name, { ...parameters, [key]: maType });
    expect(series(indicator).map(result => (result === null ? null : (result as Record<string, number>)[field]))).toEqual(expected());
  });
});
