import { approximately } from '../../indicator.mock';
import { Candle } from '@gekko/shared/models/candle.types';
import { describe, expect, it } from 'vitest';
import { BollingerBands } from './bollingerBands.indicator';

const flat = (price: number): Candle => ({ start: 0, open: price, high: price, low: price, close: price, volume: 0 });
// A move closing at 30000.11
const move = [30000.4, 30010.2, 29995.6, 30001.15, 30000.11].map(flat);

describe('BollingerBands', () => {
  const bbands = new BollingerBands();
  it.each`
    candle                                                                                      | expected
    ${{ close: 81, open: 81, high: 82.96289647361662, low: 79.03710352638338, volume: 403 }}    | ${null}
    ${{ close: 24, open: 81, high: 83.85720988022568, low: 21.142790119774318, volume: 814 }}   | ${null}
    ${{ close: 75, open: 24, high: 76.94326596315126, low: 22.056734036848734, volume: 1064 }}  | ${null}
    ${{ close: 21, open: 75, high: 79.67167346434113, low: 16.328326535658874, volume: 330 }}   | ${null}
    ${{ close: 34, open: 21, high: 34.711649023641215, low: 20.28835097635878, volume: 964 }}   | ${{ upper: 98.48980481609928, middle: 47, lower: -4.48980481609928 }}
    ${{ close: 25, open: 34, high: 36.18138133787512, low: 22.818618662124877, volume: 214 }}   | ${{ upper: 75.94772720839873, middle: 35.8, lower: -4.347727208398737 }}
    ${{ close: 72, open: 25, high: 73.33035016836122, low: 23.669649831638775, volume: 860 }}   | ${{ upper: 92.09218350002493, middle: 45.4, lower: -1.292183500024926 }}
    ${{ close: 92, open: 72, high: 94.97523624952838, low: 69.02476375047162, volume: 486 }}    | ${{ upper: 105.1048843351978, middle: 48.8, lower: -7.504884335197794 }}
    ${{ close: 99, open: 92, high: 101.5127586628106, low: 89.4872413371894, volume: 647 }}     | ${{ upper: 124.35464952778891, middle: 64.4, lower: 4.4453504722111035 }}
    ${{ close: 2, open: 99, high: 99.0804764241746, low: 1.9195235758253941, volume: 396 }}     | ${{ upper: 134.19973753235638, middle: 58, lower: -18.19973753235638 }}
    ${{ close: 86, open: 2, high: 86.08306699694582, low: 1.916933003054178, volume: 252 }}     | ${{ upper: 140.6772303655585, middle: 70.2, lower: -0.2772303655584949 }}
    ${{ close: 80, open: 86, high: 87.6552826540483, low: 78.3447173459517, volume: 299 }}      | ${{ upper: 142.72982447461715, middle: 71.8, lower: 0.8701755253828338 }}
    ${{ close: 76, open: 80, high: 80.75068906338092, low: 75.24931093661908, volume: 469 }}    | ${{ upper: 136.99415179677277, middle: 68.6, lower: 0.2058482032271769 }}
    ${{ close: 8, open: 76, high: 77.2154050332975, low: 6.784594966702496, volume: 605 }}      | ${{ upper: 124.90744929200034, middle: 50.4, lower: -24.107449292000332 }}
    ${{ close: 87, open: 8, high: 90.4594244098795, low: 4.540575590120497, volume: 261 }}      | ${{ upper: 127.34130462377338, middle: 67.4, lower: 7.458695376226629 }}
    ${{ close: 75, open: 87, high: 91.6843769949034, low: 70.3156230050966, volume: 926 }}      | ${{ upper: 123.01902800981699, middle: 65.2, lower: 7.380971990183021 }}
    ${{ close: 32, open: 75, high: 77.42509022428217, low: 29.57490977571783, volume: 544 }}    | ${{ upper: 116.27091560212355, middle: 55.6, lower: -5.070915602123549 }}
    ${{ close: 65, open: 32, high: 66.96254158787707, low: 30.037458412122934, volume: 819 }}   | ${{ upper: 111.70403073544745, middle: 53.4, lower: -4.904030735447449 }}
    ${{ close: 41, open: 65, high: 69.41431179251751, low: 36.58568820748249, volume: 1012 }}   | ${{ upper: 101.22135368956242, middle: 60, lower: 18.778646310437587 }}
    ${{ close: 9, open: 41, high: 43.081607806555546, low: 6.918392193444454, volume: 736 }}    | ${{ upper: 91.5525184905324, middle: 44.4, lower: -2.7525184905324025 }}
    ${{ close: 13, open: 9, high: 15.19184083967761, low: 6.808159160322391, volume: 971 }}     | ${{ upper: 72.59556626036888, middle: 32, lower: -8.595566260368876 }}
    ${{ close: 26, open: 13, high: 28.498919258834377, low: 10.501080741165623, volume: 1098 }} | ${{ upper: 71.6783561313319, middle: 30.8, lower: -10.078356131331898 }}
    ${{ close: 56, open: 26, high: 59.7249059948739, low: 22.2750940051261, volume: 379 }}      | ${{ upper: 64.07705802942999, middle: 29, lower: -6.077058029429999 }}
    ${{ close: 28, open: 56, high: 58.44863123776439, low: 25.551368762235615, volume: 117 }}   | ${{ upper: 59.39939393382855, middle: 26.4, lower: -6.599393933828551 }}
    ${{ close: 65, open: 28, high: 66.775319062114, low: 26.224680937886014, volume: 1041 }}    | ${{ upper: 76.80408142017868, middle: 37.6, lower: -1.6040814201786802 }}
    ${{ close: 58, open: 65, high: 68.65939501847261, low: 54.340604981527385, volume: 510 }}   | ${{ upper: 79.18465896706608, middle: 46.6, lower: 14.015341032933918 }}
    ${{ close: 17, open: 58, high: 60.01918882495998, low: 14.980811175040019, volume: 878 }}   | ${{ upper: 82.35316231690749, middle: 44.8, lower: 7.246837683092508 }}
    ${{ close: 90, open: 17, high: 93.37632122668938, low: 13.623678773310617, volume: 150 }}   | ${{ upper: 104.12961069720583, middle: 51.6, lower: -0.929610697205824 }}
    ${{ close: 87, open: 90, high: 91.79876207396401, low: 85.20123792603599, volume: 914 }}    | ${{ upper: 115.9296106972058, middle: 63.4, lower: 10.870389302794194 }}
    ${{ close: 86, open: 87, high: 90.67917429835809, low: 82.32082570164191, volume: 582 }}    | ${{ upper: 123.23595959449251, middle: 67.6, lower: 11.964040405507475 }}
    ${{ close: 99, open: 86, high: 103.90666224637769, low: 81.09333775362231, volume: 804 }}   | ${{ upper: 135.30999915980505, middle: 75.8, lower: 16.290000840194907 }}
    ${{ close: 3, open: 99, high: 100.63598126886475, low: 1.3640187311352432, volume: 436 }}   | ${{ upper: 143.59745037889115, middle: 73, lower: 2.4025496211088324 }}
    ${{ close: 70, open: 3, high: 74.01339408473842, low: -1.0133940847384295, volume: 747 }}   | ${{ upper: 137.52736679604726, middle: 69, lower: 0.4726332039527392 }}
    ${{ close: 1, open: 70, high: 70.62974231530183, low: 0.37025768469818, volume: 722 }}      | ${{ upper: 135.18249216712104, middle: 51.8, lower: -31.582492167121032 }}
    ${{ close: 27, open: 1, high: 30.879348918826008, low: -2.879348918826009, volume: 221 }}   | ${{ upper: 117.14920608794364, middle: 40, lower: -37.14920608794364 }}
    ${{ close: 9, open: 27, high: 29.207668220474442, low: 6.792331779525556, volume: 148 }}    | ${{ upper: 73.38093031466052, middle: 22, lower: -29.380930314660517 }}
    ${{ close: 92, open: 9, high: 96.46225023362183, low: 4.5377497663781705, volume: 331 }}    | ${{ upper: 110.53782580769641, middle: 39.8, lower: -30.937825807696413 }}
    ${{ close: 68, open: 92, high: 94.82774764949542, low: 65.17225235050458, volume: 338 }}    | ${{ upper: 109.46967960537569, middle: 39.4, lower: -30.669679605375684 }}
    ${{ close: 9, open: 68, high: 69.94866467256739, low: 7.051335327432617, volume: 823 }}     | ${{ upper: 107.77724163216088, middle: 41, lower: -25.77724163216088 }}
  `('should return $expected when candle close to $candle.close', ({ candle, expected }) => {
    bbands.onNewCandle(candle);
    expect(bbands.getResult()).toEqual(approximately(expected, 12));
  });

  // A middle of another kind than the sma, or multipliers other than 2, had no table on a window that moves. The deviation stays that
  // of the closes around their simple mean, as in TA-Lib, and the bands are stdevUp and stdevDown of it from the ema middle. From the
  // sixth candle, every row differs from an sma middle's, from a deviation around the middle and from swapped multipliers
  const bbandsEma = new BollingerBands({ maType: 'ema', stdevUp: 1, stdevDown: 3 });
  it.each`
    candle                                                                                     | expected
    ${{ close: 81, open: 81, high: 82.96289647361662, low: 79.03710352638338, volume: 403 }}   | ${null}
    ${{ close: 24, open: 81, high: 83.85720988022568, low: 21.142790119774318, volume: 814 }}  | ${null}
    ${{ close: 75, open: 24, high: 76.94326596315126, low: 22.056734036848734, volume: 1064 }} | ${null}
    ${{ close: 21, open: 75, high: 79.67167346434113, low: 16.328326535658874, volume: 330 }}  | ${null}
    ${{ close: 34, open: 21, high: 34.711649023641215, low: 20.28835097635878, volume: 964 }}  | ${{ upper: 72.74490240804964, middle: 47, lower: -30.234707224148906 }}
    ${{ close: 25, open: 34, high: 36.18138133787512, low: 22.818618662124877, volume: 214 }}  | ${{ upper: 59.74053027086603, middle: 39.666666666666664, lower: -20.554924145931437 }}
    ${{ close: 72, open: 25, high: 73.33035016836122, low: 23.669649831638775, volume: 860 }}  | ${{ upper: 73.7905361944569, middle: 50.44444444444444, lower: -19.593830805592944 }}
    ${{ close: 92, open: 72, high: 94.97523624952838, low: 69.02476375047162, volume: 486 }}   | ${{ upper: 92.44873846389518, middle: 64.29629629629629, lower: -20.16103020650037 }}
    ${{ close: 99, open: 92, high: 101.5127586628106, low: 89.4872413371894, volume: 647 }}    | ${{ upper: 105.84152229475865, middle: 75.86419753086419, lower: -14.067776760819186 }}
    ${{ close: 2, open: 99, high: 99.0804764241746, low: 1.9195235758253941, volume: 396 }}    | ${{ upper: 89.34266712008764, middle: 51.242798353909464, lower: -63.05680794462508 }}
    ${{ close: 86, open: 2, high: 86.08306699694582, low: 1.916933003054178, volume: 252 }}    | ${{ upper: 98.06714741871889, middle: 62.82853223593964, lower: -42.8873133123981 }}
    ${{ close: 80, open: 86, high: 87.6552826540483, low: 78.3447173459517, volume: 299 }}     | ${{ upper: 104.01726706126834, middle: 68.55235482395976, lower: -37.842381887965985 }}
  `('should return $expected with an ema middle, 1 deviation up and 3 down, when candle close to $candle.close', ({ candle, expected }) => {
    bbandsEma.onNewCandle(candle);
    expect(bbandsEma.getResult()).toEqual(approximately(expected, 12));
  });

  // A middle of exactly 0 used to read as not ready: no bands on the second candle, and the previous candle's on the fourth, fifth and
  // last. A close is never 0 or negative, but the OBV that OBV feeds to its bands is
  const bbandsAroundZero = new BollingerBands({ period: 2 });
  it.each`
    close | expected
    ${5}  | ${null}
    ${-5} | ${{ upper: 10, middle: 0, lower: -10 }}
    ${1}  | ${{ upper: 4, middle: -2, lower: -8 }}
    ${-1} | ${{ upper: 2, middle: 0, lower: -2 }}
    ${1}  | ${{ upper: 2, middle: 0, lower: -2 }}
    ${0}  | ${{ upper: 1.5, middle: 0.5, lower: -0.5 }}
    ${0}  | ${{ upper: 0, middle: 0, lower: 0 }}
  `('should return $expected on candle %$, closing at $close', ({ close, expected }) => {
    bbandsAroundZero.onNewCandle(flat(close));
    expect(bbandsAroundZero.getResult()).toEqual(expected);
  });

  // On a flat window, its closes equal within the tolerance, the three bands are the close. The deviation used to come out as a few ulps
  // rather than 0, around a middle itself a few ulps off the close, so the close lay a few ulps outside the bands in most flat windows
  it.each`
    window                                   | parameters            | candles
    ${'a move, then 5 flat at 30000.11'}     | ${{}}                 | ${[...move, ...Array(5).fill(flat(30000.11))]}
    ${'a move to 30000.06, then 5 flat'}     | ${{}}                 | ${[...move, ...Array(5).fill(flat(30000.11)), ...Array(6).fill(flat(30000.06))]}
    ${'5 flat at 30000.11 from the start'}   | ${{}}                 | ${Array(5).fill(flat(30000.11))}
    ${'5 flat at 0.007 from the start'}      | ${{}}                 | ${Array(5).fill(flat(0.007))}
    ${'4 flat at 30000, one 3.3e-10 above'}  | ${{}}                 | ${[...Array(4).fill(flat(30000)), flat(30000.00001)]}
    ${'a move, then 20 flat'}                | ${{ period: 20 }}     | ${[...move, ...Array(20).fill(flat(30000.11))]}
    ${'a move, then 5 flat, under a wma'}    | ${{ maType: 'wma' }}  | ${[...move, ...Array(5).fill(flat(30000.11))]}
    ${'a move, then 100 flat, under an ema'} | ${{ maType: 'ema' }}  | ${[...move, ...Array(100).fill(flat(30000.11))]}
    ${'a move, then 100 flat, under a dema'} | ${{ maType: 'dema' }} | ${[...move, ...Array(100).fill(flat(30000.11))]}
  `('should put the three bands on the close after $window', ({ parameters, candles }) => {
    const bbands = new BollingerBands(parameters);
    for (const candle of candles) bbands.onNewCandle(candle);
    const { close } = candles[candles.length - 1];
    expect(bbands.getResult()).toEqual({ upper: close, middle: close, lower: close });
  });

  // A middle that is off the close by more than the tolerance stays where it is, as an ema's or a dema's is just after a move: the window
  // is flat, so the bands are that middle, and the close is off them
  it.each`
    maType    | closes              | middle
    ${'ema'}  | ${[10, 20, 20]}     | ${55 / 3}
    ${'dema'} | ${[10, 20, 20, 20]} | ${550 / 27}
  `('should put the three bands on the $maType middle $middle, off the close of $closes', ({ maType, closes, middle }) => {
    const bbands = new BollingerBands({ period: 2, maType });
    for (const close of closes) bbands.onNewCandle(flat(close));
    expect(bbands.getResult()).toEqual(approximately({ upper: middle, middle, lower: middle }, 12));
  });

  // A window that moved, however little, keeps its deviation: a tick on 30000 or on 0.05, or 1e-8 of the price, is beyond the tolerance.
  // Prices of 30000, hence 9 digits (see approximately)
  it.each`
    move                 | candles                                                                             | expected
    ${'a tick on 30000'} | ${[...Array(2).fill(flat(30000)), flat(30000.01), ...Array(2).fill(flat(30000))]}   | ${{ upper: 30000.01, middle: 30000.002, lower: 29999.994 }}
    ${'1e-8 of 30000'}   | ${[...Array(2).fill(flat(30000)), flat(30000.0003), ...Array(2).fill(flat(30000))]} | ${{ upper: 30000.0003, middle: 30000.00006, lower: 29999.99982 }}
    ${'a tick on 0.05'}  | ${[...Array(2).fill(flat(0.05)), flat(0.050001), ...Array(2).fill(flat(0.05))]}     | ${{ upper: 0.050001, middle: 0.0500002, lower: 0.0499994 }}
  `('should keep the deviation of a window that moved by $move', ({ candles, expected }) => {
    const bbands = new BollingerBands();
    for (const candle of candles) bbands.onNewCandle(candle);
    expect(bbands.getResult()).toEqual(approximately(expected, 9));
  });
});
