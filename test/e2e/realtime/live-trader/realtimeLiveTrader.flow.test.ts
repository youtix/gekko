import { ONE_MINUTE } from '@constants/time.const';
import type { debugOrderScriptStrategySchema } from '@strategies/debug/debugOrderScript.schema';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import { startFakeClock } from '../../helpers/clock.helper';
import { mockConfiguration, type RawConfiguration } from '../../helpers/configuration.helper';
import {
  endRealtimeRun,
  mockRealtimeModules,
  runRealtimeUntil,
  runRealtimeUntilEnd,
  startRealtimeRun,
} from '../../helpers/realtimeRun.helper';
import { MockCCXTExchange, type AccountCall, type BalanceEntry, type CreationFault } from '../../mocks/ccxt.mock';
import { clearLogs, findLoggedObject, findTextLine, isTextLine, logStore, type TextLine } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// 1. Mock winston, ccxt and the fetcher. Each test runs on real minutes under the fake clock, and ends its run before the next test
// starts (see realtimeRun.helper). The paper flows send their orders to the simulator of paper-binance: this one sends them through
// CCXTExchange to ccxt, whose mock keeps the book and the balances of the account as Binance does (see MockCCXTExchange.createOrder)
mockRealtimeModules();
// The lines the flow reads are at info and above, the strategy's included
process.env.GEKKO_LOG_LEVEL = 'info';

const DISCLAIMER = 'I understand that Gekko only automates MY OWN trading strategies';

type BinanceExchange = Extract<RawConfiguration['exchange'], { name: 'binance' }>;
type StrategyBlock = NonNullable<RawConfiguration['strategy']>;

/** Binance's testnet, on which a Trader needs no disclaimer: its orders spend no real money */
const TESTNET: BinanceExchange = { name: 'binance', sandbox: true, apiKey: 'testnet-key', secret: 'testnet-secret' };

// 2. Mock Configuration
let exchange: BinanceExchange;
let isDisclaimerAccepted: boolean | undefined;
let strategy: StrategyBlock;
mockConfiguration(() => ({
  watch: { mode: 'realtime', assets: ['BTC'], currency: 'USDT', timeframe: '1m', tickrate: 100, warmup: { candleCount: 0 } },
  exchange,
  plugins: [{ name: 'TradingAdvisor', strategyName: strategy.name }, { name: 'Trader' }, { name: 'RoundTripAnalyzer' }],
  strategy,
  ...(isDisclaimerAccepted !== undefined && { [DISCLAIMER]: isDisclaimerAccepted }),
}));

/** The block of DebugOrderScript, which creates these orders on their candles, counted from 0, and logs what each one comes to */
const script = (orders: z.input<typeof debugOrderScriptStrategySchema>['orders']): StrategyBlock => ({ name: 'DebugOrderScript', orders });

/**
 * A time of the run, on 2024-01-01 (see REALTIME_START): the pipeline starts at 12:00:30, the Heart fetches minute 12:00 at 12:01:02, the
 * grace period after its end, then one minute a minute; an order the Trader places with a bucket is created then, and polled every 20 s
 * from then on (the default orderSynchInterval)
 */
const at = (time: string) => Date.parse(`2024-01-01T${time}.000Z`);

const ORDER_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * The lines logged as text that `keep` accepts, oldest first, each order id the StrategyManager drew, a random UUID, written #1, #2…
 * in the order the run first logged them: the first order created is #1
 */
const linesOf = (keep: (line: TextLine) => boolean) => {
  const textLines = logStore.filter(isTextLine);
  const numbers = new Map<string, string>();
  for (const { message } of textLines)
    for (const [id] of message.matchAll(ORDER_ID)) if (!numbers.has(id)) numbers.set(id, `#${numbers.size + 1}`);
  return textLines
    .map(line => ({ ...line, message: line.message.replace(ORDER_ID, id => numbers.get(id)!) }))
    .filter(keep)
    .map(({ message }) => message);
};

/** What reached the strategy: the lines DebugOrderScript logs of the orders it creates and cancels, and of what each order hook got */
const strategyLines = () => linesOf(({ _tag, message }) => _tag === 'STRATEGY' && message.startsWith('Order '));

/** What the Trader said of each order it placed: its status changes, its fills, its summary or its end */
const traderLines = () => linesOf(({ _tag, message }) => _tag === 'TRADER' && message.startsWith('[#'));

/** Every warning and error of the run, whatever logged it */
const warnings = () => linesOf(({ level }) => level === 'warn' || level === 'error');

/** The orders of the account as the exchange holds them at the end, those Gekko placed and those it did not, without their dates */
const book = () =>
  MockCCXTExchange.getOrders().map(({ id, type, side, price, amount, filled, remaining, status }) => ({
    id,
    type,
    side,
    price,
    amount,
    filled,
    remaining,
    status,
  }));

/** The line the Trader logs as it summarizes a completed order, executed at `time` (see Trader.checkOrderSummary) */
const summaryLine = (order: string, time: string, figures: string) =>
  `${order} order summary for BTC/USDT: Completed at: 2024-01-01T${time}.000Z ${figures}`;

/** The round trip the RoundTripAnalyzer logged as it closed */
const loggedRoundTrip = () => findLoggedObject(message => 'entryAt' in message && 'exitAt' in message);

/** The calls to the account at start-up, before the first candle: the TradingAdvisor's, then the Trader's */
const START_UP_CALLS: AccountCall[] = [
  // TradingAdvisor.processInit: the orders open on the pair, which init gets, then the balance, the strategy's first portfolio
  { method: 'fetchOpenOrders', symbol: 'BTC/USDT' },
  { method: 'fetchBalance' },
  // Trader.processInit: its first synchronization
  { method: 'fetchBalance' },
];

/** The calls to the account before the first order: at 12:01:02, the first candle completes the warmup, and the Trader synchronizes */
const BEFORE_FIRST_ORDER_CALLS: AccountCall[] = [...START_UP_CALLS, { method: 'fetchBalance' }];

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: Realtime Live Trader Flow', () => {
  beforeEach(async () => {
    // Reset inject singletons
    const { inject } = await import('@services/injecter/injecter');
    inject.reset();
    clearLogs();

    // Reset mocks
    MockCCXTExchange.reset();
    exchange = TESTNET;
    isDisclaimerAccepted = undefined;
    startFakeClock();
  });

  // A realtime run never ends by itself: each test ends its own, plugins finalised and orders stopped, before the next one starts
  afterEach(() => endRealtimeRun());

  // bun:test takes no tagged-template table
  it.each<{ title: string; settings: { exchange: BinanceExchange; isDisclaimerAccepted?: boolean }; isSandboxModeEnabled: boolean }>([
    {
      title: 'in sandbox mode, Binance on its testnet, without the disclaimer',
      settings: { exchange: TESTNET },
      isSandboxModeEnabled: true,
    },
    {
      title: 'out of sandbox mode, Binance itself, with the disclaimer',
      settings: { exchange: { name: 'binance', apiKey: 'live-key', secret: 'live-secret' }, isDisclaimerAccepted: true },
      isSandboxModeEnabled: false,
    },
  ])('Scenario S: the two ccxt clients CCXTExchange builds, $title', async ({ settings, isSandboxModeEnabled }) => {
    ({ exchange, isDisclaimerAccepted } = settings);
    strategy = script([{ candle: 0, side: 'BUY', type: 'MARKET' }]);
    // The run is built and its plugins initialised before the clock moves: the clients are built, the start-up calls made
    await startRealtimeRun();

    // createExchange builds the public client, which reads the market data, then the private one, which alone holds the keys, and hands
    // both sandbox, which ccxt's constructor reads: set, it sends the client to the testnet, and checkMandatoryFeatures requires the
    // sandbox feature (has). Both turn ccxt's retries off, Gekko retrying its reads itself, and Binance's quoteOrderQty, which would turn
    // the price sent with a MARKET order into an amount of currency to spend.
    const { sandbox = false, apiKey, secret } = settings.exchange;
    const options = { maxRetriesOnFailure: 0, quoteOrderQty: false };
    const clients = MockCCXTExchange.clients.map(({ userConfig, isSandboxModeEnabled }) => ({ userConfig, isSandboxModeEnabled }));
    expect({ clients, calls: MockCCXTExchange.accountCalls }).toEqual({
      clients: [
        { userConfig: { verbose: false, sandbox, agent: undefined, options }, isSandboxModeEnabled },
        { userConfig: { verbose: false, sandbox, options, apiKey, secret }, isSandboxModeEnabled },
      ],
      calls: START_UP_CALLS,
    });
  });

  /** What befalls the BUY of scenario A, then its SELL */
  type BySide<T> = { buy: T; sell: T };
  it.each<{
    title: string;
    matchesOrdersAtCreation: boolean;
    buyFilledAt: string;
    sellFilledAt: string;
    polls: BySide<AccountCall[]>;
    opened: BySide<string[]>;
    stillOpen: BySide<string[]>;
  }>([
    {
      title: 'answered closed with their fills, as Binance answers a MARKET order',
      matchesOrdersAtCreation: true,
      // Each order fills as it is created: the BUY at 12:01:02, with candle 0's bucket, the SELL at 12:02:02, with candle 1's
      buyFilledAt: '12:01:02',
      sellFilledAt: '12:02:02',
      polls: { buy: [], sell: [] },
      opened: { buy: [], sell: [] },
      stillOpen: { buy: [], sell: [] },
    },
    {
      title: 'answered open, then filled through the polls',
      matchesOrdersAtCreation: false,
      // Each order is created open, then matched at its first poll, 20 s later, at the price of the candle it was created with: the
      // next one comes with the next minute
      buyFilledAt: '12:01:22',
      sellFilledAt: '12:02:22',
      polls: {
        buy: [{ method: 'fetchOrder', id: '1', symbol: 'BTC/USDT' }],
        sell: [{ method: 'fetchOrder', id: '2', symbol: 'BTC/USDT' }],
      },
      opened: { buy: ['[#1] Status changed: OPEN'], sell: ['[#2] Status changed: OPEN'] },
      // MarketOrder warns of a MARKET order still open after its creation, then polls it as it polls a LIMIT order
      stillOpen: {
        buy: ['[#1] BUY MARKET order still open after its creation, unexpected for a market order'],
        sell: ['[#2] SELL MARKET order still open after its creation, unexpected for a market order'],
      },
    },
  ])(
    'Scenario A: a MARKET BUY then a MARKET SELL $title, their fees read from the trades, one round trip',
    async ({ matchesOrdersAtCreation, buyFilledAt, sellFilledAt, polls, opened, stillOpen }) => {
      // A BUY of 1.0000004 on candle 0, which closes at 100, a SELL of 1 on candle 1, at 110, from 10,000 USDT and no BTC
      strategy = script([
        { candle: 0, side: 'BUY', type: 'MARKET', amount: 1.0000004 },
        { candle: 1, side: 'SELL', type: 'MARKET' },
      ]);
      MockCCXTExchange.setBalances({ BTC: 0, USDT: 10000 });
      MockCCXTExchange.matchesOrdersAtCreation = matchesOrdersAtCreation;
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', [{ close: 100 }, { close: 110 }, { close: 120 }, { close: 125 }]);

      // The SELL is reported between the buckets of candles 1 and 2, and heard as candle 2's arrives, at 12:03:02, with the round trip
      await runRealtimeUntil(() => loggedRoundTrip() !== undefined, { maxMinutes: 5 });

      expect({
        calls: MockCCXTExchange.accountCalls,
        trader: traderLines(),
        strategy: strategyLines(),
        warnings: warnings(),
        roundTrip: loggedRoundTrip(),
        balances: MockCCXTExchange.getBalances(),
      }).toEqual({
        calls: [
          ...BEFORE_FIRST_ORDER_CALLS,
          // The BUY of 1.0000004 goes for 1: CCXTExchange truncates an amount to the step of its market, 0.000001, before it sends the
          // order (roundToMarketPrecision). The side goes as Gekko writes it, which ccxt's binance upper-cases, and the ask with a MARKET
          // order, which Binance ignores: the ticker follows the candles served, candle 0's close.
          { method: 'createOrder', symbol: 'BTC/USDT', type: 'market', side: 'BUY', amount: 1, price: 100 },
          ...polls.buy,
          // The summary of the BUY: the trades of the account from the second the order was created in, a page of 1000
          // (LIMITS.binance.trades), then the portfolio after the fill
          { method: 'fetchMyTrades', symbol: 'BTC/USDT', since: at('12:01:02'), limit: 1000 },
          { method: 'fetchBalance' },
          // Binance took the BUY's fee in BTC, out of the 1 BTC bought: the Trader caps the SELL of 1 at the 0.999 BTC free its last
          // synchronization read. Priced at the bid, candle 1's close.
          { method: 'createOrder', symbol: 'BTC/USDT', type: 'market', side: 'SELL', amount: 0.999, price: 110 },
          ...polls.sell,
          { method: 'fetchMyTrades', symbol: 'BTC/USDT', since: at('12:02:02'), limit: 1000 },
          { method: 'fetchBalance' },
        ],
        trader: [
          ...opened.buy,
          '[#1] BUY MARKET order fill, total filled: 1',
          '[#1] Status changed: FILLED',
          // The fee rate comes from the trade, 0.001 BTC on 1 BTC: 0.1 %, and the fee in USDT is 0.1 % of the cost, 100 × 0.001
          summaryLine('[#1] BUY MARKET', buyFilledAt, 'Order amount: 1, Effective price: 100.1, Fee: 0.1, Fee percent: 0.1,'),
          '[#2] SELL MARKET order of 1 BTC above the free balance: 0.999 BTC sent, all that can be sold',
          ...opened.sell,
          '[#2] SELL MARKET order fill, total filled: 0.999',
          '[#2] Status changed: FILLED',
          // 0.10989 USDT on the 109.89 of 0.999 × 110: 0.1 %, and 110 less its 0.1 % is 109.89
          summaryLine('[#2] SELL MARKET', sellFilledAt, 'Order amount: 0.999, Effective price: 109.89, Fee: 0.10989, Fee percent: 0.1,'),
        ],
        // The BUY is reported between the buckets of candles 0 and 1, and heard as candle 1's arrives, before that candle creates the SELL
        strategy: [
          'Order 0 created on candle 0: BUY MARKET of 1.0000004 on BTC/USDT',
          `Order 0 completed: 1 at 100, fee 0.1 (0.1 %), effective price 100.1, executed at 2024-01-01T${buyFilledAt}.000Z`,
          'Order 1 created on candle 1: SELL MARKET of 1 on BTC/USDT',
          `Order 1 completed: 0.999 at 110, fee 0.10989 (0.1 %), effective price 109.89, executed at 2024-01-01T${sellFilledAt}.000Z`,
        ],
        warnings: [
          ...stillOpen.buy,
          '[#2] SELL MARKET order of 1 BTC above the free balance: 0.999 BTC sent, all that can be sold',
          ...stillOpen.sell,
        ],
        roundTrip: {
          id: 0,
          symbol: 'BTC/USDT',
          entryAt: at(buyFilledAt),
          entryPrice: 100,
          // After the BUY the account holds 0.999 BTC and 9,900 USDT, 99.9 + 9,900 at 100, and the fee of 0.1 is given back: 10,000,
          // the equity before the BUY
          entryEquity: 10000,
          exitAt: at(sellFilledAt),
          exitPrice: 110,
          // The SELL of 0.999 at 110 brings 109.89 less its fee of 0.10989: 9,900 + 109.78011 USDT, and no BTC is left
          exitEquity: 10009.78011,
          pnl: 9.78011,
          // 9.78011 / 10,000 × 100
          profit: 0.0978011,
          // The one candle it reads, 12:01's, never falls below the entry price of 100
          maxAdverseExcursion: 0,
          duration: ONE_MINUTE,
        },
        balances: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 10009.78011, used: 0, total: 10009.78011 } },
      });
    },
  );

  it('Scenario B: a resting LIMIT BUY, reported open, filled in part, canceled by the strategy with what it filled', async () => {
    // A LIMIT BUY of 1 at 90.004 on candle 0, under the market of 100: it rests. Candle 1 dips to 89, trading 0.4 BTC down there, and
    // the strategy cancels the order on candle 2 (cancelAfter 2).
    strategy = script([{ candle: 0, side: 'BUY', type: 'LIMIT', price: 90.004, cancelAfter: 2 }]);
    MockCCXTExchange.setBalances({ BTC: 0, USDT: 10000 });
    MockCCXTExchange.setPredefinedCandles('BTC/USDT', [
      { close: 100 },
      { open: 95, low: 89, close: 92, volume: 0.4 },
      { close: 95 },
      { close: 96 },
    ]);

    // Canceled at 12:03:02, the order is reported between two buckets, and heard as the next one arrives, candle 3's at 12:04:02
    await runRealtimeUntil(() => findTextLine('Order 0 canceled:') !== undefined, { maxMinutes: 5 });

    expect({
      calls: MockCCXTExchange.accountCalls,
      trader: traderLines(),
      strategy: strategyLines(),
      warnings: warnings(),
      book: book(),
      balances: MockCCXTExchange.getBalances(),
    }).toEqual({
      calls: [
        ...BEFORE_FIRST_ORDER_CALLS,
        // CCXTExchange rounds the price to the tick of the market, 0.01, a half up, before it sends the order: 90.004 goes as 90,
        // less than half a tick away, without a warning
        { method: 'createOrder', symbol: 'BTC/USDT', type: 'limit', side: 'BUY', amount: 1, price: 90 },
        // Polled every 20 s from its creation at 12:01:02: 12:01:22, 12:01:42, then 12:02:02, after the Heart has fetched candle 1, whose
        // dip fills 0.4 BTC of it at its price, then 12:02:22, 12:02:42 and 12:03:02, after the Heart has fetched candle 2
        ...Array.from({ length: 6 }, (): AccountCall => ({ method: 'fetchOrder', id: '1', symbol: 'BTC/USDT' })),
        // Candle 2, two candles after its creation: the strategy cancels it, and the Trader reads the portfolio the cancelation leaves
        { method: 'cancelOrder', id: '1', symbol: 'BTC/USDT' },
        { method: 'fetchBalance' },
      ],
      trader: [
        '[#1] Status changed: OPEN',
        '[#1] BUY LIMIT order fill, total filled: 0.4',
        // The fill the answer to the cancelation reports, which the poll of 12:02:02 had reported first
        '[#1] BUY LIMIT order canceled (filled: 0.4, remaining: 0.6)',
      ],
      strategy: [
        'Order 0 created on candle 0: BUY LIMIT of 1 on BTC/USDT at 90.004',
        'Order 0 canceled by the strategy on candle 2',
        'Order 0 canceled: filled 0.4, remaining 0.6',
      ],
      warnings: [],
      book: [{ id: '1', type: 'limit', side: 'buy', price: 90, amount: 1, filled: 0.4, remaining: 0.6, status: 'canceled' }],
      // 0.4 BTC at 90 cost 36 USDT, and the maker fee of 0.1 % went in BTC: 0.4 - 0.0004. The 54 USDT the order held for the 0.6 it had
      // left are free again.
      balances: { BTC: { free: 0.3996, used: 0, total: 0.3996 }, USDT: { free: 9964, used: 0, total: 9964 } },
    });
  });

  it('Scenario E: a resting LIMIT SELL filled in part and canceled by the strategy, which sells all it held at the market on that candle', async () => {
    // A LIMIT SELL of 1 at 110 on candle 0, above the market of 100: it rests. Candle 1 reaches 111, trading 0.4 BTC up there, and on
    // candle 2 the strategy cancels the order (cancelAfter 2), then sends a MARKET SELL of the 1 BTC it held, to sell at the market instead
    strategy = script([
      { candle: 0, side: 'SELL', type: 'LIMIT', price: 110, amount: 1, cancelAfter: 2 },
      { candle: 2, side: 'SELL', type: 'MARKET', amount: 1 },
    ]);
    MockCCXTExchange.setBalances({ BTC: 1, USDT: 10000 });
    MockCCXTExchange.setPredefinedCandles('BTC/USDT', [
      { close: 100 },
      { open: 105, high: 111, close: 108, volume: 0.4 },
      { close: 105 },
      { close: 104 },
      { close: 103 },
    ]);

    // The SELL of candle 2 is sent at 12:03:02 and fills as it is created, reported between two buckets, heard as the next one arrives,
    // at 12:04:02
    await runRealtimeUntil(() => findTextLine('Order 1 completed') !== undefined || findTextLine('Order 1 errored') !== undefined, {
      maxMinutes: 6,
    });

    expect({
      calls: MockCCXTExchange.accountCalls,
      trader: traderLines(),
      strategy: strategyLines(),
      warnings: warnings(),
      book: book(),
      balances: MockCCXTExchange.getBalances(),
    }).toEqual({
      calls: [
        ...BEFORE_FIRST_ORDER_CALLS,
        { method: 'createOrder', symbol: 'BTC/USDT', type: 'limit', side: 'SELL', amount: 1, price: 110 },
        // Polled every 20 s from its creation at 12:01:02, the poll of 12:02:02 reading the 0.4 BTC candle 1 sold of it, to 12:03:02
        ...Array.from({ length: 6 }, (): AccountCall => ({ method: 'fetchOrder', id: '1', symbol: 'BTC/USDT' })),
        // Candle 2: the strategy cancels the LIMIT SELL, then sends the SELL, which the Trader sizes at once, before the report of the
        // cancelation reads the balance (sent first, while CCXTExchange reads the ticker it prices the SELL at, candle 2's close). It caps
        // the SELL at the 1 BTC its last synchronization read, before the LIMIT SELL was placed, less the 0.4 BTC that SELL sold: sized
        // from the whole of it, the SELL was refused for want of funds, an error counting towards the circuit breaker, the position open.
        { method: 'cancelOrder', id: '1', symbol: 'BTC/USDT' },
        { method: 'fetchBalance' },
        { method: 'createOrder', symbol: 'BTC/USDT', type: 'market', side: 'SELL', amount: 0.6, price: 105 },
        { method: 'fetchMyTrades', symbol: 'BTC/USDT', since: at('12:03:02'), limit: 1000 },
        { method: 'fetchBalance' },
      ],
      trader: [
        '[#1] Status changed: OPEN',
        '[#1] SELL LIMIT order fill, total filled: 0.4',
        '[#2] SELL MARKET order of 1 BTC above the free balance: 0.6 BTC sent, all that can be sold (1 BTC free at the last synchronization, less 0.4 BTC for the SELLs placed since)',
        '[#1] SELL LIMIT order canceled (filled: 0.4, remaining: 0.6)',
        '[#2] SELL MARKET order fill, total filled: 0.6',
        '[#2] Status changed: FILLED',
        // 0.063 USDT on the 63 of 0.6 × 105: 0.1 %, and 105 less its 0.1 % is 104.895
        summaryLine('[#2] SELL MARKET', '12:03:02', 'Order amount: 0.6, Effective price: 104.895, Fee: 0.063, Fee percent: 0.1,'),
      ],
      // Both ends are heard as the bucket of 12:04:02 arrives, after the SELL was created on candle 2
      strategy: [
        'Order 0 created on candle 0: SELL LIMIT of 1 on BTC/USDT at 110',
        'Order 0 canceled by the strategy on candle 2',
        'Order 1 created on candle 2: SELL MARKET of 1 on BTC/USDT',
        'Order 0 canceled: filled 0.4, remaining 0.6',
        'Order 1 completed: 0.6 at 105, fee 0.063 (0.1 %), effective price 104.895, executed at 2024-01-01T12:03:02.000Z',
      ],
      warnings: [
        '[#2] SELL MARKET order of 1 BTC above the free balance: 0.6 BTC sent, all that can be sold (1 BTC free at the last synchronization, less 0.4 BTC for the SELLs placed since)',
      ],
      book: [
        { id: '1', type: 'limit', side: 'sell', price: 110, amount: 1, filled: 0.4, remaining: 0.6, status: 'canceled' },
        { id: '2', type: 'market', side: 'sell', price: 105, amount: 0.6, filled: 0.6, remaining: 0, status: 'closed' },
      ],
      // 0.4 BTC at 110 brought 44 USDT less the maker fee of 0.1 %, 43.956, and 0.6 at 105 brought 63 less the taker fee, 62.937
      balances: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 10106.893, used: 0, total: 10106.893 } },
    });
  });

  // The reason the error of a creation whose outcome is unknown carries: Order.orderErroredAtCreation wraps the failure
  const outcomeUnknown = (failure: string) =>
    `Outcome unknown: the order may be live on the exchange, check it before placing it again (${failure})`;
  const TIMED_OUT = 'binance POST https://testnet.binance.vision/api/v3/order request timed out (10000 ms)';
  const NOT_A_REFUSAL = [
    'binance answered the creation of an order on BTC/USDT with a failure that is not a refusal:',
    'binance {"code":-1006,"msg":"An unexpected response was received from the message bus. Execution status unknown."}',
  ].join(' ');
  const WITHOUT_ID = [
    'binance answered the creation of an order on BTC/USDT with neither a status nor an id:',
    'the order may exist on the exchange, but cannot be followed',
  ].join(' ');
  const INSUFFICIENT_FUNDS = 'binance Account has insufficient balance for requested action.';
  /** The account as the exchange holds it at the end */
  type Account = { book: ReturnType<typeof book>; balances: Record<string, BalanceEntry> };
  /** The account once the exchange has carried out the BUY of 1 at 100 whose creation failed: 0.999 BTC bought for 100 USDT */
  const EXECUTED: Account = {
    book: [{ id: '1', type: 'market', side: 'buy', price: 100, amount: 1, filled: 1, remaining: 0, status: 'closed' }],
    balances: { BTC: { free: 0.999, used: 0, total: 0.999 }, USDT: { free: 9900, used: 0, total: 9900 } },
  };
  /** The lines of an order whose creation's outcome is unknown: its status change, then the Trader's report, which says it may be live */
  const unknownOutcomeLines = (reason: string) => [
    `[#1] BUY MARKET order error: ${reason}`,
    `[#1] BUY MARKET order: ${reason} (status: ERROR), it may still be live on the exchange, where Gekko follows it no more`,
  ];

  it.each<{ title: string; fault?: CreationFault; usdt: number; reason: string; live: string; lines: string[]; account: Account }>([
    {
      title: 'lost on the network (a RequestTimeout of ccxt), the order executed',
      fault: 'answerLost',
      usdt: 10000,
      // CCXTExchange sends a creation once, never again: the NetworkError comes as an ExchangeNetworkError, the order's outcome
      // unknown. The URL is the testnet's: the private client is in sandbox mode.
      reason: outcomeUnknown(TIMED_OUT),
      live: 'may be live on the exchange',
      lines: unknownOutcomeLines(outcomeUnknown(TIMED_OUT)),
      account: EXECUTED,
    },
    {
      title: 'failed by the exchange without a refusal (Binance -1006, an OperationFailed of ccxt), the order executed',
      fault: 'statusUnknown',
      usdt: 10000,
      reason: outcomeUnknown(NOT_A_REFUSAL),
      live: 'may be live on the exchange',
      lines: unknownOutcomeLines(outcomeUnknown(NOT_A_REFUSAL)),
      account: EXECUTED,
    },
    {
      title: 'answered with neither an id nor a status, the order executed',
      fault: 'answerWithoutId',
      usdt: 10000,
      reason: outcomeUnknown(WITHOUT_ID),
      live: 'may be live on the exchange',
      lines: unknownOutcomeLines(outcomeUnknown(WITHOUT_ID)),
      account: EXECUTED,
    },
    {
      title: 'refused for want of funds (an InsufficientFunds of ccxt), nothing placed',
      usdt: 50,
      // An InvalidOrder for Gekko: refused, the order placed nothing, and the Trader reports it at info level
      reason: INSUFFICIENT_FUNDS,
      live: 'not live on the exchange',
      lines: [`[#1] BUY MARKET order rejected: ${INSUFFICIENT_FUNDS}`],
      account: { book: [], balances: { BTC: { free: 0, used: 0, total: 0 }, USDT: { free: 50, used: 0, total: 50 } } },
    },
  ])('Scenario C: a MARKET BUY whose creation is $title', async ({ fault, usdt, reason, live, lines, account }) => {
    strategy = script([{ candle: 0, side: 'BUY', type: 'MARKET' }]);
    MockCCXTExchange.setBalances({ BTC: 0, USDT: usdt });
    if (fault) MockCCXTExchange.creationFaults = [fault];
    MockCCXTExchange.setPredefinedCandles('BTC/USDT', [{ close: 100 }, { close: 110 }, { close: 120 }]);

    // The creation fails at 12:01:02, and the error reaches the strategy as the next bucket arrives, at 12:02:02
    await runRealtimeUntil(() => findTextLine('Order 0 errored') !== undefined, { maxMinutes: 4 });

    expect({
      calls: MockCCXTExchange.accountCalls,
      strategy: strategyLines(),
      warnings: warnings(),
      book: book(),
      balances: MockCCXTExchange.getBalances(),
    }).toEqual({
      calls: [
        ...BEFORE_FIRST_ORDER_CALLS,
        // Sent once: a creation is never replayed, whatever its failure
        { method: 'createOrder', symbol: 'BTC/USDT', type: 'market', side: 'BUY', amount: 1, price: 100 },
        // The portfolio the error is reported with, which shows what the order may have executed
        { method: 'fetchBalance' },
      ],
      // The strategy hears of an error: what the exchange reported filled, nothing, and whether the order may be live (mayBeLive)
      strategy: ['Order 0 created on candle 0: BUY MARKET of 1 on BTC/USDT', `Order 0 errored: filled 0, ${live}: ${reason}`],
      warnings: lines,
      ...account,
    });
  });

  it('Scenario D: the orders open at start-up, handed to the init of GridBot, which counts them and refuses to start', async () => {
    // Placed before the run, as ccxt's binance lists them: a LIMIT BUY of 0.5 at 95 that filled 0.2; a stop-loss SELL of 1 at 90 that
    // waits for 92 off the book (STOP_LOSS_LIMIT); a take-profit SELL of 1 that sells at the market once the price reaches 120, which
    // ccxt types limit, without a price (TAKE_PROFIT); and a LIMIT BUY on ETH/USDT, a pair the run does not watch
    strategy = { name: 'GridBot', buyLevels: 2, sellLevels: 2, spacingType: 'percent', spacingValue: 1 };
    // The 2 BTC the two SELLs hold, and the USDT the BUYs hold
    MockCCXTExchange.setBalances({ BTC: 2, USDT: 10000 });
    MockCCXTExchange.addOpenOrder({ symbol: 'BTC/USDT', side: 'buy', type: 'limit', amount: 0.5, price: 95, filled: 0.2 });
    MockCCXTExchange.addOpenOrder({ symbol: 'BTC/USDT', side: 'sell', type: 'stop_loss_limit', amount: 1, price: 90, triggerPrice: 92 });
    MockCCXTExchange.addOpenOrder({ symbol: 'BTC/USDT', side: 'sell', type: 'limit', amount: 1, triggerPrice: 120 });
    MockCCXTExchange.addOpenOrder({ symbol: 'ETH/USDT', side: 'buy', type: 'limit', amount: 1, price: 1000 });

    // init runs on the first bucket, at 12:01:02, and its refusal (tools.log('error')) fails the bucket, which ends the run
    const failure = await runRealtimeUntilEnd({ maxMinutes: 3 });

    // The TradingAdvisor reads the orders of the pair once, at start-up, and CCXTExchange lists each as Gekko names it: the LIMIT BUY with
    // what it has left, 0.5 - 0.2; the stop-loss and the take-profit as OTHER, the first by its type, the second, typed limit, by its
    // trigger price, which sets it apart from the orders resting on the book, and without a price
    const refusal = [
      'GridBot: 3 orders are open on BTC/USDT at start-up:',
      'LIMIT BUY 0.3 at 95 (id 1), OTHER SELL 1 at 90 (id 2), OTHER SELL 1 at market (id 3).',
      'GridBot keeps its grid in memory and follows only the orders it places: an order placed before this run, by a previous run,',
      'by hand or by another bot, would trade beside the new grid without GridBot hearing of its fills.',
      'Cancel the orders open on BTC/USDT on the exchange, then start again',
    ].join(' ');
    expect({
      failure: { name: (failure as Error).name, message: (failure as Error).message },
      calls: MockCCXTExchange.accountCalls,
      closeReason: findTextLine('Gekko is closing the application')?.message,
    }).toEqual({
      failure: { name: 'GekkoError', message: `[STRATEGY] ${refusal}` },
      // The start-up calls alone: the run ends on its first bucket, before the end of the warmup, which the Trader synchronizes at
      calls: START_UP_CALLS,
      closeReason: `Gekko is closing the application due to an error: [STRATEGY] ${refusal}`,
    });
  });
});
