import { info } from '@gekko/core/logger/logger';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../package.json';
import { parseCommandLine } from './cli/cli.helper';
import { generateVariants, loadTemplate, validateVariants, warnOfUnreportedVariants } from './configuration/variants.helper';
import { logFailure } from '@gekko/core/logger/failure.helper';
import { WORKER_MODULE } from './fox.const';
import { logSummary } from './fox.helper';
import type { FoxOptions, Template, Variant, VariantResult } from './fox.types';
import { runWorkers } from './worker/worker.helper';

vi.mock('@gekko/core/logger/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('@gekko/shared/utils/process/process.utils', () => ({ logVersion: () => 'Gekko version: v2.0.0, Bun version: v1.3.14' }));
vi.mock('./cli/cli.helper', () => ({ parseCommandLine: vi.fn() }));
vi.mock('./configuration/variants.helper', () => ({
  generateVariants: vi.fn(),
  loadTemplate: vi.fn(),
  validateVariants: vi.fn(),
  warnOfUnreportedVariants: vi.fn(),
}));
vi.mock('@gekko/core/logger/failure.helper', () => ({ logFailure: vi.fn() }));
vi.mock('./fox.helper', () => ({ logSummary: vi.fn() }));
vi.mock('./worker/worker.helper', () => ({ runWorkers: vi.fn() }));

const OPTIONS: FoxOptions = { templatePath: 'dema.yml', maxWorkers: 4, overrides: { strategy: { period: [10, 20] } } };
const TEMPLATE: Template = { strategy: { name: 'DEMA', period: 12 } };
const VARIANTS: Variant[] = [
  { variant: 1, label: '--strategy.period 10', configuration: { strategy: { name: 'DEMA', period: 10 } } },
  { variant: 2, label: '--strategy.period 20', configuration: { strategy: { name: 'DEMA', period: 20 } } },
];
const RESULTS: VariantResult[] = [
  { variant: 1, status: 'done', durationMs: 1000 },
  { variant: 2, status: 'done', durationMs: 2000 },
];

/** The listener fox.ts registered for a process event, which the process.on spy captured instead of registering */
const handlerOf = (event: string) => {
  const registration = vi.mocked(process.on).mock.calls.find(([name]) => name === event);
  if (!registration) throw new Error(`fox.ts registered no '${event}' handler`);
  return registration[1];
};

describe('main', () => {
  let initialExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.mocked(parseCommandLine).mockReturnValue(OPTIONS);
    vi.mocked(loadTemplate).mockReturnValue(TEMPLATE);
    vi.mocked(generateVariants).mockReturnValue(VARIANTS);
    vi.mocked(runWorkers).mockResolvedValue(RESULTS);
    vi.mocked(logSummary).mockReturnValue(false);
    // fox.ts runs `await main()` when it is imported: every test imports a fresh copy of it
    vi.resetModules();
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    // fox.ts registers process-level handlers: capture them, so that none is left on the vitest process
    vi.spyOn(process, 'on').mockImplementation(() => process);
    initialExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = initialExitCode;
  });

  describe('when every variant is done', () => {
    beforeEach(async () => {
      await import('./fox');
    });

    it('should read the command line of the process', () => {
      expect(parseCommandLine).toHaveBeenCalledExactlyOnceWith(process.argv.slice(2), process.env);
    });

    it('should log the version, then the variants it backtests', () => {
      expect(vi.mocked(info).mock.calls).toStrictEqual([
        ['fox', 'Gekko version: v2.0.0, Bun version: v1.3.14'],
        ['fox', 'Backtesting 2 variants of dema.yml, 2 at a time'],
      ]);
    });

    it('should make the variants of the template', () => {
      expect(generateVariants).toHaveBeenCalledExactlyOnceWith(TEMPLATE, OPTIONS.overrides);
    });

    it('should read the template at its path', () => {
      expect(loadTemplate).toHaveBeenCalledExactlyOnceWith('dema.yml');
    });

    it('should check the variants before running them', () => {
      expect(vi.mocked(validateVariants).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runWorkers).mock.invocationCallOrder[0]);
    });

    it('should warn of the variants without a PerformanceReporter', () => {
      expect(warnOfUnreportedVariants).toHaveBeenCalledExactlyOnceWith(VARIANTS);
    });

    it('should warn of them once they are checked', () => {
      expect(vi.mocked(warnOfUnreportedVariants).mock.invocationCallOrder[0]).toBeGreaterThan(
        vi.mocked(validateVariants).mock.invocationCallOrder[0],
      );
    });

    it('should warn of them before running any', () => {
      expect(vi.mocked(warnOfUnreportedVariants).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(runWorkers).mock.invocationCallOrder[0],
      );
    });

    it('should run the variants in its workers', () => {
      expect(runWorkers).toHaveBeenCalledExactlyOnceWith(VARIANTS, 4, expect.any(String));
    });

    it('should log the summary of their results', () => {
      expect(logSummary).toHaveBeenCalledExactlyOnceWith(RESULTS);
    });

    it('should exit with code 0', () => {
      expect(process.exitCode).toBeUndefined();
    });

    it('should exit once the variants are over', () => {
      expect(process.exit).toHaveBeenCalledExactlyOnceWith();
    });
  });

  // Resolved from fox.ts's own URL, which names the worker from source and in the executable alike, the executable embedding it as an
  // entry point of its own at that path from the root of the bundle, the directory of fox.ts
  describe('the worker module', () => {
    /** The module the workers run, as main() gives it to runWorkers */
    const workerModuleUrl = async () => {
      await import('./fox');
      return String(vi.mocked(runWorkers).mock.calls[0][2]);
    };

    it('should be gekko.worker.ts, in the worker directory beside fox.ts', async () => {
      expect(await workerModuleUrl()).toMatch(/^file:\/\/.*\/apps\/fox\/src\/worker\/gekko\.worker\.ts$/);
    });

    it('should be a module that exists, run from source', async () => {
      expect(existsSync(fileURLToPath(await workerModuleUrl()))).toBe(true);
    });

    // Renamed or moved on one side only, every variant of dist/fox would fail, which no run of the sources shows
    it.each`
      entry
      ${'src/fox.ts'}
      ${path.join('src', WORKER_MODULE)}
    `('should be compiled into the executable by build:exec, beside fox.ts: $entry', ({ entry }) => {
      expect(packageJson.scripts['build:exec'].split(' ')).toContain(entry);
    });
  });

  it('should say how many variants run at once when fewer are asked for than there are', async () => {
    vi.mocked(parseCommandLine).mockReturnValue({ ...OPTIONS, maxWorkers: 1 });
    await import('./fox');

    expect(info).toHaveBeenLastCalledWith('fox', 'Backtesting 2 variants of dema.yml, 1 at a time');
  });

  it('should count a single variant', async () => {
    vi.mocked(generateVariants).mockReturnValue(VARIANTS.slice(0, 1));
    await import('./fox');

    expect(info).toHaveBeenLastCalledWith('fox', 'Backtesting 1 variant of dema.yml, 1 at a time');
  });

  it('should exit with code 1 when a variant failed', async () => {
    vi.mocked(logSummary).mockReturnValue(true);
    await import('./fox');

    expect(process.exitCode).toBe(1);
  });

  describe('when the help was printed', () => {
    beforeEach(async () => {
      vi.mocked(parseCommandLine).mockReturnValue(undefined);
      await import('./fox');
    });

    it('should read no template', () => {
      expect(loadTemplate).not.toHaveBeenCalled();
    });

    it('should log nothing', () => {
      expect(info).not.toHaveBeenCalled();
    });

    it('should exit with code 0', () => {
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('when a variant is refused', () => {
    const refusal = new GekkoError('fox', 'Variant 2 (--strategy.period 1) is invalid:\n✖ period must be at least 2');

    beforeEach(async () => {
      vi.mocked(validateVariants).mockImplementation(() => {
        throw refusal;
      });
      await import('./fox');
    });

    it('should report the refusal', () => {
      expect(logFailure).toHaveBeenCalledExactlyOnceWith('fox', refusal);
    });

    it('should run no variant', () => {
      expect(runWorkers).not.toHaveBeenCalled();
    });

    it('should not warn of the variants without a PerformanceReporter', () => {
      expect(warnOfUnreportedVariants).not.toHaveBeenCalled();
    });

    it('should exit with code 1', () => {
      expect(process.exitCode).toBe(1);
    });

    it('should exit', () => {
      expect(process.exit).toHaveBeenCalledExactlyOnceWith();
    });
  });

  it('should report what the command line refuses', async () => {
    const refusal = new GekkoError('fox', 'No template: give its path with --template-path <path> or FOX_TEMPLATE_PATH');
    vi.mocked(parseCommandLine).mockImplementation(() => {
      throw refusal;
    });
    await import('./fox');

    expect(logFailure).toHaveBeenCalledExactlyOnceWith('fox', refusal);
  });

  describe('on an uncaught exception', () => {
    const exception = new Error('boom');

    beforeEach(async () => {
      await import('./fox');
      handlerOf('uncaughtException')(exception);
    });

    it('should report it', () => {
      expect(logFailure).toHaveBeenCalledExactlyOnceWith('fox', exception, 'Uncaught exception: ');
    });

    it('should exit with code 1', () => {
      expect(process.exit).toHaveBeenLastCalledWith(1);
    });
  });

  describe('on an unhandled rejection', () => {
    const reason = new Error('network blip');

    beforeEach(async () => {
      await import('./fox');
      handlerOf('unhandledRejection')(reason);
    });

    it('should report it', () => {
      expect(logFailure).toHaveBeenCalledExactlyOnceWith('fox', reason, 'Unhandled rejection: ');
    });

    it('should set the exit code to 1', () => {
      expect(process.exitCode).toBe(1);
    });

    it('should not exit, but for the exit of main() once the variants are over', () => {
      expect(process.exit).toHaveBeenCalledOnce();
    });
  });
});
