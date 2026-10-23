import { approximately } from '../../indicator.mock';
import { describe, expect, it } from 'vitest';
import { MinusDM } from './minusDM.indicator';

describe('MinusDM', () => {
  const minusDM = new MinusDM({ period: 9 });
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
    ${{ close: 99, open: 92, high: 101.5127586628106, low: 89.4872413371894, volume: 647 }}     | ${63.62272090779892}
    ${{ close: 2, open: 99, high: 99.0804764241746, low: 1.9195235758253941, volume: 396 }}     | ${144.12124745718526}
    ${{ close: 86, open: 2, high: 86.08306699694582, low: 1.916933003054178, volume: 252 }}     | ${128.11036609026922}
    ${{ close: 80, open: 86, high: 87.6552826540483, low: 78.3447173459517, volume: 299 }}      | ${113.87588096912819}
    ${{ close: 76, open: 80, high: 80.75068906338092, low: 75.24931093661908, volume: 469 }}    | ${104.31841171522434}
    ${{ close: 8, open: 76, high: 77.2154050332975, low: 6.784594966702496, volume: 605 }}      | ${161.192193050116}
    ${{ close: 87, open: 8, high: 90.4594244098795, low: 4.540575590120497, volume: 261 }}      | ${143.2819493778809}
    ${{ close: 75, open: 87, high: 91.6843769949034, low: 70.3156230050966, volume: 926 }}      | ${127.36173278033858}
    ${{ close: 32, open: 75, high: 77.42509022428217, low: 29.57490977571783, volume: 544 }}    | ${153.95114236745752}
    ${{ close: 65, open: 32, high: 66.96254158787707, low: 30.037458412122934, volume: 819 }}   | ${136.84545988218446}
    ${{ close: 41, open: 65, high: 69.41431179251751, low: 36.58568820748249, volume: 1012 }}   | ${121.64040878416397}
    ${{ close: 9, open: 41, high: 43.081607806555546, low: 6.918392193444454, volume: 736 }}    | ${137.79210382218378}
    ${{ close: 13, open: 9, high: 15.19184083967761, low: 6.808159160322391, volume: 971 }}     | ${122.59210309728542}
    ${{ close: 26, open: 13, high: 28.498919258834377, low: 10.501080741165623, volume: 1098 }} | ${108.97075830869815}
    ${{ close: 56, open: 26, high: 59.7249059948739, low: 22.2750940051261, volume: 379 }}      | ${96.86289627439835}
    ${{ close: 28, open: 56, high: 58.44863123776439, low: 25.551368762235615, volume: 117 }}   | ${86.10035224390964}
    ${{ close: 65, open: 28, high: 66.775319062114, low: 26.224680937886014, volume: 1041 }}    | ${76.53364643903079}
    ${{ close: 58, open: 65, high: 68.65939501847261, low: 54.340604981527385, volume: 510 }}   | ${68.02990794580515}
    ${{ close: 17, open: 58, high: 60.01918882495998, low: 14.980811175040019, volume: 878 }}   | ${99.8308230916475}
    ${{ close: 90, open: 17, high: 93.37632122668938, low: 13.623678773310617, volume: 150 }}   | ${88.73850941479778}
    ${{ close: 87, open: 90, high: 91.79876207396401, low: 85.20123792603599, volume: 914 }}    | ${78.8786750353758}
    ${{ close: 86, open: 87, high: 90.67917429835809, low: 82.32082570164191, volume: 582 }}    | ${72.99479003361701}
    ${{ close: 99, open: 86, high: 103.90666224637769, low: 81.09333775362231, volume: 804 }}   | ${64.88425780765957}
    ${{ close: 3, open: 99, high: 100.63598126886475, low: 1.3640187311352432, volume: 436 }}   | ${137.4042148515178}
    ${{ close: 70, open: 3, high: 74.01339408473842, low: -1.0133940847384295, volume: 747 }}   | ${124.5144926838895}
    ${{ close: 1, open: 70, high: 70.62974231530183, low: 0.37025768469818, volume: 722 }}      | ${110.67954905234622}
    ${{ close: 27, open: 1, high: 30.879348918826008, low: -2.879348918826009, volume: 221 }}   | ${101.6314279833875}
    ${{ close: 9, open: 27, high: 29.207668220474442, low: 6.792331779525556, volume: 148 }}    | ${90.33904709634444}
    ${{ close: 92, open: 9, high: 96.46225023362183, low: 4.5377497663781705, volume: 331 }}    | ${80.30137519675061}
    ${{ close: 68, open: 92, high: 94.82774764949542, low: 65.17225235050458, volume: 338 }}    | ${71.37900017488943}
    ${{ close: 9, open: 68, high: 69.94866467256739, low: 7.051335327432617, volume: 823 }}     | ${121.56891717852923}
  `('should return $expected when candle close to $candle.close', ({ candle, expected }) => {
    minusDM.onNewCandle(candle);
    expect(minusDM.getResult()).toEqual(approximately(expected, 12));
  });

  // With period 1, −DM is each candle's own downward move, from the second candle on, as TA-Lib computes it. The first candle, which
  // has no previous one to move from, used to give a made-up 0
  const minusDM1 = new MinusDM({ period: 1 });
  it.each`
    move                       | candle                                 | expected
    ${'the first candle'}      | ${{ high: 10, low: 8, close: 9 }}      | ${null}
    ${'a move up by 1'}        | ${{ high: 11, low: 9, close: 10 }}     | ${0}
    ${'a move down by 2'}      | ${{ high: 10.5, low: 7, close: 8 }}    | ${2}
    ${'a move up by 1.5'}      | ${{ high: 12, low: 9, close: 11 }}     | ${0}
    ${'an inside candle'}      | ${{ high: 11.5, low: 9.5, close: 10 }} | ${0}
    ${'the same candle again'} | ${{ high: 11.5, low: 9.5, close: 10 }} | ${0}
    ${'a move down by 1.5'}    | ${{ high: 11, low: 8, close: 9 }}      | ${1.5}
  `('should return $expected with period 1 for $move', ({ candle, expected }) => {
    minusDM1.onNewCandle(candle);
    expect(minusDM1.getResult()).toBe(expected);
  });
});
