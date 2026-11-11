import { STRATEGY_CREATE_ORDER_EVENT, STRATEGY_INFO_EVENT } from '@gekko/shared/constants/event.const';
import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { AdviceOrder } from '@gekko/shared/models/advice.types';
import { Candle } from '@gekko/shared/models/candle.types';
import { CandleBucket, ExchangeEvent } from '@gekko/shared/models/event.types';
import { MarketData } from '@gekko/shared/models/exchange.types';
import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { StrategyInfo } from '@gekko/shared/models/strategyInfo.types';
import { TradingPair } from '@gekko/shared/models/utility.types';
import { debug, info, warning } from '@gekko/core/logger/logger';
import { BTC_ETH_TRADED_INFO, flatBucket } from '@gekko/strategies/strategy.mock';
import { InitParams, OnCandleEventParams, Positions, Strategy, Tools } from '@gekko/strategies/strategy.types';
import { randomUUID, UUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrategyManager } from './strategyManager';

// The position book is the real one: these cases run tools.positions through the StrategyManager, as a strategy does. The strategy of
// each case is a double whose hooks play what the case says; the registry of the strategies is left out.
vi.mock('@gekko/strategies/index', () => ({}));
vi.mock('@gekko/core/logger/logger', () => ({ debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() }));

// The ids the manager draws, numbered from 1 in the order it draws them in each case (see idOf): orders a case tells apart need ids of
// their own. The implementation is given to vi.fn, which mockReset restores before each case.
const drawn = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => `00000000-0000-4000-8000-${String(++drawn.count).padStart(12, '0')}`),
}));

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
const XRP: TradingPair = 'XRP/USDT';
/** The first minute of the runs below, the first of 2024 (UTC): init runs on it, and the clock is the end of the minute processed */
const START = Date.UTC(2024, 0, 1);
/** The end of the first minute, which dates what init logs and the orders of the first candle */
const FIRST_MINUTE_END = START + ONE_MINUTE;
/** A minimum cost of 15 USDT on every pair, which a share of a small balance does not reach */
const MARKET: MarketData = { cost: { min: 15 } };
/** The closes of every candle below unless a case gives others */
const CLOSES: Record<TradingPair, number> = { [BTC]: 100, [ETH]: 2000 };
/** The order a case refuses or places on BTC/USDT unless it gives another */
const BTC_MARKET = { symbol: BTC, type: 'MARKET' } as const;
/** What init does in most cases: track every watched pair */
const trackEveryPair = ({ tools }: InitParams<object>) => tools.positions.track();

/** The id the manager draws n-th in a case, from 1 */
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID;

/** A portfolio read from the exchange, holding `free` of each asset given, nothing reserved */
const portfolioOf = (free: Record<string, number>): Portfolio =>
  new Map(Object.entries(free).map(([asset, amount]) => [asset, { free: amount, used: 0, total: amount }]));

/** What tools.positions answers on `pair` */
const positionOf = ({ positions }: Pick<Tools<object>, 'positions'>, pair: TradingPair) => ({
  isLong: positions.isLong(pair),
  isPendingOrder: positions.isPendingOrder(pair),
  canBuy: positions.canBuy(pair),
  canSell: positions.canSell(pair),
});
/** The answers of a pair flat with nothing pending, long with nothing pending, and long with its SELL pending */
const FLAT = { isLong: false, isPendingOrder: false, canBuy: true, canSell: false };
const LONG = { isLong: true, isPendingOrder: false, canBuy: false, canSell: true };
const SELLING = { isLong: true, isPendingOrder: true, canBuy: false, canSell: false };

/** What the end of an order reports besides its order: what it filled, the portfolio the Trader read after it, the price of its pair */
type EndFacts = {
  amount?: number;
  filled?: number;
  remaining?: number;
  mayBeLive?: boolean;
  portfolio?: Portfolio;
  price?: number;
  /** Whether the Trader read the portfolio after the end (ExchangeEvent.portfolioReadAfterOrder); left out, the event misses it */
  readAfterOrder?: boolean;
};

describe('StrategyManager: tools.positions', () => {
  let manager: StrategyManager;
  /** The orders the manager relayed, in order, as the Trader receives them */
  let relayed: AdviceOrder[];
  /** The lines the manager relayed as strategy info, in order */
  let infos: StrategyInfo[];

  /**
   * Builds the manager of a run watching `pairs` (BTC/USDT then ETH/USDT unless given), each with the market data given (MARKET unless
   * given), its warmup of `warmupPeriod` candles (none unless given: the first candle completes it), the strategy playing `hooks`, and
   * listened to as the TradingAdvisor listens to it
   */
  const start = (
    hooks: Partial<Strategy<object>>,
    {
      pairs = [BTC, ETH],
      marketData = {},
      warmupPeriod = 0,
    }: { pairs?: TradingPair[]; marketData?: Record<TradingPair, MarketData>; warmupPeriod?: number } = {},
  ) => {
    manager = new StrategyManager({ name: 'Positions' }, warmupPeriod);
    manager.setMarketData(new Map(pairs.map(pair => [pair, marketData[pair] ?? MARKET])));
    manager['strategy'] = hooks as Strategy<object>;
    manager.on(STRATEGY_CREATE_ORDER_EVENT, (advice: AdviceOrder) => relayed.push(advice));
    manager.on(STRATEGY_INFO_EVENT, (line: StrategyInfo) => infos.push(line));
  };
  /** tools.positions, as every hook gets it */
  const positions = (): Positions => manager['tools'].positions;
  /** Sends the candle `n` (from 0) as the TradingAdvisor does on 1m: its minute, then the timeframe candle it completes, flat at `closes` */
  const sendCandle = (n: number, closes: Record<TradingPair, number> = CLOSES) => {
    const bucket = flatBucket(closes, START + n * ONE_MINUTE);
    manager.onOneMinuteBucket(bucket);
    manager.onTimeFrameCandle(bucket);
  };
  /** The one-minute bucket of minute `n` (from 0) of BTC/USDT, at the prices given: what the trailing stops trail */
  const btcMinute = (n: number, prices: Pick<Candle, 'open' | 'high' | 'low' | 'close'>): CandleBucket =>
    new Map([[BTC, { start: START + n * ONE_MINUTE, ...prices, volume: 1 }]]);
  /** The exchange part of the end of an order */
  const exchangeOf = ({ portfolio = new Map(), price = 100, readAfterOrder }: EndFacts): ExchangeEvent => ({
    portfolio,
    price,
    ...(readAfterOrder === undefined ? {} : { portfolioReadAfterOrder: readAfterOrder }),
  });
  /** What the end of the n-th order relayed (from 1) says of it, as every end does */
  const endedOrder = (n: number) => {
    const { id, symbol, side, type, amount, orderCreationDate } = relayed[n - 1];
    return { id, symbol, side, type, amount: amount ?? 1, orderCreationDate };
  };
  /** Relays the completion of the n-th order relayed (from 1), for what it asked for (1 for an order without an amount) unless given */
  const complete = (n: number, { amount, price = 100, ...facts }: EndFacts = {}) => {
    const order = endedOrder(n);
    manager.onOrderCompleted({
      order: {
        ...order,
        amount: amount ?? order.amount,
        price,
        orderExecutionDate: order.orderCreationDate,
        effectivePrice: price,
        fee: 0,
      },
      exchange: exchangeOf({ price, ...facts }),
    });
  };
  /**
   * Relays the cancelation of the n-th order relayed (from 1), placed for what it asked for (1 for an order without an amount) unless
   * given, after the fill given, if any
   */
  const cancel = (n: number, { amount, filled, remaining, ...facts }: EndFacts = {}) => {
    const order = endedOrder(n);
    const fill = filled === undefined ? {} : { filled, remaining };
    manager.onOrderCanceled({
      order: { ...order, amount: amount ?? order.amount, ...fill, orderCancelationDate: order.orderCreationDate },
      exchange: exchangeOf(facts),
    });
  };
  /**
   * Relays the error of the n-th order relayed (from 1), placed for what it asked for (1 for an order without an amount) unless given,
   * refused with nothing filled unless given
   */
  const fail = (n: number, { amount, filled = 0, mayBeLive = false, ...facts }: EndFacts = {}) => {
    const order = endedOrder(n);
    manager.onOrderErrored({
      order: {
        ...order,
        amount: amount ?? order.amount,
        reason: 'Insufficient balance',
        orderErrorDate: order.orderCreationDate,
        filled,
        mayBeLive,
      },
      exchange: exchangeOf(facts),
    });
  };
  /** What `call` throws, if anything */
  const failureOf = (call: () => unknown) => {
    try {
      call();
    } catch (failure) {
      return failure;
    }
  };

  beforeEach(() => {
    drawn.count = 0;
    relayed = [];
    infos = [];
  });

  describe('the object', () => {
    it('is the same in init, in a candle hook and in an order hook, for the whole run', () => {
      const seen: Positions[] = [];
      const keep = ({ tools }: { tools: Tools<object> }) => {
        seen.push(tools.positions);
      };
      start({ init: keep, onTimeframeCandleAfterWarmup: keep, onOrderCompleted: keep });
      sendCandle(0);
      manager['tools'].createOrder({ ...BTC_MARKET, side: 'BUY', amount: 1 });
      complete(1);
      expect(seen.filter(seenPositions => seenPositions === positions())).toHaveLength(3);
    });

    it('lists no pair before track', () => {
      start({});
      expect(positions().pairs).toEqual([]);
    });

    // The strategies walk the pairs on every candle: a copy made at each read, or a frozen array, which Bun walks some ten times slower,
    // would cost a backtest on 1m candles
    describe('once track has run', () => {
      beforeEach(() => {
        start({ init: trackEveryPair });
        sendCandle(0);
      });

      it('lists the same array at each read', () => {
        expect(positions().pairs).toBe(positions().pairs);
      });

      it('lists an array that is not frozen', () => {
        expect(Object.isFrozen(positions().pairs)).toBe(false);
      });
    });

    it('tracks the pairs when init takes track apart from it', () => {
      start({
        init: ({ tools }) => {
          const { track } = tools.positions;
          track();
        },
      });
      sendCandle(0);
      expect(positions().pairs).toEqual([BTC, ETH]);
    });

    // Each member taken apart from the object, as a strategy may (`const { canBuy, buy } = tools.positions`), once track has run and the
    // warmup is over: the pairs are flat, nothing pending, no portfolio read yet, so that no BUY is skipped
    it.each`
      member              | call                                                      | expected
      ${'pairs'}          | ${({ pairs }: Positions) => pairs}                        | ${[BTC, ETH]}
      ${'isLong'}         | ${({ isLong }: Positions) => isLong(BTC)}                 | ${false}
      ${'isPendingOrder'} | ${({ isPendingOrder }: Positions) => isPendingOrder(BTC)} | ${false}
      ${'canBuy'}         | ${({ canBuy }: Positions) => canBuy(BTC)}                 | ${true}
      ${'canSell'}        | ${({ canSell }: Positions) => canSell(BTC)}               | ${false}
      ${'buy'}            | ${({ buy }: Positions) => buy(BTC_MARKET)}                | ${idOf(1)}
      ${'sell'}           | ${({ sell }: Positions) => sell(BTC_MARKET)}              | ${idOf(1)}
    `('answers through $member taken apart from it', ({ call, expected }) => {
      start({ init: trackEveryPair });
      sendCandle(0);
      expect(call(positions())).toEqual(expected);
    });
  });

  describe('track', () => {
    /** Starts a run whose init has the book track `pairs`, and sends its first minute, which runs init: returns what init throws */
    const trackAtInit = (pairs: unknown, options?: Parameters<typeof start>[1]) => {
      start({ init: ({ tools }) => tools.positions.track(pairs as TradingPair[]) }, options);
      return failureOf(() => manager.onOneMinuteBucket(flatBucket(CLOSES, START)));
    };
    /** What a list the book cannot track is told, the list shown as util.inspect shows it */
    const listIssue = (shown: string) =>
      `[STRATEGY] Impossible to track positions: pairs must be an array of at least one watched pair, or left out to track every watched pair, got ${shown}`;
    /** What a pair that is not watched is told */
    const pairIssue = (pair: string) =>
      `[STRATEGY] Impossible to track positions on ${pair}: symbol must be one of the watched pairs (BTC/USDT, ETH/USDT), got '${pair}'`;
    const REPEAT_ISSUE = "[STRATEGY] Impossible to track positions: pairs must name each watched pair once, got 'BTC/USDT' twice";
    const AFTER_INIT_ISSUE = '[STRATEGY] Impossible to track positions: tools.positions.track is available in init only';

    // The market data lists the watched pairs in the order of watch.assets: here ETH/USDT, then BTC/USDT
    it.each`
      given
      ${undefined}
      ${null}
    `('tracks every watched pair, in the order of watch.assets, when init gives $given', ({ given }) => {
      trackAtInit(given, { pairs: [ETH, BTC] });
      expect(positions().pairs).toEqual([ETH, BTC]);
    });

    it.each`
      given         | tracked
      ${[ETH]}      | ${[ETH]}
      ${[ETH, BTC]} | ${[ETH, BTC]}
      ${[BTC, ETH]} | ${[BTC, ETH]}
    `('tracks the pairs init gives, in their order: $given', ({ given, tracked }) => {
      trackAtInit(given);
      expect(positions().pairs).toEqual(tracked);
    });

    it('keeps the pairs it tracks whatever init does to the list it gave', () => {
      start({
        init: ({ tools }) => {
          const given = [BTC];
          tools.positions.track(given);
          given.push(ETH);
        },
      });
      sendCandle(0);
      expect(positions().pairs).toEqual([BTC]);
    });

    // The pairs are checked before the book tracks any: a pair that is not watched is named before a pair named twice
    describe.each`
      given                                                 | pairs              | message
      ${'an empty list'}                                    | ${[]}              | ${listIssue('[]')}
      ${'a pair alone, not in a list'}                      | ${BTC}             | ${listIssue("'BTC/USDT'")}
      ${'a Set of pairs'}                                   | ${new Set([BTC])}  | ${listIssue("Set(1) { 'BTC/USDT' }")}
      ${'a pair that is not watched'}                       | ${[BTC, XRP]}      | ${pairIssue(XRP)}
      ${'a watched pair in lower case'}                     | ${['btc/usdt']}    | ${pairIssue('btc/usdt')}
      ${'a pair named twice'}                               | ${[BTC, ETH, BTC]} | ${REPEAT_ISSUE}
      ${'a pair named twice, then one that is not watched'} | ${[BTC, BTC, XRP]} | ${pairIssue(XRP)}
    `('when init gives $given', ({ pairs, message }) => {
      let failure: unknown;

      beforeEach(() => {
        failure = trackAtInit(pairs);
      });

      it('refuses it with a GekkoError', () => {
        expect(failure).toBeInstanceOf(GekkoError);
      });

      it('says what is wrong with it', () => {
        expect(failure).toHaveProperty('message', message);
      });

      it('tracks no pair', () => {
        expect(positions().pairs).toEqual([]);
      });
    });

    it('refuses a second call from init with the error of the book', () => {
      start({
        init: ({ tools }) => {
          tools.positions.track();
          tools.positions.track([BTC]);
        },
      });
      expect(failureOf(() => sendCandle(0))).toHaveProperty(
        'message',
        '[STRATEGY] The position book tracks its pairs already: track is called once, from init',
      );
    });

    // Kept from init and called later, it would start the tracking once the strategy had traded without it. Init tracks BTC/USDT and
    // keeps track; then the strategy asks for ETH/USDT, from a candle hook, an order hook, or anywhere once init has returned.
    describe('once init has returned', () => {
      /** track, as init got it */
      let kept: Positions['track'] | undefined;
      const trackEthereum = ({ tools }: { tools: Tools<object> }) => tools.positions.track([ETH]);
      /** Sends the first candle, on which the strategy buys 1 BTC with createOrder, then completes that BUY */
      const completeBuyOfFirstCandle = () => {
        sendCandle(0);
        manager['tools'].createOrder({ ...BTC_MARKET, side: 'BUY', amount: 1 });
        complete(1);
      };
      /** Sends the first candle, then calls the track init kept */
      const callKeptTrack = () => {
        sendCandle(0);
        kept?.([ETH]);
      };

      describe.each`
        caller                            | hooks                                       | play
        ${'onEachTimeframeCandle'}        | ${{ onEachTimeframeCandle: trackEthereum }} | ${() => sendCandle(0)}
        ${'onOrderCompleted'}             | ${{ onOrderCompleted: trackEthereum }}      | ${completeBuyOfFirstCandle}
        ${'the strategy, kept from init'} | ${{}}                                       | ${callKeptTrack}
      `('when $caller calls it', ({ hooks, play }) => {
        let failure: unknown;

        beforeEach(() => {
          kept = undefined;
          start({
            ...hooks,
            init: ({ tools }) => {
              kept = tools.positions.track;
              tools.positions.track([BTC]);
            },
          });
          failure = failureOf(play);
        });

        it('refuses it with a GekkoError', () => {
          expect(failure).toBeInstanceOf(GekkoError);
        });

        it('says that track is available in init only', () => {
          expect(failure).toHaveProperty('message', AFTER_INIT_ISSUE);
        });

        it('keeps tracking the pairs init gave', () => {
          expect(positions().pairs).toEqual([BTC]);
        });
      });
    });

    // The line of the book, through the strategy's log: relayed as strategy info, dated with the end of the minute init runs on
    describe('on several pairs', () => {
      beforeEach(() => {
        trackAtInit(undefined);
      });

      it('says at info level which pairs it trades, and the rule of their orders', () => {
        expect(vi.mocked(info).mock.calls).toEqual([['strategy', BTC_ETH_TRADED_INFO.message]]);
      });

      it('relays that line as strategy info, dated with the end of the first minute', () => {
        expect(infos).toEqual([{ timestamp: FIRST_MINUTE_END, level: 'info', tag: 'strategy', message: BTC_ETH_TRADED_INFO.message }]);
      });
    });

    it.each`
      run                                     | given        | pairs
      ${'that watches one pair'}              | ${undefined} | ${[BTC]}
      ${'that tracks one of the two watched'} | ${[BTC]}     | ${[BTC, ETH]}
    `('says nothing in a run $run', ({ given, pairs }) => {
      trackAtInit(given, { pairs });
      expect(infos).toEqual([]);
    });

    // The pairs tracked share the currency, not the pairs watched: tracked alone, BTC/USDT buys all-in
    it('has the BUY of the one pair tracked of two watched go all-in, without an allocation', () => {
      trackAtInit([BTC]);
      sendCandle(0);
      positions().buy({ symbol: BTC, type: 'STICKY' });
      expect(relayed).toStrictEqual([{ symbol: BTC, type: 'STICKY', side: 'BUY', id: idOf(1), orderCreationDate: FIRST_MINUTE_END }]);
    });
  });

  // False before track and for a pair not tracked, at any time: a strategy that never calls track never trades through the book
  describe.each`
    situation                                      | tracked      | pair
    ${'before track'}                              | ${undefined} | ${BTC}
    ${'on a watched pair the book does not track'} | ${[BTC]}     | ${ETH}
    ${'on a pair that is not watched'}             | ${null}      | ${XRP}
  `('$situation', ({ tracked, pair }) => {
    beforeEach(() => {
      const init = tracked === undefined ? undefined : ({ tools }: InitParams<object>) => tools.positions.track(tracked ?? undefined);
      start({ init });
      sendCandle(0);
    });

    it.each`
      member
      ${'isLong'}
      ${'isPendingOrder'}
      ${'canBuy'}
      ${'canSell'}
    `('answers false to $member', ({ member }: { member: 'isLong' | 'isPendingOrder' | 'canBuy' | 'canSell' }) => {
      expect(positions()[member](pair)).toBe(false);
    });
  });

  it('answers that a pair tracked, flat with nothing pending, can be bought', () => {
    start({ init: trackEveryPair });
    sendCandle(0);
    expect(positionOf(manager['tools'], BTC)).toEqual(FLAT);
  });

  describe('buy and sell, refused', () => {
    /** The refusal of the warmup, as createOrder words it */
    const WARMUP_ISSUE =
      '[STRATEGY] Orders are not available until the warmup is over: create them from onTimeframeCandleAfterWarmup, log or an order hook, never from init';
    /** The keys each side takes, as the refusal lists them */
    const BUY_KEYS = "'symbol', 'type', 'price', 'trailing'";
    const SELL_KEYS = "'symbol', 'type', 'price'";
    /** Where an order is sized, as the refusal of a size says it */
    const ELSEWHERE = '(tools.createOrder takes an amount, a cost or an allocation)';
    /** A portfolio whose share of the currency is too little for the minimum cost on two pairs: the book skips a BUY it estimates */
    const SHORT_OF_CURRENCY = () => portfolioOf({ USDT: 20 });

    // Whether orders are available is checked first, before the keys: a BUY holding a key the book refuses is told it cannot order yet
    it.each`
      order                        | place
      ${'a BUY'}                   | ${(target: Positions) => target.buy(BTC_MARKET)}
      ${'a SELL'}                  | ${(target: Positions) => target.sell(BTC_MARKET)}
      ${'a BUY holding an amount'} | ${(target: Positions) => target.buy({ ...BTC_MARKET, amount: 1 } as never)}
    `('refuses $order before a one-minute bucket set the clock', ({ place }) => {
      start({});
      expect(failureOf(() => place(positions()))).toHaveProperty('message', '[STRATEGY] No candle when relaying advice');
    });

    // A BUY is refused during the warmup before the book estimates it: never skipped, which would say nothing of the warmup. The warmup
    // is checked before the keys, as the clock is
    describe.each`
      hook                       | order                        | place
      ${'init'}                  | ${'a BUY'}                   | ${(target: Positions) => target.buy(BTC_MARKET)}
      ${'init'}                  | ${'a SELL'}                  | ${(target: Positions) => target.sell(BTC_MARKET)}
      ${'onEachTimeframeCandle'} | ${'a BUY'}                   | ${(target: Positions) => target.buy(BTC_MARKET)}
      ${'onEachTimeframeCandle'} | ${'a SELL'}                  | ${(target: Positions) => target.sell(BTC_MARKET)}
      ${'onEachTimeframeCandle'} | ${'a BUY holding an amount'} | ${(target: Positions) => target.buy({ ...BTC_MARKET, amount: 1 } as never)}
    `('when the strategy places $order from $hook during the warmup', ({ hook, place }) => {
      let failure: unknown;

      beforeEach(() => {
        const placing = ({ tools }: { tools: Tools<object> }) => place(tools.positions);
        start(
          {
            init: params => {
              trackEveryPair(params);
              if (hook === 'init') placing(params);
            },
            onEachTimeframeCandle: placing,
          },
          { warmupPeriod: 1 },
        );
        manager.onPortfolioChange(SHORT_OF_CURRENCY());
        failure = failureOf(() => sendCandle(0));
      });

      it('refuses it with a GekkoError', () => {
        expect(failure).toBeInstanceOf(GekkoError);
      });

      it('says that orders are not available until the warmup is over', () => {
        expect(failure).toHaveProperty('message', WARMUP_ISSUE);
      });

      it('logs no skip', () => {
        expect(warning).not.toHaveBeenCalled();
      });

      it('relays no order', () => {
        expect(relayed).toEqual([]);
      });
    });

    // Refused whatever its value, before anything else is read of the order: the type, the pair, the book. A size is told where an
    // order is sized so.
    describe.each`
      side      | problem                                    | place                                                                                          | message
      ${'BUY'}  | ${'an amount'}                             | ${(target: Positions) => target.buy({ ...BTC_MARKET, amount: 1 } as never)}                    | ${`[STRATEGY] Impossible to create the BUY MARKET order on BTC/USDT: tools.positions.buy takes no key but ${BUY_KEYS}, got 'amount': the position book sizes the order ${ELSEWHERE}`}
      ${'BUY'}  | ${'an allocation left undefined'}          | ${(target: Positions) => target.buy({ ...BTC_MARKET, allocation: undefined } as never)}        | ${`[STRATEGY] Impossible to create the BUY MARKET order on BTC/USDT: tools.positions.buy takes no key but ${BUY_KEYS}, got 'allocation': the position book sizes the order ${ELSEWHERE}`}
      ${'BUY'}  | ${'a cost, and a type in lower case'}      | ${(target: Positions) => target.buy({ symbol: BTC, type: 'market', cost: 100 } as never)}      | ${`[STRATEGY] Impossible to create the BUY market order on BTC/USDT: tools.positions.buy takes no key but ${BUY_KEYS}, got 'cost': the position book sizes the order ${ELSEWHERE}`}
      ${'BUY'}  | ${'a side, on a pair that is not watched'} | ${(target: Positions) => target.buy({ symbol: XRP, side: 'SELL', type: 'MARKET' } as never)}   | ${`[STRATEGY] Impossible to create the BUY MARKET order on XRP/USDT: tools.positions.buy takes no key but ${BUY_KEYS}, got 'side'`}
      ${'SELL'} | ${'an amount'}                             | ${(target: Positions) => target.sell({ ...BTC_MARKET, amount: 1 } as never)}                   | ${`[STRATEGY] Impossible to create the SELL MARKET order on BTC/USDT: tools.positions.sell takes no key but ${SELL_KEYS}, got 'amount': it sells all of the asset free ${ELSEWHERE}`}
      ${'SELL'} | ${'a trailing stop'}                       | ${(target: Positions) => target.sell({ ...BTC_MARKET, trailing: { percentage: 2 } } as never)} | ${`[STRATEGY] Impossible to create the SELL MARKET order on BTC/USDT: tools.positions.sell takes no key but ${SELL_KEYS}, got 'trailing'`}
    `('when the strategy places a $side holding $problem', ({ place, message }) => {
      let failure: unknown;

      beforeEach(() => {
        start({ init: trackEveryPair });
        manager.onPortfolioChange(SHORT_OF_CURRENCY());
        sendCandle(0);
        failure = failureOf(() => place(positions()));
      });

      it('refuses it with a GekkoError', () => {
        expect(failure).toBeInstanceOf(GekkoError);
      });

      it('names the keys it does not take, and lists those it takes', () => {
        expect(failure).toHaveProperty('message', message);
      });

      it('draws no id', () => {
        expect(randomUUID).not.toHaveBeenCalled();
      });

      it('relays no order', () => {
        expect(relayed).toEqual([]);
      });

      it('logs no skip', () => {
        expect(warning).not.toHaveBeenCalled();
      });
    });

    // What createOrder refuses, with its words, before the book reads anything: on a currency too short for a share, the book would skip
    // the BUY, with a warning, rather than refuse it
    describe.each`
      side      | problem                         | place                                                                                | message
      ${'BUY'}  | ${'a type in lower case'}       | ${(target: Positions) => target.buy({ symbol: BTC, type: 'market' } as never)}       | ${"[STRATEGY] Impossible to create the BUY market order on BTC/USDT: type must be one of 'MARKET', 'STICKY', 'LIMIT', got 'market'"}
      ${'BUY'}  | ${'a price of 0'}               | ${(target: Positions) => target.buy({ symbol: BTC, type: 'LIMIT', price: 0 })}       | ${'[STRATEGY] Impossible to create the BUY LIMIT order on BTC/USDT: price must be a number above 0, or left out for the last price of the pair, got 0'}
      ${'BUY'}  | ${'a stop of 0 %'}              | ${(target: Positions) => target.buy({ ...BTC_MARKET, trailing: { percentage: 0 } })} | ${'[STRATEGY] Impossible to create the BUY MARKET order on BTC/USDT: trailing.percentage must be a number above 0 and below 100 (2.5 for 2.5%), got 0'}
      ${'BUY'}  | ${'a pair that is not watched'} | ${(target: Positions) => target.buy({ symbol: XRP, type: 'MARKET' })}                | ${"[STRATEGY] Impossible to create the BUY MARKET order on XRP/USDT: symbol must be one of the watched pairs (BTC/USDT, ETH/USDT), got 'XRP/USDT'"}
      ${'SELL'} | ${'a type it does not know'}    | ${(target: Positions) => target.sell({ symbol: BTC, type: 'STOP' } as never)}        | ${"[STRATEGY] Impossible to create the SELL STOP order on BTC/USDT: type must be one of 'MARKET', 'STICKY', 'LIMIT', got 'STOP'"}
      ${'SELL'} | ${'a pair that is not watched'} | ${(target: Positions) => target.sell({ symbol: XRP, type: 'MARKET' })}               | ${"[STRATEGY] Impossible to create the SELL MARKET order on XRP/USDT: symbol must be one of the watched pairs (BTC/USDT, ETH/USDT), got 'XRP/USDT'"}
    `('when the strategy places a $side with $problem', ({ place, message }) => {
      let failure: unknown;

      beforeEach(() => {
        start({ init: trackEveryPair });
        manager.onPortfolioChange(SHORT_OF_CURRENCY());
        sendCandle(0);
        failure = failureOf(() => place(positions()));
      });

      it('refuses it with the words of createOrder', () => {
        expect(failure).toHaveProperty('message', message);
      });

      it('logs no skip', () => {
        expect(warning).not.toHaveBeenCalled();
      });

      it('relays no order', () => {
        expect(relayed).toEqual([]);
      });
    });

    // A watched pair passes the checks of createOrder: the book refuses it
    describe.each`
      side      | tracked      | place                                                                  | message
      ${'BUY'}  | ${[BTC]}     | ${(target: Positions) => target.buy({ symbol: ETH, type: 'STICKY' })}  | ${'[STRATEGY] Impossible to place the BUY STICKY order on ETH/USDT: the position book does not track it (it tracks BTC/USDT)'}
      ${'SELL'} | ${[BTC]}     | ${(target: Positions) => target.sell({ symbol: ETH, type: 'MARKET' })} | ${'[STRATEGY] Impossible to place the SELL MARKET order on ETH/USDT: the position book does not track it (it tracks BTC/USDT)'}
      ${'BUY'}  | ${undefined} | ${(target: Positions) => target.buy({ symbol: ETH, type: 'STICKY' })}  | ${'[STRATEGY] Impossible to place the BUY STICKY order on ETH/USDT: the position book does not track it (it tracks no pair until init calls track)'}
      ${'SELL'} | ${undefined} | ${(target: Positions) => target.sell({ symbol: ETH, type: 'MARKET' })} | ${'[STRATEGY] Impossible to place the SELL MARKET order on ETH/USDT: the position book does not track it (it tracks no pair until init calls track)'}
    `('when the strategy places a $side on a watched pair the book does not track, tracking $tracked', ({ tracked, place, message }) => {
      let failure: unknown;

      beforeEach(() => {
        start({ init: tracked ? ({ tools }) => tools.positions.track(tracked) : undefined });
        sendCandle(0);
        failure = failureOf(() => place(positions()));
      });

      it('refuses it with the words of the book', () => {
        expect(failure).toHaveProperty('message', message);
      });

      it('draws no id', () => {
        expect(randomUUID).not.toHaveBeenCalled();
      });

      it('relays no order', () => {
        expect(relayed).toEqual([]);
      });
    });
  });

  describe('buy and sell, placed', () => {
    // Placed on the first candle, which completes a warmup of none: dated with the end of its minute
    it('relays a BUY of an equal share of the currency, its allocation, while every pair tracked is flat', () => {
      start({ init: trackEveryPair });
      sendCandle(0);
      positions().buy({ symbol: BTC, type: 'STICKY' });
      expect(relayed).toStrictEqual([
        { symbol: BTC, type: 'STICKY', allocation: 50, side: 'BUY', id: idOf(1), orderCreationDate: FIRST_MINUTE_END },
      ]);
    });

    it('relays the BUY of the last pair not invested all-in, without an allocation', () => {
      start({ init: trackEveryPair });
      sendCandle(0);
      positions().buy({ symbol: BTC, type: 'STICKY' });
      complete(1);
      positions().buy({ symbol: ETH, type: 'STICKY' });
      expect(relayed[1]).toStrictEqual({ symbol: ETH, type: 'STICKY', side: 'BUY', id: idOf(2), orderCreationDate: FIRST_MINUTE_END });
    });

    it('relays the BUY of a run of one pair all-in, without an allocation', () => {
      start({ init: trackEveryPair }, { pairs: [BTC] });
      sendCandle(0, { [BTC]: 100 });
      positions().buy(BTC_MARKET);
      expect(relayed).toStrictEqual([{ symbol: BTC, type: 'MARKET', side: 'BUY', id: idOf(1), orderCreationDate: FIRST_MINUTE_END }]);
    });

    // The Trader gets the stop through the manager, which keeps it until the BUY completes
    it('relays the price of a BUY, not its stop', () => {
      start({ init: trackEveryPair }, { pairs: [BTC] });
      sendCandle(0, { [BTC]: 100 });
      positions().buy({ symbol: BTC, type: 'LIMIT', price: 90, trailing: { percentage: 2 } });
      expect(relayed).toStrictEqual([
        { symbol: BTC, type: 'LIMIT', price: 90, side: 'BUY', id: idOf(1), orderCreationDate: FIRST_MINUTE_END },
      ]);
    });

    it('keeps the stop a BUY asks for until that BUY completes, as createOrder does', () => {
      start({ init: trackEveryPair }, { pairs: [BTC] });
      sendCandle(0, { [BTC]: 100 });
      positions().buy({ ...BTC_MARKET, trailing: { percentage: 2 } });
      expect(manager['pendingTrailingStops'].get(idOf(1))).toEqual({ percentage: 2 });
    });

    it('returns the id it relays the order with', () => {
      start({ init: trackEveryPair });
      sendCandle(0);
      expect(positions().buy(BTC_MARKET)).toBe(relayed[0]?.id);
    });

    it('relays an all-in SELL, without an amount', () => {
      start({ init: trackEveryPair }, { pairs: [BTC] });
      sendCandle(0, { [BTC]: 100 });
      positions().buy(BTC_MARKET);
      complete(1);
      positions().sell(BTC_MARKET);
      expect(relayed[1]).toStrictEqual({ symbol: BTC, type: 'MARKET', side: 'SELL', id: idOf(2), orderCreationDate: FIRST_MINUTE_END });
    });

    it('keeps the SELL as one the strategy created, whose pair a cancellation names', () => {
      start({ init: trackEveryPair }, { pairs: [BTC] });
      sendCandle(0, { [BTC]: 100 });
      positions().sell(BTC_MARKET);
      expect(manager['pendingOrders'].get(idOf(1))).toEqual({ symbol: BTC, seller: 'strategy' });
    });
  });

  // On two pairs flat, a BUY takes 50 % of the 20 USDT read, 9.5 USDT once 5 % is kept back for the fee: under the minimum cost of 15
  describe('a BUY the book skips', () => {
    const SKIP_LINE =
      '[BTC/USDT] BUY skipped: 50 % of the 20 USDT free, 9.5 USDT once 5 % is kept back for the fee, is below the minimum cost of 15 USDT of the market: watch fewer pairs or fund the account';
    const FIRST_SKIP_LINE = `${SKIP_LINE}; the next skips of this pair are logged at debug level until a BUY of it is placed`;
    let id: UUID | undefined;

    beforeEach(() => {
      start({ init: trackEveryPair });
      manager.onPortfolioChange(portfolioOf({ USDT: 20 }));
      sendCandle(0);
      id = positions().buy({ symbol: BTC, type: 'STICKY' });
    });

    it('returns no id', () => {
      expect(id).toBeUndefined();
    });

    it('relays no order', () => {
      expect(relayed).toEqual([]);
    });

    it('keeps nothing pending on the pair', () => {
      expect(positionOf(manager['tools'], BTC)).toEqual(FLAT);
    });

    it('warns of the first skip of the pair', () => {
      expect(vi.mocked(warning).mock.calls).toEqual([['strategy', FIRST_SKIP_LINE]]);
    });

    // After the line of track, which init logs on the same minute
    it('relays that warning as strategy info', () => {
      expect(infos).toEqual([
        { timestamp: FIRST_MINUTE_END, level: 'info', tag: 'strategy', message: BTC_ETH_TRADED_INFO.message },
        { timestamp: FIRST_MINUTE_END, level: 'warn', tag: 'strategy', message: FIRST_SKIP_LINE },
      ]);
    });

    describe('then skips it again', () => {
      beforeEach(() => {
        positions().buy({ symbol: BTC, type: 'STICKY' });
      });

      it('logs the next skip at debug level', () => {
        expect(vi.mocked(debug).mock.calls).toEqual([['strategy', SKIP_LINE]]);
      });

      it('does not relay a debug line', () => {
        expect(infos.map(({ level }) => level)).toEqual(['info', 'warn']);
      });
    });
  });

  // What the strategy writes to its own copies changes nothing the book goes by: the manager hands it its own (see the context of the
  // book in the constructor)
  describe('what the book estimates a BUY from', () => {
    it('is the market data of the manager, whatever the strategy writes to its copy', () => {
      let id: UUID | undefined;
      start({
        init: trackEveryPair,
        onTimeframeCandleAfterWarmup: ({ tools }) => {
          tools.marketData.set(BTC, {});
          id = tools.positions.buy({ symbol: BTC, type: 'STICKY' });
        },
      });
      manager.onPortfolioChange(portfolioOf({ USDT: 20 }));
      sendCandle(0);
      expect(id).toBeUndefined();
    });

    // 50 % of 1000 USDT, 475 once 5 % is kept back: above the minimum cost of 15. Of the 20 USDT the strategy writes there, it would be
    // 9.5, under it.
    it('is the portfolio received, whatever the strategy writes to the currency of its candle hook', () => {
      let id: UUID | undefined;
      start({
        init: trackEveryPair,
        onTimeframeCandleAfterWarmup: ({ portfolio, tools }) => {
          portfolio.get('USDT')!.free = 20;
          id = tools.positions.buy({ symbol: BTC, type: 'STICKY' });
        },
      });
      manager.onPortfolioChange(portfolioOf({ USDT: 1000 }));
      sendCandle(0);
      expect(id).toBe(idOf(1));
    });

    // Skipped on its 9.5 USDT, the BUY finds 1 BTC free, 100 USDT at the close, enough to sell: the book takes it for the position
    it('is the portfolio received, whatever asset the strategy deletes from that of its candle hook', () => {
      start({
        init: trackEveryPair,
        onTimeframeCandleAfterWarmup: ({ portfolio, tools }) => {
          portfolio.delete('BTC');
          tools.positions.buy({ symbol: BTC, type: 'STICKY' });
        },
      });
      manager.onPortfolioChange(portfolioOf({ USDT: 20, BTC: 1 }));
      sendCandle(0);
      expect(positionOf(manager['tools'], BTC)).toEqual(LONG);
    });

    // 50 % of 1000 USDT buys 475 / 100000 = 0.00475 BTC at the close, under the minimum amount of 0.01; at the 2000 the strategy writes
    // in its copy, it would buy 0.2375
    it('is the close of the last timeframe candle, whatever the strategy writes to its copy of the candle', () => {
      let id: UUID | undefined;
      start(
        {
          init: trackEveryPair,
          onTimeframeCandleAfterWarmup: ({ candle, tools }: OnCandleEventParams<object>) => {
            candle.get(BTC)!.close = 2000;
            id = tools.positions.buy({ symbol: BTC, type: 'STICKY' });
          },
        },
        { marketData: { [BTC]: { amount: { min: 0.01 } } } },
      );
      manager.onPortfolioChange(portfolioOf({ USDT: 1000 }));
      sendCandle(0, { [BTC]: 100000, [ETH]: 2000 });
      expect(id).toBeUndefined();
    });

    // A minute after the candle, at 2000, that is no timeframe candle: the BUY placed as an order ends is priced at the close of the
    // last timeframe candle, 100000
    it('is the close of the last timeframe candle for a BUY placed from an order hook', () => {
      let id: UUID | undefined;
      start(
        {
          init: trackEveryPair,
          onOrderCompleted: ({ tools }) => {
            id = tools.positions.buy({ symbol: BTC, type: 'STICKY' });
          },
        },
        { marketData: { [BTC]: { amount: { min: 0.01 } } } },
      );
      manager.onPortfolioChange(portfolioOf({ USDT: 1000 }));
      sendCandle(0, { [BTC]: 100000, [ETH]: 2000 });
      manager.onOneMinuteBucket(flatBucket({ [BTC]: 2000, [ETH]: 2000 }, START + ONE_MINUTE));
      manager['tools'].createOrder({ symbol: ETH, side: 'BUY', type: 'MARKET', amount: 1 });
      complete(1, { portfolio: portfolioOf({ USDT: 1000 }) });
      expect(id).toBeUndefined();
    });
  });

  describe('the end of an order the book placed', () => {
    /** What the strategy heard, in order: the lines relayed as strategy info, and its order hooks, by name */
    let heard: string[];
    /** What tools.positions answered in each order hook, in order */
    let answers: ReturnType<typeof positionOf>[];

    /** Starts a run of BTC/USDT whose order hooks record what tools.positions answers then, and places a STICKY BUY: order 1 */
    const placeBuy = () => {
      const record =
        (hook: string) =>
        ({ tools }: { tools: Tools<object> }) => {
          heard.push(hook);
          answers.push(positionOf(tools, BTC));
        };
      start(
        {
          init: trackEveryPair,
          onOrderCompleted: record('onOrderCompleted'),
          onOrderCanceled: record('onOrderCanceled'),
          onOrderErrored: record('onOrderErrored'),
        },
        { pairs: [BTC] },
      );
      manager.on(STRATEGY_INFO_EVENT, ({ message }: StrategyInfo) => heard.push(message));
      sendCandle(0, { [BTC]: 100 });
      positions().buy({ symbol: BTC, type: 'STICKY' });
    };

    beforeEach(() => {
      heard = [];
      answers = [];
    });

    // The book settles the order before the hook: the hook reads the position after it, nothing pending
    it.each`
      outcome                         | end                                                                                       | answered
      ${'completed'}                  | ${() => complete(1, { portfolio: portfolioOf({ BTC: 1, USDT: 0 }) })}                     | ${LONG}
      ${'canceled after filling 0.9'} | ${() => cancel(1, { filled: 0.9, remaining: 0.1, portfolio: portfolioOf({ BTC: 0.9 }) })} | ${LONG}
      ${'canceled, nothing filled'}   | ${() => cancel(1, { filled: 0, remaining: 1, portfolio: portfolioOf({ BTC: 0 }) })}       | ${FLAT}
      ${'errored, nothing filled'}    | ${() => fail(1, { portfolio: portfolioOf({ BTC: 0, USDT: 1000 }) })}                      | ${FLAT}
    `('has the hook of a BUY $outcome read the position after it', ({ end, answered }) => {
      placeBuy();
      end();
      expect(answers).toEqual([answered]);
    });

    // 0.9 BTC at 100 is 90 USDT, above the minimum cost of 15: enough to sell
    it('says the position it reads after a BUY canceled after a fill before the hook runs', () => {
      placeBuy();
      cancel(1, { filled: 0.9, remaining: 0.1, portfolio: portfolioOf({ BTC: 0.9 }) });
      expect(heard).toEqual([`[${idOf(1)}] BUY order canceled: 0.9 BTC filled, enough to sell: the strategy is long`, 'onOrderCanceled']);
    });

    it('relays that line as strategy info, at info level', () => {
      placeBuy();
      cancel(1, { filled: 0.9, remaining: 0.1, portfolio: portfolioOf({ BTC: 0.9 }) });
      expect(infos).toEqual([
        {
          timestamp: FIRST_MINUTE_END,
          level: 'info',
          tag: 'strategy',
          message: `[${idOf(1)}] BUY order canceled: 0.9 BTC filled, enough to sell: the strategy is long`,
        },
      ]);
    });

    // The SELL of all the asset completes after selling 1 BTC, the balances of its end read before it: the position is kept, long
    describe('when the Trader could not read the balances after the SELL that follows', () => {
      const KEPT_LINE = `[${idOf(2)}] SELL order completed after selling 1 BTC, and the Trader could not read the balances after it: the strategy stays long until the end of its next order`;

      beforeEach(() => {
        placeBuy();
        complete(1, { portfolio: portfolioOf({ BTC: 1, USDT: 0 }) });
        positions().sell(BTC_MARKET);
        heard.length = 0;
        answers.length = 0;
        complete(2, { portfolio: portfolioOf({ BTC: 1, USDT: 0 }), readAfterOrder: false });
      });

      it('warns that it keeps the position before the hook runs', () => {
        expect(heard).toEqual([KEPT_LINE, 'onOrderCompleted']);
      });

      it('relays that warning as strategy info', () => {
        expect(infos.at(-1)).toEqual({ timestamp: FIRST_MINUTE_END, level: 'warn', tag: 'strategy', message: KEPT_LINE });
      });

      it('has the hook read the position kept', () => {
        expect(answers).toEqual([LONG]);
      });
    });

    it('leaves the position as it was after an order created with tools.createOrder', () => {
      placeBuy();
      cancel(1, { filled: 0, remaining: 1, portfolio: portfolioOf({ BTC: 0 }) });
      manager['tools'].createOrder({ ...BTC_MARKET, side: 'BUY', amount: 1 });
      complete(2, { portfolio: portfolioOf({ BTC: 1, USDT: 0 }) });
      expect(positionOf(manager['tools'], BTC)).toEqual(FLAT);
    });

    // Read before the SELL, the portfolio holds no USDT free: a BUY estimated from it would be skipped. The SELL's end carries the 1000
    // USDT read after it, 50 % of which, 475 USDT once 5 % is kept back, is above the minimum cost of 15. However it ends, having sold
    // all of its 4.75 BTC, the SELL leaves the pair flat, and the hook of its end buys again: the third order.
    it.each`
      end                                | play
      ${'completed'}                     | ${() => complete(2, { amount: 4.75, portfolio: portfolioOf({ USDT: 1000, BTC: 0 }) })}
      ${'canceled after selling it all'} | ${() => cancel(2, { amount: 4.75, filled: 4.75, remaining: 0, portfolio: portfolioOf({ USDT: 1000, BTC: 0 }) })}
      ${'errored after selling it all'}  | ${() => fail(2, { amount: 4.75, filled: 4.75, portfolio: portfolioOf({ USDT: 1000, BTC: 0 }) })}
    `('has a BUY placed from the hook of a SELL $end, right after it, estimated from the portfolio of that end', ({ play }) => {
      let id: UUID | undefined;
      const buyAgain = ({ order, tools }: { order: { side: string }; tools: Tools<object> }) => {
        if (order.side === 'SELL') id = tools.positions.buy({ symbol: BTC, type: 'STICKY' });
      };
      start({ init: trackEveryPair, onOrderCompleted: buyAgain, onOrderCanceled: buyAgain, onOrderErrored: buyAgain });
      manager.onPortfolioChange(portfolioOf({ USDT: 1000 }));
      sendCandle(0);
      positions().buy({ symbol: BTC, type: 'STICKY' });
      complete(1, { amount: 4.75, portfolio: portfolioOf({ USDT: 500, BTC: 4.75 }) });
      manager.onPortfolioChange(portfolioOf({ USDT: 0, BTC: 4.75 }));
      positions().sell(BTC_MARKET);
      play();
      expect(id).toBe(idOf(3));
    });
  });

  // A BUY of 0.5 BTC at 50000 asking for a stop of 2 % without trigger: active once the BUY completes, it trails the next minute from its
  // open, 50000, its stop price 49000, which the low of that minute, 48000, goes through
  describe('the trailing stop of a BUY', () => {
    /** What tools.positions answered on BTC/USDT in each onTrailingStopTriggered, in order */
    let answers: ReturnType<typeof positionOf>[];

    /** Starts a run of `pairs` whose onTrailingStopTriggered records what tools.positions answers then on BTC/USDT */
    const startTrailing = (pairs: TradingPair[] = [BTC]) => {
      start(
        {
          init: trackEveryPair,
          onTrailingStopTriggered: (_orderId, _state, tools) => {
            answers.push(positionOf(tools, BTC));
          },
        },
        { pairs },
      );
      sendCandle(0, Object.fromEntries(pairs.map(pair => [pair, CLOSES[pair]])));
    };
    /**
     * Completes the n-th order relayed, the BUY of 0.5 BTC at 50000, the portfolio after it holding 1000 USDT besides: enough for the
     * BUY of another pair, which the book would skip on no currency, never reading the stops it remembers
     */
    const completeBuy = (n: number) => complete(n, { amount: 0.5, price: 50000, portfolio: portfolioOf({ BTC: 0.5, USDT: 1000 }) });
    /** Sends minute `n`, whose low goes through the stop price of 49000 */
    const fallThroughStop = (n: number) => manager.onOneMinuteBucket(btcMinute(n, { open: 50000, high: 50000, low: 48000, close: 48000 }));

    beforeEach(() => {
      answers = [];
    });

    describe('placed through tools.positions.buy', () => {
      beforeEach(() => {
        startTrailing();
        positions().buy({ ...BTC_MARKET, trailing: { percentage: 2 } });
        completeBuy(1);
        fallThroughStop(1); // The stop sends its SELL: order 2
      });

      it('has the book adopt the SELL of the stop, pending on the pair when onTrailingStopTriggered runs', () => {
        expect(answers).toEqual([SELLING]);
      });

      // Nothing of the asset is free after it: the strategy is flat, though it has no order hook
      it('settles the position as that SELL completes', () => {
        complete(2, { amount: 0.5, price: 48000, portfolio: portfolioOf({ BTC: 0, USDT: 24000 }) });
        expect(positionOf(manager['tools'], BTC)).toEqual(FLAT);
      });

      // Canceled after selling 0.2, the SELL leaves 0.3 BTC, free after it: the stop is active again for that rest, and the next minute
      // opens at 48500, under its stop price, which triggers it again
      it('has the book adopt the next SELL of the stop once it is active again', () => {
        cancel(2, { filled: 0.2, remaining: 0.3, price: 48000, portfolio: portfolioOf({ BTC: 0.3 }) });
        manager.onOneMinuteBucket(btcMinute(2, { open: 48500, high: 48500, low: 48500, close: 48500 }));
        expect(answers).toEqual([SELLING, SELLING]);
      });
    });

    it('adopts nothing for the stop of a BUY created with tools.createOrder', () => {
      startTrailing();
      manager['tools'].createOrder({ ...BTC_MARKET, side: 'BUY', trailing: { percentage: 2 } });
      completeBuy(1);
      fallThroughStop(1);
      expect(answers).toEqual([FLAT]);
    });

    // The book forgets the BUYs whose stop is no longer alive as another BUY asks for a stop: it keeps one pending, its BUY not completed
    // yet, and one armed. The BUY of BTC/USDT is order 1.
    const buyBothThenComplete = () => {
      positions().buy({ ...BTC_MARKET, trailing: { percentage: 2 } });
      positions().buy({ symbol: ETH, type: 'MARKET', trailing: { percentage: 3 } });
      completeBuy(1);
    };
    const buyCompleteThenBuyEthereum = () => {
      positions().buy({ ...BTC_MARKET, trailing: { percentage: 2 } });
      completeBuy(1);
      positions().buy({ symbol: ETH, type: 'MARKET', trailing: { percentage: 3 } });
    };

    it.each`
      stop         | play
      ${'pending'} | ${buyBothThenComplete}
      ${'armed'}   | ${buyCompleteThenBuyEthereum}
    `('has the book adopt the SELL of a stop still $stop when a BUY of another pair asked for a stop', ({ play }) => {
      startTrailing([BTC, ETH]);
      play();
      fallThroughStop(1);
      expect(answers).toEqual([SELLING]);
    });

    // While the SELL pends, the minute goes through the stop price: the stop is held back, sending no SELL of its own
    describe('when the strategy sells through tools.positions.sell', () => {
      beforeEach(() => {
        startTrailing();
        positions().buy({ ...BTC_MARKET, trailing: { percentage: 2 } });
        completeBuy(1);
        positions().sell(BTC_MARKET); // Order 2
        fallThroughStop(1);
      });

      it('holds the stop back while that SELL pends', () => {
        expect(relayed.map(({ side }) => side)).toEqual(['BUY', 'SELL']);
      });

      it('cancels the stop once that SELL completes', () => {
        complete(2, { amount: 0.5, price: 48000, portfolio: portfolioOf({ BTC: 0, USDT: 24000 }) });
        expect(manager['trailingStopManager'].getOrders().size).toBe(0);
      });
    });
  });
});
