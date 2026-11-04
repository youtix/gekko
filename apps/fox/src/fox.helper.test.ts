import { error, info } from '@gekko/core/logger/logger';
import { describe, expect, it, vi } from 'vitest';
import { logSummary } from './fox.helper';
import type { VariantResult } from './fox.types';

vi.mock('@gekko/core/logger/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));

describe('logSummary', () => {
  const done = (variant: number): VariantResult => ({ variant, status: 'done', durationMs: 1000 });
  const failed = (variant: number): VariantResult => ({ variant, status: 'failed', error: 'boom', durationMs: 1000 });
  const stopped = (variant: number): VariantResult => ({
    variant,
    status: 'stopped',
    reason: '[STRATEGY] Max consecutive order errors reached (5)',
    durationMs: 1000,
  });

  it.each`
    description             | results                        | expected
    ${'one variant'}        | ${[done(1)]}                   | ${'1 variant, 0 failed'}
    ${'every variant done'} | ${[done(1), done(2), done(3)]} | ${'3 variants, 0 failed'}
  `('should log $description at info level', ({ results, expected }) => {
    logSummary(results);

    expect(info).toHaveBeenCalledExactlyOnceWith('fox', expected);
  });

  it.each`
    description                                | results                                                  | expected
    ${'one variant failed'}                    | ${[done(1), failed(2), done(3)]}                         | ${'3 variants, 1 failed: variant 2'}
    ${'two variants failed'}                   | ${[done(1), failed(2), done(3), failed(4)]}              | ${'4 variants, 2 failed: variants 2 and 4'}
    ${'one variant stopped'}                   | ${[done(1), done(2), stopped(3), done(4)]}               | ${'4 variants, 1 stopped: variant 3'}
    ${'two variants stopped'}                  | ${[stopped(1), done(2), stopped(3)]}                     | ${'3 variants, 2 stopped: variants 1 and 3'}
    ${'variants failed and a variant stopped'} | ${[done(1), failed(2), stopped(3), failed(4)]}           | ${'4 variants, 2 failed: variants 2 and 4; 1 stopped: variant 3'}
    ${'a variant failed and two stopped'}      | ${[stopped(1), failed(2), stopped(3), done(4), done(5)]} | ${'5 variants, 1 failed: variant 2; 2 stopped: variants 1 and 3'}
  `('should log $description at error level, naming them', ({ results, expected }) => {
    logSummary(results);

    expect(error).toHaveBeenCalledExactlyOnceWith('fox', expected);
  });

  // A stopped variant, as the bot's stop (the circuit breaker), leaves Fox's exit code at 0
  it.each`
    description                           | results                    | expected
    ${'every variant done'}               | ${[done(1), done(2)]}      | ${false}
    ${'a variant failed'}                 | ${[done(1), failed(2)]}    | ${true}
    ${'a variant stopped'}                | ${[done(1), stopped(2)]}   | ${false}
    ${'a variant stopped and one failed'} | ${[stopped(1), failed(2)]} | ${true}
  `('should say whether a variant failed when $description', ({ results, expected }) => {
    expect(logSummary(results)).toBe(expected);
  });
});
