import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { Candle } from '@gekko/shared/models/candle.types';
import { generateSyntheticCandle, syntheticPrice } from '../fixtures/syntheticData';
import { minuteOf } from '../helpers/clock.helper';

export type PartialCandle = {
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
};

/** A candle as ccxt hands it over: [timestamp, open, high, low, close, volume] */
export type OHLCV = [number, number, number, number, number, number];

/** Minutes without a candle, from `start` (included) to `end` (excluded), in epoch milliseconds */
export type Gap = { start: number; end: number };

type Range = { min: number; max: number };

type MockMarket = {
  symbol: string;
  base: string;
  quote: string;
  baseName: string;
  maker: number;
  taker: number;
  limits: { price: Range; amount: Range; cost: Range; market: Range };
  precision: { price: number; amount: number };
};

/**
 * ccxt's error classes, with ccxt's own inheritance (BaseError at the root, NetworkError extends OperationFailed, OrderNotFound extends
 * InvalidOrder, BadSymbol extends BadRequest) and names ('NetworkError'), so that retry, translateCcxtError
 * (src/services/exchange/exchange.helper.ts) and the creations of CCXTExchange run their instanceof checks against the mocked module,
 * and a failure reads as ccxt's.
 */
export class MockBaseError extends Error {
  constructor(message?: string) {
    super(message);
    // As ccxt names each of its errors: after its class
    this.name = new.target.name.replace(/^Mock/, '');
  }
}
export class MockOperationFailed extends MockBaseError {}
export class MockNetworkError extends MockOperationFailed {}
/** What ccxt throws for a request the exchange did not answer in time: a NetworkError, the request maybe carried out */
export class MockRequestTimeout extends MockNetworkError {}
export class MockExchangeError extends MockBaseError {}
export class MockInvalidOrder extends MockExchangeError {}
export class MockOrderNotFound extends MockInvalidOrder {}
export class MockInsufficientFunds extends MockExchangeError {}
export class MockBadRequest extends MockExchangeError {}
export class MockBadSymbol extends MockBadRequest {}

/**
 * ccxt's rounding, counting and padding modes (base/functions/number.js), which ccxt exports at the top of its module and CCXTExchange
 * reads from there (ccxt.TRUNCATE): ROUND_UP and ROUND_DOWN share their values with DECIMAL_PLACES and SIGNIFICANT_DIGITS, as in ccxt
 */
export const PRECISION_CONSTANTS = {
  TRUNCATE: 0,
  ROUND: 1,
  ROUND_UP: 2,
  ROUND_DOWN: 3,
  DECIMAL_PLACES: 2,
  SIGNIFICANT_DIGITS: 3,
  TICK_SIZE: 4,
  NO_PADDING: 5,
  PAD_WITH_ZERO: 6,
} as const;
const { TRUNCATE, ROUND, TICK_SIZE, NO_PADDING } = PRECISION_CONSTANTS;

/** The fees ccxt 4.5.39 gives every Binance spot market (fees.trading of binance.js): 0.1 % for the maker and for the taker */
const BINANCE_SPOT_FEES = { maker: 0.001, taker: 0.001 };

/** ccxt's binance asks for 500 candles when no limit is given, and for 1000 at most (binance.fetchOHLCV) */
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000;

/** Binance answers 500 trades of the account when no limit is given, and 1000 at most (GET /api/v3/myTrades) */
const DEFAULT_TRADES_PAGE_SIZE = 500;
const MAX_TRADES_PAGE_SIZE = 1000;

/** What the account holds of each currency at load, all of it free: what fetchBalance answered whatever the orders */
const DEFAULT_BALANCES: Record<string, number> = { USDT: 10000, BTC: 1, ETH: 10, LTC: 10 };

const toOHLCV = ({ start, open, high, low, close, volume }: Candle): OHLCV => [start, open, high, low, close, volume];

/** A predefined candle with the values it leaves out: its open at its close, its high and low at the higher and the lower of the two */
const completeCandle = (candle: PartialCandle) => {
  const { open = candle.close, close, volume = 50 } = candle;
  const { high = Math.max(open, close), low = Math.min(open, close) } = candle;
  return { open, high, low, close, volume };
};

/* -------------------------------------------------------------------------- */
/*                 DECIMALS, AS CCXT WRITES AND ROUNDS THEM                    */
/* -------------------------------------------------------------------------- */

/**
 * A number written out in decimal, without an exponent, with the digits String gives it, as ccxt's numberToString writes one (1.5e-7 is
 * '0.00000015', 1e21 is '1' and 21 zeros); a string as it is. The semantics of ccxt's function, written anew: the mock must not share
 * code with what it stands in for.
 */
const numberToString = (value: number | string): string => {
  if (typeof value !== 'number') return value;
  const text = String(value);
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, lead, rest = '', exponent] = match;
  const digits = lead + rest;
  // The decimal point goes after that many digits of the mantissa
  const point = 1 + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
};

const decimalsOf = (decimal: string) => decimal.split('.')[1]?.length ?? 0;

/** A decimal written out (see numberToString) as an integer count of units of 10^-scale, `scale` at least its decimals */
const toScaled = (decimal: string, scale: number): bigint => {
  const isNegative = decimal.startsWith('-');
  const [whole, fraction = ''] = (isNegative ? decimal.slice(1) : decimal).split('.');
  const units = BigInt(whole + fraction.padEnd(scale, '0'));
  return isNegative ? -units : units;
};

/** A count of units of 10^-scale written out in decimal, without trailing zeros, as ccxt writes a value it rounded without padding */
const fromScaled = (units: bigint, scale: number): string => {
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  const text = fraction ? `${whole}.${fraction}` : whole;
  return units < 0n ? `-${text}` : text;
};

/** `units` of 10^-from as units of 10^-to, rounded half away from zero when that drops digits */
const rescale = (units: bigint, from: number, to: number): bigint => {
  if (from <= to) return units * 10n ** BigInt(to - from);
  const divisor = 10n ** BigInt(from - to);
  const quotient = units / divisor;
  const rest = units - quotient * divisor;
  const isHalfOrMore = 2n * (rest < 0n ? -rest : rest) >= divisor;
  return isHalfOrMore ? quotient + (units < 0n ? -1n : 1n) : quotient;
};

/**
 * A value rounded to a multiple of `tick`, in exact decimal, as ccxt's decimalToPrecision rounds one in its TICK_SIZE counting mode,
 * the one ccxt's binance works in: TRUNCATE toward zero, ROUND to the nearest, a half away from zero. Written without padding, and as
 * ccxt writes each: a truncated value as String writes the number (1e-7 below a millionth), a rounded one in decimal.
 */
const roundToTick = (value: number | string, tick: number | string, roundingMode: number): string => {
  const [valueText, tickText] = [numberToString(value), numberToString(tick)];
  const scale = Math.max(decimalsOf(valueText), decimalsOf(tickText));
  const units = toScaled(valueText, scale);
  const tickUnits = toScaled(tickText, scale);
  if (!(tickUnits > 0n)) throw new Error(`A tick above 0 is needed in the TICK_SIZE mode, got ${tickText}`);
  let ticks = units / tickUnits;
  const rest = units - ticks * tickUnits;
  if (roundingMode === ROUND && 2n * (rest < 0n ? -rest : rest) >= tickUnits) ticks += units < 0n ? -1n : 1n;
  const rounded = fromScaled(ticks * tickUnits, scale);
  return roundingMode === TRUNCATE ? String(Number(rounded)) : rounded;
};

/** Binance books every balance, and the cost and the fee of a trade, to 8 decimals: the mock books them in units of 10^-8 */
const BOOKED_DECIMALS = 8;

/** A number as a count of units of 10^-8, rounded half away from zero */
const toUnits = (value: number): bigint => {
  const text = numberToString(value);
  return rescale(toScaled(text, decimalsOf(text)), decimalsOf(text), BOOKED_DECIMALS);
};

const fromUnits = (units: bigint): number => Number(fromScaled(units, BOOKED_DECIMALS));

/** `units` of 10^-8 times `factor`, in exact decimal, rounded half away from zero to units of 10^-8 */
const multiplyUnits = (units: bigint, factor: number): bigint => {
  const text = numberToString(factor);
  return rescale(units * toScaled(text, decimalsOf(text)), BOOKED_DECIMALS + decimalsOf(text), BOOKED_DECIMALS);
};

const minUnits = (a: bigint, b: bigint) => (a < b ? a : b);

/** What the account holds of each currency, in units of 10^-8 (see setBalances) */
const toHoldings = (balances: Record<string, number>) =>
  new Map(Object.entries(balances).map(([currency, amount]) => [currency, toUnits(amount)]));

/* -------------------------------------------------------------------------- */
/*                         THE ACCOUNT, AS BINANCE KEEPS IT                    */
/* -------------------------------------------------------------------------- */

/**
 * A call to the account, the private API of ccxt, as the mock received it: the order path of CCXTExchange, which the live flows pin.
 * The calls of the market data (the candles, the tickers, the markets) are not counted.
 */
export type AccountCall =
  | { method: 'createOrder'; symbol: string; type: string; side: string; amount: number; price?: number }
  | { method: 'fetchOrder' | 'cancelOrder'; id: string; symbol?: string }
  | { method: 'fetchOpenOrders'; symbol?: string }
  | { method: 'fetchMyTrades'; symbol?: string; since?: number; limit?: number }
  | { method: 'fetchBalance' };

/**
 * What befalls a creation (see creationFaults), its order placed on the book all the same, and matched as any other:
 * - 'answerLost': its answer is lost on the network, ccxt throwing a RequestTimeout, a NetworkError;
 * - 'statusUnknown': the exchange answers it with an internal error, Binance's -1006 ("Execution status unknown"), which ccxt throws as
 *   an OperationFailed that is not a NetworkError;
 * - 'answerWithoutId': the exchange answers it with neither the id nor the status of the order, as ccxt parses an answer it cannot read.
 */
export type CreationFault = 'answerLost' | 'statusUnknown' | 'answerWithoutId';

/**
 * An order open on the account before the run, by hand or by an earlier run (see addOpenOrder), as ccxt's binance types it: its own
 * type lower-cased (stop_loss_limit), or, for some conditional orders, the type they execute with once triggered (ccxt gives Binance's
 * TAKE_PROFIT as limit, without a price, a market order once triggered)
 */
export type OpenOrderSeed = {
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  amount: number;
  price?: number;
  filled?: number;
  /** The price a conditional order waits for, off the book: such an order never trades in the mock */
  triggerPrice?: number;
};

/** The balance of a currency, as ccxt hands it over */
export type BalanceEntry = { free: number; used: number; total: number };

/** What a fill of an order books: the asset and the currency of its market, and the fees a taker and a maker pay there */
type OrderMarket = Pick<MockMarket, 'base' | 'quote' | 'maker' | 'taker'>;

type BookedOrder = {
  id: string;
  symbol: string;
  market: OrderMarket;
  type: string;
  side: 'buy' | 'sell';
  /** In units of 10^-8, as the fill and the cost */
  amount: bigint;
  filled: bigint;
  cost: bigint;
  price?: number;
  triggerPrice?: number;
  status: 'open' | 'closed' | 'canceled';
  timestamp: number;
  lastUpdateTimestamp: number;
  lastTradeTimestamp?: number;
  /** Whether the exchange has matched it against the market as it was placed: not yet when it answered first (matchesOrdersAtCreation) */
  isMatchedAtPlacement: boolean;
  /** How many predefined candles of its pair were served when it was placed, then last matched: it trades with those served after */
  candlesSeen: number;
};

type TakerOrMaker = 'taker' | 'maker';

/** The status Binance gives an order, which ccxt's binance parses into the status of a ccxt order */
const binanceStatusOf = ({ status, filled }: BookedOrder) => {
  if (status === 'closed') return 'FILLED';
  if (status === 'canceled') return 'CANCELED';
  return filled > 0n ? 'PARTIALLY_FILLED' : 'NEW';
};

/** A ccxt order as ccxt's binance parses an answer that holds nothing of it: no id, no status (executedQty read as '0') */
const unreadOrder = (symbol: string) => ({
  info: {},
  id: undefined,
  clientOrderId: undefined,
  timestamp: undefined,
  datetime: undefined,
  lastTradeTimestamp: undefined,
  lastUpdateTimestamp: undefined,
  symbol,
  type: undefined,
  side: undefined,
  price: undefined,
  amount: undefined,
  cost: undefined,
  average: undefined,
  filled: 0,
  remaining: undefined,
  status: undefined,
  fee: undefined,
  trades: [],
  fees: [],
});

/** The markets as ccxt's binance builds them (see MockCCXTExchange.markets): each client gets its own */
const buildMarkets = (): Record<string, MockMarket> => ({
  'BTC/USDT': {
    symbol: 'BTC/USDT',
    base: 'BTC',
    quote: 'USDT',
    baseName: 'BTC',
    ...BINANCE_SPOT_FEES,
    limits: {
      price: { min: 0.1, max: 1000000 },
      amount: { min: 0.0001, max: 1000 },
      cost: { min: 5, max: 1000000 },
      market: { min: 0, max: 100 },
    },
    precision: { price: 0.01, amount: 0.000001 },
  },
  'ETH/USDT': {
    symbol: 'ETH/USDT',
    base: 'ETH',
    quote: 'USDT',
    baseName: 'ETH',
    ...BINANCE_SPOT_FEES,
    limits: {
      price: { min: 0.01, max: 100000 },
      amount: { min: 0.001, max: 10000 },
      cost: { min: 5, max: 1000000 },
      market: { min: 0, max: 2000 },
    },
    precision: { price: 0.01, amount: 0.000001 },
  },
  'LTC/USDT': {
    symbol: 'LTC/USDT',
    base: 'LTC',
    quote: 'USDT',
    baseName: 'LTC',
    ...BINANCE_SPOT_FEES,
    limits: {
      price: { min: 0.01, max: 100000 },
      amount: { min: 0.001, max: 10000 },
      cost: { min: 5, max: 1000000 },
      market: { min: 0, max: 5000 },
    },
    precision: { price: 0.01, amount: 0.000001 },
  },
});

/** The markets an order placed before the run trades on (see addOpenOrder): those of the clients, the pair's asset and currency else */
const SEED_MARKETS = buildMarkets();

export class MockCCXTExchange {
  /** The pages fetchOHLCV served each pair, which the duplicate lie counts */
  private pagesServed = new Map<string, number>();
  /** The first minute fetchOHLCV served each pair, which the duplicate lie stamps its pages with */
  private firstMinuteServed = new Map<string, number>();

  /**
   * The minutes the exchange has no candle for: for every pair (a list) or by pair (a record). The candles after a gap are served as
   * the exchange serves them, from the first at or after `since`, and a gap without an end (Infinity) ends the history of the pair, as
   * a delisting does.
   */
  public static simulatedGaps: Gap[] | Record<string, Gap[]> = [];
  /** When true, every call to fetchOHLCV and createOrder fails with a ccxt NetworkError, which CCXTExchange retries for a read only */
  public static shouldThrowError: boolean = false;
  /** The next calls to fetchOHLCV that fail with a ccxt NetworkError, one less after each: a fault that passes, which a retry gets past */
  public static networkErrorsToThrow: number = 0;
  /** When true, every call to fetchOHLCV fails with a ccxt ExchangeError, which CCXTExchange neither sends again nor translates */
  public static shouldThrowExchangeError: boolean = false;
  /** When true, every call to createOrder fails with a ccxt NetworkError, before the order reaches the book */
  public static shouldThrowOnCreateOrder: boolean = false;
  /**
   * A lie of the exchange, for the scenarios that check what guards against it: from the X-th page served to a pair, every X-th page
   * (pages counted from 0) has each of its candles stamped with the first minute served to the pair, the prices of the minutes asked
   * for kept. ccxt's own parseOHLCVs, which keeps the candles at or after `since` only, never lets such a page through; RealtimeStream
   * drops each of its candles as already delivered. 0 tells no such lie.
   */
  public static emitDuplicatesEveryXCandle: number = 0;
  /**
   * A lie of the exchange, for the scenarios that check what guards against it: every page opens with the candle of 5 minutes after
   * the call, off the minute boundaries, before the candles asked for. Binance has no candle after the minute in progress, so ccxt
   * never serves one; RealtimeStream ignores it as a minute not closed yet.
   */
  public static emitFutureCandles: boolean = false;

  /**
   * A script of candles by pair, which fetchOHLCV serves one per call, in order, each stamped with the `since` of its call, instead of
   * a page; the synthetic pages follow the last one. The pair's ticker follows them (see lastPrice), and so do the orders resting on its
   * book (see matchOrder).
   */
  public static predefinedCandles: Record<string, PartialCandle[]> = {};
  /** The index of the next predefined candle of each pair, which is also how many of them were served */
  public static predefinedCandlesIndex: Record<string, number> = {};

  /**
   * When false, the exchange answers a creation before it matches the order, as an exchange that matches asynchronously: open, nothing
   * filled, the order matched against the market at the next call to the account, a poll of it most often. True by default: the order
   * is matched as it is created, and a marketable one (a MARKET order, a LIMIT order at or past the ticker) answered closed with its
   * fills, as Binance answers a creation (newOrderRespType FULL).
   */
  public static matchesOrdersAtCreation = true;
  /** What befalls each of the next creations, the first one first, one taken off at each creation (see CreationFault) */
  public static creationFaults: CreationFault[] = [];
  /** Every call to the account, oldest first (see AccountCall) */
  public static accountCalls: AccountCall[] = [];
  /** Every client built, oldest first: CCXTExchange builds a public one, then a private one, which holds the keys */
  public static clients: MockCCXTExchange[] = [];
  /** Every trade of the account, oldest first, as ccxt's binance parses them (fetchMyTrades) */
  public static mockTrades: any[] = [];

  /** What the account holds of each currency, in units of 10^-8: what its open orders reserve included */
  private static holdings = toHoldings(DEFAULT_BALANCES);
  /** Every order of the account by id, the open ones and those that ended, oldest first */
  private static book = new Map<string, BookedOrder>();
  /** The volume each predefined candle traded with the orders resting on the book, in units of 10^-8, by `<symbol> <index>` */
  private static volumeTraded = new Map<string, bigint>();
  private static orderCount = 0;
  private static tradeCount = 0;

  public static setPredefinedCandles(symbol: string, candles: PartialCandle[]) {
    this.predefinedCandles[symbol] = candles;
    this.predefinedCandlesIndex[symbol] = 0;
  }

  public static resetPredefinedCandles() {
    this.predefinedCandles = {};
    this.predefinedCandlesIndex = {};
  }

  /** Puts every static back as it is at load, so that a test does not run on the exchange the previous one set up */
  public static reset() {
    this.simulatedGaps = [];
    this.shouldThrowError = false;
    this.networkErrorsToThrow = 0;
    this.shouldThrowExchangeError = false;
    this.shouldThrowOnCreateOrder = false;
    this.emitDuplicatesEveryXCandle = 0;
    this.emitFutureCandles = false;
    this.mockTrades = [];
    this.resetPredefinedCandles();
    this.matchesOrdersAtCreation = true;
    this.creationFaults = [];
    this.accountCalls = [];
    this.clients = [];
    this.setBalances(DEFAULT_BALANCES);
    this.book = new Map();
    this.volumeTraded = new Map();
    this.orderCount = 0;
    this.tradeCount = 0;
  }

  /** What the account holds of each currency, all of it free, in place of what it held: the currencies left out hold nothing */
  public static setBalances(balances: Record<string, number>) {
    this.holdings = toHoldings(balances);
  }

  /** The balance of each currency the account holds, as fetchBalance answers it: what its open orders reserve is used, not free */
  public static getBalances(): Record<string, BalanceEntry> {
    return Object.fromEntries(
      [...this.holdings].map(([currency, total]) => {
        const used = this.reservedOf(currency);
        return [currency, { free: fromUnits(total - used), used: fromUnits(used), total: fromUnits(total) }];
      }),
    );
  }

  /** Every order of the account, oldest first, as fetchOrder answers it */
  public static getOrders() {
    return [...this.book.values()].map(order => this.toCcxtOrder(order));
  }

  /**
   * Places an order on the book before the run, as one placed by hand or by an earlier run: open, resting, what it filled booked as
   * already traded (its trades are none of this run). Returns its id. It reserves what it holds, and a LIMIT one trades with the
   * predefined candles served from then on, as any order resting on the book, at Binance's fees.
   */
  public static addOpenOrder({ symbol, side, type, amount, price, filled = 0, triggerPrice }: OpenOrderSeed): string {
    const id = String(++this.orderCount);
    const timestamp = Date.now();
    const filledUnits = toUnits(filled);
    const [base, quote] = symbol.split('/');
    this.book.set(id, {
      id,
      symbol,
      market: SEED_MARKETS[symbol] ?? { base, quote, ...BINANCE_SPOT_FEES },
      type,
      side,
      amount: toUnits(amount),
      filled: filledUnits,
      cost: price === undefined ? 0n : multiplyUnits(filledUnits, price),
      price,
      triggerPrice,
      status: 'open',
      timestamp,
      lastUpdateTimestamp: timestamp,
      isMatchedAtPlacement: true,
      candlesSeen: this.predefinedCandlesIndex[symbol] ?? 0,
    });
    return id;
  }

  public id = 'binance';
  public name = 'binance';
  public has = {
    fetchOHLCV: true,
    fetchTickers: true,
    fetchTicker: true,
    createOrder: true,
    createLimitOrder: true,
    createMarketOrder: true,
    fetchMyTrades: true,
    fetchBalance: true,
    fetchOpenOrders: true,
    fetchOrder: true,
    cancelOrder: true,
    // Binance has a testnet, which checkMandatoryFeatures requires of a sandbox configuration
    sandbox: true,
  };

  /**
   * The markets as ccxt's binance builds them, the fields CCXTExchange.getMarketData reads: the maker and taker fees of a spot market,
   * and limits.market, Binance's MARKET_LOT_SIZE, whose maximum is lower than LOT_SIZE's (limits.amount) and whose minimum Binance
   * leaves at 0. Without them getMarketData gave no fee and no market range: the simulator of paper trading charged nothing, and the
   * paper flows pinned figures without fees.
   */
  public markets: Record<string, MockMarket> = buildMarkets();

  /** How ccxt's binance counts the precision of a market: as a tick, the step of a price or of an amount (see decimalToPrecision) */
  public precisionMode: number = TICK_SIZE;
  public paddingMode: number = NO_PADDING;
  /** What the client was built with, as ccxt's constructor names it: the keys, the options, sandbox… */
  public readonly userConfig: any;
  /** The keys of the client, which ccxt reads from userConfig: the private client alone holds them */
  public apiKey?: string;
  public secret?: string;
  /** Set by setSandboxMode, as ccxt sets it: the client sends its requests to the testnet */
  public isSandboxModeEnabled = false;

  /**
   * ccxt options bag, read and written by CCXTExchange.loadMarkets (Hyperliquid's learned spotCurrencyMapping). Empty, whatever the
   * options of userConfig, which ccxt merges into its own: a flow reads what CCXTExchange writes there
   */
  public options: Record<string, unknown> = {};

  /**
   * Built as a ccxt client is, kept for the scenarios to read (see clients and userConfig): a client built with `sandbox` (or
   * `testnet`) set goes to the testnet, as ccxt's constructor calls setSandboxMode(true) then
   */
  constructor(userConfig: any) {
    this.userConfig = userConfig;
    this.apiKey = userConfig?.apiKey;
    this.secret = userConfig?.secret;
    if (userConfig?.sandbox || userConfig?.testnet) this.setSandboxMode(true);
    MockCCXTExchange.clients.push(this);
  }

  /** As ccxt's: the requests of the client go to the testnet of the exchange, or back to the exchange itself */
  setSandboxMode(enabled: boolean) {
    this.isSandboxModeEnabled = enabled;
  }

  /** The root of the URLs the client sends its requests to: Binance's spot testnet in sandbox mode */
  private get apiUrl() {
    return this.isSandboxModeEnabled ? 'https://testnet.binance.vision' : 'https://api.binance.com';
  }

  async loadMarkets() {
    return this.markets;
  }

  /** ccxt shares the loaded catalogue of another client instead of downloading it again (CCXTExchange.loadMarkets) */
  setMarketsFromExchange(source: MockCCXTExchange) {
    this.markets = source.markets;
    return this;
  }

  market(symbol: string) {
    if (!this.markets[symbol]) {
      // Return default if not found
      return {
        limits: {
          price: { min: 0, max: Infinity },
          amount: { min: 0, max: Infinity },
          cost: { min: 0, max: Infinity },
        },
        precision: { price: 1e-8, amount: 1e-8 },
      };
    }
    return this.markets[symbol];
  }

  /** As ccxt's numberToString (see the function of the same name) */
  numberToString(value: number | string) {
    return numberToString(value);
  }

  /**
   * As ccxt's decimalToPrecision in the modes ccxt's binance rounds with: TICK_SIZE counting (a precision that is a step), TRUNCATE or
   * ROUND, no padding. Any other mode throws: the mock does not round as ccxt would there.
   */
  decimalToPrecision(value: number | string, roundingMode: number, precision: number | string, countingMode = 2, paddingMode = 5) {
    if (countingMode !== TICK_SIZE || paddingMode !== NO_PADDING)
      throw new Error(`The mock rounds in the TICK_SIZE counting mode without padding only, got modes ${countingMode} and ${paddingMode}`);
    if (roundingMode !== TRUNCATE && roundingMode !== ROUND)
      throw new Error(`The mock rounds with TRUNCATE or ROUND only, got the rounding mode ${roundingMode}`);
    return roundToTick(value, precision, roundingMode);
  }

  /** As ccxt's priceToPrecision: the price rounded to the tick of the market, a half up; one rounded to 0 is refused */
  priceToPrecision(symbol: string, price: number) {
    const { precision } = this.market(symbol);
    const result = this.decimalToPrecision(price, ROUND, precision.price, this.precisionMode, this.paddingMode);
    if (result === '0')
      throw new MockInvalidOrder(
        `binance price of ${symbol} must be greater than minimum price precision of ${numberToString(precision.price)}`,
      );
    return result;
  }

  /** As ccxt's amountToPrecision: the amount truncated to the step of the market; one truncated to 0 is refused */
  amountToPrecision(symbol: string, amount: number) {
    const { precision } = this.market(symbol);
    const result = this.decimalToPrecision(amount, TRUNCATE, precision.amount, this.precisionMode, this.paddingMode);
    if (result === '0')
      throw new MockInvalidOrder(
        `binance amount of ${symbol} must be greater than minimum amount precision of ${numberToString(precision.amount)}`,
      );
    return result;
  }

  /**
   * The last price of the pair, as a ticker follows the candles: for a pair given predefined candles, the close of the last one served,
   * the open of the first before any is; else the synthetic price at the time of the call. The ticker read the synthetic price alone:
   * in the paper flows, whose candles trade at 100, the Trader's price and the exchange.price of every order event were 10,000.
   */
  private static lastPrice(symbol: string): number {
    const candles = this.predefinedCandles[symbol] ?? [];
    if (!candles.length) return syntheticPrice(symbol, Date.now());
    const served = this.predefinedCandlesIndex[symbol] ?? 0;
    return served ? candles[served - 1].close : (candles[0].open ?? candles[0].close);
  }

  async fetchTickers(symbols: string[]) {
    const tickers: Record<string, any> = {};
    for (const symbol of symbols) {
      tickers[symbol] = await this.fetchTicker(symbol);
    }
    return tickers;
  }

  /** The last price as the bid, the ask and the last trade (see lastPrice) */
  async fetchTicker(symbol: string) {
    const price = MockCCXTExchange.lastPrice(symbol);
    const timestamp = Date.now();
    return { symbol, timestamp, datetime: new Date(timestamp).toISOString(), bid: price, ask: price, last: price, close: price };
  }

  /**
   * The 1-minute candles of the pair as ccxt's binance hands them over: sorted, from the first at or after `since`, `limit` of them at
   * most, or the latest ones without `since` (see existingMinutes); the timeframe is not read. A pair given predefined candles gets the
   * next one alone instead, until none is left. Each fault the statics set fails the call before anything is served.
   */
  async fetchOHLCV(symbol: string, _timeframe: string, since?: number, limit?: number): Promise<OHLCV[]> {
    if (MockCCXTExchange.shouldThrowExchangeError) throw new MockExchangeError('Simulated Exchange Error');
    if (MockCCXTExchange.shouldThrowError) throw new MockNetworkError('Simulated Network Error');
    if (MockCCXTExchange.networkErrorsToThrow > 0) {
      MockCCXTExchange.networkErrorsToThrow--;
      throw new MockNetworkError('Simulated Network Error');
    }

    const predefinedCandle = MockCCXTExchange.servePredefinedCandle(symbol, since);
    const page = predefinedCandle ? [predefinedCandle] : this.serveSyntheticPage(symbol, since, limit);
    this.pagesServed.set(symbol, (this.pagesServed.get(symbol) ?? 0) + 1);
    return page;
  }

  /** The next predefined candle of the pair, stamped with `since` (the time of the call without it), or undefined once all were served */
  private static servePredefinedCandle(symbol: string, since?: number): OHLCV | undefined {
    const candles = this.predefinedCandles[symbol] ?? [];
    const index = this.predefinedCandlesIndex[symbol] ?? 0;
    if (index >= candles.length) return undefined;
    this.predefinedCandlesIndex[symbol] = index + 1;

    const { open, high, low, close, volume } = completeCandle(candles[index]);
    return [since ?? Date.now(), open, high, low, close, volume];
  }

  /** A page of synthetic candles (see existingMinutes), with the lies the statics tell */
  private serveSyntheticPage(symbol: string, since: number | undefined, limit: number | undefined): OHLCV[] {
    const size = Math.min(limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    let page = MockCCXTExchange.existingMinutes(symbol, since, size).map(start => toOHLCV(generateSyntheticCandle(symbol, start)));
    if (page.length && !this.firstMinuteServed.has(symbol)) this.firstMinuteServed.set(symbol, page[0][0]);

    const period = MockCCXTExchange.emitDuplicatesEveryXCandle;
    const pageNumber = this.pagesServed.get(symbol) ?? 0;
    const firstMinute = this.firstMinuteServed.get(symbol);
    if (period && pageNumber && pageNumber % period === 0 && firstMinute !== undefined)
      page = page.map(([, open, high, low, close, volume]): OHLCV => [firstMinute, open, high, low, close, volume]);

    if (MockCCXTExchange.emitFutureCandles) page = [toOHLCV(generateSyntheticCandle(symbol, Date.now() + 5 * ONE_MINUTE)), ...page];
    return page;
  }

  /**
   * The starts of the candles the exchange serves, `size` of them at most, from the first minute at or after `since`, or the latest ones
   * without it: every minute up to the one in progress, which Binance serves unfinished, none after it, and none of the gaps of the pair,
   * which the page goes on after. The mock cut its page to a window of `limit` minutes and took the gaps out of it, as no exchange
   * does: a gap longer than a page ended the history there, and the refusal of a gap longer than the gap filler fills was out of reach.
   */
  private static existingMinutes(symbol: string, since: number | undefined, size: number): number[] {
    const gaps = Array.isArray(this.simulatedGaps) ? this.simulatedGaps : (this.simulatedGaps[symbol] ?? []);
    const gapAt = (minute: number) => gaps.find(({ start, end }) => minute >= start && minute < end);
    const minuteInProgress = minuteOf(Date.now());
    const minutes: number[] = [];

    if (since === undefined) {
      for (let minute = minuteInProgress; minutes.length < size && Number.isFinite(minute); ) {
        const gap = gapAt(minute);
        if (gap) {
          // On to the last minute before the gap
          minute = Math.ceil(gap.start / ONE_MINUTE) * ONE_MINUTE - ONE_MINUTE;
        } else {
          minutes.push(minute);
          minute -= ONE_MINUTE;
        }
      }
      return minutes.reverse();
    }

    for (let minute = Math.ceil(since / ONE_MINUTE) * ONE_MINUTE; minutes.length < size && minute <= minuteInProgress; ) {
      const gap = gapAt(minute);
      if (gap) {
        // On to the first minute at or after the end of the gap: none after a gap without an end
        minute = Math.ceil(gap.end / ONE_MINUTE) * ONE_MINUTE;
      } else {
        minutes.push(minute);
        minute += ONE_MINUTE;
      }
    }
    return minutes;
  }

  /* -------------------------------------------------------------------------- */
  /*                      THE ACCOUNT: PRIVATE API MOCKS                         */
  /* -------------------------------------------------------------------------- */

  /**
   * The trades of the account on the pair (all pairs without one), from the first at or after `since`, sorted by time, `limit` of them
   * at most, as ccxt's binance hands over those of GET /api/v3/myTrades: no fee rate, the fee in the currency it was taken in.
   */
  async fetchMyTrades(symbol?: string, since?: number, limit?: number) {
    MockCCXTExchange.accountCalls.push({ method: 'fetchMyTrades', symbol, since, limit });
    MockCCXTExchange.settleBook();
    const trades = MockCCXTExchange.mockTrades
      .filter(trade => (symbol === undefined || trade.symbol === symbol) && (since === undefined || trade.timestamp >= since))
      .sort((a, b) => a.timestamp - b.timestamp);
    return trades.slice(0, Math.min(limit ?? DEFAULT_TRADES_PAGE_SIZE, MAX_TRADES_PAGE_SIZE));
  }

  /** The balance of every currency the account holds, as ccxt hands it over (see getBalances), by currency and by free, used and total */
  async fetchBalance(_params?: Record<string, unknown>): Promise<Record<string, any>> {
    MockCCXTExchange.accountCalls.push({ method: 'fetchBalance' });
    MockCCXTExchange.settleBook();
    const balances = MockCCXTExchange.getBalances();
    const byPart = (part: keyof BalanceEntry) =>
      Object.fromEntries(Object.entries(balances).map(([currency, entry]) => [currency, entry[part]]));
    const timestamp = Date.now();
    return {
      info: {},
      timestamp,
      datetime: new Date(timestamp).toISOString(),
      ...balances,
      free: byPart('free'),
      used: byPart('used'),
      total: byPart('total'),
    };
  }

  /**
   * Places an order as Binance does through ccxt: its amount truncated to the step of the market and the price of a LIMIT order rounded
   * to its tick (ccxt's amountToPrecision and priceToPrecision, as ccxt's binance builds the request), refused when the free balance does
   * not cover it (a MARKET order valued at the ticker), then matched (see matchesOrdersAtCreation and matchOrder). Answered with the
   * order as ccxt parses Binance's answer, unless a fault befalls it (see creationFaults), or shouldThrowError or shouldThrowOnCreateOrder
   * fail it first.
   */
  async createOrder(symbol: string, type: string, side: string, amount: number, price?: number) {
    MockCCXTExchange.accountCalls.push({ method: 'createOrder', symbol, type, side, amount, price });
    if (MockCCXTExchange.shouldThrowError || MockCCXTExchange.shouldThrowOnCreateOrder) {
      throw new MockNetworkError('Simulated Network Error');
    }
    MockCCXTExchange.settleBook();

    // The market as the client has it, the one the public client loaded (see setMarketsFromExchange)
    const market = this.markets[symbol];
    if (!market) throw new MockBadSymbol(`binance does not have market symbol ${symbol}`);
    // ccxt's binance sends the side and the type upper-cased, whatever their case: CCXTExchange gives the side as Gekko writes it (BUY)
    const [orderSide, orderType] = [side.toLowerCase(), type.toLowerCase()];
    if (orderSide !== 'buy' && orderSide !== 'sell') throw new MockBadRequest(`binance {"code":-1117,"msg":"Invalid side."}`);
    if (orderType !== 'market' && orderType !== 'limit') throw new MockBadRequest(`binance {"code":-1116,"msg":"Invalid orderType."}`);
    if (orderType === 'limit' && price === undefined)
      throw new MockInvalidOrder('binance createOrder() requires a price argument for a limit order');
    const orderAmount = toUnits(Number(this.amountToPrecision(symbol, amount)));
    const orderPrice = orderType === 'limit' ? Number(this.priceToPrecision(symbol, price!)) : undefined;

    // What the order takes from the account: a BUY its cost in the currency, valued at its price or at the ticker, a SELL its amount
    const [needed, currency] =
      orderSide === 'buy'
        ? [multiplyUnits(orderAmount, orderPrice ?? MockCCXTExchange.lastPrice(symbol)), market.quote]
        : [orderAmount, market.base];
    if (needed > MockCCXTExchange.freeUnitsOf(currency))
      throw new MockInsufficientFunds('binance Account has insufficient balance for requested action.');

    const timestamp = Date.now();
    const { base, quote, maker, taker } = market;
    const order: BookedOrder = {
      id: String(++MockCCXTExchange.orderCount),
      symbol,
      market: { base, quote, maker, taker },
      type: orderType,
      side: orderSide,
      amount: orderAmount,
      filled: 0n,
      cost: 0n,
      price: orderPrice,
      status: 'open',
      timestamp,
      lastUpdateTimestamp: timestamp,
      isMatchedAtPlacement: false,
      candlesSeen: MockCCXTExchange.predefinedCandlesIndex[symbol] ?? 0,
    };
    MockCCXTExchange.book.set(order.id, order);
    const tradesBefore = MockCCXTExchange.mockTrades.length;
    if (MockCCXTExchange.matchesOrdersAtCreation) MockCCXTExchange.matchOrder(order);

    const fault = MockCCXTExchange.creationFaults.shift();
    if (fault === 'answerLost') throw new MockRequestTimeout(`binance POST ${this.apiUrl}/api/v3/order request timed out (10000 ms)`);
    if (fault === 'statusUnknown')
      throw new MockOperationFailed(
        'binance {"code":-1006,"msg":"An unexpected response was received from the message bus. Execution status unknown."}',
      );
    if (fault === 'answerWithoutId') return unreadOrder(symbol);
    // Binance's answer holds the fills of the matching (fills), which ccxt parses as the trades of the order
    return { ...MockCCXTExchange.toCcxtOrder(order, timestamp), trades: MockCCXTExchange.mockTrades.slice(tradesBefore) };
  }

  /** Cancels an open order, as DELETE /api/v3/order does: an order that is not open, or that the account never placed, is unknown */
  async cancelOrder(id: string, symbol?: string) {
    MockCCXTExchange.accountCalls.push({ method: 'cancelOrder', id, symbol });
    MockCCXTExchange.settleBook();
    const order = MockCCXTExchange.book.get(id);
    if (!order || order.status !== 'open') throw new MockOrderNotFound('binance {"code":-2011,"msg":"Unknown order sent."}');
    const timestamp = Date.now();
    Object.assign(order, { status: 'canceled', lastUpdateTimestamp: timestamp });
    // Binance dates its answer with the time of the cancelation (transactTime), which ccxt reads as the time of the order
    return MockCCXTExchange.toCcxtOrder(order, timestamp);
  }

  /** The order as GET /api/v3/order answers it: dated with its creation (time) and its last update (updateTime) */
  async fetchOrder(id: string, symbol?: string) {
    MockCCXTExchange.accountCalls.push({ method: 'fetchOrder', id, symbol });
    MockCCXTExchange.settleBook();
    const order = MockCCXTExchange.book.get(id);
    if (!order) throw new MockOrderNotFound('binance {"code":-2013,"msg":"Order does not exist."}');
    return MockCCXTExchange.toCcxtOrder(order);
  }

  /** The orders open on the pair (on every pair without one), oldest first, as GET /api/v3/openOrders answers them */
  async fetchOpenOrders(symbol?: string) {
    MockCCXTExchange.accountCalls.push({ method: 'fetchOpenOrders', symbol });
    MockCCXTExchange.settleBook();
    return [...MockCCXTExchange.book.values()]
      .filter(order => order.status === 'open' && (symbol === undefined || order.symbol === symbol))
      .map(order => MockCCXTExchange.toCcxtOrder(order));
  }

  /**
   * Matches every open order against the market, as the exchange has by the time it answers a call to the account: the mock has no
   * clock of its own, its book moves when it is asked
   */
  private static settleBook() {
    for (const order of this.book.values()) if (order.status === 'open') this.matchOrder(order);
  }

  /**
   * Matches an open order against the market. As it is placed (at its creation, or at the next call when the exchange answered first),
   * a marketable one executes in full at the ticker, as a taker: a MARKET order, a LIMIT BUY at or above the ask, a LIMIT SELL at or
   * below the bid. A LIMIT order that rests then trades at its price, as a maker, with each predefined candle of its pair served after
   * it was placed that reaches it (the low for a BUY, the high for a SELL), for as much as the volume of that candle, which the orders
   * it fills share. No other order trades: a conditional one waits off the book, and synthetic candles fill nothing.
   */
  private static matchOrder(order: BookedOrder) {
    const { symbol, side, type, price } = order;
    if (!order.isMatchedAtPlacement) {
      order.isMatchedAtPlacement = true;
      const ticker = this.lastPrice(symbol);
      const isMarketable =
        type === 'market' || (type === 'limit' && price !== undefined && (side === 'buy' ? price >= ticker : price <= ticker));
      if (isMarketable) return this.fill(order, order.amount - order.filled, ticker, 'taker');
    }
    if (type !== 'limit' || price === undefined || order.triggerPrice !== undefined) return;

    const candles = this.predefinedCandles[symbol] ?? [];
    const served = this.predefinedCandlesIndex[symbol] ?? 0;
    for (let index = order.candlesSeen; index < served && order.status === 'open'; index++) {
      const { low, high, volume } = completeCandle(candles[index]);
      if (side === 'buy' ? low > price : high < price) continue;
      const key = `${symbol} ${index}`;
      const traded = this.volumeTraded.get(key) ?? 0n;
      const amount = minUnits(toUnits(volume) - traded, order.amount - order.filled);
      if (amount <= 0n) continue;
      this.volumeTraded.set(key, traded + amount);
      this.fill(order, amount, price, 'maker');
    }
    order.candlesSeen = Math.max(order.candlesSeen, served);
  }

  /**
   * Books a fill of the order, at `price`, as Binance books a spot trade: the cost in the currency, rounded to 8 decimals, and the fee
   * of the market for a taker or a maker, taken in what the trade brings in, the asset of a BUY, the currency of a SELL (no BNB to pay
   * it with). A BUY of 1 BTC at 100 costs 100 USDT and brings 0.999 BTC; a SELL of 1 BTC at 110 takes 1 BTC and brings 109.89 USDT.
   */
  private static fill(order: BookedOrder, amount: bigint, price: number, takerOrMaker: TakerOrMaker) {
    const { base, quote, maker, taker } = order.market;
    const cost = multiplyUnits(amount, price);
    const isBuy = order.side === 'buy';
    const fee = multiplyUnits(isBuy ? amount : cost, takerOrMaker === 'taker' ? taker : maker);
    const feeCurrency = isBuy ? base : quote;
    this.addHolding(base, isBuy ? amount - fee : -amount);
    this.addHolding(quote, isBuy ? -cost : cost - fee);

    const timestamp = Date.now();
    order.filled += amount;
    order.cost += cost;
    order.lastTradeTimestamp = timestamp;
    order.lastUpdateTimestamp = timestamp;
    if (order.filled >= order.amount) order.status = 'closed';

    const id = String(++this.tradeCount);
    const feeEntry = { cost: fromUnits(fee), currency: feeCurrency };
    this.mockTrades.push({
      info: {
        symbol: order.symbol.replace('/', ''),
        id,
        orderId: order.id,
        price: numberToString(price),
        qty: fromScaled(amount, BOOKED_DECIMALS),
        quoteQty: fromScaled(cost, BOOKED_DECIMALS),
        commission: fromScaled(fee, BOOKED_DECIMALS),
        commissionAsset: feeCurrency,
        time: timestamp,
        isBuyer: isBuy,
        isMaker: takerOrMaker === 'maker',
      },
      timestamp,
      datetime: new Date(timestamp).toISOString(),
      symbol: order.symbol,
      id,
      order: order.id,
      type: undefined,
      side: order.side,
      takerOrMaker,
      price,
      amount: fromUnits(amount),
      cost: fromUnits(cost),
      fee: feeEntry,
      fees: [feeEntry],
    });
  }

  private static addHolding(currency: string, units: bigint) {
    this.holdings.set(currency, (this.holdings.get(currency) ?? 0n) + units);
  }

  /** What the open orders reserve of a currency: a BUY the cost of what it has left at its price, a SELL what it has left of the asset */
  private static reservedOf(currency: string): bigint {
    let reserved = 0n;
    for (const order of this.book.values()) {
      if (order.status !== 'open') continue;
      const { base, quote } = order.market;
      const left = order.amount - order.filled;
      if (order.side === 'sell' && base === currency) reserved += left;
      if (order.side === 'buy' && quote === currency && order.price !== undefined) reserved += multiplyUnits(left, order.price);
    }
    return reserved;
  }

  private static freeUnitsOf(currency: string): bigint {
    return (this.holdings.get(currency) ?? 0n) - this.reservedOf(currency);
  }

  /**
   * An order as ccxt's binance parses an answer about it. A creation and a cancelation are dated with the time of their answer
   * (`answeredAt`, Binance's transactTime), which ccxt reads as the time of the order; a query with its creation (time) and its last
   * update (updateTime). The price of a MARKET order is the mean price of its fills, as ccxt gives it, none before it fills.
   */
  private static toCcxtOrder(order: BookedOrder, answeredAt?: number) {
    const timestamp = answeredAt ?? order.timestamp;
    const filled = fromUnits(order.filled);
    // The cost over the fill, to 18 decimals, as ccxt's Precise divides them
    const average = order.filled > 0n ? Number(fromScaled((order.cost * 10n ** 18n) / order.filled, 18)) : undefined;
    return {
      info: { symbol: order.symbol.replace('/', ''), orderId: order.id, status: binanceStatusOf(order) },
      id: order.id,
      clientOrderId: undefined,
      timestamp,
      datetime: new Date(timestamp).toISOString(),
      lastTradeTimestamp: order.lastTradeTimestamp,
      lastUpdateTimestamp: answeredAt ?? order.lastUpdateTimestamp,
      symbol: order.symbol,
      type: order.type,
      timeInForce: order.type === 'market' ? 'IOC' : 'GTC',
      postOnly: false,
      reduceOnly: undefined,
      side: order.side,
      price: order.price ?? average,
      triggerPrice: order.triggerPrice,
      amount: fromUnits(order.amount),
      cost: fromUnits(order.cost),
      average,
      filled,
      remaining: fromUnits(order.amount - order.filled),
      status: order.status,
      fee: undefined,
      trades: [],
      fees: [],
    };
  }
}

const mockCcxtErrorClasses = {
  BaseError: MockBaseError,
  OperationFailed: MockOperationFailed,
  NetworkError: MockNetworkError,
  RequestTimeout: MockRequestTimeout,
  ExchangeError: MockExchangeError,
  InvalidOrder: MockInvalidOrder,
  OrderNotFound: MockOrderNotFound,
  InsufficientFunds: MockInsufficientFunds,
  BadRequest: MockBadRequest,
  BadSymbol: MockBadSymbol,
};

/**
 * The module to hand to `mock.module('ccxt', ...)`: the exchange class, the error classes and the precision constants, as default and
 * named exports
 */
export const createCcxtModuleMock = () => ({
  default: { binance: MockCCXTExchange, ...mockCcxtErrorClasses, ...PRECISION_CONSTANTS },
  binance: MockCCXTExchange,
  ...mockCcxtErrorClasses,
  ...PRECISION_CONSTANTS,
});
