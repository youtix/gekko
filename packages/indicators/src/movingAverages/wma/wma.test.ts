import { approximately } from '../../indicator.mock';
import { Candle } from '@gekko/shared/models/candle.types';
import { describe, expect, it } from 'vitest';
import { WMA } from './wma.indicator';

const toCandle = (close: number): Candle => ({ start: 0, open: close, high: close, low: close, close, volume: 0 });
/** The weighted average of a window summed afresh, oldest price first, as the WMA used to do on every candle */
const fullSum = (window: number[]) =>
  window.reduce((sum, close, i) => sum + close * (i + 1), 0) / ((window.length * (window.length + 1)) / 2);
/** A year of 1-minute closes: a random walk from 60000 in cents, drawn from a seeded generator so that every run gets the same */
const yearOfCloses = (() => {
  let seed = 7;
  let close = 60000;
  return Array.from({ length: 525_600 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    close = Math.max(100, Math.round(close * (1 + (seed / 2 ** 32 - 0.5) * 0.004) * 100) / 100);
    return close;
  });
})();

describe('WMA', () => {
  const wma = new WMA({ period: 9 });
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
    ${{ close: 99, open: 92, high: 101.5127586628106, low: 89.4872413371894, volume: 647 }}     | ${64.2}
    ${{ close: 2, open: 99, high: 99.0804764241746, low: 1.9195235758253941, volume: 396 }}     | ${52.977777777777774}
    ${{ close: 86, open: 2, high: 86.08306699694582, low: 1.916933003054178, volume: 252 }}     | ${60.31111111111111}
    ${{ close: 80, open: 86, high: 87.6552826540483, low: 78.3447173459517, volume: 299 }}      | ${65.06666666666666}
    ${{ close: 76, open: 80, high: 80.75068906338092, low: 75.24931093661908, volume: 469 }}    | ${68.91111111111111}
    ${{ close: 8, open: 76, high: 77.2154050332975, low: 6.784594966702496, volume: 605 }}      | ${57.93333333333333}
    ${{ close: 87, open: 8, high: 90.4594244098795, low: 4.540575590120497, volume: 261 }}      | ${63.333333333333336}
    ${{ close: 75, open: 87, high: 91.6843769949034, low: 70.3156230050966, volume: 926 }}      | ${64.95555555555555}
    ${{ close: 32, open: 75, high: 77.42509022428217, low: 29.57490977571783, volume: 544 }}    | ${57.91111111111111}
    ${{ close: 65, open: 32, high: 66.96254158787707, low: 30.037458412122934, volume: 819 }}   | ${58.8}
    ${{ close: 41, open: 65, high: 69.41431179251751, low: 36.58568820748249, volume: 1012 }}   | ${55.644444444444446}
    ${{ close: 9, open: 41, high: 43.081607806555546, low: 6.918392193444454, volume: 736 }}    | ${45.22222222222222}
    ${{ close: 13, open: 9, high: 15.19184083967761, low: 6.808159160322391, volume: 971 }}     | ${37.31111111111111}
    ${{ close: 26, open: 13, high: 28.498919258834377, low: 10.501080741165623, volume: 1098 }} | ${33.48888888888889}
    ${{ close: 56, open: 26, high: 59.7249059948739, low: 22.2750940051261, volume: 379 }}      | ${36.77777777777778}
    ${{ close: 28, open: 56, high: 58.44863123776439, low: 25.551368762235615, volume: 117 }}   | ${33.4}
    ${{ close: 65, open: 28, high: 66.775319062114, low: 26.224680937886014, volume: 1041 }}    | ${38.733333333333334}
    ${{ close: 58, open: 65, high: 68.65939501847261, low: 54.340604981527385, volume: 510 }}   | ${42.888888888888886}
    ${{ close: 17, open: 58, high: 60.01918882495998, low: 14.980811175040019, volume: 878 }}   | ${38.266666666666666}
    ${{ close: 90, open: 17, high: 93.37632122668938, low: 13.623678773310617, volume: 150 }}   | ${49.31111111111111}
    ${{ close: 87, open: 90, high: 91.79876207396401, low: 85.20123792603599, volume: 914 }}    | ${58.666666666666664}
    ${{ close: 86, open: 87, high: 90.67917429835809, low: 82.32082570164191, volume: 582 }}    | ${66.08888888888889}
    ${{ close: 99, open: 86, high: 103.90666224637769, low: 81.09333775362231, volume: 804 }}   | ${74.4888888888889}
    ${{ close: 3, open: 99, high: 100.63598126886475, low: 1.3640187311352432, volume: 436 }}   | ${62.06666666666667}
    ${{ close: 70, open: 3, high: 74.01339408473842, low: -1.0133940847384295, volume: 747 }}   | ${64.22222222222223}
    ${{ close: 1, open: 70, high: 70.62974231530183, low: 0.37025768469818, volume: 722 }}      | ${51.644444444444446}
    ${{ close: 27, open: 1, high: 30.879348918826008, low: -2.879348918826009, volume: 221 }}   | ${45.68888888888889}
    ${{ close: 9, open: 27, high: 29.207668220474442, low: 6.792331779525556, volume: 148 }}    | ${36.82222222222222}
    ${{ close: 92, open: 9, high: 96.46225023362183, low: 4.5377497663781705, volume: 331 }}    | ${44.733333333333334}
    ${{ close: 68, open: 92, high: 94.82774764949542, low: 65.17225235050458, volume: 338 }}    | ${47.8}
    ${{ close: 9, open: 68, high: 69.94866467256739, low: 7.051335327432617, volume: 823 }}     | ${39.48888888888889}
  `('should return $expected when candle close to $candle.close', ({ candle, expected }) => {
    wma.onNewCandle(candle);
    expect(wma.getResult()).toEqual(approximately(expected, 12));
  });
  const wma2 = new WMA({ period: 5 });
  it.each`
    candle                | expected
    ${{ close: 25.0 }}    | ${null}
    ${{ close: 24.875 }}  | ${null}
    ${{ close: 24.7813 }} | ${null}
    ${{ close: 24.5938 }} | ${null}
    ${{ close: 24.5 }}    | ${24.664606666666668}
    ${{ close: 24.625 }}  | ${24.622933333333332}
    ${{ close: 25.2188 }} | ${24.804193333333334}
    ${{ close: 27.25 }}   | ${25.6396}
  `('should return $expected when candle close to $candle.close', ({ candle, expected }) => {
    wma2.onNewCandle(candle);
    expect(wma2.getResult()).toEqual(approximately(expected, 12));
  });

  // The WMA used to drop src and average the close
  const wmaHl2 = new WMA({ period: 3, src: 'hl2' });
  it.each`
    candle                                                                                     | expected
    ${{ close: 81, open: 81, high: 82.96289647361662, low: 79.03710352638338, volume: 403 }}   | ${null}
    ${{ close: 24, open: 81, high: 83.85720988022568, low: 21.142790119774318, volume: 814 }}  | ${null}
    ${{ close: 75, open: 24, high: 76.94326596315126, low: 22.056734036848734, volume: 1064 }} | ${55.75}
    ${{ close: 21, open: 75, high: 79.67167346434113, low: 16.328326535658874, volume: 330 }}  | ${49.25}
    ${{ close: 34, open: 21, high: 34.711649023641215, low: 20.28835097635878, volume: 964 }}  | ${38}
    ${{ close: 25, open: 34, high: 36.18138133787512, low: 22.818618662124877, volume: 214 }}  | ${31.916666666666668}
    ${{ close: 72, open: 25, high: 73.33035016836122, low: 23.669649831638775, volume: 860 }}  | ${38.666666666666664}
    ${{ close: 92, open: 72, high: 94.97523624952838, low: 69.02476375047162, volume: 486 }}   | ${62.083333333333336}
    ${{ close: 99, open: 92, high: 101.5127586628106, low: 89.4872413371894, volume: 647 }}    | ${83.16666666666667}
    ${{ close: 2, open: 99, high: 99.0804764241746, low: 1.9195235758253941, volume: 396 }}    | ${70.75}
    ${{ close: 86, open: 2, high: 86.08306699694582, low: 1.916933003054178, volume: 252 }}    | ${54.75}
    ${{ close: 80, open: 86, high: 87.6552826540483, low: 78.3447173459517, volume: 299 }}     | ${64.58333333333333}
  `('should return $expected with src hl2 when candle high to $candle.high and low to $candle.low', ({ candle, expected }) => {
    wmaHl2.onNewCandle(candle);
    expect(wmaHl2.getResult()).toEqual(approximately(expected, 12));
  });

  // Each candle used to sum the whole window again, O(period). The sums now slide in O(1) and are summed afresh every period candles:
  // without that, their rounding errors would pile up, to 6e-9 of the price by the end of this year at period 14. At each period, a
  // candle in the middle of the year, and the last one before a fresh sum near its end, where the slid sums have drifted for longest
  it.each`
    period  | candles
    ${14}   | ${262_143}
    ${14}   | ${525_587}
    ${200}  | ${262_143}
    ${200}  | ${525_599}
    ${1000} | ${262_143}
    ${1000} | ${524_999}
  `(
    'should stay within 1e-12 of the full sum at candle $candles of a year of 1-minute candles with period $period',
    ({ period, candles }) => {
      const wma = new WMA({ period });
      for (const close of yearOfCloses.slice(0, candles)) wma.onNewCandle(toCandle(close));
      expect(Math.abs((wma.getResult() ?? NaN) / fullSum(yearOfCloses.slice(candles - period, candles)) - 1)).toBeLessThan(1e-12);
    },
  );

  // A window of one price, as an illiquid pair or gap-filled minutes make, keeps the average the full sum gives it, candle after candle:
  // sliding the sums would move it by an ulp now and then, a slope on a market that did not move, and leave EFI's force of 0 off 0
  it.each`
    window                   | period | move                                                            | price
    ${'a move'}              | ${5}   | ${[30003.69, 29987.83, 29982.57, 29995.42, 30009.75, 30007.35]} | ${30011.81}
    ${'a move'}              | ${3}   | ${[30019.78, 29989.57, 30010.28, 29986.13]}                     | ${29992.93}
    ${'forces, as EFI sees'} | ${3}   | ${[-83.1402, 1.0714, 1.82984, 50.68496, 29.16452]}              | ${0}
  `('should hold the full sum of a window flat at $price after $window, on every candle it stays flat', ({ period, move, price }) => {
    const wma = new WMA({ period });
    const results = [...move, ...Array(3 * period).fill(price)].map(close => {
      wma.onNewCandle(toCandle(close));
      return wma.getResult();
    });
    // The window is flat from candle move.length + period on
    expect(results.slice(move.length + period - 1)).toEqual(Array(2 * period + 1).fill(fullSum(Array(period).fill(price))));
  });

  // A price that is not a number, or infinite, counts until it leaves the window and no longer: it cannot be taken back out of a sum,
  // so the sums are made afresh while it is in them
  const wmaNonFinite = new WMA({ period: 3 });
  it.each`
    close       | expected
    ${1}        | ${null}
    ${2}        | ${null}
    ${3}        | ${14 / 6}
    ${NaN}      | ${NaN}
    ${5}        | ${NaN}
    ${6}        | ${NaN}
    ${7}        | ${38 / 6}
    ${8}        | ${44 / 6}
    ${9}        | ${50 / 6}
    ${Infinity} | ${Infinity}
    ${11}       | ${Infinity}
    ${12}       | ${Infinity}
    ${13}       | ${74 / 6}
    ${14}       | ${80 / 6}
  `('should return $expected on candle %$, closing at $close', ({ close, expected }) => {
    wmaNonFinite.onNewCandle(toCandle(close));
    expect(wmaNonFinite.getResult()).toBe(expected);
  });
});
