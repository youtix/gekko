import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { prepare, verifyConditions, type Exec, type VersionPluginContext } from './version.cjs';

// The plugin runs in a temporary directory, on a copy of the real package.json. Its build is a stub that writes the executables with
// the version package.json carries when the build runs, so a test can tell whether the version was written first.
const EXECUTABLES = ['dist/gekko', 'dist/fox'];
const VERSION = '9.8.7';
const PACKAGE_JSON = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
// A workspace's package.json, which carries no version: the root's is the one version of the checkout
const WORKSPACE_PACKAGE_JSON = `${JSON.stringify({ name: '@gekko/cli', private: true }, null, 2)}\n`;

const versionIn = (dir: string): string => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

/** A build that writes the executables named, each holding the version package.json carries */
const buildOf =
  (executables: string[]): Exec =>
  (_file, _args, { cwd }) => {
    for (const executable of executables) {
      mkdirSync(path.dirname(path.join(cwd, executable)), { recursive: true });
      writeFileSync(path.join(cwd, executable), versionIn(cwd));
    }
  };
const buildExecutables = buildOf(EXECUTABLES);

describe('version plugin', () => {
  describe('verifyConditions', () => {
    it('should accept a list of paths as the executables', () => {
      expect(() => verifyConditions({ executables: EXECUTABLES })).not.toThrow();
    });

    it.each`
      case                         | executables
      ${'no list'}                 | ${undefined}
      ${'an empty list'}           | ${[]}
      ${'a path alone'}            | ${'dist/gekko'}
      ${'a list holding a number'} | ${['dist/gekko', 42]}
      ${'a list holding no path'}  | ${['dist/gekko', '']}
    `('should refuse $case as the executables', ({ executables }) => {
      expect(() => verifyConditions({ executables })).toThrow('The version plugin needs the paths of the executables');
    });

    it('should name what it was given', () => {
      expect(() => verifyConditions({ executables: ['dist/gekko', 42] })).toThrow("got [ 'dist/gekko', 42 ]");
    });
  });

  describe('prepare', () => {
    let dir: string;
    let log: Mock<(message: string) => void>;
    let context: VersionPluginContext;

    const read = (file: string) => readFileSync(path.join(dir, file), 'utf8');
    const write = (file: string, content: string) => {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    };

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'gekko-release-'));
      write('package.json', PACKAGE_JSON);
      write('apps/gekko/package.json', WORKSPACE_PACKAGE_JSON);
      log = vi.fn();
      context = { cwd: dir, nextRelease: { version: VERSION }, logger: { log } };
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('should write 9.8.7, the version being released, into package.json', () => {
      prepare({ executables: EXECUTABLES }, context, buildExecutables);
      expect(versionIn(dir)).toBe(VERSION);
    });

    it('should leave package.json as it was but for its version', () => {
      prepare({ executables: EXECUTABLES }, context, buildExecutables);
      const { version } = JSON.parse(PACKAGE_JSON);
      expect(read('package.json')).toBe(PACKAGE_JSON.replace(`"version": "${version}"`, `"version": "${VERSION}"`));
    });

    it("should leave a workspace's package.json without a version", () => {
      prepare({ executables: EXECUTABLES }, context, buildExecutables);
      expect(read('apps/gekko/package.json')).toBe(WORKSPACE_PACKAGE_JSON);
    });

    it.each`
      executable
      ${'dist/gekko'}
      ${'dist/fox'}
    `('should build $executable, carrying 9.8.7, the version being released', ({ executable }) => {
      prepare({ executables: EXECUTABLES }, context, buildExecutables);
      expect(read(executable)).toBe(VERSION);
    });

    it('should build once, with bun run build:exec, in the working directory of the release', () => {
      const exec = vi.fn(buildExecutables);
      prepare({ executables: EXECUTABLES }, context, exec);
      expect(exec.mock.calls).toEqual([['bun', ['run', '--silent', 'build:exec'], { cwd: dir, stdio: 'inherit' }]]);
    });

    it('should log the version written, then the executables rebuilt', () => {
      prepare({ executables: EXECUTABLES }, context, buildExecutables);
      expect(log.mock.calls).toEqual([['Wrote version 9.8.7 into package.json'], ['Rebuilt dist/gekko and dist/fox with version 9.8.7']]);
    });

    it('should log the executable rebuilt when there is one', () => {
      prepare({ executables: ['dist/gekko'] }, context, buildOf(['dist/gekko']));
      expect(log.mock.calls.at(-1)).toEqual(['Rebuilt dist/gekko with version 9.8.7']);
    });

    it.each`
      case                                       | built             | error
      ${'no executable'}                         | ${[]}             | ${'bun run build:exec wrote none of dist/gekko and dist/fox, which the GitHub release attaches'}
      ${'one of the executables, not the other'} | ${['dist/gekko']} | ${'bun run build:exec wrote no dist/fox, which the GitHub release attaches'}
    `('should refuse a build that writes $case, naming what it did not write', ({ built, error }) => {
      expect(() => prepare({ executables: EXECUTABLES }, context, buildOf(built))).toThrow(error);
    });

    it('should refuse a build that writes no executable, even when an earlier build left them', () => {
      for (const executable of EXECUTABLES) write(executable, 'an earlier build');
      expect(() => prepare({ executables: EXECUTABLES }, context, vi.fn())).toThrow(
        'bun run build:exec wrote none of dist/gekko and dist/fox',
      );
    });

    it('should run the build:exec script of package.json with bun when no runner is given', () => {
      const script = 'mkdir -p dist && printf built > dist/gekko && printf built > dist/fox';
      write('package.json', JSON.stringify({ scripts: { 'build:exec': script } }));
      prepare({ executables: EXECUTABLES }, context);
      expect(EXECUTABLES.map(read)).toEqual(['built', 'built']);
    });
  });
});
