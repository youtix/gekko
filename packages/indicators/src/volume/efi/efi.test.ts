import { approximately } from '../../indicator.mock';
import { describe, expect, it } from 'vitest';
import { EFI } from './efi.indicator';

describe('EFI', () => {
  // Forces of up to 5e4, hence 9 digits (see approximately): with 13, every value from 256 on had to match to the last bit
  const efi = new EFI();
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
    ${{ close: 8, open: 76, high: 77.2154050332975, low: 6.784594966702496, volume: 605 }}      | ${{ fi: -41140, smoothed: -517.9230769230769 }}
    ${{ close: 87, open: 8, high: 90.4594244098795, low: 4.540575590120497, volume: 261 }}      | ${{ fi: 20619, smoothed: 2501.6373626373625 }}
    ${{ close: 75, open: 87, high: 91.6843769949034, low: 70.3156230050966, volume: 926 }}      | ${{ fi: -11112, smoothed: 556.8320251177392 }}
    ${{ close: 32, open: 75, high: 77.42509022428217, low: 29.57490977571783, volume: 544 }}    | ${{ fi: -23392, smoothed: -2864.429692756223 }}
    ${{ close: 65, open: 32, high: 66.96254158787707, low: 30.037458412122934, volume: 819 }}   | ${{ fi: 27027, smoothed: 1405.774549066094 }}
    ${{ close: 41, open: 65, high: 69.41431179251751, low: 36.58568820748249, volume: 1012 }}   | ${{ fi: -24288, smoothed: -2264.764672229062 }}
    ${{ close: 9, open: 41, high: 43.081607806555546, low: 6.918392193444454, volume: 736 }}    | ${{ fi: -23552, smoothed: -5305.798290482053 }}
    ${{ close: 13, open: 9, high: 15.19184083967761, low: 6.808159160322391, volume: 971 }}     | ${{ fi: 3884, smoothed: -3992.9699632703314 }}
    ${{ close: 26, open: 13, high: 28.498919258834377, low: 10.501080741165623, volume: 1098 }} | ${{ fi: 14274, smoothed: -1383.4028256602842 }}
    ${{ close: 56, open: 26, high: 59.7249059948739, low: 22.2750940051261, volume: 379 }}      | ${{ fi: 11370, smoothed: 438.5118637197561 }}
    ${{ close: 28, open: 56, high: 58.44863123776439, low: 25.551368762235615, volume: 117 }}   | ${{ fi: -3276, smoothed: -92.13268824020906 }}
    ${{ close: 65, open: 28, high: 66.775319062114, low: 26.224680937886014, volume: 1041 }}    | ${{ fi: 38517, smoothed: 5423.457695794106 }}
    ${{ close: 58, open: 65, high: 68.65939501847261, low: 54.340604981527385, volume: 510 }}   | ${{ fi: -3570, smoothed: 4138.678024966377 }}
    ${{ close: 17, open: 58, high: 60.01918882495998, low: 14.980811175040019, volume: 878 }}   | ${{ fi: -35998, smoothed: -1595.133121457391 }}
    ${{ close: 90, open: 17, high: 93.37632122668938, low: 13.623678773310617, volume: 150 }}   | ${{ fi: 10950, smoothed: 197.02875303652172 }}
    ${{ close: 87, open: 90, high: 91.79876207396401, low: 85.20123792603599, volume: 914 }}    | ${{ fi: -2742, smoothed: -222.83249739726705 }}
    ${{ close: 86, open: 87, high: 90.67917429835809, low: 82.32082570164191, volume: 582 }}    | ${{ fi: -582, smoothed: -274.14214062622887 }}
    ${{ close: 99, open: 86, high: 103.90666224637769, low: 81.09333775362231, volume: 804 }}   | ${{ fi: 10452, smoothed: 1258.1638794632322 }}
    ${{ close: 3, open: 99, high: 100.63598126886475, low: 1.3640187311352432, volume: 436 }}   | ${{ fi: -41856, smoothed: -4901.002389031515 }}
    ${{ close: 70, open: 3, high: 74.01339408473842, low: -1.0133940847384295, volume: 747 }}   | ${{ fi: 50049, smoothed: 2948.997952258701 }}
    ${{ close: 1, open: 70, high: 70.62974231530183, low: 0.37025768469818, volume: 722 }}      | ${{ fi: -49818, smoothed: -4589.144612349684 }}
    ${{ close: 27, open: 1, high: 30.879348918826008, low: -2.879348918826009, volume: 221 }}   | ${{ fi: 5746, smoothed: -3112.695382014015 }}
    ${{ close: 9, open: 27, high: 29.207668220474442, low: 6.792331779525556, volume: 148 }}    | ${{ fi: -2664, smoothed: -3048.5960417262986 }}
    ${{ close: 92, open: 9, high: 96.46225023362183, low: 4.5377497663781705, volume: 331 }}    | ${{ fi: 27473, smoothed: 1311.6319642346007 }}
    ${{ close: 68, open: 92, high: 94.82774764949542, low: 65.17225235050458, volume: 338 }}    | ${{ fi: -8112, smoothed: -34.601173513199456 }}
    ${{ close: 9, open: 68, high: 69.94866467256739, low: 7.051335327432617, volume: 823 }}     | ${{ fi: -48557, smoothed: -6966.372434439885 }}
  `('should return $expected when candle close to $candle.close', ({ candle, expected }) => {
    efi.onNewCandle(candle);
    expect(efi.getResult()).toEqual(approximately(expected, 9));
  });

  // The force is the change of the src price times the volume. With a src, smoothed used to be NaN forever and fi took the close
  const efiHigh = new EFI({ src: 'high' });
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
    ${{ close: 8, open: 76, high: 77.2154050332975, low: 6.784594966702496, volume: 605 }}      | ${{ fi: -2138.8468382004676, smoothed: -861.7897266796826 }}
    ${{ close: 87, open: 8, high: 90.4594244098795, low: 4.540575590120497, volume: 261 }}      | ${{ fi: 3456.689057287903, smoothed: -244.8641861128848 }}
    ${{ close: 75, open: 87, high: 91.6843769949034, low: 70.3156230050966, volume: 926 }}      | ${{ fi: 1134.306093732131, smoothed: -47.839860420739655 }}
    ${{ close: 32, open: 75, high: 77.42509022428217, low: 29.57490977571783, volume: 544 }}    | ${{ fi: -7757.052003217949, smoothed: -1149.1558808203408 }}
    ${{ close: 65, open: 32, high: 66.96254158787707, low: 30.037458412122934, volume: 819 }}   | ${{ fi: -8568.827333215779, smoothed: -2209.108945448261 }}
    ${{ close: 41, open: 65, high: 69.41431179251751, low: 36.58568820748249, volume: 1012 }}   | ${{ fi: 2481.1914470961246, smoothed: -1539.0660322276344 }}
    ${{ close: 9, open: 41, high: 43.081607806555546, low: 6.918392193444454, volume: 736 }}    | ${{ fi: -19380.870133668006, smoothed: -4087.895189576259 }}
    ${{ close: 13, open: 9, high: 15.19184083967761, low: 6.808159160322391, volume: 971 }}     | ${{ fi: -27080.963724838475, smoothed: -7372.619266042289 }}
    ${{ close: 26, open: 13, high: 28.498919258834377, low: 10.501080741165623, volume: 1098 }} | ${{ fi: 14611.17210423413, smoothed: -4232.077641717087 }}
    ${{ close: 56, open: 26, high: 59.7249059948739, low: 22.2750940051261, volume: 379 }}      | ${{ fi: 11834.64897295898, smoothed: -1936.8309824776493 }}
    ${{ close: 28, open: 56, high: 58.44863123776439, low: 25.551368762235615, volume: 117 }}   | ${{ fi: -149.3241465818129, smoothed: -1681.4728630639584 }}
    ${{ close: 65, open: 28, high: 66.775319062114, low: 26.224680937886014, volume: 1041 }}    | ${{ fi: 8668.082025147938, smoothed: -202.96502189083049 }}
    ${{ close: 58, open: 65, high: 68.65939501847261, low: 54.340604981527385, volume: 510 }}   | ${{ fi: 960.8787377428935, smoothed: -36.70162765744135 }}
    ${{ close: 17, open: 58, high: 60.01918882495998, low: 14.980811175040019, volume: 878 }}   | ${{ fi: -7586.101037904085, smoothed: -1115.1872576926762 }}
    ${{ close: 90, open: 17, high: 93.37632122668938, low: 13.623678773310617, volume: 150 }}   | ${{ fi: 5003.56986025941, smoothed: -241.0790979852353 }}
    ${{ close: 87, open: 90, high: 91.79876207396401, low: 85.20123792603599, volume: 914 }}    | ${{ fi: -1441.889065590989, smoothed: -412.6233790717715 }}
    ${{ close: 86, open: 87, high: 90.67917429835809, low: 82.32082570164191, volume: 582 }}    | ${{ fi: -651.6000854026465, smoothed: -446.7629085476108 }}
    ${{ close: 99, open: 86, high: 103.90666224637769, low: 81.09333775362231, volume: 804 }}   | ${{ fi: 10634.900310207759, smoothed: 1136.3318369888705 }}
    ${{ close: 3, open: 99, high: 100.63598126886475, low: 1.3640187311352432, volume: 436 }}   | ${{ fi: -1426.0169061956412, smoothed: 770.2820165339404 }}
    ${{ close: 70, open: 3, high: 74.01339408473842, low: -1.0133940847384295, volume: 747 }}   | ${{ fi: -19887.07262654237, smoothed: -2180.768646762675 }}
    ${{ close: 1, open: 70, high: 70.62974231530183, low: 0.37025768469818, volume: 722 }}      | ${{ fi: -2442.996577533223, smoothed: -2218.229779729896 }}
    ${{ close: 27, open: 1, high: 30.879348918826008, low: -2.879348918826009, volume: 221 }}   | ${{ fi: -8784.836940621155, smoothed: -3156.3165170000757 }}
    ${{ close: 9, open: 27, high: 29.207668220474442, low: 6.792331779525556, volume: 148 }}    | ${{ fi: -247.40874335603166, smoothed: -2740.758263622355 }}
    ${{ close: 92, open: 9, high: 96.46225023362183, low: 4.5377497663781705, volume: 331 }}    | ${{ fi: 22261.266646351785, smoothed: 830.9595806596649 }}
    ${{ close: 68, open: 92, high: 94.82774764949542, low: 65.17225235050458, volume: 338 }}    | ${{ fi: -552.4618734347262, smoothed: 633.3279443604662 }}
    ${{ close: 9, open: 68, high: 69.94866467256739, low: 7.051335327432617, volume: 823 }}     | ${{ fi: -20475.48529001177, smoothed: -2382.216803406996 }}
  `('should return $expected with src high when candle high to $candle.high', ({ candle, expected }) => {
    efiHigh.onNewCandle(candle);
    expect(efiHigh.getResult()).toEqual(approximately(expected, 9));
  });
});
