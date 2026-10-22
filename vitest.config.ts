import { defineConfig } from 'vitest/config';
import { alias, cacheDirFor, COVERAGE_THRESHOLDS, DEPS_OPTIMIZER, MONOREPO_ROOT } from './vitest.shared';

// The root's own suites: the tests of scripts/ (the release plugin, the documentation and the tooling checks). Each workspace has
// a vitest.config.ts of its own, built by vitest.shared.ts, which turbo runs one by one (bun run test).
export default defineConfig({
  cacheDir: cacheDirFor(MONOREPO_ROOT),
  test: {
    mockReset: true,
    restoreMocks: true,
    include: ['scripts/**/*.test.ts'],
    deps: { optimizer: DEPS_OPTIMIZER },
    coverage: {
      reporter: ['text'],
      // scripts/release holds the release's own semantic-release plugin
      include: ['scripts/**/*.cjs'],
      thresholds: COVERAGE_THRESHOLDS,
    },
  },
  resolve: { alias },
});
