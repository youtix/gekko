import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readPackageJson, ROOT, workspaceDirectories } from './workspaces.helper';

// The dependencies each vitest configuration bundles for its suites (depsOptimizerFor of vitest.shared.ts), read from the
// configurations as vitest loads them. A test cannot import them, vitest/config failing to load in vitest's own runner: Bun loads them
// in a process of its own, as version.test.ts runs it.
const WORKSPACES = workspaceDirectories();
const CONFIGS = ['vitest.config.ts', ...WORKSPACES.map(workspace => `${workspace}/vitest.config.ts`)];
const PRINT_BUNDLED = `
const bundled = {};
for (const config of process.argv.slice(1)) bundled[config] = (await import(\`\${process.cwd()}/\${config}\`)).default.test.deps.optimizer.ssr.include;
console.log(JSON.stringify(bundled));
`;
const BUNDLED: Record<string, string[]> = JSON.parse(
  execFileSync('bun', ['--eval', PRINT_BUNDLED, '--', ...CONFIGS], { cwd: ROOT, encoding: 'utf8' }),
);

const DIRECTORY_BY_NAME = Object.fromEntries(WORKSPACES.map(directory => [readPackageJson(directory).name, directory]));

/** Whether a workspace is @gekko/core or lists, at any depth, a workspace that is: ccxt, which the core imports, can reach its suites */
const reachesCore = (directory: string): boolean => {
  const { dependencies = {}, devDependencies = {} } = readPackageJson(directory);
  return (
    directory === DIRECTORY_BY_NAME['@gekko/core'] ||
    Object.keys({ ...dependencies, ...devDependencies }).some(
      name => Object.hasOwn(DIRECTORY_BY_NAME, name) && reachesCore(DIRECTORY_BY_NAME[name]),
    )
  );
};

describe('the dependencies vitest bundles', () => {
  // ccxt only where a suite can load it: left out there, its import cycles fail the suite (Cannot access 'bydfiRest' before
  // initialization), and bundled elsewhere, it cost each run on a fresh cache half a second and 39 MB
  it.each`
    config                                    | bundled
    ${'vitest.config.ts'}                     | ${['date-fns', 'lodash-es']}
    ${'packages/shared/vitest.config.ts'}     | ${['date-fns', 'lodash-es']}
    ${'packages/schemas/vitest.config.ts'}    | ${['date-fns', 'lodash-es']}
    ${'packages/indicators/vitest.config.ts'} | ${['date-fns', 'lodash-es']}
    ${'packages/strategies/vitest.config.ts'} | ${['date-fns', 'lodash-es']}
    ${'packages/core/vitest.config.ts'}       | ${['date-fns', 'lodash-es', 'ccxt']}
    ${'packages/plugins/vitest.config.ts'}    | ${['date-fns', 'lodash-es', 'ccxt']}
    ${'apps/gekko/vitest.config.ts'}          | ${['date-fns', 'lodash-es', 'ccxt']}
    ${'apps/fox/vitest.config.ts'}            | ${['date-fns', 'lodash-es', 'ccxt']}
  `('should bundle $bundled for the suites of $config', ({ config, bundled }) => {
    expect(BUNDLED[config]).toEqual(bundled);
  });

  it.each(WORKSPACES)('should bundle ccxt for the suites of %s exactly when it is @gekko/core or depends on it', workspace => {
    expect(BUNDLED[`${workspace}/vitest.config.ts`].includes('ccxt')).toBe(reachesCore(workspace));
  });
});
