import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import tsconfigBase from './tsconfig.base.json';

/** The root of the monorepo, where bun.lock, tsconfig.base.json and node_modules are */
export const MONOREPO_ROOT = __dirname;

/**
 * The aliases of the workspace packages, from the `paths` of tsconfig.base.json, which Bun, tsc and ESLint read: `@gekko/shared/*`
 * mapped to `./packages/shared/src/*` is the `@gekko/shared` prefix here. tsconfig.base.json stays plain JSON, without a comment or a
 * trailing comma, which the bundler that loads this file refuses.
 */
export const alias = Object.fromEntries(
  Object.entries(tsconfigBase.compilerOptions.paths).map(([pattern, [target]]) => [
    pattern.replace(/\/\*$/, ''),
    path.resolve(MONOREPO_ROOT, target.replace(/\/\*$/, '')),
  ]),
);

/**
 * Vite rebuilds its bundles of the dependencies when the lockfile it reads changes, and it reads no bun.lock: after a bump, the tests
 * would go on running against the bundle of the old version. The cache is named after the root bun.lock's content, so that a bump
 * starts a new one, and after the directory of the workspace running: a copy of the repository whose node_modules is a link shares
 * the directory, and Vite deletes the bundles of another checkout to rebuild them, under a run that reads them. The directories of
 * earlier lockfiles stay behind: deleting node_modules/.vite reclaims them.
 */
export const cacheDirFor = (dir: string) => {
  const cacheKey = createHash('sha256')
    .update(readFileSync(path.resolve(MONOREPO_ROOT, 'bun.lock')))
    .update(dir)
    .digest('hex')
    .slice(0, 16);
  return path.resolve(MONOREPO_ROOT, 'node_modules/.vite', cacheKey);
};

/** The files the coverage of a workspace leaves out: the schemas, mocks, types, errors and constants, the benches and the barrels */
export const COVERAGE_EXCLUDE = ['src/**/*.{schema,mock,types,error,const}.ts', 'src/**/*.bench.ts', 'src/**/index.ts'];

// The suites cover over 98 % of each: at 80 %, a new module of a thousand untested lines passed
export const COVERAGE_THRESHOLDS = { lines: 95, functions: 95, branches: 95, statements: 95 };

/** The packages the package.json of a directory lists, its dependencies and its devDependencies */
const listedPackages = (dir: string): string[] => {
  const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return Object.keys({ ...dependencies, ...devDependencies });
};

/** Whether the suites of a directory can load a package: its package.json lists it, or lists a workspace that can, at any depth */
const canLoad = (dir: string, name: string): boolean =>
  listedPackages(dir).some(listed => listed === name || (Object.hasOwn(alias, listed) && canLoad(path.dirname(alias[listed]), name)));

/**
 * The dependencies vitest bundles for the suites of a directory, `dir` a workspace's or the root's. Each test file runs in a process of
 * its own, which loaded them module by module, hundreds of modules each: bundled once, they load in a fraction of the time. date-fns and
 * lodash-es for every one; ccxt where the suites can load it, @gekko/core, which lists it, and every workspace above it (the plugins,
 * apps/gekko and apps/fox), where it must be bundled with the others: left out, the suites that load it fail on one of its import cycles
 * (Cannot access 'bydfiRest' before initialization). Bundled for the others, which never load it, it cost each an esbuild run of half a
 * second and 39 MB of its cache directory.
 */
export const depsOptimizerFor = (dir: string) => ({
  ssr: { enabled: true, include: ['date-fns', 'lodash-es', ...(canLoad(dir, 'ccxt') ? ['ccxt'] : [])] },
});

/**
 * The vitest configuration of a workspace (a package or an app), `dir` its directory: its unit tests are `src/**\/*.test.ts` (the e2e
 * suite of apps/gekko runs on Bun's test runner, out of vitest), its coverage counts `src/**\/*.ts` but `coverageExclude`, at the
 * thresholds every workspace meets.
 */
export const workspaceVitestConfig = (dir: string, { coverageExclude = COVERAGE_EXCLUDE }: { coverageExclude?: string[] } = {}) =>
  defineConfig({
    cacheDir: cacheDirFor(dir),
    test: {
      mockReset: true,
      restoreMocks: true,
      include: ['src/**/*.test.ts'],
      deps: { optimizer: depsOptimizerFor(dir) },
      coverage: {
        reporter: ['text'],
        include: ['src/**/*.ts'],
        exclude: coverageExclude,
        thresholds: COVERAGE_THRESHOLDS,
      },
    },
    resolve: { alias },
  });
