import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { readFileSync } from 'fs';
import { dump } from 'js-yaml';
import JSON5 from 'json5';
import { omit } from 'lodash-es';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfigurationFile, parseConfiguration, readConfigurationFile, readConfigurationFromEnvironment } from './configuration.helper';

vi.mock('fs', () => ({ readFileSync: vi.fn() }));

/** A paper trading configuration as a file holds it, before the schema checks it */
const raw = {
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
/** The watch section of raw as the schema outputs it: the schema derives the pairs, which a file cannot set */
const parsedWatch = { ...raw.watch, pairs: [{ symbol: 'BTC/USDT' }] };
/** The exchanges the importer and the backtest modes accept, for the configurations switched to those modes */
const importerExchange = { name: 'binance' };
const backtestExchange = {
  ...raw.exchange,
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

/** The content the configuration file holds, as the parser reads it: an object is written as JSON */
const setFileContent = (content: unknown) =>
  vi.mocked(readFileSync).mockReturnValue(typeof content === 'string' ? content : JSON.stringify(content));

describe('loadConfigurationFile', () => {
  // Each content parses with the parser of its own format only (JSON5's unquoted keys are no YAML mapping), so that a row also proves
  // which parser was picked
  it.each`
    path              | content
    ${'config.json'}  | ${JSON5.stringify(raw)}
    ${'config.json5'} | ${JSON5.stringify(raw)}
    ${'config.yml'}   | ${dump(raw)}
    ${'config.yaml'}  | ${dump(raw)}
    ${'config.JSON'}  | ${JSON5.stringify(raw)}
    ${'config.Json5'} | ${JSON5.stringify(raw)}
    ${'config.YML'}   | ${dump(raw)}
    ${'config.Yaml'}  | ${dump(raw)}
  `('reads $path with the parser of its extension, whatever its case', ({ path, content }) => {
    setFileContent(content);
    expect(loadConfigurationFile(path)).toEqual(raw);
  });

  it('reads the file at the path it is given, as UTF-8', () => {
    setFileContent(raw);
    loadConfigurationFile('./config/gekko.json');
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith('./config/gekko.json', 'utf8');
  });

  // Not checked: the schema checks the content (see parseConfiguration)
  it('returns the content as the parser reads it, before the schema checks it', () => {
    setFileContent({ watch: 'nonsense' });
    expect(loadConfigurationFile('config.json')).toEqual({ watch: 'nonsense' });
  });

  it.each`
    path
    ${'config.toml'}
    ${'config'}
    ${'myjson'}
  `('refuses $path, whose extension no parser reads', ({ path }) => {
    setFileContent(raw);
    expect(() => loadConfigurationFile(path)).toThrow(
      new GekkoError('configuration', `Unsupported file extension: ${path} (expected .json, .json5, .yml or .yaml)`),
    );
  });

  it.each`
    file                                  | path             | content                         | message
    ${'an empty YAML file'}               | ${'config.yml'}  | ${''}                           | ${'Empty configuration file: config.yml'}
    ${'a YAML file of a comment alone'}   | ${'config.yml'}  | ${'# nothing configured yet\n'} | ${'Empty configuration file: config.yml'}
    ${'a YAML file of an empty document'} | ${'config.yml'}  | ${'---\n'}                      | ${'Empty configuration file: config.yml'}
    ${'an empty JSON file'}               | ${'config.json'} | ${''}                           | ${'Invalid JSON in configuration file config.json: invalid end of input at line 1, column 1'}
  `('refuses $file: $message', ({ path, content, message }) => {
    setFileContent(content);
    expect(() => loadConfigurationFile(path)).toThrow(new GekkoError('configuration', message));
  });

  // The parser's own error was reported whole, at error level and without the file name: js-yaml's message quotes the lines around
  // the fault, three before and two after, so a typo near the Telegram token or the API keys printed them, whole or cut short
  describe('given a file that does not parse', () => {
    // Fake credentials, each holding FAKE, on the lines around the faults
    const TOKEN = '123456789:FAKETELEGRAMTOKEN0000000000000000';
    const API_KEY = `FAKEAPIKEY${'0'.repeat(54)}`;
    const SECRET = `FAKESECRET${'0'.repeat(54)}`;
    const watchLine = 'watch: { assets: [BTC], currency: USDT, timeframe: 5m, mode: realtime }';
    const exchangeLines = ['exchange:', '  name: binance', `  apiKey: ${API_KEY}`, `  secret: ${SECRET}`];
    /** A live trading configuration, its credentials on lines 4 and 5, followed by the given lines */
    const liveYaml = (...lines: string[]) => [watchLine, ...exchangeLines, ...lines].join('\n');
    /** A live trading configuration whose Telegram token, on line 8, is followed by the given line */
    const telegramYaml = (line: string) => liveYaml('plugins:', '  - name: EventSubscriber', `    token: ${TOKEN}`, line);
    const timestampYaml = [
      'watch:',
      '  assets: [BTC]',
      '  currency: USDT',
      '  mode: importer',
      '  daterange:',
      '    start: !!timestamp 2024-01-01',
      '    end: 2024-01-02',
      `exchange: { name: binance, apiKey: ${API_KEY}, secret: ${SECRET} }`,
    ].join('\n');
    const missingCommaJson5 = [
      '{',
      '  watch: { assets: ["BTC"], currency: "USDT", timeframe: "5m", mode: "realtime" },',
      `  exchange: { name: "binance", apiKey: "${API_KEY}", secret: "${SECRET}" }`,
      '  plugins: [],',
      '}',
    ].join('\n');
    /** The refusal of a file that does not parse: its format and its name, then the fault */
    const refusal = (format: string, path: string, fault: string) =>
      `[CONFIGURATION] Invalid ${format} in configuration file ${path}: ${fault}`;
    /** JSON5's reason for a character it did not expect, at the position it gives */
    const invalidCharacter = (character: string, line: number, column: number) =>
      `invalid character '${character}' at line ${line}, column ${column}`;

    /** What loading the file throws, to read more of it than its message */
    const loadError = (path: string) => {
      try {
        loadConfigurationFile(path);
      } catch (error) {
        return error as Error;
      }
      throw new Error('The configuration loaded');
    };

    // A nesting too deep for js-yaml's recursion fails with the engine's RangeError, whose message Bun ends with a period
    describe.each`
      problem                                     | path                     | content                                                          | message
      ${'an @ value under the Telegram token'}    | ${'./config/live.yml'}   | ${telegramYaml('    botUsername: @gekko_bot')}                   | ${refusal('YAML', './config/live.yml', 'bad indentation of a mapping entry at line 9, column 18')}
      ${'a stray colon under the Telegram token'} | ${'./config/live.yml'}   | ${telegramYaml('    chatId: -100123456789: alerts group')}       | ${refusal('YAML', './config/live.yml', 'bad indentation of a mapping entry at line 9, column 26')}
      ${'a tab indent under the API keys'}        | ${'./config/live.yml'}   | ${liveYaml('\tsandbox: false', 'plugins: []')}                   | ${refusal('YAML', './config/live.yml', 'tab characters must not be used in indentation at line 6, column 1')}
      ${'an unknown !!timestamp tag'}             | ${'./config/live.yml'}   | ${timestampYaml}                                                 | ${refusal('YAML', './config/live.yml', 'unknown tag !<tag:yaml.org,2002:timestamp> at line 6, column 34')}
      ${'two YAML documents'}                     | ${'./config/live.yml'}   | ${`${liveYaml('plugins: []')}\n---\n${liveYaml('plugins: []')}`} | ${refusal('YAML', './config/live.yml', 'expected a single document in the stream, but found more')}
      ${'a JSON5 object missing a comma'}         | ${'./config/live.json5'} | ${missingCommaJson5}                                             | ${refusal('JSON5', './config/live.json5', invalidCharacter('p', 4, 3))}
      ${'YAML in a .json file'}                   | ${'./config/live.json'}  | ${liveYaml('plugins: []')}                                       | ${refusal('JSON', './config/live.json', invalidCharacter('w', 1, 1))}
      ${'a nesting too deep for the YAML parser'} | ${'./config/live.yml'}   | ${liveYaml(`plugins: ${'['.repeat(100_000)}`)}                   | ${expect.stringMatching(/^\[CONFIGURATION\] Invalid YAML in configuration file \.\/config\/live\.yml: Maximum call stack size exceeded\.?$/)}
    `('as $problem', ({ path, content, message }) => {
      beforeEach(() => {
        setFileContent(content);
      });

      it('throws a GekkoError', () => {
        expect(() => loadConfigurationFile(path)).toThrow(GekkoError);
      });

      it('names the format and the file, then what the parser found wrong and where', () => {
        expect(() => loadConfigurationFile(path)).toThrow(expect.objectContaining({ message }));
      });

      it('quotes none of the credentials around the fault', () => {
        expect(loadError(path).message).not.toMatch(/FAKE/);
      });

      it('keeps no cause, which the fatal error report would print in full', () => {
        expect(loadError(path).cause).toBeUndefined();
      });
    });
  });
});

describe('parseConfiguration', () => {
  it.each`
    section      | expected
    ${'watch'}   | ${parsedWatch}
    ${'storage'} | ${null}
  `('returns the $section section as the schema outputs it, its defaults applied', ({ section, expected }) => {
    expect(parseConfiguration(raw, 'object')[section as 'watch' | 'storage']).toEqual(expected);
  });

  describe.each`
    problem                        | content                                                                | issues
    ${'a misspelt key'}            | ${{ ...raw, watch: { ...omit(raw.watch, 'assets'), asset: ['BTC'] } }} | ${'✖ Unrecognized key: "asset"\n  → at watch\n✖ Invalid input: expected array, received undefined\n  → at watch.assets'}
    ${'a value of the wrong type'} | ${{ ...raw, showLogo: 'yes' }}                                         | ${'✖ Invalid input: expected boolean, received string\n  → at showLogo'}
  `('given a configuration with $problem', ({ content, issues }) => {
    it('throws a GekkoError', () => {
      expect(() => parseConfiguration(content, 'object')).toThrow(GekkoError);
    });

    it.each`
      source
      ${'object'}
      ${'variant 12'}
      ${'file ./config/gekko.json'}
    `('names its source, $source, then gives each problem on its own line with the path of the option at fault', ({ source }) => {
      expect(() => parseConfiguration(content, source)).toThrow(
        expect.objectContaining({ message: `[CONFIGURATION] Invalid configuration ${source}:\n${issues}` }),
      );
    });
  });

  describe('given a daterange', () => {
    /** raw in importer mode, over `daterange` */
    const importerOver = (daterange: { start: string; end: string }) => ({
      ...raw,
      exchange: importerExchange,
      watch: { ...raw.watch, mode: 'importer', daterange },
    });

    it('reads each bound as the epoch milliseconds of its instant', () => {
      const daterange = { start: '2023-01-01T00:00:00Z', end: '2023-01-02T00:00:00Z' };
      expect(parseConfiguration(importerOver(daterange), 'object').watch.daterange).toEqual({
        start: Date.UTC(2023, 0, 1),
        end: Date.UTC(2023, 0, 2),
      });
    });

    // Both bounds are included, each as the minute holding it: equal bounds are the range of a one-minute re-import, which getWatch
    // refused when it compared milliseconds, quoting them
    it('reads equal bounds as a one-minute range', () => {
      const daterange = { start: '2023-01-01T10:23:00Z', end: '2023-01-01T10:23:00Z' };
      expect(parseConfiguration(importerOver(daterange), 'object').watch.daterange).toEqual({
        start: Date.UTC(2023, 0, 1, 10, 23),
        end: Date.UTC(2023, 0, 1, 10, 23),
      });
    });

    it.each`
      mode          | exchange            | storage
      ${'importer'} | ${importerExchange} | ${undefined}
      ${'backtest'} | ${backtestExchange} | ${{ type: 'sqlite', database: 'gekko.db' }}
    `('refuses a range that ends before it starts in $mode mode, naming both bounds in ISO 8601', ({ mode, exchange, storage }) => {
      const daterange = { start: '2023-01-02T00:00:00Z', end: '2023-01-01T00:00:00Z' };
      expect(() => parseConfiguration({ ...raw, exchange, storage, watch: { ...raw.watch, mode, daterange } }, 'object')).toThrow(
        expect.objectContaining({
          message:
            '[CONFIGURATION] Invalid configuration object:\n✖ watch.daterange must end in the minute of its start or later: it starts at 2023-01-02T00:00:00.000Z and ends at 2023-01-01T00:00:00.000Z\n  → at watch.daterange',
        }),
      );
    });
  });
});

describe('readConfigurationFile', () => {
  it('returns the configuration the file holds, as the schema outputs it', () => {
    setFileContent(dump(raw));
    expect(readConfigurationFile('./config/gekko.yml').watch).toEqual(parsedWatch);
  });

  it('names the file in the refusal of an invalid configuration', () => {
    setFileContent({ ...raw, showLogo: 'yes' });
    expect(() => readConfigurationFile('./config/gekko.json')).toThrow(
      '[CONFIGURATION] Invalid configuration file ./config/gekko.json:\n✖ Invalid input: expected boolean, received string\n  → at showLogo',
    );
  });

  // js-yaml's default schema loaded an unquoted timestamp as a Date, rolled over when the day did not exist (2023-02-29 as March 1st),
  // while the schema refused a quoted day or offset: the loader keeps YAML timestamps as text, which the schema checks either way
  describe('given a YAML daterange', () => {
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
    `('reads $form, $start, as 2023-01-01T00:00:00.000Z', ({ start }) => {
      setFileContent(importerYaml(start));
      expect(readConfigurationFile('config.yml').watch.daterange).toEqual({ start: Date.UTC(2023, 0, 1), end: Date.UTC(2023, 0, 2) });
    });

    it.each`
      start
      ${'2023-02-29'}
      ${'2023-04-31'}
      ${'2023-13-01'}
      ${'2023-02-28T24:00:00Z'}
      ${'2023-01-01T00:00:00+25:00'}
    `('refuses $start, a date that does not exist, unquoted, naming it and its path', ({ start }) => {
      setFileContent(importerYaml(start));
      expect(() => readConfigurationFile('config.yml')).toThrow(
        expect.objectContaining({
          message: `[CONFIGURATION] Invalid configuration file config.yml:\n✖ watch.daterange.start '${start}' must be a date that exists, in ISO 8601: a day (2024-01-01, from its midnight UTC), or a day and a time with Z or an offset (2024-01-01T00:00:00Z, 2024-01-01T02:00:00+02:00)\n  → at watch.daterange.start`,
        }),
      );
    });
  });
});

describe('readConfigurationFromEnvironment', () => {
  const pathVariable = process.env.GEKKO_CONFIG_FILE_PATH;

  afterEach(() => {
    if (pathVariable === undefined) delete process.env.GEKKO_CONFIG_FILE_PATH;
    else process.env.GEKKO_CONFIG_FILE_PATH = pathVariable;
  });

  it('refuses to read a configuration while GEKKO_CONFIG_FILE_PATH is unset', () => {
    delete process.env.GEKKO_CONFIG_FILE_PATH;
    expect(() => readConfigurationFromEnvironment()).toThrow(
      new GekkoError('configuration', 'Missing GEKKO_CONFIG_FILE_PATH environment variable'),
    );
  });

  describe('with GEKKO_CONFIG_FILE_PATH set', () => {
    beforeEach(() => {
      process.env.GEKKO_CONFIG_FILE_PATH = './config/gekko.json';
      setFileContent(raw);
    });

    it('reads the file it names', () => {
      readConfigurationFromEnvironment();
      expect(readFileSync).toHaveBeenCalledExactlyOnceWith('./config/gekko.json', 'utf8');
    });

    it('returns the configuration that file holds, as the schema outputs it', () => {
      expect(readConfigurationFromEnvironment().watch).toEqual(parsedWatch);
    });
  });
});
