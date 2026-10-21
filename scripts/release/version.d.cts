// The types of version.cjs for its test, which also imports Exec and VersionPluginContext, types the JavaScript file does not
// export: tsc resolves the test's import of './version.cjs' to this file, and checks version.cjs on its own, against its JSDoc
// (allowJs and its @ts-check). Neither is checked against the other: a change to the plugin's parameters is made in both.

/** The version plugin's options in release.config.cjs. */
export interface VersionPluginConfig {
  /** The file `bun run build:exec` writes, relative to the working directory: the executable the GitHub release attaches. */
  executable: string;
}

/** The part of semantic-release's context the version plugin reads. */
export interface VersionPluginContext {
  cwd: string;
  nextRelease: { version: string };
  logger: { log: (message: string) => void };
}

/** Runs a command and throws if it fails, as `execFileSync` does. */
export type Exec = (file: string, args: string[], options: { cwd: string; stdio: 'inherit' }) => unknown;

/** Refuses a configuration that does not name the executable. */
export function verifyConditions(pluginConfig: { executable?: unknown }): void;

/** Writes the version being released into package.json, then rebuilds the executable from it, with `exec` (execFileSync by default). */
export function prepare(pluginConfig: VersionPluginConfig, context: VersionPluginContext, exec?: Exec): void;
