import { approximately, illiquidCandles, resultsOf } from '@indicators/indicator.mock';
import { getTrueRange } from '@indicators/volatility/trueRange/trueRange.helper';
import { Candle } from '@models/candle.types';
import { describe, expect, it, vi } from 'vitest';
import { ADX } from './adx/adx.indicator';
import { ADXRibbon } from './adxRibbon/adxRibbon.indicator';
import { DX } from './dx/dx.indicator';
import { MinusDI } from './minusDI/minusDI.indicator';
import { MinusDM } from './minusDM/minusDM.indicator';
import { PlusDI } from './plusDI/plusDI.indicator';
import { PlusDM } from './plusDM/plusDM.indicator';

// The real true range runs (vi.fn(impl) survives mockReset), spied to count how often each candle's is computed
vi.mock('@indicators/volatility/trueRange/trueRange.helper', async importOriginal => {
  const actual = await importOriginal<typeof import('@indicators/volatility/trueRange/trueRange.helper')>();
  return { getTrueRange: vi.fn(actual.getTrueRange) };
});

const zigzag: Candle[] = Array.from({ length: 40 }, (_, index) => {
  const close = 100 + 10 * Math.sin(index / 3) + 5 * Math.sin(index / 7);
  return { start: index * 60_000, open: close, high: close + 1 + (index % 3), low: close - 1 - (index % 5), close, volume: 100 };
});

describe('DirectionalMovement', () => {
  // DX used to build a PlusDI and a MinusDI, which each computed the true range of every candle: twice per candle, and 38 times in the
  // default ribbon of 19 ADXs. Both DIs now read one directional movement
  it.each`
    name           | create                           | perCandle
    ${'DX'}        | ${() => new DX({ period: 14 })}  | ${1}
    ${'ADX'}       | ${() => new ADX({ period: 14 })} | ${1}
    ${'ADXRibbon'} | ${() => new ADXRibbon()}         | ${19}
  `('should compute the true range of each candle after the first $perCandle time(s) for $name', ({ create, perCandle }) => {
    resultsOf(create(), zigzag);
    expect(getTrueRange).toHaveBeenCalledTimes(perCandle * (zigzag.length - 1));
  });

  // As in TA-Lib: a DI over a true range of 0 is 0, and so is the DX of two DIs of 0, rather than 0/0
  const flat: Candle = { start: 0, open: 10, high: 10, low: 10, close: 10, volume: 0 };
  it.each`
    name         | create                              | expected
    ${'PlusDM'}  | ${() => new PlusDM({ period: 2 })}  | ${[null, 0, 0, 0]}
    ${'MinusDM'} | ${() => new MinusDM({ period: 2 })} | ${[null, 0, 0, 0]}
    ${'PlusDI'}  | ${() => new PlusDI({ period: 2 })}  | ${[null, null, 0, 0]}
    ${'MinusDI'} | ${() => new MinusDI({ period: 2 })} | ${[null, null, 0, 0]}
    ${'DX'}      | ${() => new DX({ period: 2 })}      | ${[null, null, 0, 0]}
  `('should return $expected for $name on candles that never move', ({ create, expected }) => {
    expect(resultsOf(create(), [flat, flat, flat, flat])).toEqual(expected);
  });

  // A candle that reaches as far above the previous high as below the previous low has no direction: neither DM counts the move
  const outside: Candle[] = [
    { start: 0, open: 9, high: 10, low: 8, close: 9, volume: 1 },
    { start: 60_000, open: 9, high: 11, low: 7, close: 9, volume: 1 },
  ];
  it.each`
    name         | create
    ${'PlusDM'}  | ${() => new PlusDM({ period: 1 })}
    ${'MinusDM'} | ${() => new MinusDM({ period: 1 })}
  `('should return 0 for $name on a candle that moves as far up as down', ({ create }) => {
    expect(resultsOf(create(), outside)).toEqual([null, 0]);
  });

  // By hand on an illiquid market, with period 2. The DIs divide the DMs by the true ranges of its gaps, 4, 5 and 4 where high − low
  // gives 2, 3 and 0: the value tables' candles never gap, so DIs over high − low passed them. The made-up candles, and the candle that
  // moves as far up as down, halve both DMs, so DX holds at 20 over them, as over any candle without directional movement
  it.each`
    name         | create                              | expected
    ${'PlusDM'}  | ${() => new PlusDM({ period: 2 })}  | ${[null, 0, 0, 4, 2, 3, 1.5, 0.75, 0.375, 0.1875, 3.09375]}
    ${'MinusDM'} | ${() => new MinusDM({ period: 2 })} | ${[null, 0, 0, 0, 4, 2, 1, 0.5, 0.25, 1.125, 0.5625]}
    ${'PlusDI'}  | ${() => new PlusDI({ period: 2 })}  | ${[null, null, 0, 100, 200 / 7, 40, 40, 40, 600 / 47, 200 / 37, 6600 / 101]}
    ${'MinusDI'} | ${() => new MinusDI({ period: 2 })} | ${[null, null, 0, 0, 400 / 7, 80 / 3, 80 / 3, 80 / 3, 400 / 47, 1200 / 37, 1200 / 101]}
    ${'DX'}      | ${() => new DX({ period: 2 })}      | ${[null, null, 0, 100, 100 / 3, 20, 20, 20, 20, 500 / 7, 900 / 13]}
  `('should return the values worked out by hand for $name on an illiquid market', ({ create, expected }) => {
    expect(resultsOf(create(), illiquidCandles)).toEqual(approximately(expected, 12));
  });
});
