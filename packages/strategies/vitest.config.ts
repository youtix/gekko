import { COVERAGE_EXCLUDE, workspaceVitestConfig } from '../../vitest.shared';

export default workspaceVitestConfig(__dirname, {
  // The e2e fixtures and the private strategies are not covered, as before the monorepo
  coverageExclude: [...COVERAGE_EXCLUDE, 'src/custom/**/*.ts', 'src/debug/**/*.ts'],
});
