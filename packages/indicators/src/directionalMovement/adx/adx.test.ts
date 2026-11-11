import { approximately } from '../../indicator.mock';
import { WilderSmoothing } from '../../movingAverages/wilderSmoothing/wilderSmoothing.indicator';
import { Candle } from '@gekko/shared/models/candle.types';
import { describe, expect, it } from 'vitest';
import { DX } from '../dx/dx.indicator';
import { ADX } from './adx.indicator';

// A zigzag whose highs and lows move apart and together, long enough for every period below to seed its smoothing and run past it
const zigzag: Candle[] = Array.from({ length: 80 }, (_, index) => {
  const close = 100 + 10 * Math.sin(index / 3) + 5 * Math.sin(index / 7);
  return { start: index * 60_000, open: close, high: close + 1 + (index % 3), low: close - 1 - (index % 5), close, volume: 100 };
});

describe('ADX', () => {
  const adx = new ADX({ period: 9 });
  it.each`
    candle                                                                                      | expected
    ${{ close: 81, open: 81, high: 82.96289647361662, low: 79.03710352638338, volume: 403 }}    | ${null}
    ${{ close: 24, open: 81, high: 83.85720988022568, low: 21.142790119774318, volume: 814 }}   | ${null}
    ${{ close: 75, open: 24, high: 76.94326596315126, low: 22.056734036848734, volume: 1064 }}  | ${null}
    ${{ close: 21, open: 75, high: 79.67167346434113, low: 16.328326535658874, volume: 330 }}   | ${null}
    ${{ close: 34, open: 21, high: 34.711649023641215, low: 20.28835097635878, volume: 964 }}   | ${null}
    ${{ close: 25, open: 34, high: 36.18138133787512, low: 22.818618662124877, volume: 214 }}   | ${null}
    ${{ close: 72, open: 25, high: 73.33035016836122, low: 23.669649831638775, volume: 860 }}   | ${null}
    ${{ close: 92, open: 72, high: 94.97523624952838, low: 69.02476375047162, volume: 486 }}    | ${null}
    ${{ close: 99, open: 92, high: 101.5127586628106, low: 89.4872413371894, volume: 647 }}     | ${null}
    ${{ close: 2, open: 99, high: 99.0804764241746, low: 1.9195235758253941, volume: 396 }}     | ${null}
    ${{ close: 86, open: 2, high: 86.08306699694582, low: 1.916933003054178, volume: 252 }}     | ${null}
    ${{ close: 80, open: 86, high: 87.6552826540483, low: 78.3447173459517, volume: 299 }}      | ${null}
    ${{ close: 76, open: 80, high: 80.75068906338092, low: 75.24931093661908, volume: 469 }}    | ${null}
    ${{ close: 8, open: 76, high: 77.2154050332975, low: 6.784594966702496, volume: 605 }}      | ${null}
    ${{ close: 87, open: 8, high: 90.4594244098795, low: 4.540575590120497, volume: 261 }}      | ${null}
    ${{ close: 75, open: 87, high: 91.6843769949034, low: 70.3156230050966, volume: 926 }}      | ${null}
    ${{ close: 32, open: 75, high: 77.42509022428217, low: 29.57490977571783, volume: 544 }}    | ${null}
    ${{ close: 65, open: 32, high: 66.96254158787707, low: 30.037458412122934, volume: 819 }}   | ${49.59638591814373}
    ${{ close: 41, open: 65, high: 69.41431179251751, low: 36.58568820748249, volume: 1012 }}   | ${50.47262030548518}
    ${{ close: 9, open: 41, high: 43.081607806555546, low: 6.918392193444454, volume: 736 }}    | ${52.0908173439492}
    ${{ close: 13, open: 9, high: 15.19184083967761, low: 6.808159160322391, volume: 971 }}     | ${53.53209768714351}
    ${{ close: 26, open: 13, high: 28.498919258834377, low: 10.501080741165623, volume: 1098 }} | ${53.134067556993905}
    ${{ close: 56, open: 26, high: 59.7249059948739, low: 22.2750940051261, volume: 379 }}      | ${49.53715171897203}
    ${{ close: 28, open: 56, high: 58.44863123776439, low: 25.551368762235615, volume: 117 }}   | ${46.33989319628592}
    ${{ close: 65, open: 28, high: 66.775319062114, low: 26.224680937886014, volume: 1041 }}    | ${42.67075410972949}
    ${{ close: 58, open: 65, high: 68.65939501847261, low: 54.340604981527385, volume: 510 }}   | ${39.21477939744913}
    ${{ close: 17, open: 58, high: 60.01918882495998, low: 14.980811175040019, volume: 878 }}   | ${38.76013732322219}
    ${{ close: 90, open: 17, high: 93.37632122668938, low: 13.623678773310617, volume: 150 }}   | ${35.31528832603742}
    ${{ close: 87, open: 90, high: 91.79876207396401, low: 85.20123792603599, volume: 914 }}    | ${32.25320032853985}
    ${{ close: 86, open: 87, high: 90.67917429835809, low: 82.32082570164191, volume: 582 }}    | ${29.753289884431524}
    ${{ close: 99, open: 86, high: 103.90666224637769, low: 81.09333775362231, volume: 804 }}   | ${26.59060790670204}
    ${{ close: 3, open: 99, high: 100.63598126886475, low: 1.3640187311352432, volume: 436 }}   | ${28.057289989299047}
    ${{ close: 70, open: 3, high: 74.01339408473842, low: -1.0133940847384295, volume: 747 }}   | ${29.450803478632245}
    ${{ close: 1, open: 70, high: 70.62974231530183, low: 0.37025768469818, volume: 722 }}      | ${30.68948213581731}
    ${{ close: 27, open: 1, high: 30.879348918826008, low: -2.879348918826009, volume: 221 }}   | ${31.94030873152129}
    ${{ close: 9, open: 27, high: 29.207668220474442, low: 6.792331779525556, volume: 148 }}    | ${33.05215459436927}
    ${{ close: 92, open: 9, high: 96.46225023362183, low: 4.5377497663781705, volume: 331 }}    | ${30.598893330651187}
    ${{ close: 68, open: 92, high: 94.82774764949542, low: 65.17225235050458, volume: 338 }}    | ${28.41821665179067}
    ${{ close: 9, open: 68, high: 69.94866467256739, low: 7.051335327432617, volume: 823 }}     | ${27.612946871844642}
  `('should return $expected when candle close to $candle.close', ({ candle, expected }) => {
    adx.onNewCandle(candle);
    expect(adx.getResult()).toEqual(approximately(expected, 12));
  });

  // The period-2 DX of dx.test.ts, 60, then 300 / 11 from the move up by 1.5 through the same candle again, then 4500 / 59, smoothed
  // over 2 from the mean of its first two values. On the candles without directional movement ADX heads for the DX they keep, where
  // ADX(1), now refused, fell to 0
  const adx2 = new ADX({ period: 2 });
  it.each`
    move                       | candle                                 | expected
    ${'the first candle'}      | ${{ high: 10, low: 8, close: 9 }}      | ${null}
    ${'a move up by 1'}        | ${{ high: 11, low: 9, close: 10 }}     | ${null}
    ${'a move down by 2'}      | ${{ high: 10.5, low: 7, close: 8 }}    | ${null}
    ${'a move up by 1.5'}      | ${{ high: 12, low: 9, close: 11 }}     | ${(60 + 300 / 11) / 2}
    ${'an inside candle'}      | ${{ high: 11.5, low: 9.5, close: 10 }} | ${(480 / 11 + 300 / 11) / 2}
    ${'the same candle again'} | ${{ high: 11.5, low: 9.5, close: 10 }} | ${(390 / 11 + 300 / 11) / 2}
    ${'a move down by 1.5'}    | ${{ high: 11, low: 8, close: 9 }}      | ${(345 / 11 + 4500 / 59) / 2}
  `('should return $expected with period 2 for $move', ({ candle, expected }) => {
    adx2.onNewCandle(candle);
    expect(adx2.getResult()).toEqual(approximately(expected, 12));
  });

  it.each`
    period
    ${2}
    ${9}
    ${14}
  `('should be the Wilder smoothing of DX, nulls included, with period $period', ({ period }) => {
    const indicator = new ADX({ period });
    const dx = new DX({ period });
    const smoothing = new WilderSmoothing({ period });
    const results: (number | null)[] = [];
    const smoothedDx: (number | null)[] = [];
    zigzag.forEach(candle => {
      indicator.onNewCandle(candle);
      results.push(indicator.getResult());
      dx.onNewCandle(candle);
      const value = dx.getResult();
      if (value !== null) smoothing.onNewCandle({ ...candle, close: value });
      smoothedDx.push(smoothing.getResult());
    });
    expect(results).toEqual(smoothedDx);
  });
});
