import { ONE_MINUTE } from '@constants/time.const';
import type { SQLiteStorage } from '@services/storage/sqlite.storage';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { range } from 'lodash-es';
import { generateSyntheticCandle } from '../../fixtures/syntheticData';
import { startFakeClock } from '../../helpers/clock.helper';
import { mockConfiguration } from '../../helpers/configuration.helper';
import { readCandles } from '../../helpers/database.helper';
import { endRealtimeRun, mockRealtimeModules, runRealtimeFor } from '../../helpers/realtimeRun.helper';
import { createCcxtModuleMock, MockCCXTExchange } from '../../mocks/ccxt.mock';
import { clearLogs } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

/**
 * A ccxt hyperliquid client: the mock's binance one, on a spot market of Hyperliquid, which records how it was built and what it was
 * asked. ccxt learns the wrapped spot tokens (UBTC for BTC) from Hyperliquid's token list as it loads the markets, into its options.
 */
class MockHyperliquid extends MockCCXTExchange {
  /** Every client built, in the order they were: CCXTExchange builds a public one, then a private one */
  static clients: MockHyperliquid[] = [];

  readonly config: unknown;
  /** The calls each client got, oldest first, with their arguments: the client given to setMarketsFromExchange by its index */
  readonly calls: unknown[][] = [];
  public id = 'hyperliquid';
  public name = 'hyperliquid';
  public markets = {
    'BTC/USDC': {
      symbol: 'BTC/USDC',
      base: 'BTC',
      quote: 'USDC',
      baseName: 'UBTC',
      maker: 0.0004,
      taker: 0.0007,
      limits: {
        price: { min: 0, max: 1000000 },
        amount: { min: 0.00001, max: 1000 },
        cost: { min: 10, max: 1000000 },
        market: { min: 0, max: 1000 },
      },
      precision: { price: 1, amount: 0.00001 },
    },
  };

  constructor(config: unknown) {
    super(config);
    this.config = config;
    MockHyperliquid.clients.push(this);
  }

  async loadMarkets() {
    this.calls.push(['loadMarkets']);
    this.options.spotCurrencyMapping = { UBTC: 'BTC' };
    return super.loadMarkets();
  }

  setMarketsFromExchange(source: MockCCXTExchange) {
    this.calls.push(['setMarketsFromExchange', MockHyperliquid.clients.findIndex(client => client === source)]);
    return super.setMarketsFromExchange(source);
  }

  async fetchOHLCV(symbol: string, timeframe: string, since?: number, limit?: number) {
    this.calls.push(['fetchOHLCV', symbol, timeframe, since, limit]);
    return super.fetchOHLCV(symbol, timeframe, since, limit);
  }

  async fetchOpenOrders(symbol: string) {
    this.calls.push(['fetchOpenOrders', symbol]);
    return super.fetchOpenOrders(symbol);
  }

  async fetchBalance(params?: unknown) {
    this.calls.push(['fetchBalance', params]);
    return super.fetchBalance();
  }
}

// 1. Mock winston, ccxt and the fetcher. Each test runs on real minutes under the fake clock, from 12:00:30, and ends its run before
// the next test starts (see realtimeRun.helper)
mockRealtimeModules();
// Then ccxt again, with the hyperliquid client beside the binance one: the mock module holds binance alone
mock.module('ccxt', () => {
  const ccxt = createCcxtModuleMock();
  return { ...ccxt, hyperliquid: MockHyperliquid, default: { ...ccxt.default, hyperliquid: MockHyperliquid } };
});

// 2. Mock Configuration: the candles of BTC/USDC on Hyperliquid, written by a CandleWriter, for a TradingAdvisor that reads the account
// at walletAddress, after a warmup of two candles
const WALLET_ADDRESS = '0x00000000000000000000000000000000000000aa';
mockConfiguration({
  watch: { mode: 'realtime', assets: ['BTC'], currency: 'USDC', timeframe: '1m', warmup: { candleCount: 2, tickrate: 100 } },
  exchange: { name: 'hyperliquid', walletAddress: WALLET_ADDRESS },
  storage: { type: 'sqlite', database: ':memory:' },
  plugins: [{ name: 'TradingAdvisor', strategyName: 'DebugRealtime' }, { name: 'CandleWriter' }],
  strategy: { name: 'DebugRealtime' },
});

// --------------------------------------------------------------------------
// HELPERS
// --------------------------------------------------------------------------

/** The start of the minute hh:mm of the day the runs start on, 2024-01-01 (see REALTIME_START) */
const minute = (hours: number, minutes: number) => Date.UTC(2024, 0, 1, hours, minutes);

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Realtime on Hyperliquid', () => {
  beforeEach(async () => {
    const { inject } = await import('@services/injecter/injecter');
    inject.reset();
    clearLogs();
    MockCCXTExchange.reset();
    MockHyperliquid.clients = [];
    startFakeClock();
  });

  // A realtime run never ends by itself: each test ends its own, plugins finalised, before the next one starts
  afterEach(() => endRealtimeRun());

  it('Scenario A: two clients without the builder fee, the candles read by the public one, the account by the private one', async () => {
    const { inject } = await import('@services/injecter/injecter');
    const storage = inject.storage() as SQLiteStorage;
    // Kept open once the run is over, for the scenario to read what it holds
    storage.close = () => {};

    // To 12:02:30: the warmup history at start-up, then the ticks of 12:01:02 and 12:02:02
    await runRealtimeFor({ minutes: 2 });

    // createExchange builds a public client, which a proxy would route, and a private one with the keys, both with ccxt's retries off,
    // the spot markets alone, and no builder fee: on, ccxt would sign an approval of a fee to its own address before the first order,
    // then add 1 bp to every order. The warmup history asks for 5000 candles a page, Hyperliquid's most; the live streams for the
    // minutes closed since the last tick
    const options = { fetchMarkets: { types: ['spot'] }, maxRetriesOnFailure: 0, builderFee: false };
    expect({
      clients: MockHyperliquid.clients.map(({ config, calls }) => ({ config, calls })),
      privateClientOptions: MockHyperliquid.clients[1]?.options,
      stored: readCandles(storage, 'BTC/USDC'),
    }).toEqual({
      clients: [
        {
          config: { verbose: false, sandbox: false, agent: undefined, options },
          calls: [
            ['loadMarkets'],
            ['fetchOHLCV', 'BTC/USDC', '1m', minute(11, 58), 5000],
            ['fetchOHLCV', 'BTC/USDC', '1m', minute(12, 0), 1],
            ['fetchOHLCV', 'BTC/USDC', '1m', minute(12, 1), 1],
          ],
        },
        {
          config: { verbose: false, sandbox: false, privateKey: undefined, walletAddress: WALLET_ADDRESS, options },
          // The markets the public client loaded, shared rather than downloaded again; then the TradingAdvisor's start-up reads of the
          // orders open on the pair and of the spot balance, at walletAddress
          calls: [
            ['setMarketsFromExchange', 0],
            ['fetchOpenOrders', 'BTC/USDC'],
            ['fetchBalance', { type: 'spot' }],
          ],
        },
      ],
      // The mapping of the wrapped spot tokens the public client learned, which the private one reads to key the balance
      privateClientOptions: { spotCurrencyMapping: { UBTC: 'BTC' } },
      // The two warmup minutes, 11:58 and 11:59, then the live ones, 12:00 and 12:01, as the exchange served them
      stored: range(4).map(index => generateSyntheticCandle('BTC/USDC', minute(11, 58) + index * ONE_MINUTE)),
    });
  });
});
