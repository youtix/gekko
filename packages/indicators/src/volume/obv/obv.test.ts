import { approximately, illiquidCandles, resultsOf } from '../../indicator.mock';
import { Candle } from '@gekko/shared/models/candle.types';
import { describe, expect, it } from 'vitest';
import { OBV } from './obv.indicator';

const candleAt = (close: number, volume: number): Candle => ({ start: 0, open: close, high: close, low: close, close, volume });
// A walk whose OBV ends at 10.68, then five candles closing unchanged
const walkThenStill = [
  [100, 7.34],
  [101, 3.25],
  [100.5, 2.85],
  [102, 5.38],
  [101.5, 8.75],
  [103, 6.31],
  [103, 0.8],
  [103, 1.6],
  [103, 0.35],
  [103, 2.4],
  [103, 0.95],
].map(([close, volume]) => candleAt(close, volume));

describe('OBV', () => {
  // The OBV and its bands reach 3.6e3, hence 10 digits (see approximately): with 13, every value from 256 on had to match to the last bit

  // The OBV starts at the first candle's volume, 403, as TA-Lib's does, so its bands come on candle 5. It used to skip that candle and
  // start at 0 a candle later: every value was 403 lower and the first result came on candle 6
  const obv = new OBV({ period: 5 });
  it.each`
    candle                                                                                      | expected
    ${{ close: 81, open: 81, high: 82.96289647361662, low: 79.03710352638338, volume: 403 }}    | ${null}
    ${{ close: 24, open: 81, high: 83.85720988022568, low: 21.142790119774318, volume: 814 }}   | ${null}
    ${{ close: 75, open: 24, high: 76.94326596315126, low: 22.056734036848734, volume: 1064 }}  | ${null}
    ${{ close: 21, open: 75, high: 79.67167346434113, low: 16.328326535658874, volume: 330 }}   | ${null}
    ${{ close: 34, open: 21, high: 34.711649023641215, low: 20.28835097635878, volume: 964 }}   | ${{ obv: 1287, ma: 451, upper: 1546.9678827410958, lower: -644.9678827410958 }}
    ${{ close: 25, open: 34, high: 36.18138133787512, low: 22.818618662124877, volume: 214 }}   | ${{ obv: 1073, ma: 585, upper: 1783.743342004451, lower: -613.743342004451 }}
    ${{ close: 72, open: 25, high: 73.33035016836122, low: 23.669649831638775, volume: 860 }}   | ${{ obv: 1933, ma: 1053.8, upper: 2157.413265596241, lower: -49.81326559624131 }}
    ${{ close: 92, open: 72, high: 94.97523624952838, low: 69.02476375047162, volume: 486 }}    | ${{ obv: 2419, ma: 1407, upper: 2849.728526092141, lower: -35.728526092140555 }}
    ${{ close: 99, open: 92, high: 101.5127586628106, low: 89.4872413371894, volume: 647 }}     | ${{ obv: 3066, ma: 1955.6, upper: 3418.2680279543956, lower: 492.9319720456044 }}
    ${{ close: 2, open: 99, high: 99.0804764241746, low: 1.9195235758253941, volume: 396 }}     | ${{ obv: 2670, ma: 2232.2, upper: 3604.803599004461, lower: 859.5964009955385 }}
    ${{ close: 86, open: 2, high: 86.08306699694582, low: 1.916933003054178, volume: 252 }}     | ${{ obv: 2922, ma: 2602, upper: 3403.683229212137, lower: 1800.3167707878629 }}
    ${{ close: 80, open: 86, high: 87.6552826540483, low: 78.3447173459517, volume: 299 }}      | ${{ obv: 2623, ma: 2740, upper: 3196.9726468838153, lower: 2283.0273531161847 }}
    ${{ close: 76, open: 80, high: 80.75068906338092, low: 75.24931093661908, volume: 469 }}    | ${{ obv: 2154, ma: 2687, upper: 3311.3973094112434, lower: 2062.6026905887566 }}
    ${{ close: 8, open: 76, high: 77.2154050332975, low: 6.784594966702496, volume: 605 }}      | ${{ obv: 1549, ma: 2383.6, upper: 3354.572790555945, lower: 1412.6272094440544 }}
    ${{ close: 87, open: 8, high: 90.4594244098795, low: 4.540575590120497, volume: 261 }}      | ${{ obv: 1810, ma: 2211.6, upper: 3222.5627886326974, lower: 1200.6372113673024 }}
    ${{ close: 75, open: 87, high: 91.6843769949034, low: 70.3156230050966, volume: 926 }}      | ${{ obv: 884, ma: 1804, upper: 2971.8088884744798, lower: 636.1911115255202 }}
    ${{ close: 32, open: 75, high: 77.42509022428217, low: 29.57490977571783, volume: 544 }}    | ${{ obv: 340, ma: 1347.4, upper: 2654.2555237668776, lower: 40.54447623312262 }}
    ${{ close: 65, open: 32, high: 66.96254158787707, low: 30.037458412122934, volume: 819 }}   | ${{ obv: 1159, ma: 1148.4, upper: 2176.6899202073314, lower: 120.11007979266878 }}
    ${{ close: 41, open: 65, high: 69.41431179251751, low: 36.58568820748249, volume: 1012 }}   | ${{ obv: 147, ma: 868, upper: 2058.269213245474, lower: -322.26921324547425 }}
    ${{ close: 9, open: 41, high: 43.081607806555546, low: 6.918392193444454, volume: 736 }}    | ${{ obv: -589, ma: 388.2, upper: 1606.5171344112337, lower: -830.1171344112336 }}
    ${{ close: 13, open: 9, high: 15.19184083967761, low: 6.808159160322391, volume: 971 }}     | ${{ obv: 382, ma: 287.8, upper: 1404.649425840386, lower: -829.049425840386 }}
    ${{ close: 26, open: 13, high: 28.498919258834377, low: 10.501080741165623, volume: 1098 }} | ${{ obv: 1480, ma: 515.8, upper: 1990.3539800224337, lower: -958.7539800224338 }}
    ${{ close: 56, open: 26, high: 59.7249059948739, low: 22.2750940051261, volume: 379 }}      | ${{ obv: 1859, ma: 655.8, upper: 2446.970968947409, lower: -1135.370968947409 }}
    ${{ close: 28, open: 56, high: 58.44863123776439, low: 25.551368762235615, volume: 117 }}   | ${{ obv: 1742, ma: 974.8, upper: 2855.760350459307, lower: -906.1603504593072 }}
    ${{ close: 65, open: 28, high: 66.775319062114, low: 26.224680937886014, volume: 1041 }}    | ${{ obv: 2783, ma: 1649.2, upper: 3191.290736629982, lower: 107.1092633700182 }}
    ${{ close: 58, open: 65, high: 68.65939501847261, low: 54.340604981527385, volume: 510 }}   | ${{ obv: 2273, ma: 2027.4, upper: 2939.851291850694, lower: 1114.9487081493062 }}
    ${{ close: 17, open: 58, high: 60.01918882495998, low: 14.980811175040019, volume: 878 }}   | ${{ obv: 1395, ma: 2010.4, upper: 2965.197235019038, lower: 1055.602764980962 }}
    ${{ close: 90, open: 17, high: 93.37632122668938, low: 13.623678773310617, volume: 150 }}   | ${{ obv: 1545, ma: 1947.6, upper: 2972.686610974897, lower: 922.5133890251027 }}
    ${{ close: 87, open: 90, high: 91.79876207396401, low: 85.20123792603599, volume: 914 }}    | ${{ obv: 631, ma: 1725.4, upper: 3210.742573280656, lower: 240.05742671934445 }}
    ${{ close: 86, open: 87, high: 90.67917429835809, low: 82.32082570164191, volume: 582 }}    | ${{ obv: 49, ma: 1178.6, upper: 2716.0397419086057, lower: -358.8397419086057 }}
    ${{ close: 99, open: 86, high: 103.90666224637769, low: 81.09333775362231, volume: 804 }}   | ${{ obv: 853, ma: 894.6, upper: 1975.2202663285561, lower: -186.0202663285562 }}
    ${{ close: 3, open: 99, high: 100.63598126886475, low: 1.3640187311352432, volume: 436 }}   | ${{ obv: 417, ma: 699, upper: 1697.4307687566525, lower: -299.43076875665247 }}
    ${{ close: 70, open: 3, high: 74.01339408473842, low: -1.0133940847384295, volume: 747 }}   | ${{ obv: 1164, ma: 622.8, upper: 1380.457864738432, lower: -134.857864738432 }}
    ${{ close: 1, open: 70, high: 70.62974231530183, low: 0.37025768469818, volume: 722 }}      | ${{ obv: 442, ma: 585, upper: 1355.9910505317166, lower: -185.9910505317166 }}
    ${{ close: 27, open: 1, high: 30.879348918826008, low: -2.879348918826009, volume: 221 }}   | ${{ obv: 663, ma: 707.8, upper: 1263.80201438484, lower: 151.79798561515986 }}
    ${{ close: 9, open: 27, high: 29.207668220474442, low: 6.792331779525556, volume: 148 }}    | ${{ obv: 515, ma: 640.2, upper: 1191.3172651986147, lower: 89.08273480138553 }}
    ${{ close: 92, open: 9, high: 96.46225023362183, low: 4.5377497663781705, volume: 331 }}    | ${{ obv: 846, ma: 726, upper: 1243.98841685891, lower: 208.0115831410899 }}
    ${{ close: 68, open: 92, high: 94.82774764949542, low: 65.17225235050458, volume: 338 }}    | ${{ obv: 508, ma: 594.8, upper: 884.631399265159, lower: 304.968600734841 }}
    ${{ close: 9, open: 68, high: 69.94866467256739, low: 7.051335327432617, volume: 823 }}     | ${{ obv: -315, ma: 443.4, upper: 1240.7863304572006, lower: -353.98633045720067 }}
  `('should return $expected when candle close to $candle.close', ({ candle, expected }) => {
    obv.onNewCandle(candle);
    expect(obv.getResult()).toEqual(approximately(expected, 10));
  });

  // OBV hands stdevUp and stdevDown on to its bands, and an OBV that handed them over swapped used to pass this file: every table took
  // 2 and 2. With 1 up and 3 down, the bands are those of a BollingerBands with these multipliers fed the OBV, worked out apart from
  // the classes, and each row from the fifth candle differs from the swapped bands
  const obvOneUpThreeDown = new OBV({ period: 5, stdevUp: 1, stdevDown: 3 });
  it.each`
    candle                                                                                     | expected
    ${{ close: 81, open: 81, high: 82.96289647361662, low: 79.03710352638338, volume: 403 }}   | ${null}
    ${{ close: 24, open: 81, high: 83.85720988022568, low: 21.142790119774318, volume: 814 }}  | ${null}
    ${{ close: 75, open: 24, high: 76.94326596315126, low: 22.056734036848734, volume: 1064 }} | ${null}
    ${{ close: 21, open: 75, high: 79.67167346434113, low: 16.328326535658874, volume: 330 }}  | ${null}
    ${{ close: 34, open: 21, high: 34.711649023641215, low: 20.28835097635878, volume: 964 }}  | ${{ obv: 1287, ma: 451, upper: 998.9839413705479, lower: -1192.9518241116436 }}
    ${{ close: 25, open: 34, high: 36.18138133787512, low: 22.818618662124877, volume: 214 }}  | ${{ obv: 1073, ma: 585, upper: 1184.3716710022254, lower: -1213.1150130066767 }}
    ${{ close: 72, open: 25, high: 73.33035016836122, low: 23.669649831638775, volume: 860 }}  | ${{ obv: 1933, ma: 1053.8, upper: 1605.6066327981207, lower: -601.619898394362 }}
    ${{ close: 92, open: 72, high: 94.97523624952838, low: 69.02476375047162, volume: 486 }}   | ${{ obv: 2419, ma: 1407, upper: 2128.3642630460704, lower: -757.0927891382107 }}
    ${{ close: 99, open: 92, high: 101.5127586628106, low: 89.4872413371894, volume: 647 }}    | ${{ obv: 3066, ma: 1955.6, upper: 2686.9340139771975, lower: -238.40204193159343 }}
    ${{ close: 2, open: 99, high: 99.0804764241746, low: 1.9195235758253941, volume: 396 }}    | ${{ obv: 2670, ma: 2232.2, upper: 2918.5017995022304, lower: 173.2946014933077 }}
    ${{ close: 86, open: 2, high: 86.08306699694582, low: 1.916933003054178, volume: 252 }}    | ${{ obv: 2922, ma: 2602, upper: 3002.8416146060686, lower: 1399.4751561817943 }}
    ${{ close: 80, open: 86, high: 87.6552826540483, low: 78.3447173459517, volume: 299 }}     | ${{ obv: 2623, ma: 2740, upper: 2968.4863234419076, lower: 2054.5410296742775 }}
  `('should return $expected with 1 deviation up and 3 down when candle close to $candle.close', ({ candle, expected }) => {
    obvOneUpThreeDown.onNewCandle(candle);
    expect(obvOneUpThreeDown.getResult()).toEqual(approximately(expected, 10));
  });

  // Bands the OBV used to miss. A middle of exactly 0 read as not ready, so a flat start, a made-up first candle (volume 0) or a window
  // summing to 0 got no bands, or the previous candle's. Unchanged closes after a walk got bands a few ulps wide, around a middle a few
  // ulps off the OBV, which then lay outside them
  it.each`
    window                                 | period | candles                                                    | expected
    ${'a flat start'}                      | ${5}   | ${Array(8).fill(candleAt(100, 10))}                        | ${{ obv: 10, ma: 10, upper: 10, lower: 10 }}
    ${'a made-up first candle, then flat'} | ${5}   | ${[candleAt(100, 0), ...Array(7).fill(candleAt(100, 10))]} | ${{ obv: 0, ma: 0, upper: 0, lower: 0 }}
    ${'a window summing to 0'}             | ${2}   | ${[candleAt(10, 5), candleAt(9, 10)]}                      | ${{ obv: -5, ma: 0, upper: 10, lower: -10 }}
    ${'unchanged closes after a walk'}     | ${5}   | ${walkThenStill}                                           | ${{ obv: 10.68, ma: 10.68, upper: 10.68, lower: 10.68 }}
  `('should return $expected for $window', ({ period, candles, expected }) => {
    const obv = new OBV({ period });
    for (const candle of candles) obv.onNewCandle(candle);
    expect(obv.getResult()).toEqual(expected);
  });

  // On an illiquid market, with period 2: its made-up first candle starts the OBV at 0, and no candle without volume moves it. Neither
  // does the ninth, which trades a volume of 3 but closes unchanged: as in TA-Lib, an unchanged close counts for neither side. The bands
  // of a window that holds one OBV are that OBV
  it('should move the OBV only when the close changes, on an illiquid market', () => {
    expect(resultsOf(new OBV({ period: 2 }), illiquidCandles)).toEqual([
      null,
      { obv: 0, ma: 0, upper: 0, lower: 0 },
      { obv: 0, ma: 0, upper: 0, lower: 0 },
      { obv: 4, ma: 2, upper: 6, lower: -2 },
      { obv: -2, ma: 1, upper: 7, lower: -5 },
      { obv: -1, ma: -1.5, upper: -0.5, lower: -2.5 },
      { obv: -1, ma: -1, upper: -1, lower: -1 },
      { obv: -1, ma: -1, upper: -1, lower: -1 },
      { obv: -1, ma: -1, upper: -1, lower: -1 },
      { obv: -3, ma: -2, upper: 0, lower: -4 },
      { obv: 2, ma: -0.5, upper: 4.5, lower: -5.5 },
    ]);
  });
});
