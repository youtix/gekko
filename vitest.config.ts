import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import tsconfig from './tsconfig.json';

// The aliases are the paths of tsconfig.json, which Bun, tsc and ESLint read: `@utils/*` mapped to `./src/utils/*` is the `@utils`
// prefix here. The bundler that loads this file reads tsconfig.json as plain JSON, without a comment or a trailing comma.
const alias = Object.fromEntries(
  Object.entries(tsconfig.compilerOptions.paths).map(([pattern, [target]]) => [
    pattern.replace(/\/\*$/, ''),
    path.resolve(__dirname, target.replace(/\/\*$/, '')),
  ]),
);

// Vite rebuilds its bundles of the dependencies when the lockfile it reads changes, and it reads no bun.lock: after a bump, the tests
// would go on running against the bundle of the old version. The cache is named after bun.lock's content, so that a bump starts a
// new one, and after this checkout: a copy of the repository whose node_modules is a link shares the directory, and Vite deletes the
// bundles of another checkout to rebuild them, under a run that reads them. The directories of earlier lockfiles stay behind:
// deleting node_modules/.vite reclaims them.
const cacheKey = createHash('sha256')
  .update(readFileSync(path.resolve(__dirname, 'bun.lock')))
  .update(__dirname)
  .digest('hex')
  .slice(0, 16);

export default defineConfig({
  cacheDir: path.resolve(__dirname, 'node_modules/.vite', cacheKey),
  test: {
    mockReset: true,
    restoreMocks: true,
    // scripts/release holds the release's own semantic-release plugin
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    deps: {
      // Each test file runs in a process of its own, which loaded date-fns, lodash-es and ccxt module by module, hundreds of modules
      // each: bundled once, they load in a fraction of the time. ccxt must be bundled with the others: left out, the suites that load it
      // fail on one of its import cycles (Cannot access 'bydfiRest' before initialization).
      optimizer: { ssr: { enabled: true, include: ['date-fns', 'lodash-es', 'ccxt'] } },
    },
    coverage: {
      reporter: ['text'],
      include: ['src/**/*.ts', 'scripts/**/*.cjs'],
      exclude: [
        'src/**/*.{schema,mock,types,error,const}.ts',
        'src/**/*.bench.ts',
        'src/**/index.ts',
        'src/strategies/custom/**/*.ts',
        'src/strategies/debug/**/*.ts',
      ],
      // The suite covers over 98 % of each: at 80 %, a new module of a thousand untested lines passed
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
  resolve: { alias },
});
