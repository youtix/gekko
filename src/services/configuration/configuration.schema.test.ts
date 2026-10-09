import { load } from 'js-yaml';
import { cloneDeep, get, set } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { configurationSchema, watchSchema } from './configuration.schema';

const BATCH_SIZE_MESSAGE =
  'batchSize must be an integer between 1 and 44640 (minutes, 31 days at most: each batch is read into memory at once)';
const INSERT_THRESHOLD_MESSAGE =
  'storage.insertThreshold must be an integer between 1 and 1440 (minutes, a day at most: the candles are held in memory until they are written)';

const DISCLAIMER_FIELD = 'I understand that Gekko only automates MY OWN trading strategies' as const;

const ISO_START = '2023-01-01T00:00:00.000Z';
const ISO_END = '2023-01-02T00:00:00.000Z';
const START_TIMESTAMP = Date.UTC(2023, 0, 1);
const END_TIMESTAMP = Date.UTC(2023, 0, 2);

const marketDataEntry = (symbol: string) => ({
  symbol,
  marketData: {
    price: { min: 0.01, max: 1000000 },
    amount: { min: 0.00001, max: 9000 },
    cost: { min: 5, max: 9000000 },
    precision: { price: 8, amount: 8 },
    fee: { maker: 0.0004, taker: 0.0007 },
  },
});

// js-yaml loads the unquoted timestamps below as Date objects, not strings.
const UNQUOTED_DATERANGE_YAML = `
watch:
  assets: [BTC]
  currency: USDT
  timeframe: 1m
  mode: backtest
  daterange:
    start: 2023-01-01T00:00:00Z
    end: 2023-01-02T00:00:00Z
exchange:
  name: dummy-cex
  simulationBalance:
    - assetName: USDT
      balance: 1000
  marketData:
    - symbol: BTC/USDT
      marketData:
        price: { min: 0.01, max: 1000000 }
        amount: { min: 0.00001, max: 9000 }
        cost: { min: 5, max: 9000000 }
        precision: { price: 8, amount: 8 }
        fee: { maker: 0.0004, taker: 0.0007 }
storage:
  type: sqlite
  database: db/candles.sql
plugins: []
`;

// Required in backtest mode and by CandleWriter
const sqliteStorage = { type: 'sqlite', database: 'db/candles.sql' };

// Base pairs for v3 config format
const basePairs = [{ symbol: 'BTC/USDT' }];

describe('watchSchema', () => {
  const baseWatch = {
    assets: ['BTC'],
    currency: 'USDT',
    timeframe: '1m' as const,
  };

  describe('importer mode', () => {
    const importerBase = { ...baseWatch, mode: 'importer' as const };

    it.each`
      scenario                                               | overrides                                                            | expectSuccess
      ${'a daterange with no value (null) fails validation'} | ${{}}                                                                | ${false}
      ${'accepts valid daterange'}                           | ${{ daterange: { start: ISO_START, end: ISO_END } }}                 | ${true}
      ${'respects extra optional fields'}                    | ${{ daterange: { start: ISO_START, end: ISO_END }, batchSize: 500 }} | ${true}
    `('$scenario', ({ overrides, expectSuccess }) => {
      const candidate: Record<string, unknown> = {
        ...importerBase,
        daterange: null,
        ...overrides,
      };

      const result = watchSchema.safeParse(candidate);

      if (expectSuccess) {
        expect(result.success).toBe(true);
      } else {
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]).toMatchObject({ path: ['daterange'] });
      }
    });

    it('allows missing timeframe', () => {
      const candidate = {
        ...importerBase,
        timeframe: undefined,
        daterange: { start: ISO_START, end: ISO_END },
      };
      const result = watchSchema.safeParse(candidate);
      expect(result.success).toBe(true);
    });
  });

  describe('backtest mode', () => {
    const backtestBase = { ...baseWatch, mode: 'backtest' as const };

    it.each`
      scenario                                               | overrides                                                            | expectSuccess
      ${'a daterange with no value (null) fails validation'} | ${{}}                                                                | ${false}
      ${'accepts valid daterange'}                           | ${{ daterange: { start: ISO_START, end: ISO_END } }}                 | ${true}
      ${'respects extra optional fields'}                    | ${{ daterange: { start: ISO_START, end: ISO_END }, batchSize: 500 }} | ${true}
    `('$scenario', ({ overrides, expectSuccess }) => {
      const candidate: Record<string, unknown> = {
        ...backtestBase,
        daterange: null,
        ...overrides,
      };

      const result = watchSchema.safeParse(candidate);

      if (expectSuccess) {
        expect(result.success).toBe(true);
      } else {
        expect(result.success).toBe(false);
        // We expect daterange error here as per existing tests
        expect(result.error?.issues[0]).toMatchObject({ path: ['daterange'] });
      }
    });

    it('requires timeframe', () => {
      const candidate = {
        ...backtestBase,
        daterange: { start: ISO_START, end: ISO_END },
        timeframe: undefined,
      };
      const result = watchSchema.safeParse(candidate);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({
        path: ['timeframe'],
        message: 'timeframe is required for backtest and realtime modes',
      });
    });
  });

  describe('realtime mode', () => {
    it('applies defaults while leaving daterange optional', () => {
      const candidate = {
        ...baseWatch,
        mode: 'realtime' as const,
        timeframe: '1m' as const,
      };

      const result = watchSchema.parse(candidate);

      expect(result.tickrate).toBe(1000);
      expect(result.pairs).toEqual(basePairs);
      expect(result.assets).toEqual(['BTC']);
      expect(result.currency).toBe('USDT');
      expect(result.warmup).toEqual({ tickrate: 1000, candleCount: 0 });
      expect(result.daterange).toBeUndefined();
    });

    it('fills in the warmup fields left out', () => {
      const { warmup } = watchSchema.parse({ ...baseWatch, mode: 'realtime', warmup: {} });
      expect(warmup).toEqual({ tickrate: 1000, candleCount: 0 });
    });

    it('requires timeframe', () => {
      const candidate = {
        ...baseWatch,
        mode: 'realtime' as const,
        timeframe: undefined,
      };

      const result = watchSchema.safeParse(candidate);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({
        path: ['timeframe'],
        message: 'timeframe is required for backtest and realtime modes',
      });
    });
  });

  describe('daterange', () => {
    const backtestWatch = { ...baseWatch, mode: 'backtest' as const };

    it.each`
      scenario          | start                  | end
      ${'ISO strings'}  | ${ISO_START}           | ${ISO_END}
      ${'a Date start'} | ${new Date(ISO_START)} | ${ISO_END}
      ${'a Date end'}   | ${ISO_START}           | ${new Date(ISO_END)}
    `('converts $scenario to epoch milliseconds', ({ start, end }) => {
      const { daterange } = watchSchema.parse({ ...backtestWatch, daterange: { start, end } });
      expect(daterange).toEqual({ start: START_TIMESTAMP, end: END_TIMESTAMP });
    });

    it.each`
      scenario                      | start                     | end                       | issue
      ${'an invalid Date start'}    | ${new Date('not a date')} | ${ISO_END}                | ${{ path: ['daterange', 'start'], code: 'invalid_type' }}
      ${'an invalid Date end'}      | ${ISO_START}              | ${new Date('not a date')} | ${{ path: ['daterange', 'end'], code: 'invalid_type' }}
      ${'a date-only string start'} | ${'2023-01-01'}           | ${ISO_END}                | ${{ path: ['daterange', 'start'], message: 'Invalid ISO datetime' }}
    `('reports $scenario as an issue on its path', ({ start, end, issue }) => {
      const result = watchSchema.safeParse({ ...backtestWatch, daterange: { start, end } });
      expect(result.error?.issues).toMatchObject([issue]);
    });

    // Omitted, not null: YAML loads a `daterange:` key with no value as null, which fails the type check before this rule runs.
    it.each`
      mode
      ${'importer'}
      ${'backtest'}
    `('reports a daterange omitted in $mode mode as required', ({ mode }) => {
      const result = watchSchema.safeParse({ ...baseWatch, mode });
      expect(result.error?.issues).toMatchObject([
        { code: 'custom', path: ['daterange'], message: 'daterange is required for importer and backtest modes' },
      ]);
    });
  });

  describe('numeric fields', () => {
    const realtimeWatch = { ...baseWatch, mode: 'realtime' as const };

    it.each`
      path                         | value     | message
      ${['tickrate']}              | ${0}      | ${'tickrate must be an integer of at least 100'}
      ${['tickrate']}              | ${-1}     | ${'tickrate must be an integer of at least 100'}
      ${['tickrate']}              | ${99}     | ${'tickrate must be an integer of at least 100'}
      ${['tickrate']}              | ${500.5}  | ${'tickrate must be an integer of at least 100'}
      ${['tickrate']}              | ${'500'}  | ${'tickrate must be an integer of at least 100'}
      ${['warmup', 'tickrate']}    | ${0}      | ${'warmup.tickrate must be an integer of at least 100'}
      ${['warmup', 'tickrate']}    | ${99}     | ${'warmup.tickrate must be an integer of at least 100'}
      ${['warmup', 'tickrate']}    | ${500.5}  | ${'warmup.tickrate must be an integer of at least 100'}
      ${['warmup', 'candleCount']} | ${-1}     | ${'warmup.candleCount must be an integer of at least 0'}
      ${['warmup', 'candleCount']} | ${10.5}   | ${'warmup.candleCount must be an integer of at least 0'}
      ${['batchSize']}             | ${0}      | ${BATCH_SIZE_MESSAGE}
      ${['batchSize']}             | ${-1}     | ${BATCH_SIZE_MESSAGE}
      ${['batchSize']}             | ${1440.5} | ${BATCH_SIZE_MESSAGE}
      ${['batchSize']}             | ${44641}  | ${BATCH_SIZE_MESSAGE}
      ${['batchSize']}             | ${'1440'} | ${BATCH_SIZE_MESSAGE}
    `('rejects $value at $path', ({ path, value, message }) => {
      const result = watchSchema.safeParse(set(cloneDeep(realtimeWatch), path, value));
      expect(result.error?.issues).toMatchObject([{ path, message }]);
    });

    it.each`
      path                         | value
      ${['tickrate']}              | ${100}
      ${['warmup', 'tickrate']}    | ${100}
      ${['warmup', 'candleCount']} | ${0}
      ${['batchSize']}             | ${1}
    `('accepts $value at $path, the lowest value allowed', ({ path, value }) => {
      const watch = watchSchema.parse(set(cloneDeep(realtimeWatch), path, value));
      expect(get(watch, path)).toBe(value);
    });

    it('accepts a batchSize of 44640, 31 days of minutes, the highest value allowed', () => {
      const watch = watchSchema.parse({ ...realtimeWatch, batchSize: 44640 });
      expect(watch.batchSize).toBe(44640);
    });
  });

  describe('unknown keys', () => {
    const daterange = { start: ISO_START, end: ISO_END };
    const backtestWatch = { ...baseWatch, mode: 'backtest' as const, daterange };

    it.each`
      scenario                            | overrides                                                    | path             | keys
      ${'a misspelt key under watch'}     | ${{ tickRate: 500 }}                                         | ${[]}            | ${['tickRate']}
      ${'a misspelt key under warmup'}    | ${{ warmup: { candlecount: 250 } }}                          | ${['warmup']}    | ${['candlecount']}
      ${'an unknown key under daterange'} | ${{ daterange: { ...daterange, timezone: 'Europe/Paris' } }} | ${['daterange']} | ${['timezone']}
    `('rejects $scenario instead of dropping it', ({ overrides, path, keys }) => {
      const result = watchSchema.safeParse({ ...backtestWatch, ...overrides });
      expect(result.error?.issues).toMatchObject([{ code: 'unrecognized_keys', path, keys }]);
    });
  });

  describe('assets and currency', () => {
    it.each`
      scenario                            | assets                                          | currency      | issue
      ${'a duplicated asset'}             | ${['BTC', 'ETH', 'BTC']}                        | ${'USDT'}     | ${{ path: ['assets'], message: 'assets must not contain duplicates (repeated: BTC)' }}
      ${'several duplicated assets'}      | ${['BTC', 'ETH', 'ETH', 'BTC', 'BTC']}          | ${'USDT'}     | ${{ path: ['assets'], message: 'assets must not contain duplicates (repeated: ETH, BTC)' }}
      ${'an asset equal to the currency'} | ${['BTC', 'USDT']}                              | ${'USDT'}     | ${{ path: ['assets'], message: 'assets must not contain the currency (USDT)' }}
      ${'a numeric asset'}                | ${['BTC', 1000]}                                | ${'USDT'}     | ${{ path: ['assets', 1], code: 'invalid_type' }}
      ${'an empty asset'}                 | ${['']}                                         | ${'USDT'}     | ${{ path: ['assets', 0], message: 'Asset must not be empty' }}
      ${'a numeric currency'}             | ${['BTC']}                                      | ${1000}       | ${{ path: ['currency'], code: 'invalid_type' }}
      ${'an empty currency'}              | ${['BTC']}                                      | ${''}         | ${{ path: ['currency'], message: 'Currency must not be empty' }}
      ${'no asset'}                       | ${[]}                                           | ${'USDT'}     | ${{ path: ['assets'], message: 'At least one asset is required' }}
      ${'6 assets'}                       | ${['BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'DOT']} | ${'USDT'}     | ${{ path: ['assets'], message: 'Maximum 5 assets allowed' }}
      ${'an asset with a slash'}          | ${['BTC/USDT']}                                 | ${'USDT'}     | ${{ path: ['assets', 0], message: 'Asset must not contain a slash' }}
      ${'a currency with a slash'}        | ${['BTC']}                                      | ${'BTC/USDT'} | ${{ path: ['currency'], message: 'Currency must not contain a slash' }}
    `('reports $scenario as an issue', ({ assets, currency, issue }) => {
      const result = watchSchema.safeParse({ ...baseWatch, mode: 'realtime', assets, currency });
      expect(result.error?.issues).toMatchObject([issue]);
    });

    it('accepts 5 assets, the most allowed', () => {
      const result = watchSchema.safeParse({ ...baseWatch, mode: 'realtime', assets: ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK'] });
      expect(result.error?.issues).toBeUndefined();
    });
  });

  describe('mode and timeframe', () => {
    it.each`
      field          | value
      ${'mode'}      | ${'live'}
      ${'timeframe'} | ${'60m'}
    `('reports $value as a $field outside the allowed values', ({ field, value }) => {
      const result = watchSchema.safeParse({ ...baseWatch, mode: 'realtime', [field]: value });
      expect(result.error?.issues).toMatchObject([{ path: [field], code: 'invalid_value' }]);
    });
  });
});

describe('configurationSchema', () => {
  const createBaseConfig = () => ({
    watch: {
      assets: ['BTC'],
      currency: 'USDT',
      mode: 'realtime' as const,
      timeframe: '1m' as const,
    },
    plugins: [] as Array<{ name?: string }>,
    exchange: {
      name: 'paper-binance' as const,
      simulationBalance: [
        { assetName: 'BTC', balance: 1 },
        { assetName: 'USDT', balance: 10000 },
      ],
    },
  });

  it('populates defaults for optional configuration sections', () => {
    const result = configurationSchema.parse(createBaseConfig());

    expect(result.showLogo).toBe(true);
    expect(result.watch.tickrate).toBe(1000);
    expect(result.watch.pairs).toEqual(basePairs);
    expect(result.watch.assets).toEqual(['BTC']);
    expect(result.watch.currency).toBe('USDT');
    expect(result.watch.warmup).toEqual({ tickrate: 1000, candleCount: 0 });
    expect(result.watch.daterange).toBeUndefined();
    expect(result.exchange).toMatchObject({
      name: 'paper-binance',
      exchangeSynchInterval: 600000,
      orderSynchInterval: 20000,
    });
    expect(result.storage).toBeNull();
    expect(result[DISCLAIMER_FIELD]).toBeNull();
  });

  describe('storage', () => {
    const backtestConfig = () => ({
      ...createBaseConfig(),
      watch: { ...createBaseConfig().watch, mode: 'backtest', daterange: { start: ISO_START, end: ISO_END } },
      exchange: {
        name: 'dummy-cex',
        simulationBalance: [{ assetName: 'USDT', balance: 1000 }],
        marketData: [marketDataEntry('BTC/USDT')],
      },
    });
    const writerConfig = () => ({ ...createBaseConfig(), plugins: [{ name: 'CandleWriter' }] });

    it.each`
      scenario                        | config            | message
      ${'in backtest mode'}           | ${backtestConfig} | ${'storage is required in backtest mode, which reads the candles from it'}
      ${'with a CandleWriter plugin'} | ${writerConfig}   | ${'storage is required by the CandleWriter plugin, which writes the candles to it'}
    `('reports a missing storage $scenario', ({ config, message }) => {
      const result = configurationSchema.safeParse(config());
      expect(result.error?.issues).toMatchObject([{ path: ['storage'], message }]);
    });

    it.each`
      scenario                        | config
      ${'in backtest mode'}           | ${backtestConfig}
      ${'with a CandleWriter plugin'} | ${writerConfig}
    `('accepts a storage $scenario', ({ config }) => {
      const result = configurationSchema.safeParse({ ...config(), storage: sqliteStorage });
      expect(result.error?.issues).toBeUndefined();
    });

    it('reports a missing storage together with an invalid watch field', () => {
      const result = configurationSchema.safeParse(set(backtestConfig(), ['watch', 'tickrate'], 50));
      expect(result.error?.issues.map(issue => issue.path)).toEqual([['watch', 'tickrate'], ['storage']]);
    });

    // The marketData rule only stands down for an issue inside a section, not for one of the rules next to it
    it('reports a missing storage together with a missing marketData entry', () => {
      const result = configurationSchema.safeParse(set(backtestConfig(), ['watch', 'assets'], ['BTC', 'ETH']));
      expect(result.error?.issues.map(issue => issue.path)).toEqual([['storage'], ['exchange', 'marketData']]);
    });

    it.each`
      field                | value        | issue
      ${'database'}        | ${''}        | ${{ path: ['storage', 'database'], message: 'storage.database must not be empty' }}
      ${'database'}        | ${'   '}     | ${{ path: ['storage', 'database'], message: 'storage.database must not be empty' }}
      ${'database'}        | ${undefined} | ${{ path: ['storage', 'database'], code: 'invalid_type' }}
      ${'insertThreshold'} | ${0}         | ${{ path: ['storage', 'insertThreshold'], message: INSERT_THRESHOLD_MESSAGE }}
      ${'insertThreshold'} | ${-3}        | ${{ path: ['storage', 'insertThreshold'], message: INSERT_THRESHOLD_MESSAGE }}
      ${'insertThreshold'} | ${1.5}       | ${{ path: ['storage', 'insertThreshold'], message: INSERT_THRESHOLD_MESSAGE }}
      ${'insertThreshold'} | ${1441}      | ${{ path: ['storage', 'insertThreshold'], message: INSERT_THRESHOLD_MESSAGE }}
      ${'insertThreshold'} | ${'1000'}    | ${{ path: ['storage', 'insertThreshold'], message: INSERT_THRESHOLD_MESSAGE }}
    `('reports $value as storage.$field', ({ field, value, issue }) => {
      const result = configurationSchema.safeParse({ ...createBaseConfig(), storage: { ...sqliteStorage, [field]: value } });
      expect(result.error?.issues).toMatchObject([issue]);
    });

    // Left out, insertThreshold stays out, and Storage applies the default of the mode
    it.each`
      scenario                                         | storage                                                | expected
      ${'a database path with spaces around it'}       | ${{ ...sqliteStorage, database: '  db/candles.sql ' }} | ${sqliteStorage}
      ${'an insertThreshold of 1, the fewest'}         | ${{ ...sqliteStorage, insertThreshold: 1 }}            | ${{ ...sqliteStorage, insertThreshold: 1 }}
      ${'an insertThreshold of 1440, a day, the most'} | ${{ ...sqliteStorage, insertThreshold: 1440 }}         | ${{ ...sqliteStorage, insertThreshold: 1440 }}
      ${'no insertThreshold'}                          | ${sqliteStorage}                                       | ${sqliteStorage}
    `('reads $scenario', ({ storage, expected }) => {
      const result = configurationSchema.parse({ ...createBaseConfig(), storage });
      expect(result.storage).toStrictEqual(expected);
    });
  });

  it('reports a storage type other than sqlite', () => {
    const result = configurationSchema.safeParse({ ...createBaseConfig(), storage: { type: 'postgres', database: 'gekko.db' } });
    expect(result.error?.issues).toMatchObject([{ path: ['storage', 'type'], code: 'invalid_value' }]);
  });

  const traderPlugin = [{ name: 'Trader' }];
  const OtherPlugin = [{ name: 'Other' }];
  const binanceExchange = { name: 'binance', apiKey: 'test', secret: 'test' };
  const sandboxExchange = { name: 'binance', sandbox: true, apiKey: 'test', secret: 'test' };

  it.each`
    scenario                                              | plugins         | exchange           | disclaimer | expectSuccess
    ${'trader plugin with real exchange missing consent'} | ${traderPlugin} | ${binanceExchange} | ${null}    | ${false}
    ${'trader plugin with disclaimer declined'}           | ${traderPlugin} | ${binanceExchange} | ${false}   | ${false}
    ${'trader plugin with disclaimer acknowledged'}       | ${traderPlugin} | ${binanceExchange} | ${true}    | ${true}
    ${'non-trader plugin without disclaimer'}             | ${OtherPlugin}  | ${binanceExchange} | ${null}    | ${true}
    ${'trader plugin on sandboxed exchange'}              | ${traderPlugin} | ${sandboxExchange} | ${null}    | ${true}
  `('enforces disclaimer requirements when $scenario', ({ plugins, exchange, disclaimer, expectSuccess }) => {
    const configInput: Record<string, unknown> = {
      ...createBaseConfig(),
      plugins,
      exchange,
    };

    if (disclaimer !== undefined) {
      configInput[DISCLAIMER_FIELD] = disclaimer;
    }

    const result = configurationSchema.safeParse(configInput);

    if (expectSuccess) {
      expect(result.success).toBe(true);
    } else {
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({
        path: [DISCLAIMER_FIELD],
      });
    }
  });

  describe('unknown keys', () => {
    const storage = { type: 'sqlite', database: 'gekko.db', insertTreshold: 100 };
    const binance = { ...binanceExchange, sandobx: true };
    const hyperliquid = { name: 'hyperliquid', privateKey: '0x01', walletAddress: '0x02', sandobx: true };

    // A dropped key would leave its default in place: with the disclaimer accepted, a misspelt sandbox flag would trade live
    it.each`
      scenario                                    | overrides                           | path            | keys
      ${'a misspelt strategy block (strategies)'} | ${{ strategies: { name: 'DEMA' } }} | ${[]}           | ${['strategies']}
      ${'a misspelt storage option'}              | ${{ storage }}                      | ${['storage']}  | ${['insertTreshold']}
      ${'a misspelt sandbox flag on binance'}     | ${{ exchange: binance }}            | ${['exchange']} | ${['sandobx']}
      ${'a misspelt sandbox flag on hyperliquid'} | ${{ exchange: hyperliquid }}        | ${['exchange']} | ${['sandobx']}
    `('refuses $scenario instead of dropping it', ({ overrides, path, keys }) => {
      const result = configurationSchema.safeParse({
        ...createBaseConfig(),
        plugins: traderPlugin,
        [DISCLAIMER_FIELD]: true,
        ...overrides,
      });
      expect(result.error?.issues).toMatchObject([{ code: 'unrecognized_keys', path, keys }]);
    });

    // The strategy block is handed whole to the strategy, and the pipeline parses each plugin entry with its plugin's schema
    it.each`
      scenario                                 | overrides                                                                          | path
      ${'the parameters of the strategy'}      | ${{ strategy: { name: 'DEMA', period: 12, thresholds: { up: 100 } } }}             | ${['strategy']}
      ${'the options of a plugin, left to it'} | ${{ plugins: [{ name: 'Trader', portfolioUpdates: { threshold: 1, dust: 10 } }] }} | ${['plugins', 0]}
    `('keeps $scenario as written', ({ overrides, path }) => {
      const result = configurationSchema.parse({ ...createBaseConfig(), ...overrides });
      expect(get(result, path)).toEqual(get(overrides, path));
    });
  });

  describe('exchange allowed in each mode', () => {
    const simulationBalance = [{ assetName: 'USDT', balance: 1000 }];
    const exchanges: Record<string, object> = {
      'dummy-cex': { name: 'dummy-cex', simulationBalance, marketData: [marketDataEntry('BTC/USDT')] },
      binance: binanceExchange,
      'binance sandbox': sandboxExchange,
      hyperliquid: { name: 'hyperliquid', privateKey: '0x01', walletAddress: '0x02' },
      'paper-binance': { name: 'paper-binance', simulationBalance },
    };
    // A daterange is required in backtest and importer modes and optional in realtime mode.
    const createConfig = (mode: string, exchange: string) => ({
      ...createBaseConfig(),
      watch: { ...createBaseConfig().watch, mode, daterange: { start: ISO_START, end: ISO_END } },
      exchange: exchanges[exchange],
      storage: sqliteStorage,
    });

    it.each`
      mode          | exchange             | verdict
      ${'backtest'} | ${'dummy-cex'}       | ${'accepts'}
      ${'backtest'} | ${'binance'}         | ${'refuses'}
      ${'backtest'} | ${'binance sandbox'} | ${'refuses'}
      ${'backtest'} | ${'hyperliquid'}     | ${'refuses'}
      ${'backtest'} | ${'paper-binance'}   | ${'refuses'}
      ${'importer'} | ${'dummy-cex'}       | ${'refuses'}
      ${'importer'} | ${'binance'}         | ${'accepts'}
      ${'importer'} | ${'binance sandbox'} | ${'accepts'}
      ${'importer'} | ${'hyperliquid'}     | ${'accepts'}
      ${'importer'} | ${'paper-binance'}   | ${'refuses'}
      ${'realtime'} | ${'dummy-cex'}       | ${'refuses'}
      ${'realtime'} | ${'binance'}         | ${'accepts'}
      ${'realtime'} | ${'binance sandbox'} | ${'accepts'}
      ${'realtime'} | ${'hyperliquid'}     | ${'accepts'}
      ${'realtime'} | ${'paper-binance'}   | ${'accepts'}
    `('$verdict $exchange in $mode mode', ({ mode, exchange, verdict }) => {
      const result = configurationSchema.safeParse(createConfig(mode, exchange));
      const issuePaths = result.error?.issues.map(issue => issue.path) ?? [];
      expect(issuePaths).toEqual(verdict === 'accepts' ? [] : [['exchange', 'name']]);
    });

    // The first row is the reported trigger: a live trading config (keys, Trader, disclaimer accepted) switched to backtest.
    it.each`
      mode          | exchange       | message
      ${'backtest'} | ${'binance'}   | ${'Exchange binance cannot be used in backtest mode (allowed: dummy-cex)'}
      ${'realtime'} | ${'dummy-cex'} | ${'Exchange dummy-cex cannot be used in realtime mode (allowed: binance, hyperliquid, paper-binance)'}
    `('reports $exchange in $mode mode as one issue naming the allowed exchanges', ({ mode, exchange, message }) => {
      const result = configurationSchema.safeParse({
        ...createConfig(mode, exchange),
        plugins: [{ name: 'TradingAdvisor' }, { name: 'Trader' }],
        [DISCLAIMER_FIELD]: true,
      });
      expect(result.error?.issues).toMatchObject([{ path: ['exchange', 'name'], message }]);
    });

    it.each`
      mode          | exchange
      ${'backtest'} | ${'dummy-cex'}
      ${'realtime'} | ${'paper-binance'}
    `('accepts a Trader on $exchange in $mode mode without the disclaimer', ({ mode, exchange }) => {
      const result = configurationSchema.safeParse({ ...createConfig(mode, exchange), plugins: traderPlugin });
      expect(result.error?.issues).toBeUndefined();
    });
  });

  it('accepts a YAML daterange written as unquoted ISO timestamps', () => {
    const { watch } = configurationSchema.parse(load(UNQUOTED_DATERANGE_YAML));
    expect(watch.daterange).toEqual({ start: START_TIMESTAMP, end: END_TIMESTAMP });
  });

  describe('dummy-cex marketData', () => {
    const createBacktestConfig = (assets: string[], symbols?: string[]) => ({
      ...createBaseConfig(),
      watch: { ...createBaseConfig().watch, assets, mode: 'backtest', daterange: { start: ISO_START, end: ISO_END } },
      exchange: {
        name: 'dummy-cex',
        simulationBalance: [{ assetName: 'USDT', balance: 1000 }],
        ...(symbols && { marketData: symbols.map(marketDataEntry) }),
      },
      storage: sqliteStorage,
    });
    const missingIssue = (symbols: string) => ({
      path: ['exchange', 'marketData'],
      message: `Each watched pair needs a marketData entry, or dummy-cex fills its orders with no fees and no order limits (missing: ${symbols})`,
    });
    const malformedSymbolMessage = (symbol: string) =>
      `Symbol '${symbol}' must be an asset and a currency in upper-case letters and digits, joined by one slash, as in BTC/USDT`;
    const notWatchedIssue = (symbols: string) => ({
      path: ['exchange', 'marketData'],
      message: `Each marketData symbol must match a watched pair (not watched: ${symbols})`,
    });

    it.each`
      scenario                            | assets            | symbols                     | issues
      ${'no entry at all'}                | ${['BTC', 'ETH']} | ${undefined}                | ${[missingIssue('BTC/USDT, ETH/USDT')]}
      ${'one pair missing out of two'}    | ${['BTC', 'ETH']} | ${['BTC/USDT']}             | ${[missingIssue('ETH/USDT')]}
      ${'a mistyped symbol'}              | ${['BTC']}        | ${['BTC/USTD']}             | ${[missingIssue('BTC/USDT'), notWatchedIssue('BTC/USTD')]}
      ${'an entry for an unwatched pair'} | ${['BTC']}        | ${['BTC/USDT', 'ETH/USDT']} | ${[notWatchedIssue('ETH/USDT')]}
    `('reports $scenario', ({ assets, symbols, issues }) => {
      const result = configurationSchema.safeParse(createBacktestConfig(assets, symbols));
      expect(result.error?.issues).toMatchObject(issues);
    });

    it('reports a missing entry and a strategy name mismatch together', () => {
      const result = configurationSchema.safeParse({
        ...createBacktestConfig(['BTC', 'ETH'], ['BTC/USDT']),
        plugins: [{ name: 'TradingAdvisor', strategyName: 'SMACrossover' }],
        strategy: { name: 'EMARibbon' },
      });
      expect(result.error?.issues).toMatchObject([missingIssue('ETH/USDT'), { path: ['strategy', 'name'] }]);
    });

    it('accepts an entry for every watched pair, in any order', () => {
      const result = configurationSchema.safeParse(createBacktestConfig(['BTC', 'ETH'], ['ETH/USDT', 'BTC/USDT']));
      expect(result.error?.issues).toBeUndefined();
    });

    it.each`
      type           | symbol
      ${'a number'}  | ${1000}
      ${'a boolean'} | ${true}
      ${'an object'} | ${{ base: 'BTC', quote: 'USDT' }}
      ${'null'}      | ${null}
    `('reports an entry symbol given as $type as a type issue instead of throwing', ({ symbol }) => {
      const config = createBacktestConfig(['BTC']);
      const marketData = [{ ...marketDataEntry('BTC/USDT'), symbol }];
      const result = configurationSchema.safeParse({ ...config, exchange: { ...config.exchange, marketData } });
      expect(result.error?.issues).toMatchObject([{ path: ['exchange', 'marketData', 0, 'symbol'], code: 'invalid_type' }]);
    });

    // Zod still runs the configuration's refinement after a non-aborting issue (a failed refine or bound) under watch or
    // exchange, but skips the transforms that build watch.pairs and the marketData Map.
    describe('when another field is invalid', () => {
      const coveredConfig = createBacktestConfig(['BTC'], ['BTC/USDT']);

      it.each`
        scenario                                 | path                                       | value                             | issue
        ${'a tickrate below 100'}                | ${['watch', 'tickrate']}                   | ${50}                             | ${{ path: ['watch', 'tickrate'], message: 'tickrate must be an integer of at least 100' }}
        ${'a negative warmup candleCount'}       | ${['watch', 'warmup', 'candleCount']}      | ${-1}                             | ${{ path: ['watch', 'warmup', 'candleCount'], message: 'warmup.candleCount must be an integer of at least 0' }}
        ${'a batchSize of 0'}                    | ${['watch', 'batchSize']}                  | ${0}                              | ${{ path: ['watch', 'batchSize'], message: BATCH_SIZE_MESSAGE }}
        ${'a duplicated asset'}                  | ${['watch', 'assets']}                     | ${['BTC', 'BTC']}                 | ${{ path: ['watch', 'assets'], message: 'assets must not contain duplicates (repeated: BTC)' }}
        ${'an asset with a slash'}               | ${['watch', 'assets']}                     | ${['BTC/USDT']}                   | ${{ path: ['watch', 'assets', 0], message: 'Asset must not contain a slash' }}
        ${'6 assets'}                            | ${['watch', 'assets']}                     | ${['A', 'B', 'C', 'D', 'E', 'F']} | ${{ path: ['watch', 'assets'], message: 'Maximum 5 assets allowed' }}
        ${'a daterange start that is not ISO'}   | ${['watch', 'daterange', 'start']}         | ${'yesterday'}                    | ${{ path: ['watch', 'daterange', 'start'], message: 'Invalid ISO datetime' }}
        ${'an asset equal to the currency'}      | ${['watch', 'assets']}                     | ${['USDT']}                       | ${{ path: ['watch', 'assets'], message: 'assets must not contain the currency (USDT)' }}
        ${'a marketData symbol without a slash'} | ${['exchange', 'marketData', 0, 'symbol']} | ${'BTCUSDT'}                      | ${{ path: ['exchange', 'marketData', 0, 'symbol'], message: 'Symbol must contain a slash' }}
        ${'a lowercase marketData symbol'}       | ${['exchange', 'marketData', 0, 'symbol']} | ${'btc/usdt'}                     | ${{ path: ['exchange', 'marketData', 0, 'symbol'], message: malformedSymbolMessage('btc/usdt') }}
      `('reports $scenario as the only issue', ({ path, value, issue }) => {
        const result = configurationSchema.safeParse(set(cloneDeep(coveredConfig), path, value));
        expect(result.error?.issues).toMatchObject([issue]);
      });

      it('reports both the watch issue and the mode issue of a realtime dummy-cex config', () => {
        const result = configurationSchema.safeParse({
          ...coveredConfig,
          watch: { ...coveredConfig.watch, mode: 'realtime', tickrate: 50 },
        });
        expect(result.error?.issues).toMatchObject([
          { path: ['watch', 'tickrate'], message: 'tickrate must be an integer of at least 100' },
          {
            path: ['exchange', 'name'],
            message: 'Exchange dummy-cex cannot be used in realtime mode (allowed: binance, hyperliquid, paper-binance)',
          },
        ]);
      });
    });
  });

  describe('strategy name', () => {
    const emaRibbon = { name: 'EMARibbon', src: 'close', count: 7 };
    const createStrategyConfig = (plugins: object[], strategy?: object) => ({
      ...createBaseConfig(),
      plugins,
      storage: sqliteStorage,
      ...(strategy && { strategy }),
    });
    const mismatchIssue = (name: string, strategyName: string) => ({
      path: ['strategy', 'name'],
      message: `strategy.name '${name}' must equal the TradingAdvisor strategyName '${strategyName}', which selects the strategy class`,
    });

    it.each`
      scenario                  | plugins
      ${'the only plugin'}      | ${[{ name: 'TradingAdvisor', strategyName: 'SMACrossover' }]}
      ${'not the first plugin'} | ${[{ name: 'CandleWriter' }, { name: 'TradingAdvisor', strategyName: 'SMACrossover' }]}
    `('reports a strategy.name that differs from the strategyName of a TradingAdvisor that is $scenario', ({ plugins }) => {
      const result = configurationSchema.safeParse(createStrategyConfig(plugins, emaRibbon));
      expect(result.error?.issues).toMatchObject([mismatchIssue('EMARibbon', 'SMACrossover')]);
    });

    // A strategyName that is not a string is reported by the TradingAdvisor schema, when the pipeline parses the plugins.
    it.each`
      scenario                                    | plugins                                                              | strategy
      ${'the two names are equal'}                | ${[{ name: 'TradingAdvisor', strategyName: 'EMARibbon' }]}           | ${emaRibbon}
      ${'there is no strategy block'}             | ${[{ name: 'TradingAdvisor', strategyName: 'SMACrossover' }]}        | ${undefined}
      ${'there is no TradingAdvisor plugin'}      | ${[{ name: 'Trader' }]}                                              | ${emaRibbon}
      ${'the TradingAdvisor has no strategyName'} | ${[{ name: 'TradingAdvisor' }]}                                      | ${emaRibbon}
      ${'the strategyName is a number'}           | ${[{ name: 'TradingAdvisor', strategyName: 1000 }]}                  | ${emaRibbon}
      ${'the strategyName is null'}               | ${[{ name: 'TradingAdvisor', strategyName: null }]}                  | ${emaRibbon}
      ${'the strategyName is an object'}          | ${[{ name: 'TradingAdvisor', strategyName: { name: 'EMARibbon' } }]} | ${emaRibbon}
    `('reports no issue when $scenario', ({ plugins, strategy }) => {
      const result = configurationSchema.safeParse(createStrategyConfig(plugins, strategy));
      expect(result.error?.issues).toBeUndefined();
    });
  });

  // The warmup takes warmup.candleCount timeframe candles and the strategy trades from the next one. A backtest whose range held no
  // more ended normally, without a trade. The candles are counted as the batcher makes them from the minutes the backtest reads: from a
  // timeframe boundary (2024-01-01 is a Monday), whole ones only, the seconds of the range dropped.
  describe('warmup of a backtest', () => {
    const tradingAdvisor = [{ name: 'TradingAdvisor', strategyName: 'DEMA' }];
    const dummyExchange = {
      name: 'dummy-cex',
      simulationBalance: [{ assetName: 'USDT', balance: 1000 }],
      marketData: [marketDataEntry('BTC/USDT')],
    };
    const createWarmupConfig = (
      timeframe: string,
      candleCount: number,
      start: string,
      end: string,
      { mode = 'backtest', plugins = tradingAdvisor }: { mode?: string; plugins?: object[] } = {},
    ) => ({
      ...createBaseConfig(),
      watch: { ...createBaseConfig().watch, mode, timeframe, warmup: { candleCount }, daterange: { start, end } },
      exchange: mode === 'backtest' ? dummyExchange : createBaseConfig().exchange,
      storage: sqliteStorage,
      plugins,
    });

    it.each`
      scenario                                                      | timeframe | candleCount | start                     | end                       | held  | first                         | lastMinuteNeeded
      ${'exactly warmup.candleCount candles'}                       | ${'1m'}   | ${10}       | ${'2024-01-01T00:00:00Z'} | ${'2024-01-01T00:09:00Z'} | ${10} | ${'2024-01-01T00:00:00.000Z'} | ${'2024-01-01T00:10:00.000Z'}
      ${'the minutes before the first boundary, which are skipped'} | ${'1h'}   | ${2}        | ${'2024-01-01T00:30:00Z'} | ${'2024-01-01T03:58:00Z'} | ${2}  | ${'2024-01-01T01:00:00.000Z'} | ${'2024-01-01T03:59:00.000Z'}
      ${'no whole candle, without warmup'}                          | ${'1d'}   | ${0}        | ${'2024-01-01T10:00:00Z'} | ${'2024-01-01T20:00:00Z'} | ${0}  | ${'2024-01-02T00:00:00.000Z'} | ${'2024-01-02T23:59:00.000Z'}
      ${'weeks, which start on Monday'}                             | ${'1w'}   | ${1}        | ${'2024-01-03T00:00:00Z'} | ${'2024-01-14T23:59:00Z'} | ${1}  | ${'2024-01-08T00:00:00.000Z'} | ${'2024-01-21T23:59:00.000Z'}
      ${'calendar months, a 29-day February included'}              | ${'1M'}   | ${1}        | ${'2024-01-15T00:00:00Z'} | ${'2024-03-31T23:58:00Z'} | ${1}  | ${'2024-02-01T00:00:00.000Z'} | ${'2024-03-31T23:59:00.000Z'}
      ${'361 days, a year not over yet'}                            | ${'1y'}   | ${0}        | ${'2023-01-01T00:00:00Z'} | ${'2023-12-27T23:59:00Z'} | ${0}  | ${'2023-01-01T00:00:00.000Z'} | ${'2023-12-31T23:59:00.000Z'}
      ${'seconds, which the backtest drops'}                        | ${'1m'}   | ${2}        | ${'2024-01-01T00:00:30Z'} | ${'2024-01-01T00:01:59Z'} | ${2}  | ${'2024-01-01T00:00:00.000Z'} | ${'2024-01-01T00:02:00.000Z'}
      ${'an end before the start'}                                  | ${'1d'}   | ${10}       | ${'2024-02-01T00:00:00Z'} | ${'2024-01-01T00:00:00Z'} | ${0}  | ${'2024-02-01T00:00:00.000Z'} | ${'2024-02-11T23:59:00.000Z'}
    `(
      'refuses a range of $timeframe candles with $scenario, saying where it must end',
      ({ timeframe, candleCount, start, end, held, first, lastMinuteNeeded }) => {
        const result = configurationSchema.safeParse(createWarmupConfig(timeframe, candleCount, start, end));
        expect(result.error?.issues).toMatchObject([
          {
            path: ['watch', 'daterange'],
            message: `watch.daterange must hold more whole ${timeframe} candles than warmup.candleCount (${candleCount}), or the warmup never ends and the strategy never trades: it holds ${held} from ${first}, its first ${timeframe} boundary, so it must end at ${lastMinuteNeeded} or later`,
          },
        ]);
      },
    );

    // One candle more than the warmup, each range ending on the last minute the refusal above asks for
    it.each`
      scenario                                                      | timeframe | candleCount | start                     | end
      ${'one candle more than warmup.candleCount'}                  | ${'1m'}   | ${10}       | ${'2024-01-01T00:00:00Z'} | ${'2024-01-01T00:10:00Z'}
      ${'the minutes before the first boundary, which are skipped'} | ${'1h'}   | ${2}        | ${'2024-01-01T00:30:00Z'} | ${'2024-01-01T03:59:00Z'}
      ${'one whole candle, without warmup'}                         | ${'1d'}   | ${0}        | ${'2024-01-01T10:00:00Z'} | ${'2024-01-02T23:59:00Z'}
      ${'weeks, which start on Monday'}                             | ${'1w'}   | ${1}        | ${'2024-01-03T00:00:00Z'} | ${'2024-01-21T23:59:00Z'}
      ${'calendar months, a 29-day February included'}              | ${'1M'}   | ${1}        | ${'2024-01-15T00:00:00Z'} | ${'2024-03-31T23:59:00Z'}
      ${'a 28-day February, a whole month'}                         | ${'1M'}   | ${0}        | ${'2023-02-01T00:00:00Z'} | ${'2023-02-28T23:59:00Z'}
      ${'seconds, which the backtest drops'}                        | ${'1m'}   | ${2}        | ${'2024-01-01T00:00:30Z'} | ${'2024-01-01T00:02:00Z'}
    `('accepts a range of $timeframe candles with $scenario', ({ timeframe, candleCount, start, end }) => {
      const result = configurationSchema.safeParse(createWarmupConfig(timeframe, candleCount, start, end));
      expect(result.error?.issues).toBeUndefined();
    });

    // In realtime the warmup candles are history fetched before the live ones, whatever the range; a backtest without a strategy has no
    // warmup to complete
    it.each`
      scenario                              | options
      ${'in realtime mode'}                 | ${{ mode: 'realtime' }}
      ${'in a backtest without a strategy'} | ${{ plugins: [{ name: 'RoundTripAnalyzer' }] }}
    `('does not count the candles of the range $scenario', ({ options }) => {
      const result = configurationSchema.safeParse(createWarmupConfig('1d', 10, '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', options));
      expect(result.error?.issues).toBeUndefined();
    });

    // A range of exactly warmup.candleCount candles, which a section issue leaves unreported, as with the marketData rule: zod leaves a
    // range with an issue as written, not in epoch milliseconds
    it.each`
      scenario                            | path                     | value
      ${'a tickrate below 100'}           | ${['watch', 'tickrate']} | ${50}
      ${'an asset equal to the currency'} | ${['watch', 'assets']}   | ${['USDT']}
    `('stands down when a section has an issue: $scenario', ({ path, value }) => {
      const config = set(createWarmupConfig('1m', 10, '2024-01-01T00:00:00Z', '2024-01-01T00:09:00Z'), path, value);
      expect(configurationSchema.safeParse(config).error?.issues.map(issue => issue.path)).toEqual([path]);
    });
  });
});
