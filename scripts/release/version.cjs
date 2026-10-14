// @ts-check
// The release's own semantic-release plugin. No release step wrote package.json, whose version the executable prints at start-up,
// so a release printed whatever version was typed in last, and the GitHub release named an executable the build no longer wrote,
// which @semantic-release/github only logs: two releases went out without one. Its prepare step, run after the changelog's and
// before the release commit, writes the version being released into package.json and rebuilds the executable from it.
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');

/**
 * Refuses a configuration that does not name the executable, before anything is released.
 *
 * @param {{ executable?: unknown }} pluginConfig the plugin's options in release.config.cjs
 */
const verifyConditions = ({ executable }) => {
  if (typeof executable !== 'string' || executable === '') {
    throw new Error('The version plugin needs the path of the executable the GitHub release attaches, as its executable option');
  }
};

/**
 * Writes the version being released into package.json, then rebuilds the executable with `bun run build:exec`, so that the
 * executable the GitHub release attaches prints that version.
 *
 * @param {{ executable: string }} pluginConfig the plugin's options in release.config.cjs
 * @param {{ cwd: string, nextRelease: { version: string }, logger: { log: (message: string) => void } }} context the part of
 *   semantic-release's context the plugin reads
 * @param {(file: string, args: string[], options: { cwd: string, stdio: 'inherit' }) => unknown} [exec] runs the build and
 *   throws if it fails, as execFileSync does
 */
const prepare = ({ executable }, { cwd, nextRelease: { version }, logger }, exec = execFileSync) => {
  const packageJsonPath = path.resolve(cwd, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  // Two spaces and a final newline, as Prettier writes package.json, so that the release commit changes the version only
  writeFileSync(packageJsonPath, `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`);
  logger.log(`Wrote version ${version} into package.json`);

  // The executable an earlier build left, such as the one CI builds before it releases, must not pass for this one
  const executablePath = path.resolve(cwd, executable);
  rmSync(executablePath, { force: true });
  exec('bun', ['run', '--silent', 'build:exec'], { cwd, stdio: 'inherit' });
  if (!existsSync(executablePath)) {
    throw new Error(`bun run build:exec wrote no ${executable}, the executable the GitHub release attaches`);
  }
  logger.log(`Rebuilt ${executable} with version ${version}`);
};

module.exports = { verifyConditions, prepare };
