import { analyzerSchema } from '@plugins/analyzers/analyzer.schema';
import { candleWriterSchema } from '@plugins/candleWriter/candleWriter.schema';
import { eventSubscriberSchema } from '@plugins/eventSubscriber/eventSubscriber.schema';
import type * as plugins from '@plugins/index';
import { performanceReporterSchema } from '@plugins/performanceReporter/performanceReporter.schema';
import { supervisionSchema } from '@plugins/supervision/supervision.schema';
import { traderSchema } from '@plugins/trader/trader.schema';
import { tradingAdvisorSchema } from '@plugins/tradingAdvisor/tradingAdvisor.schema';
import { configurationSchema } from '@services/configuration/configuration.schema';
import * as strategies from '@strategies/index';
import type { StrategyConstructor } from '@strategies/strategy.types';
import { CORE_SCHEMA, load } from 'js-yaml';
import { isPlainObject, omit } from 'lodash-es';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';

// CLAUDE.md says that the YAML examples of the guides validate against the schemas and that their TypeScript examples type-check, and
// nothing read them: a schema or a type that changed left them stale until someone checked them by hand. These tests read every fenced
// block of documentation/*.md and README.md, and every configuration of config/, and hold them to the code. A block that shows part of
// something only (a key of a section, a line of a file) carries `fragment` after its language, as in ```yaml fragment, and is left out.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

const GUIDES = [
  ...readdirSync(path.join(ROOT, 'documentation'))
    .filter(file => file.endsWith('.md'))
    .sort()
    .map(file => `documentation/${file}`),
  'README.md',
];

/* -------------------------------------------------------------------------- */
/*                               FENCED BLOCKS                                */
/* -------------------------------------------------------------------------- */

type Block = { source: string; line: number; lang: string; where: string; isFragment: boolean; text: string };

const LANGUAGES: Record<string, string> = { yml: 'yaml', ts: 'typescript' };

/** The fenced blocks of a markdown text, numbered from 1 by language, with the line of their opening fence */
const blocksOf = (source: string, markdown: string): Block[] => {
  const lines = markdown.split('\n');
  const counts = new Map<string, number>();
  const blocks: Block[] = [];
  for (let start = 0; start < lines.length; start++) {
    const opening = /^(\s*)(`{3,}|~{3,})([^`]*)$/.exec(lines[start]);
    if (!opening) continue;
    const [, indent, fence, info] = opening;
    const closing = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`);
    let end = start + 1;
    while (end < lines.length && !closing.test(lines[end])) end++;
    const [word, ...flags] = info.trim().split(/\s+/);
    const lang = LANGUAGES[word] ?? word;
    const index = (counts.get(lang) ?? 0) + 1;
    counts.set(lang, index);
    const margin = new RegExp(`^ {0,${indent.length}}`);
    const text = lines
      .slice(start + 1, end)
      .map(line => line.replace(margin, ''))
      .join('\n');
    const where = `${source}:${start + 1} (${lang} block ${index})`;
    blocks.push({ source, line: start + 1, lang, where, isFragment: flags.includes('fragment'), text });
    start = end;
  }
  return blocks;
};

const guideBlocks = GUIDES.flatMap(source => blocksOf(source, read(source)));

/** A block as a guide writes it, for the samples */
const fenced = (info: string, ...lines: string[]) => ['```' + info, ...lines, '```'].join('\n');

/* -------------------------------------------------------------------------- */
/*                                    YAML                                    */
/* -------------------------------------------------------------------------- */

/**
 * The options of each plugin, by the name a configuration gives it. From the schema files: a plugin's own module loads the
 * configuration singleton, which throws without GEKKO_CONFIG_FILE_PATH. The type holds the map to the registry, so that a plugin added
 * there, or given another schema, fails the type check here.
 */
const PLUGIN_SCHEMAS: { [Name in keyof typeof plugins]: ReturnType<(typeof plugins)[Name]['getStaticConfiguration']>['schema'] } = {
  CandleWriter: candleWriterSchema,
  EventSubscriber: eventSubscriberSchema,
  PerformanceReporter: performanceReporterSchema,
  PortfolioAnalyzer: analyzerSchema,
  RoundTripAnalyzer: analyzerSchema,
  Supervision: supervisionSchema,
  Trader: traderSchema,
  TradingAdvisor: tradingAdvisorSchema,
};

/** The registry the StrategyManager looks a strategy up in, by its name */
const STRATEGIES: Partial<Record<string, StrategyConstructor>> = strategies;

/** A block holding these three is a whole configuration, checked as the loader checks a file; any other one section by section */
const CONFIGURATION_SECTIONS = ['watch', 'exchange', 'plugins'];
const SECTION_SCHEMAS: Partial<Record<string, ZodType>> = configurationSchema.shape;

// The configurations of config/ leave their credentials empty for the reader to fill in, and realtime-trader.yml its disclaimer false:
// the loader refuses both, so they are filled in as a reader would before a run, and the name of each test says so
const CREDENTIAL_STAND_INS: Record<string, string> = {
  apiKey: 'api-key',
  secret: 'api-secret',
  privateKey: '0x01',
  walletAddress: '0x02',
  token: 'bot-token',
  botUsername: 'bot',
};
const DISCLAIMER = 'I understand that Gekko only automates MY OWN trading strategies';

/** A yaml block, or a file of config/, which is a whole configuration whatever it holds */
type Document = { where: string; source: string; content: unknown; isFile?: boolean };
type Check = { where: string; what: string; issues: () => string[] };
type YamlChecks = { configurations: Check[]; entries: Check[]; strategyBlocks: Check[]; sections: Check[]; unchecked: string[] };

const issuesOf = (schema: ZodType, value: unknown) =>
  schema.safeParse(value).error?.issues.map(({ path: at, message }) => `${at.join('.') || '(top level)'}: ${message}`) ?? [];

const nameOf = (value: unknown) => (isPlainObject(value) ? (value as { name?: unknown }).name : undefined);

/** The plugin entries of a block: a list of entries, a single one, or the plugins section of a configuration */
const entriesOf = (content: unknown): unknown[] => {
  if (Array.isArray(content)) return content;
  if (nameOf(content) !== undefined) return [content];
  const list = isPlainObject(content) ? (content as { plugins?: unknown }).plugins : undefined;
  return Array.isArray(list) ? list : [];
};

const pluginCheck = (where: string, entry: unknown, index?: number): Check => {
  const name = nameOf(entry);
  const schema = typeof name === 'string' && Object.hasOwn(PLUGIN_SCHEMAS, name) ? PLUGIN_SCHEMAS[name as keyof typeof plugins] : null;
  return {
    where,
    what: `${index === undefined ? '' : `plugins[${index}] `}${String(name)}`,
    issues: () => (schema ? issuesOf(schema, entry) : [`no plugin is named ${String(name)} (${Object.keys(PLUGIN_SCHEMAS).join(', ')})`]),
  };
};

/** Checks a strategy block as the StrategyManager does, with the schema of the class its name selects, without its name */
const strategyCheck = (where: string, block: unknown, externalStrategies: Set<unknown>): Check | null => {
  const name = nameOf(block);
  const Strategy = typeof name === 'string' && Object.hasOwn(STRATEGIES, name) ? STRATEGIES[name] : undefined;
  // A strategy of the reader's, which a TradingAdvisor of the guides loads from a strategyPath: its own schema checks it at start-up
  if (!Strategy && externalStrategies.has(name)) return null;
  return {
    where,
    what: String(name),
    issues: () => {
      if (!Strategy) return [`no strategy of the registry is named ${String(name)}`];
      if (!Strategy.schema) return [`${String(name)} declares no schema to check its block with`];
      return issuesOf(Strategy.schema, omit(block as object, 'name'));
    },
  };
};

const yamlChecksOf = (documents: Document[], externalStrategies: Set<unknown>): YamlChecks => {
  const checks: YamlChecks = { configurations: [], entries: [], strategyBlocks: [], sections: [], unchecked: [] };
  for (const { where, content, isFile } of documents) {
    if (!isFile && (Array.isArray(content) || nameOf(content) !== undefined)) {
      entriesOf(content).forEach((entry, index) => checks.entries.push(pluginCheck(where, entry, Array.isArray(content) ? index : undefined)));
      continue;
    }
    const block = isPlainObject(content) ? (content as Record<string, unknown>) : {};
    const isConfiguration = isFile || CONFIGURATION_SECTIONS.every(section => section in block);
    if (isConfiguration) checks.configurations.push({ where, what: 'configuration', issues: () => issuesOf(configurationSchema, content) });
    else if (!isPlainObject(content)) checks.unchecked.push(`${where}: neither a configuration, a section of one nor a plugin entry`);
    for (const [key, value] of Object.entries(block)) {
      const schema = SECTION_SCHEMAS[key];
      if (key === 'plugins' && Array.isArray(value)) value.forEach((entry, index) => checks.entries.push(pluginCheck(where, entry, index)));
      else if (key === 'strategy') {
        const check = strategyCheck(where, value, externalStrategies);
        if (check) checks.strategyBlocks.push(check);
      }
      // The configuration schema checks the other sections of a whole configuration
      else if (isConfiguration) continue;
      else if (schema) checks.sections.push({ where, what: key, issues: () => issuesOf(schema, value) });
      else checks.unchecked.push(`${where}: ${key} is not a section of a configuration`);
    }
  }
  return checks;
};

/** Reads each yaml block as the loader reads a file, with YAML's core schema */
const documentsOf = (blocks: Block[]) => {
  const documents: Document[] = [];
  const unreadable: string[] = [];
  for (const { where, source, lang, isFragment, text } of blocks) {
    if (lang !== 'yaml' || isFragment) continue;
    try {
      documents.push({ where, source, content: load(text, { schema: CORE_SCHEMA }) });
    } catch (error) {
      unreadable.push(`${where}: not YAML (${error instanceof Error ? error.message.split('\n')[0] : 'unreadable'})`);
    }
  }
  return { documents, unreadable };
};

const configurationFile = (file: string): Document => {
  const source = `config/${file}`;
  const content = load(read(source), { schema: CORE_SCHEMA, filename: source });
  const changes = new Set<string>();
  const options = isPlainObject(content) ? (content as Record<string, unknown>) : {};
  for (const section of [options.exchange, ...entriesOf(content)].filter(isPlainObject) as Record<string, unknown>[]) {
    for (const [key, standIn] of Object.entries(CREDENTIAL_STAND_INS)) {
      if (section[key] !== null) continue;
      section[key] = standIn;
      changes.add('credentials filled in');
    }
  }
  if (options[DISCLAIMER] === false) {
    options[DISCLAIMER] = true;
    changes.add('disclaimer set to true');
  }
  return { where: `${source}${changes.size ? ` (${[...changes].join(', ')})` : ''}`, source, content, isFile: true };
};

const guideDocuments = documentsOf(guideBlocks);
const configurationFiles = readdirSync(path.join(ROOT, 'config'))
  .filter(file => /\.ya?ml$/.test(file))
  .sort()
  .map(configurationFile);
const yamlDocuments = [...guideDocuments.documents, ...configurationFiles];
const externalStrategies = new Set(
  yamlDocuments
    .flatMap(({ content }) => entriesOf(content))
    .filter(entry => nameOf(entry) === 'TradingAdvisor' && (entry as { strategyPath?: unknown }).strategyPath !== undefined)
    .map(entry => (entry as { strategyName?: unknown }).strategyName),
);
const yaml = yamlChecksOf(yamlDocuments, externalStrategies);

const issuesOfSample = (markdown: string) => {
  const { documents, unreadable } = documentsOf(blocksOf('sample.md', markdown));
  const { configurations, entries, strategyBlocks, sections, unchecked } = yamlChecksOf(documents, new Set());
  return [...unreadable, ...unchecked, ...[...configurations, ...entries, ...strategyBlocks, ...sections].flatMap(check => check.issues())];
};

// Rows of [where, what, check]: vitest prints a %s whole, where it quotes a $value and cuts it at 40 characters
const rowsOf = (checks: Check[]) => checks.map(check => [check.where, check.what, check] as const);

describe('yaml blocks of the guides and configurations of config/', () => {
  it.each(rowsOf(yaml.configurations))('%s is a valid %s', (_where, _what, { issues }) => {
    expect(issues()).toEqual([]);
  });

  it.each(rowsOf(yaml.entries))('%s %s is a valid plugin entry', (_where, _what, { issues }) => {
    expect(issues()).toEqual([]);
  });

  it.each(rowsOf(yaml.strategyBlocks))('%s strategy block is valid for %s', (_where, _what, { issues }) => {
    expect(issues()).toEqual([]);
  });

  it.each(rowsOf(yaml.sections))('%s %s section is valid', (_where, _what, { issues }) => {
    expect(issues()).toEqual([]);
  });

  it('should read every yaml block as a configuration, a section of one or plugin entries', () => {
    expect([...guideDocuments.unreadable, ...yaml.unchecked]).toEqual([]);
  });

  it('should find yaml blocks in the guides', () => {
    expect(guideDocuments.documents.length).toBeGreaterThan(0);
  });

  it.each`
    sample                     | markdown
    ${'a whole configuration'} | ${'```yaml\nwatch: {}\nexchange:\n  name: binance\n  sandBox: true\nplugins: []\n```'}
    ${'a plugin entry'}        | ${'```yaml\nplugins:\n  - name: TradingAdvisor\n    strategyName: RSI\n    maxConsecutiveError: 5\n```'}
    ${'a strategy block'}      | ${'```yaml\nstrategy:\n  name: RSI\n  period: 14\n  treshold: 70\n```'}
    ${'an exchange section'}   | ${'```yaml\nexchange:\n  name: paper-binance\n  simulationBalances: []\n```'}
  `('should refuse $sample holding a misspelt key', ({ markdown }) => {
    expect(issuesOfSample(markdown)).toContainEqual(expect.stringContaining('Unrecognized key'));
  });

  it('should check a file of config/ as a whole configuration, whatever it holds', () => {
    const file = { where: 'config/sample.yml', source: 'config/sample.yml', content: { exchange: { name: 'binance' } }, isFile: true };
    expect(yamlChecksOf([file], new Set()).configurations.flatMap(check => check.issues())).toContainEqual(expect.stringMatching(/^plugins: /));
  });

  // A configuration of config/ that leaves a credential for the reader to fill in says where to write it: in a copy git ignores
  // (config/*.local.*), not in the tracked file, which a later `git commit -a` committed with the keys
  it.each(
    configurationFiles
      .filter(({ where }) => where.includes('credentials filled in'))
      .map(({ source }) => [source, source.replace(/\.ya?ml$/, '.local.yml')]),
  )('%s should send the reader to %s, a copy git ignores, for its credentials', (source, copy) => {
    expect(read(source)).toContain(copy);
  });

  it.each([
    ['read', 'yaml', 1],
    ['leave out', 'yaml fragment', 0],
  ])('should %s a block opened with ```%s', (_outcome, info, documentCount) => {
    expect(documentsOf(blocksOf('sample.md', fenced(info, 'watch:', '  warmup:', '    candleCount: 40'))).documents).toHaveLength(documentCount);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 TYPESCRIPT                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the snippets use without declaring it: what the Complete Example of custom-strategies.md imports, the head of a strategy file,
 * with AddIndicatorFn, and MyParams, the parameters of the strategy the Lifecycle Methods build. A script, so its declarations are
 * global: a snippet's own import or declaration of a name wins.
 */
const CONTEXT = `type OrderSide = import('@models/order.types').OrderSide;
type TradingPair = import('@models/utility.types').TradingPair;
type UUID = import('node:crypto').UUID;
type AddIndicatorFn = import('@strategies/strategy.types').AddIndicatorFn;
type IndicatorResults<T = unknown> = import('@strategies/strategy.types').IndicatorResults<T>;
type InitParams<T> = import('@strategies/strategy.types').InitParams<T>;
type OnCandleEventParams<T> = import('@strategies/strategy.types').OnCandleEventParams<T>;
type OnOrderCompletedEventParams<T> = import('@strategies/strategy.types').OnOrderCompletedEventParams<T>;
type OnOrderCanceledEventParams<T> = import('@strategies/strategy.types').OnOrderCanceledEventParams<T>;
type OnOrderErroredEventParams<T> = import('@strategies/strategy.types').OnOrderErroredEventParams<T>;
type Strategy<T> = import('@strategies/strategy.types').Strategy<T>;
type Tools<T> = import('@strategies/strategy.types').Tools<T>;
type TrailingStopState = import('@strategies/trailingStopManager.types').TrailingStopState;
type MyParams = { short: number; long: number };
declare const z: typeof import('zod').z;
declare namespace z {
  type infer<T> = import('zod').z.infer<T>;
}
`;

/** A snippet of statements runs in a function that hands it what a hook or init has in scope, as the guide shows it there */
const STATEMENTS_FRAME = {
  before: `export function snippet(
  addIndicator: AddIndicatorFn,
  pair: TradingPair,
  candle: OnCandleEventParams<MyParams>['candle'],
  tools: Tools<MyParams>,
  createOrder: Tools<MyParams>['createOrder'],
  indicators: IndicatorResults[],
  close: number,
): void {
`,
  after: '\n}\n',
};

type Kind = 'module' | 'statements' | 'class members' | 'unparsable';
/** The file written for a block: its text starts on line `firstLine` of `content`, wrapped as its kind needs */
type Snippet = Block & { kind: Kind; file: string; content?: string; firstLine: number; problems: string[] };

const indent = (text: string) =>
  text
    .split('\n')
    .map(line => (line ? `  ${line}` : line))
    .join('\n');

const sourceFileOf = (text: string) => ts.createSourceFile('snippet.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const syntaxErrorsOf = (text: string) =>
  (ts.transpileModule(text, { reportDiagnostics: true }).diagnostics ?? []).map(diagnostic => ({
    line: diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : 1,
    message: `TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
  }));

const isExported = (statement: ts.Statement) =>
  ts.canHaveModifiers(statement) && !!ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword);

const isModule = ({ statements }: ts.SourceFile) =>
  statements.some(
    statement =>
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement) || isExported(statement),
  );

const kindOf = (text: string): Kind => {
  if (!syntaxErrorsOf(text).length) return isModule(sourceFileOf(text)) ? 'module' : 'statements';
  return syntaxErrorsOf(`class Members {\n${text}\n}`).length ? 'unparsable' : 'class members';
};

const memberNamesOf = (members: ts.NodeArray<ts.ClassElement>) => members.map(member => member.name?.getText());

/**
 * Class members (a method or two of the strategy the guide builds) are checked in the class of the closest block of statements before
 * them that declares one, in place of its members of the same names.
 */
const classFrameOf = (skeleton: string, members: string) => {
  const declaration = sourceFileOf(skeleton).statements.findLast(ts.isClassDeclaration);
  if (!declaration) return null;
  const replaced = memberNamesOf((sourceFileOf(`class Members {\n${members}\n}`).statements[0] as ts.ClassDeclaration).members);
  let before = skeleton.slice(0, declaration.members.end);
  for (const member of [...declaration.members].reverse()) {
    if (replaced.includes(member.name?.getText())) before = before.slice(0, member.getFullStart()) + before.slice(member.getEnd());
  }
  return { before: `${before}\n`, after: `\n${skeleton.slice(declaration.members.end)}` };
};

const relativeImportsOf = ({ statements }: ts.SourceFile) =>
  statements.flatMap(statement =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text.startsWith('./')
      ? [statement.moduleSpecifier.text]
      : [],
  );

const exportedClassesOf = ({ statements }: ts.SourceFile) =>
  statements.filter(ts.isClassDeclaration).flatMap(declaration => (isExported(declaration) && declaration.name ? [declaration.name.text] : []));

/**
 * Writes each typescript block as `<guide>-<line>.ts`, but for a module another block imports by a relative path
 * (`export * from './myStrategy.strategy'`): that one is written under that path, the first block of the guide to export the class the
 * path is named after (MyStrategy), as a strategy's file is named after its class.
 */
const snippetsOf = (blocks: Block[]): Snippet[] => {
  const snippets: Snippet[] = [];
  let skeleton: Block | undefined;
  for (const block of blocks) {
    if (block.lang !== 'typescript' || block.isFragment) continue;
    if (skeleton?.source !== block.source) skeleton = undefined;
    const kind = kindOf(block.text);
    const snippet: Snippet = { ...block, kind, file: `${path.basename(block.source, '.md')}-${block.line}.ts`, firstLine: 1, problems: [] };
    const frame = kind === 'class members' && skeleton ? classFrameOf(skeleton.text, block.text) : null;
    if (kind === 'module') snippet.content = `${block.text}\n`;
    else if (kind === 'statements' || frame) {
      const before = `${STATEMENTS_FRAME.before}${indent(frame?.before ?? '')}`;
      snippet.content = `${before}${indent(block.text)}${indent(frame?.after ?? '')}${STATEMENTS_FRAME.after}`;
      snippet.firstLine = before.split('\n').length;
    } else if (kind === 'class members') snippet.problems.push(`${block.where}: no block of statements before it declares the class of these members`);
    else snippet.problems.push(...syntaxErrorsOf(block.text).map(({ line, message }) => `${block.source}:${block.line + line}: ${message}`));
    if (kind === 'statements' && sourceFileOf(block.text).statements.some(ts.isClassDeclaration)) skeleton = block;
    snippets.push(snippet);
  }
  for (const importer of snippets.filter(({ kind }) => kind === 'module')) {
    for (const specifier of relativeImportsOf(sourceFileOf(importer.text))) {
      const file = `${path.posix.normalize(specifier).replace(/\.[jt]s$/, '')}.ts`;
      if (snippets.some(snippet => snippet.file === file)) continue;
      const className = path.posix.basename(specifier).split('.')[0].toLowerCase();
      const exporter = snippets.find(
        ({ source, kind, text }) =>
          source === importer.source && kind === 'module' && exportedClassesOf(sourceFileOf(text)).some(name => name.toLowerCase() === className),
      );
      if (exporter) exporter.file = file;
    }
  }
  return snippets;
};

/** One sample of each kind, with a type error at a known line: the check must find it there, and nowhere else */
const TYPESCRIPT_SAMPLES = [
  {
    sample: 'a snippet of statements',
    source: 'statements.sample.md',
    markdown: fenced('typescript', 'addIndicator("SMA", pair, { periode: 20 });'),
    error: /^statements\.sample\.md:2: TS2561 Object literal may only specify known properties, but 'periode' does not exist/,
  },
  {
    // The members override the class's own end: kept beside them, it would be a duplicate implementation
    sample: 'class members',
    source: 'members.sample.md',
    markdown: [
      fenced('typescript', 'class Tracker implements Strategy<MyParams> {', '  private isLong = false;', '  end(): void {}', '}'),
      fenced('typescript', 'end(): void {', '  this.isLong = "yes";', '}'),
    ].join('\n\n'),
    error: /^members\.sample\.md:10: TS2322 Type 'string' is not assignable to type 'boolean'\.$/,
  },
  {
    sample: 'a module',
    source: 'module.sample.md',
    markdown: fenced('typescript', 'import { Strategy } from "@strategies/strategy";', '', 'export class Empty implements Strategy<object> {}'),
    error: /^module\.sample\.md:2: TS2307 Cannot find module '@strategies\/strategy' or its corresponding type declarations\.$/,
  },
].map(sample => ({ ...sample, written: snippetsOf(blocksOf(sample.source, sample.markdown)) }));

const snippets = snippetsOf(guideBlocks);
const DIAGNOSTIC = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/;
const TSC = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const TSC_TIMEOUT = 120_000;
const typeErrors = new Map<string, string[]>();
const otherErrors: string[] = [];
let directory = '';
let keepDirectory = false;

/** Places a type error of a written file in the guide, when it falls in the text of the block, else in that file */
const locate = (snippet: Snippet | undefined, file: string, line: number) => {
  const offset = line - (snippet?.firstLine ?? 0);
  const isInBlock = snippet && offset >= 0 && offset < snippet.text.split('\n').length;
  return isInBlock ? `${snippet.source}:${snippet.line + 1 + offset}` : `${path.join(directory, file)}:${line}`;
};

const errorsOf = ({ file, problems }: Snippet) => [...problems, ...(typeErrors.get(file) ?? [])];

describe('typescript blocks of the guides', () => {
  beforeAll(() => {
    const cache = path.join(ROOT, 'node_modules/.cache/docs-ts');
    mkdirSync(cache, { recursive: true });
    // Its real path: tsc names a file from the project's path, relative to its working directory, which is real. Under a symbolic
    // link (node_modules linked into a copy of the repository), the names no longer matched the files written.
    directory = realpathSync(mkdtempSync(path.join(cache, 'run-')));
    const written = [...snippets, ...TYPESCRIPT_SAMPLES.flatMap(sample => sample.written)].filter(({ content }) => content !== undefined);
    for (const { file, content } of written) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), content ?? '');
    }
    writeFileSync(path.join(directory, 'context.ts'), CONTEXT);
    // The program sees the global declarations of src, as the type check of the codebase does (IndicatorRegistry, EpochTimeStamp): a
    // module only imported by the snippets would leave out the declaration files and the indicators' registry entries
    const isGlobal = (file: string) => file.endsWith('.d.ts') || (!/\.(test|bench)\.ts$/.test(file) && read(`src/${file}`).includes('declare global'));
    const globals = readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .filter(file => file.endsWith('.ts') && isGlobal(file))
      .map(file => path.join(ROOT, 'src', file));
    const tsconfig = {
      extends: path.join(ROOT, 'tsconfig.json'),
      compilerOptions: { noEmit: true, incremental: false },
      include: ['**/*.ts', ...globals],
    };
    writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
    let output = '';
    try {
      execFileSync(process.execPath, [TSC, '--project', directory, '--pretty', 'false'], { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      const { stdout } = error as { stdout?: string };
      if (stdout === undefined) throw error;
      output = stdout;
    }
    let errors = otherErrors;
    for (const line of output.split('\n').filter(Boolean)) {
      const diagnostic = DIAGNOSTIC.exec(line);
      if (!diagnostic) {
        // The rest of a message, on the lines that follow it
        if (/^\s/.test(line) && errors.length) errors[errors.length - 1] += ` ${line.trim()}`;
        else otherErrors.push(line);
        continue;
      }
      const [, file, at, code, message] = diagnostic;
      const snippet = written.find(candidate => candidate.file === file);
      if (snippet && !typeErrors.has(file)) typeErrors.set(file, []);
      errors = (snippet && typeErrors.get(file)) || otherErrors;
      errors.push(`${locate(snippet, file, Number(at))}: ${code} ${message}`);
    }
  }, TSC_TIMEOUT);

  afterAll(() => {
    if (directory && !keepDirectory) rmSync(directory, { recursive: true, force: true });
  });

  it.each(snippets.map(snippet => [snippet.where, snippet.kind, snippet] as const))('%s type-checks as %s', (_where, _kind, snippet) => {
    const errors = errorsOf(snippet);
    if (errors.length) keepDirectory = true;
    expect(errors, `the files checked are kept in ${directory}`).toEqual([]);
  });

  it('should compile the declarations the snippets rely on without error', () => {
    if (otherErrors.length) keepDirectory = true;
    expect(otherErrors, `the files checked are kept in ${directory}`).toEqual([]);
  });

  it('should find typescript blocks in the guides', () => {
    expect(snippets.length).toBeGreaterThan(0);
  });

  it.each(TYPESCRIPT_SAMPLES)('should report a type error in $sample at its line of the guide', ({ written, error }) => {
    expect(written.flatMap(errorsOf)).toEqual([expect.stringMatching(error)]);
  });

  it.each([
    ['check', 'typescript', 1],
    ['leave out', 'typescript fragment', 0],
  ])('should %s a block opened with ```%s', (_outcome, info, snippetCount) => {
    expect(snippetsOf(blocksOf('sample.md', fenced(info, 'addIndicator("SMA", pair, { period: 20 });')))).toHaveLength(snippetCount);
  });
});
