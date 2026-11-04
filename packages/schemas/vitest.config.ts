import { workspaceVitestConfig } from '../../vitest.shared';

export default workspaceVitestConfig(__dirname, {
  // The schemas are this package's code: covered, where every other package leaves its *.schema.ts out
  coverageExclude: ['src/**/*.{mock,types,const}.ts', 'src/**/index.ts'],
});
