import { gekkoPipeline } from '@gekko/core/core/pipeline/pipeline';
import { error, useWriteLock } from '@gekko/core/logger/logger';
import { createRunContext } from '@gekko/core/run/runContext.helper';
import type { RunContext } from '@gekko/core/run/runContext.types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Template, VariantRequest, VariantResult } from '../fox.types';

vi.mock('@gekko/core/core/pipeline/pipeline', () => ({ gekkoPipeline: vi.fn() }));
vi.mock('@gekko/core/run/runContext.helper', () => ({ createRunContext: vi.fn() }));
// The lines of logFailure, which the worker logs a rejection left unhandled and an uncaught exception with, as the bot does
vi.mock('@gekko/core/logger/logger', () => ({ useWriteLock: vi.fn(), debug: vi.fn(), error: vi.fn() }));
// The registry the worker hands the pipeline: the plugins' own modules load bun:sqlite, which vitest, on Node, cannot
vi.mock('@gekko/plugins/index', () => ({ Trader: 'the Trader class' }));

/** The global scope of a worker, which the worker module gives its message handler */
type WorkerScope = { onmessage?: (event: { data: VariantRequest }) => void };

const CONFIGURATION: Template = { watch: { mode: 'backtest' } };
/** The lock of stdout Fox's main thread shares, which it posts to the worker with the variant */
const WRITE_LOCK = new SharedArrayBuffer(8);

/** The listener the worker registered for a process event, which the process.on spy captured instead of registering */
const handlerOf = (event: string) => {
  const registration = vi.mocked(process.on).mock.calls.find(([name]) => name === event);
  if (!registration) throw new Error(`the worker registered no '${event}' handler`);
  return registration[1];
};

/** Lets the timers due run, those a test armed included */
const turnEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

describe('gekko.worker', () => {
  let scope: WorkerScope;
  let context: RunContext;
  /** Settles with what the worker posts */
  let posted: Promise<VariantResult>;

  /** Posts the variant to the worker, and settles with what it posts back */
  const backtest = async (variant = 3) => {
    scope.onmessage?.({ data: { variant, configuration: CONFIGURATION, writeLock: WRITE_LOCK } });
    return posted;
  };

  beforeEach(async () => {
    context = {
      configuration: {} as RunContext['configuration'],
      services: { closeStorage: vi.fn(), exchange: vi.fn(), storage: vi.fn() },
    };
    vi.mocked(createRunContext).mockReturnValue(context);
    vi.mocked(gekkoPipeline).mockResolvedValue(undefined);
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(4000);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // The worker registers process-level handlers: capture them, so that none is left on the vitest process
    vi.spyOn(process, 'on').mockImplementation(() => process);
    scope = {};
    vi.stubGlobal('self', scope);
    posted = new Promise(resolve => vi.stubGlobal('postMessage', vi.fn(resolve)));
    // The module sets the handler of the scope it runs in as it is evaluated: a fresh copy for each test
    vi.resetModules();
    await import('./gekko.worker');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Each line whole, none cut by another thread's, none left to write as the worker exits, which Fox's terminate() would cut short
  it('should write its lines under the lock of stdout it is posted', async () => {
    await backtest();

    expect(useWriteLock).toHaveBeenCalledExactlyOnceWith(WRITE_LOCK);
  });

  it('should take that lock before it builds the context of the backtest', async () => {
    await backtest();

    expect(vi.mocked(useWriteLock).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(createRunContext).mock.invocationCallOrder[0]);
  });

  describe('when the backtest ends normally', () => {
    it('should build the context of the variant from its configuration', async () => {
      await backtest();

      expect(createRunContext).toHaveBeenCalledExactlyOnceWith(CONFIGURATION, 'variant 3');
    });

    it('should run the pipeline on that context', async () => {
      await backtest();

      expect(vi.mocked(gekkoPipeline).mock.calls[0][0].context).toBe(context);
    });

    it('should run the pipeline with the plugins of the registry', async () => {
      await backtest();

      expect(vi.mocked(gekkoPipeline).mock.calls[0][0].plugins).toMatchObject({ Trader: 'the Trader class' });
    });

    it('should post that it is done, with its duration', async () => {
      expect(await backtest()).toStrictEqual({ variant: 3, status: 'done', durationMs: 3000 });
    });

    it('should close the storage', async () => {
      await backtest();

      expect(context.services.closeStorage).toHaveBeenCalledOnce();
    });

    it('should exit once it posted', async () => {
      await backtest();

      expect(vi.mocked(process.exit).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(postMessage).mock.invocationCallOrder[0]);
    });
  });

  describe('when the backtest fails', () => {
    beforeEach(async () => {
      const { GekkoError } = await import('@gekko/shared/errors/gekko.error');
      vi.mocked(gekkoPipeline).mockRejectedValue(new GekkoError('pipeline', 'Missing candles in database'));
    });

    it('should post the failure as describeError writes it', async () => {
      expect(await backtest()).toStrictEqual({ variant: 3, status: 'failed', error: 'Missing candles in database', durationMs: 3000 });
    });

    it('should close the storage all the same', async () => {
      await backtest();

      expect(context.services.closeStorage).toHaveBeenCalledOnce();
    });

    it('should exit', async () => {
      await backtest();

      expect(process.exit).toHaveBeenCalledExactlyOnceWith();
    });
  });

  describe('when the configuration is refused', () => {
    beforeEach(async () => {
      const { GekkoError } = await import('@gekko/shared/errors/gekko.error');
      vi.mocked(createRunContext).mockImplementation(() => {
        throw new GekkoError('configuration', 'Invalid configuration variant 3');
      });
    });

    it('should post the refusal', async () => {
      expect(await backtest()).toStrictEqual({ variant: 3, status: 'failed', error: 'Invalid configuration variant 3', durationMs: 3000 });
    });

    it('should not run the pipeline', async () => {
      await backtest();

      expect(gekkoPipeline).not.toHaveBeenCalled();
    });
  });

  describe('when the backtest fails unexpectedly', () => {
    const failure = new TypeError("Cannot read properties of undefined (reading 'close')", { cause: new Error('no candle') });

    beforeEach(() => {
      vi.mocked(gekkoPipeline).mockRejectedValue(failure);
    });

    it('should post the failure with its stack and its causes', async () => {
      expect(await backtest()).toStrictEqual({
        variant: 3,
        status: 'failed',
        error: "Cannot read properties of undefined (reading 'close')",
        stack: expect.stringMatching(
          /^TypeError: Cannot read properties of undefined \(reading 'close'\)\n {4}at [\s\S]+\nCaused by: Error: no candle\n {4}at /,
        ),
        durationMs: 3000,
      });
    });
  });

  // The pipeline wraps an exception of a strategy's end() in the GekkoError of the TradingAdvisor that failed to finalize: its message
  // says what failed, its cause where. The worker posted the message alone
  describe('when the backtest fails with a GekkoError that has a cause', () => {
    const cause = Object.assign(new TypeError("undefined is not an object (evaluating 'candle.close')"), {
      stack: "TypeError: undefined is not an object (evaluating 'candle.close')\n    at end (thrower.strategy.ts:13:39)",
    });

    beforeEach(async () => {
      const { GekkoError } = await import('@gekko/shared/errors/gekko.error');
      vi.mocked(gekkoPipeline).mockRejectedValue(
        new GekkoError('stream', `TradingAdvisor failed to finalize: ${cause.message}`, { cause }),
      );
    });

    it('should post its message, then what caused it, with its stack', async () => {
      expect(await backtest()).toStrictEqual({
        variant: 3,
        status: 'failed',
        error: "TradingAdvisor failed to finalize: undefined is not an object (evaluating 'candle.close')",
        stack: [
          "[STREAM] TradingAdvisor failed to finalize: undefined is not an object (evaluating 'candle.close')",
          "Caused by: TypeError: undefined is not an object (evaluating 'candle.close')",
          '    at end (thrower.strategy.ts:13:39)',
        ].join('\n'),
        durationMs: 3000,
      });
    });
  });

  // util.inspect, which the worker posted, cuts a chain after two causes
  it('should post every cause of a failure, down to the root', async () => {
    vi.mocked(gekkoPipeline).mockRejectedValue(
      new Error('level 1', { cause: new Error('level 2', { cause: new Error('level 3', { cause: new Error('the root cause') }) }) }),
    );

    expect((await backtest()).stack).toMatch(/\nCaused by: Error: the root cause\n/);
  });

  it('should post no stack for a failure that is no Error, which its message says all of', async () => {
    vi.mocked(gekkoPipeline).mockRejectedValue('a text');

    expect(await backtest()).toStrictEqual({ variant: 3, status: 'failed', error: 'a text', durationMs: 3000 });
  });

  it('should post a failure when the storage cannot be closed', async () => {
    vi.mocked(context.services.closeStorage).mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(await backtest()).toStrictEqual({
      variant: 3,
      status: 'failed',
      error: 'Could not close the storage: database is locked',
      stack: expect.stringMatching(/^Could not close the storage: Error: database is locked\n {4}at /),
      durationMs: 3000,
    });
  });

  it('should post both failures when the backtest and the close of the storage fail', async () => {
    vi.mocked(gekkoPipeline).mockRejectedValue(new Error('boom'));
    vi.mocked(context.services.closeStorage).mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect((await backtest()).error).toBe('boom; Could not close the storage: database is locked');
  });

  // As the bot's main() does, before anything can fail: a rejection left unhandled, a throw in a timer
  it('should register its process handlers before it builds the context of the backtest', async () => {
    await backtest();

    expect(vi.mocked(process.on).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(createRunContext).mock.invocationCallOrder[0]);
  });

  // The bot logs it without stopping and exits 1 once its run is over: Fox's worker died with it, which cut its backtest short, or, with
  // no macrotask left before its exit, never heard of it and posted the variant done
  describe('when a rejection is left unhandled during the backtest', () => {
    const reason = new Error('floating rejection');
    /** Called as the backtest ends, after the rejection */
    const backtestEnded = vi.fn();

    beforeEach(() => {
      vi.mocked(gekkoPipeline).mockImplementation(async () => {
        handlerOf('unhandledRejection')(reason);
        await turnEventLoop();
        backtestEnded();
      });
    });

    it('should log it as the bot does', async () => {
      await backtest();

      expect(error).toHaveBeenCalledExactlyOnceWith(
        'gekko',
        expect.stringMatching(/^Unhandled rejection: Error: floating rejection\n {4}at /),
      );
    });

    it('should go on with the backtest, and post once it is over', async () => {
      await backtest();

      expect(backtestEnded.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(postMessage).mock.invocationCallOrder[0]);
    });

    it('should post the variant failed, naming the rejection, with its stack', async () => {
      expect(await backtest()).toStrictEqual({
        variant: 3,
        status: 'failed',
        error: 'Unhandled rejection: floating rejection',
        stack: expect.stringMatching(/^Unhandled rejection: Error: floating rejection\n {4}at /),
        durationMs: 3000,
      });
    });
  });

  // A strategy that floats a rejection on every candle: the first named, the others counted, rather than a line of thousands
  it('should name the first rejection left unhandled and count the others', async () => {
    vi.mocked(gekkoPipeline).mockImplementation(async () => {
      for (const message of ['first', 'second', 'third']) handlerOf('unhandledRejection')(message);
    });

    expect((await backtest()).error).toBe('Unhandled rejection: first (and 2 more)');
  });

  it('should name the failure of the backtest before a rejection left unhandled', async () => {
    vi.mocked(gekkoPipeline).mockImplementation(async () => {
      handlerOf('unhandledRejection')('floating rejection');
      throw new Error('boom');
    });

    expect((await backtest()).error).toBe('boom; Unhandled rejection: floating rejection');
  });

  // The bot logs it, closes its storage and exits 1 at once, without finalising its plugins
  describe('when an exception is not caught during the backtest', () => {
    const exception = new Error('thrown in a timer');

    beforeEach(() => {
      // The backtest in progress, which the exception ends
      vi.mocked(gekkoPipeline).mockReturnValue(new Promise(() => {}));
    });

    /** Posts the variant to the worker, then throws in one of its timers, and settles with what the worker posts back */
    const backtestThrowing = async () => {
      scope.onmessage?.({ data: { variant: 3, configuration: CONFIGURATION, writeLock: WRITE_LOCK } });
      handlerOf('uncaughtException')(exception);
      return posted;
    };

    it('should log it as the bot does', async () => {
      await backtestThrowing();

      expect(error).toHaveBeenCalledExactlyOnceWith(
        'gekko',
        expect.stringMatching(/^Uncaught exception: Error: thrown in a timer\n {4}at /),
      );
    });

    it('should post the variant failed at once, with the exception and its stack', async () => {
      expect(await backtestThrowing()).toStrictEqual({
        variant: 3,
        status: 'failed',
        error: 'Uncaught exception: thrown in a timer',
        stack: expect.stringMatching(/^Uncaught exception: Error: thrown in a timer\n {4}at /),
        durationMs: 3000,
      });
    });

    it('should close the storage', async () => {
      await backtestThrowing();

      expect(context.services.closeStorage).toHaveBeenCalledOnce();
    });

    it('should exit once it posted', async () => {
      await backtestThrowing();

      expect(vi.mocked(process.exit).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(postMessage).mock.invocationCallOrder[0]);
    });
  });

  // process.exit() ends a worker at once, but not the mock of a test: the backtest that goes on posts nothing more
  it('should post its outcome once when an exception is not caught as the backtest goes on', async () => {
    vi.mocked(gekkoPipeline).mockImplementation(async () => {
      handlerOf('uncaughtException')(new Error('thrown in a timer'));
    });
    await backtest();
    await turnEventLoop();
    await turnEventLoop();

    expect(postMessage).toHaveBeenCalledOnce();
  });

  // A backtest yields to the event loop only as it ends, and not at all without a PerformanceReporter: the worker posted, and exited,
  // before the timers the run left due, and the rejections Bun reports at the end of a task, could come
  describe('when the backtest leaves something due as it ends', () => {
    it('should let a timer it left due throw before it posts its outcome', async () => {
      vi.mocked(gekkoPipeline).mockImplementation(async () => {
        setTimeout(() => handlerOf('uncaughtException')(new Error('thrown in a timer')), 0);
      });

      expect((await backtest()).error).toBe('Uncaught exception: thrown in a timer');
    });

    it('should let a rejection it left unhandled be reported before it posts its outcome', async () => {
      vi.mocked(gekkoPipeline).mockImplementation(async () => {
        setTimeout(() => handlerOf('unhandledRejection')('floating rejection'), 0);
      });

      expect((await backtest()).error).toBe('Unhandled rejection: floating rejection');
    });

    it('should let them come after a failed backtest too', async () => {
      vi.mocked(gekkoPipeline).mockImplementation(async () => {
        setTimeout(() => handlerOf('unhandledRejection')('floating rejection'), 0);
        throw new Error('boom');
      });

      expect((await backtest()).error).toBe('boom; Unhandled rejection: floating rejection');
    });
  });
});
