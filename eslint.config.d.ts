import type { Linter } from 'eslint';

/**
 * The workspaces and what each may import, keyed by the directory of the workspace (or of its src/ or test/, when the two differ),
 * as eslint.config.js declares it. Declared here for scripts/tooling/dependencies.test.ts, which imports the configuration: tsc reads
 * no JavaScript module under a node_modules path, where the pre-commit hook checks a copy of the index, and so reports no type for
 * the import without this file, which outranks the .js.
 */
export const DEPENDENCIES: Record<string, readonly string[]>;

declare const config: Linter.Config[];
export default config;
