import pluginJs from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  {
    rules: {
      'no-console': 'error',
      'no-multiple-empty-lines': ['error', { max: 1 }],
      'arrow-parens': ['error', 'as-needed'],
      semi: ['error', 'always'],
      indent: 'off',
      quotes: ['error', 'single'],
      'max-len': 'off',
      'comma-dangle': ['error', 'always-multiline'],
      'object-curly-spacing': ['error', 'always'],
      'import/no-cycle': 'error',
      'import/no-unresolved': 'error',
      // import/no-unused-modules is left out: without options it checks nothing, and its unusedExports option crashes under ESLint 10,
      // which eslint-plugin-import 2.32 does not support. A dead export is found with TypeScript's find-references instead.

      // Registries are read by a computed name (indicators[name], strategies[...], pluginList[...]): the plugin cannot check one, and
      // TypeScript types the key. A plain member that does not exist is still reported.
      'import/namespace': ['error', { allowComputed: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    settings: {
      'import/resolver': { typescript: { bun: true } },
      'import/ignore': ['node_modules', 'dist'],
      'import/core-modules': ['reflect-metadata'],
      // The import plugin reads the imports and exports of a module only for these extensions (JavaScript ones by default): without
      // .ts, import/no-cycle saw no import between two of our files, and a value cycle passed the lint
      'import/extensions': ['.ts', '.js'],
      'import/parsers': { '@typescript-eslint/parser': ['.ts'] },
    },
  },
  {
    // In CI and a fresh clone, src/strategies/custom/index.ts is the tracked placeholder, which exports nothing, so
    // `export * from './custom/index'` fails import/export there and nowhere else. TypeScript still refuses two strategies exported
    // under the same name.
    files: ['src/strategies/index.ts'],
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
    files: ['**/*.test.ts', '**/*.bench.ts', '**/test/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
