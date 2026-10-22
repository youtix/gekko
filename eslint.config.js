import pluginJs from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The workspaces and what each may import (CLAUDE.md, Architecture): the graph is one way, from an app down to @gekko/shared. The
 * e2e suite of apps/gekko reads the schemas and the fixture strategies' types, which its executable does not: its test directory
 * may import every package, its sources the three the executable is composed of.
 */
const DEPENDENCIES = {
  'packages/shared': [],
  'packages/schemas': ['packages/shared'],
  'packages/indicators': ['packages/shared'],
  'packages/strategies': ['packages/shared', 'packages/schemas', 'packages/indicators'],
  'packages/core': ['packages/shared', 'packages/schemas'],
  'packages/plugins': ['packages/shared', 'packages/schemas', 'packages/indicators', 'packages/strategies', 'packages/core'],
  'apps/gekko/src': ['packages/shared', 'packages/core', 'packages/plugins'],
  'apps/gekko/test': [
    'packages/shared',
    'packages/schemas',
    'packages/indicators',
    'packages/strategies',
    'packages/core',
    'packages/plugins',
  ],
  'apps/fox': ['packages/shared', 'packages/schemas', 'packages/strategies', 'packages/core', 'packages/plugins'],
};
const WORKSPACES = [
  'packages/shared',
  'packages/schemas',
  'packages/indicators',
  'packages/strategies',
  'packages/core',
  'packages/plugins',
  'apps/gekko',
  'apps/fox',
];
const workspaceOf = target => WORKSPACES.find(workspace => target === workspace || target.startsWith(`${workspace}/`));
// One zone per workspace and forbidden source: a file of `target` importing a file of `from` is an error naming both
const boundaryZones = Object.entries(DEPENDENCIES).flatMap(([target, allowed]) =>
  WORKSPACES.filter(from => from !== workspaceOf(target) && !allowed.includes(from)).map(from => ({
    target: `./${target}`,
    from: `./${from}`,
    message: `${target} cannot import ${from}: the packages depend one way, see CLAUDE.md (Architecture)`,
  })),
);

/** @type {import('eslint').Linter.Config[]} */
export default [
  // `eslint .` lints the whole checkout, but for what the tools write (the executables, an html or lcov coverage report), the
  // candles the importer stores, the local notes of documentation/dev and the worktrees the Claude desktop app checks out under
  // .claude/worktrees/, which git hides through .git/info/exclude, a file eslint does not read. Each worktree is a copy of the
  // checkout with an eslint.config.js of its own, which eslint 10 reads for the files under it: typescript-eslint then holds two
  // candidate tsconfigRootDirs and refuses every file of the lint, the root's too
  { ignores: ['dist/', 'db/', 'coverage/', 'documentation/dev/', '.claude/', '.turbo/', '**/.turbo/'] },
  // Node's globals, without CommonJS's (the .cjs files get them below): Bun has Node's globals, and the .js files are ES modules. With
  // the browser's, `status = 'x'` and `document.title` passed the lint
  { languageOptions: { globals: globals.nodeBuiltin } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  {
    // No formatting rule: Prettier formats (format:check in CI, prettier --write at commit). ESLint's stylistic rules, deprecated since
    // ESLint 8.53, refused the double quotes Prettier writes around a text holding an apostrophe, so that no spelling passed both.
    rules: {
      'no-console': 'error',
      'import/no-cycle': 'error',
      // The dependency graph of the workspaces, one way (see DEPENDENCIES): a package of a lower layer importing a higher one, a
      // helper of @gekko/shared importing a plugin or the core among them, is an error whatever the import brings
      'import/no-restricted-paths': ['error', { zones: boundaryZones }],
      'import/no-unresolved': 'error',
      // import/no-unused-modules is left out: without options it checks nothing, and its unusedExports option crashes under ESLint 10,
      // which eslint-plugin-import 2.32 does not support. A dead export is found with TypeScript's find-references instead.

      // Registries are read by a computed name (indicators[name], strategies[...], plugins[...]): the plugin cannot check one, and
      // TypeScript types the key. A plain member that does not exist is still reported.
      'import/namespace': ['error', { allowComputed: true }],
      // Every unused parameter, a leading one too, unless its name starts with _: by default (after-used), only those after the last
      // one used were reported
      '@typescript-eslint/no-unused-vars': ['error', { args: 'all', argsIgnorePattern: '^_' }],
    },
  },
  {
    settings: {
      // The root tsconfig.json declares the paths of the workspace packages (@gekko/<pkg>/* → packages/<pkg>/src/*), which every
      // workspace's tsconfig extends: one project resolves every import of the checkout
      'import/resolver': { typescript: { bun: true, project: './tsconfig.json' } },
      // Each entry is a regular expression tested against the absolute path of a module: an unanchored 'dist' matched a checkout under
      // ~/distrib/ or /srv/dist/, where import/no-cycle and the other rules that read a module's exports then reported nothing
      'import/ignore': ['/node_modules/'],
      // The import plugin reads the imports and exports of a module only for these extensions (JavaScript ones by default): without
      // .ts, import/no-cycle saw no import between two of our files, and a value cycle passed the lint
      'import/extensions': ['.ts', '.js'],
      'import/parsers': { '@typescript-eslint/parser': ['.ts'] },
    },
  },
  {
    // In CI and a fresh clone, packages/strategies/src/custom/index.ts is the tracked placeholder, which exports nothing, so
    // `export * from './custom/index'` fails import/export there and nowhere else. TypeScript still refuses two strategies exported
    // under the same name.
    files: ['packages/strategies/src/index.ts'],
    rules: { 'import/export': 'off' },
  },
  {
    // The CommonJS files, which Node runs (the release and commitlint configurations, the release's plugin): typescript-eslint
    // parses every file as an ES module, where require and module are undefined
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/test/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
