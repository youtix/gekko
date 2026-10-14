import { afterEach, beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
import packageJson from '../../../package.json';
import { logVersion, wait, waitSync } from './process.utils';

describe('process', () => {
  describe('logVersion()', () => {
    afterEach(() => {
      Reflect.deleteProperty(process.versions, 'bun');
    });

    it('should include the package version', () => {
      const result = logVersion();
      expect(result).toContain(`v${packageJson.version}`);
    });

    it('should include the Bun version under the Bun label when running on Bun', () => {
      process.versions.bun = '1.3.14';
      const result = logVersion();
      expect(result).toContain('Bun version: v1.3.14');
    });

    it('should include the Node version under the Node label when not running on Bun', () => {
      const result = logVersion();
      expect(result).toContain(`Node version: ${process.version}`);
    });

    it('should not claim a Bun version when not running on Bun', () => {
      const result = logVersion();
      expect(result).not.toContain('Bun');
    });
  });

  describe('wait()', () => {
    let settled: boolean;

    beforeEach(() => {
      vi.useFakeTimers();
      settled = false;
      void wait(500).then(() => (settled = true));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // The async advance lets the promise callbacks run, so that a wait resolved at once is seen resolved from the first row
    it.each`
      elapsed | state
      ${1}    | ${'pending'}
      ${499}  | ${'pending'}
      ${500}  | ${'resolved'}
    `('should leave a wait of 500 ms $state after $elapsed ms', async ({ elapsed, state }) => {
      await vi.advanceTimersByTimeAsync(elapsed);
      expect(settled ? 'resolved' : 'pending').toBe(state);
    });
  });

  describe('waitSync()', () => {
    it('should block on a buffer Atomics.wait accepts, a shared one', () => {
      expect(() => waitSync(1)).not.toThrow();
    });

    describe('with Atomics.wait spied', () => {
      let atomicsWait: MockInstance;

      beforeEach(() => {
        atomicsWait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      });

      it('should block on Atomics.wait once, for the delay given (50 ms)', () => {
        waitSync(50);
        expect(atomicsWait.mock.calls).toEqual([[expect.any(Int32Array), 0, 0, 50]]);
      });

      it.each`
        ms
        ${0}
        ${-1}
        ${NaN}
        ${undefined}
      `('should return at once, without blocking, for a delay of $ms ms', ({ ms }) => {
        waitSync(ms);
        expect(atomicsWait).not.toHaveBeenCalled();
      });
    });
  });
});
