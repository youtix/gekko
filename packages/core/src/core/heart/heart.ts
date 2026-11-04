import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { debug } from '../../logger/logger';
import EventEmitter from 'node:events';
import { HeartOptions } from './heart.types';

/**
 * Emits 'tick' once right after pump(), then once per tick rate, `gracePeriod` ms after each multiple of the tick rate in epoch
 * time: with a tick rate of a minute, every tick fires just after a minute boundary. Each tick is a timeout armed by the previous
 * one on the next boundary, so that a late timer never shifts the ticks after it (an interval keeps every delay and drifts).
 *
 * Emits 'error' with a GekkoError instead of a tick when a tick comes more than three tick rates after the previous one (the
 * machine slept or the event loop was blocked); without an 'error' listener, the EventEmitter throws it from the timer.
 */
export class Heart extends EventEmitter {
  private lastTick: number;
  private readonly tickRate: number;
  private readonly gracePeriod: number;
  private timeout?: Timer;
  private nextTickAt?: number;

  constructor(tickRate: number, { gracePeriod = 0 }: HeartOptions = {}) {
    super();
    this.tickRate = tickRate;
    this.gracePeriod = gracePeriod;
    this.lastTick = 0;
  }

  public tick() {
    const currentTime = Date.now();
    const isLate = this.lastTick && this.lastTick < currentTime - this.tickRate * 3;
    // Updated before emitting: the next tick, if any, is measured from this one rather than failing again
    this.lastTick = currentTime;
    // see https://github.com/askmike/gekko/issues/514 for details
    if (isLate) this.emit('error', new GekkoError('core', 'Failed to tick in time'));
    else this.emit('tick');
  }

  public pump() {
    if (this.isHeartBeating()) return;
    debug('core', 'Starting heartbeat ticks');
    this.timeout = setTimeout(this.beat, 0);
  }

  public stop() {
    debug('core', 'Stopping heartbeat ticks');
    clearTimeout(this.timeout);
    this.timeout = undefined;
    this.nextTickAt = undefined;
  }

  public isHeartBeating() {
    return !!this.timeout;
  }

  /** The first boundary (plus the grace period) strictly after `time` */
  private getNextTickTime(time: number) {
    return time - ((time - this.gracePeriod) % this.tickRate) + this.tickRate;
  }

  private readonly beat = () => {
    const now = Date.now();
    // A timer may fire a little early: wait for the boundary rather than tick twice around it
    if (this.nextTickAt !== undefined && now < this.nextTickAt) {
      this.timeout = setTimeout(this.beat, this.nextTickAt - now);
      return;
    }
    // Armed before ticking, so that a listener that throws does not stop the heart
    this.nextTickAt = this.getNextTickTime(now);
    this.timeout = setTimeout(this.beat, this.nextTickAt - now);
    this.tick();
  };
}
