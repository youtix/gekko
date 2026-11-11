import { approximately } from '../../indicator.mock';
import { describe, expect, it } from 'vitest';
import { WilderSmoothing } from './wilderSmoothing.indicator';

describe('WilderSmoothing', () => {
  const ws = new WilderSmoothing({ period: 5 });
  it.each`
    candle                | expected
    ${{ close: 62.125 }}  | ${null}
    ${{ close: 61.125 }}  | ${null}
    ${{ close: 62.3438 }} | ${null}
    ${{ close: 65.3125 }} | ${null}
    ${{ close: 63.9688 }} | ${62.97502}
    ${{ close: 63.4375 }} | ${63.067516}
    ${{ close: 63 }}      | ${63.0540128}
    ${{ close: 63.7812 }} | ${63.19945024}
    ${{ close: 63.4062 }} | ${63.240800192}
    ${{ close: 63.4062 }} | ${63.2738801536}
    ${{ close: 62.4375 }} | ${63.10660412288}
    ${{ close: 61.8438 }} | ${62.854043298304}
  `('should return $expected on candle %$, closing at $candle.close', ({ candle, expected }) => {
    ws.onNewCandle(candle);
    expect(ws.getResult()).toEqual(approximately(expected, 12));
  });

  // Wilder's smoothing used to drop src and smooth the close
  const wsHl2 = new WilderSmoothing({ period: 3, src: 'hl2' });
  it.each`
    candle                                                                                     | expected
    ${{ close: 81, open: 81, high: 82.96289647361662, low: 79.03710352638338, volume: 403 }}   | ${null}
    ${{ close: 24, open: 81, high: 83.85720988022568, low: 21.142790119774318, volume: 814 }}  | ${null}
    ${{ close: 75, open: 24, high: 76.94326596315126, low: 22.056734036848734, volume: 1064 }} | ${61}
    ${{ close: 21, open: 75, high: 79.67167346434113, low: 16.328326535658874, volume: 330 }}  | ${56.666666666666664}
    ${{ close: 34, open: 21, high: 34.711649023641215, low: 20.28835097635878, volume: 964 }}  | ${46.944444444444436}
    ${{ close: 25, open: 34, high: 36.18138133787512, low: 22.818618662124877, volume: 214 }}  | ${41.129629629629626}
    ${{ close: 72, open: 25, high: 73.33035016836122, low: 23.669649831638775, volume: 860 }}  | ${43.58641975308641}
    ${{ close: 92, open: 72, high: 94.97523624952838, low: 69.02476375047162, volume: 486 }}   | ${56.3909465020576}
    ${{ close: 99, open: 92, high: 101.5127586628106, low: 89.4872413371894, volume: 647 }}    | ${69.4272976680384}
    ${{ close: 2, open: 99, high: 99.0804764241746, low: 1.9195235758253941, volume: 396 }}    | ${63.118198445358935}
    ${{ close: 86, open: 2, high: 86.08306699694582, low: 1.916933003054178, volume: 252 }}    | ${56.74546563023929}
    ${{ close: 80, open: 86, high: 87.6552826540483, low: 78.3447173459517, volume: 299 }}     | ${65.49697708682619}
  `('should return $expected with src hl2 when candle high to $candle.high and low to $candle.low', ({ candle, expected }) => {
    wsHl2.onNewCandle(candle);
    expect(wsHl2.getResult()).toEqual(approximately(expected, 12));
  });
});
