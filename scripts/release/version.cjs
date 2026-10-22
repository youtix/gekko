// @ts-check
// The release's own semantic-release plugin. No release step wrote package.json, whose version the executables print at start-up,
// so a release printed whatever version was typed in last, and the GitHub release named an executable the build no longer wrote,
// which @semantic-release/github only logs: two releases went out without one. Its prepare step, run after the changelog's and
// before the release commit, writes the version being released into the root package.json, the one version of the checkout (the
// workspaces' package.json files have none), and rebuilds every executable from it.
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { inspect } = require('node:util');

/**
 * Names the paths in words: `a`, `a and b`, `a, b and c`.
 *
 * @param {string[]} paths at least one path
 */
const listInWords = paths => (paths.length === 1 ? paths[0] : `${paths.slice(0, -1).join(', ')} and ${paths.at(-1)}`);

/**
 * Refuses a configuration that does not list the executables, before anything is released.
 *
 * @param {{ executables?: unknown }} pluginConfig the plugin's options in release.config.cjs
 */
const verifyConditions = ({ executables }) => {
  const isPathList =
    Array.isArray(executables) &&
    executables.length > 0 &&
    executables.every(executable => typeof executable === 'string' && executable !== '');
  if (!isPathList) {
    throw new Error(
      `The version plugin needs the paths of the executables the GitHub release attaches, as its executables option, a list of one ` +
        `path or more: got ${inspect(executables)}`,
    );
  }
};

/**
 * Writes the version being released into the root package.json, then rebuilds the executables with `bun run build:exec`, which
 * builds every app, so that each executable the GitHub release attaches prints that version.
 *
 * @param {{ executables: string[] }} pluginConfig the plugin's options in release.config.cjs
 * @param {{ cwd: string, nextRelease: { version: string }, logger: { log: (message: string) => void } }} context the part of
 *   semantic-release's context the plugin reads
 * @param {(file: string, args: string[], options: { cwd: string, stdio: 'inherit' }) => unknown} [exec] runs the build and
 *   throws if it fails, as execFileSync does
 */
const prepare = ({ executables }, { cwd, nextRelease: { version }, logger }, exec = execFileSync) => {
  const packageJsonPath = path.resolve(cwd, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  // Two spaces and a final newline, as Prettier writes package.json, so that the release commit changes the version only
  writeFileSync(packageJsonPath, `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`);
  logger.log(`Wrote version ${version} into package.json`);

  // The executables an earlier build left, such as those CI builds before it releases, must not pass for these ones
  for (const executable of executables) rmSync(path.resolve(cwd, executable), { force: true });
  exec('bun', ['run', '--silent', 'build:exec'], { cwd, stdio: 'inherit' });
  const missing = executables.filter(executable => !existsSync(path.resolve(cwd, executable)));
  if (missing.length) {
    throw new Error(
      `bun run build:exec wrote ${missing.length === 1 ? 'no' : 'none of'} ${listInWords(missing)}, which the GitHub release attaches`,
    );
  }
  logger.log(`Rebuilt ${listInWords(executables)} with version ${version}`);
};

module.exports = { verifyConditions, prepare };
