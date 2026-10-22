import { gekkoPipeline } from '@gekko/core/core/pipeline/pipeline';
import { createRunContext } from '@gekko/core/run/runContext.helper';
import type { RunContext } from '@gekko/core/run/runContext.types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Template, VariantRequest, VariantResult } from '../fox.types';

vi.mock('@gekko/core/core/pipeline/pipeline', () => ({ gekkoPipeline: vi.fn() }));
vi.mock('@gekko/core/run/runContext.helper', () => ({ createRunContext: vi.fn() }));
// The registry the worker hands the pipeline: the plugins' own modules load bun:sqlite, which vitest, on Node, cannot
vi.mock('@gekko/plugins/index', () => ({ Trader: 'the Trader class' }));

/** The global scope of a worker, which the worker module gives its message handler */
type WorkerScope = { onmessage?: (event: { data: VariantRequest }) => void };

const CONFIGURATION: Template = { watch: { mode: 'backtest' } };

describe('gekko.worker', () => {
  let scope: WorkerScope;
  let context: RunContext;
  /** Settles with what the worker posts */
  let posted: Promise<VariantResult>;

  /** Posts the variant to the worker, and settles with what it posts back */
  const backtest = async (variant = 3) => {
    scope.onmessage?.({ data: { variant, configuration: CONFIGURATION } });
    return posted;
  };

  beforeEach(async () => {
    context = {
      configuration: {} as RunContext['configuration'],
      services: { closeStorage: vi.fn(), exchange: vi.fn(), storage: vi.fn() },
    };
    vi.mocked(createRunContext).mockReturnValue(context);
    vi.mocked(gekkoPipeline).mockResolvedValue([]);
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(4000);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
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
    beforeEach(() => {
      vi.mocked(createRunContext).mockImplementation(() => {
        throw new Error('Invalid configuration variant 3');
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

  it('should post a failure when the storage cannot be closed', async () => {
    vi.mocked(context.services.closeStorage).mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(await backtest()).toStrictEqual({
      variant: 3,
      status: 'failed',
      error: 'Could not close the storage: database is locked',
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
});
