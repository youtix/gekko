import { configurationSchema } from '../configuration/configuration.schema';
import { cloneDeep, get, omit, set } from 'lodash-es';
import { describe, expect, it } from 'vitest';
import { dummyExchangeSchema } from './dummyCentralizedExchange.schema';

const MARKET_DATA = {
  price: { min: 0.01, max: 1_000_000 },
  amount: { min: 0.00001, max: 9000 },
  cost: { min: 5, max: 9_000_000 },
  precision: { price: 2, amount: 5 },
  fee: { maker: 0.0004, taker: 0.0007 },
};

const createConfig = () => ({
  name: 'dummy-cex',
  simulationBalance: [{ assetName: 'USDT', balance: 1000 }],
  marketData: [{ symbol: 'BTC/USDT', marketData: cloneDeep(MARKET_DATA) }],
  initialTicker: [{ symbol: 'BTC/USDT', ticker: { bid: 99, ask: 100 } }],
});

/** The configuration with `value` set at `path` in the marketData entry of BTC/USDT */
const withMarketData = (path: string[], value: unknown) => set(createConfig(), ['marketData', 0, 'marketData', ...path], value);
const withTicker = (ticker: Record<string, unknown>) => set(createConfig(), ['initialTicker', 0, 'ticker'], ticker);
/** The configuration with its `field` list holding its entry, then a copy of it with `value` set at `path` */
const withRepeatedEntry = (field: 'simulationBalance' | 'marketData' | 'initialTicker', path: string[], value: unknown) => {
  const config = createConfig();
  const [entry] = config[field];
  return { ...config, [field]: [entry, set(cloneDeep(entry), path, value)] };
};

const feeMessage = (field: string) => `${field} must be a fraction between 0 and 1 (0.001 is a 0.1 % fee)`;
const precisionMessage = (field: string) => `${field} must be a whole number of decimals of at least 0, not a step (2 for a step of 0.01)`;
const significantDigitsMessage =
  'precision.priceSignificantDigits must be a whole number of at least 1 (5 on Hyperliquid), ' +
  'left out for a tick that does not depend on the price';

describe('dummyExchangeSchema', () => {
  it('maps each marketData entry to its symbol, its precision turned from decimals into steps', () => {
    expect(dummyExchangeSchema.parse(createConfig()).marketData).toEqual(
      new Map([['BTC/USDT', { ...MARKET_DATA, precision: { price: 0.01, amount: 0.00001 } }]]),
    );
  });

  it('maps each initial ticker to its symbol', () => {
    expect(dummyExchangeSchema.parse(createConfig()).initialTicker).toEqual(new Map([['BTC/USDT', { bid: 99, ask: 100 }]]));
  });

  it.each`
    field
    ${'marketData'}
    ${'initialTicker'}
  `('defaults $field to an empty map', ({ field }) => {
    const result = dummyExchangeSchema.parse(omit(createConfig(), field));
    expect(result[field as 'marketData' | 'initialTicker']).toEqual(new Map());
  });

  it('keeps the sync interval bounds shared by every exchange', () => {
    const result = dummyExchangeSchema.safeParse({ ...createConfig(), orderSynchInterval: 0 });
    expect(result.error?.issues).toMatchObject([{ path: ['orderSynchInterval'] }]);
  });

  it.each`
    field
    ${'marketData'}
    ${'initialTicker'}
  `('maps the $field entries of two pairs to their symbols', ({ field }) => {
    const config = createConfig();
    const [entry] = config[field as 'marketData' | 'initialTicker'];
    const result = dummyExchangeSchema.parse({ ...config, [field]: [entry, { ...entry, symbol: 'ETH/USDT' }] });
    expect([...result[field as 'marketData' | 'initialTicker'].keys()]).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  // Read into a Map, a list that repeats a key kept its last entry only, without a word: a second BTC/USDT block with a 1 % taker
  // fee charged that fee on every trade of the backtest, and USDT 1000 then 100 started it with 100 USDT
  it.each`
    field                  | config                                                                   | message
    ${'simulationBalance'} | ${withRepeatedEntry('simulationBalance', ['balance'], 100)}              | ${'simulationBalance must hold one entry per assetName (repeated: USDT)'}
    ${'marketData'}        | ${withRepeatedEntry('marketData', ['marketData', 'fee', 'taker'], 0.01)} | ${'marketData must hold one entry per symbol (repeated: BTC/USDT)'}
    ${'initialTicker'}     | ${withRepeatedEntry('initialTicker', ['ticker', 'bid'], 98)}             | ${'initialTicker must hold one entry per symbol (repeated: BTC/USDT)'}
  `('refuses $field entries that repeat a key with $message', ({ field, config, message }) => {
    expect(dummyExchangeSchema.safeParse(config).error?.issues).toMatchObject([{ path: [field], message }]);
  });

  // An initialTicker entry for a malformed symbol was accepted, then never read: the watched pair started without its ticker
  it.each`
    field              | symbol
    ${'initialTicker'} | ${'BTC/'}
    ${'initialTicker'} | ${' BTC/USDT'}
    ${'initialTicker'} | ${'btc/usdt'}
    ${'marketData'}    | ${'BTC/USDT/ETH'}
  `('refuses the $field symbol $symbol at its entry', ({ field, symbol }) => {
    const result = dummyExchangeSchema.safeParse(set(createConfig(), [field, 0, 'symbol'], symbol));
    expect(result.error?.issues).toMatchObject([
      {
        path: [field, 0, 'symbol'],
        message: `Symbol '${symbol}' must be an asset and a currency in upper-case letters and digits, joined by one slash, as in BTC/USDT`,
      },
    ]);
  });

  // Dropped, a misspelt key would leave its default in place: a misspelt max, for one, would leave the range without a maximum
  it.each`
    level                       | path                                            | key
    ${'the exchange'}           | ${[]}                                           | ${'marketdata'}
    ${'a marketData entry'}     | ${['marketData', 0]}                            | ${'fees'}
    ${'the market data'}        | ${['marketData', 0, 'marketData']}              | ${'maker'}
    ${'a limit range'}          | ${['marketData', 0, 'marketData', 'price']}     | ${'maximum'}
    ${'a market order range'}   | ${['marketData', 0, 'marketData', 'market']}    | ${'maxQty'}
    ${'the precision'}          | ${['marketData', 0, 'marketData', 'precision']} | ${'cost'}
    ${'the fees'}               | ${['marketData', 0, 'marketData', 'fee']}       | ${'tierBased'}
    ${'an initialTicker entry'} | ${['initialTicker', 0]}                         | ${'last'}
    ${'a ticker'}               | ${['initialTicker', 0, 'ticker']}               | ${'last'}
  `('refuses an unknown key ($key) in $level instead of dropping it', ({ path, key }) => {
    const result = dummyExchangeSchema.safeParse(set(createConfig(), [...path, key], 1));
    expect(result.error?.issues).toMatchObject([{ code: 'unrecognized_keys', path, keys: [key] }]);
  });

  describe('marketData', () => {
    // A negative max is reported once: the min ≤ max refinement, which zod still runs after the failed bound, skips it.
    it.each`
      path                                       | value      | message
      ${['price', 'min']}                        | ${-1}      | ${'price.min must be a number of at least 0'}
      ${['price', 'max']}                        | ${-1}      | ${'price.max must be a number of at least 0'}
      ${['amount', 'min']}                       | ${-1}      | ${'amount.min must be a number of at least 0'}
      ${['amount', 'max']}                       | ${-1}      | ${'amount.max must be a number of at least 0'}
      ${['cost', 'min']}                         | ${-1}      | ${'cost.min must be a number of at least 0'}
      ${['cost', 'max']}                         | ${-1}      | ${'cost.max must be a number of at least 0'}
      ${['cost', 'min']}                         | ${'5'}     | ${'cost.min must be a number of at least 0'}
      ${['price', 'min']}                        | ${NaN}     | ${'price.min must be a number of at least 0'}
      ${['market', 'min']}                       | ${-1}      | ${'market.min must be a number of at least 0'}
      ${['market', 'max']}                       | ${-1}      | ${'market.max must be a number of at least 0'}
      ${['market', 'max']}                       | ${'100'}   | ${'market.max must be a number of at least 0'}
      ${['precision', 'price']}                  | ${-2}      | ${precisionMessage('precision.price')}
      ${['precision', 'amount']}                 | ${-2}      | ${precisionMessage('precision.amount')}
      ${['precision', 'price']}                  | ${0.01}    | ${precisionMessage('precision.price')}
      ${['precision', 'amount']}                 | ${0.00001} | ${precisionMessage('precision.amount')}
      ${['precision', 'amount']}                 | ${'8'}     | ${precisionMessage('precision.amount')}
      ${['precision', 'priceSignificantDigits']} | ${0}       | ${significantDigitsMessage}
      ${['precision', 'priceSignificantDigits']} | ${2.5}     | ${significantDigitsMessage}
      ${['precision', 'priceSignificantDigits']} | ${'5'}     | ${significantDigitsMessage}
      ${['fee', 'maker']}                        | ${1.5}     | ${feeMessage('fee.maker')}
      ${['fee', 'maker']}                        | ${-0.1}    | ${feeMessage('fee.maker')}
      ${['fee', 'taker']}                        | ${1.5}     | ${feeMessage('fee.taker')}
      ${['fee', 'taker']}                        | ${-0.1}    | ${feeMessage('fee.taker')}
      ${['fee', 'taker']}                        | ${'0.1%'}  | ${feeMessage('fee.taker')}
    `('reports $value at $path as its only issue', ({ path, value, message }) => {
      const result = dummyExchangeSchema.safeParse(withMarketData(path, value));
      expect(result.error?.issues).toMatchObject([{ path: ['marketData', 0, 'marketData', ...path], message }]);
    });

    it.each`
      range
      ${'price'}
      ${'amount'}
      ${'cost'}
      ${'market'}
    `('rejects a $range min above its max', ({ range }) => {
      const result = dummyExchangeSchema.safeParse(withMarketData([range], { min: 10, max: 5 }));
      expect(result.error?.issues).toMatchObject([
        {
          path: ['marketData', 0, 'marketData', range],
          message: `${range}.min must not exceed ${range}.max (leave max out for no maximum)`,
        },
      ]);
    });

    describe.each`
      range
      ${'price'}
      ${'amount'}
      ${'cost'}
      ${'market'}
    `('$range', ({ range }) => {
      it.each`
        scenario                             | limits
        ${'a max of 0, which sets no limit'} | ${{ min: 10, max: 0 }}
        ${'a max left out'}                  | ${{ min: 10 }}
        ${'a min equal to its max'}          | ${{ min: 5, max: 5 }}
        ${'a min of 0'}                      | ${{ min: 0, max: 5 }}
      `('accepts $scenario', ({ limits }) => {
        const result = dummyExchangeSchema.parse(withMarketData([range], limits));
        expect(get(result.marketData.get('BTC/USDT'), range)).toEqual(limits);
      });
    });

    // The amounts of a market order may leave either bound out, as MarketData states them: Binance leaves the minimum at 0
    it.each`
      scenario           | market
      ${'a max alone'}   | ${{ max: 86.27382215 }}
      ${'a min alone'}   | ${{ min: 0.001 }}
      ${'neither bound'} | ${{}}
    `('hands on a market range of $scenario as it is', ({ market }) => {
      const result = dummyExchangeSchema.parse(withMarketData(['market'], market));
      expect(result.marketData.get('BTC/USDT')?.market).toStrictEqual(market);
    });

    // Without one, a MARKET order takes the amount range (see getMarketOrderLimits)
    it('leaves market out of the market data when the configuration does', () => {
      const result = dummyExchangeSchema.parse(createConfig());
      expect(result.marketData.get('BTC/USDT')).not.toHaveProperty('market');
    });

    // Configured in decimals, a precision is handed on as the step MarketData.precision holds in every mode, as ccxt gives it
    it.each`
      path                       | decimals | step
      ${['precision', 'price']}  | ${2}     | ${0.01}
      ${['precision', 'amount']} | ${5}     | ${0.00001}
      ${['precision', 'price']}  | ${8}     | ${0.00000001}
      ${['precision', 'amount']} | ${8}     | ${0.00000001}
      ${['precision', 'price']}  | ${0}     | ${1}
      ${['precision', 'amount']} | ${0}     | ${1}
    `('turns $decimals decimals at $path into a step of $step', ({ path, decimals, step }) => {
      const result = dummyExchangeSchema.parse(withMarketData(path, decimals));
      expect(get(result.marketData.get('BTC/USDT'), path)).toBe(step);
    });

    // Hyperliquid's rule, for a backtest to rehearse it: a count of digits, not decimals, handed on as MarketData states it
    it.each`
      digits
      ${5}
      ${1}
    `('hands precision.priceSignificantDigits of $digits on as it is', ({ digits }) => {
      const result = dummyExchangeSchema.parse(withMarketData(['precision', 'priceSignificantDigits'], digits));
      expect(result.marketData.get('BTC/USDT')?.precision?.priceSignificantDigits).toBe(digits);
    });

    it('leaves precision.priceSignificantDigits out of the market data when the configuration does', () => {
      const result = dummyExchangeSchema.parse(createConfig());
      expect(result.marketData.get('BTC/USDT')?.precision).not.toHaveProperty('priceSignificantDigits');
    });

    it.each`
      path                | value
      ${['fee', 'maker']} | ${0}
      ${['fee', 'maker']} | ${1}
      ${['fee', 'taker']} | ${0}
      ${['fee', 'taker']} | ${1}
    `('accepts $value at $path, a bound of its range', ({ path, value }) => {
      const result = dummyExchangeSchema.parse(withMarketData(path, value));
      expect(get(result.marketData.get('BTC/USDT'), path)).toBe(value);
    });
  });

  describe('initialTicker', () => {
    // A bid above an ask of 0 or below is reported once: the bid ≤ ask refinement, which zod still runs after the failed
    // bound, skips it.
    it.each`
      scenario                    | ticker                     | issue
      ${'a bid above the ask'}    | ${{ bid: 101, ask: 100 }}  | ${{ path: ['initialTicker', 0, 'ticker'], message: 'ticker.bid must not exceed ticker.ask' }}
      ${'a bid of 0'}             | ${{ bid: 0, ask: 100 }}    | ${{ path: ['initialTicker', 0, 'ticker', 'bid'], message: 'ticker.bid must be a number greater than 0' }}
      ${'a negative bid'}         | ${{ bid: -1, ask: 100 }}   | ${{ path: ['initialTicker', 0, 'ticker', 'bid'], message: 'ticker.bid must be a number greater than 0' }}
      ${'an ask of 0'}            | ${{ bid: 99, ask: 0 }}     | ${{ path: ['initialTicker', 0, 'ticker', 'ask'], message: 'ticker.ask must be a number greater than 0' }}
      ${'a negative ask'}         | ${{ bid: 99, ask: -1 }}    | ${{ path: ['initialTicker', 0, 'ticker', 'ask'], message: 'ticker.ask must be a number greater than 0' }}
      ${'an ask given as a text'} | ${{ bid: 99, ask: '100' }} | ${{ path: ['initialTicker', 0, 'ticker', 'ask'], message: 'ticker.ask must be a number greater than 0' }}
    `('reports $scenario as the only issue', ({ ticker, issue }) => {
      const result = dummyExchangeSchema.safeParse(withTicker(ticker));
      expect(result.error?.issues).toMatchObject([issue]);
    });

    it('accepts a bid equal to the ask', () => {
      const result = dummyExchangeSchema.parse(withTicker({ bid: 100, ask: 100 }));
      expect(result.initialTicker.get('BTC/USDT')).toEqual({ bid: 100, ask: 100 });
    });
  });

  // Zod still runs the configuration's refinement after these issues, with the Map of the list at fault left unbuilt: the
  // refinement must neither throw nor add an issue of its own.
  describe('in a backtest configuration', () => {
    const createBacktestConfig = (exchange: object) => ({
      watch: {
        assets: ['BTC'],
        currency: 'USDT',
        timeframe: '1m',
        mode: 'backtest',
        daterange: { start: '2023-01-01T00:00:00.000Z', end: '2023-01-02T00:00:00.000Z' },
      },
      exchange,
      storage: { type: 'sqlite', database: 'db/candles.sql' },
      plugins: [],
    });

    it('accepts a valid exchange', () => {
      const result = configurationSchema.safeParse(createBacktestConfig(createConfig()));
      expect(result.error?.issues).toBeUndefined();
    });

    it.each`
      scenario                          | exchange                                                                 | path
      ${'a negative max'}               | ${withMarketData(['price', 'max'], -1)}                                  | ${['exchange', 'marketData', 0, 'marketData', 'price', 'max']}
      ${'a min above its max'}          | ${withMarketData(['cost'], { min: 10, max: 5 })}                         | ${['exchange', 'marketData', 0, 'marketData', 'cost']}
      ${'a market min above its max'}   | ${withMarketData(['market'], { min: 10, max: 5 })}                       | ${['exchange', 'marketData', 0, 'marketData', 'market']}
      ${'a fee of 150 %'}               | ${withMarketData(['fee', 'taker'], 1.5)}                                 | ${['exchange', 'marketData', 0, 'marketData', 'fee', 'taker']}
      ${'a precision given as a step'}  | ${withMarketData(['precision', 'price'], 0.01)}                          | ${['exchange', 'marketData', 0, 'marketData', 'precision', 'price']}
      ${'a bid above the ask'}          | ${withTicker({ bid: 101, ask: 100 })}                                    | ${['exchange', 'initialTicker', 0, 'ticker']}
      ${'an interval of 0'}             | ${{ ...createConfig(), exchangeSynchInterval: 0 }}                       | ${['exchange', 'exchangeSynchInterval']}
      ${'a repeated balance asset'}     | ${withRepeatedEntry('simulationBalance', ['balance'], 100)}              | ${['exchange', 'simulationBalance']}
      ${'a repeated marketData symbol'} | ${withRepeatedEntry('marketData', ['marketData', 'fee', 'taker'], 0.01)} | ${['exchange', 'marketData']}
      ${'a repeated ticker symbol'}     | ${withRepeatedEntry('initialTicker', ['ticker', 'bid'], 98)}             | ${['exchange', 'initialTicker']}
      ${'a malformed ticker symbol'}    | ${set(createConfig(), ['initialTicker', 0, 'symbol'], 'BTC/')}           | ${['exchange', 'initialTicker', 0, 'symbol']}
    `('reports $scenario as the only issue', ({ exchange, path }) => {
      const result = configurationSchema.safeParse(createBacktestConfig(exchange));
      expect(result.error?.issues).toMatchObject([{ path }]);
    });
  });
});
