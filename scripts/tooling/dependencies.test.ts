import { describe, expect, it } from 'vitest';
import { DEPENDENCIES } from '../../eslint.config.js';
import { readPackageJson, workspaceDirectories } from './workspaces.helper';

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
});
