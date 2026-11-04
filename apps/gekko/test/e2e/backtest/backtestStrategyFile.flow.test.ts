import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawDaterange, type RawConfiguration } from '../helpers/configuration.helper';
import { clearLogs } from '../mocks/winston.mock';
import { flatCandles, minute, mockBacktestModules, rawMarket, runBacktest } from './backtestRun.helper';

mockBacktestModules();

/** The module that imports a strategy file, by its real path: Bun names it when the file is not there */
const STRATEGY_MANAGER = realpathSync(
  fileURLToPath(new URL('../../../../../packages/plugins/src/tradingAdvisor/strategyManager.ts', import.meta.url)),
);

/** A strategy file that imports the module ./levels */
const IMPORTING_LEVELS = "import { LEVELS } from './levels';\n\nexport class MyStrategy {\n  levels = LEVELS;\n}\n";

/** A backtest of BTC from 00:00 to 00:08, its TradingAdvisor loading MyStrategy from the file at `strategyPath` */
const backtestOf = (strategyPath: string): RawConfiguration => ({
  watch: {
    mode: 'backtest',
    assets: ['BTC'],
    currency: 'USDT',
    timeframe: '1m',
    daterange: rawDaterange({ start: minute(0), end: minute(9) - 1 }),
  },
  exchange: {
    name: 'dummy-cex',
    simulationBalance: [
      { assetName: 'BTC', balance: 0 },
      { assetName: 'USDT', balance: 1000 },
    ],
    marketData: [rawMarket('BTC/USDT')],
  },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [{ name: 'TradingAdvisor', strategyName: 'MyStrategy', strategyPath }, { name: 'Trader' }],
  strategy: { name: 'MyStrategy' },
});

/**
 * The files of the strategy's directory, by name, the strategy file myStrategy.strategy.ts among them unless it is the one missing; what
 * the run's failure says of them after `[TRADING ADVISOR] Cannot import the strategy file <file>: `; and the lines that follow it in the
 * report main() logs of that failure (describeFailure), `Caused by: ` then the same text unless the row gives them: each from the path
 * of the strategy file and of its directory
 */
type Row = {
  problem: string;
  files: Record<string, string>;
  said: (file: string, directory: string) => string;
  causes?: (file: string, directory: string) => string[];
};

/**
 * The import of a strategy file that cannot be found or parsed rejects with Bun's ResolveMessage or BuildMessage, which describeError
 * writes with their class, a BuildMessage with its position, the one place its file is named. Under Bun 1.4.4 both are Errors: their
 * message alone came out, and a BuildMessage has no stack, so that the Caused by line of the report main() logs named no line of the
 * file. The unit suites fake them: only a run of the real loader shows a Bun upgrade that changes them again. What follows the class is
 * Bun's own wording, which custom-strategies.md quotes: a change of it shows here too.
 */
describe('E2E: Backtest of a strategy file that cannot be imported', () => {
  let directory: string;

  beforeEach(() => {
    clearLogs();
    // Its real path, by which Bun names its files
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'gekko-strategy-file-e2e-')));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it.each<Row>([
    {
      problem: 'a syntax error, at its line and column',
      files: { 'myStrategy.strategy.ts': 'export class MyStrategy {\n  init() {\n    const x = (1 + 2;\n  }\n}\n' },
      said: file => `BuildMessage: Expected ")" but found ";" at ${file}:3:21`,
    },
    {
      problem: 'two syntax errors, each at its line and column',
      files: { 'myStrategy.strategy.ts': 'export class MyStrategy {\n  init() {\n    const x = (1 + 2;\n    const y = [1, 2;\n  }\n}\n' },
      said: file =>
        `2 errors building "${file}": BuildMessage: Expected ")" but found ";" at ${file}:3:21; ` +
        `BuildMessage: Expected "]" but found ";" at ${file}:4:20`,
      causes: file => [
        `Caused by: AggregateError: 2 errors building "${file}"`,
        `Error 1 of 2: BuildMessage: Expected ")" but found ";" at ${file}:3:21`,
        `Error 2 of 2: BuildMessage: Expected "]" but found ";" at ${file}:4:20`,
      ],
    },
    {
      problem: 'a syntax error of a module it imports, in that module',
      files: { 'myStrategy.strategy.ts': IMPORTING_LEVELS, 'levels.ts': 'export const LEVELS = [1, 2;\n' },
      said: (_file, dir) => `BuildMessage: Expected "]" but found ";" at ${dir}/levels.ts:1:28`,
    },
    {
      problem: 'a module it imports that is not there',
      files: { 'myStrategy.strategy.ts': IMPORTING_LEVELS },
      said: file => `ResolveMessage: Cannot find module './levels' imported from ${file}`,
    },
    {
      problem: 'a strategy file that is not there',
      files: {},
      said: file => `ResolveMessage: Cannot find module '${file}' imported from ${STRATEGY_MANAGER}`,
    },
  ])('stops the run at start-up on $problem, naming it as Bun does', async ({ files, said, causes }) => {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
    const file = join(directory, 'myStrategy.strategy.ts');

    const { failure } = await runBacktest(backtestOf(file), { 'BTC/USDT': flatCandles(10000) });

    // Loaded with the logger once the mocks of the flow are set, as the pipeline is
    const { describeFailure } = await import('@gekko/core/logger/failure.helper');
    expect(describeFailure(failure).split('\n')).toStrictEqual([
      `[TRADING ADVISOR] Cannot import the strategy file ${file}: ${said(file, directory)}`,
      ...(causes?.(file, directory) ?? [`Caused by: ${said(file, directory)}`]),
    ]);
  });
});
