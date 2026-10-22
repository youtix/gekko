import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DEPENDENCIES } from '../../eslint.config.js';
import { readPackageJson, ROOT, workspaceDirectories } from './workspaces.helper';

// The graph of the workspaces is written twice: each workspace's package.json names, as `workspace:*` dependencies, the workspaces its
// sources and its tests import, and DEPENDENCIES of eslint.config.js names, for each workspace (apps/gekko's sources and its tests
// apart, the tests reading more), those its files may import, ESLint refusing an import of any other. The rows hold the two to each
// other: a workspace lists nothing ESLint refuses, and everything ESLint lets its sources import.
const GRAPH: Record<string, readonly string[]> = DEPENDENCIES;
const WORKSPACES = workspaceDirectories();
const DIRECTORY_BY_NAME = Object.fromEntries(WORKSPACES.map(directory => [readPackageJson(directory).name, directory]));
const workspaceOf = (target: string) => WORKSPACES.find(workspace => target === workspace || target.startsWith(`${workspace}/`));

/** The workspaces a workspace's package.json lists, as directories, sorted */
const listed = (directory: string) => {
  const { dependencies = {}, devDependencies = {} } = readPackageJson(directory);
  return Object.keys({ ...dependencies, ...devDependencies })
    .filter(name => name.startsWith('@gekko/'))
    .map(name => DIRECTORY_BY_NAME[name])
    .sort();
};

/** The workspaces ESLint lets any file of a workspace import: its zones together */
const allowed = (directory: string) =>
  [
    ...new Set(
      Object.entries(GRAPH)
        .filter(([target]) => workspaceOf(target) === directory)
        .flatMap(([, imports]) => imports),
    ),
  ].sort();

/** The workspaces ESLint lets the sources of a workspace import: the zone of the workspace, or of its src/ */
const allowedToSources = (directory: string) => [...(GRAPH[directory] ?? GRAPH[`${directory}/src`] ?? [])].sort();

// The root's own modules, the configurations at the root and the files of scripts/, import packages from the root's node_modules, where
// Bun's hoisted linker also puts what the workspaces declare: a package the root imported without declaring it resolved there, until an
// isolated install (`bun install --linker isolated`, or a lockfile written anew, whose `configVersion` 1 selects that linker) left it
// out, failing the root's suite and its type check
const SCRIPT_FILE = /\.[cm]?[jt]s$/;
const ROOT_FILES = [
  ...readdirSync(ROOT).filter(file => SCRIPT_FILE.test(file)),
  ...readdirSync(path.join(ROOT, 'scripts'), { recursive: true, encoding: 'utf8' })
    .filter(file => SCRIPT_FILE.test(file))
    .map(file => `scripts/${file}`),
].sort();
const { dependencies: rootDependencies = {}, devDependencies: rootDevDependencies = {} } = readPackageJson('.');
const ROOT_DECLARED = Object.keys({ ...rootDependencies, ...rootDevDependencies });

/** The package an import names: its scope and its name (`@eslint/js`), or its name alone (`vitest` of `vitest/config`) */
const packageOf = (specifier: string) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

/**
 * The packages a file imports from node_modules, its imports, re-exports, `import()` and `require()` together: not a relative path, a
 * builtin of Node or of Bun, nor a workspace, which the paths of tsconfig.base.json resolve
 */
const importedPackages = (file: string) =>
  ts
    .preProcessFile(readFileSync(path.join(ROOT, file), 'utf8'), true, true)
    .importedFiles.map(({ fileName }) => fileName)
    .filter(specifier => !specifier.startsWith('.') && !isBuiltin(specifier) && !/^(bun:|@gekko\/)/.test(specifier))
    .map(packageOf);

describe('dependencies', () => {
  it.each(Object.keys(GRAPH))('should map %s, a workspace or a directory of one, in eslint.config.js', target => {
    expect(workspaceOf(target)).toBeDefined();
  });

  it.each(Object.entries(GRAPH))('should let %s import workspaces only', (_target, imports) => {
    expect(imports.filter(directory => !WORKSPACES.includes(directory))).toEqual([]);
  });

  it.each(WORKSPACES)('should list in %s/package.json only workspaces ESLint lets its files import', workspace => {
    expect(allowed(workspace)).toEqual(expect.arrayContaining(listed(workspace)));
  });

  it.each(WORKSPACES)('should list in %s/package.json every workspace ESLint lets its sources import', workspace => {
    expect(listed(workspace)).toEqual(expect.arrayContaining(allowedToSources(workspace)));
  });

  it.each(ROOT_FILES)('should declare in the root package.json every package %s imports', file => {
    expect(importedPackages(file).filter(name => !ROOT_DECLARED.includes(name))).toEqual([]);
  });
});
