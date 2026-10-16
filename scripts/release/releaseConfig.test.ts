import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';

// The release attached an executable the build no longer wrote, which @semantic-release/github only logs, and committed no
// package.json. These tests read release.config.cjs as semantic-release does and hold it to the build:exec script.
type ConfiguredPlugin = [string, Record<string, unknown>];
type Asset = string | { path: string };
const require = createRequire(import.meta.url);
const { plugins }: { plugins: (string | ConfiguredPlugin)[] } = require('../../release.config.cjs');

const names = plugins.map(plugin => (Array.isArray(plugin) ? plugin[0] : plugin));
const isConfigured = (plugin: string | ConfiguredPlugin): plugin is ConfiguredPlugin => Array.isArray(plugin);
const optionsOf = (name: string) => plugins.filter(isConfigured).find(([pluginName]) => pluginName === name)?.[1];
const buildOutfile = /--outfile[= ](\S+)/.exec(packageJson.scripts['build:exec'])?.[1];

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
  it('should attach to the GitHub release the file build:exec writes', () => {
    const assets = optionsOf('@semantic-release/github')?.assets as Asset[];
    expect(assets.map(asset => (typeof asset === 'string' ? asset : asset.path))).toEqual([buildOutfile]);
  });

  it('should have the version plugin check the file build:exec writes', () => {
    expect(optionsOf('./scripts/release/version.cjs')?.executable).toBe(buildOutfile);
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
