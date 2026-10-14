import { bench as vitestBench, type BenchFunction } from 'vitest';

/**
 * vitest's bench, which every `*.bench.ts` imports: an error its function throws during tinybench's warmup fails the run.
 *
 * tinybench records an error thrown during its warmup and measures nothing more: the bench was reported without a sample, its group
 * without a table and the summary "NaNx faster", while `bun run bench` passed. SMACrossover's three oscillating benches measured nothing
 * so, their fixtures throwing on the first SELL. Rethrown (tinybench's `throws`), such an error fails the file and the run, and vitest
 * measures nothing more in that file.
 *
 * During the warmup only: `setup` sets `throws` before each phase, on the tinybench instance vitest builds for this bench alone. vitest
 * awaits the measurement inside a timer callback, so an error rethrown there escapes it, unhandled, and the run hangs without a word,
 * where recorded it reaches vitest through tinybench's `error` event and fails the file once its group is measured. Hence not
 * `{ throws: true }`, which rethrows in both phases.
 *
 * Relies on vitest 4.0.18 and the tinybench 2.9.0 it runs: `setup(task, mode)` called before each phase, `throws` read after it, a
 * tinybench instance per bench. To be probed again on an upgrade. It has no `.only` or `.skip`: vitest's own bench has them, for a run
 * while iterating.
 */
export const bench = (name: string, fn: BenchFunction) =>
  vitestBench(name, fn, {
    setup: (task, mode) => {
      task.bench.throws = mode === 'warmup';
    },
  });
