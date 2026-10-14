import { debug } from '@services/logger';
import { copyPayload } from './event.utils';

type Listener<T = unknown> = (payload: T) => Promise<void> | void;

/**
 * Payloads queued in a row under one event name, which its listeners receive together, as one array. `isCopied`: each was copied as
 * it was queued. One queued while nobody listened to its event is the emitter's own object (see addDeferredEmit).
 */
type DeferredGroup = { name: string; payloads: unknown[]; isCopied: boolean };

const NO_LISTENERS: readonly Listener[] = [];

export class SequentialEventEmitter {
  /**
   * The listeners of each event. An array stored here is never changed, on stores a new one: an emit or a delivery goes through the
   * listeners its event had when it started, whatever they add meanwhile, without copying them each time. on pushed into the array
   * stored, which emit walked as it grew: a listener added by a listener was called by the emit that added it.
   */
  private listeners: Map<string, readonly Listener[]>;
  /**
   * The deferred events in the order they were queued. Only payloads queued in a row under one name are grouped: listeners depend on
   * the order across events too (a cancelation must follow the creation of its order, a fill between two errors makes them not
   * consecutive).
   */
  private readonly deferredGroups: DeferredGroup[];
  public readonly emitterName: string;

  constructor(emitterName: string) {
    this.listeners = new Map();
    this.deferredGroups = [];
    this.emitterName = emitterName;
  }

  public on<T = unknown>(event: string, listener: Listener<T>): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? NO_LISTENERS), listener as Listener]);
  }

  /**
   * Calls the listeners of the event at once, one after the other, each awaited, with the payload itself: unlike a deferred event, it
   * is not copied, so the listeners share it with each other and with the emitter (the report of the PortfolioAnalyzer holds its own
   * equity curve). It serves the final reports, sent from processFinalize once the run is over, and the error line of a strategy, a new
   * object, each with one listener among the plugins: a copy would protect nothing, and would walk a curve of a point per timeframe
   * candle.
   */
  public async emit<T = unknown>(event: string, payload?: T): Promise<void> {
    for (const listener of this.listeners.get(event) ?? NO_LISTENERS) await listener(payload);
  }

  /**
   * Queues a copy of the payload, made now: what the emitter changes in its own object afterwards never reaches the listeners, nor what
   * they change in theirs the emitter (the Trader queues the portfolio it sizes its orders from). The copy throws on what structuredClone
   * refuses, a function or a symbol (see copyPayload).
   * An event nobody listens to gets no copy, which a backtest at 1m made every minute for the equity point of the PortfolioAnalyzer:
   * its payload is queued as it is, grouped as any other, so that the payloads queued under another event on either side of it still
   * reach their listeners apart. A listener added before its delivery gets a copy made then, which shows what the emitter changed
   * meanwhile: in a run none is added, the pipeline wiring every listener before the stream starts.
   */
  public addDeferredEmit<T = unknown>(name: string, payload: T): void {
    debug('event', `[${this.emitterName}] Adding deferred event: ${name}`);
    const isListened = !!this.listeners.get(name)?.length;
    const queued = isListened ? copyPayload(payload) : payload;
    const lastGroup = this.deferredGroups.at(-1);
    if (lastGroup?.name === name) {
      lastGroup.payloads.push(queued);
      lastGroup.isCopied &&= isListened;
    } else this.deferredGroups.push({ name, payloads: [queued], isCopied: isListened });
  }

  /**
   * Delivers the oldest group of deferred events to each listener in turn, each with its own copy of the array and its payloads.
   * Resolves to false when none is queued, to true otherwise.
   */
  public async broadcastDeferredEmit(): Promise<boolean> {
    // Out of the queue before its delivery: a payload a listener queues meanwhile joins a later group, not the array being delivered
    const group = this.deferredGroups.shift();
    if (!group) return false;
    const { name, payloads, isCopied } = group;
    debug('event', `[${this.emitterName}] Broadcasting deferred event: ${name} (${payloads.length} payloads)`);
    // The listeners all got the copy made when the payloads were queued: one that wrote to it changed what the next ones received, and
    // what the others kept (the analyzers keep the latest portfolio). The last listener gets that copy, which nothing else holds any
    // more, and only the others a new one: none for a single listener, as the timeframe candle has in a backtest (its analyzer). The
    // listeners are those of the event when the delivery starts: one added meanwhile would have shared the copy of the last. A group
    // holding a payload queued while nobody listened holds the emitter's own object: every listener gets a copy then, the last included.
    const listeners = this.listeners.get(name) ?? NO_LISTENERS;
    const newCopies = isCopied ? listeners.length - 1 : listeners.length;
    for (let index = 0; index < listeners.length; index++) {
      // One after the other, to avoid race conditions
      await listeners[index](index < newCopies ? copyPayload(payloads) : payloads);
    }
    return true;
  }

  /**
   * Whether a group of deferred events is queued, which a broadcast would deliver. Synchronous: the stream skips the broadcast of a
   * plugin with nothing queued, an awaited call per plugin and bucket otherwise, most of them with nothing to deliver.
   */
  public hasDeferredEvents(): boolean {
    return this.deferredGroups.length > 0;
  }

  /**
   * How many deferred payloads are still queued, per event name, in the order the names were first queued: what never arrives if no
   * broadcast follows. Only the events listened to are counted, nothing is lost with the others. It leaves the queue as it is.
   */
  public countUndeliveredPayloads(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const { name, payloads } of this.deferredGroups) {
      if (this.listeners.get(name)?.length) counts.set(name, (counts.get(name) ?? 0) + payloads.length);
    }
    return counts;
  }
}
