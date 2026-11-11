import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readPackageJson, ROOT } from './workspaces.helper';

// No strategy shares code with another. A strategy loaded from a strategyPath file can import only types from Gekko, the executable
// resolving no @gekko/… path in a file it loads at run time: what the built-in strategies would share, the position book and the
// grouping of their indicator arguments by pair, comes through their tools, which such a strategy gets too. Of their package, the
// files of a strategy's directory import only that directory's files and the two type modules at the root of the package,
// strategy.types and trailingStopManager.types; their tests, benches and mocks may also import strategy.mock, the tooling the strategy
// suites share. ESLint's zones hold the packages a file imports, not the files of its own package: this test does. The private
// strategies of custom/, which git ignores, are left out.
const PACKAGE = 'packages/strategies';
const SOURCES = path.join(ROOT, PACKAGE, 'src');
/** The package's name and a slash: tsconfig.base.json maps @gekko/strategies/<path> to src/<path>, as typeCheck.test.ts checks */
const ALIAS = `${readPackageJson(PACKAGE).name}/`;
/** The modules at the root of the package that any file of a strategy's directory may import: types, as a strategyPath file may */
const TYPE_MODULES = ['strategy.types', 'trailingStopManager.types'];
/** Those that a test, a bench or a mock may import: the type modules and the tooling the strategy suites share */
const SUITE_MODULES = [...TYPE_MODULES, 'strategy.mock'];
const SUITE_FILE = /\.(test|bench|mock)\.ts$/;
/** An extension a specifier may end with: Bun reads `./x.ts` and `./x.js` as the module `./x`, and tsc's bundler resolution `./x.js` */
const EXTENSION = /\.[jt]s$/;
/** The vitest functions whose first argument names a module: they mock it, or import it past its mock */
const VI_MODULE_FUNCTIONS = new Set(['mock', 'doMock', 'importActual', 'importMock']);

/** Whether a call names a module as its first argument: `import()`, `require()` or one of the vitest functions above */
const isModuleCall = ({ expression }: ts.CallExpression) =>
  expression.kind === ts.SyntaxKind.ImportKeyword ||
  (ts.isIdentifier(expression) && expression.text === 'require') ||
  (ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'vi' &&
    VI_MODULE_FUNCTIONS.has(expression.name.text));

/** The node with which a node names a module, if it names one: an import, a re-export, a type `import('…')` or a module call */
const specifierNodeOf = (node: ts.Node): ts.Node | undefined => {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  if (ts.isCallExpression(node) && isModuleCall(node)) return node.arguments[0];
  return undefined;
};

/**
 * The modules a source names, as written and in their order, read from its syntax tree, where a comment or a text names no module.
 * tsc's pre-processing, with which the other suites read the imports of a file, reads neither a `vi.mock` nor an
 * `export * as ns from '…'`.
 */
const specifiersOf = (file: string, source: string) => {
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    const specifier = specifierNodeOf(node);
    if (specifier !== undefined && ts.isStringLiteralLike(specifier)) specifiers.push(specifier.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest));
  return specifiers;
};

/**
 * The module a specifier of `file` names, both relative to the strategies' sources and without an extension (`dema/dema.types`,
 * `strategy.types`, or `..` or a path under it for a module outside them): a path relative to the file's directory, or a path under
 * the package's name. Undefined for a module of another package, which ESLint's zones hold.
 */
const moduleOf = (file: string, specifier: string) => {
  if (specifier.startsWith('.')) return path.posix.join(path.posix.dirname(file), specifier).replace(EXTENSION, '');
  if (specifier.startsWith(ALIAS)) return path.posix.normalize(specifier.slice(ALIAS.length)).replace(EXTENSION, '');
  return undefined;
};

/** Whether a module lies inside a directory, both relative to the strategies' sources, `.` being the sources themselves */
const isInside = (module: string, directory: string) => {
  const relative = path.posix.relative(directory, module);
  return relative !== '..' && !relative.startsWith('../');
};

/** Whether a file of the strategies' sources, relative to them, is held to the rule: a .ts file of one of their directories but custom/ */
const isStrategyFile = (file: string) => file.endsWith('.ts') && file.includes('/') && !file.startsWith('custom/');

/**
 * The specifiers of `source`, the text of `file` (relative to the strategies' sources), that name a module of the package the file may
 * not import, as written and in their order: one neither in the file's strategy directory, at any depth, nor among the root modules
 * it may import, the type modules and, for a test, a bench or a mock, strategy.mock.
 */
const refusedImports = (file: string, source: string) => {
  const directory = file.slice(0, file.indexOf('/'));
  const shared = SUITE_FILE.test(file) ? SUITE_MODULES : TYPE_MODULES;
  return specifiersOf(file, source).filter(specifier => {
    const module = moduleOf(file, specifier);
    return module !== undefined && isInside(module, '.') && !isInside(module, directory) && !shared.includes(module);
  });
};

const STRATEGY_FILES = readdirSync(SOURCES, { recursive: true, encoding: 'utf8' }).filter(isStrategyFile).sort();

describe('the imports of the strategies', () => {
  // vitest shows 38 characters at most of a value in a title, cutting a longer one short: the cells the titles name keep to them
  describe('the files held to the rule', () => {
    it.each`
      file                                 | held
      ${'dema/dema.strategy.ts'}           | ${true}
      ${'debug/debug.mock.ts'}             | ${true}
      ${'gridBot/gridBot.helper.bench.ts'} | ${true}
      ${'gridBot/levels/levels.helper.ts'} | ${true}
      ${'custom/index.ts'}                 | ${false}
      ${'custom/mine/mine.strategy.ts'}    | ${false}
      ${'strategy.types.ts'}               | ${false}
      ${'index.ts'}                        | ${false}
      ${'dema/README.md'}                  | ${false}
    `('should hold $file to the rule: $held', ({ file, held }) => {
      expect(isStrategyFile(file)).toBe(held);
    });
  });

  describe('the rule', () => {
    it.each`
      case                                        | file                                     | source
      ${'a module of its own directory'}          | ${'dema/dema.strategy.ts'}               | ${"import { DEMAStrategyParams } from './dema.types';"}
      ${'its own directory, from a subdirectory'} | ${'gridBot/levels/levels.helper.ts'}     | ${"import { GridLayout } from '../gridBot.types';"}
      ${'strategy.types'}                         | ${'dema/dema.strategy.ts'}               | ${"import { Strategy } from '../strategy.types';"}
      ${'trailingStopManager.types'}              | ${'debug/debugTrailingStop.strategy.ts'} | ${"import type { TrailingStopState } from '../trailingStopManager.types';"}
      ${'strategy.types by the package name'}     | ${'rsi/rsi.strategy.ts'}                 | ${"import type { Tools } from '@gekko/strategies/strategy.types';"}
      ${'strategy.types with an extension'}       | ${'rsi/rsi.strategy.ts'}                 | ${"import type { Tools } from '../strategy.types.js';"}
      ${'strategy.mock'}                          | ${'dema/dema.test.ts'}                   | ${"import { playSteps } from '../strategy.mock';"}
      ${'strategy.mock by the package name'}      | ${'smaCrossover/smaCrossover.bench.ts'}  | ${"import { fakeTools } from '@gekko/strategies/strategy.mock';"}
      ${'strategy.mock, which it re-exports'}     | ${'debug/debug.mock.ts'}                 | ${"export { LoggedLine } from '../strategy.mock';"}
      ${'a mock of a module of its directory'}    | ${'gridBot/gridBot.test.ts'}             | ${"vi.mock('./gridBot.helper');"}
      ${'a module of another workspace'}          | ${'dema/dema.strategy.ts'}               | ${"import { round } from '@gekko/shared/utils/math/round.utils';"}
      ${'a file out of the package sources'}      | ${'dema/dema.strategy.ts'}               | ${"import manifest from '../../package.json';"}
      ${'a package'}                              | ${'dema/dema.strategy.ts'}               | ${"import { z } from 'zod';"}
      ${'comments that look like imports'}        | ${'dema/dema.test.ts'}                   | ${"// import { x } from '../helpers/strategy.helper';\n/* vi.mock('../rsi/rsi.strategy'); */"}
      ${'a text that only looks like an import'}  | ${'dema/dema.test.ts'}                   | ${"const text = `import { x } from '../rsi/rsi.strategy'`;"}
    `('should let $file import $case', ({ file, source }) => {
      expect(refusedImports(file, source)).toEqual([]);
    });

    it.each`
      case                                      | file                       | source                                                                                                                     | refused
      ${'a module of another strategy'}         | ${'rsi/rsi.strategy.ts'}   | ${"import { DEMA } from '../dema/dema.strategy';"}                                                                         | ${['../dema/dema.strategy']}
      ${'a module of a directory of helpers'}   | ${'dema/dema.strategy.ts'} | ${"import { indicatorsBySymbol } from '../helpers/strategy.helper';"}                                                      | ${['../helpers/strategy.helper']}
      ${'strategy.mock, from a source file'}    | ${'dema/dema.strategy.ts'} | ${"import { fakeTools } from '../strategy.mock';"}                                                                         | ${['../strategy.mock']}
      ${'another strategy by the package name'} | ${'rsi/rsi.test.ts'}       | ${"import { DEMA } from '@gekko/strategies/dema/dema.strategy';"}                                                          | ${['@gekko/strategies/dema/dema.strategy']}
      ${'the registry of the package'}          | ${'dema/dema.test.ts'}     | ${"import * as strategies from '../index';"}                                                                               | ${['../index']}
      ${'a type of another strategy'}           | ${'rsi/rsi.strategy.ts'}   | ${"import type { DEMAStrategyParams } from '../dema/dema.types';"}                                                         | ${['../dema/dema.types']}
      ${'a dynamic import'}                     | ${'dema/dema.test.ts'}     | ${"const { RSI } = await import('../rsi/rsi.strategy');"}                                                                  | ${['../rsi/rsi.strategy']}
      ${'the type of a module'}                 | ${'dema/dema.test.ts'}     | ${"type RSIModule = typeof import('../rsi/rsi.strategy');"}                                                                | ${['../rsi/rsi.strategy']}
      ${'a mock'}                               | ${'dema/dema.test.ts'}     | ${"vi.mock('../helpers/positionBook/positionBook');"}                                                                      | ${['../helpers/positionBook/positionBook']}
      ${'a mock that is not hoisted'}           | ${'dema/dema.test.ts'}     | ${"vi.doMock('@gekko/strategies/rsi/rsi.strategy', () => ({}));"}                                                          | ${['@gekko/strategies/rsi/rsi.strategy']}
      ${'a module imported past its mock'}      | ${'dema/dema.test.ts'}     | ${"const rsi = await vi.importActual('../rsi/rsi.strategy');"}                                                             | ${['../rsi/rsi.strategy']}
      ${'a re-export'}                          | ${'debug/debug.mock.ts'}   | ${"export { OrderRecorder } from '../helpers/positionTracker/positionTracker.mock';"}                                      | ${['../helpers/positionTracker/positionTracker.mock']}
      ${'a re-export of a namespace'}           | ${'debug/debug.mock.ts'}   | ${"export * as rsi from '../rsi/rsi.strategy';"}                                                                           | ${['../rsi/rsi.strategy']}
      ${'an import for its side effects'}       | ${'dema/dema.strategy.ts'} | ${"import '../rsi/rsi.strategy';"}                                                                                         | ${['../rsi/rsi.strategy']}
      ${'a require'}                            | ${'dema/dema.strategy.ts'} | ${"const rsi = require('../rsi/rsi.strategy');"}                                                                           | ${['../rsi/rsi.strategy']}
      ${'two imports of three, in their order'} | ${'dema/dema.strategy.ts'} | ${"import { a } from './dema.types';\nimport { b } from '../rsi/rsi.strategy';\nimport { c } from '../tma/tma.strategy';"} | ${['../rsi/rsi.strategy', '../tma/tma.strategy']}
    `('should refuse, in $file, $case', ({ file, source, refused }) => {
      expect(refusedImports(file, source)).toEqual(refused);
    });
  });

  describe('the files of packages/strategies/src', () => {
    it.each(STRATEGY_FILES)(
      'should import, in %s, nothing of the package but its own directory, strategy.types, trailingStopManager.types and, in a test, a bench or a mock, strategy.mock',
      file => {
        expect(refusedImports(file, readFileSync(path.join(SOURCES, file), 'utf8'))).toEqual([]);
      },
    );
  });
});
