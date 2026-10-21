import pluginJs from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  // `eslint .` lints the whole checkout, but for what the tools write (the executable, an html or lcov coverage report), the candles
  // the importer stores and the local notes of documentation/dev
  { ignores: ['dist/', 'db/', 'coverage/', 'documentation/dev/'] },
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
      // A helper of src/helpers is shared by several modules, the plugins among them: one that imported a plugin's own module made the
      // plugin a dependency of every module that uses the helper
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/helpers',
              from: './src/plugins',
              message: 'src/helpers cannot import a plugin: move what it needs to src/helpers',
            },
          ],
        },
      ],
      'import/no-unresolved': 'error',
      // import/no-unused-modules is left out: without options it checks nothing, and its unusedExports option crashes under ESLint 10,
      // which eslint-plugin-import 2.32 does not support. A dead export is found with TypeScript's find-references instead.

      // Registries are read by a computed name (indicators[name], strategies[...], pluginList[...]): the plugin cannot check one, and
      // TypeScript types the key. A plain member that does not exist is still reported.
      'import/namespace': ['error', { allowComputed: true }],
      // Every unused parameter, a leading one too, unless its name starts with _: by default (after-used), only those after the last
      // one used were reported
      '@typescript-eslint/no-unused-vars': ['error', { args: 'all', argsIgnorePattern: '^_' }],
    },
  },
  {
    settings: {
      'import/resolver': { typescript: { bun: true } },
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
    files: ['**/*.test.ts', '**/test/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
