import { readdirSync, readFileSync } from 'node:fs';
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

/** The files a tsconfig names, its includes resolved: those a program starts from */
const filesOf = (tsconfig: string) => parse(tsconfig)?.fileNames ?? [];

/** The files a type check reads: those its tsconfig names, and every file they import, as tsc builds its program */
const sourcesOf = (tsconfig: string) => {
  const { fileNames: rootNames = [], options = {} } = parse(tsconfig) ?? {};
  return ts
    .createProgram({ rootNames, options })
    .getSourceFiles()
    .map(({ fileName }) => fileName);
};

// Building a program reads every file it reaches, the declarations of node_modules included: some seconds
const PROGRAM_TIMEOUT = 60_000;

/** The modules a file imports by a relative path, absolute, with their extension */
const relativeImportsOf = (file: string) =>
  ts
    .preProcessFile(readFileSync(file, 'utf8'))
    .importedFiles.map(({ fileName }) => fileName)
    .filter(specifier => specifier.startsWith('.'))
    .map(specifier => `${path.resolve(path.dirname(file), specifier)}.ts`);

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
const INDICATORS_SOURCES = path.join(ROOT, 'packages/indicators/src');
const INDICATOR_TYPES = path.join(INDICATORS_SOURCES, 'indicator.types.ts');
/** The modules of the indicators that augment IndicatorRegistry, each with the entry of its indicator */
const REGISTRY_ENTRIES = globalDeclarationFiles().filter(file => file.startsWith(`${INDICATORS_SOURCES}/`) && !file.endsWith('.d.ts'));

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
    // each indicator's types declare, and EpochTimeStamp, their code did not type-check in this program. The declaration files come
    // with the include, the registry entries with indicator.types.ts, which imports them: the program's files, not the include's
    it(
      'should read every global declaration of the workspaces',
      () => {
        const sources = new Set(sourcesOf('tsconfig.scripts.json'));
        expect(globalDeclarationFiles().filter(file => !sources.has(file))).toEqual([]);
      },
      PROGRAM_TIMEOUT,
    );
  });

  describe('packages/indicators/src/indicator.types.ts', () => {
    // Each indicator's IndicatorRegistry entry is a global declaration of its <name>.types.ts, which importing the indicator does not
    // bring: indicator.types.ts imports every one, where the indicators, the moving averages and the strategies' types lead, so that a
    // program reaching an indicator sees them all, without its tsconfig including them
    it('should import every module of the indicators that declares a registry entry', () => {
      const imported = relativeImportsOf(INDICATOR_TYPES);
      expect(REGISTRY_ENTRIES.filter(file => !imported.includes(file))).toEqual([]);
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
