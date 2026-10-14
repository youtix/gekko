import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { prepare, verifyConditions, type Exec, type VersionPluginContext } from './version.cjs';

// The plugin runs in a temporary directory, on a copy of the real package.json. Its build is a stub that writes the executable
// with the version package.json carries when the build runs, so a test can tell whether the version was written first.
const EXECUTABLE = 'dist/gekko2';
const VERSION = '9.8.7';
const PACKAGE_JSON = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');

const versionIn = (dir: string): string => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

const buildExecutable: Exec = (_file, _args, { cwd }) => {
  mkdirSync(path.join(cwd, 'dist'), { recursive: true });
  writeFileSync(path.join(cwd, EXECUTABLE), versionIn(cwd));
};

describe('version plugin', () => {
  describe('verifyConditions', () => {
    it('should accept a path as the executable', () => {
      expect(() => verifyConditions({ executable: EXECUTABLE })).not.toThrow();
    });

    it.each`
      case            | executable
      ${'no path'}    | ${undefined}
      ${'empty path'} | ${''}
      ${'number'}     | ${42}
    `('should refuse a $case as the executable', ({ executable }) => {
      expect(() => verifyConditions({ executable })).toThrow('The version plugin needs the path of the executable');
    });
  });

  describe('prepare', () => {
    let dir: string;
    let log: Mock<(message: string) => void>;
    let context: VersionPluginContext;

    const read = (file: string) => readFileSync(path.join(dir, file), 'utf8');

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'gekko-release-'));
      writeFileSync(path.join(dir, 'package.json'), PACKAGE_JSON);
      log = vi.fn();
      context = { cwd: dir, nextRelease: { version: VERSION }, logger: { log } };
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('should write 9.8.7, the version being released, into package.json', () => {
      prepare({ executable: EXECUTABLE }, context, buildExecutable);
      expect(versionIn(dir)).toBe(VERSION);
    });

    it('should leave package.json as it was but for its version', () => {
      prepare({ executable: EXECUTABLE }, context, buildExecutable);
      const { version } = JSON.parse(PACKAGE_JSON);
      expect(read('package.json')).toBe(PACKAGE_JSON.replace(`"version": "${version}"`, `"version": "${VERSION}"`));
    });

    it('should build an executable that carries 9.8.7, the version being released', () => {
      prepare({ executable: EXECUTABLE }, context, buildExecutable);
      expect(read(EXECUTABLE)).toBe(VERSION);
    });

    it('should build with bun run build:exec, in the working directory of the release', () => {
      const exec = vi.fn(buildExecutable);
      prepare({ executable: EXECUTABLE }, context, exec);
      expect(exec).toHaveBeenCalledWith('bun', ['run', '--silent', 'build:exec'], { cwd: dir, stdio: 'inherit' });
    });

    it('should log the version written, then the executable rebuilt', () => {
      prepare({ executable: EXECUTABLE }, context, buildExecutable);
      expect(log.mock.calls).toEqual([['Wrote version 9.8.7 into package.json'], ['Rebuilt dist/gekko2 with version 9.8.7']]);
    });

    it('should refuse a build that writes no executable', () => {
      expect(() => prepare({ executable: EXECUTABLE }, context, vi.fn())).toThrow('bun run build:exec wrote no dist/gekko2');
    });

    it('should refuse a build that writes no executable, even when an earlier build left one', () => {
      mkdirSync(path.join(dir, 'dist'));
      writeFileSync(path.join(dir, EXECUTABLE), 'an earlier build');
      expect(() => prepare({ executable: EXECUTABLE }, context, vi.fn())).toThrow('bun run build:exec wrote no dist/gekko2');
    });

    it('should run the build:exec script of package.json with bun when no runner is given', () => {
      const script = `mkdir -p dist && printf built > ${EXECUTABLE}`;
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { 'build:exec': script } }));
      prepare({ executable: EXECUTABLE }, context);
      expect(read(EXECUTABLE)).toBe('built');
    });
  });
});
