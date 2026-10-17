import { GekkoError } from '@errors/gekko.error';
import { StrategyOrder } from '@models/advice.types';
import { CandleBucket } from '@models/event.types';
import { Portfolio } from '@models/portfolio.types';
import { TradingPair } from '@models/utility.types';
import { MarketData } from '@services/exchange/exchange.types';
import { noop } from 'lodash-es';
import { UUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PositionBook } from './positionBook';
import { BTC_ETH_TRADED_INFO, flatBucket } from './positionBook.mock';
import { LoggedLine, OrderRecorder, playSteps, relayOrderOutcome, UNKNOWN_ORDER_ID } from './positionTracker.mock';
import { LoggerFn } from './strategy.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
const SOL: TradingPair = 'SOL/USDT';
const XRP: TradingPair = 'XRP/USDT';
/** The id OrderRecorder gives the first order created */
const FIRST_ORDER_ID: UUID = '00000000-0000-0000-0000-000000000001';
const RULE = 'each BUY takes an equal share of the free currency among the pairs not invested, each SELL sells all of its asset';
const NEXT_SKIPS = '; the next skips of this pair are logged at debug level until a BUY of it is placed';

/** The first `count` of BTC/USDT, ETH/USDT, SOL/USDT, XRP/USDT, ADA/USDT and DOT/USDT, in that order */
const pairsOf = (count: number) => ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOT'].slice(0, count).map(asset => `${asset}/USDT` as TradingPair);
/** A bucket holding a candle of each of `pairs`, in their order, as init gets it */
const bucketOf = (pairs: TradingPair[]): CandleBucket => flatBucket(Object.fromEntries(pairs.map(pair => [pair, 100])));
/** A portfolio holding `free` of `currency` */
const holdingCurrency = (free: number, currency = 'USDT'): Portfolio => new Map([[currency, { free, used: 0, total: free }]]);
/** The market data of `pairs`, each with a minimum cost of `minimum`, a bound only as a number above 0 */
const withMinimumCost = (pairs: TradingPair[], minimum?: number) =>
  new Map<TradingPair, MarketData>(pairs.map(pair => [pair, { cost: { min: minimum } }]));

describe('PositionBook', () => {
  let book: PositionBook;
  let orders: OrderRecorder;
  let logs: LoggedLine[];
  let portfolio: Portfolio;
  let marketData: Map<TradingPair, MarketData>;

  const log: LoggerFn = (level, message) => {
    logs.push({ level, message });
  };
  /** The params of a candle hook, as a strategy hands them to buy and sell: the portfolio and the market data of the test */
  const params = () => ({ portfolio, tools: { createOrder: orders.createOrder, log, marketData } });
  /** Tracks `pairs`, as init does on a bucket of them */
  const track = (pairs: TradingPair[]) => book.track({ candle: bucketOf(pairs), tools: { log } });
  /**
   * Plays the steps (see playSteps): 'buy<ASSET>' and 'sell<ASSET>' place a STICKY order of <ASSET>/USDT through the book, 'stop<ASSET>'
   * is the SELL of a trailing stop there, which the StrategyManager creates and the book adopts, and 'usdt<free>' sets the portfolio of
   * the next candles to <free> USDT
   */
  const play = (steps: string) =>
    playSteps(steps, book, orders, step => {
      const [, action, name] = /^(buy|sell|stop|usdt)([A-Z]+|\d+)$/.exec(step) ?? [];
      const symbol = `${name}/USDT` as TradingPair;
      if (action === 'buy') book.buy({ type: 'STICKY', symbol }, params());
      else if (action === 'sell') book.sell({ type: 'STICKY', symbol }, params());
      else if (action === 'stop') book.adoptSell(orders.createOrder({ type: 'MARKET', side: 'SELL', symbol }), symbol);
      else if (action === 'usdt') portfolio = holdingCurrency(Number(name));
      else throw new Error(`Unknown step: ${step}`);
    });
  /** The position on `pair`: flat or long, and pending while an order of its own waits for its outcome */
  const positionOn = (pair: TradingPair) => `${book.isLong(pair) ? 'long' : 'flat'}${book.isPendingOrder(pair) ? ', pending' : ''}`;

  beforeEach(() => {
    book = new PositionBook();
    orders = new OrderRecorder();
    logs = [];
    portfolio = new Map();
    marketData = new Map();
  });

  describe('track', () => {
    it('tracks no pair before it is called', () => {
      expect(book.pairs).toEqual([]);
    });

    // The bucket holds a candle of every watched pair, in the order of watch.assets
    it.each`
      case             | pairs
      ${'one pair'}    | ${[BTC]}
      ${'three pairs'} | ${[ETH, BTC, SOL]}
    `('tracks the pairs of the bucket in its order: $case', ({ pairs }) => {
      track(pairs);
      expect(book.pairs).toEqual(pairs);
    });

    it('tracks each pair flat, nothing pending', () => {
      track([BTC, ETH, SOL]);
      expect(book.pairs.map(positionOn)).toEqual(['flat', 'flat', 'flat']);
    });

    it.each`
      case             | pairs              | expected
      ${'one pair'}    | ${[BTC]}           | ${[]}
      ${'two pairs'}   | ${[BTC, ETH]}      | ${[BTC_ETH_TRADED_INFO]}
      ${'three pairs'} | ${[ETH, BTC, SOL]} | ${[{ level: 'info', message: `Trading ETH/USDT, BTC/USDT and SOL/USDT: ${RULE}` }]}
    `('says once, at info level, which pairs it trades and how, but for one pair: $case', ({ pairs, expected }) => {
      track(pairs);
      expect(logs).toEqual(expected);
    });

    it('refuses a second call', () => {
      track([BTC]);
      expect(() => track([ETH])).toThrow(
        new GekkoError('strategy', 'The position book tracks its pairs already: track is called once, from init'),
      );
    });

    it('keeps the pairs of its first call after refusing a second', () => {
      track([BTC]);
      try {
        track([ETH]);
      } catch {
        // Refused, as the test above asserts
      }
      expect(book.pairs).toEqual([BTC]);
    });
  });

  describe('a pair not tracked', () => {
    it.each`
      query
      ${'isLong'}
      ${'isPendingOrder'}
      ${'canBuy'}
      ${'canSell'}
    `('answers $query with false', ({ query }) => {
      track([BTC, ETH]);
      expect(book[query as 'isLong' | 'isPendingOrder' | 'canBuy' | 'canSell'](XRP)).toBe(false);
    });

    // A tracked pair can buy: before track, none can
    it('lets no pair buy before track', () => {
      expect(book.canBuy(BTC)).toBe(false);
    });

    it.each`
      case                                      | tracked            | act                                                           | message
      ${'a BUY'}                                | ${[BTC, ETH]}      | ${() => book.buy({ type: 'STICKY', symbol: XRP }, params())}  | ${'Impossible to place the BUY STICKY order on XRP/USDT: the position book does not track it (it tracks BTC/USDT and ETH/USDT)'}
      ${'a SELL'}                               | ${[BTC, ETH]}      | ${() => book.sell({ type: 'MARKET', symbol: XRP }, params())} | ${'Impossible to place the SELL MARKET order on XRP/USDT: the position book does not track it (it tracks BTC/USDT and ETH/USDT)'}
      ${'the SELL of a trailing stop to adopt'} | ${[BTC, ETH]}      | ${() => book.adoptSell(FIRST_ORDER_ID, XRP)}                  | ${'Impossible to adopt the SELL 00000000-0000-0000-0000-000000000001 on XRP/USDT: the position book does not track it (it tracks BTC/USDT and ETH/USDT)'}
      ${'a BUY, one pair tracked'}              | ${[BTC]}           | ${() => book.buy({ type: 'STICKY', symbol: XRP }, params())}  | ${'Impossible to place the BUY STICKY order on XRP/USDT: the position book does not track it (it tracks BTC/USDT)'}
      ${'a BUY, three pairs tracked'}           | ${[BTC, ETH, SOL]} | ${() => book.buy({ type: 'LIMIT', symbol: XRP }, params())}   | ${'Impossible to place the BUY LIMIT order on XRP/USDT: the position book does not track it (it tracks BTC/USDT, ETH/USDT and SOL/USDT)'}
      ${'a BUY before track, no pair tracked'}  | ${undefined}       | ${() => book.buy({ type: 'STICKY', symbol: BTC }, params())}  | ${'Impossible to place the BUY STICKY order on BTC/USDT: the position book does not track it (it tracks no pair until init calls track)'}
    `('refuses $case with a GekkoError', ({ tracked, act, message }) => {
      if (tracked) track(tracked);
      expect(act).toThrow(new GekkoError('strategy', message));
    });
  });

  describe('positions', () => {
    beforeEach(() => {
      track([BTC, ETH]);
    });

    // An outcome reports nothing of an execution, unless its step gives the asset left free after it ('errored:1:0.5', see playSteps)
    it.each`
      case                                              | steps                                                          | btc                | eth
      ${'nothing placed'}                               | ${''}                                                          | ${'flat'}          | ${'flat'}
      ${'a BTC BUY placed'}                             | ${'buyBTC'}                                                    | ${'flat, pending'} | ${'flat'}
      ${'the BTC BUY completed'}                        | ${'buyBTC completed:1'}                                        | ${'long'}          | ${'flat'}
      ${'an ETH BUY placed, BTC long'}                  | ${'buyBTC completed:1 buyETH'}                                 | ${'long'}          | ${'flat, pending'}
      ${'both BUYs completed, ETH first'}               | ${'buyBTC buyETH completed:2 completed:1'}                     | ${'long'}          | ${'long'}
      ${'the ETH BUY canceled, BTC long'}               | ${'buyBTC completed:1 buyETH canceled:2'}                      | ${'long'}          | ${'flat'}
      ${'the ETH BUY errored after buying 0.5 ETH'}     | ${'buyETH errored:1:0.5'}                                      | ${'flat'}          | ${'long'}
      ${'a BTC SELL placed, ETH long'}                  | ${'buyBTC buyETH completed:1 completed:2 sellBTC'}             | ${'long, pending'} | ${'long'}
      ${'the BTC SELL completed, ETH long'}             | ${'buyBTC buyETH completed:1 completed:2 sellBTC completed:3'} | ${'flat'}          | ${'long'}
      ${'the BTC SELL errored, nothing reported'}       | ${'buyBTC buyETH completed:1 completed:2 sellBTC errored:3'}   | ${'long'}          | ${'long'}
      ${'a stop SELL adopted on BTC'}                   | ${'buyBTC completed:1 stopBTC'}                                | ${'long, pending'} | ${'flat'}
      ${'the stop SELL completed'}                      | ${'buyBTC completed:1 stopBTC completed:2'}                    | ${'flat'}          | ${'flat'}
      ${'an order of neither completed, a BTC BUY due'} | ${'buyBTC completed:unknown'}                                  | ${'flat, pending'} | ${'flat'}
    `('reads $case: BTC $btc, ETH $eth', ({ steps, btc, eth }) => {
      play(steps);
      expect({ BTC: positionOn(BTC), ETH: positionOn(ETH) }).toEqual({ BTC: btc, ETH: eth });
    });

    it.each`
      case                                   | steps                                              | pair   | canBuy   | canSell
      ${'BTC flat, nothing pending'}         | ${''}                                              | ${BTC} | ${true}  | ${false}
      ${'BTC flat, its BUY pending'}         | ${'buyBTC'}                                        | ${BTC} | ${false} | ${false}
      ${'ETH flat beside a BTC BUY pending'} | ${'buyBTC'}                                        | ${ETH} | ${true}  | ${false}
      ${'BTC long'}                          | ${'buyBTC completed:1'}                            | ${BTC} | ${false} | ${true}
      ${'ETH flat beside BTC long'}          | ${'buyBTC completed:1'}                            | ${ETH} | ${true}  | ${false}
      ${'BTC long, its SELL pending'}        | ${'buyBTC completed:1 sellBTC'}                    | ${BTC} | ${false} | ${false}
      ${'ETH long beside a BTC SELL'}        | ${'buyBTC buyETH completed:1 completed:2 sellBTC'} | ${ETH} | ${false} | ${true}
    `('allows a BUY ($canBuy) and a SELL ($canSell) when $case', ({ steps, pair, canBuy, canSell }) => {
      play(steps);
      expect({ canBuy: book.canBuy(pair), canSell: book.canSell(pair) }).toEqual({ canBuy, canSell });
    });
  });

  describe('order hooks', () => {
    beforeEach(() => {
      track([BTC, ETH]);
    });

    // An outcome goes to the tracker of its order's pair: an order of a pair not tracked, or none, is no tracker's
    it.each`
      outcome        | order                                 | steps                           | relayed                                  | isOwn
      ${'completed'} | ${'its BTC BUY'}                      | ${'buyBTC'}                     | ${1}                                     | ${true}
      ${'canceled'}  | ${'its BTC BUY'}                      | ${'buyBTC'}                     | ${1}                                     | ${true}
      ${'errored'}   | ${'its BTC BUY'}                      | ${'buyBTC'}                     | ${1}                                     | ${true}
      ${'completed'} | ${'its ETH BUY, beside a BTC BUY'}    | ${'buyBTC buyETH'}              | ${2}                                     | ${true}
      ${'completed'} | ${'its BTC SELL'}                     | ${'buyBTC completed:1 sellBTC'} | ${2}                                     | ${true}
      ${'completed'} | ${'a stop SELL it adopted'}           | ${'buyBTC completed:1 stopBTC'} | ${2}                                     | ${true}
      ${'completed'} | ${'an order of a pair not tracked'}   | ${'buyBTC'}                     | ${{ id: FIRST_ORDER_ID, symbol: XRP }}   | ${false}
      ${'canceled'}  | ${'an order of a pair not tracked'}   | ${'buyBTC'}                     | ${{ id: FIRST_ORDER_ID, symbol: XRP }}   | ${false}
      ${'errored'}   | ${'an order of a pair not tracked'}   | ${'buyBTC'}                     | ${{ id: FIRST_ORDER_ID, symbol: XRP }}   | ${false}
      ${'completed'} | ${'an order without a pair'}          | ${'buyBTC'}                     | ${{ id: UNKNOWN_ORDER_ID }}              | ${false}
      ${'completed'} | ${'another order of BTC'}             | ${'buyBTC'}                     | ${{ id: UNKNOWN_ORDER_ID, symbol: BTC }} | ${false}
      ${'completed'} | ${'its BTC BUY, relayed on ETH/USDT'} | ${'buyBTC'}                     | ${{ id: FIRST_ORDER_ID, symbol: ETH }}   | ${false}
      ${'completed'} | ${'an order already settled'}         | ${'buyBTC completed:1'}         | ${1}                                     | ${false}
    `('says whether $order, $outcome, was the order of the tracker of its pair ($isOwn)', ({ outcome, steps, relayed, isOwn }) => {
      play(steps);
      const order = typeof relayed === 'number' ? orders.created(relayed)! : relayed;
      expect(relayOrderOutcome(book, outcome, order)).toBe(isOwn);
    });
  });

  describe('buy', () => {
    const btcBuy = { type: 'STICKY', side: 'BUY', symbol: BTC } satisfies StrategyOrder;

    // The pairs not invested are those not long, a pair whose BUY is pending among them, and the pair asking
    it.each`
      case                                                         | count | steps                                              | allocation
      ${'one pair: all-in'}                                        | ${1}  | ${'buyBTC'}                                        | ${undefined}
      ${'two pairs flat: 50 %'}                                    | ${2}  | ${'buyBTC'}                                        | ${50}
      ${'three pairs flat: 100 / 3 rounded down'}                  | ${3}  | ${'buyBTC'}                                        | ${33.333333}
      ${'four pairs flat: 25 %'}                                   | ${4}  | ${'buyBTC'}                                        | ${25}
      ${'six pairs flat: 100 / 6 rounded down'}                    | ${6}  | ${'buyBTC'}                                        | ${16.666666}
      ${'two pairs, ETH long: all-in, the last pair not invested'} | ${2}  | ${'buyETH completed:1 buyBTC'}                     | ${undefined}
      ${'two pairs, the BUY of ETH pending: 50 %, ETH counted'}    | ${2}  | ${'buyETH buyBTC'}                                 | ${50}
      ${'two pairs, the SELL of ETH pending: all-in, ETH long'}    | ${2}  | ${'buyETH completed:1 sellETH buyBTC'}             | ${undefined}
      ${'two pairs, ETH sold: 50 %'}                               | ${2}  | ${'buyETH completed:1 sellETH completed:2 buyBTC'} | ${50}
      ${'two pairs, the BUY of ETH canceled: 50 %'}                | ${2}  | ${'buyETH canceled:1 buyBTC'}                      | ${50}
      ${'two pairs, the BUY of ETH errored after a fill: all-in'}  | ${2}  | ${'buyETH errored:1:0.5 buyBTC'}                   | ${undefined}
      ${'three pairs, ETH long: 50 %'}                             | ${3}  | ${'buyETH completed:1 buyBTC'}                     | ${50}
      ${'three pairs, ETH and SOL long: all-in'}                   | ${3}  | ${'buyETH buySOL completed:1 completed:2 buyBTC'}  | ${undefined}
      ${'two pairs, BTC long buying again: 50 %, BTC counted'}     | ${2}  | ${'buyBTC completed:1 buyBTC'}                     | ${50}
    `('allocates a BUY of BTC its share of the currency on $case', ({ count, steps, allocation }) => {
      track(pairsOf(count));
      play(steps);
      expect(orders.advices.at(-1)).toStrictEqual(allocation === undefined ? btcBuy : { ...btcBuy, allocation });
    });

    // Two signals on one candle are sized from one balance read: each pair whose BUY is pending is counted, so their shares are equal
    it.each`
      case                                                  | count | steps                                                                | allocations
      ${'two BUYs on one candle, then one after the other'} | ${4}  | ${'buyBTC buyETH completed:1 completed:2 buySOL completed:3 buyXRP'} | ${[25, 25, 50, undefined]}
      ${'two BUYs on one candle, then two on another'}      | ${4}  | ${'buyBTC buyETH completed:1 completed:2 buySOL buyXRP'}             | ${[25, 25, 50, 50]}
      ${'three BUYs on one candle, 99.999999 % in all'}     | ${3}  | ${'buyBTC buyETH buySOL'}                                            | ${[33.333333, 33.333333, 33.333333]}
    `('allocates each BUY its share on $case: $allocations', ({ count, steps, allocations }) => {
      track(pairsOf(count));
      play(steps);
      expect(orders.advices.map(({ allocation }) => allocation)).toEqual(allocations);
    });

    it('places the BUY as given, its price and its stop kept, with its side and its allocation', () => {
      track([BTC, ETH]);
      book.buy({ type: 'LIMIT', symbol: BTC, price: 90, trailing: { percentage: 5 } }, params());
      expect(orders.advices).toStrictEqual([
        { type: 'LIMIT', symbol: BTC, price: 90, trailing: { percentage: 5 }, allocation: 50, side: 'BUY' },
      ]);
    });

    it('returns the id of the BUY placed', () => {
      track([BTC]);
      expect(book.buy({ type: 'STICKY', symbol: BTC }, params())).toBe(FIRST_ORDER_ID);
    });
  });

  describe('sell', () => {
    beforeEach(() => {
      track([BTC, ETH]);
    });

    it.each`
      order                                         | created
      ${{ type: 'STICKY', symbol: ETH }}            | ${{ type: 'STICKY', symbol: ETH, side: 'SELL' }}
      ${{ type: 'LIMIT', symbol: ETH, price: 110 }} | ${{ type: 'LIMIT', symbol: ETH, price: 110, side: 'SELL' }}
    `('places an all-in SELL as given, with its side and no allocation, BTC flat: $created', ({ order, created }) => {
      play('buyETH completed:1');
      book.sell(order, params());
      expect(orders.advices.at(-1)).toStrictEqual(created);
    });

    it('returns the id of the SELL placed', () => {
      expect(book.sell({ type: 'STICKY', symbol: ETH }, params())).toBe(FIRST_ORDER_ID);
    });

    // The skip is the BUYs': a SELL brings the currency in
    it('places a SELL whatever the currency free', () => {
      portfolio = holdingCurrency(0);
      marketData = withMinimumCost([BTC, ETH], 10);
      book.sell({ type: 'STICKY', symbol: BTC }, params());
      expect(orders.advices).toStrictEqual([{ type: 'STICKY', symbol: BTC, side: 'SELL' }]);
    });
  });

  describe('a BUY below the minimum cost', () => {
    // 50 % of 20 USDT is 10 USDT, 9.5 USDT once 5 % is kept back for the fee: below a minimum of 10
    const SKIP_LINE =
      '[BTC/USDT] BUY skipped: 50 % of the 20 USDT free, 9.5 USDT once 5 % is kept back for the fee, is below the minimum cost of 10 USDT of the market: watch fewer pairs or fund the account';

    /** Tracks `pairs` without a word, the portfolio holding `free` of `currency`, each pair with a minimum cost of `minimum` */
    const setUp = (pairs: TradingPair[], free: number, minimum?: number, currency = 'USDT') => {
      book.track({ candle: bucketOf(pairs), tools: { log: noop } });
      portfolio = holdingCurrency(free, currency);
      marketData = withMinimumCost(pairs, minimum);
    };

    // The estimate, on several pairs: the share of the USDT free, of which 95 % is spent, the 5 % kept back for the fee, against the
    // minimum cost. Once the BUY of ETH has completed, BTC is the last pair not invested, which buys all-in.
    it.each`
      case                                                                | count | free   | minimum      | steps                                 | placed
      ${'50 % of 25 USDT, 11.875 USDT, above a minimum of 10'}            | ${2}  | ${25}  | ${10}        | ${'buyBTC'}                           | ${1}
      ${'50 % of 20 USDT, 9.5 USDT, below a minimum of 10'}               | ${2}  | ${20}  | ${10}        | ${'buyBTC'}                           | ${0}
      ${'50 % of 20 USDT, 9.5 USDT, the minimum itself'}                  | ${2}  | ${20}  | ${9.5}       | ${'buyBTC'}                           | ${1}
      ${'33.333333 % of 25 USDT, 7.9166665875 USDT, below 10'}            | ${3}  | ${25}  | ${10}        | ${'buyBTC'}                           | ${0}
      ${'50 % of no USDT, below 10'}                                      | ${2}  | ${0}   | ${10}        | ${'buyBTC'}                           | ${0}
      ${'50 % of 1 USDT, on a market without a minimum cost'}             | ${2}  | ${1}   | ${undefined} | ${'buyBTC'}                           | ${1}
      ${'50 % of 1 USDT, a minimum of 0, which bounds nothing'}           | ${2}  | ${1}   | ${0}         | ${'buyBTC'}                           | ${1}
      ${'all of 9 USDT, 8.55 USDT, below 10, BTC the last pair to buy'}   | ${2}  | ${100} | ${10}        | ${'buyETH completed:1 usdt9 buyBTC'}  | ${0}
      ${'all of 11 USDT, 10.45 USDT, above 10, BTC the last pair to buy'} | ${2}  | ${100} | ${10}        | ${'buyETH completed:1 usdt11 buyBTC'} | ${1}
    `('places $placed BUY of BTC for $case', ({ count, free, minimum, steps, placed }) => {
      setUp(pairsOf(count), free, minimum);
      play(steps);
      expect(orders.advices.filter(({ symbol }) => symbol === BTC)).toHaveLength(placed);
    });

    // Refused by the exchange, the BUY of a single-pair strategy tells its tracker of a holding present at start-up, and trips
    // maxConsecutiveErrors on an account that can neither buy nor sell: a book that tracks one pair never skips
    it.each`
      case                                    | free | minimum
      ${'all of 9 USDT, 8.55 USDT, below 10'} | ${9} | ${10}
      ${'all of no USDT, below 10'}           | ${0} | ${10}
    `('sends the all-in BUY of a book tracking one pair as before: $case', ({ free, minimum }) => {
      setUp([BTC], free, minimum);
      play('buyBTC');
      expect(orders.advices).toStrictEqual([{ type: 'STICKY', symbol: BTC, side: 'BUY' }]);
    });

    it('logs nothing for the BUY of a book tracking one pair, below the minimum', () => {
      setUp([BTC], 9, 10);
      play('buyBTC');
      expect(logs).toEqual([]);
    });

    // Without the currency free or a minimum to compare with, the Trader and the exchange say what they make of the BUY, as before
    it.each`
      case                                                 | currencies                                            | data
      ${'the portfolio without USDT, no balance read yet'} | ${new Map([['BTC', { free: 1, used: 0, total: 1 }]])} | ${withMinimumCost([BTC, ETH], 10)}
      ${'a pair without market data'}                      | ${holdingCurrency(1)}                                 | ${withMinimumCost([ETH], 10)}
    `('places the BUY on $case', ({ currencies, data }) => {
      track([BTC, ETH]);
      portfolio = currencies;
      marketData = data;
      play('buyBTC');
      expect(orders.advices).toHaveLength(1);
    });

    it('returns undefined for a BUY skipped', () => {
      setUp([BTC, ETH], 20, 10);
      expect(book.buy({ type: 'STICKY', symbol: BTC }, params())).toBeUndefined();
    });

    it('leaves the pair flat, nothing pending, after a BUY skipped', () => {
      setUp([BTC, ETH], 20, 10);
      play('buyBTC');
      expect(book.canBuy(BTC)).toBe(true);
    });

    // On a minimum of 10 USDT
    it.each`
      case                                  | pairs              | free   | steps                                | message
      ${'a share'}                          | ${[BTC, ETH, SOL]} | ${25}  | ${'buyBTC'}                          | ${`[BTC/USDT] BUY skipped: 33.333333 % of the 25 USDT free, 7.9166665875 USDT once 5 % is kept back for the fee, is below the minimum cost of 10 USDT of the market: watch fewer pairs or fund the account${NEXT_SKIPS}`}
      ${'all-in, BTC the last pair to buy'} | ${[BTC, ETH]}      | ${100} | ${'buyETH completed:1 usdt9 buyBTC'} | ${`[BTC/USDT] BUY skipped: all of the 9 USDT free, 8.55 USDT once 5 % is kept back for the fee, is below the minimum cost of 10 USDT of the market: fund the account${NEXT_SKIPS}`}
    `('warns of the first skip of a pair, $case, through the strategy log', ({ pairs, free, steps, message }) => {
      setUp(pairs, free, 10);
      play(steps);
      expect(logs).toEqual([{ level: 'warn', message }]);
    });

    // 50 % of 0.000002 BTC is 0.000001 BTC, 9.5e-7 as String writes it once 5 % is kept back
    it('writes the cost estimate and the minimum beside it with every decimal', () => {
      setUp(['ETH/BTC', 'SOL/BTC'], 0.000002, 0.000001, 'BTC');
      book.buy({ type: 'STICKY', symbol: 'ETH/BTC' }, params());
      expect(logs).toEqual([
        {
          level: 'warn',
          message: `[ETH/BTC] BUY skipped: 50 % of the 0.000002 BTC free, 0.00000095 BTC once 5 % is kept back for the fee, is below the minimum cost of 0.000001 BTC of the market: watch fewer pairs or fund the account${NEXT_SKIPS}`,
        },
      ]);
    });

    it('logs the next skips of the pair at debug level, without the note on them', () => {
      setUp([BTC, ETH], 20, 10);
      play('buyBTC buyBTC');
      expect(logs).toEqual([
        { level: 'warn', message: `${SKIP_LINE}${NEXT_SKIPS}` },
        { level: 'debug', message: SKIP_LINE },
      ]);
    });

    // On 30 USDT, 50 % is 15 USDT, 14.25 USDT once 5 % is kept back: placed
    it.each`
      case                                                          | steps                                              | levels
      ${'three skips of BTC'}                                       | ${'buyBTC buyBTC buyBTC'}                          | ${['warn', 'debug', 'debug']}
      ${'a skip of each pair, then of BTC'}                         | ${'buyBTC buyETH buyBTC'}                          | ${['warn', 'warn', 'debug']}
      ${'a skip of BTC, a BUY of BTC placed then canceled, a skip'} | ${'buyBTC usdt30 buyBTC canceled:1 usdt20 buyBTC'} | ${['warn', 'warn']}
      ${'a skip of BTC, a BUY of ETH placed, a skip of BTC'}        | ${'buyBTC usdt30 buyETH usdt20 buyBTC'}            | ${['warn', 'debug']}
    `('logs at $levels the skips of $case', ({ steps, levels }) => {
      setUp([BTC, ETH], 20, 10);
      play(steps);
      expect(logs.map(({ level }) => level)).toEqual(levels);
    });
  });
});
