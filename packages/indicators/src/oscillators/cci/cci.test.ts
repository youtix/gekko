import { approximately } from '../../indicator.mock';
import { Candle } from '@gekko/shared/models/candle.types';
import { describe, expect, it } from 'vitest';
import { CCI } from './cci.indicator';

const flat = (price: number): Candle => ({ start: 0, open: price, high: price, low: price, close: price, volume: 0 });
const traded = (close: number, high: number, low: number): Candle => ({ start: 0, open: close, high, low, close, volume: 1 });

describe('CCI', () => {
  const cci = new CCI({ period: 9 });
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
    ${{ close: 99, open: 92, high: 101.5127586628106, low: 89.4872413371894, volume: 647 }}     | ${128.98903775883073}
    ${{ close: 2, open: 99, high: 99.0804764241746, low: 1.9195235758253941, volume: 396 }}     | ${-61.603733559609665}
    ${{ close: 86, open: 2, high: 86.08306699694582, low: 1.916933003054178, volume: 252 }}     | ${14.42938347179712}
    ${{ close: 80, open: 86, high: 87.6552826540483, low: 78.3447173459517, volume: 299 }}      | ${79.70565453137107}
    ${{ close: 76, open: 80, high: 80.75068906338092, low: 75.24931093661908, volume: 469 }}    | ${50.491679273827536}
    ${{ close: 8, open: 76, high: 77.2154050332975, low: 6.784594966702496, volume: 605 }}      | ${-93.2370820668693}
    ${{ close: 87, open: 8, high: 90.4594244098795, low: 4.540575590120497, volume: 261 }}      | ${-14.196428571428587}
    ${{ close: 75, open: 87, high: 91.6843769949034, low: 70.3156230050966, volume: 926 }}      | ${42.07077326343381}
    ${{ close: 32, open: 75, high: 77.42509022428217, low: 29.57490977571783, volume: 544 }}    | ${-58.807947019867534}
    ${{ close: 65, open: 32, high: 66.96254158787707, low: 30.037458412122934, volume: 819 }}   | ${-18.116343490304715}
    ${{ close: 41, open: 65, high: 69.41431179251751, low: 36.58568820748249, volume: 1012 }}   | ${-53.038674033149164}
    ${{ close: 9, open: 41, high: 43.081607806555546, low: 6.918392193444454, volume: 736 }}    | ${-138.5830540928674}
    ${{ close: 13, open: 9, high: 15.19184083967761, low: 6.808159160322391, volume: 971 }}     | ${-131.37697516930027}
    ${{ close: 26, open: 13, high: 28.498919258834377, low: 10.501080741165623, volume: 1098 }} | ${-72.25485765928606}
    ${{ close: 56, open: 26, high: 59.7249059948739, low: 22.2750940051261, volume: 379 }}      | ${11.353711790393028}
    ${{ close: 28, open: 56, high: 58.44863123776439, low: 25.551368762235615, volume: 117 }}   | ${-13.319566339700561}
    ${{ close: 65, open: 28, high: 66.775319062114, low: 26.224680937886014, volume: 1041 }}    | ${75.32387415175819}
    ${{ close: 58, open: 65, high: 68.65939501847261, low: 54.340604981527385, volume: 510 }}   | ${95.91950810508665}
    ${{ close: 17, open: 58, high: 60.01918882495998, low: 14.980811175040019, volume: 878 }}   | ${-28.241563055062173}
    ${{ close: 90, open: 17, high: 93.37632122668938, low: 13.623678773310617, volume: 150 }}   | ${115.11991657977062}
    ${{ close: 87, open: 90, high: 91.79876207396401, low: 85.20123792603599, volume: 914 }}    | ${152.41935483870967}
    ${{ close: 86, open: 87, high: 90.67917429835809, low: 82.32082570164191, volume: 582 }}    | ${115.59020044543435}
    ${{ close: 99, open: 86, high: 103.90666224637769, low: 81.09333775362231, volume: 804 }}   | ${113.80662020905925}
    ${{ close: 3, open: 99, high: 100.63598126886475, low: 1.3640187311352432, volume: 436 }}   | ${-87.35584843492587}
    ${{ close: 70, open: 3, high: 74.01339408473842, low: -1.0133940847384295, volume: 747 }}   | ${-51.562500000000014}
    ${{ close: 1, open: 70, high: 70.62974231530183, low: 0.37025768469818, volume: 722 }}      | ${-106.23134328358209}
    ${{ close: 27, open: 1, high: 30.879348918826008, low: -2.879348918826009, volume: 221 }}   | ${-92.89340101522842}
    ${{ close: 9, open: 27, high: 29.207668220474442, low: 6.792331779525556, volume: 148 }}    | ${-91.52694610778445}
    ${{ close: 92, open: 9, high: 96.46225023362183, low: 4.5377497663781705, volume: 331 }}    | ${28.644578313253014}
    ${{ close: 68, open: 92, high: 94.82774764949542, low: 65.17225235050458, volume: 338 }}    | ${63.82165605095541}
    ${{ close: 9, open: 68, high: 69.94866467256739, low: 7.051335327432617, volume: 823 }}     | ${-47.02295552367288}
  `('should return $expected when candle close to $candle.close', ({ candle, expected }) => {
    cci.onNewCandle(candle);
    expect(cci.getResult()).toEqual(approximately(expected, 12));
  });

  // A flat window used to give ±66.67 instead of 0: its mean, summed in floating point, lands a few ulps off the price, and the mean
  // deviation was that residue. Flat at 30000.11 it gave +66.67, flat at 30000.06 −66.67. Values near 30000 move with the order of the
  // sums, hence 8 digits
  const cciFlat = new CCI({ period: 5 });
  it.each`
    step                              | candle                                                                         | expected
    ${'the first candle'}             | ${{ close: 30000.4, open: 29990, high: 30005.5, low: 29985.25, volume: 12 }}   | ${null}
    ${'a second candle'}              | ${{ close: 30010.2, open: 30000.4, high: 30012.75, low: 29998.1, volume: 9 }}  | ${null}
    ${'a third candle'}               | ${{ close: 29995.6, open: 30010.2, high: 30015, low: 29992.3, volume: 15 }}    | ${null}
    ${'a fourth candle'}              | ${{ close: 30001.15, open: 29995.6, high: 30003.8, low: 29990.45, volume: 7 }} | ${null}
    ${'a fifth, closing at 30000.11'} | ${{ close: 30000.11, open: 30001.15, high: 30004.9, low: 29998, volume: 11 }}  | ${2.722676001723103}
    ${'a flat candle at 30000.11'}    | ${flat(30000.11)}                                                              | ${-42.47416020674449}
    ${'a second flat one'}            | ${flat(30000.11)}                                                              | ${-2.0825198490837336}
    ${'a third flat one'}             | ${flat(30000.11)}                                                              | ${16.741071428667496}
    ${'a fourth flat one'}            | ${flat(30000.11)}                                                              | ${-41.66666666709087}
    ${'a fifth: the window is flat'}  | ${flat(30000.11)}                                                              | ${0}
    ${'a sixth flat one'}             | ${flat(30000.11)}                                                              | ${0}
    ${'a move to 30000.06'}           | ${{ close: 30000.06, open: 30000.11, high: 30003, low: 29999, volume: 4 }}     | ${166.6666666646952}
    ${'a flat candle at 30000.06'}    | ${flat(30000.06)}                                                              | ${-54.92692126342392}
    ${'a second flat one'}            | ${flat(30000.06)}                                                              | ${-50.32317636214945}
    ${'a third flat one'}             | ${flat(30000.06)}                                                              | ${-45.906829488009826}
    ${'a fourth flat one'}            | ${flat(30000.06)}                                                              | ${-41.666666666817854}
    ${'a fifth: the window is flat'}  | ${flat(30000.06)}                                                              | ${0}
    ${'a sixth flat one'}             | ${flat(30000.06)}                                                              | ${0}
  `('should return $expected on candle %$, $step', ({ candle, expected }) => {
    cciFlat.onNewCandle(candle);
    expect(cciFlat.getResult()).toEqual(approximately(expected, 8));
  });

  // Typical prices equal within the tolerance make a flat window. That also covers prices equal in exact arithmetic but an ulp apart in
  // floating point, as a wick: a candle that traded a tick either side and closed unchanged. Read as a deviation, it gave up to
  // period / 0.015
  it.each`
    window                                  | candles                                                                     | old
    ${'5 flat at 30000.11'}                 | ${Array(5).fill(flat(30000.11))}                                            | ${66.67}
    ${'5 flat at 0.007'}                    | ${Array(5).fill(flat(0.007))}                                               | ${-66.67}
    ${'4 flat at 30000.05, then a wick'}    | ${[...Array(4).fill(flat(30000.05)), traded(30000.05, 30000.06, 30000.04)]} | ${333.33}
    ${'a wick, then 4 flat at 30000.06'}    | ${[traded(30000.06, 30000.07, 30000.05), ...Array(4).fill(flat(30000.06))]} | ${83.33}
    ${'4 flat at 30000, one 3.3e-11 above'} | ${[...Array(4).fill(flat(30000)), flat(30000.000001)]}                      | ${166.67}
  `('should return 0 for $window, not $old', ({ candles }) => {
    const cci = new CCI({ period: 5 });
    for (const candle of candles) cci.onNewCandle(candle);
    expect(cci.getResult()).toBe(0);
  });

  // One candle off an otherwise flat window gives period / 0.03 when it comes last, −period / (0.03 × (period − 1)) otherwise, however
  // small its step, as long as it is a real one. In the last row the last typical price is within the tolerance of the mean. A step this
  // small is held only to the rounding of the price, which puts the CCI up to 4.2e-6 off these exact values: hence 4 digits
  it.each`
    window                                 | period | candles                                                                                 | expected
    ${'4 flat at 30000, one 1e-8 above'}   | ${5}   | ${[...Array(4).fill(flat(30000)), flat(30000.0003)]}                                    | ${500 / 3}
    ${'4 flat at 30000, one 1e-8 below'}   | ${5}   | ${[...Array(4).fill(flat(30000)), flat(29999.9997)]}                                    | ${-500 / 3}
    ${'4 flat at 30000.05, one tick up'}   | ${5}   | ${[...Array(4).fill(flat(30000.05)), traded(30000.06, 30000.06, 30000.05)]}             | ${500 / 3}
    ${'4 flat at 0.1, one 1e-7 above'}     | ${5}   | ${[...Array(4).fill(flat(0.1)), flat(0.10000001)]}                                      | ${500 / 3}
    ${'99 flat at 100000, one 5e-8 above'} | ${100} | ${[...Array(50).fill(flat(100000)), flat(100000.005), ...Array(49).fill(flat(100000))]} | ${-100 / (0.03 * 99)}
  `('should return $expected for $window', ({ period, candles, expected }) => {
    const cci = new CCI({ period });
    for (const candle of candles) cci.onNewCandle(candle);
    expect(cci.getResult()).toEqual(approximately(expected, 4));
  });
});
