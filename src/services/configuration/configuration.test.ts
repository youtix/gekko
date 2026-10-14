import { GekkoError } from '@errors/gekko.error';
import { readFileSync } from 'fs';
import { dump } from 'js-yaml';
import JSON5 from 'json5';
import { omit } from 'lodash-es';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

describe('Configuration Service', () => {
  let Configuration: any;

  const mockConfig = {
    showLogo: true,
    watch: {
      assets: ['BTC'],
      currency: 'USDT',
      timeframe: '1m',
      mode: 'realtime',
      warmup: { candleCount: 100, tickrate: 1000 },
      tickrate: 1000,
    },
    plugins: [{ name: 'PerformanceAnalyzer' }],
    strategy: { name: 'CCI' },
    exchange: {
      name: 'paper-binance',
      simulationBalance: [
        { assetName: 'BTC', balance: 1 },
        { assetName: 'USDT', balance: 10000 },
      ],
    },
  };
  // What getWatch() returns for mockConfig: the schema derives pairs, which a config file cannot set.
  const parsedWatch = { ...mockConfig.watch, pairs: [{ symbol: 'BTC/USDT' }] };
  // Exchanges accepted by the importer and backtest modes, for the tests that switch mockConfig to them.
  const importerExchange = { name: 'binance' };
  const backtestExchange = {
    ...mockConfig.exchange,
    name: 'dummy-cex',
    marketData: [
      {
        symbol: 'BTC/USDT',
        marketData: {
          price: { min: 0.01, max: 1000000 },
          amount: { min: 0.00001, max: 9000 },
          cost: { min: 5, max: 9000000 },
          precision: { price: 8, amount: 8 },
          fee: { maker: 0.0004, taker: 0.0007 },
        },
      },
    ],
  };

  const setConfigFile = (path: string | undefined, content: unknown) => {
    if (path) process.env.GEKKO_CONFIG_FILE_PATH = path;
    else delete process.env.GEKKO_CONFIG_FILE_PATH;

    vi.mocked(readFileSync).mockReturnValue(typeof content === 'string' ? content : JSON.stringify(content));
  };

  beforeAll(async () => {
    process.env.GEKKO_CONFIG_FILE_PATH = 'setup.json';
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockConfig));
    const mod = await import('./configuration');
    Configuration = mod.Configuration;
  });

  beforeEach(() => {
    process.env.GEKKO_CONFIG_FILE_PATH = 'config.json';
  });

  describe('Initialization', () => {
    it('should throw error if GEKKO_CONFIG_FILE_PATH is missing', () => {
      setConfigFile(undefined, mockConfig);
      expect(() => new Configuration()).toThrow('Missing GEKKO_CONFIG_FILE_PATH environment variable');
    });

    it.each([
      ['config.json', JSON.stringify(mockConfig)],
      ['config.json5', JSON.stringify(mockConfig)],
    ])('should load valid JSON/JSON5 config from %s', (path, content) => {
      setConfigFile(path, content);
      const config = new Configuration();
      expect(config.getWatch()).toEqual(parsedWatch);
    });

    it.each([
      [
        'config.yaml',
        'showLogo: true\nwatch:\n  assets:\n    - BTC\n  currency: USDT\n  timeframe: 1m\n  mode: realtime\n  warmup:\n    candleCount: 100\nplugins:\n  - name: PerformanceAnalyzer\nstrategy:\n  name: CCI\nexchange:\n  name: paper-binance\n  simulationBalance:\n    - assetName: BTC\n      balance: 1\n    - assetName: USDT\n      balance: 10000',
      ],
      [
        'config.yml',
        'showLogo: true\nwatch:\n  assets:\n    - BTC\n  currency: USDT\n  timeframe: 1m\n  mode: realtime\n  warmup:\n    candleCount: 100\nplugins:\n  - name: PerformanceAnalyzer\nstrategy:\n  name: CCI\nexchange:\n  name: paper-binance\n  simulationBalance:\n    - assetName: BTC\n      balance: 1\n    - assetName: USDT\n      balance: 10000',
      ],
    ])('should load valid YAML config from %s', (path, content) => {
      setConfigFile(path, content);
      const config = new Configuration();
      expect(config.getWatch()).toEqual(parsedWatch);
    });

    // Each content parses with its own format's parser only, so a row also proves which parser was picked.
    it.each`
      path              | content
      ${'config.JSON'}  | ${JSON5.stringify(mockConfig)}
      ${'config.Json5'} | ${JSON5.stringify(mockConfig)}
      ${'config.YML'}   | ${dump(mockConfig)}
      ${'config.Yaml'}  | ${dump(mockConfig)}
    `('should load $path whatever the case of its extension', ({ path, content }) => {
      setConfigFile(path, content);
      const config = new Configuration();
      expect(config.getWatch()).toEqual(parsedWatch);
    });

    describe.each`
      problem                        | content                                                                              | issues
      ${'a misspelt key'}            | ${{ ...mockConfig, watch: { ...omit(mockConfig.watch, 'assets'), asset: ['BTC'] } }} | ${'✖ Unrecognized key: "asset"\n  → at watch\n✖ Invalid input: expected array, received undefined\n  → at watch.assets'}
      ${'a value of the wrong type'} | ${{ ...mockConfig, showLogo: 'yes' }}                                                | ${'✖ Invalid input: expected boolean, received string\n  → at showLogo'}
    `('when the configuration file has $problem', ({ content, issues }) => {
      beforeEach(() => {
        setConfigFile('./config/gekko.json', content);
      });

      it('should throw a GekkoError', () => {
        expect(() => new Configuration()).toThrow(GekkoError);
      });

      it('should name the file, then give each problem on its own line with the path of the option at fault', () => {
        expect(() => new Configuration()).toThrow(
          expect.objectContaining({ message: `[CONFIGURATION] Invalid configuration file ./config/gekko.json:\n${issues}` }),
        );
      });
    });

    it('should throw error for empty content', () => {
      vi.mocked(readFileSync).mockReturnValue('');
      expect(() => new Configuration()).toThrow();
    });

    it.each`
      path
      ${'config.toml'}
      ${'config'}
      ${'myjson'}
    `('should reject $path because its extension is not supported', ({ path }) => {
      setConfigFile(path, mockConfig);
      expect(() => new Configuration()).toThrow(
        `[CONFIGURATION] Unsupported file extension: ${path} (expected .json, .json5, .yml or .yaml)`,
      );
    });

    it.each`
      description            | content
      ${'empty'}             | ${''}
      ${'only a comment'}    | ${'# nothing configured yet\n'}
      ${'an empty document'} | ${'---\n'}
    `('should throw an empty file error when the YAML file is $description', ({ content }) => {
      setConfigFile('config.yml', content);
      expect(() => new Configuration()).toThrow('[CONFIGURATION] Empty configuration file: config.yml');
    });

    // js-yaml's default schema loaded an unquoted timestamp as a Date, rolled over when the day did not exist (2023-02-29 as March 1st),
    // while the schema refused a quoted day or offset: the loader keeps YAML timestamps as text, which the schema checks either way
    describe('with a YAML daterange', () => {
      /** An importer configuration file, its daterange.start written as `start` is */
      const importerYaml = (start: string) =>
        [
          'watch:',
          '  assets: [BTC]',
          '  currency: USDT',
          '  mode: importer',
          '  daterange:',
          `    start: ${start}`,
          '    end: 2023-01-02T00:00:00Z',
          'exchange:',
          '  name: binance',
          'plugins: []',
        ].join('\n');
      const quoted = (text: string) => `'${text}'`;

      it.each`
        form                                          | start
        ${'an unquoted date and time'}                | ${'2023-01-01T00:00:00Z'}
        ${'a quoted date and time'}                   | ${quoted('2023-01-01T00:00:00Z')}
        ${'an unquoted day'}                          | ${'2023-01-01'}
        ${'a quoted day'}                             | ${quoted('2023-01-01')}
        ${'an unquoted date and time with an offset'} | ${'2023-01-01T02:00:00+02:00'}
        ${'a quoted date and time with an offset'}    | ${quoted('2023-01-01T02:00:00+02:00')}
      `('should read $form, $start, as 2023-01-01T00:00:00.000Z', ({ start }) => {
        setConfigFile('config.yml', importerYaml(start));
        expect(new Configuration().getWatch().daterange).toEqual({ start: Date.UTC(2023, 0, 1), end: Date.UTC(2023, 0, 2) });
      });

      it.each`
        start
        ${'2023-02-29'}
        ${'2023-04-31'}
        ${'2023-13-01'}
        ${'2023-02-28T24:00:00Z'}
        ${'2023-01-01T00:00:00+25:00'}
      `('should refuse $start, a date that does not exist, unquoted, naming it and its path', ({ start }) => {
        setConfigFile('config.yml', importerYaml(start));
        expect(() => new Configuration()).toThrow(
          expect.objectContaining({
            message: `[CONFIGURATION] Invalid configuration file config.yml:\n✖ watch.daterange.start '${start}' must be a date that exists, in ISO 8601: a day (2024-01-01, from its midnight UTC), or a day and a time with Z or an offset (2024-01-01T00:00:00Z, 2024-01-01T02:00:00+02:00)\n  → at watch.daterange.start`,
          }),
        );
      });
    });
  });

  describe('Methods', () => {
    let configInstance: any; // Type as any because Configuration is loaded dynamically

    beforeEach(() => {
      setConfigFile('config.json', mockConfig);
      configInstance = new Configuration();
    });

    describe('showLogo', () => {
      it('should return showLogo value', () => {
        expect(configInstance.showLogo()).toBe(true);
      });

      it('should throw if configuration is missing (simulated)', () => {
        (configInstance as any).configuration = undefined;
        expect(() => configInstance.showLogo()).toThrow('Empty configuration file');
      });
    });

    describe('getPlugins', () => {
      it('should return plugins', () => {
        expect(configInstance.getPlugins()).toEqual(mockConfig.plugins);
      });

      it('should throw if configuration is missing', () => {
        (configInstance as any).configuration = undefined;
        expect(() => configInstance.getPlugins()).toThrow('Empty configuration file');
      });
    });

    describe('getStrategy', () => {
      it('should return strategy', () => {
        expect(configInstance.getStrategy()).toEqual(mockConfig.strategy);
      });

      it('should throw if configuration is missing', () => {
        (configInstance as any).configuration = undefined;
        expect(() => configInstance.getStrategy()).toThrow('Empty configuration file');
      });
    });

    describe('getExchange', () => {
      it('should return exchange', () => {
        const exchange = configInstance.getExchange();
        expect(exchange.name).toBe('paper-binance');
        expect(exchange.simulationBalance).toBeInstanceOf(Map);
        expect(exchange.simulationBalance.get('BTC')).toBe(1);
        expect(exchange.simulationBalance.get('USDT')).toBe(10000);
      });

      it('should throw if configuration is missing', () => {
        (configInstance as any).configuration = undefined;
        expect(() => configInstance.getExchange()).toThrow('Empty configuration file');
      });
    });

    describe('getWatch', () => {
      it('should return watch config', () => {
        expect(configInstance.getWatch()).toEqual(parsedWatch);
      });

      it('should throw if configuration is missing', () => {
        (configInstance as any).configuration = undefined;
        expect(() => configInstance.getWatch()).toThrow('Empty configuration file');
      });

      it('should validate daterange in importer mode', () => {
        const importerConfig = {
          ...mockConfig,
          exchange: importerExchange,
          watch: {
            ...mockConfig.watch,
            mode: 'importer',
            daterange: { start: '2023-01-01T00:00:00Z', end: '2023-01-02T00:00:00Z' },
          },
        };
        setConfigFile('config.json', importerConfig);
        const config = new Configuration();

        expect(config.getWatch()).toEqual({
          ...importerConfig.watch,
          pairs: parsedWatch.pairs,
          daterange: {
            start: new Date(importerConfig.watch.daterange.start).getTime(),
            end: new Date(importerConfig.watch.daterange.end).getTime(),
          },
        });
      });

      // Both bounds are included, each as the minute holding it: equal bounds are the range of a one-minute re-import, which getWatch
      // refused when it compared milliseconds, quoting them
      it('should return equal bounds, a one-minute range, in importer mode', () => {
        const daterange = { start: '2023-01-01T10:23:00Z', end: '2023-01-01T10:23:00Z' };
        setConfigFile('config.json', {
          ...mockConfig,
          exchange: importerExchange,
          watch: { ...mockConfig.watch, mode: 'importer', daterange },
        });
        expect(new Configuration().getWatch().daterange).toEqual({
          start: Date.UTC(2023, 0, 1, 10, 23),
          end: Date.UTC(2023, 0, 1, 10, 23),
        });
      });

      it.each`
        mode          | exchange            | storage
        ${'importer'} | ${importerExchange} | ${undefined}
        ${'backtest'} | ${backtestExchange} | ${{ type: 'sqlite', database: 'gekko.db' }}
      `(
        'should refuse at load a range that ends before it starts in $mode mode, naming both bounds in ISO 8601',
        ({ mode, exchange, storage }) => {
          const daterange = { start: '2023-01-02T00:00:00Z', end: '2023-01-01T00:00:00Z' };
          setConfigFile('config.json', { ...mockConfig, exchange, storage, watch: { ...mockConfig.watch, mode, daterange } });
          expect(() => new Configuration()).toThrow(
            expect.objectContaining({
              message:
                '[CONFIGURATION] Invalid configuration file config.json:\n✖ watch.daterange must end in the minute of its start or later: it starts at 2023-01-02T00:00:00.000Z and ends at 2023-01-01T00:00:00.000Z\n  → at watch.daterange',
            }),
          );
        },
      );
    });

    describe('getStorage', () => {
      it('should return undefined if not configured and not needed', () => {
        expect(configInstance.getStorage()).toBeUndefined();
      });

      it('should throw if configuration is missing', () => {
        (configInstance as any).configuration = undefined;
        expect(() => configInstance.getStorage()).toThrow('Empty configuration file');
      });

      it('should return storage when in backtest mode', () => {
        const backtestConfig = {
          ...mockConfig,
          exchange: backtestExchange,
          watch: {
            ...mockConfig.watch,
            mode: 'backtest',
            daterange: { start: '2023-01-01T00:00:00Z', end: '2023-01-02T00:00:00Z' },
          },
          storage: { type: 'sqlite', database: 'gekko.db' },
        };
        setConfigFile('config.json', backtestConfig);
        const config = new Configuration();
        expect(config.getStorage()).toEqual(backtestConfig.storage);
      });

      it('should return storage when CandleWriter plugin is present', () => {
        const writerConfig = {
          ...mockConfig,
          plugins: [{ name: 'CandleWriter' }],
          storage: { type: 'sqlite', database: 'gekko.db' },
        };
        setConfigFile('config.json', writerConfig);
        const config = new Configuration();
        expect(config.getStorage()).toEqual(writerConfig.storage);
      });
    });
  });
});
