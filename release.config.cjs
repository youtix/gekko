// The executable `bun run build:exec` writes and the GitHub release attaches. Its name stays the same from one release to the next,
// so that a link to the latest release's executable keeps working.
const EXECUTABLE = 'dist/gekko2';

module.exports = {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    // Writes the version being released into package.json, which the executable prints at start-up, then rebuilds the executable
    ['./scripts/release/version.cjs', { executable: EXECUTABLE }],
    // The label names the platform: bun build --compile builds for the machine it runs on, the one running this release
    ['@semantic-release/github', { assets: [{ path: EXECUTABLE, label: `gekko2 executable (${process.platform}-${process.arch})` }] }],
    [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'package.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
  ],
};
