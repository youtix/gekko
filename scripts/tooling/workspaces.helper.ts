import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The root of the checkout, where the root package.json declares the workspaces and tsconfig.base.json their paths */
export const ROOT = path.resolve(import.meta.dirname, '../..');

export type PackageJson = {
  name: string;
  workspaces?: string[];
  scripts?: Partial<Record<string, string>>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** The package.json of a directory, relative to the root ('.' for the root's own) */
export const readPackageJson = (directory: string): PackageJson =>
  JSON.parse(readFileSync(path.join(ROOT, directory, 'package.json'), 'utf8'));

const hasPackageJson = (directory: string) => existsSync(path.join(ROOT, directory, 'package.json'));

/**
 * The directories of the workspaces, relative to the root and sorted, as Bun and turbo find them: each directory holding a package.json
 * that a pattern of the root package.json's `workspaces` names, `packages/*` and `apps/*` naming every directory under theirs. An app
 * still being written, without its package.json, is none.
 */
export const workspaceDirectories = (): string[] =>
  (readPackageJson('.').workspaces ?? [])
    .flatMap(pattern => {
      if (!pattern.endsWith('/*')) return [pattern];
      const parent = pattern.slice(0, -'/*'.length);
      return readdirSync(path.join(ROOT, parent), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => `${parent}/${entry.name}`);
    })
    .filter(hasPackageJson)
    .sort();

const isGlobalDeclarationFile = (file: string) =>
  file.endsWith('.d.ts') ||
  (file.endsWith('.ts') && !/\.(test|bench)\.ts$/.test(file) && readFileSync(file, 'utf8').includes('declare global'));

/**
 * The files of the workspaces' sources that declare globals, absolute and sorted: the declaration files (EpochTimeStamp, the empty
 * IndicatorRegistry), which nothing imports, so that a program sees them only when its tsconfig includes them, and the modules that
 * augment them (each indicator's entry in IndicatorRegistry), which packages/indicators/src/indicator.types.ts imports, so that a
 * program sees them once it reaches an indicator or the strategies' types.
 */
export const globalDeclarationFiles = (): string[] =>
  workspaceDirectories()
    .map(workspace => path.join(ROOT, workspace, 'src'))
    .filter(sources => existsSync(sources))
    .flatMap(sources => readdirSync(sources, { recursive: true, encoding: 'utf8' }).map(file => path.join(sources, file)))
    .filter(isGlobalDeclarationFile)
    .sort();
