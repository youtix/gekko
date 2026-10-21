import { ApplicationStopError } from '@errors/applicationStop.error';
import { GekkoError } from '@errors/gekko.error';
import { CandleBucket } from '@models/event.types';
import { Plugin } from '@plugins/plugin';
import { error, info, warning } from '@services/logger';
import { SequentialEventEmitter } from '@helpers/event/sequentialEventEmitter';
import { noop } from 'lodash-es';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { PluginsStream } from './plugins.stream';

/* -------------------------------------------------------------------------- */
/*                                    MOCKS                                   */
/* -------------------------------------------------------------------------- */

const { injectMock } = vi.hoisted(() => ({
  injectMock: {
    exchange: vi.fn(() => ({ getExchangeName: (): string => 'binance' })),
  },
}));

vi.mock('@services/injecter/injecter', () => ({ inject: injectMock }));
vi.mock('@services/logger', () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

/* -------------------------------------------------------------------------- */
/*                                  HELPERS                                   */
/* -------------------------------------------------------------------------- */

const BUCKET: CandleBucket = new Map();

/** As Bun's ResolveMessage, which the dynamic import() of a file that cannot be found rejects with: not an Error, its message a getter */
class ResolveMessage {
  readonly #message: string;

  constructor(message: string) {
    this.#message = message;
  }

  get message() {
    return this.#message;
  }
}

const STRATEGY_FILE = '/strategies/my.strategy.ts';

const createPluginStub = (overrides?: Partial<Record<keyof Plugin, unknown>>) =>
  ({
    emitterName: 'Stub',
    processInitStream: vi.fn(async () => undefined),
    processInputStream: vi.fn(async () => undefined),
    processCloseStream: vi.fn(async () => undefined),
    // Something queued, as far as the stream asks: what broadcastDeferredEmit resolves to tells what it delivered
    hasDeferredEvents: vi.fn(() => true),
    broadcastDeferredEmit: vi.fn(async () => false),
    countUndeliveredPayloads: vi.fn(() => new Map()),
    ...overrides,
  }) as unknown as Plugin;

/** A stub plugin on a real SequentialEventEmitter named `name`: what it queues is broadcast, or counted, as a plugin's is */
const createEmittingPluginStub = (name: string) =>
  Object.assign(new SequentialEventEmitter(name), {
    processInitStream: vi.fn(async () => undefined),
    processInputStream: vi.fn(async () => undefined),
    processCloseStream: vi.fn(async () => undefined),
  }) as unknown as Plugin;

/** A promise settled from outside, to hold a plugin or a source at a given step. */
const createGate = () => {
  let open = () => {};
  const promise = new Promise<void>(resolve => (open = resolve));
  return { promise, open };
};

/**
 * Work a stub plugin holds until the test releases it, as one awaiting the exchange would: `run` is the stub's method, `started`
 * settles once the plugin has begun it, and `finished` is called as it ends. It resolves to false, as broadcastDeferredEmit does
 * once nothing more is queued.
 */
const createHeldWork = () => {
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const finished = vi.fn();
  const run = vi.fn(async () => {
    started.resolve();
    await released.promise;
    finished();
    return false;
  });
  return { run, started: started.promise, release: () => released.resolve(), finished };
};

/** Runs the plugins through the public API, as pipeline.helper does, and returns what the pipeline rejected with, if anything. */
const runPipeline = (source: Iterable<CandleBucket> | AsyncIterable<CandleBucket>, plugins: Plugin[]) =>
  pipeline(Readable.from(source), new PluginsStream(plugins)).then(
    () => undefined,
    (reason: unknown) => reason,
  );

const throwing = (thrown: unknown) =>
  vi.fn(async () => {
    throw thrown;
  });

const waitForError = (stream: PluginsStream) => new Promise<Error>(resolve => stream.once('error', resolve));

/** The logger throws `thrown` as the stream logs a failed finalisation at error level, as a logger that is down would */
const failToLogFinalizationFailure = (thrown: unknown) =>
  vi.mocked(error).mockImplementation((_tag, message) => {
    if (typeof message === 'string' && message.includes('failed to finalize')) throw thrown;
  });

/** Writes a bucket to the stream on its own, outside any pipeline, and resolves once the stream has processed it */
const writeBucket = (stream: PluginsStream) =>
  new Promise<void>((resolve, reject) => stream.write(BUCKET, failure => (failure ? reject(failure) : resolve())));

/* -------------------------------------------------------------------------- */
/*                                   TESTS                                    */
/* -------------------------------------------------------------------------- */

describe('PluginsStream', () => {
  describe('_construct', () => {
    it('initializes each plugin once', async () => {
      const plugin = createPluginStub();

      await runPipeline([], [plugin]);

      expect(plugin.processInitStream).toHaveBeenCalledOnce();
    });

    // A template literal threw for a value without a prototype, from the catch meant to report it: the stream was never constructed, and
    // the pipeline never settled
    it.each`
      kind                             | thrown                                                 | message
      ${'an Error'}                    | ${new Error('init err')}                               | ${'init err'}
      ${'a string'}                    | ${'string error'}                                      | ${'Error when initializing stream plugin: string error'}
      ${'a value without a prototype'} | ${Object.assign(Object.create(null), { status: 503 })} | ${'Error when initializing stream plugin: [Object: null prototype] { status: 503 }'}
    `('rejects the pipeline with $message when a plugin init throws $kind', async ({ thrown, message }) => {
      const plugin = createPluginStub({ processInitStream: throwing(thrown) });

      expect(await runPipeline([BUCKET], [plugin])).toEqual(new Error(message));
    });

    describe('when the stream is destroyed while a plugin initializes', () => {
      const destroyError = new Error('download failed');
      let plugins: Plugin[];
      let reported: unknown;

      beforeEach(async () => {
        const initGate = createGate();
        plugins = [createPluginStub({ processInitStream: vi.fn(() => initGate.promise) }), createPluginStub()];
        const stream = new PluginsStream(plugins);
        const errored = new Promise(resolve => stream.once('error', resolve));
        await vi.waitFor(() => expect(plugins[0].processInitStream).toHaveBeenCalled());

        stream.destroy(destroyError);
        initGate.open();
        reported = await errored;
      });

      it('reports the error it was destroyed with', () => {
        expect(reported).toBe(destroyError);
      });

      it('finalizes the plugin whose init was in progress, once it is done', () => {
        expect(plugins[0].processCloseStream).toHaveBeenCalledOnce();
      });

      it('tells the plugin why the run stops', () => {
        expect(plugins[0].processCloseStream).toHaveBeenCalledWith(destroyError);
      });

      it('does not initialize the plugins left', () => {
        expect(plugins[1].processInitStream).not.toHaveBeenCalled();
      });
    });
  });

  describe('_write', () => {
    describe('successful processing', () => {
      it('forwards the bucket to the dummy exchange before the plugins', async () => {
        const callOrder: string[] = [];
        const dummyExchange = { processOneMinuteBucket: vi.fn(() => callOrder.push('exchange')), getExchangeName: () => 'dummy-cex' };
        injectMock.exchange.mockReturnValue(dummyExchange);
        const plugin = createPluginStub({ processInputStream: vi.fn(async () => callOrder.push('plugin')) });

        await runPipeline([BUCKET], [plugin]);

        expect(callOrder).toEqual(['exchange', 'plugin']);
      });

      it('broadcasts the deferred events of each plugin until its queue is empty, in config order', async () => {
        const callOrder: string[] = [];
        const queues = [2, 1];
        const plugins = queues.map((_, index) =>
          createPluginStub({
            broadcastDeferredEmit: vi.fn(async () => {
              callOrder.push(`plugin ${index}`);
              return queues[index]-- > 0;
            }),
          }),
        );

        await runPipeline([BUCKET], plugins);

        expect(callOrder).toEqual(['plugin 0', 'plugin 0', 'plugin 0', 'plugin 1', 'plugin 1']);
      });

      it('delivers the deferred events of a plugin in the order they were queued', async () => {
        const delivered: string[] = [];
        const trader = createEmittingPluginStub('Trader');
        trader.on('orderErrored', () => {
          delivered.push('orderErrored');
        });
        trader.on('orderCompleted', () => {
          delivered.push('orderCompleted');
        });
        vi.mocked(trader.processInputStream).mockImplementation(async () => {
          trader.addDeferredEmit('orderErrored', { id: 1 });
          trader.addDeferredEmit('orderCompleted', { id: 2 });
          trader.addDeferredEmit('orderErrored', { id: 3 });
        });

        await runPipeline([BUCKET], [trader]);

        expect(delivered).toEqual(['orderErrored', 'orderCompleted', 'orderErrored']);
      });

      // A fill reaches the strategy and the analyzers in the bucket it happened in: the Trader's queue fills as the TradingAdvisor's is
      // flushed. Working out which plugins have something queued before the loop leaves that event for the next bucket.
      it('delivers within the bucket an event a handler queues on a plugin flushed after its own', async () => {
        const advisor = createEmittingPluginStub('TradingAdvisor');
        const trader = createEmittingPluginStub('Trader');
        const onOrderCompleted = vi.fn();
        // The Trader places the order the advice asks for, and the simulator ends it at once: its end is queued on the Trader
        advisor.on('strategyCreateOrder', () => trader.addDeferredEmit('orderCompleted', { id: 2 }));
        trader.on('orderCompleted', onOrderCompleted);
        vi.mocked(advisor.processInputStream).mockImplementation(async () => advisor.addDeferredEmit('strategyCreateOrder', { id: 1 }));

        await writeBucket(new PluginsStream([advisor, trader]));

        expect(onOrderCompleted).toHaveBeenCalledOnce();
      });

      // Awaited for every plugin on every bucket, though most have nothing queued
      it('does not broadcast for a plugin with nothing queued', async () => {
        const plugin = createPluginStub({ hasDeferredEvents: vi.fn(() => false) });

        await runPipeline([BUCKET], [plugin]);

        expect(plugin.broadcastDeferredEmit).not.toHaveBeenCalled();
      });

      // The ranking allocated its arrays on every bucket, though a run that goes on has no failure to rank
      it('does not rank the failures of a bucket every plugin processed', async () => {
        const rankFailures = vi.spyOn(PluginsStream.prototype as any, 'rankFailures');

        await runPipeline([BUCKET, BUCKET], [createPluginStub(), createPluginStub()]);

        expect(rankFailures).not.toHaveBeenCalled();
      });

      it('finalizes the plugins at the end of the stream', async () => {
        const plugin = createPluginStub();

        await runPipeline([BUCKET], [plugin]);

        expect(plugin.processCloseStream).toHaveBeenCalledOnce();
      });

      it('logs the closing message at the end of the stream', async () => {
        await runPipeline([BUCKET], [createPluginStub()]);

        expect(info).toHaveBeenCalledWith('stream', 'Gekko is closing the application !');
      });
    });

    describe('when a plugin fails on a bucket', () => {
      // String() threw for a value without a prototype, from the handler of the failed bucket: the stream was never destroyed, and the
      // pipeline never settled
      it.each`
        kind                             | thrown                                                 | message
        ${'an Error'}                    | ${new Error('process-failed')}                         | ${'process-failed'}
        ${'a string'}                    | ${'string error'}                                      | ${'string error'}
        ${'a value without a prototype'} | ${Object.assign(Object.create(null), { status: 503 })} | ${'[Object: null prototype] { status: 503 }'}
      `('rejects the pipeline with $message when a plugin throws $kind', async ({ thrown, message }) => {
        const plugin = createPluginStub({ processInputStream: throwing(thrown) });

        expect(await runPipeline([BUCKET], [plugin])).toEqual(new Error(message));
      });

      it('finalizes the plugins', async () => {
        const plugin = createPluginStub({ processInputStream: throwing(new Error('fail')) });

        await runPipeline([BUCKET], [plugin]);

        expect(plugin.processCloseStream).toHaveBeenCalledOnce();
      });

      it('tells the plugins why the run stops', async () => {
        const failure = new Error('fail');
        const plugin = createPluginStub({ processInputStream: throwing(failure) });

        await runPipeline([BUCKET], [plugin]);

        expect(plugin.processCloseStream).toHaveBeenCalledWith(failure);
      });

      // util.inspect wrote a ResolveMessage as 'ResolveMessage {}', without the module or the file that imported it
      it.each`
        kind                  | thrown                                                                          | reason
        ${'a GekkoError'}     | ${new GekkoError('trader', 'No balance')}                                       | ${'[TRADER] No balance'}
        ${'an Error'}         | ${new TypeError('fetch failed')}                                                | ${'TypeError: fetch failed'}
        ${'a string'}         | ${'string error'}                                                               | ${'string error'}
        ${'another value'}    | ${{ code: 42 }}                                                                 | ${'{ code: 42 }'}
        ${'a ResolveMessage'} | ${new ResolveMessage(`Cannot find module './signals' from '${STRATEGY_FILE}'`)} | ${`ResolveMessage: Cannot find module './signals' from '${STRATEGY_FILE}'`}
      `('logs why the application closes when a plugin throws $kind', async ({ thrown, reason }) => {
        await runPipeline([BUCKET], [createPluginStub({ processInputStream: throwing(thrown) })]);

        expect(error).toHaveBeenCalledWith('stream', `Gekko is closing the application due to an error: ${reason}`);
      });

      it('logs why the application closes before finalizing the plugins, for the last flush of Supervision to send it', async () => {
        const plugin = createPluginStub({ processInputStream: throwing(new Error('fail')) });

        await runPipeline([BUCKET], [plugin]);

        const [logCallOrder] = vi.mocked(error).mock.invocationCallOrder;
        const [finalizeCallOrder] = vi.mocked(plugin.processCloseStream).mock.invocationCallOrder;
        expect(logCallOrder).toBeLessThan(finalizeCallOrder);
      });

      it('logs why the application closes once, not again when the stream is destroyed', async () => {
        await runPipeline([BUCKET], [createPluginStub({ processInputStream: throwing(new Error('fail')) })]);

        expect(error).toHaveBeenCalledOnce();
      });

      it('logs no event dropped when the failed bucket leaves none queued', async () => {
        await runPipeline([BUCKET], [createPluginStub({ processInputStream: throwing(new Error('fail')) })]);

        expect(warning).not.toHaveBeenCalled();
      });

      it('does not process the buckets that follow', async () => {
        const plugin = createPluginStub({ processInputStream: throwing(new Error('fail')) });

        await runPipeline([BUCKET, BUCKET, BUCKET], [plugin]);

        expect(plugin.processInputStream).toHaveBeenCalledOnce();
      });

      it('finalizes all the plugins even when some finalizations throw', async () => {
        const plugins = [
          createPluginStub({
            processInputStream: throwing(new Error('fail')),
            processCloseStream: throwing(new Error('finalize1 failed')),
          }),
          createPluginStub(),
        ];

        await runPipeline([BUCKET], plugins);

        expect(plugins[1].processCloseStream).toHaveBeenCalledOnce();
      });

      describe('when logging the failed finalization throws', () => {
        const bucketError = new Error('fail');
        let rejection: unknown;

        beforeEach(async () => {
          failToLogFinalizationFailure(new Error('log down'));
          const plugin = createPluginStub({
            processInputStream: throwing(bucketError),
            processCloseStream: throwing(new Error('finalize failed')),
          });

          rejection = await runPipeline([BUCKET], [plugin]);
        });

        it('still rejects the pipeline with the error of the bucket', () => {
          expect(rejection).toBe(bucketError);
        });

        it('logs the failure as a warning', () => {
          expect(warning).toHaveBeenLastCalledWith('stream', 'Finalization errors: log down');
        });
      });

      // A warning, hidden at the default level, without the plugin. String() threw for a value without a prototype: the warning named
      // the TypeError instead of the failure.
      it.each`
        kind                             | thrown                                                 | logged
        ${'an Error'}                    | ${new Error('finalize failed')}                        | ${'Stub failed to finalize: finalize failed'}
        ${'a GekkoError'}                | ${new GekkoError('storage', 'disk full')}              | ${'Stub failed to finalize: disk full'}
        ${'another value'}               | ${'finalize failed'}                                   | ${'Stub failed to finalize: finalize failed'}
        ${'a value without a prototype'} | ${Object.assign(Object.create(null), { status: 503 })} | ${'Stub failed to finalize: [Object: null prototype] { status: 503 }'}
      `('logs a finalization that throws $kind at error level: $logged', async ({ thrown, logged }) => {
        const plugin = createPluginStub({ processInputStream: throwing(new Error('fail')), processCloseStream: throwing(thrown) });

        await runPipeline([BUCKET], [plugin]);

        expect(error).toHaveBeenCalledWith('stream', logged);
      });

      it('logs a failed finalization after the reason the application closes', async () => {
        const plugin = createPluginStub({
          processInputStream: throwing(new Error('fail')),
          processCloseStream: throwing(new Error('finalize failed')),
        });

        await runPipeline([BUCKET], [plugin]);

        expect(vi.mocked(error).mock.calls).toEqual([
          ['stream', 'Gekko is closing the application due to an error: Error: fail'],
          ['stream', 'Stub failed to finalize: finalize failed'],
        ]);
      });
    });

    describe('when several plugins fail on the same bucket', () => {
      const firstError = new Error('first failed');
      let callOrder: string[];
      let plugins: Plugin[];
      let rejection: unknown;

      beforeEach(async () => {
        callOrder = [];
        const slow = vi.fn(async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          callOrder.push('slow plugin done');
          throw 'third failed';
        });
        plugins = [
          createPluginStub({ processInputStream: throwing(firstError), processCloseStream: vi.fn(async () => callOrder.push('finalize')) }),
          createPluginStub({ emitterName: 'Second', processInputStream: throwing(new Error('second failed')) }),
          createPluginStub({ emitterName: 'Third', processInputStream: slow }),
        ];

        rejection = await runPipeline([BUCKET], plugins);
      });

      it('rejects the pipeline with the error of the first plugin in config order', () => {
        expect(rejection).toBe(firstError);
      });

      it('finalizes the plugins only once every plugin is done with the bucket', () => {
        expect(callOrder).toEqual(['slow plugin done', 'finalize']);
      });

      it.each`
        message
        ${'Second failed on the bucket as well: Error: second failed'}
        ${'Third failed on the bucket as well: third failed'}
      `('logs the other failure with its plugin: $message', ({ message }) => {
        expect(error).toHaveBeenCalledWith('stream', message);
      });
    });

    describe('when two plugins fail on the same bucket, the second before the first', () => {
      const firstError = new Error('first failure');
      const secondError = new Error('second failure');
      const firstStop = new ApplicationStopError('strategy', 'first stop');
      const secondStop = new ApplicationStopError('strategy', 'second stop');

      /** Runs a bucket both plugins fail on, the second one first: gives what the pipeline rejects with */
      const runBucketBothFailOn = (firstReason: unknown, secondReason: unknown) =>
        runPipeline(
          [BUCKET],
          [
            createPluginStub({
              emitterName: 'First',
              processInputStream: vi.fn(async () => {
                await new Promise(resolve => setImmediate(resolve)); // Once the second has failed
                throw firstReason;
              }),
            }),
            createPluginStub({ emitterName: 'Second', processInputStream: throwing(secondReason) }),
          ],
        );

      it.each`
        reported                                                    | first         | second         | expected
        ${'the failure of the first plugin in config order'}        | ${firstError} | ${secondError} | ${firstError}
        ${'an ApplicationStopError over a failure before it'}       | ${firstError} | ${secondStop}  | ${secondStop}
        ${'an ApplicationStopError over a failure after it'}        | ${firstStop}  | ${secondError} | ${firstStop}
        ${'the first of two ApplicationStopErrors in config order'} | ${firstStop}  | ${secondStop}  | ${firstStop}
      `('rejects the pipeline with $reported', async ({ first, second, expected }) => {
        expect(await runBucketBothFailOn(first, second)).toBe(expected);
      });

      it.each`
        failure                                         | first         | second         | logged
        ${'of the second plugin, after the first'}      | ${firstError} | ${secondError} | ${'Second failed on the bucket as well: Error: second failure'}
        ${'of the first plugin, when the second stops'} | ${firstError} | ${secondStop}  | ${'First failed on the bucket as well: Error: first failure'}
      `('logs the other failure, $failure, with its plugin', async ({ first, second, logged }) => {
        await runBucketBothFailOn(first, second);

        expect(error).toHaveBeenCalledWith('stream', logged);
      });

      it('logs the other failure after the reason the application closes', async () => {
        await runBucketBothFailOn(firstError, secondError);

        expect(vi.mocked(error).mock.calls).toEqual([
          ['stream', 'Gekko is closing the application due to an error: Error: first failure'],
          ['stream', 'Second failed on the bucket as well: Error: second failure'],
        ]);
      });
    });

    describe.each`
      source                                 | method
      ${'processInputStream'}                | ${'processInputStream'}
      ${'broadcastDeferredEmit (a handler)'} | ${'broadcastDeferredEmit'}
    `('on an ApplicationStopError thrown by $source', ({ method }) => {
      const stopError = new ApplicationStopError('strategy', 'stop error application');
      let plugin: Plugin;
      let stream: PluginsStream;
      let rejection: unknown;

      beforeEach(async () => {
        plugin = createPluginStub({ [method]: throwing(stopError) });
        stream = new PluginsStream([plugin]);
        rejection = await pipeline(Readable.from([BUCKET]), stream).catch((reason: unknown) => reason);
      });

      it('rejects the pipeline with the ApplicationStopError itself, not a premature close', () => {
        expect(rejection).toBe(stopError);
      });

      // The failed bucket destroys the stream itself, and _destroy waits for that bucket to settle: neither may wait for the other
      it('closes the stream it destroys after the failed bucket', () => {
        expect(stream.closed).toBe(true);
      });

      it('finalizes all plugins', () => {
        expect(plugin.processCloseStream).toHaveBeenCalledOnce();
      });

      it('logs the stop reason as a warning, for the last flush of Supervision to send it', () => {
        expect(warning).toHaveBeenCalledWith('stream', 'Application stopped gracefully: [STRATEGY] stop error application');
      });

      it('logs the stop reason before finalizing the plugins', () => {
        const [logCallOrder] = vi.mocked(warning).mock.invocationCallOrder;
        const [finalizeCallOrder] = vi.mocked(plugin.processCloseStream).mock.invocationCallOrder;
        expect(logCallOrder).toBeLessThan(finalizeCallOrder);
      });
    });

    describe('when a handler stops the application during the flush, with deferred events still queued', () => {
      const STOP_LOG = 'Application stopped gracefully: [STRATEGY] Max consecutive order errors reached (1)';
      const DROPPED_EVENTS_LOG =
        'Deferred events dropped as the application closes, the final reports may miss them: ' +
        'Trader (orderCompleted: 1, portfolioChange: 2), RoundTripAnalyzer (roundtripCompleted: 1)';
      let plugins: Plugin[];
      let onOrderCompleted: Mock;

      beforeEach(async () => {
        const advisor = createEmittingPluginStub('TradingAdvisor');
        const trader = createEmittingPluginStub('Trader');
        const analyzer = createEmittingPluginStub('RoundTripAnalyzer');
        plugins = [advisor, trader, analyzer];
        // As the circuit breaker: the advisor stops the application on an order error the Trader reports
        trader.on('orderErrored', () => {
          throw new ApplicationStopError('strategy', 'Max consecutive order errors reached (1)');
        });
        onOrderCompleted = vi.fn();
        trader.on('orderCompleted', onOrderCompleted);
        trader.on('portfolioChange', noop);
        analyzer.on('roundtripCompleted', noop);
        vi.mocked(trader.processInputStream).mockImplementation(async () => {
          trader.addDeferredEmit('orderErrored', { id: 1 });
          trader.addDeferredEmit('orderCompleted', { id: 2 });
          trader.addDeferredEmit('portfolioChange', { id: 3 });
          trader.addDeferredEmit('portfolioChange', { id: 4 });
        });
        vi.mocked(analyzer.processInputStream).mockImplementation(async () => {
          analyzer.addDeferredEmit('roundtripCompleted', { id: 5 });
          analyzer.addDeferredEmit('equitySnapshot', { id: 6 }); // Nobody listens to it: nothing is lost with it
        });

        await runPipeline([BUCKET], plugins);
      });

      it('delivers none of them', () => {
        expect(onOrderCompleted).not.toHaveBeenCalled();
      });

      it('logs, once and after the stop reason, those a plugin listens to, per plugin, as a warning', () => {
        expect(vi.mocked(warning).mock.calls).toEqual([
          ['stream', STOP_LOG],
          ['stream', DROPPED_EVENTS_LOG],
        ]);
      });

      it('logs them before finalizing the plugins, for the last flush of Supervision to send them', () => {
        const [, logCallOrder] = vi.mocked(warning).mock.invocationCallOrder;
        const [finalizeCallOrder] = vi.mocked(plugins[0].processCloseStream).mock.invocationCallOrder;
        expect(logCallOrder).toBeLessThan(finalizeCallOrder);
      });
    });
  });

  describe('_final', () => {
    // Only logged as a warning, hidden at the default level: an import whose last insert failed exited with code 0, its last minutes
    // missing from the database
    describe('when a plugin finalization fails at the end of the stream', () => {
      const finalizeError = new Error('database is locked');
      let plugins: Plugin[];
      let rejection: unknown;

      beforeEach(async () => {
        plugins = [createPluginStub({ emitterName: 'CandleWriter', processCloseStream: throwing(finalizeError) }), createPluginStub()];

        rejection = await runPipeline([BUCKET], plugins);
      });

      it('rejects the pipeline with a GekkoError', () => {
        expect(rejection).toBeInstanceOf(GekkoError);
      });

      it('rejects the pipeline naming the plugin and its failure', () => {
        expect(rejection).toHaveProperty('message', '[STREAM] CandleWriter failed to finalize: database is locked');
      });

      it('rejects the pipeline with the failure of the plugin as the cause', () => {
        expect(rejection).toHaveProperty('cause', finalizeError);
      });

      it('finalizes the other plugins', () => {
        expect(plugins[1].processCloseStream).toHaveBeenCalledOnce();
      });

      // main() reports what the pipeline rejects with: logged by the stream as well, the failure showed twice
      it('logs nothing at error level', () => {
        expect(error).not.toHaveBeenCalled();
      });

      it('does not log the closing message', () => {
        expect(info).not.toHaveBeenCalledWith('stream', 'Gekko is closing the application !');
      });
    });

    it.each`
      kind                             | thrown                                                 | message
      ${'a GekkoError'}                | ${new GekkoError('storage', 'disk full')}              | ${'[STREAM] Stub failed to finalize: disk full'}
      ${'a string'}                    | ${'finalize err'}                                      | ${'[STREAM] Stub failed to finalize: finalize err'}
      ${'a value without a prototype'} | ${Object.assign(Object.create(null), { status: 503 })} | ${'[STREAM] Stub failed to finalize: [Object: null prototype] { status: 503 }'}
    `('rejects the pipeline with $message when a plugin finalization throws $kind', async ({ thrown, message }) => {
      const plugin = createPluginStub({ processCloseStream: throwing(thrown) });

      expect(await runPipeline([BUCKET], [plugin])).toHaveProperty('message', message);
    });

    describe('when several plugin finalizations fail', () => {
      const firstError = new Error('database is locked');
      const secondError = new TypeError('this.strategy.end is not a function');
      let rejection: unknown;

      beforeEach(async () => {
        rejection = await runPipeline(
          [BUCKET],
          [
            createPluginStub({ emitterName: 'CandleWriter', processCloseStream: throwing(firstError) }),
            createPluginStub(),
            createPluginStub({ emitterName: 'TradingAdvisor', processCloseStream: throwing(secondError) }),
          ],
        );
      });

      it('rejects the pipeline naming each of them, in config order', () => {
        expect(rejection).toHaveProperty(
          'message',
          '[STREAM] CandleWriter failed to finalize: database is locked; TradingAdvisor failed to finalize: this.strategy.end is not a function',
        );
      });

      it('rejects the pipeline with an AggregateError of their failures as the cause', () => {
        expect(rejection).toHaveProperty('cause', new AggregateError([firstError, secondError], '2 plugins failed to finalize'));
      });
    });

    it.each`
      kind               | thrown                   | message
      ${'an Error'}      | ${new Error('log down')} | ${'log down'}
      ${'another value'} | ${'log down'}            | ${'log down'}
    `('rejects the pipeline when logging the closing message throws $kind', async ({ thrown, message }) => {
      vi.mocked(info).mockImplementationOnce(() => {
        throw thrown;
      });

      expect(await runPipeline([BUCKET], [createPluginStub()])).toEqual(new Error(message));
    });

    // As pipeline() does when a stream of the chain fails, or its signal aborts, while _final finalises the plugins
    describe('when destroyed while the plugins are finalized at the end of the stream', () => {
      const destroyError = new Error('aborted');
      let reported: unknown;

      beforeEach(async () => {
        const finalization = createHeldWork();
        const plugin = createPluginStub({
          emitterName: 'CandleWriter',
          processCloseStream: vi.fn(async () => {
            await finalization.run();
            throw new Error('database is locked');
          }),
        });
        const stream = new PluginsStream([plugin]);
        const streamError = waitForError(stream);
        stream.end();
        await finalization.started;
        stream.destroy(destroyError);
        finalization.release();

        reported = await streamError;
      });

      it('reports the error it was destroyed with', () => {
        expect(reported).toBe(destroyError);
      });

      // A destroyed stream drops the error _final gives it: the failure has to be logged
      it('logs the failed finalization at error level', () => {
        expect(error).toHaveBeenCalledWith('stream', 'CandleWriter failed to finalize: database is locked');
      });
    });
  });

  describe('_destroy', () => {
    describe('when a stream upstream fails between two buckets', () => {
      const sourceError = new Error('download failed');
      let plugins: Plugin[];
      let rejection: unknown;

      beforeEach(async () => {
        const bucketProcessed = createGate();
        plugins = [
          createPluginStub({ processInputStream: vi.fn(async () => bucketProcessed.open()) }),
          createPluginStub({ processCloseStream: throwing(new Error('finalize failed')) }),
        ];
        async function* failingSource() {
          yield BUCKET;
          await bucketProcessed.promise; // Fails once the plugins have processed a bucket, like a download that breaks off
          throw sourceError;
        }

        rejection = await runPipeline(failingSource(), plugins);
      });

      it('rejects the pipeline with the error of the source, not with the finalization failure', () => {
        expect(rejection).toBe(sourceError);
      });

      it('logs why the application closes', () => {
        expect(error).toHaveBeenCalledWith('stream', 'Gekko is closing the application due to an error: Error: download failed');
      });

      it('logs why the application closes before finalizing the plugins', () => {
        const [logCallOrder] = vi.mocked(error).mock.invocationCallOrder;
        const [finalizeCallOrder] = vi.mocked(plugins[0].processCloseStream).mock.invocationCallOrder;
        expect(logCallOrder).toBeLessThan(finalizeCallOrder);
      });

      it('logs the failed finalization at error level, after why the application closes', () => {
        expect(vi.mocked(error).mock.calls).toEqual([
          ['stream', 'Gekko is closing the application due to an error: Error: download failed'],
          ['stream', 'Stub failed to finalize: finalize failed'],
        ]);
      });

      it.each`
        index | plugin
        ${0}  | ${'first'}
        ${1}  | ${'second'}
      `('finalizes the $plugin plugin exactly once', ({ index }) => {
        expect(plugins[index].processCloseStream).toHaveBeenCalledOnce();
      });
    });

    // The pipeline destroys the stream as soon as a stream upstream fails, whatever the bucket in progress is doing
    describe.each`
      work                                   | method
      ${'a plugin is processing the bucket'} | ${'processInputStream'}
      ${'a deferred event is delivered'}     | ${'broadcastDeferredEmit'}
    `('when a failure upstream destroys it while $work', ({ method }: { method: 'processInputStream' | 'broadcastDeferredEmit' }) => {
      const upstreamError = new Error('download failed');
      let plugin: Plugin;
      let heldWork: ReturnType<typeof createHeldWork>;
      let streamError: Promise<Error>;

      beforeEach(async () => {
        heldWork = createHeldWork();
        plugin = createPluginStub({ [method]: heldWork.run });
        const stream = new PluginsStream([plugin]);
        streamError = waitForError(stream);
        stream.write(BUCKET);
        await heldWork.started;
        stream.destroy(upstreamError);
      });

      afterEach(async () => {
        heldWork.release();
        await streamError; // Settled within the test, nothing of it runs into the next one
      });

      it('does not finalize the plugins before that work is done', () => {
        expect(plugin.processCloseStream).not.toHaveBeenCalled();
      });

      it('finalizes the plugins once that work is done', async () => {
        heldWork.release();
        await streamError;
        const [finishCallOrder] = heldWork.finished.mock.invocationCallOrder;
        const [finalizeCallOrder] = vi.mocked(plugin.processCloseStream).mock.invocationCallOrder;
        expect(finishCallOrder).toBeLessThan(finalizeCallOrder);
      });

      it('finalizes the plugins exactly once', async () => {
        heldWork.release();
        await streamError;
        expect(plugin.processCloseStream).toHaveBeenCalledOnce();
      });

      it('reports the error it was destroyed with', async () => {
        heldWork.release();
        expect(await streamError).toBe(upstreamError);
      });
    });

    describe('when a failure upstream destroys it while a plugin is processing a bucket it then fails on', () => {
      const upstreamError = new Error('download failed');
      const stopError = new ApplicationStopError('strategy', 'Max consecutive order errors reached (5)');
      let plugin: Plugin;
      let finalization: ReturnType<typeof createHeldWork>;
      let stream: PluginsStream;
      let streamError: Promise<Error>;

      beforeEach(async () => {
        const bucketWork = createHeldWork();
        finalization = createHeldWork();
        plugin = createPluginStub({
          emitterName: 'Trader',
          processInputStream: vi.fn(async () => {
            await bucketWork.run();
            throw stopError;
          }),
          processCloseStream: vi.fn(async () => {
            await finalization.run();
          }),
          countUndeliveredPayloads: vi.fn(() => new Map([['orderCompleted', 1]])),
        });
        stream = new PluginsStream([plugin]);
        streamError = waitForError(stream);
        stream.write(BUCKET);
        await bucketWork.started;
        stream.destroy(upstreamError);
        bucketWork.release();
        await finalization.started; // By the failed bucket
      });

      afterEach(async () => {
        finalization.release();
        await streamError;
      });

      it('does not close the stream before the failed bucket has finalized the plugins', async () => {
        await new Promise(resolve => setImmediate(resolve)); // Long enough for a premature close to happen
        expect(stream.closed).toBe(false);
      });

      it('finalizes the plugins exactly once', async () => {
        finalization.release();
        await streamError;
        expect(plugin.processCloseStream).toHaveBeenCalledOnce();
      });

      it('tells the plugins the failure of the bucket', () => {
        expect(plugin.processCloseStream).toHaveBeenCalledWith(stopError);
      });

      // pipeline() rejects with the error upstream, which came first: pipeline.helper prefers the stream's failure, main() sees the stop
      it('reports the failure of the bucket, not the error it was destroyed with', async () => {
        finalization.release();
        expect(await streamError).toBe(stopError);
      });

      it('exposes the failure of the bucket as its failure', () => {
        expect(stream.failure).toBe(stopError);
      });

      it('logs the failure of the bucket', () => {
        expect(warning).toHaveBeenCalledWith(
          'stream',
          'Application stopped gracefully: [STRATEGY] Max consecutive order errors reached (5)',
        );
      });

      it('logs the error it was destroyed with as well', () => {
        expect(error).toHaveBeenCalledWith('stream', 'Gekko is closing the application due to an error: Error: download failed');
      });

      it('logs the deferred events dropped once, as the failed bucket does', async () => {
        finalization.release();
        await streamError;
        const droppedEventsLog =
          'Deferred events dropped as the application closes, the final reports may miss them: Trader (orderCompleted: 1)';
        expect(vi.mocked(warning).mock.calls.filter(([, message]) => message === droppedEventsLog)).toHaveLength(1);
      });
    });

    describe('when a stream upstream fails while the plugins are finalized after an ApplicationStopError', () => {
      const stopError = new ApplicationStopError('strategy', 'circuit breaker');
      const sourceError = new Error('download failed');
      let plugins: Plugin[];
      let rejection: unknown;
      let reported: unknown;
      let failure: unknown;

      beforeEach(async () => {
        const finalizationStarted = createGate();
        const finalizationGate = createGate();
        plugins = [
          createPluginStub({ processInputStream: throwing(stopError) }),
          createPluginStub({
            processCloseStream: vi.fn(async () => {
              finalizationStarted.open();
              await finalizationGate.promise;
            }),
          }),
        ];
        async function* failingSource() {
          yield BUCKET;
          await finalizationStarted.promise;
          setTimeout(finalizationGate.open, 10);
          throw sourceError;
        }
        const stream = new PluginsStream(plugins);
        stream.on('error', reason => (reported = reason));

        rejection = await pipeline(Readable.from(failingSource()), stream).catch((reason: unknown) => reason);
        failure = stream.failure;
      });

      // pipeline() keeps the first error of the chain: the caller has to read the stream's failure to see the stop
      it('rejects the pipeline with the error of the source, which came first', () => {
        expect(rejection).toBe(sourceError);
      });

      it('emits the ApplicationStopError', () => {
        expect(reported).toBe(stopError);
      });

      it('exposes the ApplicationStopError as its failure', () => {
        expect(failure).toBe(stopError);
      });

      it.each`
        index
        ${0}
        ${1}
      `('finalizes the plugin $index exactly once', ({ index }) => {
        expect(plugins[index].processCloseStream).toHaveBeenCalledOnce();
      });
    });

    describe('when a failure upstream destroys it, with deferred events queued for the next bucket', () => {
      const DROPPED_EVENTS_LOG =
        'Deferred events dropped as the application closes, the final reports may miss them: TradingAdvisor (strategyCreateOrder: 1)';
      let advisor: Plugin;

      beforeEach(async () => {
        advisor = createEmittingPluginStub('TradingAdvisor');
        const trader = createEmittingPluginStub('Trader');
        // A strategy placing an order on a fill: it is queued on the advisor, flushed before the Trader, for the next bucket
        trader.on('orderCompleted', () => advisor.addDeferredEmit('strategyCreateOrder', { id: 2 }));
        advisor.on('strategyCreateOrder', noop);
        vi.mocked(trader.processInputStream).mockImplementation(async () => trader.addDeferredEmit('orderCompleted', { id: 1 }));
        const stream = new PluginsStream([advisor, trader]);
        await writeBucket(stream);

        const streamError = waitForError(stream);
        stream.destroy(new Error('download failed'));
        await streamError;
      });

      it('logs them, per plugin, as a warning', () => {
        expect(warning).toHaveBeenCalledWith('stream', DROPPED_EVENTS_LOG);
      });

      it('logs them after the reason the application closes', () => {
        const [reasonCallOrder] = vi.mocked(error).mock.invocationCallOrder;
        const [droppedCallOrder] = vi.mocked(warning).mock.invocationCallOrder;
        expect(reasonCallOrder).toBeLessThan(droppedCallOrder);
      });

      it('logs them before finalizing the plugins, for the last flush of Supervision to send them', () => {
        const [droppedCallOrder] = vi.mocked(warning).mock.invocationCallOrder;
        const [finalizeCallOrder] = vi.mocked(advisor.processCloseStream).mock.invocationCallOrder;
        expect(droppedCallOrder).toBeLessThan(finalizeCallOrder);
      });
    });

    describe('when _construct fails on the second of three plugins', () => {
      const initError = new Error('init failed');
      let plugins: Plugin[];
      let rejection: unknown;

      beforeEach(async () => {
        plugins = [createPluginStub(), createPluginStub({ processInitStream: throwing(initError) }), createPluginStub()];

        rejection = await runPipeline([BUCKET], plugins);
      });

      it('rejects the pipeline with the init error', () => {
        expect(rejection).toBe(initError);
      });

      it('logs why the application closes', () => {
        expect(error).toHaveBeenCalledWith('stream', 'Gekko is closing the application due to an error: Error: init failed');
      });

      it.each`
        index | outcome                | plugin                 | calls
        ${0}  | ${'finalizes'}         | ${'initialized'}       | ${1}
        ${1}  | ${'does not finalize'} | ${'whose init failed'} | ${0}
        ${2}  | ${'does not finalize'} | ${'never initialized'} | ${0}
      `('$outcome the plugin $plugin', ({ index, calls }) => {
        expect(plugins[index].processCloseStream).toHaveBeenCalledTimes(calls);
      });
    });

    it('does not finalize the plugins again after a normal end', async () => {
      const plugin = createPluginStub();

      await runPipeline([BUCKET], [plugin]);

      expect(plugin.processCloseStream).toHaveBeenCalledOnce();
    });

    it('logs no error after a normal end', async () => {
      await runPipeline([BUCKET], [createPluginStub()]);

      expect(error).not.toHaveBeenCalled();
    });

    it('logs no event dropped after a normal end, even with events left queued', async () => {
      const plugin = createPluginStub({ countUndeliveredPayloads: vi.fn(() => new Map([['strategyCreateOrder', 1]])) });

      await runPipeline([BUCKET], [plugin]);

      expect(warning).not.toHaveBeenCalled();
    });

    it('logs no event dropped when destroyed without an error, even with events left queued', async () => {
      const stream = new PluginsStream([
        createPluginStub({ countUndeliveredPayloads: vi.fn(() => new Map([['strategyCreateOrder', 1]])) }),
      ]);

      stream.destroy();
      await new Promise(resolve => stream.once('close', resolve));

      expect(warning).not.toHaveBeenCalled();
    });

    describe('when logging the failed finalization throws', () => {
      const sourceError = new Error('download failed');

      const failWhileFinalizationThrows = (thrown: unknown) => {
        failToLogFinalizationFailure(thrown);
        const bucketProcessed = createGate();
        const plugin = createPluginStub({
          processInputStream: vi.fn(async () => bucketProcessed.open()),
          processCloseStream: throwing(new Error('finalize failed')),
        });
        async function* failingSource() {
          yield BUCKET;
          await bucketProcessed.promise;
          throw sourceError;
        }
        return runPipeline(failingSource(), [plugin]);
      };

      it('still rejects the pipeline with the error of the source', async () => {
        expect(await failWhileFinalizationThrows(new Error('log down'))).toBe(sourceError);
      });

      it.each`
        kind               | thrown
        ${'an Error'}      | ${new Error('log down')}
        ${'another value'} | ${'log down'}
      `('logs the failure as a warning when the logger throws $kind', async ({ thrown }) => {
        await failWhileFinalizationThrows(thrown);

        expect(warning).toHaveBeenLastCalledWith('stream', 'Finalization errors: log down');
      });
    });
  });
});
