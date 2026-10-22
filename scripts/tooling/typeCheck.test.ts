import { readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { globalDeclarationFiles, readPackageJson, ROOT, workspaceDirectories } from './workspaces.helper';

// The files each type check reads, from its tsconfig as tsc reads it. The default include left out version.cjs, whose version.d.cts
// outranks it, and tsconfig's former exclude left out vitest.config.ts: neither was type-checked. tsconfig.json is the whole checkout
// in one program, which the editor and the pre-commit hook's check of the index read; each workspace's type:check reads its own
// tsconfig.json, and type:check:scripts reads tsconfig.scripts.json.
const parse = (tsconfig: string) =>
  ts.getParsedCommandLineOfConfigFile(path.join(ROOT, tsconfig), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });

const filesOf = (tsconfig: string) => parse(tsconfig)?.fileNames ?? [];

/** A tsconfig as written, without what it extends */
const rawConfigOf = (tsconfig: string): { extends?: unknown; compilerOptions?: { paths?: Record<string, string[]> } } =>
  ts.readConfigFile(path.join(ROOT, tsconfig), ts.sys.readFile).config ?? {};

const WORKSPACES = workspaceDirectories();
const CHECKOUT_FILES = filesOf('tsconfig.json');
const SCRIPTS_FILES = filesOf('tsconfig.scripts.json');
const SCRIPTS_SOURCES = readdirSync(path.join(ROOT, 'scripts'), { recursive: true, encoding: 'utf8' })
  .filter(file => file.endsWith('.ts'))
  .map(file => `scripts/${file}`);
const BASE_PATHS = rawConfigOf('tsconfig.base.json').compilerOptions?.paths ?? {};

describe('type check', () => {
  describe('tsconfig.json, the whole checkout', () => {
    it.each`
      file
      ${'vitest.config.ts'}
      ${'vitest.shared.ts'}
      ${'scripts/release/version.cjs'}
    `('should read $file', ({ file }) => {
      expect(CHECKOUT_FILES).toContain(path.join(ROOT, file));
    });

    // The pre-commit hook checks the index with it: a file another type check reads and this one does not is committed unchecked
    it.each([...WORKSPACES.map(workspace => `${workspace}/tsconfig.json`), 'tsconfig.scripts.json'])(
      'should read every file %s reads',
      tsconfig => {
        expect(filesOf(tsconfig).filter(file => !CHECKOUT_FILES.includes(file))).toEqual([]);
      },
    );
  });

  describe('tsconfig.scripts.json, the root tasks', () => {
    it.each([...SCRIPTS_SOURCES, 'scripts/release/version.cjs', 'vitest.config.ts', 'vitest.shared.ts'])('should read %s', file => {
      expect(SCRIPTS_FILES).toContain(path.join(ROOT, file));
    });

    // The documentation test imports the strategies and the plugins, whose modules reach the indicators: without the registry entries
    // each indicator's types declare, and EpochTimeStamp, their code did not type-check in this program
    it('should read every global declaration of the workspaces', () => {
      expect(globalDeclarationFiles().filter(file => !SCRIPTS_FILES.includes(file))).toEqual([]);
    });
  });

  describe.each(WORKSPACES)('%s', workspace => {
    it('should extend tsconfig.base.json, whose compiler options and paths every workspace shares', () => {
      expect(rawConfigOf(`${workspace}/tsconfig.json`).extends).toBe('../../tsconfig.base.json');
    });

    it('should read its vitest.config.ts', () => {
      expect(filesOf(`${workspace}/tsconfig.json`)).toContain(path.join(ROOT, workspace, 'vitest.config.ts'));
    });

    // tsc, Bun, vitest and ESLint resolve `@gekko/<package>/<path>` through these paths alone, to the sources of the package
    it('should have a path in tsconfig.base.json from its name to its sources', () => {
      expect(BASE_PATHS[`${readPackageJson(workspace).name}/*`]).toEqual([`./${workspace}/src/*`]);
    });
  });
});
