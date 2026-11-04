const path = require('node:path');

// The executables `bun run build:exec` writes, one per app (turbo runs the build:exec script of apps/gekko and of apps/fox), which the
// GitHub release attaches. Their names stay the same from one release to the next, so that a link to the latest release's executable
// keeps working.
const EXECUTABLES = ['dist/gekko', 'dist/fox'];

// The commits are read as the commit-msg hook validates them, with the Conventional Commits parser of commitlint's configuration.
// Under the default Angular preset, `feat!:` and a `BREAKING-CHANGE:` footer passed the hook but were not read as breaking: such a
// change was released as a minor or a patch, without a note.
const PRESET = 'conventionalcommits';

module.exports = {
  branches: ['main'],
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: PRESET }],
    ['@semantic-release/release-notes-generator', { preset: PRESET }],
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    // Writes the version being released into the root package.json, which the executables print at start-up, then rebuilds them
    ['./scripts/release/version.cjs', { executables: EXECUTABLES }],
    // The label names the platform: bun build --compile builds for the machine it runs on, the one running this release
    [
      '@semantic-release/github',
      {
        assets: EXECUTABLES.map(executable => ({
          path: executable,
          label: `${path.basename(executable)} executable (${process.platform}-${process.arch})`,
        })),
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'package.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
  ],
};
