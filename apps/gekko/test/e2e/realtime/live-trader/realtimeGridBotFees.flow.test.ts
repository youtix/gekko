import type { gridBotStrategySchema } from '@gekko/schemas/strategies/gridBot.schema';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import { startFakeClock } from '../../helpers/clock.helper';
import type { RawConfiguration } from '../../helpers/configuration.helper';
import { endRealtimeRun, mockRealtimeModules, runRealtimeUntil, useRealtimeConfiguration } from '../../helpers/realtimeRun.helper';
import { MockCCXTExchange, type PartialCandle } from '../../mocks/ccxt.mock';
import { clearLogs, findTextLine, numberedTextLines, type TextLine } from '../../mocks/winston.mock';

// --------------------------------------------------------------------------
// MOCKS SETUP
// --------------------------------------------------------------------------

// Winston, ccxt and the fetcher, as every realtime flow mocks them. The grid's orders go through CCXTExchange to ccxt, whose mock keeps
// the book and the balances of the account as Binance does: a fill takes Binance's 0.1 % fee in what it brings in, so a BUY's in the
// asset bought, to 8 decimals (see MockCCXTExchange.fill)
mockRealtimeModules();
// The lines the flow reads are at info and above, GridBot's included
process.env.GEKKO_LOG_LEVEL = 'info';

/** Binance's testnet, on which a Trader needs no disclaimer */
const TESTNET: Extract<RawConfiguration['exchange'], { name: 'binance' }> = {
  name: 'binance',
  sandbox: true,
  apiKey: 'testnet-key',
  secret: 'testnet-secret',
};

/** GridBot's block as a configuration file writes it, without its name */
type GridBlock = z.input<typeof gridBotStrategySchema>;

// The configuration each run reads as it starts (see useRealtimeConfiguration): GridBot on BTC/USDT, its grid placed on the first
// candle, 12:00's, which the Heart fetches at 12:01:02 (see REALTIME_START)
let grid: GridBlock;
useRealtimeConfiguration(() => ({
  watch: { mode: 'realtime', assets: ['BTC'], currency: 'USDT', timeframe: '1m', tickrate: 100, warmup: { candleCount: 0 } },
  exchange: TESTNET,
  plugins: [{ name: 'TradingAdvisor', strategyName: 'GridBot' }, { name: 'Trader' }],
  strategy: { name: 'GridBot', ...grid },
}));

/**
 * The lines logged as text that `keep` accepts, oldest first, as `level | message`, each order id the StrategyManager drew written #1,
 * #2… in the order the run first logged them (see numberedTextLines)
 */
const linesOf = (keep: (line: TextLine) => boolean) =>
  numberedTextLines(rank => `#${rank}`)
    .filter(keep)
    .map(({ level, message }) => `${level} | ${message}`);

/** GridBot's lines and the StrategyManager's */
const strategyLines = () => linesOf(({ _tag }) => _tag === 'STRATEGY');

/** Every warning and error of the run, whatever logged it: the Trader's caps and refusals among them */
const warnings = () => linesOf(({ level }) => level === 'warn' || level === 'error');

/** The orders the run sent to the exchange, as `SIDE amount at price`, oldest first: the amounts as CCXTExchange sent them, on the step */
const ordersSent = () =>
  MockCCXTExchange.accountCalls.flatMap(call => (call.method === 'createOrder' ? [`${call.side} ${call.amount} at ${call.price}`] : []));

// --------------------------------------------------------------------------
// TEST SUITE
// --------------------------------------------------------------------------

describe('E2E: GridBot live on Binance, its BUYs paying their fees in the asset bought', () => {
  beforeEach(() => {
    clearLogs();
    MockCCXTExchange.reset();
    startFakeClock();
  });

  // A realtime run never ends by itself: each test ends its own before the next one starts
  afterEach(() => endRealtimeRun());

  it('Scenario A: a grid at the market minimum sells what each BUY left, carrying the rest under a step, without a cap or a refusal', async () => {
    // Three buy levels and one sell level 1 apart around 100: BUY 97, 98 and 99, SELL 101. The market takes 5 USDT at least, 0.051547
    // BTC at 97 on the step of 0.000001 (5 / 97 = 0.05154639…, rounded up), which the balances fund and no more: the SELL 0.051547 BTC,
    // the BUYs 0.051547 × (99 + 98 + 97) × 1.001 = 15.16997… USDT, the maker fee set aside as the simulator charges it. No BTC is left
    // over: the SELL of the quantity that used to follow a BUY asked for the fee more than the account held, which the Trader capped at
    // the free balance with a warning at each round trip, and of the SELLs of two BUYs heard together the first sold the quantity and
    // the second was capped for both (0.051444 at 100).
    grid = { buyLevels: 3, sellLevels: 1, spacingType: 'fixed', spacingValue: 1 };
    MockCCXTExchange.setBalances({ BTC: 0.051547, USDT: 15.1714 });
    const candles: PartialCandle[] = [
      // The grid is built around its close
      { close: 100 },
      // Its low fills the BUY at 99
      { open: 100, low: 98.9, close: 99.5 },
      { close: 99.5 },
      // Its high fills the SELL at 100 that BUY turned into
      { open: 99.5, high: 100.3, close: 99.8 },
      { close: 99.8 },
      // The BUY at 99 again, then its SELL
      { open: 99.8, low: 98.9, close: 99.5 },
      { close: 99.5 },
      { open: 99.5, high: 100.3, close: 99.8 },
      { close: 99.8 },
      // Its low fills the BUYs at 99 and at 98, heard together
      { open: 99.8, low: 97.9, close: 98.5 },
      { close: 98.5 },
      // Its high fills both SELLs
      { open: 98.5, high: 100.3, close: 99.8 },
      { close: 99.8 },
      { close: 99.8 },
    ];
    MockCCXTExchange.setPredefinedCandles('BTC/USDT', candles);

    // The SELLs of 12:11 are heard filled, and their levels turned to BUYs, with the bucket of 12:12
    await runRealtimeUntil(() => ordersSent().length === 12, { maxMinutes: 14 });

    expect({ orders: ordersSent(), strategy: strategyLines(), warnings: warnings(), balances: MockCCXTExchange.getBalances() }).toEqual({
      orders: [
        'BUY 0.051547 at 97',
        'BUY 0.051547 at 98',
        'BUY 0.051547 at 99',
        'SELL 0.051547 at 101',
        // Each BUY of 0.051547 pays Binance's 0.1 % in BTC, 0.000051547 rounded to 8 decimals, 0.00005155, and leaves 0.05149545 BTC:
        // the SELL that follows sells 0.051495 of it on the step, its level carrying the 0.00000045 left
        'SELL 0.051495 at 100',
        // A SELL's fill turns its level to a BUY of the whole quantity
        'BUY 0.051547 at 99',
        // 0.00000045 carried and 0.05149545 left: 0.0514959, 0.051495 on the step, 0.0000009 carried
        'SELL 0.051495 at 100',
        'BUY 0.051547 at 99',
        // The BUYs at 98 and at 99 heard together, the one at 98 placed first and polled first: each SELL sells what its own BUY left,
        // where the SELL of the quantity took the fee shortfall of both out of the second one. At 99, 0.0000009 carried and 0.05149545
        // left: 0.05149635, 0.051496 on the step
        'SELL 0.051495 at 99',
        'SELL 0.051496 at 100',
        'BUY 0.051547 at 98',
        'BUY 0.051547 at 99',
      ],
      strategy: [
        'info | Strategy warmup done ! Sending first candle bucket (2024-01-01T12:00:00.000Z) to strategy',
        'info | GridBot: Grid built around 100 with 3 buy / 1 sell levels, qty=0.051547',
        // Said once in the run, at the first BUY whose fee the exchange took in BTC
        "info | GridBot: The exchange took the fee of the BUY at 99 in BTC: its level holds 0.05149545 BTC, and its SELL at 100 sells 0.051495, on the amount step, the rest carried to the level's next SELL. A SELL that follows a BUY whose fee is taken in BTC sells what that BUY left, and the next BUY buys the quantity again",
      ],
      // No SELL above the free balance for the Trader to cap, none under the market minimum for the exchange to refuse
      warnings: [],
      balances: {
        // The SELL at 101 holds its 0.051547 BTC, and the levels at 98 and at 99 carry 0.00000045 and 0.00000035, free
        BTC: { free: 0.0000008, used: 0.051547, total: 0.0515478 },
        // 15.1714 USDT, less 0.051547 × 99 = 5.103153 for each of the three BUYs at 99 and 0.051547 × 98 = 5.051606 for the one at 98,
        // plus what the SELLs brought, their 0.1 % taken out: 5.1495 - 0.0051495 for each 0.051495 at 100, 5.098005 - 0.00509801 for
        // 0.051495 at 99 and 5.1496 - 0.0051496 for 0.051496 at 100, 15.33639339 in all. The BUYs at 97, 98 and 99 hold 0.051547 × 294
        USDT: { free: 0.18157539, used: 15.154818, total: 15.33639339 },
      },
    });
  });

  it('Scenario B: a grid whose BUY leaves less than the market minimum sells that minimum while the idle BTC pays the fee, then is refused', async () => {
    // Two buy levels and one sell level 300 apart around 60000: BUY 59400 and 59700, SELL 60300. The market takes 0.0001 BTC at least
    // (amount.min), which the balances fund, with 0.00000015 BTC over: a BUY of 0.0001 pays a fee of 0.0000001 BTC and leaves 0.0000999,
    // 0.000099 on the step of 0.000001, under the minimum. Sold alone, it was refused at the first round trip.
    grid = { buyLevels: 2, sellLevels: 1, spacingType: 'fixed', spacingValue: 300 };
    MockCCXTExchange.setBalances({ BTC: 0.00010015, USDT: 11.93 });
    const candles: PartialCandle[] = [
      { close: 60000 },
      // Its low fills the BUY at 59700
      { open: 60000, low: 59650, close: 59800 },
      { close: 59800 },
      // Its high fills the SELL at 60000 that BUY turned into
      { open: 59800, high: 60050, close: 59900 },
      { close: 59900 },
      // The BUY at 59700 again
      { open: 59900, low: 59650, close: 59800 },
      ...Array.from({ length: 8 }, (): PartialCandle => ({ close: 59800 })),
    ];
    MockCCXTExchange.setPredefinedCandles('BTC/USDT', candles);

    // The second SELL of the level is refused once the idle BTC is spent, and placed again until the level gives up
    await runRealtimeUntil(() => findTextLine('failed after') !== undefined, { maxMinutes: 14 });

    // The refusal CCXTExchange makes before it sends an order: the amount the Trader capped, truncated to the step, under amount.min
    const refusal = "Order 'amount' with value 0.000099 is out of range. Expected a value between 0.0001 and 1000.";
    /** The Trader's lines of a SELL of the level at its second round trip, each attempt capped at the free balance, then refused */
    const refused = (order: number) => [
      `warn | [#${order}] SELL LIMIT order of 0.0001 BTC above the free balance: 0.00009995 BTC sent, all that can be sold`,
      `error | [#${order}] SELL LIMIT order rejected: ${refusal}`,
    ];
    const raised =
      'warn | GridBot: The exchange took the fee of the BUY at 59700 in BTC: its level holds 0.0000999 BTC, under the market minimum of 0.0001 at its SELL price, 60000, and the SELL sells 0.0001, the rest taken from the BTC the grid does not trade; once that is spent, the market refuses such a SELL at each attempt until its level gives up. Pay the fees in another asset (BNB on Binance), or fund each level with more than the market minimum and its fee';
    const givenUp = `warn | GridBot: SELL at 60000 failed after 4 attempts (retryOnError: 3): its level is left without an order, the rest of the grid trades on. Last error: ${refusal}`;
    expect({ orders: ordersSent(), strategy: strategyLines(), warnings: warnings(), balances: MockCCXTExchange.getBalances() }).toEqual({
      orders: [
        'BUY 0.0001 at 59400',
        'BUY 0.0001 at 59700',
        'SELL 0.0001 at 60300',
        // Raised to the minimum: 0.0000999 left by the BUY, and 0.0000001 of the 0.00000015 BTC over, which the Trader reads free
        'SELL 0.0001 at 60000',
        'BUY 0.0001 at 59700',
        // Its second SELL never reaches the exchange: CCXTExchange refuses each attempt, the Trader having capped it
      ],
      strategy: [
        'info | Strategy warmup done ! Sending first candle bucket (2024-01-01T12:00:00.000Z) to strategy',
        'info | GridBot: Grid built around 60000 with 2 buy / 1 sell levels, qty=0.0001',
        // Warned of once in the run, at the first SELL raised
        raised,
        givenUp,
      ],
      warnings: [
        raised,
        // The second BUY leaves 0.0000999 too, and 0.00000005 BTC is over: the SELL of 0.0001 is capped at 0.00009995, which CCXTExchange
        // truncates to 0.000099, under amount.min. GridBot places it again for 0.0001 three times (retryOnError), refused alike
        ...[6, 7, 8, 9].flatMap(refused),
        givenUp,
      ],
      balances: {
        // The SELL at 60300 holds its 0.0001 BTC, and the level that gave up 0.0000999 + 0.00000005, idle
        BTC: { free: 0.00009995, used: 0.0001, total: 0.00019995 },
        // 11.93 USDT, less 5.94 the BUY at 59400 holds, less 5.97 for each BUY at 59700, plus 6 less its 0.1 % for the SELL at 60000
        USDT: { free: 0.044, used: 5.94, total: 5.984 },
      },
    });
  });
});
