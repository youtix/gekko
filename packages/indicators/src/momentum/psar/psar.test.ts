import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { approximately } from '../../indicator.mock';
import { describe, expect, it } from 'vitest';
import { PSAR } from './psar.indicator';

describe('PSAR', () => {
  const psar = new PSAR();
  it.each`
    candle                                                                                      | expected
    ${{ close: 81, open: 81, high: 82.96289647361662, low: 79.03710352638338, volume: 403 }}    | ${null}
    ${{ close: 24, open: 81, high: 83.85720988022568, low: 21.142790119774318, volume: 814 }}   | ${21.142790119774318}
    ${{ close: 75, open: 24, high: 76.94326596315126, low: 22.056734036848734, volume: 1064 }}  | ${21.142790119774318}
    ${{ close: 21, open: 75, high: 79.67167346434113, low: 16.328326535658874, volume: 330 }}   | ${83.85720988022568}
    ${{ close: 34, open: 21, high: 34.711649023641215, low: 20.28835097635878, volume: 964 }}   | ${82.50663221333434}
    ${{ close: 25, open: 34, high: 36.18138133787512, low: 22.818618662124877, volume: 214 }}   | ${81.18306609978083}
    ${{ close: 72, open: 25, high: 73.33035016836122, low: 23.669649831638775, volume: 860 }}   | ${79.88597130849838}
    ${{ close: 92, open: 72, high: 94.97523624952838, low: 69.02476375047162, volume: 486 }}    | ${16.328326535658874}
    ${{ close: 99, open: 92, high: 101.5127586628106, low: 89.4872413371894, volume: 647 }}     | ${17.901264729936265}
    ${{ close: 2, open: 99, high: 99.0804764241746, low: 1.9195235758253941, volume: 396 }}     | ${101.5127586628106}
    ${{ close: 86, open: 2, high: 86.08306699694582, low: 1.916933003054178, volume: 252 }}     | ${101.5127586628106}
    ${{ close: 80, open: 86, high: 87.6552826540483, low: 78.3447173459517, volume: 299 }}      | ${99.0804764241746}
    ${{ close: 76, open: 80, high: 80.75068906338092, low: 75.24931093661908, volume: 469 }}    | ${95.19393468732979}
    ${{ close: 8, open: 76, high: 77.2154050332975, low: 6.784594966702496, volume: 605 }}      | ${91.46285461995876}
    ${{ close: 87, open: 8, high: 90.4594244098795, low: 4.540575590120497, volume: 261 }}      | ${1.916933003054178}
    ${{ close: 75, open: 87, high: 91.6843769949034, low: 70.3156230050966, volume: 926 }}      | ${3.6877828311906846}
    ${{ close: 32, open: 75, high: 77.42509022428217, low: 29.57490977571783, volume: 544 }}    | ${4.540575590120497}
    ${{ close: 65, open: 32, high: 66.96254158787707, low: 30.037458412122934, volume: 819 }}   | ${8.026327646311813}
    ${{ close: 41, open: 65, high: 69.41431179251751, low: 36.58568820748249, volume: 1012 }}   | ${11.372649620255476}
    ${{ close: 9, open: 41, high: 43.081607806555546, low: 6.918392193444454, volume: 736 }}    | ${91.6843769949034}
    ${{ close: 13, open: 9, high: 15.19184083967761, low: 6.808159160322391, volume: 971 }}     | ${89.98905729887422}
    ${{ close: 26, open: 13, high: 28.498919258834377, low: 10.501080741165623, volume: 1098 }} | ${86.66182137333215}
    ${{ close: 56, open: 26, high: 59.7249059948739, low: 22.2750940051261, volume: 379 }}      | ${83.46767488481176}
    ${{ close: 28, open: 56, high: 58.44863123776439, low: 25.551368762235615, volume: 117 }}   | ${80.40129425583218}
    ${{ close: 65, open: 28, high: 66.775319062114, low: 26.224680937886014, volume: 1041 }}    | ${77.45756885201179}
    ${{ close: 58, open: 65, high: 68.65939501847261, low: 54.340604981527385, volume: 510 }}   | ${74.63159246434421}
    ${{ close: 17, open: 58, high: 60.01918882495998, low: 14.980811175040019, volume: 878 }}   | ${71.91865513218333}
    ${{ close: 90, open: 17, high: 93.37632122668938, low: 13.623678773310617, volume: 150 }}   | ${6.808159160322391}
    ${{ close: 87, open: 90, high: 91.79876207396401, low: 85.20123792603599, volume: 914 }}    | ${8.53952240164973}
    ${{ close: 86, open: 87, high: 90.67917429835809, low: 82.32082570164191, volume: 582 }}    | ${10.236258378150524}
    ${{ close: 99, open: 86, high: 103.90666224637769, low: 81.09333775362231, volume: 804 }}   | ${11.8990596351213}
    ${{ close: 3, open: 99, high: 100.63598126886475, low: 1.3640187311352432, volume: 436 }}   | ${103.90666224637769}
    ${{ close: 70, open: 3, high: 74.01339408473842, low: -1.0133940847384295, volume: 747 }}   | ${103.90666224637769}
    ${{ close: 1, open: 70, high: 70.62974231530183, low: 0.37025768469818, volume: 722 }}      | ${100.63598126886475}
    ${{ close: 27, open: 1, high: 30.879348918826008, low: -2.879348918826009, volume: 221 }}   | ${96.57000625472062}
    ${{ close: 9, open: 27, high: 29.207668220474442, low: 6.792331779525556, volume: 148 }}    | ${90.60304494430783}
    ${{ close: 92, open: 9, high: 96.46225023362183, low: 4.5377497663781705, volume: 331 }}    | ${-2.879348918826009}
    ${{ close: 68, open: 92, high: 94.82774764949542, low: 65.17225235050458, volume: 338 }}    | ${-0.8925169357770523}
    ${{ close: 9, open: 68, high: 69.94866467256739, low: 7.051335327432617, volume: 823 }}     | ${1.0545784076109253}
  `('should return $expected when candle close to $candle.close', ({ candle, expected }) => {
    psar.onNewCandle(candle);
    expect(psar.getResult()).toEqual(approximately(expected, 12));
  });

  // An acceleration equal to its maximum keeps the factor fixed, as TA-Lib does with an acceleration above it. By hand with 0.25, which
  // keeps every value exact: from the first low, each SAR closes a quarter of its gap to the extreme point, and the gap down reverses
  // it to the highest high, 118, where the next SAR stays, as it may not go below the last two highs. A factor raised past its maximum
  // at a new high or a new low would close more of the gap
  const fixedFactor = new PSAR({ acceleration: 0.25, maxAcceleration: 0.25 });
  it.each`
    move                              | candle                     | expected
    ${'the first candle'}             | ${{ high: 102, low: 100 }} | ${null}
    ${'a move up, which starts long'} | ${{ high: 106, low: 104 }} | ${100}
    ${'a new high'}                   | ${{ high: 110, low: 108 }} | ${101.5}
    ${'a second new high'}            | ${{ high: 114, low: 112 }} | ${103.625}
    ${'a third new high'}             | ${{ high: 118, low: 116 }} | ${106.21875}
    ${'a gap down through the SAR'}   | ${{ high: 105, low: 100 }} | ${118}
    ${'a new low'}                    | ${{ high: 98, low: 96 }}   | ${118}
    ${'a second new low'}             | ${{ high: 94, low: 92 }}   | ${112.5}
    ${'a third new low'}              | ${{ high: 90, low: 88 }}   | ${107.375}
  `('should return $expected with a fixed factor of 0.25 for $move', ({ candle, expected }) => {
    fixedFactor.onNewCandle(candle);
    expect(fixedFactor.getResult()).toBe(expected);
  });

  // As in TA-Lib, the SAR starts short only when the second candle's −DM is positive: its low fell, and by more than its high rose.
  // Long, it starts at the first low (8), and short at the first high (10). A second low already below that first low reverses a long
  // start at once, to the highest high
  it.each`
    move                            | high   | low    | start      | expected
    ${'up'}                         | ${11}  | ${9}   | ${'long'}  | ${8}
    ${'down'}                       | ${9.5} | ${7}   | ${'short'} | ${10}
    ${'as far down as up'}          | ${11}  | ${7}   | ${'long'}  | ${11}
    ${'down, but further up'}       | ${12}  | ${7.5} | ${'long'}  | ${12}
    ${'inside the first'}           | ${9.5} | ${8.5} | ${'long'}  | ${8}
    ${'lower, without a lower low'} | ${8.6} | ${8.5} | ${'long'}  | ${8}
  `('should start $start and return $expected when the second candle moves $move', ({ high, low, expected }) => {
    const psar = new PSAR();
    psar.onNewCandle({ start: 0, open: 9, high: 10, low: 8, close: 9, volume: 1 });
    psar.onNewCandle({ start: 1, open: 9, high, low, close: low, volume: 1 });

    expect(psar.getResult()).toBe(expected);
  });

  // By hand with a factor rising from 1/16 to 1/4, which keeps every value exact. Each row is the SAR its candle is tested against, set
  // on the candle before, so a change of factor shows on the next row. A high or a low only equal to the extreme point leaves the factor
  // as it is; the third new extreme takes it to 1/4 and the fourth keeps it there. A SAR that would pass the last low stops on it, and a
  // low on the SAR reverses it, as a high on it does in a fall; each reversal brings the factor back to 1/16. The 39 candles above take
  // the factor no higher than 0.06, and none of them equals an extreme point or lands on a SAR
  const steppedFactor = new PSAR({ acceleration: 0.0625, maxAcceleration: 0.25 });
  it.each`
    move                                                 | candle                     | expected
    ${'the first candle'}                                | ${{ high: 10, low: 8 }}    | ${null}
    ${'a move up, which starts long'}                    | ${{ high: 11, low: 9 }}    | ${8}
    ${'the same high again'}                             | ${{ high: 11, low: 10 }}   | ${8.1875}
    ${'a new high'}                                      | ${{ high: 12, low: 11 }}   | ${8.36328125}
    ${'a second new high'}                               | ${{ high: 13, low: 12 }}   | ${8.81787109375}
    ${'a third new high, which takes the factor to 1/4'} | ${{ high: 14, low: 13 }}   | ${9.602020263671875}
    ${'a fourth new high, which holds it there'}         | ${{ high: 15, low: 14 }}   | ${10.70151519775390625}
    ${'a lower high, whose low stops the SAR'}           | ${{ high: 14.5, low: 12 }} | ${11.7761363983154296875}
    ${'a low on the SAR, which reverses it'}             | ${{ high: 13, low: 12 }}   | ${15}
    ${'a new low'}                                       | ${{ high: 12.5, low: 11 }} | ${14.8125}
    ${'the same low again'}                              | ${{ high: 12, low: 11 }}   | ${14.3359375}
    ${'a second new low'}                                | ${{ high: 11.5, low: 10 }} | ${13.9189453125}
    ${'a third new low, which takes the factor to 1/4'}  | ${{ high: 11, low: 9 }}    | ${13.18414306640625}
    ${'a fourth new low, which holds it there'}          | ${{ high: 10, low: 8 }}    | ${12.1381072998046875}
    ${'a fifth new low, whose high stops the SAR'}       | ${{ high: 11, low: 7.5 }}  | ${11.103580474853515625}
    ${'a high on the SAR, which reverses it'}            | ${{ high: 11, low: 9 }}    | ${7.5}
    ${'a new high after the reversal'}                   | ${{ high: 12, low: 10 }}   | ${7.5}
    ${'a second new high after it'}                      | ${{ high: 13, low: 11 }}   | ${8.0625}
  `('should return $expected with a factor rising from 1/16 to 1/4 for $move', ({ candle, expected }) => {
    steppedFactor.onNewCandle(candle);
    expect(steppedFactor.getResult()).toBe(expected);
  });

  // Such a pair used to restart the factor above its maximum after every reversal
  it('should refuse an acceleration above maxAcceleration', () => {
    expect(() => new PSAR({ acceleration: 0.3, maxAcceleration: 0.2 })).toThrow(
      new GekkoError(
        'strategy',
        'Indicator PSAR: acceleration must be at most maxAcceleration, got acceleration 0.3 and maxAcceleration 0.2 (the factor would restart above its maximum after every reversal)',
      ),
    );
  });
});
