import { debug, error, info } from '@gekko/core/logger/logger';
import { times } from 'lodash-es';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';
import { COMPILED_WORKER_MODULE } from '../fox.const';
import type { Template, Variant, VariantResult } from '../fox.types';
import { describeWorkerError, runWorker, runWorkers, workerModule } from './worker.helper';

vi.mock('@gekko/core/logger/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));

type Listener = (event: Record<string, unknown>) => void;

/**
 * A stand-in for Bun's Worker: it records how it was created, what it was posted and whether it was terminated, and dispatches the
 * events a test gives it. With an `answer`, it posts back what answer gives for the request, after the delay the answer gives.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static answer?: (request: { variant: number; configuration: Template }) => { result: VariantResult; delayMs: number };
  static running = 0;
  static mostRunning = 0;

  readonly posted: unknown[] = [];
  readonly listeners: Record<string, Listener[]> = {};
  isTerminated = false;

  constructor(readonly module: string) {
    FakeWorker.instances.push(this);
    FakeWorker.running += 1;
    FakeWorker.mostRunning = Math.max(FakeWorker.mostRunning, FakeWorker.running);
  }

  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  dispatch(type: string, event: Record<string, unknown>) {
    this.listeners[type]?.forEach(listener => listener(event));
  }

  postMessage(request: { variant: number; configuration: Template }) {
    this.posted.push(request);
    if (!FakeWorker.answer) return;
    const { result, delayMs } = FakeWorker.answer(request);
    setTimeout(() => this.dispatch('message', { data: result }), delayMs);
  }

  terminate() {
    if (!this.isTerminated) FakeWorker.running -= 1;
    this.isTerminated = true;
    this.dispatch('close', { code: 0 });
  }
}

const done = (variant: number, durationMs = 2000): VariantResult => ({ variant, status: 'done', durationMs });

describe('workerModule', () => {
  it.each`
    description                  | moduleUrl                                                       | expected
    ${'the compiled executable'} | ${'file:///$bunfs/root/fox'}                                    | ${'./worker/gekko.worker.ts'}
    ${'a run from source'}       | ${'file:///home/me/gekko/apps/fox/src/worker/worker.helper.ts'} | ${'file:///home/me/gekko/apps/fox/src/worker/gekko.worker.ts'}
  `('should find the worker of $description', ({ moduleUrl, expected }) => {
    expect(workerModule(moduleUrl)).toBe(expected);
  });

  // The executable embeds the entry points build:exec names, and Bun resolves a worker from the root of the bundle, src/fox.ts's
  // directory: renamed on one side only, every variant of dist/fox would fail, which no run of the sources shows
  it.each`
    entry
    ${'src/fox.ts'}
    ${path.join('src', COMPILED_WORKER_MODULE)}
  `('should be compiled into the executable by build:exec: $entry', ({ entry }) => {
    expect(packageJson.scripts['build:exec'].split(' ')).toContain(entry);
  });
});

describe('describeWorkerError', () => {
  /** The message of the error event of a worker whose timer threw, as Bun writes it */
  const BUN_MESSAGE = [
    '4 |   await wait(10);',
    "5 |   if (failing) throw new Error('boom');",
    '                                   ^',
    'error: boom',
    '      at <anonymous> (/app/src/worker/gekko.worker.ts:5:36)',
    '',
  ].join('\n');

  it.each`
    description                        | message            | expected
    ${'an error under its code frame'} | ${BUN_MESSAGE}     | ${'error: boom\n      at <anonymous> (/app/src/worker/gekko.worker.ts:5:36)'}
    ${'a value thrown as it is'}       | ${'a plain value'} | ${'a plain value'}
  `('should keep $description', ({ message, expected }) => {
    expect(describeWorkerError(message)).toBe(expected);
  });
});

describe('runWorker', () => {
  const configuration: Template = { watch: { mode: 'backtest' } };
  let outcome: Promise<VariantResult>;
  let worker: FakeWorker;

  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.answer = undefined;
    vi.stubGlobal('Worker', FakeWorker);
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(3500);
    outcome = runWorker(3, configuration);
    [worker] = FakeWorker.instances;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should start the worker module beside its own', () => {
    expect(worker.module).toMatch(/\/src\/worker\/gekko\.worker\.ts$/);
  });

  it('should start a worker module that exists, run from source', () => {
    expect(existsSync(fileURLToPath(worker.module))).toBe(true);
  });

  it('should post the variant to the worker', () => {
    expect(worker.posted).toStrictEqual([{ variant: 3, configuration }]);
  });

  describe('when the worker posts its result', () => {
    beforeEach(() => {
      worker.dispatch('message', { data: done(3) });
    });

    it('should give that result', async () => {
      expect(await outcome).toStrictEqual(done(3));
    });

    it('should terminate the worker', () => {
      expect(worker.isTerminated).toBe(true);
    });
  });

  it('should give a failure for an error of the worker, without its code frame', async () => {
    worker.dispatch('error', { message: "5 |   throw new Error('boom');\n          ^\nerror: boom" });

    expect(await outcome).toStrictEqual({ variant: 3, status: 'failed', error: 'error: boom', durationMs: 2500 });
  });

  it('should terminate a worker that failed', () => {
    worker.dispatch('error', { message: 'boom' });

    expect(worker.isTerminated).toBe(true);
  });

  it('should give a failure for a worker that ended without a result', async () => {
    worker.dispatch('close', { code: 3 });

    expect(await outcome).toStrictEqual({
      variant: 3,
      status: 'failed',
      error: 'its worker ended with code 3 without reporting an outcome',
      durationMs: 2500,
    });
  });

  it('should keep the first outcome', async () => {
    worker.dispatch('message', { data: done(3) });
    worker.dispatch('error', { message: 'too late' });

    expect(await outcome).toStrictEqual(done(3));
  });
});

describe('runWorkers', () => {
  /** `count` variants, labelled after their period but the last, which has no label */
  const variantsOf = (count: number): Variant[] =>
    times(count, index => ({
      variant: index + 1,
      label: index === count - 1 ? '' : `--strategy.period ${(index + 1) * 10}`,
      configuration: { strategy: { period: (index + 1) * 10 } },
    }));

  /** The lines logged at info level that hold `text` */
  const infoLinesWith = (text: string) => vi.mocked(info).mock.calls.filter(([, message]) => String(message).includes(text));

  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.running = 0;
    FakeWorker.mostRunning = 0;
    // Variant 1 takes the longest, so that the others end before it
    FakeWorker.answer = ({ variant }) => ({ result: done(variant, variant * 1000), delayMs: variant === 1 ? 30 : 1 });
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should give the results in the order of the variants', async () => {
    expect(await runWorkers(variantsOf(5), 2)).toStrictEqual([done(1, 1000), done(2, 2000), done(3, 3000), done(4, 4000), done(5, 5000)]);
  });

  it.each`
    maxWorkers | mostRunning
    ${1}       | ${1}
    ${2}       | ${2}
    ${8}       | ${5}
  `('should run $mostRunning workers at most for at most $maxWorkers', async ({ maxWorkers, mostRunning }) => {
    await runWorkers(variantsOf(5), maxWorkers);

    expect(FakeWorker.mostRunning).toBe(mostRunning);
  });

  it('should start the next variant as one ends, while the slowest still runs', async () => {
    await runWorkers(variantsOf(5), 2);

    // The variants in the order they end: from the second on, each started in the slot the one before it left
    expect(infoLinesWith(' done ').map(([, message]) => Number(/^Variant (\d+)/.exec(String(message))?.[1]))).toStrictEqual([
      2, 3, 4, 5, 1,
    ]);
  });

  it('should log each variant as it starts', async () => {
    await runWorkers(variantsOf(2), 2);

    expect(infoLinesWith('started')).toStrictEqual([
      ['fox', 'Variant 1 of 2 (--strategy.period 10) started'],
      ['fox', 'Variant 2 of 2 started'],
    ]);
  });

  it('should log each variant as it ends, with the duration of its backtest', async () => {
    await runWorkers(variantsOf(2), 1);

    expect(infoLinesWith(' done ')).toStrictEqual([
      ['fox', 'Variant 1 of 2 (--strategy.period 10) done in 1 second'],
      ['fox', 'Variant 2 of 2 done in 2 seconds'],
    ]);
  });

  describe('when a variant fails', () => {
    beforeEach(() => {
      FakeWorker.answer = ({ variant }) => ({
        result: variant === 2 ? { variant, status: 'failed', error: 'Missing candles in database', durationMs: 300 } : done(variant),
        delayMs: 1,
      });
    });

    it('should log its failure at error level', async () => {
      await runWorkers(variantsOf(3), 2);

      expect(error).toHaveBeenCalledExactlyOnceWith(
        'fox',
        'Variant 2 of 3 (--strategy.period 20) failed after less than a second: Missing candles in database',
      );
    });

    it('should run the other variants', async () => {
      expect(await runWorkers(variantsOf(3), 2)).toStrictEqual([
        done(1),
        { variant: 2, status: 'failed', error: 'Missing candles in database', durationMs: 300 },
        done(3),
      ]);
    });

    it('should log no stack for a failure posted without one', async () => {
      await runWorkers(variantsOf(3), 2);

      expect(debug).not.toHaveBeenCalled();
    });
  });

  it('should log the stack of an unexpected failure at debug level, under its line', async () => {
    const stack = "TypeError: Cannot read properties of undefined (reading 'close')\n    at onTimeframeCandle (dema.strategy.ts:42:7)";
    FakeWorker.answer = ({ variant }) => ({ result: { variant, status: 'failed', error: 'boom', stack, durationMs: 300 }, delayMs: 1 });
    await runWorkers(variantsOf(1), 1);

    expect(debug).toHaveBeenCalledExactlyOnceWith('fox', `Variant 1 of 1: ${stack}`);
  });
});
