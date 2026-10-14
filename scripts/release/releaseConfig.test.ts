import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';

// The release attached an executable the build no longer wrote, which @semantic-release/github only logs, and committed no
// package.json. These tests read release.config.cjs as semantic-release does and hold it to the build:exec script.
type ConfiguredPlugin = [string, Record<string, unknown>];
type Asset = string | { path: string };
const { plugins }: { plugins: (string | ConfiguredPlugin)[] } = createRequire(import.meta.url)('../../release.config.cjs');

const names = plugins.map(plugin => (Array.isArray(plugin) ? plugin[0] : plugin));
const isConfigured = (plugin: string | ConfiguredPlugin): plugin is ConfiguredPlugin => Array.isArray(plugin);
const optionsOf = (name: string) => plugins.filter(isConfigured).find(([pluginName]) => pluginName === name)?.[1];
const buildOutfile = /--outfile[= ](\S+)/.exec(packageJson.scripts['build:exec'])?.[1];

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
});
