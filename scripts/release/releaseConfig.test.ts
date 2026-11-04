import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import { readPackageJson, workspaceDirectories } from '../tooling/workspaces.helper';

// The release attached an executable the build no longer wrote, which @semantic-release/github only logs, and committed no
// package.json. These tests read release.config.cjs as semantic-release does and hold it to the build:exec scripts.
type ConfiguredPlugin = [string, Record<string, unknown>];
type Asset = string | { path: string; label?: string };
const require = createRequire(import.meta.url);
const { plugins }: { plugins: (string | ConfiguredPlugin)[] } = require('../../release.config.cjs');

const names = plugins.map(plugin => (Array.isArray(plugin) ? plugin[0] : plugin));
const isConfigured = (plugin: string | ConfiguredPlugin): plugin is ConfiguredPlugin => Array.isArray(plugin);
const optionsOf = (name: string) => plugins.filter(isConfigured).find(([pluginName]) => pluginName === name)?.[1];
const assets = (optionsOf('@semantic-release/github')?.assets ?? []) as Asset[];
const attached = assets.map(asset => (typeof asset === 'string' ? asset : asset.path));

// The workspaces whose build:exec script `turbo run build:exec` runs, each with the file it writes, relative to the root
const builds = workspaceDirectories().flatMap(workspace => {
  const script = readPackageJson(workspace).scripts?.['build:exec'];
  const outfile = script === undefined ? undefined : /--outfile[= ](\S+)/.exec(script)?.[1];
  return script === undefined ? [] : [[workspace, outfile && path.posix.join(workspace, outfile)] as const];
});

// The parser the commit-msg hook validates a message with: commitlint.config.cjs's own preset, else that of the configuration it
// extends. The release read the commits with the default Angular preset instead, which takes neither `feat!:` nor a
// `BREAKING-CHANGE:` footer for a breaking change: such a change passed the hook and was released as a minor or a patch.
const commitlint: { extends: string[]; parserPreset?: string } = require('../../commitlint.config.cjs');
const hookParser: string = commitlint.parserPreset ?? (await import(commitlint.extends[0])).default.parserPreset;

// semantic-release loads a plugin it depends on itself from its own directory first, so a plugin declared in another major than
// the one semantic-release requires is never the one that runs: @semantic-release/github was declared in 12, and 11 ran.
const semanticReleaseDependencies: Record<string, string> = require('semantic-release/package.json').dependencies;
const majorOf = (range: string | undefined) => /^\^(\d+)\./.exec(range ?? '')?.[1];

describe('release.config.cjs', () => {
  it('should attach to the GitHub release dist/gekko and dist/fox, the executables of the two apps', () => {
    expect(attached).toEqual(['dist/gekko', 'dist/fox']);
  });

  it('should label each executable with its name and the platform that built it', () => {
    expect(assets.map(asset => (typeof asset === 'string' ? undefined : asset.label))).toEqual([
      `gekko executable (${process.platform}-${process.arch})`,
      `fox executable (${process.platform}-${process.arch})`,
    ]);
  });

  it('should have the version plugin check the files it attaches', () => {
    expect(optionsOf('./scripts/release/version.cjs')?.executables).toEqual(attached);
  });

  // The version plugin runs the root's build:exec once: through turbo, it builds every app
  it('should build with turbo, which runs the build:exec script of every workspace that has one', () => {
    expect(packageJson.scripts['build:exec']).toBe('turbo run build:exec');
  });

  it.each(builds)('should attach the file the build:exec script of %s writes, %s', (_workspace, outfile) => {
    expect(attached).toContain(outfile);
  });

  // The reverse: a file attached that no build:exec writes, which the version plugin refuses before anything is tagged
  it.each(attached)('should build %s, attached to the release, with the build:exec script of a workspace', outfile => {
    expect(builds.map(([, built]) => built)).toContain(outfile);
  });

  it('should write the version after the changelog and before the release commit', () => {
    expect(names).toEqual([
      '@semantic-release/commit-analyzer',
      '@semantic-release/release-notes-generator',
      '@semantic-release/changelog',
      './scripts/release/version.cjs',
      '@semantic-release/github',
      '@semantic-release/git',
    ]);
  });

  it('should commit package.json with the changelog', () => {
    expect(optionsOf('@semantic-release/git')?.assets).toEqual(['CHANGELOG.md', 'package.json']);
  });

  it.each`
    plugin
    ${'@semantic-release/commit-analyzer'}
    ${'@semantic-release/release-notes-generator'}
  `('should have $plugin read the commits with the parser of the commit-msg hook', ({ plugin }) => {
    expect(`conventional-changelog-${optionsOf(plugin)?.preset}`).toBe(hookParser);
  });

  // The plugins import the preset from their own directory, then from the working directory: it came only through commitlint
  it('should declare the preset package', () => {
    expect(Object.keys(packageJson.devDependencies)).toContain(hookParser);
  });

  it('should resolve the preset package', async () => {
    await expect(import(hookParser)).resolves.toHaveProperty('default');
  });

  it('should declare semantic-release, whose own plugin versions run', () => {
    expect(Object.keys(packageJson.devDependencies)).toContain('semantic-release');
  });

  it.each`
    plugin
    ${'@semantic-release/commit-analyzer'}
    ${'@semantic-release/release-notes-generator'}
    ${'@semantic-release/github'}
  `('should declare $plugin in the major semantic-release loads', ({ plugin }) => {
    expect(majorOf(packageJson.devDependencies[plugin as keyof typeof packageJson.devDependencies])).toBe(
      majorOf(semanticReleaseDependencies[plugin]),
    );
  });
});
