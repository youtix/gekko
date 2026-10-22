import { loadConfigurationFile } from '@gekko/core/configuration/configuration.helper';
import { warning } from '@gekko/core/logger/logger';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { cloneDeep, get, range } from 'lodash-es';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOverrides } from '../cli/cli.helper';
import type { Overrides, Template, Variant } from '../fox.types';
import { generateVariants, loadTemplate, validateVariants, warnOfUnreportedVariants } from './variants.helper';

vi.mock('@gekko/core/configuration/configuration.helper', () => ({ loadConfigurationFile: vi.fn() }));
vi.mock('@gekko/core/logger/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));

// The registries, with the real schemas, and the modes and events of the real plugins: the plugins' own modules load the exchanges and
// bun:sqlite, which vitest, on Node, cannot
vi.mock('@gekko/plugins/index', async () => {
  const { analyzerSchema } = await import('@gekko/schemas/plugins/analyzer.schema');
  const { candleWriterSchema } = await import('@gekko/schemas/plugins/candleWriter.schema');
  const { performanceReporterSchema } = await import('@gekko/schemas/plugins/performanceReporter.schema');
  const { traderSchema } = await import('@gekko/schemas/plugins/trader.schema');
  const { tradingAdvisorSchema } = await import('@gekko/schemas/plugins/tradingAdvisor.schema');
  const BOTH = ['realtime', 'backtest'];
  const pluginOf = (schema?: unknown, modes = BOTH, eventsEmitted: string[] = []) => ({
    getStaticConfiguration: () => ({ schema, modes, eventsEmitted }),
  });
  return {
    CandleWriter: pluginOf(candleWriterSchema, ['realtime', 'importer']),
    PerformanceReporter: pluginOf(performanceReporterSchema, ['backtest']),
    PortfolioAnalyzer: pluginOf(analyzerSchema, BOTH, ['performanceReport', 'equitySnapshot']),
    RoundTripAnalyzer: pluginOf(analyzerSchema, BOTH, ['performanceReport', 'roundtripCompleted']),
    SchemaLess: pluginOf(),
    Trader: pluginOf(traderSchema, BOTH, ['portfolioChange', 'orderCanceled', 'orderCompleted', 'orderErrored', 'orderInitiated']),
    TradingAdvisor: pluginOf(tradingAdvisorSchema, BOTH, ['strategyInfo', 'strategyCreateOrder', 'strategyCancelOrder']),
  };
});
vi.mock('@gekko/strategies/index', async () => {
  const { demaStrategySchema } = await import('@gekko/schemas/strategies/dema.schema');
  return { DEMA: { schema: demaStrategySchema }, Unchecked: {} };
});

const MARKET_DATA = {
  price: { min: 0.01, max: 1000000 },
  amount: { min: 0.00001, max: 9000 },
  cost: { min: 5, max: 9000000 },
  precision: { price: 8, amount: 8 },
  fee: { maker: 0.0004, taker: 0.0007 },
};

/** A backtest of BTC/USDT on DEMA, as a template holds it */
const TEMPLATE: Template = {
  showLogo: false,
  watch: {
    assets: ['BTC'],
    currency: 'USDT',
    timeframe: '1h',
    mode: 'backtest',
    warmup: { candleCount: 10 },
    daterange: { start: '2024-01-01T00:00:00.000Z', end: '2024-01-03T23:59:00.000Z' },
  },
  exchange: {
    name: 'dummy-cex',
    marketData: [{ symbol: 'BTC/USDT', marketData: MARKET_DATA }],
    simulationBalance: [
      { assetName: 'BTC', balance: 0 },
      { assetName: 'USDT', balance: 1000 },
    ],
  },
  storage: { type: 'sqlite', database: './db/binance-BTC_USDT.sql' },
  strategy: { name: 'DEMA', period: 12, thresholds: { up: 100, down: -150 } },
  plugins: [
    { name: 'TradingAdvisor', strategyName: 'DEMA' },
    { name: 'Trader' },
    { name: 'PortfolioAnalyzer' },
    { name: 'PerformanceReporter', fileName: 'DEMA_performance_reports.csv' },
  ],
};

/** The template with `changes` merged over it, as a variant of it */
const variantOf = (changes: (configuration: Template) => void, variant = 1, label = ''): Variant => {
  const configuration = cloneDeep(TEMPLATE);
  changes(configuration);
  return { variant, label, configuration };
};

const pluginsOf = (configuration: Template) => configuration.plugins as Record<string, unknown>[];
const strategyOf = (configuration: Template) => configuration.strategy as Record<string, unknown>;

describe('loadTemplate', () => {
  describe('when the file holds a configuration', () => {
    beforeEach(() => {
      vi.mocked(loadConfigurationFile).mockReturnValue(TEMPLATE);
    });

    it('should give it', () => {
      expect(loadTemplate('dema.yml')).toBe(TEMPLATE);
    });

    it('should read the file as a configuration file', () => {
      loadTemplate('dema.yml');

      expect(loadConfigurationFile).toHaveBeenCalledExactlyOnceWith('dema.yml');
    });
  });

  it('should pass on what the loader refuses', () => {
    const refusal = new GekkoError('configuration', 'Empty configuration file: dema.yml');
    vi.mocked(loadConfigurationFile).mockImplementation(() => {
      throw refusal;
    });

    expect(() => loadTemplate('dema.yml')).toThrow(refusal);
  });

  describe('when the file cannot be read', () => {
    const failure = new Error("ENOENT: no such file or directory, open 'dema.yml'");

    beforeEach(() => {
      vi.mocked(loadConfigurationFile).mockImplementation(() => {
        throw failure;
      });
    });

    it('should refuse it, naming the file', () => {
      expect(() => loadTemplate('dema.yml')).toThrow(
        "[FOX] Cannot read the template dema.yml: ENOENT: no such file or directory, open 'dema.yml'",
      );
    });

    it('should keep the failure as the cause', () => {
      expect(() => loadTemplate('dema.yml')).toThrow(expect.objectContaining({ cause: failure }));
    });
  });

  it.each`
    description   | content           | message
    ${'a list'}   | ${['BTC', 'ETH']} | ${"[FOX] Invalid template dema.yml: a configuration is a mapping of its sections (watch, exchange, plugins…), got [ 'BTC', 'ETH' ]"}
    ${'a text'}   | ${'watch'}        | ${'[FOX] Invalid template dema.yml: a configuration is a mapping of its sections (watch, exchange, plugins…), got "watch"'}
    ${'a number'} | ${42}             | ${'[FOX] Invalid template dema.yml: a configuration is a mapping of its sections (watch, exchange, plugins…), got 42'}
  `('should refuse a file holding $description', ({ content, message }) => {
    vi.mocked(loadConfigurationFile).mockReturnValue(content);

    expect(() => loadTemplate('dema.yml')).toThrow(message);
  });
});

describe('generateVariants', () => {
  const template: Template = {
    strategy: { name: 'DEMA', period: 12, thresholds: { up: 100, down: -150 } },
    plugins: [{ name: 'A' }, { name: 'B' }],
  };

  it.each`
    description                                  | overrides                                       | expected
    ${'the template alone without overrides'}    | ${{}}                                           | ${[{ variant: 1, label: '', configuration: template }]}
    ${'one variant of a single value'}           | ${{ strategy: { period: 14 } }}                 | ${[{ variant: 1, label: '', configuration: { ...template, strategy: { name: 'DEMA', period: 14, thresholds: { up: 100, down: -150 } } } }]}
    ${'a variant of each value of a list'}       | ${{ strategy: { period: [10, 20] } }}           | ${[{ variant: 1, label: '--strategy.period 10', configuration: { ...template, strategy: { name: 'DEMA', period: 10, thresholds: { up: 100, down: -150 } } } }, { variant: 2, label: '--strategy.period 20', configuration: { ...template, strategy: { name: 'DEMA', period: 20, thresholds: { up: 100, down: -150 } } } }]}
    ${'a key inside a block, its siblings kept'} | ${{ strategy: { thresholds: { up: [1, 2] } } }} | ${[{ variant: 1, label: '--strategy.thresholds.up 1', configuration: { ...template, strategy: { name: 'DEMA', period: 12, thresholds: { up: 1, down: -150 } } } }, { variant: 2, label: '--strategy.thresholds.up 2', configuration: { ...template, strategy: { name: 'DEMA', period: 12, thresholds: { up: 2, down: -150 } } } }]}
    ${'an item of a list, the others kept'}      | ${{ plugins: { 1: { fileName: 'b.csv' } } }}    | ${[{ variant: 1, label: '', configuration: { ...template, plugins: [{ name: 'A' }, { name: 'B', fileName: 'b.csv' }] } }]}
    ${'a key the template lacks'}                | ${{ watch: { batchSize: 1440 } }}               | ${[{ variant: 1, label: '', configuration: { ...template, watch: { batchSize: 1440 } } }]}
  `('should make $description', ({ overrides, expected }) => {
    expect(generateVariants(template, overrides)).toStrictEqual(expected);
  });

  it('should make every combination, the values of the last option changing first', () => {
    const overrides: Overrides = { strategy: { period: [10, 15], thresholds: { up: [50, 100] } }, showLogo: false };

    expect(generateVariants(template, overrides).map(({ variant, label }) => `${variant}: ${label}`)).toStrictEqual([
      '1: --strategy.period 10 --strategy.thresholds.up 50',
      '2: --strategy.period 10 --strategy.thresholds.up 100',
      '3: --strategy.period 15 --strategy.thresholds.up 50',
      '4: --strategy.period 15 --strategy.thresholds.up 100',
    ]);
  });

  // As the command line writes them: String wrote a number below 1e-6 or from 1e21 in exponent form (1e-7), which reads back as a text
  it.each`
    description                   | values                    | labels
    ${'numbers below 1e-6'}       | ${[0.0000001, 0.0000002]} | ${['--strategy.thresholds.up 0.0000001', '--strategy.thresholds.up 0.0000002']}
    ${'numbers from 1e21'}        | ${[1e21, 2]}              | ${['--strategy.thresholds.up 1000000000000000000000', '--strategy.thresholds.up 2']}
    ${'negative decimal numbers'} | ${[-0.5, -150]}           | ${['--strategy.thresholds.up -0.5', '--strategy.thresholds.up -150']}
    ${'booleans'}                 | ${[true, false]}          | ${['--strategy.thresholds.up true', '--strategy.thresholds.up false']}
    ${'texts'}                    | ${['close', 'ohlc4']}     | ${['--strategy.thresholds.up close', '--strategy.thresholds.up ohlc4']}
  `('should label the variants of $description as the command line writes them', ({ values, labels }) => {
    expect(generateVariants(template, { strategy: { thresholds: { up: values } } }).map(({ label }) => label)).toStrictEqual(labels);
  });

  // fox.md's re-run of a variant: each of its keys given the value of its label
  it('should write labels that the command line reads back as the values of the variants', () => {
    const variants = generateVariants(template, { strategy: { thresholds: { up: [0.0000001, 1e21] } } });

    expect(variants.map(({ label }) => parseOverrides(label.split(' ')))).toStrictEqual([
      { strategy: { thresholds: { up: 0.0000001 } } },
      { strategy: { thresholds: { up: 1e21 } } },
    ]);
  });

  it('should set the single values in every variant', () => {
    const overrides: Overrides = { strategy: { period: [10, 15] }, showLogo: false };

    expect(generateVariants(template, overrides).map(({ configuration }) => configuration.showLogo)).toStrictEqual([false, false]);
  });

  it('should leave the template as it was', () => {
    const original = cloneDeep(template);
    generateVariants(template, { strategy: { period: [10, 15], thresholds: { up: 1 } } });

    expect(template).toStrictEqual(original);
  });

  it('should give each variant a copy of its own', () => {
    const [first, second] = generateVariants(template, { strategy: { period: [10, 15] } });

    expect(first.configuration.plugins).not.toBe(second.configuration.plugins);
  });

  // The reporter writes the label after the id of its row, which only names the strategy block: a sweep of a fee needs it
  describe('when the template has a PerformanceReporter', () => {
    const REPORTER = { name: 'PerformanceReporter', fileName: 'a.csv' };
    const reported: Template = { ...template, plugins: [{ name: 'A' }, REPORTER] };

    /** The plugins of each variant of `source` made of `overrides` */
    const pluginsOfVariants = (overrides: Overrides, source = reported) =>
      generateVariants(source, overrides).map(({ configuration }) => configuration.plugins);

    it.each`
      description                                                        | overrides                                                                          | expected
      ${'each variant its label'}                                        | ${{ strategy: { period: [10, 20] } }}                                              | ${[[{ name: 'A' }, { ...REPORTER, label: '--strategy.period 10' }], [{ name: 'A' }, { ...REPORTER, label: '--strategy.period 20' }]]}
      ${'no label to a single variant'}                                  | ${{ strategy: { period: 14 } }}                                                    | ${[[{ name: 'A' }, REPORTER]]}
      ${'each variant its label after the one an override gives'}        | ${{ strategy: { period: [10, 20] }, plugins: { 1: { label: 'mine' } } }}           | ${[[{ name: 'A' }, { ...REPORTER, label: 'mine --strategy.period 10' }], [{ name: 'A' }, { ...REPORTER, label: 'mine --strategy.period 20' }]]}
      ${'a single variant the label an override gives, alone, a re-run'} | ${{ strategy: { period: 14 }, plugins: { 1: { label: '--strategy.period 14' } } }} | ${[[{ name: 'A' }, { ...REPORTER, label: '--strategy.period 14' }]]}
    `('should give $description', ({ overrides, expected }) => {
      expect(pluginsOfVariants(overrides)).toStrictEqual(expected);
    });

    it.each`
      description                                                           | plugins                                           | expected
      ${"the label of its own the template gives it, before the variant's"} | ${[{ ...REPORTER, label: 'baseline' }]}           | ${[{ ...REPORTER, label: 'baseline --strategy.period 10' }]}
      ${'every PerformanceReporter its label'}                              | ${[REPORTER, { ...REPORTER, fileName: 'b.csv' }]} | ${[{ ...REPORTER, label: '--strategy.period 10' }, { ...REPORTER, fileName: 'b.csv', label: '--strategy.period 10' }]}
      ${'a label that is not a text as it is, for the schema to refuse'}    | ${[{ ...REPORTER, label: 12 }]}                   | ${[{ ...REPORTER, label: 12 }]}
      ${'an empty label as it is, for the schema to refuse'}                | ${[{ ...REPORTER, label: '' }]}                   | ${[{ ...REPORTER, label: '' }]}
      ${'an entry that is not an object as it is'}                          | ${['PerformanceReporter']}                        | ${['PerformanceReporter']}
      ${'plugins that are not a list as they are'}                          | ${'PerformanceReporter'}                          | ${'PerformanceReporter'}
    `('should keep $description', ({ plugins, expected }) => {
      expect(pluginsOfVariants({ strategy: { period: [10, 20] } }, { ...template, plugins })[0]).toStrictEqual(expected);
    });
  });

  // lodash's merge kept any other key on the array, as a property no configuration reads: every variant ran the template's value under
  // the label of the value asked for
  describe('when an option enters a list of the template', () => {
    /** A template whose first plugin holds a list of its own */
    const NESTED: Template = { plugins: [{ name: 'Mine', steps: [{ candle: 0 }] }] };
    const EMPTY: Template = { plugins: [] };

    it.each`
      description                                  | template    | overrides                                                                                           | message
      ${'by the symbol of its item'}               | ${TEMPLATE} | ${{ exchange: { marketData: { 'BTC/USDT': { marketData: { fee: { maker: [0.001, 0.002] } } } } } }} | ${'[FOX] --exchange.marketData.BTC/USDT.marketData.fee.maker: exchange.marketData is a list, name its item by its index (0)'}
      ${'by the asset of its item'}                | ${TEMPLATE} | ${{ exchange: { simulationBalance: { USDT: { balance: 5000 } } } }}                                 | ${'[FOX] --exchange.simulationBalance.USDT.balance: exchange.simulationBalance is a list, name its item by its index (0 or 1)'}
      ${'by the value of its item'}                | ${TEMPLATE} | ${{ watch: { assets: { BTC: 'SOL' } } }}                                                            | ${'[FOX] --watch.assets.BTC: watch.assets is a list, name its item by its index (0)'}
      ${'by the name of its plugin'}               | ${TEMPLATE} | ${{ plugins: { Trader: { portfolioUpdates: { threshold: [1, 5] } } } }}                             | ${'[FOX] --plugins.Trader.portfolioUpdates.threshold: plugins is a list, name its item by its index (0 to 3)'}
      ${'by a zero-padded index'}                  | ${TEMPLATE} | ${{ plugins: { '03': { fileName: ['a.csv', 'b.csv'] } } }}                                          | ${'[FOX] --plugins.03.fileName: plugins is a list, name its item by its index (0 to 3)'}
      ${'by a negative index'}                     | ${TEMPLATE} | ${{ plugins: { '-1': { label: ['x', 'y'] } } }}                                                     | ${'[FOX] --plugins.-1.label: plugins is a list, name its item by its index (0 to 3)'}
      ${'by an index written with an exponent'}    | ${TEMPLATE} | ${{ plugins: { '1e0': { label: 'x' } } }}                                                           | ${'[FOX] --plugins.1e0.label: plugins is a list, name its item by its index (0 to 3)'}
      ${'at its length, which would cut it short'} | ${TEMPLATE} | ${{ plugins: { length: 3 } }}                                                                       | ${'[FOX] --plugins.length: plugins is a list, name its item by its index (0 to 3)'}
      ${'inside an item of another list'}          | ${NESTED}   | ${{ plugins: { 0: { steps: { first: { candle: 2 } } } } }}                                          | ${'[FOX] --plugins.0.steps.first.candle: plugins.0.steps is a list, name its item by its index (0)'}
      ${'that is empty'}                           | ${EMPTY}    | ${{ plugins: { Trader: { name: 'Trader' } } }}                                                      | ${'[FOX] --plugins.Trader.name: plugins is a list, name its item by its index (it is empty: 0 adds an item)'}
      ${'among more values than the cap, first'}   | ${TEMPLATE} | ${{ plugins: { Trader: { portfolioUpdates: { threshold: range(10_001) } } } }}                      | ${'[FOX] --plugins.Trader.portfolioUpdates.threshold: plugins is a list, name its item by its index (0 to 3)'}
    `('should refuse a key of the list $description, before any variant is made', ({ template, overrides, message }) => {
      expect(() => generateVariants(template, overrides)).toThrow(message);
    });

    it.each`
      description                                     | template    | overrides                                                                         | path                                                           | value
      ${'an item by its index'}                       | ${TEMPLATE} | ${{ plugins: { 3: { fileName: 'b.csv' } } }}                                      | ${['plugins', 3, 'fileName']}                                  | ${'b.csv'}
      ${'an item of a list by its index, then a key'} | ${TEMPLATE} | ${{ exchange: { marketData: { 0: { marketData: { fee: { maker: 0.001 } } } } } }} | ${['exchange', 'marketData', 0, 'marketData', 'fee', 'maker']} | ${0.001}
      ${'an item of a list inside an item'}           | ${NESTED}   | ${{ plugins: { 0: { steps: { 0: { candle: 2 } } } } }}                            | ${['plugins', 0, 'steps', 0, 'candle']}                        | ${2}
      ${'a new item, at the length of the list'}      | ${TEMPLATE} | ${{ plugins: { 4: { name: 'RoundTripAnalyzer' } } }}                              | ${['plugins', 4, 'name']}                                      | ${'RoundTripAnalyzer'}
      ${'the first item of an empty list'}            | ${EMPTY}    | ${{ plugins: { 0: { name: 'Trader' } } }}                                         | ${['plugins', 0, 'name']}                                      | ${'Trader'}
      ${'a key below a value that is not an object'}  | ${TEMPLATE} | ${{ showLogo: { now: true } }}                                                    | ${['showLogo', 'now']}                                         | ${true}
      ${'a key below a key the template lacks'}       | ${TEMPLATE} | ${{ watch: { tickrate: { length: 3 } } }}                                         | ${['watch', 'tickrate', 'length']}                             | ${3}
    `('should set $description', ({ template, overrides, path, value }) => {
      expect(get(generateVariants(template, overrides)[0].configuration, path)).toBe(value);
    });
  });

  describe('when the overrides make more variants than the cap', () => {
    it.each`
      description                                | overrides                                                         | message
      ${'one more than the cap'}                 | ${{ a: range(10_001) }}                                           | ${'[FOX] The overrides make 10001 variants (10001 values of --a), more than the 10000 Fox makes at most: give them fewer values'}
      ${'a hundred million, before any is made'} | ${{ a: range(10_000), showLogo: false, b: { c: range(10_000) } }} | ${'[FOX] The overrides make 100000000 variants (10000 values of --a × 10000 values of --b.c), more than the 10000 Fox makes at most: give them fewer values'}
    `('should refuse $description, naming the values of each option', ({ overrides, message }) => {
      expect(() => generateVariants(template, overrides)).toThrow(message);
    });

    it('should make as many variants as the cap', () => {
      expect(generateVariants(template, { strategy: { period: range(100), thresholds: { up: range(100) } } })).toHaveLength(10_000);
    });
  });
});

describe('validateVariants', () => {
  it.each`
    description                               | changes
    ${'the template'}                         | ${() => {}}
    ${'a strategy without schema'}            | ${(configuration: Template) => Object.assign(configuration, { strategy: { name: 'Unchecked', anything: 1 }, plugins: [{ name: 'TradingAdvisor', strategyName: 'Unchecked' }] })}
    ${'a strategy loaded from a file'}        | ${(configuration: Template) => Object.assign(configuration, { strategy: { name: 'Mine', period: 'any' }, plugins: [{ name: 'TradingAdvisor', strategyName: 'Mine', strategyPath: './mine.ts' }] })}
    ${'no TradingAdvisor, no strategy check'} | ${(configuration: Template) => Object.assign(configuration, { strategy: undefined, plugins: [{ name: 'PortfolioAnalyzer' }] })}
    ${'a plugin without schema'}              | ${(configuration: Template) => pluginsOf(configuration).push({ name: 'SchemaLess', anything: 1 })}
  `('should accept $description', ({ changes }) => {
    expect(() => validateVariants([variantOf(changes)])).not.toThrow();
  });

  it.each`
    description                               | changes                                                                                               | message
    ${'an invalid configuration'}             | ${(configuration: Template) => Object.assign(configuration.watch as object, { timeframe: '7m' })}     | ${'[FOX] Variant 1 is invalid:\n✖ Invalid option: expected one of'}
    ${'another mode than backtest'}           | ${(configuration: Template) => Object.assign(configuration, IMPORTER)}                                | ${'[FOX] Variant 1 is invalid:\n✖ Fox backtests its variants: watch.mode must be backtest, got "importer"\n  → at watch.mode'}
    ${'a strategy block its schema refuses'}  | ${(configuration: Template) => Object.assign(strategyOf(configuration), { period: 1 })}               | ${'[FOX] Variant 1 is invalid:\n✖ period must be at least 2 (the DEMA and the SMA of a single candle are both its close, so they never differ)\n  → at strategy.period'}
    ${'a strategy block missing a parameter'} | ${(configuration: Template) => delete strategyOf(configuration).thresholds}                           | ${'[FOX] Variant 1 is invalid:\n✖ Invalid input: expected object, received undefined\n  → at strategy.thresholds'}
    ${'a strategy no registry holds'}         | ${(configuration: Template) => Object.assign(configuration, UNKNOWN_STRATEGY)}                        | ${'[FOX] Variant 1 is invalid:\n✖ No strategy is named "DEMAX": the strategies are DEMA and Unchecked\n  → at plugins[0].strategyName'}
    ${'a strategyName that is not a text'}    | ${(configuration: Template) => Object.assign(pluginsOf(configuration)[0], { strategyName: 12 })}      | ${'[FOX] Variant 1 is invalid:\n✖ Invalid input: expected string, received number\n  → at plugins[0].strategyName'}
    ${'a plugin no registry holds'}           | ${(configuration: Template) => Object.assign(pluginsOf(configuration)[3], { name: 'Reporter' })}      | ${'[FOX] Variant 1 is invalid:\n✖ No plugin is named "Reporter": the plugins are CandleWriter, PerformanceReporter, PortfolioAnalyzer, RoundTripAnalyzer, SchemaLess, Trader and TradingAdvisor\n  → at plugins[3].name'}
    ${'a plugin no registry holds, first'}    | ${(configuration: Template) => pluginsOf(configuration).unshift({ name: 'Reporter' })}                | ${'[FOX] Variant 1 is invalid:\n✖ No plugin is named "Reporter": the plugins are CandleWriter, PerformanceReporter, PortfolioAnalyzer, RoundTripAnalyzer, SchemaLess, Trader and TradingAdvisor\n  → at plugins[0].name'}
    ${'a plugin named as an inherited key'}   | ${(configuration: Template) => Object.assign(pluginsOf(configuration)[3], { name: 'constructor' })}   | ${'[FOX] Variant 1 is invalid:\n✖ No plugin is named "constructor"'}
    ${'a plugin named in another case'}       | ${(configuration: Template) => Object.assign(pluginsOf(configuration)[1], { name: 'trader' })}        | ${'[FOX] Variant 1 is invalid:\n✖ No plugin is named "trader" (did you mean "Trader"?): the plugins are CandleWriter, PerformanceReporter, PortfolioAnalyzer, RoundTripAnalyzer, SchemaLess, Trader and TradingAdvisor\n  → at plugins[1].name'}
    ${'a benchmark that is not watched'}      | ${(configuration: Template) => Object.assign(pluginsOf(configuration)[2], { benchmarkAsset: 'SOL' })} | ${'[FOX] Variant 1 is invalid:\n✖ benchmarkAsset must be one of the watched assets (BTC), got "SOL"\n  → at plugins[2].benchmarkAsset'}
    ${'a benchmark not written as an asset'}  | ${(configuration: Template) => Object.assign(pluginsOf(configuration)[2], { benchmarkAsset: 'btc' })} | ${"[FOX] Variant 1 is invalid:\n✖ Asset 'btc' must be written in upper-case letters and digits, as in BTC or 1INCH\n  → at plugins[2].benchmarkAsset"}
    ${'a plugin entry its schema refuses'}    | ${(configuration: Template) => Object.assign(pluginsOf(configuration)[3], { fileName: '' })}          | ${'[FOX] Variant 1 is invalid:\n✖ File name must not be empty\n  → at plugins[3].fileName'}
    ${'a plugin that does not backtest'}      | ${(configuration: Template) => pluginsOf(configuration).push({ name: 'CandleWriter' })}               | ${'[FOX] Variant 1 is invalid:\n✖ Plugin CandleWriter does not support backtest mode, only realtime and importer\n  → at plugins[4].name'}
    ${'two plugins emitting one event'}       | ${(configuration: Template) => pluginsOf(configuration).push({ name: 'RoundTripAnalyzer' })}          | ${'[FOX] Variant 1 is invalid:\n✖ Plugins PortfolioAnalyzer (plugins[2]) and RoundTripAnalyzer are broadcasting the same event: performanceReport. This behavior is unsupported.\n  → at plugins[4].name'}
    ${'a plugin configured twice'}            | ${(configuration: Template) => pluginsOf(configuration).push({ name: 'PortfolioAnalyzer' })}          | ${'[FOX] Variant 1 is invalid:\n✖ Plugins PortfolioAnalyzer (plugins[2]) and PortfolioAnalyzer are broadcasting the same events: performanceReport and equitySnapshot. This behavior is unsupported.\n  → at plugins[4].name'}
  `('should refuse $description', ({ changes, message }) => {
    expect(() => validateVariants([variantOf(changes)])).toThrow(message);
  });

  it('should refuse the first invalid variant, naming its values', () => {
    const variants = [
      variantOf(() => {}, 1, '--strategy.period 2'),
      variantOf(configuration => Object.assign(strategyOf(configuration), { period: 1 }), 2, '--strategy.period 1'),
      variantOf(configuration => Object.assign(strategyOf(configuration), { period: 0 }), 3, '--strategy.period 0'),
    ];

    expect(() => validateVariants(variants)).toThrow('[FOX] Variant 2 (--strategy.period 1) is invalid:\n');
  });

  it('should list every issue of the variant', () => {
    const variant = variantOf(configuration => {
      Object.assign(strategyOf(configuration), { period: 1 });
      Object.assign(pluginsOf(configuration)[3], { fileName: '' });
    });

    expect(() => validateVariants([variant])).toThrow(
      [
        '[FOX] Variant 1 is invalid:',
        '✖ period must be at least 2 (the DEMA and the SMA of a single candle are both its close, so they never differ)',
        '  → at strategy.period',
        '✖ File name must not be empty',
        '  → at plugins[3].fileName',
      ].join('\n'),
    );
  });
});

describe('warnOfUnreportedVariants', () => {
  /** A variant whose plugins are those named */
  const variantWith = (variant: number, ...names: string[]): Variant => ({
    variant,
    label: '',
    configuration: { plugins: names.map(name => ({ name })) },
  });
  const reported = (variant: number) => variantWith(variant, 'PortfolioAnalyzer', 'PerformanceReporter');
  const unreported = (variant: number) => variantWith(variant, 'PortfolioAnalyzer');

  it('should not warn when every variant has a PerformanceReporter', () => {
    warnOfUnreportedVariants([reported(1), reported(2)]);

    expect(warning).not.toHaveBeenCalled();
  });

  it.each`
    description                          | variants                                       | message
    ${'the template of every variant'}   | ${[unreported(1), unreported(2)]}              | ${'The template has no PerformanceReporter: no CSV row will record the figures of its variants'}
    ${'the template of its one variant'} | ${[unreported(1)]}                             | ${'The template has no PerformanceReporter: no CSV row will record the figures of its variant'}
    ${'the one variant without one'}     | ${[reported(1), unreported(2), reported(3)]}   | ${'Variant 2 has no PerformanceReporter: no CSV row will record its figures'}
    ${'the variants without one'}        | ${[unreported(1), reported(2), unreported(3)]} | ${'Variants 1 and 3 have no PerformanceReporter: no CSV row will record their figures'}
  `('should warn once of $description', ({ variants, message }) => {
    warnOfUnreportedVariants(variants);

    expect(warning).toHaveBeenCalledExactlyOnceWith('fox', message);
  });
});

/** The sections of an import of BTC/USDT: a configuration the schema accepts, in another mode than backtest */
const IMPORTER = {
  watch: {
    assets: ['BTC'],
    currency: 'USDT',
    mode: 'importer',
    daterange: { start: '2024-01-01T00:00:00.000Z', end: '2024-01-02T00:00:00.000Z' },
  },
  exchange: { name: 'binance' },
  strategy: undefined,
  plugins: [{ name: 'CandleWriter' }],
};

/** A TradingAdvisor and a strategy block naming a strategy that does not exist */
const UNKNOWN_STRATEGY = {
  strategy: { name: 'DEMAX', period: 12 },
  plugins: [{ name: 'TradingAdvisor', strategyName: 'DEMAX' }, { name: 'Trader' }],
};
