import { ApplicationStopError } from '@errors/applicationStop.error';
import { describeError, toError } from '@errors/error.helper';
import { GekkoError } from '@errors/gekko.error';
import { CandleBucket } from '@models/event.types';
import { Nullable } from '@models/utility.types';
import { Plugin } from '@plugins/plugin';
import { isDummyExchange } from '@services/exchange/exchange.helper';
import { DummyExchange } from '@services/exchange/exchange.types';
import { inject } from '@services/injecter/injecter';
import { info, error as logError, warning } from '@services/logger';
import { partition } from 'lodash-es';
import { Writable } from 'node:stream';
import { collectFailures, describeReason, isRejected } from './plugins.helper';
import { PluginFailure } from './plugins.types';

export class PluginsStream extends Writable {
  private readonly plugins: Plugin[];
  /** Only these are finalised: all the plugins, unless _construct failed or the stream was destroyed part way */
  private readonly initializedPlugins: Plugin[] = [];
  private readonly dummyExchange?: DummyExchange;
  /** The bucket being processed. _destroy waits for it, so that no plugin is finalised in the middle of a bucket. */
  private pendingWrite?: Promise<void>;
  /**
   * Started by whichever of _final, a failed bucket and _destroy comes first; the others wait for the same promise. It resolves to the
   * error that names the plugins whose finalisation failed, if any (see finalizePlugins).
   */
  private finalization?: Promise<GekkoError | undefined>;
  /** The error a bucket failed with. The stream reports it even when a stream upstream fails while the plugins are finalised. */
  private caughtError?: Error;
  /** The plugins that failed on that bucket besides the one whose failure is the error: logged after it */
  private otherFailures: PluginFailure[] = [];

  constructor(plugins: Plugin[]) {
    super({ objectMode: true });
    this.plugins = plugins;
    const exchange = inject.exchange();
    if (isDummyExchange(exchange)) this.dummyExchange = exchange;
  }

  /**
   * The error a bucket failed with, if any. pipeline() rejects with the first error of the chain, so when a stream upstream
   * fails while the plugins are finalised after a failed bucket, it rejects with the upstream error, not this one: the
   * caller has to prefer this one to tell an ApplicationStopError from a crash.
   */
  public get failure(): Error | undefined {
    return this.caughtError;
  }

  public async _construct(callback: (error?: Error | null) => void): Promise<void> {
    try {
      for (const plugin of this.plugins) {
        // Destroyed meanwhile (a stream upstream failed): the plugins left would be finalised as soon as initialised
        if (this.destroyed) break;
        await plugin.processInitStream();
        this.initializedPlugins.push(plugin);
      }
      callback();
    } catch (error) {
      // Not a template literal for a value that is not an Error: String() throws for one without a prototype, and the pipeline waited
      // for a callback never called
      if (error instanceof Error) callback(error);
      else callback(new Error(`Error when initializing stream plugin: ${describeError(error)}`));
    }
  }

  public _write(bucket: CandleBucket, _: BufferEncoding, done: (error?: Nullable<Error>) => void) {
    this.pendingWrite = this.processBucket(bucket).then(
      () => done(),
      (reason: unknown) => this.stopOnError(reason),
    );
  }

  public async _final(done: (error?: Nullable<Error>) => void) {
    // Only reached after every bucket succeeded: a failed bucket destroys the stream, which then never calls _final
    try {
      // A failed finalisation fails a run that otherwise ended normally. It was only logged as a warning, hidden at the default level:
      // an import whose last insert failed exited with code 0, its last minutes missing from the database, and a backtest of its range
      // stopped later on missing candles, without a word on why.
      const finalizationFailure = await this.finalizeAllPlugins();
      if (finalizationFailure) {
        done(finalizationFailure);
        return;
      }
      info('stream', 'Gekko is closing the application !');
      done();
    } catch (error) {
      done(toError(error));
    }
  }

  /**
   * Runs on every teardown. _final and a failed bucket finalise the plugins before it, but stream/promises destroys this
   * stream without calling _final when a stream upstream fails, or _construct does: the plugins are finalised here then,
   * once the bucket in progress, if any, is done.
   */
  public async _destroy(error: Nullable<Error>, callback: (error?: Nullable<Error>) => void) {
    // A failure upstream or of _construct. Not once the finalisation has started: a failed bucket has said why already, and the error
    // _final fails with is the finalisation's own.
    if (error && !this.finalization) this.logCloseReason(error);
    // A failure upstream destroys the stream at once, whatever the bucket in progress is doing: its handlers run to their end (an
    // order being created, deferred events being delivered) before the plugins are finalised, not under them
    await this.pendingWrite; // Never rejects: a failed bucket is handled by stopOnError
    // Counted once that bucket is done: what is left waits for a bucket that never comes. A failed bucket has named them already.
    if (error && !this.finalization) this.logDroppedEvents();
    try {
      const finalizationFailure = await this.finalizeAllPlugins(this.caughtError ?? error ?? undefined);
      // The run failed or was stopped, and its own error stays the one reported: a failed finalisation is logged besides it. Unless it
      // is that error: _final failed the run with it, and the stream is destroyed with it.
      if (finalizationFailure && finalizationFailure !== error) logError('stream', describeError(finalizationFailure));
    } catch (finalizeError) {
      warning('stream', `Finalization errors: ${describeError(finalizeError)}`);
    }
    // The error of a failed bucket, or else the one the stream was destroyed with: a finalisation failure only when _final failed with it
    callback(this.caughtError ?? error);
  }

  private async processBucket(bucket: CandleBucket) {
    // Forward bucket to dummy exchange (if set by user) before all plugins
    await this.dummyExchange?.processOneMinuteBucket(bucket);

    // Forward bucket to all plugins concurrently, and let them all finish before the plugins can be finalised
    const results = await Promise.allSettled(this.plugins.map(plugin => plugin.processInputStream(bucket)));
    // Ranked once a plugin failed: the ranking allocated its arrays on every bucket, though none fails in a run that goes on
    if (results.some(isRejected)) {
      const [failure, ...otherFailures] = this.rankFailures(results);
      this.otherFailures = otherFailures;
      throw failure.reason;
    }

    // Broadcast the deferred events plugin by plugin, in config order. Each call delivers the oldest group of the plugin's queue,
    // the payloads queued in a row under one event name, so that the events arrive in the order they were queued. It resolves to
    // false once the queue is empty. Not called while a plugin has nothing queued (see hasDeferredEvents): an awaited call per plugin
    // and bucket, most of them with nothing to deliver. Asked as each plugin's turn comes, not once before the loop: a handler of a
    // plugin flushed earlier queues events on a later one, delivered with this bucket (in a backtest, the order a TradingAdvisor's
    // advice places ends on the Trader at once, and the strategy and the analyzers hear of it in the bucket it filled in).
    for (const plugin of this.plugins) {
      while (plugin.hasDeferredEvents() && (await plugin.broadcastDeferredEmit()));
    }
  }

  /** The bucket failed: `reason` is what the dummy exchange, a plugin or an event handler threw */
  private async stopOnError(reason: unknown) {
    const error = toError(reason);
    this.caughtError = error;
    this.logCloseReason(reason);
    for (const { plugin, reason: otherReason } of this.otherFailures) {
      logError('stream', `${plugin.emitterName} failed on the bucket as well: ${describeReason(otherReason)}`);
    }
    this.logDroppedEvents();

    // Finalize all plugins before destroying the stream. A failed finalisation is logged by _destroy, which waits for it too.
    await this.finalizeAllPlugins(error).catch(() => undefined);

    // The pipeline rejects with this error, which is how main() tells an ApplicationStopError from a crash. _destroy runs at once
    // and waits for this bucket to settle: nothing here may wait for the stream to close.
    this.destroy(error);
  }

  /**
   * Says why the application closes, before the plugins are finalised: Supervision's last flush sends it to Telegram then. main()
   * logs the failure in full (stack, causes) only once they are, too late for that flush, so the console shows its message twice.
   */
  private logCloseReason(reason: unknown) {
    if (reason instanceof ApplicationStopError) warning('stream', `Application stopped gracefully: ${reason.message}`);
    else logError('stream', `Gekko is closing the application due to an error: ${describeReason(reason)}`);
  }

  /**
   * The plugins that failed on a bucket, the one whose failure is thrown first. An ApplicationStopError comes before any other failure:
   * it is an orderly stop, which a restart-on-failure supervisor must leave stopped, and main() tells it from a crash by the error the
   * pipeline rejects with. So when one plugin asks to stop and another fails, Gekko stops (exit code 0). Then config order, whichever
   * plugin failed first in time: the failure reported does not depend on timing.
   */
  private rankFailures(results: PromiseSettledResult<void>[]): PluginFailure[] {
    const [stops, others] = partition(collectFailures(this.plugins, results), ({ reason }) => reason instanceof ApplicationStopError);
    return [...stops, ...others];
  }

  /**
   * Names, per plugin, the deferred events left queued as the application closes on a failure, before the plugins are finalised (for
   * Supervision's last flush): those a failed bucket did not deliver, or, on a failure upstream, those a handler queued on a plugin
   * flushed before it (an order a strategy hook places on a fill), for a bucket that never comes. They are dropped: delivered after a
   * stop (the circuit breaker), they could make the strategy act again, an order hook placing a new order. The final reports may miss
   * them (an orderCompleted, a roundtripCompleted).
   * Not counted: the group whose delivery threw. broadcastDeferredEmit takes a group out of the queue before delivering it, and stops
   * at the listener that throws: the listeners wired after it (in config order) never receive it. An EventSubscriber configured
   * after the TradingAdvisor never hears of the orderErrored that tripped the circuit breaker.
   */
  private logDroppedEvents() {
    const dropped = this.plugins.flatMap(plugin => {
      const counts = Array.from(plugin.countUndeliveredPayloads(), ([event, count]) => `${event}: ${count}`);
      return counts.length ? [`${plugin.emitterName} (${counts.join(', ')})`] : [];
    });
    if (dropped.length)
      warning('stream', `Deferred events dropped as the application closes, the final reports may miss them: ${dropped.join(', ')}`);
  }

  /** Finalises the plugins whose init completed, once: whoever asks later gets the same promise (see finalization) */
  private finalizeAllPlugins(failure?: Error): Promise<GekkoError | undefined> {
    this.finalization ??= this.finalizePlugins(failure);
    return this.finalization;
  }

  /**
   * `failure` tells the plugins that the run stops before its end: their final reports then describe a partial run. Each plugin's
   * cleanup runs whatever the others do. Resolves to undefined when none failed, else to an error naming each plugin that did with
   * what it threw, caused by that failure, or by an AggregateError of them when several failed: _final fails the run with it, _destroy
   * logs it.
   */
  private async finalizePlugins(failure?: Error): Promise<GekkoError | undefined> {
    const results = await Promise.allSettled(this.initializedPlugins.map(plugin => plugin.processCloseStream(failure)));
    const failures = collectFailures(this.initializedPlugins, results);
    if (!failures.length) return undefined;

    const message = failures.map(({ plugin, reason }) => `${plugin.emitterName} failed to finalize: ${describeError(reason)}`).join('; ');
    const reasons = failures.map(({ reason }) => reason);
    const cause = reasons.length === 1 ? reasons[0] : new AggregateError(reasons, `${reasons.length} plugins failed to finalize`);
    return new GekkoError('stream', message, { cause });
  }
}
