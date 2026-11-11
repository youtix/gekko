import { approximately } from '../../indicator.mock';
import { describe, expect, it } from 'vitest';
import { StochasticRSI } from './stochasticRSI.indicator';

describe('StochasticRSI', () => {
  const sRSI = new StochasticRSI({ period: 9, fastKPeriod: 5, fastDPeriod: 3 });
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
    ${{ close: 75, open: 87, high: 91.6843769949034, low: 70.3156230050966, volume: 926 }}      | ${{ fastK: 85.37853333347987, fastD: 66.44646375349221 }}
    ${{ close: 32, open: 75, high: 77.42509022428217, low: 29.57490977571783, volume: 544 }}    | ${{ fastK: 35.06061725671864, fastD: 73.4797168633995 }}
    ${{ close: 65, open: 32, high: 66.96254158787707, low: 30.037458412122934, volume: 819 }}   | ${{ fastK: 77.94420454637489, fastD: 66.12778504552446 }}
    ${{ close: 41, open: 65, high: 69.41431179251751, low: 36.58568820748249, volume: 1012 }}   | ${{ fastK: 20.61020983610605, fastD: 44.53834387973319 }}
    ${{ close: 9, open: 41, high: 43.081607806555546, low: 6.918392193444454, volume: 736 }}    | ${{ fastK: 0, fastD: 32.85147146082698 }}
    ${{ close: 13, open: 9, high: 15.19184083967761, low: 6.808159160322391, volume: 971 }}     | ${{ fastK: 9.681700495814049, fastD: 10.097303443973361 }}
    ${{ close: 26, open: 13, high: 28.498919258834377, low: 10.501080741165623, volume: 1098 }} | ${{ fastK: 43.008292088392686, fastD: 17.56333086140224 }}
    ${{ close: 56, open: 26, high: 59.7249059948739, low: 22.2750940051261, volume: 379 }}      | ${{ fastK: 100, fastD: 50.89666419473557 }}
    ${{ close: 28, open: 56, high: 58.44863123776439, low: 25.551368762235615, volume: 117 }}   | ${{ fastK: 44.07179812053926, fastD: 62.360030069643976 }}
    ${{ close: 65, open: 28, high: 66.775319062114, low: 26.224680937886014, volume: 1041 }}    | ${{ fastK: 100, fastD: 81.35726604017974 }}
    ${{ close: 58, open: 65, high: 68.65939501847261, low: 54.340604981527385, volume: 510 }}   | ${{ fastK: 81.3906738969407, fastD: 75.15415733915997 }}
    ${{ close: 17, open: 58, high: 60.01918882495998, low: 14.980811175040019, volume: 878 }}   | ${{ fastK: 0, fastD: 60.463557965646885 }}
    ${{ close: 90, open: 17, high: 93.37632122668938, low: 13.623678773310617, volume: 150 }}   | ${{ fastK: 100, fastD: 60.463557965646885 }}
    ${{ close: 87, open: 90, high: 91.79876207396401, low: 85.20123792603599, volume: 914 }}    | ${{ fastK: 95.36561031866142, fastD: 65.12187010622046 }}
    ${{ close: 86, open: 87, high: 90.67917429835809, low: 82.32082570164191, volume: 582 }}    | ${{ fastK: 93.65297718338276, fastD: 96.33952916734803 }}
    ${{ close: 99, open: 86, high: 103.90666224637769, low: 81.09333775362231, volume: 804 }}   | ${{ fastK: 100, fastD: 96.33952916734803 }}
    ${{ close: 3, open: 99, high: 100.63598126886475, low: 1.3640187311352432, volume: 436 }}   | ${{ fastK: 0, fastD: 64.55099239446089 }}
    ${{ close: 70, open: 3, high: 74.01339408473842, low: -1.0133940847384295, volume: 747 }}   | ${{ fastK: 64.50035120723106, fastD: 54.833450402410335 }}
    ${{ close: 1, open: 70, high: 70.62974231530183, low: 0.37025768469818, volume: 722 }}      | ${{ fastK: 11.656018075268253, fastD: 25.38545642749975 }}
    ${{ close: 27, open: 1, high: 30.879348918826008, low: -2.879348918826009, volume: 221 }}   | ${{ fastK: 34.70677697170932, fastD: 36.95438208473619 }}
    ${{ close: 9, open: 27, high: 29.207668220474442, low: 6.792331779525556, volume: 148 }}    | ${{ fastK: 32.573242428987086, fastD: 26.3120124919882 }}
    ${{ close: 92, open: 9, high: 96.46225023362183, low: 4.5377497663781705, volume: 331 }}    | ${{ fastK: 100, fastD: 55.76000646689878 }}
    ${{ close: 68, open: 92, high: 94.82774764949542, low: 65.17225235050458, volume: 338 }}    | ${{ fastK: 73.23365265119345, fastD: 68.60229836006016 }}
    ${{ close: 9, open: 68, high: 69.94866467256739, low: 7.051335327432617, volume: 823 }}     | ${{ fastK: 2.909373289445141, fastD: 58.71434198021284 }}
  `('should return $expected when candle close to $candle.close', ({ candle, expected }) => {
    sRSI.onNewCandle(candle);
    expect(sRSI.getResult()).toEqual(approximately(expected, 12));
  });

  // The Stochastic underneath used to seed its averages on raw %K values taken over partial windows of RSI values, which an ema
  // kept for many candles. Values from a port of TA-Lib's STOCHRSI
  const sRSIEma = new StochasticRSI({ period: 9, fastKPeriod: 5, fastDPeriod: 3, slowMaType: 'ema' });
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
    ${{ close: 75, open: 87, high: 91.6843769949034, low: 70.3156230050966, volume: 926 }}      | ${{ fastK: 85.37853333347987, fastD: 66.44646375349221 }}
    ${{ close: 32, open: 75, high: 77.42509022428217, low: 29.57490977571783, volume: 544 }}    | ${{ fastK: 35.06061725671864, fastD: 50.75354050510543 }}
    ${{ close: 65, open: 32, high: 66.96254158787707, low: 30.037458412122934, volume: 819 }}   | ${{ fastK: 77.94420454637489, fastD: 64.34887252574016 }}
    ${{ close: 41, open: 65, high: 69.41431179251751, low: 36.58568820748249, volume: 1012 }}   | ${{ fastK: 20.61020983610605, fastD: 42.47954118092311 }}
    ${{ close: 9, open: 41, high: 43.081607806555546, low: 6.918392193444454, volume: 736 }}    | ${{ fastK: 0, fastD: 21.239770590461553 }}
    ${{ close: 13, open: 9, high: 15.19184083967761, low: 6.808159160322391, volume: 971 }}     | ${{ fastK: 9.681700495814049, fastD: 15.460735543137801 }}
    ${{ close: 26, open: 13, high: 28.498919258834377, low: 10.501080741165623, volume: 1098 }} | ${{ fastK: 43.008292088392686, fastD: 29.234513815765244 }}
    ${{ close: 56, open: 26, high: 59.7249059948739, low: 22.2750940051261, volume: 379 }}      | ${{ fastK: 100, fastD: 64.61725690788262 }}
    ${{ close: 28, open: 56, high: 58.44863123776439, low: 25.551368762235615, volume: 117 }}   | ${{ fastK: 44.071798120539256, fastD: 54.34452751421094 }}
    ${{ close: 65, open: 28, high: 66.775319062114, low: 26.224680937886014, volume: 1041 }}    | ${{ fastK: 100, fastD: 77.17226375710547 }}
    ${{ close: 58, open: 65, high: 68.65939501847261, low: 54.340604981527385, volume: 510 }}   | ${{ fastK: 81.3906738969407, fastD: 79.28146882702308 }}
    ${{ close: 17, open: 58, high: 60.01918882495998, low: 14.980811175040019, volume: 878 }}   | ${{ fastK: 0, fastD: 39.64073441351154 }}
    ${{ close: 90, open: 17, high: 93.37632122668938, low: 13.623678773310617, volume: 150 }}   | ${{ fastK: 100, fastD: 69.82036720675578 }}
    ${{ close: 87, open: 90, high: 91.79876207396401, low: 85.20123792603599, volume: 914 }}    | ${{ fastK: 95.36561031866142, fastD: 82.5929887627086 }}
    ${{ close: 86, open: 87, high: 90.67917429835809, low: 82.32082570164191, volume: 582 }}    | ${{ fastK: 93.65297718338276, fastD: 88.12298297304568 }}
    ${{ close: 99, open: 86, high: 103.90666224637769, low: 81.09333775362231, volume: 804 }}   | ${{ fastK: 100, fastD: 94.06149148652284 }}
    ${{ close: 3, open: 99, high: 100.63598126886475, low: 1.3640187311352432, volume: 436 }}   | ${{ fastK: 0, fastD: 47.03074574326142 }}
    ${{ close: 70, open: 3, high: 74.01339408473842, low: -1.0133940847384295, volume: 747 }}   | ${{ fastK: 64.50035120723105, fastD: 55.765548475246234 }}
    ${{ close: 1, open: 70, high: 70.62974231530183, low: 0.37025768469818, volume: 722 }}      | ${{ fastK: 11.656018075268253, fastD: 33.71078327525724 }}
    ${{ close: 27, open: 1, high: 30.879348918826008, low: -2.879348918826009, volume: 221 }}   | ${{ fastK: 34.70677697170931, fastD: 34.20878012348328 }}
    ${{ close: 9, open: 27, high: 29.207668220474442, low: 6.792331779525556, volume: 148 }}    | ${{ fastK: 32.573242428987086, fastD: 33.39101127623518 }}
    ${{ close: 92, open: 9, high: 96.46225023362183, low: 4.5377497663781705, volume: 331 }}    | ${{ fastK: 100, fastD: 66.6955056381176 }}
    ${{ close: 68, open: 92, high: 94.82774764949542, low: 65.17225235050458, volume: 338 }}    | ${{ fastK: 73.23365265119345, fastD: 69.96457914465552 }}
    ${{ close: 9, open: 68, high: 69.94866467256739, low: 7.051335327432617, volume: 823 }}     | ${{ fastK: 2.909373289445141, fastD: 36.43697621705033 }}
  `('should return $expected with an ema fastD when candle close to $candle.close', ({ candle, expected }) => {
    sRSIEma.onNewCandle(candle);
    expect(sRSIEma.getResult()).toEqual(approximately(expected, 12));
  });

  // A dema fastD used to come out two candles before TA-Lib's. A dema overshoots its input: fastD tops 100 at the close of 99, as
  // in TA-Lib
  const sRSIDema = new StochasticRSI({ period: 9, fastKPeriod: 5, fastDPeriod: 3, slowMaType: 'dema' });
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
    ${{ close: 65, open: 32, high: 66.96254158787707, low: 30.037458412122934, volume: 819 }}   | ${{ fastK: 77.94420454637489, fastD: 68.1814527900344 }}
    ${{ close: 41, open: 65, high: 69.41431179251751, low: 36.58568820748249, volume: 1012 }}   | ${{ fastK: 20.61020983610605, fastD: 33.4611656406617 }}
    ${{ close: 9, open: 41, high: 43.081607806555546, low: 6.918392193444454, volume: 736 }}    | ${{ fastK: 0, fastD: 6.110697525100072 }}
    ${{ close: 13, open: 9, high: 15.19184083967761, low: 6.808159160322391, volume: 971 }}     | ${{ fastK: 9.681700495814049, fastD: 5.006681486795184 }}
    ${{ close: 26, open: 13, high: 28.498919258834377, low: 10.501080741165623, volume: 1098 }} | ${{ fastK: 43.008292088392686, fastD: 30.894375923907656 }}
    ${{ close: 56, open: 26, high: 59.7249059948739, low: 22.2750940051261, volume: 379 }}      | ${{ fastK: 100, fastD: 83.13855950801252 }}
    ${{ close: 28, open: 56, high: 58.44863123776439, low: 25.551368762235615, volume: 117 }}   | ${{ fastK: 44.071798120539256, fastD: 58.46881411744005 }}
    ${{ close: 65, open: 28, high: 66.775319062114, low: 26.224680937886014, volume: 1041 }}    | ${{ fastK: 100, fastD: 90.64827518016729 }}
    ${{ close: 58, open: 65, high: 68.65939501847261, low: 54.340604981527385, volume: 510 }}   | ${{ fastK: 81.3906738969407, fastD: 87.0740770735128 }}
    ${{ close: 17, open: 58, high: 60.01918882495998, low: 14.980811175040019, volume: 878 }}   | ${{ fastK: 0, fastD: 23.71667133000063 }}
    ${{ close: 90, open: 17, high: 93.37632122668938, low: 13.623678773310617, volume: 150 }}   | ${{ fastK: 100, fastD: 76.94815206162244 }}
    ${{ close: 87, open: 90, high: 91.79876207396401, low: 85.20123792603599, volume: 914 }}    | ${{ fastK: 95.36561031866142, fastD: 92.54319196811835 }}
    ${{ close: 86, open: 87, high: 90.67917429835809, low: 82.32082570164191, volume: 582 }}    | ${{ fastK: 93.65297718338276, fastD: 95.8630816809191 }}
    ${{ close: 99, open: 86, high: 103.90666224637769, low: 81.09333775362231, volume: 804 }}   | ${{ fastK: 100, fastD: 100.90079509719813 }}
    ${{ close: 3, open: 99, high: 100.63598126886475, low: 1.3640187311352432, volume: 436 }}   | ${{ fastK: 0, fastD: 26.935024676968354 }}
    ${{ close: 70, open: 3, high: 74.01339408473842, low: -1.0133940847384295, volume: 747 }}   | ${{ fastK: 64.50035120723105, fastD: 50.08508930809211 }}
    ${{ close: 1, open: 70, high: 70.62974231530183, low: 0.37025768469818, volume: 722 }}      | ${{ fastK: 11.656018075268253, fastD: 19.843171091685683 }}
    ${{ close: 27, open: 1, high: 30.879348918826008, low: -2.879348918826009, volume: 221 }}   | ${{ fastK: 34.70677697170931, fastD: 27.523972455810522 }}
    ${{ close: 9, open: 27, high: 29.207668220474442, low: 6.792331779525556, volume: 148 }}    | ${{ fastK: 32.573242428987086, fastD: 29.63972301877476 }}
    ${{ close: 92, open: 9, high: 96.46225023362183, low: 4.5377497663781705, volume: 331 }}    | ${{ fastK: 100, fastD: 81.47210869032858 }}
    ${{ close: 68, open: 92, high: 94.82774764949542, low: 65.17225235050458, volume: 338 }}    | ${{ fastK: 73.23365265119345, fastD: 78.98741742402997 }}
    ${{ close: 9, open: 68, high: 69.94866467256739, low: 7.051335327432617, volume: 823 }}     | ${{ fastK: 2.909373289445141, fastD: 24.184593892934963 }}
  `('should return $expected with a dema fastD when candle close to $candle.close', ({ candle, expected }) => {
    sRSIDema.onNewCandle(candle);
    expect(sRSIDema.getResult()).toEqual(approximately(expected, 12));
  });

  // Over a flat stretch the RSI holds still in exact arithmetic but wobbles in its last bits: fastK used to read that wobble as a range,
  // 0 or 100 at random (100 on candles 11, 14, 16 and 17 here). The close holds at 102.5 from candle 9, so from candle 11 on the 3 RSI
  // values of fastK's window are equal in exact arithmetic, and fastK is 0. Candles 7 to 10 come from a port of TA-Lib's STOCHRSI
  const sRSIFlat = new StochasticRSI({ period: 3, fastKPeriod: 3, fastDPeriod: 2 });
  it.each`
    close     | expected
    ${100.5}  | ${null}
    ${98.5}   | ${null}
    ${98.5}   | ${null}
    ${100.5}  | ${null}
    ${102.25} | ${null}
    ${101.25} | ${null}
    ${101.75} | ${{ fastK: 43.227250919558664, fastD: 26.945617411489586 }}
    ${102.75} | ${{ fastK: 100, fastD: 71.61362545977933 }}
    ${102.5}  | ${{ fastK: 39.50198001625961, fastD: 69.7509900081298 }}
    ${102.5}  | ${{ fastK: 0, fastD: 19.750990008129893 }}
    ${102.5}  | ${{ fastK: 0, fastD: 0 }}
    ${102.5}  | ${{ fastK: 0, fastD: 0 }}
    ${102.5}  | ${{ fastK: 0, fastD: 0 }}
    ${102.5}  | ${{ fastK: 0, fastD: 0 }}
    ${102.5}  | ${{ fastK: 0, fastD: 0 }}
    ${102.5}  | ${{ fastK: 0, fastD: 0 }}
    ${102.5}  | ${{ fastK: 0, fastD: 0 }}
    ${102.5}  | ${{ fastK: 0, fastD: 0 }}
    ${102.5}  | ${{ fastK: 0, fastD: 0 }}
  `('should return $expected on candle %$, closing at $close', ({ close, expected }) => {
    sRSIFlat.onNewCandle({ start: 0, open: close, high: close, low: close, close, volume: 0 });
    expect(sRSIFlat.getResult()).toEqual(approximately(expected, 12));
  });
});
