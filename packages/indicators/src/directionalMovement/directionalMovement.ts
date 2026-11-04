import { getTrueRange } from '../volatility/trueRange/trueRange.helper';
import { Candle } from '@gekko/shared/models/candle.types';
import { Direction } from './directionalMovement.types';

/**
 * Wilder's directional movement, which +DM, −DM, +DI, −DI and DX read. From the second candle, each candle gives a true range and
 * moves up and down from the previous candle, of which only the larger counts, when it is positive. Each is kept as TA-Lib keeps it,
 * a running sum: the sum of the first period − 1 values, then previous − previous / period + value, period times Wilder's average.
 * DX used to read a +DI and a −DI that each computed the true range and its sum: twice per candle, and 38 times in the default ADX
 * ribbon. It now reads both DIs from one of these.
 */
export class DirectionalMovement {
  private readonly period: number;
  private previous?: Candle;
  /** Candles seen after the first, each a move from the one before */
  private moves = 0;
  private trueRange = 0;
  private readonly dm: Record<Direction, number> = { plus: 0, minus: 0 };

  /** @param period - Candles of the first sums, and the divisor of the running sums: a whole number the indicator has checked */
  constructor(period: number) {
    this.period = period;
  }

  public onNewCandle(candle: Candle): void {
    const previous = this.previous;
    this.previous = candle;
    // The first candle has no previous one to move from. It counted as a move of 0, which ±DM of period 1 published as a made-up first
    // value: as in TA-Lib, the DMs start at the second candle
    if (!previous) return;

    this.moves++;
    const up = candle.high - previous.high;
    const down = previous.low - candle.low;
    this.trueRange = this.accumulate(this.trueRange, getTrueRange(previous, candle));
    this.dm.plus = this.accumulate(this.dm.plus, up > 0 && up > down ? up : 0);
    this.dm.minus = this.accumulate(this.dm.minus, down > 0 && down > up ? down : 0);
  }

  /**
   * +DM or −DM: from candle period, the sum of the moves of candles 2 to period, then the running sum. With period 1, each candle's own
   * move from the second candle, since previous − previous / 1 is 0. Null before.
   */
  public getDM(direction: Direction): number | null {
    return this.moves < Math.max(this.period - 1, 1) ? null : this.dm[direction];
  }

  /** +DI or −DI, the DM as a percentage of the true range: from candle period + 1, as in TA-Lib, and 0 while the true range is 0 */
  public getDI(direction: Direction): number | null {
    if (this.moves < this.period) return null;
    return this.trueRange === 0 ? 0 : (100 * this.dm[direction]) / this.trueRange;
  }

  /** The sum with the value of the latest move: the first sum until candle period, then Wilder's running sum */
  private accumulate(sum: number, value: number): number {
    return this.moves < this.period ? sum + value : sum - sum / this.period + value;
  }
}
