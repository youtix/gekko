import { loadConfigurationFile } from '@gekko/core/configuration/configuration.helper';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { cloneDeep } from 'lodash-es';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Overrides, Template, Variant } from '../fox.types';
import { generateVariants, loadTemplate, validateVariants } from './variants.helper';

vi.mock('@gekko/core/configuration/configuration.helper', () => ({ loadConfigurationFile: vi.fn() }));

// The registries, with the real schemas: the plugins' own modules load the exchanges and bun:sqlite, which vitest, on Node, cannot
vi.mock('@gekko/plugins/index', async () => {
  const { analyzerSchema } = await import('@gekko/schemas/plugins/analyzer.schema');
  const { candleWriterSchema } = await import('@gekko/schemas/plugins/candleWriter.schema');
  const { performanceReporterSchema } = await import('@gekko/schemas/plugins/performanceReporter.schema');
  const { traderSchema } = await import('@gekko/schemas/plugins/trader.schema');
  const { tradingAdvisorSchema } = await import('@gekko/schemas/plugins/tradingAdvisor.schema');
  const pluginOf = (schema?: unknown) => ({ getStaticConfiguration: () => ({ schema }) });
  return {
    CandleWriter: pluginOf(candleWriterSchema),
    PerformanceReporter: pluginOf(performanceReporterSchema),
    PortfolioAnalyzer: pluginOf(analyzerSchema),
    SchemaLess: pluginOf(),
    Trader: pluginOf(traderSchema),
    TradingAdvisor: pluginOf(tradingAdvisorSchema),
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
    description                               | changes                                                                                             | message
    ${'an invalid configuration'}             | ${(configuration: Template) => Object.assign(configuration.watch as object, { timeframe: '7m' })}   | ${'[FOX] Variant 1 is invalid:\n✖ Invalid option: expected one of'}
    ${'another mode than backtest'}           | ${(configuration: Template) => Object.assign(configuration, IMPORTER)}                              | ${'[FOX] Variant 1 is invalid:\n✖ Fox backtests its variants: watch.mode must be backtest, got "importer"\n  → at watch.mode'}
    ${'a strategy block its schema refuses'}  | ${(configuration: Template) => Object.assign(strategyOf(configuration), { period: 1 })}             | ${'[FOX] Variant 1 is invalid:\n✖ period must be at least 2 (the DEMA and the SMA of a single candle are both its close, so they never differ)\n  → at strategy.period'}
    ${'a strategy block missing a parameter'} | ${(configuration: Template) => delete strategyOf(configuration).thresholds}                         | ${'[FOX] Variant 1 is invalid:\n✖ Invalid input: expected object, received undefined\n  → at strategy.thresholds'}
    ${'a strategy no registry holds'}         | ${(configuration: Template) => Object.assign(configuration, UNKNOWN_STRATEGY)}                      | ${'[FOX] Variant 1 is invalid:\n✖ No strategy is named "DEMAX": the strategies are DEMA and Unchecked\n  → at plugins[0].strategyName'}
    ${'a strategyName that is not a text'}    | ${(configuration: Template) => Object.assign(pluginsOf(configuration)[0], { strategyName: 12 })}    | ${'[FOX] Variant 1 is invalid:\n✖ Invalid input: expected string, received number\n  → at plugins[0].strategyName'}
    ${'a plugin no registry holds'}           | ${(configuration: Template) => Object.assign(pluginsOf(configuration)[3], { name: 'Reporter' })}    | ${'[FOX] Variant 1 is invalid:\n✖ No plugin is named "Reporter": the plugins are CandleWriter, PerformanceReporter, PortfolioAnalyzer, SchemaLess, Trader and TradingAdvisor\n  → at plugins[3].name'}
    ${'a plugin named as an inherited key'}   | ${(configuration: Template) => Object.assign(pluginsOf(configuration)[3], { name: 'constructor' })} | ${'[FOX] Variant 1 is invalid:\n✖ No plugin is named "constructor"'}
    ${'a plugin entry its schema refuses'}    | ${(configuration: Template) => Object.assign(pluginsOf(configuration)[3], { fileName: '' })}        | ${'[FOX] Variant 1 is invalid:\n✖ File name must not be empty\n  → at plugins[3].fileName'}
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
