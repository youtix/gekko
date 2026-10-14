import { config } from '@services/configuration/configuration';
import { gekkoPipeline } from '@services/core/pipeline/pipeline';
import { inject } from '@services/injecter/injecter';
import { debug, error, warning } from '@services/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/configuration/configuration', () => ({ config: { showLogo: vi.fn() } }));
vi.mock('@services/core/pipeline/pipeline', () => ({ gekkoPipeline: vi.fn() }));
vi.mock('@services/injecter/injecter', () => ({ inject: { storage: vi.fn(), closeStorage: vi.fn() } }));
vi.mock('@services/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));

/** The listener gekko2.ts registered for a process event, which the process.on spy captured instead of registering */
const handlerOf = (event: string) => {
  const registration = vi.mocked(process.on).mock.calls.find(([name]) => name === event);
  if (!registration) throw new Error(`gekko2.ts registered no '${event}' handler`);
  return registration[1];
};

/** Imports gekko2.ts with a pipeline that never ends, as in realtime mode, and resolves once the pipeline has started */
const startRealtimeRun = () =>
  new Promise<void>(started => {
    vi.mocked(gekkoPipeline).mockImplementation(() => {
      started();
      return new Promise<never>(() => {});
    });
    void import('./gekko2'); // never settles, like `await main()` in a realtime run
  });

describe('main', () => {
  let initialExitCode: typeof process.exitCode;

  beforeEach(() => {
    // gekko2.ts runs `await main()` when it is imported: every test imports a fresh copy of it
    vi.resetModules();
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // gekko2.ts registers process-level handlers: capture them, so that none is left on the vitest process
    vi.spyOn(process, 'on').mockImplementation(() => process);
    initialExitCode = process.exitCode;
  });

  afterEach(() => {
    vi.restoreAllMocks(); // the process.exit, process.on and console.log spies
    process.exitCode = initialExitCode;
  });

  describe('when the pipeline ends normally', () => {
    beforeEach(async () => {
      vi.mocked(gekkoPipeline).mockResolvedValue([]);
      await import('./gekko2');
    });

    it('does not call process.exit', () => {
      expect(process.exit).not.toHaveBeenCalled();
    });

    it('closes the storage', () => {
      expect(inject.closeStorage).toHaveBeenCalledOnce();
    });
  });

  describe('when no storage is configured', () => {
    beforeEach(() => {
      // Importer mode without CandleWriter: the factory would throw, as the real one does
      vi.mocked(gekkoPipeline).mockResolvedValue([]);
      vi.mocked(inject.storage).mockImplementation(() => {
        throw new Error('[INJECTER] Missing or unknown storage.');
      });
    });

    it('ends the run without an error', async () => {
      await expect(import('./gekko2')).resolves.toBeDefined();
    });

    it('does not create a storage to close it', async () => {
      await import('./gekko2');

      expect(inject.storage).not.toHaveBeenCalled();
    });
  });

  describe('when the configuration cannot be loaded', () => {
    beforeEach(async () => {
      // The real module, which builds `config` when it is evaluated: without a file to read, its evaluation throws a GekkoError
      vi.doUnmock('@services/configuration/configuration');
      vi.stubEnv('GEKKO_CONFIG_FILE_PATH', undefined);
      await import('./gekko2');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.doMock('@services/configuration/configuration', () => ({ config }));
    });

    it('logs its one-line message at error level', () => {
      expect(error).toHaveBeenCalledWith('gekko', '[CONFIGURATION] Missing GEKKO_CONFIG_FILE_PATH environment variable');
    });

    it('logs its stack at debug level', () => {
      expect(debug).toHaveBeenCalledWith(
        'gekko',
        expect.stringMatching(/^GekkoError: \[CONFIGURATION\] Missing GEKKO_CONFIG_FILE_PATH environment variable\n\s+at /),
      );
    });

    it('exits with code 1', () => {
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('does not start the pipeline', () => {
      expect(gekkoPipeline).not.toHaveBeenCalled();
    });
  });

  describe('when the pipeline stops with an ApplicationStopError', () => {
    beforeEach(async () => {
      // Imported after vi.resetModules(), so that it is the class gekko2.ts checks against
      const { ApplicationStopError } = await import('@errors/applicationStop.error');
      vi.mocked(gekkoPipeline).mockRejectedValue(new ApplicationStopError('strategy', 'Max consecutive order errors reached (5)'));
      await import('./gekko2');
    });

    it('logs the stop reason at error level', () => {
      expect(error).toHaveBeenCalledWith('gekko', 'Application stopped: [STRATEGY] Max consecutive order errors reached (5)');
    });

    it('logs nothing at debug level', () => {
      expect(debug).not.toHaveBeenCalled();
    });

    it('exits with code 0', () => {
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    });

    it('closes the storage before exiting', () => {
      const [closeCallOrder] = vi.mocked(inject.closeStorage).mock.invocationCallOrder;
      const [exitCallOrder] = vi.mocked(process.exit).mock.invocationCallOrder;
      expect(closeCallOrder).toBeLessThan(exitCallOrder);
    });
  });

  describe('when the pipeline stops with an ApplicationStopError after an unhandled rejection', () => {
    beforeEach(async () => {
      const { ApplicationStopError } = await import('@errors/applicationStop.error');
      vi.mocked(gekkoPipeline).mockImplementation(async () => {
        // As when a floated timer-driven task (an order poll) rejects before the breaker trips
        handlerOf('unhandledRejection')(new Error('binance fetchOrder failed: 503 Service Unavailable'));
        throw new ApplicationStopError('strategy', 'Max consecutive order errors reached (5)');
      });
      await import('./gekko2');
    });

    it('still exits with code 0', () => {
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    });
  });

  describe('when the pipeline fails with a GekkoError', () => {
    let failure: Error;

    beforeEach(async () => {
      // A subclass, imported after vi.resetModules() so that it extends the GekkoError gekko2.ts checks against
      const { MissingCandlesError } = await import('@services/core/stream/backtest/backtest.error');
      failure = new MissingCandlesError('BTC/USDT', { start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 0, 2) });
      vi.mocked(gekkoPipeline).mockRejectedValue(failure);
      await import('./gekko2');
    });

    it('logs its one-line message at error level', () => {
      expect(error).toHaveBeenCalledWith('gekko', failure.message);
    });

    it('logs its stack at debug level', () => {
      expect(debug).toHaveBeenCalledWith('gekko', failure.stack);
    });

    it('exits with code 1', () => {
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    });
  });

  describe('when the pipeline fails with a GekkoError that has a cause', () => {
    const cause = new Error('binance GET https://api.binance.com/api/v3/exchangeInfo 503 Service Unavailable');

    beforeEach(async () => {
      const { GekkoError } = await import('@errors/gekko.error');
      vi.mocked(gekkoPipeline).mockRejectedValue(new GekkoError('exchange', 'Could not load the markets', { cause }));
      await import('./gekko2');
    });

    it('logs its message, then its cause in full, at error level', () => {
      expect(error).toHaveBeenCalledWith('gekko', `[EXCHANGE] Could not load the markets\nCaused by: ${cause.stack}`);
    });
  });

  describe('when the pipeline fails with any other error', () => {
    // As when a strategy hook reads an indicator result that is still null (Bun's wording)
    const expression = 'results.value';
    const hookError = new TypeError(`null is not an object (evaluating '${expression}')`);

    beforeEach(async () => {
      vi.mocked(gekkoPipeline).mockRejectedValue(hookError);
      await import('./gekko2');
    });

    it('logs its name and message at error level', () => {
      expect(error).toHaveBeenCalledWith(
        'gekko',
        expect.stringMatching(/^TypeError: null is not an object \(evaluating 'results\.value'\)\n/),
      );
    });

    it('logs its stack frames at error level', () => {
      expect(error).toHaveBeenCalledWith('gekko', expect.stringMatching(/\n\s+at .*gekko2\.test\.ts:\d+:\d+/));
    });

    it('exits with code 1', () => {
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('closes the storage before exiting', () => {
      const [closeCallOrder] = vi.mocked(inject.closeStorage).mock.invocationCallOrder;
      const [exitCallOrder] = vi.mocked(process.exit).mock.invocationCallOrder;
      expect(closeCallOrder).toBeLessThan(exitCallOrder);
    });
  });

  describe('when the pipeline rejects with a value that is not an Error', () => {
    beforeEach(async () => {
      vi.mocked(gekkoPipeline).mockRejectedValue('raw failure');
      await import('./gekko2');
    });

    it('logs the value as is at error level', () => {
      expect(error).toHaveBeenCalledWith('gekko', 'raw failure');
    });

    it('exits with code 1', () => {
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    });
  });

  describe('failure report', () => {
    /** The error-level text of an error and its causes: the stack of each, outermost first */
    const causedBy = (...chain: Error[]) => chain.map(link => link.stack).join('\nCaused by: ');

    const noStack = Object.assign(new Error('Request timed out'), { stack: undefined });
    // Bun's DOMException stacks are frames only
    const framesOnly = Object.assign(new Error('The object can not be cloned.'), {
      name: 'DataCloneError',
      stack: 'structuredClone@[native code]\naddDeferredEmit@/app/src/plugins/plugin.ts:58:30',
    });
    const rangeError = new RangeError('Invalid time value');
    const withCause = new Error('Cannot build the warmup window', { cause: rangeError });
    const rejectedOrder = new Error('Order creation failed', { cause: { code: -2010, msg: 'Account has insufficient balance.' } });
    // Longer than the two causes util.inspect() shows by default
    const socketError = new Error('connect ECONNREFUSED 104.18.0.1:443');
    const requestError = new Error('fetch failed', { cause: socketError });
    const fetchError = new Error('binance fetchOHLCV failed', { cause: requestError });
    const warmupError = new Error('Could not fetch the warmup candles', { cause: fetchError });
    const loopStart = new Error('Order sync failed');
    const loopEnd = new Error('Order fetch failed', { cause: loopStart });
    loopStart.cause = loopEnd;

    it.each`
      kind                                   | failure                            | logged
      ${'an object that is not an Error'}    | ${{ status: 503, retryAfter: 30 }} | ${'{ status: 503, retryAfter: 30 }'}
      ${'an Error with no stack'}            | ${noStack}                         | ${'Error: Request timed out'}
      ${'an Error with a frames-only stack'} | ${framesOnly}                      | ${`DataCloneError: The object can not be cloned.\n${framesOnly.stack}`}
      ${'the cause of an Error'}             | ${withCause}                       | ${causedBy(withCause, rangeError)}
      ${'a cause that is not an Error'}      | ${rejectedOrder}                   | ${`${rejectedOrder.stack}\nCaused by: { code: -2010, msg: 'Account has insufficient balance.' }`}
      ${'every cause of a long chain'}       | ${warmupError}                     | ${causedBy(warmupError, fetchError, requestError, socketError)}
      ${'each cause of a loop once'}         | ${loopStart}                       | ${causedBy(loopStart, loopEnd)}
    `('logs $kind at error level', async ({ failure, logged }) => {
      vi.mocked(gekkoPipeline).mockRejectedValue(failure);
      await import('./gekko2');

      expect(error).toHaveBeenCalledWith('gekko', logged);
    });
  });

  describe('logo', () => {
    it.each`
      showLogo | printCount | outcome
      ${true}  | ${1}       | ${'prints'}
      ${false} | ${0}       | ${'does not print'}
    `('$outcome the logo when showLogo() returns $showLogo', async ({ showLogo, printCount }) => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.mocked(config.showLogo).mockReturnValue(showLogo);

      await import('./gekko2');

      expect(consoleLog).toHaveBeenCalledTimes(printCount);
    });
  });

  describe('process-level handlers', () => {
    it.each`
      event
      ${'uncaughtException'}
      ${'unhandledRejection'}
      ${'SIGINT'}
      ${'SIGTERM'}
    `('registers a $event handler before the pipeline starts', async ({ event }) => {
      vi.mocked(gekkoPipeline).mockResolvedValue([]);
      await import('./gekko2');

      const { calls, invocationCallOrder } = vi.mocked(process.on).mock;
      const registrationCallOrder = invocationCallOrder[calls.findIndex(([name]) => name === event)];
      const [pipelineCallOrder] = vi.mocked(gekkoPipeline).mock.invocationCallOrder;
      expect(registrationCallOrder).toBeLessThan(pipelineCallOrder);
    });
  });

  describe('on an uncaught exception during a realtime run', () => {
    const tickError = new Error('[CORE] Failed to tick in time');
    const onUncaughtException = () => handlerOf('uncaughtException')(tickError, 'uncaughtException');

    beforeEach(async () => {
      await startRealtimeRun();
    });

    describe('when the storage closes', () => {
      beforeEach(() => {
        onUncaughtException();
      });

      it('logs the exception with its stack at error level', () => {
        expect(error).toHaveBeenCalledWith('gekko', `Uncaught exception: ${tickError.stack}`);
      });

      it('exits with code 1', () => {
        expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
      });

      it('closes the storage before exiting', () => {
        const [closeCallOrder] = vi.mocked(inject.closeStorage).mock.invocationCallOrder;
        const [exitCallOrder] = vi.mocked(process.exit).mock.invocationCallOrder;
        expect(closeCallOrder).toBeLessThan(exitCallOrder);
      });
    });

    describe('when closing the storage throws', () => {
      beforeEach(() => {
        vi.mocked(inject.closeStorage).mockImplementation(() => {
          throw new Error('database is locked');
        });
      });

      it('does not throw', () => {
        expect(onUncaughtException).not.toThrow();
      });

      it('still exits with code 1', () => {
        onUncaughtException();
        expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
      });
    });
  });

  describe.each`
    signal       | exitCode
    ${'SIGINT'}  | ${130}
    ${'SIGTERM'} | ${143}
  `('on $signal during a realtime run', ({ signal, exitCode }) => {
    const onSignal = () => handlerOf(signal)(signal);

    beforeEach(async () => {
      await startRealtimeRun();
    });

    describe('when the storage closes', () => {
      beforeEach(() => {
        onSignal();
      });

      it('logs the signal at warning level', () => {
        expect(warning).toHaveBeenCalledWith('gekko', `Received ${signal}: closing the storage and exiting without finalising the plugins`);
      });

      it(`exits with code ${exitCode}`, () => {
        expect(process.exit).toHaveBeenCalledExactlyOnceWith(exitCode);
      });

      it('closes the storage before exiting', () => {
        const [closeCallOrder] = vi.mocked(inject.closeStorage).mock.invocationCallOrder;
        const [exitCallOrder] = vi.mocked(process.exit).mock.invocationCallOrder;
        expect(closeCallOrder).toBeLessThan(exitCallOrder);
      });
    });

    describe('when closing the storage throws', () => {
      const closeError = new Error('database is locked');

      beforeEach(() => {
        vi.mocked(inject.closeStorage).mockImplementation(() => {
          throw closeError;
        });
      });

      it('does not throw', () => {
        expect(onSignal).not.toThrow();
      });

      it('logs the failure at error level', () => {
        onSignal();
        expect(error).toHaveBeenCalledWith('gekko', `Could not close the storage: ${closeError.stack}`);
      });

      it(`still exits with code ${exitCode}`, () => {
        onSignal();
        expect(process.exit).toHaveBeenCalledExactlyOnceWith(exitCode);
      });
    });
  });

  describe('on an unhandled rejection during a realtime run', () => {
    const fetchError = new Error('binance GET https://api.binance.com/api/v3/klines 503 Service Unavailable');

    beforeEach(async () => {
      await startRealtimeRun();
    });

    describe('with an Error', () => {
      beforeEach(() => {
        handlerOf('unhandledRejection')(fetchError);
      });

      it('logs the rejection with its stack at error level', () => {
        expect(error).toHaveBeenCalledWith('gekko', `Unhandled rejection: ${fetchError.stack}`);
      });

      it('sets the exit code to 1', () => {
        expect(process.exitCode).toBe(1);
      });

      it('does not exit', () => {
        expect(process.exit).not.toHaveBeenCalled();
      });
    });

    it.each`
      kind                               | reason                                                                 | logged
      ${'an Error with no stack'}        | ${Object.assign(new Error('Request timed out'), { stack: undefined })} | ${'Unhandled rejection: Error: Request timed out'}
      ${'a value that is not an Error'}  | ${'socket hang up'}                                                    | ${'Unhandled rejection: socket hang up'}
      ${'an object without a prototype'} | ${Object.assign(Object.create(null), { status: 503 })}                 | ${'Unhandled rejection: [Object: null prototype] { status: 503 }'}
    `('logs $kind at error level', ({ reason, logged }) => {
      handlerOf('unhandledRejection')(reason);
      expect(error).toHaveBeenCalledWith('gekko', logged);
    });
  });

  describe.each`
    event                   | prefix
    ${'uncaughtException'}  | ${'Uncaught exception: '}
    ${'unhandledRejection'} | ${'Unhandled rejection: '}
  `('on a GekkoError reaching the $event handler', ({ event, prefix }) => {
    let failure: Error;

    beforeEach(async () => {
      await startRealtimeRun();
      const { GekkoError } = await import('@errors/gekko.error');
      failure = new GekkoError('core', 'Failed to tick in time');
      handlerOf(event)(failure);
    });

    it('logs its one-line message at error level', () => {
      expect(error).toHaveBeenCalledWith('gekko', `${prefix}[CORE] Failed to tick in time`);
    });

    it('logs its stack at debug level', () => {
      expect(debug).toHaveBeenCalledWith('gekko', `${prefix}${failure.stack}`);
    });
  });
});
