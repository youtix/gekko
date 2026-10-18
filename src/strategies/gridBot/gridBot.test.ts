import { GekkoError } from '@errors/gekko.error';
import { OrderOutOfRangeError } from '@errors/orderOutOfRange.error';
import { ETH_IGNORED_WARNING, logsAtInit } from '@helpers/strategy/positionTracker/positionTracker.mock';
import type { Candle } from '@models/candle.types';
import type { CandleBucket } from '@models/event.types';
import type { LogLevel } from '@models/logLevel.types';
import type { OrderSide } from '@models/order.types';
import type { BalanceDetail, Portfolio } from '@models/portfolio.types';
import type { TradingPair } from '@models/utility.types';
import { dummyExchangeSchema } from '@services/exchange/dummy/dummyCentralizedExchange.schema';
import type { MarketData, OpenOrder, OpenOrderType } from '@services/exchange/exchange.types';
import type { UUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GridBot } from './gridBot.strategy';
import type { GridBotStrategyParams } from './gridBot.types';
import * as GridBotUtils from './gridBot.helper';

const defaultParams: GridBotStrategyParams = {
  buyLevels: 2,
  sellLevels: 2,
  spacingType: 'fixed',
  spacingValue: 5,
  retryOnError: 3,
};

const marketDataMock: MarketData = {
  amount: { min: 0.1 },
  precision: { price: 0.01, amount: 0.01 },
};

const marketData = new Map([['BTC/USDT', marketDataMock]]);

const makeCandle = (close: number): CandleBucket => {
  const candle: Candle = {
    start: 0,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  };
  return new Map([['BTC/USDT', candle]]);
};

// The split that funds every level of the default grid at 100 with 2.5: its two SELLs 5 BTC, its BUYs at 95 and 90 462.5 USDT
const balancedPortfolio: Portfolio = new Map<string, BalanceDetail>([
  ['BTC', { free: 5, used: 0, total: 5 }],
  ['USDT', { free: 462.5, used: 0, total: 462.5 }],
]);

const unbalancedPortfolio: Portfolio = new Map<string, BalanceDetail>([
  ['BTC', { free: 0, used: 0, total: 0 }],
  ['USDT', { free: 1000, used: 0, total: 1000 }],
]);

// The reason the order layer ends a creation lost on the network with, an order that says it may be live on the exchange
// (OrderErroredEvent.mayBeLive)
const lostOnTheNetwork =
  'Outcome unknown: the order may be live on the exchange, check it before placing it again ([EXCHANGE] binance POST https://api.binance.com/api/v3/order 504 Gateway Time-out)';

describe('GridBot', () => {
  let strategy: GridBot;
  let createOrder: ReturnType<typeof vi.fn>;
  let cancelOrder: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.fn>;
  let issuedOrders: Array<{ id: UUID; price: number; side: OrderSide; type: string; amount: number }>;
  let settledIds: Set<UUID>;
  let tools: any;

  beforeEach(() => {
    strategy = new GridBot();
    issuedOrders = [];
    settledIds = new Set();
    // As the StrategyManager's, which throws a GekkoError on 'error': with a log that returned, these tests ran code after it that a
    // real run never reached
    log = vi.fn((level: LogLevel, message: string) => {
      if (level === 'error') throw new GekkoError('strategy', message);
    });
    cancelOrder = vi.fn();
    createOrder = vi.fn(order => {
      const id = `order-${issuedOrders.length + 1}` as UUID;
      issuedOrders.push({ id, price: order.price ?? 0, side: order.side, type: order.type, amount: order.amount });
      return id;
    });
    // tools should simulate the structure expected by the strategy
    tools = { strategyParams: defaultParams, marketData, createOrder, cancelOrder, log, pairs: ['BTC/USDT'] };
  });

  const initStrategy = (price = 100, params: Partial<GridBotStrategyParams> = {}, portfolio: Portfolio = balancedPortfolio) => {
    tools.strategyParams = { ...defaultParams, ...params };
    strategy.init({
      candle: makeCandle(price),
      portfolio,
      tools,
      addIndicator: vi.fn(),
    });
  };

  /** A candle after the warmup: the first one starts the grid around its close */
  const afterWarmup = (price: number, portfolio: Portfolio = balancedPortfolio) =>
    strategy.onTimeframeCandleAfterWarmup({ candle: makeCandle(price), portfolio, tools });

  /** A run without warmup: its first candle, which init receives, is also the first after the warmup */
  const startStrategy = (price = 100, params: Partial<GridBotStrategyParams> = {}, portfolio: Portfolio = balancedPortfolio) => {
    initStrategy(price, params, portfolio);
    afterWarmup(price, portfolio);
  };

  /** Runs a step that stops the run, as tools.log('error') does, to look at what it did before */
  const untilStopped = (step: () => void) => {
    try {
      step();
    } catch (err) {
      if (!(err instanceof GekkoError)) throw err;
    }
  };

  const findOrderId = (price: number, side: OrderSide): UUID | undefined =>
    issuedOrders.find(order => order.price === price && order.side === side)?.id;

  /** The order a level holds now at that price and side: a level armed or placed again gets a new order at the same price */
  const liveOrder = (price: number, side: OrderSide) => issuedOrders.findLast(order => order.price === price && order.side === side);

  /**
   * Delivers the outcome of the live order at that price and side, as the Trader reports it: a cancel with nothing filled and an
   * error 'Test error' that filled nothing and is not live, a refusal, unless `details` say otherwise
   */
  const settle = (
    outcome: 'completed' | 'canceled' | 'errored',
    price: number,
    side: OrderSide,
    details: { filled?: number; remaining?: number; reason?: string; mayBeLive?: boolean } = {},
  ) => {
    const { id, amount } = liveOrder(price, side) ?? {};
    const order = { id, symbol: 'BTC/USDT', side, type: 'LIMIT', amount, price } as any;
    const exchange = { price, portfolio: balancedPortfolio };
    settledIds.add(order.id);
    if (outcome === 'completed') strategy.onOrderCompleted({ order, exchange, tools });
    if (outcome === 'canceled')
      strategy.onOrderCanceled({ order: { ...order, filled: 0, remaining: amount, ...details }, exchange, tools });
    if (outcome === 'errored')
      strategy.onOrderErrored({ order: { ...order, reason: 'Test error', filled: 0, mayBeLive: false, ...details }, exchange, tools });
  };

  /** The orders sent and not settled, as `side price` from the lowest price: the book the exchange holds */
  const openBook = () =>
    issuedOrders
      .filter(({ id }) => !settledIds.has(id))
      .sort((a, b) => a.price - b.price || a.side.localeCompare(b.side))
      .map(({ side, price }) => `${side} ${price}`);

  /** The orders sent once `count` had been, as `type side price` */
  const sentAfter = (count: number) => issuedOrders.slice(count).map(({ type, side, price }) => `${type} ${side} ${price}`);

  /** The orders sent once `count` had been, as `side price xamount` */
  const amountsSentAfter = (count: number) => issuedOrders.slice(count).map(({ side, price, amount }) => `${side} ${price} x${amount}`);

  // GridBot traded the first pair watched and ignored the others without a word, while their candles are still required every minute
  describe('the pair traded', () => {
    const ethCandle: Candle = { start: 0, open: 2000, high: 2000, low: 2000, close: 2000, volume: 1 };
    /** A bucket of BTC/USDT closing at that price, then ETH/USDT, as watch.assets lists BTC then ETH */
    const withEth = (close: number): CandleBucket => makeCandle(close).set('ETH/USDT', ethCandle);

    it.each`
      case           | pairs                       | expected
      ${'one pair'}  | ${['BTC/USDT']}             | ${[]}
      ${'two pairs'} | ${['BTC/USDT', 'ETH/USDT']} | ${[ETH_IGNORED_WARNING]}
    `('warns once, at init, when it ignores watched pairs: $case', ({ pairs, expected }) => {
      expect(logsAtInit(new GridBot(), pairs, defaultParams)).toEqual(expected);
    });

    it('places its grid on the first pair watched, BTC/USDT, the bucket holding ETH/USDT as well', () => {
      tools.strategyParams = defaultParams;
      strategy.init({ candle: withEth(100), portfolio: balancedPortfolio, tools, addIndicator: vi.fn() });
      strategy.onTimeframeCandleAfterWarmup({ candle: withEth(100), portfolio: balancedPortfolio, tools });

      expect(createOrder.mock.calls.map(([{ symbol, side, price }]) => `${symbol} ${side} ${price}`)).toEqual([
        'BTC/USDT BUY 90',
        'BTC/USDT BUY 95',
        'BTC/USDT SELL 105',
        'BTC/USDT SELL 110',
      ]);
    });
  });

  // GridBot keeps its grid in memory: restarted against an exchange that kept the grid of its previous run, it built a second grid
  // beside it, whose fills never reached it, or, the old grid holding the funds, stopped for an insufficient portfolio at every restart
  describe('orders open on the exchange at start-up', () => {
    /** An order the exchange lists as open, `filled` of it executed already */
    const openOrder = (id: string, type: OpenOrderType, side: OrderSide, remaining: number, price?: number, filled = 0): OpenOrder => ({
      id,
      side,
      type,
      price,
      amount: remaining + filled,
      filled,
      remaining,
      timestamp: 0,
    });
    const BUY_95 = openOrder('28458', 'LIMIT', 'BUY', 2, 95);
    const SELL_105_HALF_FILLED = openOrder('28459', 'LIMIT', 'SELL', 1, 105, 1);
    const STOP_LOSS = openOrder('28460', 'OTHER', 'SELL', 2);
    const UNFOLLOWED = [
      'GridBot keeps its grid in memory and follows only the orders it places: an order placed before this run, by a previous run,',
      'by hand or by another bot, would trade beside the new grid without GridBot hearing of its fills.',
      'Cancel the orders open on BTC/USDT on the exchange, then start again',
    ].join(' ');

    /** Runs init with the orders the exchange listed as open at start-up */
    const initOn = (openOrders?: Map<TradingPair, OpenOrder[]>) => {
      tools.strategyParams = defaultParams;
      strategy.init({ candle: makeCandle(100), portfolio: balancedPortfolio, tools, addIndicator: vi.fn(), openOrders });
    };

    it.each`
      description         | orders                                       | message
      ${'one order'}      | ${[BUY_95]}                                  | ${`GridBot: 1 order is open on BTC/USDT at start-up: LIMIT BUY 2 at 95 (id 28458). ${UNFOLLOWED}`}
      ${'several orders'} | ${[BUY_95, SELL_105_HALF_FILLED, STOP_LOSS]} | ${`GridBot: 3 orders are open on BTC/USDT at start-up: LIMIT BUY 2 at 95 (id 28458), LIMIT SELL 1 at 105 (id 28459), OTHER SELL 2 at market (id 28460). ${UNFOLLOWED}`}
    `('says why it stops at error level, naming $description open on its pair', ({ orders, message }) => {
      untilStopped(() => initOn(new Map([['BTC/USDT', orders]])));

      expect(log.mock.calls.filter(([level]) => level === 'error')).toEqual([['error', message]]);
    });

    it('stops the run at init', () => {
      expect(() => initOn(new Map([['BTC/USDT', [BUY_95]]]))).toThrow(GekkoError);
    });

    it.each`
      description                      | openOrders
      ${'no list of them'}             | ${undefined}
      ${'none listed'}                 | ${new Map()}
      ${'none on its pair'}            | ${new Map([['BTC/USDT', []]])}
      ${'orders on another pair only'} | ${new Map([['ETH/USDT', [BUY_95, STOP_LOSS]], ['BTC/USDT', []]])}
    `('starts with $description, and places its grid on the first candle after the warmup', ({ openOrders }) => {
      initOn(openOrders);
      afterWarmup(100);

      expect(openBook()).toEqual(['BUY 90', 'BUY 95', 'SELL 105', 'SELL 110']);
    });
  });

  // GridBot placed its grid from init, on the first candle of the warmup: in realtime a candle of the history replayed at start-up,
  // so the Trader sent live a grid centred on a stale close, a year old with 365 daily candles
  describe('warmup', () => {
    // The split of the default grid at 130, 2.5 a level: its BUYs at 125 and 120 take 612.5 USDT
    const balancedAt130: Portfolio = new Map<string, BalanceDetail>([
      ['BTC', { free: 5, used: 0, total: 5 }],
      ['USDT', { free: 612.5, used: 0, total: 612.5 }],
    ]);

    it.each`
      portfolio              | description
      ${balancedPortfolio}   | ${'a balanced portfolio, which gets its grid'}
      ${unbalancedPortfolio} | ${'an unbalanced portfolio, which gets its rebalance'}
    `('places no order from init, with $description', ({ portfolio }) => {
      initStrategy(100, {}, portfolio);

      expect(createOrder).not.toHaveBeenCalled();
    });

    it('places no order on a candle of the warmup', () => {
      initStrategy(100);
      strategy.onEachTimeframeCandle({ candle: makeCandle(130), portfolio: balancedPortfolio, tools });

      expect(createOrder).not.toHaveBeenCalled();
    });

    it('warns of no price out of range on a candle of the warmup, the grid not being placed yet', () => {
      initStrategy(100);
      strategy.onEachTimeframeCandle({ candle: makeCandle(150), portfolio: balancedPortfolio, tools });

      expect(log).not.toHaveBeenCalledWith('warn', expect.stringContaining('out of grid range'));
    });

    it('places the grid around the close of the first candle after the warmup, not around the close init received', () => {
      initStrategy(100, {}, balancedAt130);
      afterWarmup(130, balancedAt130);

      expect(issuedOrders.map(({ side, price }) => `${side} ${price}`)).toEqual(['BUY 120', 'BUY 125', 'SELL 135', 'SELL 140']);
    });

    // Centred on 200, a BUY of 2.54 BTC, where centred on the close init received, 100, it would be 5.19
    it('plans the rebalance at the close of the first candle after the warmup', () => {
      initStrategy(100, {}, unbalancedPortfolio);
      afterWarmup(200, unbalancedPortfolio);

      expect(createOrder.mock.calls).toEqual([[{ type: 'STICKY', side: 'BUY', amount: 2.54, symbol: 'BTC/USDT' }]]);
    });

    it('sizes on the portfolio of the first candle after the warmup, not on the one init received', () => {
      initStrategy(100, {}, unbalancedPortfolio);
      afterWarmup(100, balancedPortfolio);

      expect(issuedOrders.map(({ side, type }) => `${side} ${type}`)).toEqual(['BUY LIMIT', 'BUY LIMIT', 'SELL LIMIT', 'SELL LIMIT']);
    });

    it('starts the grid once: a later candle after the warmup places no other order', () => {
      startStrategy(100);
      afterWarmup(130);

      expect(createOrder).toHaveBeenCalledTimes(4);
    });
  });

  describe('grid placement', () => {
    it('places correct number of orders for balanced portfolio', () => {
      startStrategy(100);

      expect(createOrder).toHaveBeenCalledTimes(4);
    });

    it.each`
      buyLevels | sellLevels | expectedOrders
      ${1}      | ${1}       | ${2}
      ${2}      | ${2}       | ${4}
      ${3}      | ${2}       | ${5}
      ${2}      | ${3}       | ${5}
    `('places $expectedOrders orders for $buyLevels buy and $sellLevels sell levels', ({ buyLevels, sellLevels, expectedOrders }) => {
      // The split that funds 2 a level, which needs no rebalance: 2 BTC for each SELL, and 2 × the price of each BUY, 95, 90, 85…
      const btc = 2 * sellLevels;
      const usdt = Array.from({ length: buyLevels }, (_, i) => 2 * (95 - 5 * i)).reduce((total, cost) => total + cost, 0);
      const balancedForLevels: Portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: btc, used: 0, total: btc }],
        ['USDT', { free: usdt, used: 0, total: usdt }],
      ]);

      startStrategy(100, { buyLevels, sellLevels }, balancedForLevels);

      expect(createOrder).toHaveBeenCalledTimes(expectedOrders);
    });

    it('places buy orders below center price', () => {
      startStrategy(100);

      const buyOrders = issuedOrders.filter(o => o.side === 'BUY');
      expect(buyOrders.every(o => o.price < 100)).toBe(true);
    });

    it('places sell orders above center price', () => {
      startStrategy(100);

      const sellOrders = issuedOrders.filter(o => o.side === 'SELL');
      expect(sellOrders.every(o => o.price > 100)).toBe(true);
    });

    it('uses LIMIT order type for grid orders', () => {
      startStrategy(100);

      expect(issuedOrders.every(o => o.type === 'LIMIT')).toBe(true);
    });
  });

  describe('rebalancing', () => {
    // At 100, 1000 USDT or 10 BTC fund 1000 / (185 + 2 × 100) = 2.597… a level of the default grid once rebalanced: its SELLs take
    // 5.19… BTC, its BUYs at 95 and 90 take 480.5… USDT. From all in USDT, a BUY of (1000 - 480.5…) / 100 = 5.19… BTC, 5.19 on the
    // amount step; from all in BTC, a SELL of 10 - 5.19… = 4.80…, 4.8
    const assetOnlyPortfolio: Portfolio = new Map<string, BalanceDetail>([
      ['BTC', { free: 10, used: 0, total: 10 }],
      ['USDT', { free: 0, used: 0, total: 0 }],
    ]);
    /** A portfolio of `btc` BTC and `usdt` USDT, all free */
    const freePortfolio = (btc: number, usdt: number): Portfolio =>
      new Map<string, BalanceDetail>([
        ['BTC', { free: btc, used: 0, total: btc }],
        ['USDT', { free: usdt, used: 0, total: usdt }],
      ]);
    /** Ends the rebalance order placed last as the Trader reports a failure, the balances it left in the portfolio */
    const endRebalance = (outcome: 'errored' | 'canceled', left: Portfolio) => {
      const order = { id: issuedOrders[issuedOrders.length - 1].id, reason: 'Test error' } as any;
      const exchange = { price: 100, portfolio: left };
      if (outcome === 'errored') strategy.onOrderErrored({ order, exchange, tools });
      else strategy.onOrderCanceled({ order, exchange, tools });
    };

    // The side of the rebalance used to be asserted on a BUY alone, the test named after the side checking the type of the order: a
    // STICKY order hard-coded to BUY, rebalancing a portfolio rich in BTC by buying more of it, failed only a test of locked funds
    it.each`
      portfolio              | description      | expected
      ${unbalancedPortfolio} | ${'all in USDT'} | ${{ type: 'STICKY', side: 'BUY', amount: 5.19, symbol: 'BTC/USDT' }}
      ${assetOnlyPortfolio}  | ${'all in BTC'}  | ${{ type: 'STICKY', side: 'SELL', amount: 4.8, symbol: 'BTC/USDT' }}
    `('rebalances a portfolio $description with a STICKY $expected.side of $expected.amount', ({ portfolio, expected }) => {
      startStrategy(100, {}, portfolio);

      expect(createOrder.mock.calls).toEqual([[expected]]);
    });

    // The rebalance aimed at 50/50, a BUY or a SELL of 5 BTC here: the grid built on 5 BTC and 500 USDT traded 2.5 a level, and its
    // BUYs at 95 and 90 left 37.5 USDT idle for the whole run
    it.each`
      portfolio              | side
      ${unbalancedPortfolio} | ${'BUY'}
      ${assetOnlyPortfolio}  | ${'SELL'}
    `('builds, once the $side rebalance fills, a grid that the BTC and the USDT it leaves fund alike: 2.59 a level', ({ portfolio }) => {
      startStrategy(100, {}, portfolio);
      const [{ id, side, amount }] = issuedOrders;
      // Filled at 100, without fee
      const bought = side === 'BUY' ? amount : -amount;
      const rebalanced = freePortfolio(portfolio.get('BTC')!.free + bought, portfolio.get('USDT')!.free - bought * 100);
      strategy.onOrderCompleted({ order: { id } as any, exchange: { price: 100, portfolio: rebalanced }, tools });

      expect(amountsSentAfter(1)).toEqual(['BUY 90 x2.59', 'BUY 95 x2.59', 'SELL 105 x2.59', 'SELL 110 x2.59']);
    });

    // The plan made again after a failure used to be checked by the count of orders sent. It is made on the balances the failure
    // left, a partial fill included: 3 BTC and 700 USDT fund the same 2.597… a level, a BUY of (700 - 480.5…) / 100 = 2.19…, and 7 BTC
    // and 300 USDT a SELL of 7 - 5.19… = 1.80…
    it.each`
      portfolio              | outcome       | left                     | description         | expected
      ${unbalancedPortfolio} | ${'errored'}  | ${unbalancedPortfolio}   | ${'nothing bought'} | ${['STICKY BUY 5.19', 'STICKY BUY 5.19']}
      ${unbalancedPortfolio} | ${'canceled'} | ${freePortfolio(3, 700)} | ${'3 BTC bought'}   | ${['STICKY BUY 5.19', 'STICKY BUY 2.19']}
      ${assetOnlyPortfolio}  | ${'errored'}  | ${assetOnlyPortfolio}    | ${'nothing sold'}   | ${['STICKY SELL 4.8', 'STICKY SELL 4.8']}
      ${assetOnlyPortfolio}  | ${'canceled'} | ${freePortfolio(7, 300)} | ${'3 BTC sold'}     | ${['STICKY SELL 4.8', 'STICKY SELL 1.8']}
    `('places the rebalance again on its side once $outcome with $description', ({ portfolio, outcome, left, expected }) => {
      startStrategy(100, {}, portfolio);
      endRebalance(outcome, left);

      expect(issuedOrders.map(({ type, side, amount }) => `${type} ${side} ${amount}`)).toEqual(expected);
    });

    it('builds the grid once a failed rebalance leaves the balances at the split of the grid', () => {
      startStrategy(100, {}, unbalancedPortfolio);
      endRebalance('errored', balancedPortfolio);

      expect(amountsSentAfter(1)).toEqual(['BUY 90 x2.5', 'BUY 95 x2.5', 'SELL 105 x2.5', 'SELL 110 x2.5']);
    });

    it.each`
      outcome       | reason
      ${'errored'}  | ${'Test error'}
      ${'canceled'} | ${'Order was canceled'}
    `('warns that the attempt failed once the rebalance is $outcome', ({ outcome, reason }) => {
      startStrategy(100, {}, unbalancedPortfolio);
      endRebalance(outcome, unbalancedPortfolio);

      expect(log).toHaveBeenCalledWith('warn', `GridBot: Rebalance attempt 1 failed: ${reason}. Retrying...`);
    });

    // A failed attempt was warned of as retried whatever followed it: the grid built on the balances it left, or the run stopped
    describe('the warning of a failed attempt, which says what follows it', () => {
      /** The lines logged at warn and error level */
      const warningsAndErrors = () => log.mock.calls.filter(([level]) => level === 'warn' || level === 'error');

      it('says the rebalance is not placed again once the balances it left need none: the grid is built on them', () => {
        startStrategy(100, {}, unbalancedPortfolio);
        endRebalance('errored', balancedPortfolio);

        expect(warningsAndErrors()).toEqual([
          [
            'warn',
            'GridBot: Rebalance attempt 1 failed: Test error. Not placed again: the free balances it left need no rebalance, the grid is built on them',
          ],
        ]);
      });

      // The last attempt stops the run before any warning
      it('says the rebalance is retried only when it is placed again, not before the attempt that stops the run', () => {
        startStrategy(100, { retryOnError: 1 }, unbalancedPortfolio);
        untilStopped(() => [1, 2].forEach(() => endRebalance('errored', unbalancedPortfolio)));

        expect(warningsAndErrors()).toEqual([
          ['warn', 'GridBot: Rebalance attempt 1 failed: Test error. Retrying...'],
          ['error', 'GridBot: Rebalance failed after 2 attempts (retryOnError: 1): the grid is not built. Last error: Test error'],
        ]);
      });
    });

    // A sell-only grid buys all the currency pays. Divided in binary, 7.0007 / 100.01 was 0.06999999999999999, a BUY of 0.06; reckoned
    // in binary, 0.27 at 100.01 cost 27.002700000000004, more than the 27.0027 free: the BUY was left out for insufficient currency,
    // and the grid, without BTC to sell, stopped the run for an insufficient portfolio
    describe('of a sell-only grid holding exactly what a whole number of steps of its BUY costs', () => {
      const sellOnly = { buyLevels: 0, sellLevels: 5, spacingType: 'percent', spacingValue: 1 } as const;

      beforeEach(() => {
        tools.marketData = new Map([['BTC/USDT', { price: { min: 0.01 }, precision: { price: 0.01, amount: 0.01 } }]]);
      });

      it.each`
        usdt       | amount
        ${7.0007}  | ${0.07}
        ${27.0027} | ${0.27}
      `('rebalances $usdt USDT with a STICKY BUY of all of it, $amount at 100.01', ({ usdt, amount }) => {
        startStrategy(100, sellOnly, freePortfolio(0, usdt));

        expect(createOrder.mock.calls).toEqual([[{ type: 'STICKY', side: 'BUY', amount, symbol: 'BTC/USDT' }]]);
      });
    });

    // A rebalance used to be planned and placed again whatever the error: one lost on the network may be live on the exchange,
    // untracked, and both filled, the portfolio was rebalanced twice
    describe('when the outcome of the rebalance order is unknown', () => {
      const loseRebalance = () =>
        strategy.onOrderErrored({
          order: { id: issuedOrders[0].id, reason: lostOnTheNetwork, mayBeLive: true } as any,
          exchange: { price: 100, portfolio: unbalancedPortfolio },
          tools,
        });

      it('stops the run, the grid not built', () => {
        startStrategy(100, {}, unbalancedPortfolio);

        expect(loseRebalance).toThrow(
          `GridBot: The rebalance, a STICKY BUY of 5.19, may be live on the exchange without GridBot tracking it: the grid is not built. Check it on the exchange. Last error: ${lostOnTheNetwork}`,
        );
      });

      it('does not place the rebalance again', () => {
        startStrategy(100, {}, unbalancedPortfolio);
        untilStopped(loseRebalance);

        expect(issuedOrders.map(({ type, side }) => `${type} ${side}`)).toEqual(['STICKY BUY']);
      });

      // Its poll failed for good while it was open, as the order says: worded by the exchange, the reason alone was taken for a refusal
      it('stops the run once the rebalance may be live as the order says it, whatever its reason', () => {
        startStrategy(100, {}, unbalancedPortfolio);
        const failPoll = () =>
          strategy.onOrderErrored({
            order: { id: issuedOrders[0].id, reason: 'Invalid API key', mayBeLive: true } as any,
            exchange: { price: 100, portfolio: unbalancedPortfolio },
            tools,
          });

        expect(failPoll).toThrow(
          'GridBot: The rebalance, a STICKY BUY of 5.19, may be live on the exchange without GridBot tracking it: the grid is not built. Check it on the exchange. Last error: Invalid API key',
        );
      });
    });

    // The grid used to be built anyway on the portfolio as it was, after a tools.log('error') that had already stopped the run: these
    // tests ran that code with a log that returned
    describe('once the rebalance failed at every attempt', () => {
      // Short of BTC for the grid, yet with both sides funded: built without the rebalance, the grid would have 4 levels of 1.5 BTC
      const shortOfAssetPortfolio: Portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: 3, used: 0, total: 3 }],
        ['USDT', { free: 1000, used: 0, total: 1000 }],
      ]);

      /** Ends the live rebalance order `times` times in a row, as the Trader reports it, the portfolio left as it was */
      const failRebalance = (times: number, outcome: 'errored' | 'canceled') => {
        for (let i = 0; i < times; i++) {
          const order = { id: issuedOrders[issuedOrders.length - 1].id, reason: 'Test error' } as any;
          const exchange = { price: 100, portfolio: shortOfAssetPortfolio };
          if (outcome === 'errored') strategy.onOrderErrored({ order, exchange, tools });
          else strategy.onOrderCanceled({ order, exchange, tools });
        }
      };

      it.each`
        outcome       | retryOnError | attempts | reason
        ${'errored'}  | ${1}         | ${2}     | ${'Test error'}
        ${'errored'}  | ${3}         | ${4}     | ${'Test error'}
        ${'canceled'} | ${3}         | ${4}     | ${'Order was canceled'}
      `(
        'stops the run once $attempts attempts in a row are $outcome, with retryOnError $retryOnError',
        ({ outcome, retryOnError, attempts, reason }) => {
          startStrategy(100, { retryOnError }, shortOfAssetPortfolio);

          expect(() => failRebalance(attempts, outcome)).toThrow(
            `GridBot: Rebalance failed after ${attempts} attempts (retryOnError: ${retryOnError}): the grid is not built. Last error: ${reason}`,
          );
        },
      );

      it('places the rebalance again until its last attempt', () => {
        startStrategy(100, { retryOnError: 3 }, shortOfAssetPortfolio);

        expect(() => failRebalance(3, 'errored')).not.toThrow();
      });

      it('builds no grid on the portfolio as it is: the orders sent are the attempts of the rebalance', () => {
        startStrategy(100, { retryOnError: 3 }, shortOfAssetPortfolio);
        untilStopped(() => failRebalance(4, 'errored'));

        expect(issuedOrders.map(({ type, side }) => `${type} ${side}`)).toEqual(['STICKY BUY', 'STICKY BUY', 'STICKY BUY', 'STICKY BUY']);
      });
    });

    // The rebalance used to be planned on the total balances, funds locked in other orders included, while the grid is sized on the
    // free ones, the only funds its orders can use. 0.01 BTC locked and 600 USDT free were found balanced, and the grid, built on no
    // BTC, stopped the run for an insufficient portfolio; with 0.01 BTC free besides, a balanced free part was rebalanced by a STICKY
    // SELL of the free BTC to match the locked one, and the grid built on half of it. Planned on the free balances, the rebalance
    // balances what the grid uses.
    describe('when part of the balances is locked in other orders', () => {
      const lotMarketData = new Map([['BTC/USDT', { precision: { price: 0.01, amount: 0.0001 }, amount: { min: 0.0001 } }]]);
      const percentGrid = { buyLevels: 5, sellLevels: 5, spacingType: 'percent', spacingValue: 1 } as const;
      const portfolioOf = (btc: Omit<BalanceDetail, 'total'>, usdt: Omit<BalanceDetail, 'total'>): Portfolio =>
        new Map([
          ['BTC', { ...btc, total: btc.free + btc.used }],
          ['USDT', { ...usdt, total: usdt.free + usdt.used }],
        ]);
      const btcLocked = portfolioOf({ free: 0, used: 0.01 }, { free: 600, used: 0 });
      // The split of the grid at 60000, 0.002 a level: 0.01 BTC for its SELLs, 582 USDT for its BUYs at 59400 down to 57000
      const btcLockedFreeBalanced = portfolioOf({ free: 0.01, used: 0.01 }, { free: 582, used: 0 });
      const usdtLocked = portfolioOf({ free: 0.01, used: 0 }, { free: 0, used: 600 });
      const usdtLockedFreeBalanced = portfolioOf({ free: 0.01, used: 0 }, { free: 582, used: 600 });

      beforeEach(() => {
        tools.marketData = lotMarketData;
      });

      it.each`
        portfolio                 | description                                      | expected
        ${btcLocked}              | ${'0.01 BTC locked and 600 USDT free'}           | ${['STICKY BUY 0.005']}
        ${btcLockedFreeBalanced}  | ${'0.01 BTC locked, 0.01 BTC and 582 USDT free'} | ${['LIMIT BUY 0.002', 'LIMIT SELL 0.002']}
        ${usdtLocked}             | ${'600 USDT locked and 0.01 BTC free'}           | ${['STICKY SELL 0.0049']}
        ${usdtLockedFreeBalanced} | ${'600 USDT locked, 0.01 BTC and 582 USDT free'} | ${['LIMIT BUY 0.002', 'LIMIT SELL 0.002']}
      `('rebalances the free balances, $description, at 60000: $expected', ({ portfolio, expected }) => {
        startStrategy(60000, percentGrid, portfolio);

        expect([...new Set(issuedOrders.map(({ type, side, amount }) => `${type} ${side} ${amount}`))]).toEqual(expected);
      });

      it.each`
        portfolio                                                            | description       | locked
        ${btcLocked}                                                         | ${'BTC'}          | ${'0.01 BTC locked in other orders, left out: the rebalance and the grid use the free balances only, 0 BTC and 600 USDT'}
        ${usdtLockedFreeBalanced}                                            | ${'USDT'}         | ${'600 USDT locked in other orders, left out: the rebalance and the grid use the free balances only, 0.01 BTC and 582 USDT'}
        ${portfolioOf({ free: 0.01, used: 0.01 }, { free: 600, used: 600 })} | ${'BTC and USDT'} | ${'0.01 BTC and 600 USDT locked in other orders, left out: the rebalance and the grid use the free balances only, 0.01 BTC and 600 USDT'}
      `('reports the $description locked in other orders at info', ({ portfolio, locked }) => {
        startStrategy(60000, percentGrid, portfolio);

        expect(log).toHaveBeenCalledWith('info', `GridBot: ${locked}`);
      });

      it('reports them once: not again when the grid is built after the rebalance', () => {
        startStrategy(60000, percentGrid, btcLocked);
        const rebalanced = portfolioOf({ free: 0.005, used: 0.01 }, { free: 299.88, used: 0 });
        strategy.onOrderCompleted({ order: { id: issuedOrders[0].id } as any, exchange: { price: 60000, portfolio: rebalanced }, tools });

        expect(log.mock.calls.filter(([, message]) => message.includes('locked in other orders'))).toHaveLength(1);
      });

      it('reports nothing locked when nothing is', () => {
        startStrategy(100);

        expect(log).not.toHaveBeenCalledWith('info', expect.stringContaining('locked in other orders'));
      });
    });

    // Planned on the free balances, a rebalance exceeds them by a rounding at most: a plan they cannot pay is still not sent, and the
    // grid is built on them as they are. A BUY is paid at the price of its STICKY order, the maker fee on top: 5 at 100, a notional
    // of 500, takes 500.25002 at 100.01.
    describe('when the free balances cannot pay for the rebalance planned', () => {
      const feeMarketData = new Map([['BTC/USDT', { ...marketDataMock, price: { min: 0.01 }, fee: { maker: 0.0004 } }]]);
      const partlyLocked: Portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: 0, used: 0, total: 0 }],
        ['USDT', { free: 500.22, used: 499.78, total: 1000 }],
      ]);
      const sellOfSix = { side: 'SELL', amount: 6, estimatedNotional: 600, centerPrice: 100 };
      const buyOfFive = { side: 'BUY', amount: 5, estimatedNotional: 500, centerPrice: 100 };

      it.each`
        plan         | portfolio            | markets          | description                              | warning
        ${sellOfSix} | ${balancedPortfolio} | ${marketData}    | ${'a SELL of 6, 5 BTC free'}             | ${'Insufficient asset for rebalance'}
        ${buyOfFive} | ${partlyLocked}      | ${feeMarketData} | ${'a BUY of 5 at 100, 500.22 USDT free'} | ${'Insufficient currency for rebalance'}
      `('warns that it leaves out $description', ({ plan, portfolio, markets, warning }) => {
        tools.marketData = markets;
        vi.spyOn(GridBotUtils, 'computeRebalancePlan').mockReturnValue(plan);
        startStrategy(100, {}, portfolio);

        expect(log).toHaveBeenCalledWith('warn', `GridBot: ${warning}, building grid with current allocation`);
      });

      it.each`
        plan         | portfolio            | markets          | description                              | expected
        ${sellOfSix} | ${balancedPortfolio} | ${marketData}    | ${'a SELL of 6, 5 BTC free'}             | ${['LIMIT BUY', 'LIMIT BUY', 'LIMIT SELL', 'LIMIT SELL']}
        ${buyOfFive} | ${partlyLocked}      | ${feeMarketData} | ${'a BUY of 5 at 100, 500.22 USDT free'} | ${['LIMIT BUY', 'LIMIT BUY']}
      `('builds the grid on the free balances instead of $description', ({ plan, portfolio, markets, expected }) => {
        tools.marketData = markets;
        vi.spyOn(GridBotUtils, 'computeRebalancePlan').mockReturnValue(plan);
        startStrategy(100, {}, portfolio);

        expect(issuedOrders.map(order => `${order.type} ${order.side}`)).toEqual(expected);
      });
    });
  });

  describe('validation', () => {
    it.each`
      price  | params                                                      | expectedError
      ${0}   | ${{}}                                                       | ${'GridBot: Center price must be positive'}
      ${100} | ${{ buyLevels: 25, spacingType: 'fixed', spacingValue: 5 }} | ${'GridBot: Grid configuration would result in non-positive buy prices'}
    `('stops the run with $expectedError', ({ price, params, expectedError }) => {
      expect(() => startStrategy(price, params)).toThrow(expectedError);
    });

    it('stops the run if the grid bounds cannot be computed', () => {
      vi.spyOn(GridBotUtils, 'computeGridBounds').mockReturnValue(null);

      expect(() => startStrategy(100)).toThrow('GridBot: Could not compute valid grid bounds');
    });

    // GridBot used to go on after tools.log('error'), as if it had only logged
    it('stops the run on its own, with a log that would return at error level', () => {
      log.mockImplementation(() => undefined);

      expect(() => startStrategy(0)).toThrow('GridBot: Center price must be positive');
    });

    // The start checked the lowest BUY around its own center price only, while a grid rebalanced first is planned again or built
    // around the price the rebalance ended at. The default grid started at 10.01 has its lowest BUY at 0.01: rebalanced at 9, it was
    // built without its BUY at -1, with a warning that 79.87 BTC and 281.17 USDT free funded no more orders of the market minimum, or,
    // once the rebalance had failed, a second STICKY BUY was sent, planned for a grid of one buy level
    describe('around the price a rebalance ended at, lower than the one the start checked', () => {
      const atNine =
        'GridBot: Grid configuration would result in non-positive buy prices: the lowest of buyLevels 2, spaced by spacingValue 5 (fixed) below the center price 9, would be at -1';
      const refusedAtNine = 'Not placed again: the grid is refused around 9, the price it ended at';
      // All in the asset, as a buy-only grid wants it in currency: a STICKY SELL of the 10 BTC
      const assetOnly: Portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: 10, used: 0, total: 10 }],
        ['USDT', { free: 0, used: 0, total: 0 }],
      ]);

      /**
       * Ends the rebalance, the first order sent, as the Trader reports it at `price`: filled there, without fee, from `portfolio`, or
       * failed with nothing traded
       */
      const endRebalanceAt = (outcome: 'completed' | 'errored' | 'canceled', price: number, portfolio: Portfolio = unbalancedPortfolio) => {
        const [{ id, side, amount }] = issuedOrders;
        const order = { id, reason: 'Test error' } as any;
        const bought = side === 'BUY' ? amount : -amount;
        const [btc, usdt] = [portfolio.get('BTC')!.free + bought, portfolio.get('USDT')!.free - bought * price];
        const filled: Portfolio = new Map<string, BalanceDetail>([
          ['BTC', { free: btc, used: 0, total: btc }],
          ['USDT', { free: usdt, used: 0, total: usdt }],
        ]);
        if (outcome === 'completed') strategy.onOrderCompleted({ order, exchange: { price, portfolio: filled }, tools });
        if (outcome === 'errored') strategy.onOrderErrored({ order, exchange: { price, portfolio }, tools });
        if (outcome === 'canceled') strategy.onOrderCanceled({ order, exchange: { price, portfolio }, tools });
      };
      /** The lines logged at warn and error level */
      const warningsAndErrors = () => log.mock.calls.filter(([level]) => level === 'warn' || level === 'error');

      // From 1000 USDT, a STICKY BUY of 79.87 BTC planned around 10.01
      it('stops the run once the rebalance fills at 9, as the start would around 9, naming the price the grid would be built around', () => {
        startStrategy(10.01, {}, unbalancedPortfolio);

        expect(() => endRebalanceAt('completed', 9)).toThrow(atNine);
      });

      // A failed attempt is warned of with what follows it: it read "Retrying..." before the stop, no rebalance being placed again
      it.each`
        outcome        | expected
        ${'completed'} | ${[['error', atNine]]}
        ${'errored'}   | ${[['warn', `GridBot: Rebalance attempt 1 failed: Test error. ${refusedAtNine}`], ['error', atNine]]}
        ${'canceled'}  | ${[['warn', `GridBot: Rebalance attempt 1 failed: Order was canceled. ${refusedAtNine}`], ['error', atNine]]}
      `('says why at error level once the rebalance is $outcome at 9, and warns of no level left out', ({ outcome, expected }) => {
        startStrategy(10.01, {}, unbalancedPortfolio);
        untilStopped(() => endRebalanceAt(outcome, 9));

        expect(warningsAndErrors()).toEqual(expected);
      });

      it.each`
        outcome
        ${'completed'}
        ${'errored'}
        ${'canceled'}
      `('sends no order once the rebalance is $outcome at 9: neither the grid nor a rebalance planned again', ({ outcome }) => {
        startStrategy(10.01, {}, unbalancedPortfolio);
        untilStopped(() => endRebalanceAt(outcome, 9));

        expect(issuedOrders.map(({ type, side, amount }) => `${type} ${side} ${amount}`)).toEqual(['STICKY BUY 79.87']);
      });

      // As the start refuses them: a BUY at 0 is no order the market takes, and a BUY is checked at the price its order is placed at,
      // on the tick. Spaced by 4.9 around 10.5, the lowest BUY is at 0.7, 0.5 on a tick of 0.5: around 10, at 0.2, rounded to 0.
      it.each`
        start    | params                   | tick    | outcome        | description                                            | expected
        ${10.01} | ${{}}                    | ${0.01} | ${'completed'} | ${'at 0 itself, the rebalance filled at 10'}           | ${'spaced by spacingValue 5 (fixed) below the center price 10, would be at 0'}
        ${10.5}  | ${{ spacingValue: 4.9 }} | ${0.5}  | ${'completed'} | ${'at 0 on a tick of 0.5, the rebalance filled at 10'} | ${'spaced by spacingValue 4.9 (fixed) below the center price 10, would be at 0'}
        ${10.5}  | ${{ spacingValue: 4.9 }} | ${0.5}  | ${'errored'}   | ${'at 0 on a tick of 0.5, the rebalance failed at 10'} | ${'spaced by spacingValue 4.9 (fixed) below the center price 10, would be at 0'}
      `('stops the run for a lowest BUY $description', ({ start, params, tick, outcome, expected }) => {
        tools.marketData = new Map([['BTC/USDT', { ...marketDataMock, precision: { price: tick, amount: 0.01 } }]]);
        startStrategy(start, params, unbalancedPortfolio);

        expect(() => endRebalanceAt(outcome, 10)).toThrow(
          `GridBot: Grid configuration would result in non-positive buy prices: the lowest of buyLevels 2, ${expected}`,
        );
      });

      // Its only BUY at -1 left the grid without a level: it stopped for an insufficient portfolio, 0 BTC and 90 USDT free
      it('says why a buy-only grid, its BTC sold at 9, is not built: its lowest BUY, not its portfolio', () => {
        startStrategy(10.01, { buyLevels: 1, sellLevels: 0, spacingValue: 10 }, assetOnly);

        expect(() => endRebalanceAt('completed', 9, assetOnly)).toThrow(
          'GridBot: Grid configuration would result in non-positive buy prices: the lowest of buyLevels 1, spaced by spacingValue 10 (fixed) below the center price 9, would be at -1',
        );
      });

      it.each`
        start    | price    | description                        | expected
        ${11}    | ${10.01} | ${'lower, its lowest BUY at 0.01'} | ${['BUY 0.01 x34.48', 'BUY 5.01 x34.48', 'SELL 15.01 x34.48', 'SELL 20.01 x34.48']}
        ${10.01} | ${10.5}  | ${'higher'}                        | ${['BUY 0.5 x26.89', 'BUY 5.5 x26.89', 'SELL 15.5 x26.89', 'SELL 20.5 x26.89']}
      `('builds the grid as before once the rebalance planned at $start fills $description, at $price', ({ start, price, expected }) => {
        startStrategy(start, {}, unbalancedPortfolio);
        endRebalanceAt('completed', price);

        expect(amountsSentAfter(1)).toEqual(expected);
      });

      it('places the rebalance again as before once it failed lower, every BUY above 0: at 10.01, planned at 11', () => {
        startStrategy(11, {}, unbalancedPortfolio);
        endRebalanceAt('errored', 10.01);

        expect(issuedOrders.map(({ type, side, amount }) => `${type} ${side} ${amount}`)).toEqual(['STICKY BUY 68.96', 'STICKY BUY 79.87']);
      });
    });
  });

  // A spacing under the price tick used to be accepted, the prices of the grid rounded onto each other: percent 0.001 at 100 put a
  // 3/3 grid at 100, where its levels bought and sold at zero spread, two fees a round trip for nothing. A spacing under the
  // round-trip fee was accepted without a word, and its round trips lost money.
  describe('spacing against the price tick and the round-trip fee', () => {
    const underTick = { buyLevels: 3, sellLevels: 3, spacingType: 'percent', spacingValue: 0.001 } as const;
    // On the 2/2 grid of 5 BTC and 500 USDT at 100: 99.98, 99.99, 100.01 and 100.02, 0.01 % a level
    const oneTick = { spacingType: 'fixed', spacingValue: 0.01 } as const;
    const feeWarnings = () => log.mock.calls.filter(([level, message]) => level === 'warn' && message.includes('round-trip fee'));

    it('stops the run when two adjacent prices of the grid round to the same tick, naming the parameter and the tick', () => {
      expect(() => startStrategy(100, underTick)).toThrow(
        'GridBot: Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.001 (percent) around the center price 100, two adjacent prices of the grid would both round to 100 at the price tick 0.01',
      );
    });

    it.each`
      portfolio              | description
      ${balancedPortfolio}   | ${'the grid of a balanced portfolio'}
      ${unbalancedPortfolio} | ${'the rebalance of an unbalanced one'}
    `('sends no order then, neither $description', ({ portfolio }) => {
      untilStopped(() => startStrategy(100, underTick, portfolio));

      expect(createOrder).not.toHaveBeenCalled();
    });

    // The grid is built around the price the rebalance ended at, which the start did not check: a percent step shrinks with the price,
    // and 0.0084 % keeps the prices of a 3/3 grid a tick apart at 100, not at 99, where two round to 98.98
    describe('once rebalanced at a price lower than the one the start checked', () => {
      const nearTheTick = { buyLevels: 3, sellLevels: 3, spacingType: 'percent', spacingValue: 0.0084 } as const;
      const rebalancedAt99 = () =>
        strategy.onOrderCompleted({
          order: { id: issuedOrders[0].id } as any,
          exchange: { price: 99, portfolio: balancedPortfolio },
          tools,
        });

      it('stops the run, naming the price the grid would be built around', () => {
        startStrategy(100, nearTheTick, unbalancedPortfolio);

        expect(rebalancedAt99).toThrow(
          'GridBot: Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.0084 (percent) around the center price 99, two adjacent prices of the grid would both round to 98.98 at the price tick 0.01',
        );
      });

      it('sends no order of the grid: the rebalance only', () => {
        startStrategy(100, nearTheTick, unbalancedPortfolio);
        untilStopped(rebalancedAt99);

        expect(issuedOrders.map(({ type, side }) => `${type} ${side}`)).toEqual(['STICKY BUY']);
      });

      // 0.25 BTC and 24.75 USDT fund 2 of the 3 levels a side, at amount.min 0.1: the prices of the 2/2 grid stay a tick apart at 99
      it('builds the levels the free balances fund, when only the farthest, left out, would round to one tick', () => {
        const fundingTwoASide: Portfolio = new Map<string, BalanceDetail>([
          ['BTC', { free: 0.25, used: 0, total: 0.25 }],
          ['USDT', { free: 24.75, used: 0, total: 24.75 }],
        ]);
        startStrategy(100, nearTheTick, unbalancedPortfolio);
        const exchange = { price: 99, portfolio: fundingTwoASide };
        strategy.onOrderCompleted({ order: { id: issuedOrders[0].id } as any, exchange, tools });

        expect(amountsSentAfter(1)).toEqual(['BUY 98.98 x0.12', 'BUY 98.99 x0.12', 'SELL 99.01 x0.12', 'SELL 99.02 x0.12']);
      });
    });

    // The rebalance planned again after a failure was not checked against the tick: its STICKY order was sent for a grid around the
    // price the failure ended at, which the build refused once that second rebalance had filled
    describe('once a rebalance failed around a price the start did not check', () => {
      const nearTheTick = { buyLevels: 3, sellLevels: 3, spacingType: 'percent', spacingValue: 0.0084 } as const;
      const at99 =
        'GridBot: Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.0084 (percent) around the center price 99, two adjacent prices of the grid would both round to 98.98 at the price tick 0.01';
      /** Fails the rebalance, the first order sent, as the Trader reports a refusal at `price`, nothing traded */
      const failRebalanceAt = (price: number) =>
        strategy.onOrderErrored({
          order: { id: issuedOrders[0].id, reason: 'Test error' } as any,
          exchange: { price, portfolio: unbalancedPortfolio },
          tools,
        });

      it('stops the run before placing it again, naming the price the grid would be built around', () => {
        startStrategy(100, nearTheTick, unbalancedPortfolio);

        expect(() => failRebalanceAt(99)).toThrow(at99);
      });

      it('sends no second rebalance: the first one only', () => {
        startStrategy(100, nearTheTick, unbalancedPortfolio);
        untilStopped(() => failRebalanceAt(99));

        expect(issuedOrders.map(({ type, side, amount }) => `${type} ${side} ${amount}`)).toEqual(['STICKY BUY 5']);
      });

      it('warns that the attempt failed and is not placed again, then says why at error level', () => {
        startStrategy(100, nearTheTick, unbalancedPortfolio);
        untilStopped(() => failRebalanceAt(99));

        expect(log.mock.calls.filter(([level]) => level === 'warn' || level === 'error')).toEqual([
          [
            'warn',
            'GridBot: Rebalance attempt 1 failed: Test error. Not placed again: the grid is refused around 99, the price it ended at',
          ],
          ['error', at99],
        ]);
      });

      // No rebalance is paid for then: the grid built on 0.25 BTC and 24.75 USDT, which need none, is checked on the levels they fund,
      // 2 of the 3 a side, as once a rebalance fills
      it('builds the levels the free balances it left fund, as before, when only the farthest, left out, would round to one tick', () => {
        const fundingTwoASide: Portfolio = new Map<string, BalanceDetail>([
          ['BTC', { free: 0.25, used: 0, total: 0.25 }],
          ['USDT', { free: 24.75, used: 0, total: 24.75 }],
        ]);
        startStrategy(100, nearTheTick, unbalancedPortfolio);
        strategy.onOrderErrored({
          order: { id: issuedOrders[0].id, reason: 'Test error' } as any,
          exchange: { price: 99, portfolio: fundingTwoASide },
          tools,
        });

        expect(amountsSentAfter(1)).toEqual(['BUY 98.98 x0.12', 'BUY 98.99 x0.12', 'SELL 99.01 x0.12', 'SELL 99.02 x0.12']);
      });

      // At 101, the prices of the grid stay a tick apart: 100.97 … 101.03
      it('places the rebalance again as before once it failed where the prices of the grid stay a tick apart, at 101', () => {
        startStrategy(100, nearTheTick, unbalancedPortfolio);
        failRebalanceAt(101);

        expect(issuedOrders.map(({ type, side, amount }) => `${type} ${side} ${amount}`)).toEqual(['STICKY BUY 5', 'STICKY BUY 4.95']);
      });
    });

    describe('on a market with a maker fee of 0.0004, 0.08003 % a round trip', () => {
      // The split of the grid a tick apart, whose BUYs at 99.99 and 99.98 cost about what its SELLs are worth
      const balancedOneTick: Portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: 5, used: 0, total: 5 }],
        ['USDT', { free: 500, used: 0, total: 500 }],
      ]);

      beforeEach(() => {
        tools.marketData = new Map([['BTC/USDT', { ...marketDataMock, fee: { maker: 0.0004 } }]]);
      });

      it('warns that a spacing of one tick is under the round-trip fee, naming the parameter and the fee', () => {
        startStrategy(100, oneTick, balancedOneTick);

        expect(log).toHaveBeenCalledWith(
          'warn',
          'GridBot: spacingValue 0.01 (fixed) is under the round-trip fee: a level that sells less than 0.08003 % above its buy, paying the maker fee of 0.0004 (fee.maker) on its BUY and on its SELL, loses money at each round trip, 4 out of 4 here, the narrowest selling at 100.02, 0.009999 % above its buy at 100.01',
        );
      });

      it('warns once: not again on the candles and the fills that follow', () => {
        startStrategy(100, oneTick, balancedOneTick);
        afterWarmup(100);
        strategy.onEachTimeframeCandle({ candle: makeCandle(100), portfolio: balancedPortfolio, tools });
        settle('completed', 99.99, 'BUY');

        expect(feeWarnings()).toHaveLength(1);
      });

      it('places the grid all the same: a bad grid, not an impossible one', () => {
        startStrategy(100, oneTick, balancedOneTick);

        expect(amountsSentAfter(0)).toEqual(['BUY 99.98 x2.49', 'BUY 99.99 x2.49', 'SELL 100.01 x2.49', 'SELL 100.02 x2.49']);
      });

      it.each`
        params                                            | description
        ${{}}                                             | ${'fixed 5, 5 % a level'}
        ${{ spacingType: 'percent', spacingValue: 0.09 }} | ${'percent 0.09, 0.08992 % for the narrowest level'}
      `('warns of nothing for a spacing over the round-trip fee: $description', ({ params }) => {
        startStrategy(100, params);

        expect(feeWarnings()).toEqual([]);
      });
    });

    it('warns of nothing on a market that states no fee, even for a spacing of one tick', () => {
      startStrategy(100, oneTick);

      expect(feeWarnings()).toEqual([]);
    });
  });

  describe('order completion', () => {
    // These two used to check only that no order had disappeared, which held whatever the fill did: it armed nothing, BUY 95 and
    // SELL 105 being each other's neighbour across the center price
    it.each`
      side      | price  | expected
      ${'BUY'}  | ${95}  | ${['LIMIT SELL 100']}
      ${'SELL'} | ${105} | ${['LIMIT BUY 100']}
    `('arms the opposite side one step away, at the center price, after a $side fill at $price', ({ side, price, expected }) => {
      startStrategy(100);
      const sentBefore = issuedOrders.length;
      settle('completed', price, side);

      expect(sentAfter(sentBefore)).toEqual(expected);
    });

    it('logs warning when only one side remains', () => {
      startStrategy(100, { buyLevels: 1, sellLevels: 1 });

      const buyId = findOrderId(95, 'BUY');
      strategy.onOrderCompleted({
        order: { id: buyId as UUID, side: 'BUY' } as any,
        exchange: { price: 95, portfolio: balancedPortfolio },
        tools,
      });

      expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('one side'));
    });

    it('ignores unknown order IDs', () => {
      startStrategy(100);

      const initialCalls = createOrder.mock.calls.length;
      strategy.onOrderCompleted({
        order: { id: 'unknown-id' as UUID, side: 'BUY' } as any,
        exchange: { price: 100, portfolio: balancedPortfolio },
        tools,
      });

      expect(createOrder).toHaveBeenCalledTimes(initialCalls);
    });
  });

  // A fill armed the neighbouring level, and only if it held no order: a neighbour whose own fill was not reported yet was skipped.
  // A drop through several BUYs re-armed when a backtest reported the fills highest first, not when paper or live trading polled
  // them lowest first, so a backtest kept a grid that paper and live trading lost
  describe('levels filled together', () => {
    const afterDrop = ['SELL 90', 'SELL 95', 'SELL 100', 'SELL 105', 'SELL 110', 'SELL 115'];
    const afterRally = ['BUY 85', 'BUY 90', 'BUY 95', 'BUY 100', 'BUY 105', 'BUY 110'];

    it.each`
      side      | prices             | book
      ${'BUY'}  | ${[95, 90, 85]}    | ${afterDrop}
      ${'BUY'}  | ${[95, 85, 90]}    | ${afterDrop}
      ${'BUY'}  | ${[90, 95, 85]}    | ${afterDrop}
      ${'BUY'}  | ${[90, 85, 95]}    | ${afterDrop}
      ${'BUY'}  | ${[85, 95, 90]}    | ${afterDrop}
      ${'BUY'}  | ${[85, 90, 95]}    | ${afterDrop}
      ${'SELL'} | ${[105, 110, 115]} | ${afterRally}
      ${'SELL'} | ${[105, 115, 110]} | ${afterRally}
      ${'SELL'} | ${[110, 105, 115]} | ${afterRally}
      ${'SELL'} | ${[110, 115, 105]} | ${afterRally}
      ${'SELL'} | ${[115, 105, 110]} | ${afterRally}
      ${'SELL'} | ${[115, 110, 105]} | ${afterRally}
    `('re-arms the fills of $side $prices, reported in that order, into the same book', ({ side, prices, book }) => {
      startStrategy(100, { buyLevels: 3, sellLevels: 3 });
      prices.forEach((price: number) => settle('completed', price, side));

      expect(openBook()).toEqual(book);
    });

    it.each`
      prices
      ${[90, 95, 100]}
      ${[100, 95, 90]}
    `('places the initial grid again once the price comes back through SELL $prices, reported in that order', ({ prices }) => {
      startStrategy(100, { buyLevels: 3, sellLevels: 3 });
      [85, 90, 95].forEach(price => settle('completed', price, 'BUY'));
      prices.forEach((price: number) => settle('completed', price, 'SELL'));

      expect(openBook()).toEqual(['BUY 85', 'BUY 90', 'BUY 95', 'SELL 105', 'SELL 110', 'SELL 115']);
    });
  });

  // The two levels next to the center price were each other's neighbours, two steps apart, and each held its order, so the first
  // fill on either side armed nothing: a price swinging between the center and one step away traded once, then never again
  describe('around the center price', () => {
    const assetOnlyPortfolio: Portfolio = new Map<string, BalanceDetail>([
      ['BTC', { free: 10, used: 0, total: 10 }],
      ['USDT', { free: 0, used: 0, total: 0 }],
    ]);

    // A one-sided grid wants the whole portfolio on its side: no rebalance
    it.each`
      grid           | buyLevels | sellLevels | portfolio              | side      | price  | expected
      ${'buy-only'}  | ${3}      | ${0}       | ${unbalancedPortfolio} | ${'BUY'}  | ${95}  | ${['LIMIT SELL 100']}
      ${'sell-only'} | ${0}      | ${3}       | ${assetOnlyPortfolio}  | ${'SELL'} | ${105} | ${['LIMIT BUY 100']}
    `(
      'arms the center price after the first fill of a $grid grid, $side $price',
      ({ buyLevels, sellLevels, portfolio, side, price, expected }) => {
        startStrategy(100, { buyLevels, sellLevels }, portfolio);
        const sentBefore = issuedOrders.length;
        settle('completed', price, side);

        expect(sentAfter(sentBefore)).toEqual(expected);
      },
    );

    it('trades every swing between the center price and one step below it', () => {
      startStrategy(100);
      const sentBefore = issuedOrders.length;
      settle('completed', 95, 'BUY');
      settle('completed', 100, 'SELL');
      settle('completed', 95, 'BUY');
      settle('completed', 100, 'SELL');

      expect(sentAfter(sentBefore)).toEqual(['LIMIT SELL 100', 'LIMIT BUY 95', 'LIMIT SELL 100', 'LIMIT BUY 95']);
    });

    // One candle, or one poll interval, through both levels: each takes the center price on its other side, and the one the market
    // has passed fills next
    it.each`
      first         | fills
      ${'BUY 95'}   | ${[[95, 'BUY'], [105, 'SELL']]}
      ${'SELL 105'} | ${[[105, 'SELL'], [95, 'BUY']]}
    `('arms the center price on both sides once BUY 95 and SELL 105 fill together, $first reported first', ({ fills }) => {
      startStrategy(100);
      fills.forEach(([price, side]: [number, OrderSide]) => settle('completed', price, side));

      expect(openBook()).toEqual(['BUY 90', 'BUY 100', 'SELL 100', 'SELL 110']);
    });

    it('places the initial grid again once both orders at the center price fill', () => {
      startStrategy(100);
      settle('completed', 95, 'BUY');
      settle('completed', 105, 'SELL');
      settle('completed', 100, 'SELL');
      settle('completed', 100, 'BUY');

      expect(openBook()).toEqual(['BUY 90', 'BUY 95', 'SELL 105', 'SELL 110']);
    });
  });

  describe('order errors', () => {
    it('retries order on error', () => {
      startStrategy(100);

      const buyId = findOrderId(95, 'BUY');
      strategy.onOrderErrored({
        order: { id: buyId as UUID, reason: 'Test error' } as any,
        exchange: { price: 100, portfolio: balancedPortfolio },
        tools,
      });

      expect(createOrder).toHaveBeenCalledTimes(5);
    });
  });

  // A level whose order failed at every attempt gave up through tools.log('error'), which throws: the first one stopped the bot, with
  // a message naming an array index rather than the order
  describe('a grid order that failed at every attempt', () => {
    /** Ends the live order at that price and side in error `times` times in a row, as the Trader reports it */
    const fail = (times: number, price: number, side: OrderSide) => {
      for (let i = 0; i < times; i++) settle('errored', price, side);
    };

    it.each`
      side      | price  | retryOnError | attempts
      ${'BUY'}  | ${95}  | ${1}         | ${2}
      ${'BUY'}  | ${95}  | ${3}         | ${4}
      ${'SELL'} | ${105} | ${3}         | ${4}
    `(
      'warns that the $side at $price failed after $attempts attempts, with retryOnError $retryOnError',
      ({ side, price, retryOnError, attempts }) => {
        startStrategy(100, { retryOnError });
        fail(attempts, price, side);

        expect(log).toHaveBeenCalledWith(
          'warn',
          `GridBot: ${side} at ${price} failed after ${attempts} attempts (retryOnError: ${retryOnError}): its level is left without an order, the rest of the grid trades on. Last error: Test error`,
        );
      },
    );

    it('does not stop the run while other levels hold an order', () => {
      startStrategy(100, { retryOnError: 3 });

      expect(() => fail(4, 95, 'BUY')).not.toThrow();
    });

    it('is placed again after every attempt but the last', () => {
      startStrategy(100, { retryOnError: 3 });
      const sentBefore = issuedOrders.length;
      fail(4, 95, 'BUY');

      expect(sentAfter(sentBefore)).toEqual(['LIMIT BUY 95', 'LIMIT BUY 95', 'LIMIT BUY 95']);
    });

    it('leaves its level without an order, the rest of the book in place', () => {
      startStrategy(100, { retryOnError: 3 });
      fail(4, 95, 'BUY');

      expect(openBook()).toEqual(['BUY 90', 'SELL 105', 'SELL 110']);
    });

    it('lets the rest of the grid trade on: the fill of the BUY below arms its SELL', () => {
      startStrategy(100, { retryOnError: 3 });
      fail(4, 95, 'BUY');
      const sentBefore = issuedOrders.length;
      settle('completed', 90, 'BUY');

      expect(sentAfter(sentBefore)).toEqual(['LIMIT SELL 95']);
    });

    // A grid without any order would sit idle for the rest of the run
    it.each`
      grid     | buyLevels | sellLevels | portfolio              | failing                         | last
      ${'1/0'} | ${1}      | ${0}       | ${unbalancedPortfolio} | ${[[95, 'BUY']]}                | ${'BUY at 95'}
      ${'1/1'} | ${1}      | ${1}       | ${balancedPortfolio}   | ${[[95, 'BUY'], [105, 'SELL']]} | ${'SELL at 105'}
    `('stops the run once no level of a $grid grid holds an order any more', ({ buyLevels, sellLevels, portfolio, failing, last }) => {
      startStrategy(100, { buyLevels, sellLevels, retryOnError: 1 }, portfolio);

      expect(() => failing.forEach(([price, side]: [number, OrderSide]) => fail(2, price, side))).toThrow(
        `GridBot: ${last} failed after 2 attempts (retryOnError: 1): no level of the grid holds an order any more. Last error: Test error`,
      );
    });
  });

  describe('order cancellation', () => {
    it('replaces canceled grid order', () => {
      startStrategy(100);

      const buyId = findOrderId(95, 'BUY');
      strategy.onOrderCanceled({
        order: { id: buyId as UUID } as any,
        exchange: { price: 100, portfolio: balancedPortfolio },
        tools,
      });

      expect(createOrder).toHaveBeenCalledTimes(5);
    });
  });

  // A canceled order was placed again for the whole quantity, its attempts counted from 0 again: what had filled before the cancel
  // was traded a second time, and an exchange that kept canceling it (self-trade prevention, a cancel by hand) brought it back
  // without end
  describe('a grid order canceled', () => {
    // 2.5 per level: the 2/2 grid at 100 on 5 BTC and 462.5 USDT. 2.5 - 2.2 is 0.2999999999999998 in binary
    it.each`
      side      | price  | cancels                                                             | description                                      | expected
      ${'BUY'}  | ${95}  | ${[{ filled: 0, remaining: 2.5 }]}                                  | ${'nothing filled'}                              | ${['BUY 95 x2.5']}
      ${'BUY'}  | ${95}  | ${[{ filled: 1, remaining: 1.5 }]}                                  | ${'1 filled'}                                    | ${['BUY 95 x1.5']}
      ${'BUY'}  | ${95}  | ${[{ filled: 1, remaining: 0 }]}                                    | ${'1 filled, its remaining amount not reported'} | ${['BUY 95 x1.5']}
      ${'SELL'} | ${105} | ${[{ filled: 0.5, remaining: 2 }]}                                  | ${'0.5 filled'}                                  | ${['SELL 105 x2']}
      ${'BUY'}  | ${95}  | ${[{ filled: 2.2, remaining: 0.3 }]}                                | ${'2.2 filled'}                                  | ${['BUY 95 x0.3']}
      ${'BUY'}  | ${95}  | ${[{ filled: 0.3, remaining: 2.2 }, { filled: 0.2, remaining: 2 }]} | ${'0.3 filled, then 0.2 of the rest'}            | ${['BUY 95 x2.2', 'BUY 95 x2']}
    `('places again what is left of $side $price, $description: $expected', ({ side, price, cancels, expected }) => {
      startStrategy(100);
      const sentBefore = issuedOrders.length;
      cancels.forEach((cancel: { filled: number; remaining: number }) => settle('canceled', price, side, cancel));

      expect(amountsSentAfter(sentBefore)).toEqual(expected);
    });

    // The order leaves its fill out when no answer of the exchange reported one (see OrderCanceledEvent): placed again whole, the part
    // that may have filled traded again. It used to hand on such a fill as 0, and 0 filled with 0 remaining stood for it
    const noFill = { filled: undefined, remaining: undefined };
    it.each`
      details                                  | description
      ${noFill}                                | ${'no fill reported'}
      ${{ filled: undefined, remaining: 1.5 }} | ${'a remaining amount without its fill'}
    `('places again whole an order canceled with $description', ({ details }) => {
      startStrategy(100);
      const sentBefore = issuedOrders.length;
      settle('canceled', 95, 'BUY', details);

      expect(amountsSentAfter(sentBefore)).toEqual(['BUY 95 x2.5']);
    });

    it('warns that an order canceled with no fill reported is placed again whole', () => {
      startStrategy(100);
      settle('canceled', 95, 'BUY', noFill);

      expect(log).toHaveBeenCalledWith(
        'warn',
        'GridBot: BUY at 95 was canceled with no fill reported: it is placed again whole, 2.5, which trades again any part of it that had filled',
      );
    });

    // A fill reported as 0 is a fact: nothing filled, nothing traded twice
    it('does not warn of an order canceled with 0 filled reported', () => {
      startStrategy(100);
      settle('canceled', 95, 'BUY', { filled: 0, remaining: 0 });

      expect(log).not.toHaveBeenCalledWith('warn', expect.stringContaining('no fill reported'));
    });

    it('names the cancel with no fill reported as the last error once the level gives up', () => {
      startStrategy(100, { retryOnError: 1 });
      settle('canceled', 95, 'BUY', noFill);
      settle('canceled', 95, 'BUY', noFill);

      expect(log).toHaveBeenCalledWith(
        'warn',
        'GridBot: BUY at 95 failed after 2 attempts (retryOnError: 1): its level is left without an order, the rest of the grid trades on. Last error: Order was canceled (no fill reported)',
      );
    });

    it('turns its level to the other side once the cancel reports it filled in full, as a fill does', () => {
      startStrategy(100);
      const sentBefore = issuedOrders.length;
      settle('canceled', 95, 'BUY', { filled: 2.5, remaining: 0 });

      expect(amountsSentAfter(sentBefore)).toEqual(['SELL 100 x2.5']);
    });

    // What was left under the market's minimum order, amount.min 0.1 here, used to be placed again, refused at every attempt, until
    // the level gave up holding the part filled
    it.each`
      side      | price  | filled  | description                                         | expected
      ${'BUY'}  | ${95}  | ${2.45} | ${'0.05 left, under amount.min: turned, as filled'} | ${['SELL 100 x2.5']}
      ${'SELL'} | ${105} | ${2.45} | ${'0.05 left, under amount.min: turned, as filled'} | ${['BUY 100 x2.5']}
      ${'BUY'}  | ${95}  | ${2.4}  | ${'0.1 left, amount.min itself: placed again'}      | ${['BUY 95 x0.1']}
    `('places $expected once $side $price is canceled with $description', ({ side, price, filled, expected }) => {
      startStrategy(100);
      const sentBefore = issuedOrders.length;
      settle('canceled', price, side, { filled, remaining: 2.5 - filled });

      expect(amountsSentAfter(sentBefore)).toEqual(expected);
    });

    it('logs, at info, a level turned with less left than the market takes in an order', () => {
      startStrategy(100);
      settle('canceled', 95, 'BUY', { filled: 2.45, remaining: 0.05 });

      expect(log).toHaveBeenCalledWith(
        'info',
        'GridBot: BUY at 95 was canceled with 0.05 left, under the market minimum of 0.1: its level turns to its other side, as after a fill',
      );
    });

    describe('again and again', () => {
      /** Cancels the live order at that price and side `times` times in a row, nothing filled */
      const cancel = (times: number, price: number, side: OrderSide) => {
        for (let i = 0; i < times; i++) settle('canceled', price, side);
      };

      it.each`
        side      | price  | retryOnError | attempts
        ${'BUY'}  | ${95}  | ${1}         | ${2}
        ${'BUY'}  | ${95}  | ${3}         | ${4}
        ${'SELL'} | ${105} | ${3}         | ${4}
      `(
        'warns that the $side at $price failed after $attempts cancels, with retryOnError $retryOnError',
        ({ side, price, retryOnError, attempts }) => {
          startStrategy(100, { retryOnError });
          cancel(attempts, price, side);

          expect(log).toHaveBeenCalledWith(
            'warn',
            `GridBot: ${side} at ${price} failed after ${attempts} attempts (retryOnError: ${retryOnError}): its level is left without an order, the rest of the grid trades on. Last error: Order was canceled (filled: 0, remaining: 2.5)`,
          );
        },
      );

      it('is placed again after every cancel but the last', () => {
        startStrategy(100, { retryOnError: 3 });
        const sentBefore = issuedOrders.length;
        cancel(4, 95, 'BUY');

        expect(sentAfter(sentBefore)).toEqual(['LIMIT BUY 95', 'LIMIT BUY 95', 'LIMIT BUY 95']);
      });

      it('counts the cancels and the refusals of an order together', () => {
        startStrategy(100, { retryOnError: 3 });
        ['canceled', 'errored', 'canceled', 'errored'].forEach(outcome => settle(outcome as 'canceled' | 'errored', 95, 'BUY'));

        expect(log).toHaveBeenCalledWith(
          'warn',
          'GridBot: BUY at 95 failed after 4 attempts (retryOnError: 3): its level is left without an order, the rest of the grid trades on. Last error: Test error',
        );
      });

      it('counts the attempts from 0 again once the level fills', () => {
        startStrategy(100, { retryOnError: 3 });
        cancel(3, 95, 'BUY');
        settle('completed', 95, 'BUY');
        cancel(3, 100, 'SELL');

        expect(log).not.toHaveBeenCalledWith('warn', expect.stringContaining('failed after'));
      });

      // One candle, or one poll interval, through BUY 95 and SELL 105 arms a SELL and a BUY at the center price. Should the market
      // sit there, an exchange preventing self-trades (Binance expires the maker by default) cancels each in turn as the other is
      // placed again: the cancels count, and both levels give up
      it('stops placing again a SELL and a BUY at the center price that the exchange cancels in turn', () => {
        startStrategy(100, { retryOnError: 3 });
        settle('completed', 95, 'BUY');
        settle('completed', 105, 'SELL');
        const sentBefore = issuedOrders.length;
        for (let i = 0; i < 4; i++) {
          settle('canceled', 100, 'SELL');
          settle('canceled', 100, 'BUY');
        }

        expect(sentAfter(sentBefore)).toEqual(Array.from({ length: 3 }, () => ['LIMIT SELL 100', 'LIMIT BUY 100']).flat());
      });
    });
  });

  // Every error placed the order again, an "Outcome unknown" one too: the order lost on the network may be live on the exchange,
  // where nothing tracks it any more, so it was doubled, two lots bought or sold where the level holds one, or the copy was refused
  // for want of the reserve the first one holds
  describe('a grid order whose outcome is unknown', () => {
    // As the Trader relays it: whether the order may be live is the order's to say, whatever the words of its reason. A poll that
    // failed for good, worded by the exchange itself, used to be taken for a refusal, and the order placed again beside the one live
    const pollFailed = '[EXCHANGE] binance {"code":-2013,"msg":"Order does not exist."}';
    // A creation lost on the network, which the order says may be live
    const lost = { reason: lostOnTheNetwork, mayBeLive: true };
    it.each`
      details                                          | description
      ${{ reason: pollFailed, mayBeLive: true }}       | ${'its poll failed for good, the order said maybe live'}
      ${{ reason: lostOnTheNetwork, mayBeLive: true }} | ${'a creation lost on the network, the order said maybe live'}
    `('is not placed again after $description', ({ details }) => {
      startStrategy(100);
      const sentBefore = issuedOrders.length;
      settle('errored', 95, 'BUY', details);

      expect(sentAfter(sentBefore)).toEqual([]);
    });

    it('warns that an order whose poll failed for good may be live on the exchange, untracked', () => {
      startStrategy(100);
      settle('errored', 95, 'BUY', { reason: pollFailed, mayBeLive: true });

      expect(log).toHaveBeenCalledWith(
        'warn',
        `GridBot: BUY 2.5 at 95 may be live on the exchange without GridBot tracking it: it is not placed again, its level is left without an order, the rest of the grid trades on. Check it there. Last error: ${pollFailed}`,
      );
    });

    // The order said it is not live: its reason does not decide
    it('is placed again once the order says it is not live, whatever its reason', () => {
      startStrategy(100);
      const sentBefore = issuedOrders.length;
      settle('errored', 95, 'BUY', { reason: lostOnTheNetwork, mayBeLive: false });

      expect(sentAfter(sentBefore)).toEqual(['LIMIT BUY 95']);
    });

    it('warns that it may be live on the exchange, untracked, its level left without an order', () => {
      startStrategy(100);
      settle('errored', 95, 'BUY', lost);

      expect(log).toHaveBeenCalledWith(
        'warn',
        `GridBot: BUY 2.5 at 95 may be live on the exchange without GridBot tracking it: it is not placed again, its level is left without an order, the rest of the grid trades on. Check it there. Last error: ${lostOnTheNetwork}`,
      );
    });

    it('leaves its level without an order, the rest of the book in place', () => {
      startStrategy(100);
      settle('errored', 95, 'BUY', lost);

      expect(openBook()).toEqual(['BUY 90', 'SELL 105', 'SELL 110']);
    });

    it('lets the rest of the grid trade on: the fill of the BUY below arms its SELL', () => {
      startStrategy(100);
      settle('errored', 95, 'BUY', lost);
      const sentBefore = issuedOrders.length;
      settle('completed', 90, 'BUY');

      expect(sentAfter(sentBefore)).toEqual(['LIMIT SELL 95']);
    });

    // 1.66 per level: the 3/3 grid at 100 on 5 BTC and 462.5 USDT
    it('does not stop the run while retryOnError orders or fewer may be live untracked', () => {
      startStrategy(100, { buyLevels: 3, sellLevels: 3, retryOnError: 3 });

      expect(() => [95, 90, 85].forEach(price => settle('errored', price, 'BUY', lost))).not.toThrow();
    });

    it('stops the run once more orders than retryOnError may be live untracked, naming them', () => {
      startStrategy(100, { buyLevels: 3, sellLevels: 3, retryOnError: 3 });
      const loseFour = () => {
        [95, 90, 85].forEach(price => settle('errored', price, 'BUY', lost));
        settle('errored', 105, 'SELL', lost);
      };

      expect(loseFour).toThrow(
        `GridBot: BUY 1.66 at 95, BUY 1.66 at 90, BUY 1.66 at 85, SELL 1.66 at 105 may be live on the exchange without GridBot tracking them: 4 orders, more than retryOnError (3). Check them on the exchange. Last error: ${lostOnTheNetwork}`,
      );
    });

    // All in currency, as a buy-only grid wants it: no rebalance, 10.52 on the one level
    it('stops the run once no level of the grid holds an order any more', () => {
      startStrategy(100, { buyLevels: 1, sellLevels: 0 }, unbalancedPortfolio);

      expect(() => settle('errored', 95, 'BUY', lost)).toThrow(
        `GridBot: BUY 10.52 at 95 may be live on the exchange without GridBot tracking it, and no level of the grid holds an order any more. Check it on the exchange. Last error: ${lostOnTheNetwork}`,
      );
    });
  });

  describe('a grid order refused', () => {
    it.each`
      reason                                                                                                | source
      ${'[EXCHANGE] Insufficient currency balance (portfolio: 60, order cost: 190)'}                        | ${'the simulated exchange'}
      ${'[EXCHANGE] binance {"code":-2010,"msg":"Account has insufficient balance for requested action."}'} | ${'a real exchange'}
      ${new OrderOutOfRangeError('exchange', 'amount', 0.001, 0.01).message}                                | ${'the limits of the market'}
      ${'no price known for BTC/USDT'}                                                                      | ${'the Trader'}
    `('is placed again after a refusal from $source', ({ reason }) => {
      startStrategy(100);
      const sentBefore = issuedOrders.length;
      settle('errored', 95, 'BUY', { reason });

      expect(sentAfter(sentBefore)).toEqual(['LIMIT BUY 95']);
    });

    it('is placed again for the amount refused: what a cancel after a partial fill left of it', () => {
      startStrategy(100);
      const sentBefore = issuedOrders.length;
      settle('canceled', 95, 'BUY', { filled: 1, remaining: 1.5 });
      settle('errored', 95, 'BUY');

      expect(amountsSentAfter(sentBefore)).toEqual(['BUY 95 x1.5', 'BUY 95 x1.5']);
    });
  });

  // A fill arms a level on the opposite side, but the level kept the side the grid was built with: a canceled or errored order
  // came back on that side, the SELL armed below the center as a BUY above the market, the BUY armed above it as a SELL below the
  // market. The one-side warning read the same stale sides
  describe('a level armed on the opposite side by a fill', () => {
    // BUY 95 and BUY 90 fill and turn their levels to SELL 100 and SELL 95; the mirror above the center: SELL 105 and SELL 110 fill
    // and turn theirs to BUY 100 and BUY 105
    const sellArmedAt95 = [
      [95, 'BUY'],
      [90, 'BUY'],
    ];
    const buyArmedAt105 = [
      [105, 'SELL'],
      [110, 'SELL'],
    ];

    it.each`
      fills            | side      | price  | outcomes                   | then                        | expected
      ${sellArmedAt95} | ${'SELL'} | ${95}  | ${['canceled']}            | ${'canceled'}               | ${['LIMIT SELL 95']}
      ${buyArmedAt105} | ${'BUY'}  | ${105} | ${['canceled']}            | ${'canceled'}               | ${['LIMIT BUY 105']}
      ${sellArmedAt95} | ${'SELL'} | ${95}  | ${['errored']}             | ${'errored'}                | ${['LIMIT SELL 95']}
      ${buyArmedAt105} | ${'BUY'}  | ${105} | ${['errored']}             | ${'errored'}                | ${['LIMIT BUY 105']}
      ${sellArmedAt95} | ${'SELL'} | ${95}  | ${['canceled', 'errored']} | ${'canceled, then errored'} | ${['LIMIT SELL 95', 'LIMIT SELL 95']}
    `('places the order a fill armed, $side $price, again on its side once $then', ({ fills, side, price, outcomes, expected }) => {
      startStrategy(100);
      fills.forEach(([fillPrice, fillSide]: [number, OrderSide]) => settle('completed', fillPrice, fillSide));
      const sentBefore = issuedOrders.length;
      outcomes.forEach((outcome: 'canceled' | 'errored') => settle(outcome, price, side));

      expect(issuedOrders.slice(sentBefore).map(order => `${order.type} ${order.side} ${order.price}`)).toEqual(expected);
    });

    it.each`
      fills            | book
      ${sellArmedAt95} | ${'SELL 95, 100, 105 and 110'}
      ${buyArmedAt105} | ${'BUY 90, 95, 100 and 105'}
    `('warns that only one side remains once the fills leave $book', ({ fills }) => {
      startStrategy(100);
      fills.forEach(([price, side]: [number, OrderSide]) => settle('completed', price, side));

      expect(log).toHaveBeenCalledWith('warn', 'GridBot: Only one side of the grid remains active');
    });

    it('does not warn once the fills of a buy-only grid leave BUY 85 and SELL 95 and 100', () => {
      // All in currency, as a buy-only grid wants it: no rebalance
      startStrategy(100, { buyLevels: 3, sellLevels: 0 }, unbalancedPortfolio);
      settle('completed', 95, 'BUY');
      settle('completed', 90, 'BUY');

      expect(log).not.toHaveBeenCalledWith('warn', 'GridBot: Only one side of the grid remains active');
    });
  });

  // The warning was logged on every timeframe candle out of the range, each one relayed to Telegram: 1440 a day at 1m while the price
  // stayed out of a grid that GridBot does not move, and nothing said when it came back
  describe('out of range', () => {
    /** Timeframe candles closing at these prices, one after the other */
    const closeAt = (closes: number[]) =>
      closes.forEach(close => strategy.onEachTimeframeCandle({ candle: makeCandle(close), portfolio: balancedPortfolio, tools }));
    /** The lines logged about the range, as `level message` */
    const rangeLogs = () =>
      log.mock.calls.filter(([, message]) => message.includes('grid range')).map(([level, message]) => `${level} ${message}`);
    /** The warning for a close out of the grid [min, max], whose orders wait for the price at `reentry` */
    const out = (close: number, [min, max]: number[], reentry: number) =>
      `warn GridBot: Price ${close} is out of grid range [${min}, ${max}]: the grid stays in place, its orders waiting for the price to come back to ${reentry}`;
    const back = (close: number, [min, max]: number[]) => `info GridBot: Price ${close} is back in grid range [${min}, ${max}]`;
    // The 2/2 grid at 100: 90, 95, 100, 105 and 110. Once its SELLs have filled above 110, the highest of the BUYs they armed is at
    // 105; once its BUYs have filled below 90, the lowest of the SELLs they armed is at 95
    const above = (close: number) => out(close, [90, 110], 105);
    const below = (close: number) => out(close, [90, 110], 95);
    const backIn = (close: number) => back(close, [90, 110]);
    // All in the asset, as a sell-only grid wants it: no rebalance
    const assetOnly: Portfolio = new Map<string, BalanceDetail>([
      ['BTC', { free: 10, used: 0, total: 10 }],
      ['USDT', { free: 0, used: 0, total: 0 }],
    ]);

    it.each`
      closes                      | description                              | logged                             | expected
      ${[130, 135, 140]}          | ${'three candles closing above it'}      | ${'one warning'}                   | ${[above(130)]}
      ${[80, 75, 70]}             | ${'three candles closing below it'}      | ${'one warning'}                   | ${[below(80)]}
      ${[130, 135, 140, 100]}     | ${'three above it, then one back in it'} | ${'one warning, then one info'}    | ${[above(130), backIn(100)]}
      ${[111, 109, 111, 109]}     | ${'closes on either side of its top'}    | ${'one warning'}                   | ${[above(111)]}
      ${[111, 109, 106, 105]}     | ${'above it, then down to 105'}          | ${'one warning, then one info'}    | ${[above(111), backIn(105)]}
      ${[89, 91, 94, 95]}         | ${'below it, then up to 95'}             | ${'one warning, then one info'}    | ${[below(89), backIn(95)]}
      ${[130, 100, 105, 110, 90]} | ${'one above it, four in it, on bounds'} | ${'one warning, then one info'}    | ${[above(130), backIn(100)]}
      ${[130, 100, 80, 75]}       | ${'above it, back in it, then below it'} | ${'a warning each time it leaves'} | ${[above(130), backIn(100), below(80)]}
      ${[80, 130, 135]}           | ${'below it, then above it at once'}     | ${'a warning on each side'}        | ${[below(80), above(130)]}
      ${[100, 90, 110]}           | ${'in it, its bounds included'}          | ${'nothing'}                       | ${[]}
    `('logs $logged for $description', ({ closes, expected }) => {
      startStrategy(100);
      closeAt(closes);

      expect(rangeLogs()).toEqual(expected);
    });

    // A one-sided grid has the center price for a bound: beyond it, the price finds the grid's orders one price inside it, as it does
    // beyond the farthest level
    it.each`
      grid           | buyLevels | sellLevels | portfolio              | closes                 | expected
      ${'buy-only'}  | ${3}      | ${0}       | ${unbalancedPortfolio} | ${[101, 99, 96, 95]}   | ${[out(101, [85, 100], 95), back(95, [85, 100])]}
      ${'sell-only'} | ${0}      | ${3}       | ${assetOnly}           | ${[99, 101, 104, 105]} | ${[out(99, [100, 115], 105), back(105, [100, 115])]}
      ${'1/0'}       | ${1}      | ${0}       | ${unbalancedPortfolio} | ${[94, 97, 100]}       | ${[out(94, [95, 100], 100), back(100, [95, 100])]}
    `('logs the price a $grid grid trades again at, and the price back there', ({ buyLevels, sellLevels, portfolio, closes, expected }) => {
      startStrategy(100, { buyLevels, sellLevels }, portfolio);
      closeAt(closes);

      expect(rangeLogs()).toEqual(expected);
    });
  });

  // The warning was logged after every fill that left one side, so after every fill of a grid holding a single order
  describe('one side of the grid', () => {
    const oneSideWarnings = () => log.mock.calls.filter(([, message]) => message === 'GridBot: Only one side of the grid remains active');
    // 0 BTC and 10 USDT fund one BUY 95 of 0.1, amount.min, the rebalance of 0.05 BTC being under it
    const tenUsdt: Portfolio = new Map<string, BalanceDetail>([
      ['BTC', { free: 0, used: 0, total: 0 }],
      ['USDT', { free: 10, used: 0, total: 10 }],
    ]);
    /** The level next to the center price below it trading `fills` times: its BUY 95 fills, then the SELL 100 it arms, and so on */
    const swings = (fills: number) =>
      Array.from({ length: fills }, (_, i) => (i % 2 === 0 ? ['completed', 95, 'BUY'] : ['completed', 100, 'SELL']));
    /** SELL 105 failing at every attempt, the first and the 3 retries: its level is left without an order */
    const sellGivenUp = Array.from({ length: 4 }, () => ['errored', 105, 'SELL']);

    it.each`
      grid                                    | params                             | portfolio              | steps                             | warnings
      ${'one BUY, all 10 USDT fund'}          | ${{}}                              | ${tenUsdt}             | ${swings(4)}                      | ${1}
      ${'a 1/0 grid, all in currency'}        | ${{ buyLevels: 1, sellLevels: 0 }} | ${unbalancedPortfolio} | ${swings(3)}                      | ${1}
      ${'a 1/1 grid whose SELL gave up'}      | ${{ buyLevels: 1, sellLevels: 1 }} | ${balancedPortfolio}   | ${[...sellGivenUp, ...swings(3)]} | ${1}
      ${'a 1/1 grid, two-sided at each SELL'} | ${{ buyLevels: 1, sellLevels: 1 }} | ${balancedPortfolio}   | ${swings(5)}                      | ${3}
    `('warns $warnings time(s) that only one side remains: $grid', ({ params, portfolio, steps, warnings }) => {
      startStrategy(100, params, portfolio);
      steps.forEach(([outcome, price, side]: ['completed' | 'errored', number, OrderSide]) => settle(outcome, price, side));

      expect(oneSideWarnings()).toHaveLength(warnings);
    });
  });

  describe('spacing types', () => {
    it.each`
      spacingType      | spacingValue | expectedBuyPrice | expectedSellPrice
      ${'fixed'}       | ${5}         | ${95}            | ${105}
      ${'percent'}     | ${5}         | ${95}            | ${105}
      ${'logarithmic'} | ${0.05}      | ${95.24}         | ${105}
    `('calculates correct prices for $spacingType spacing', ({ spacingType, spacingValue, expectedBuyPrice, expectedSellPrice }) => {
      startStrategy(100, { spacingType, spacingValue, buyLevels: 1, sellLevels: 1 });

      const buyOrders = issuedOrders.filter(o => o.side === 'BUY');
      const sellOrders = issuedOrders.filter(o => o.side === 'SELL');

      expect(buyOrders[0]?.price).toBe(expectedBuyPrice);
      expect(sellOrders[0]?.price).toBe(expectedSellPrice);
    });
  });

  describe('price tick', () => {
    /** The orders sent, as `side price` */
    const pricesSent = () => issuedOrders.map(({ side, price }) => `${side} ${price}`);

    // Divided by the tick in binary, a close on a tie fell under the half, 109.445 / 0.01 being 10944.499999999998: the grid was
    // centred on 109.44 where round rounds the close to 109.45
    it('centres the grid on a close on a tie rounded upwards, as round rounds it: 109.445 to 109.45', () => {
      // The split of the default grid at 109.45, 2.5 a level: its BUYs at 104.45 and 99.45 take 509.75 USDT
      const balancedAt109: Portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: 5, used: 0, total: 5 }],
        ['USDT', { free: 509.75, used: 0, total: 509.75 }],
      ]);
      startStrategy(109.445, {}, balancedAt109);

      expect(pricesSent()).toEqual(['BUY 99.45', 'BUY 104.45', 'SELL 114.45', 'SELL 119.45']);
    });

    it('warns of no missing tick on a market that states one', () => {
      startStrategy(100);

      expect(log).not.toHaveBeenCalledWith('warn', expect.stringContaining('states no price tick'));
    });

    // The decimals were read from the close then: a close of 100 rounded the prices of a grid spaced by 0.5 % to whole units, 99, 99,
    // 100, 100, 101 and 101, which the start refused, two levels buying and selling at one price
    describe('on a market that states none', () => {
      const halfPercent = { buyLevels: 3, sellLevels: 3, spacingType: 'percent', spacingValue: 0.5 } as const;
      // Its split, 5/3 a level: its BUYs at 99.5, 99 and 98.5 take 495 USDT
      const balancedHalfPercent: Portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: 5, used: 0, total: 5 }],
        ['USDT', { free: 495, used: 0, total: 495 }],
      ]);

      beforeEach(() => {
        tools.marketData = new Map([['BTC/USDT', { amount: { min: 0.1 }, precision: { amount: 0.01 } }]]);
      });

      it('places the grid at its prices rounded to 8 decimals', () => {
        startStrategy(100, halfPercent, balancedHalfPercent);

        expect(pricesSent()).toEqual(['BUY 98.5', 'BUY 99', 'BUY 99.5', 'SELL 100.5', 'SELL 101', 'SELL 101.5']);
      });

      it('centres the grid on the close rounded to 8 decimals', () => {
        startStrategy(100.123456789);

        expect(pricesSent()).toEqual(['BUY 90.12345679', 'BUY 95.12345679', 'SELL 105.12345679', 'SELL 110.12345679']);
      });

      it('warns that it rounds the prices to 8 decimals, which a coarser tick refuses', () => {
        startStrategy(100, halfPercent, balancedHalfPercent);

        expect(log).toHaveBeenCalledWith(
          'warn',
          'GridBot: The market data of BTC/USDT states no price tick (precision.price): the prices of the grid are rounded to 8 decimals, which the exchange refuses if its own tick is coarser',
        );
      });

      it('warns of the missing tick before a refusal at the start', () => {
        untilStopped(() => startStrategy(1, { buyLevels: 1, sellLevels: 1, spacingType: 'percent', spacingValue: 1e-7 }));

        expect(log.mock.calls.map(([level]) => level)).toEqual(['warn', 'error']);
      });
    });

    // Hyperliquid takes 5 significant digits in a price: from 10000 on its tick is 1, where precision.price, its tick at the price the
    // markets were loaded at, 9990 here, says 0.1. Rounded to 0.1, the grid sent prices the exchange moved, 10001.4 taken as 10001,
    // and two prices a tick of 0.1 apart that it took as one, 10000.5 and 10001 as 10001
    describe('on a market that takes 5 significant digits in a price, its tick stated as 0.1', () => {
      const significantDigits = new Map([['BTC/USDT', { precision: { price: 0.1, amount: 0.01, priceSignificantDigits: 5 } }]]);
      // The split of the grid spaced by 1 around 10000, 1 a level: its BUYs at 9999 and 9998 take 19997 USDT
      const balancedAround10000: Portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: 2, used: 0, total: 2 }],
        ['USDT', { free: 19997.5, used: 0, total: 19997.5 }],
      ]);

      it('places the grid at the prices the exchange takes: a close of 10000.37 centres it on 10000, its SELLs at 10001 and 10002', () => {
        tools.marketData = significantDigits;
        startStrategy(10000.37, { spacingValue: 1 }, balancedAround10000);

        expect(pricesSent()).toEqual(['BUY 9998', 'BUY 9999', 'SELL 10001', 'SELL 10002']);
      });

      it('stops the run for two prices of the grid its tick rounds together, naming the rule: 10000.5 and 10001 at 10001', () => {
        tools.marketData = significantDigits;

        expect(() => startStrategy(9999, { buyLevels: 2, sellLevels: 4, spacingValue: 0.5 }, balancedAround10000)).toThrow(
          'GridBot: Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.5 (fixed) around the center price 9999, two adjacent prices of the grid would both round to 10001 at the price tick 1, the market taking 5 significant digits in a price (precision.priceSignificantDigits)',
        );
      });

      it('builds the grid around the price the exchange takes once the rebalance fills at 10000.37: 10000', () => {
        tools.marketData = significantDigits;
        startStrategy(10000, { spacingValue: 1 }, unbalancedPortfolio);
        const exchange = { price: 10000.37, portfolio: balancedAround10000 };
        strategy.onOrderCompleted({ order: { id: issuedOrders[0].id } as any, exchange, tools });

        expect(amountsSentAfter(1)).toEqual(['BUY 9998 x1', 'BUY 9999 x1', 'SELL 10001 x1', 'SELL 10002 x1']);
      });

      // Placed again around 10000, the rebalance would pay for a grid whose prices 10000.5 and 10001 the exchange takes as one
      it('stops the run before placing a failed rebalance again around the price the exchange takes, 10000 for 10000.37', () => {
        tools.marketData = significantDigits;
        startStrategy(9998, { buyLevels: 2, sellLevels: 4, spacingValue: 0.5 }, unbalancedPortfolio);
        const failAt10000 = () =>
          strategy.onOrderErrored({
            order: { id: issuedOrders[0].id, reason: 'Test error' } as any,
            exchange: { price: 10000.37, portfolio: unbalancedPortfolio },
            tools,
          });

        expect(failAt10000).toThrow(
          'GridBot: Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.5 (fixed) around the center price 10000, two adjacent prices of the grid would both round to 10001 at the price tick 1, the market taking 5 significant digits in a price (precision.priceSignificantDigits)',
        );
      });

      it('places the grid at the prices of the tick stated, as before, on a market that states no such rule', () => {
        tools.marketData = new Map([['BTC/USDT', { precision: { price: 0.1, amount: 0.01 } }]]);
        startStrategy(10000.37, { spacingValue: 1 }, balancedAround10000);

        expect(pricesSent()).toEqual(['BUY 9998.4', 'BUY 9999.4', 'SELL 10001.4', 'SELL 10002.4']);
      });

      // Sized at 10048.5, where it is placed at 10049, 1 a level would cost 20096, more than the 20095.5 free
      it('sizes its BUYs at the prices the exchange takes: 0.99 a level for 20095.5 USDT, at 10047 and 10049', () => {
        const buyOnlyInCurrency: Portfolio = new Map<string, BalanceDetail>([
          ['BTC', { free: 0, used: 0, total: 0 }],
          ['USDT', { free: 20095.5, used: 0, total: 20095.5 }],
        ]);
        tools.marketData = significantDigits;
        startStrategy(10050, { sellLevels: 0, spacingValue: 1.5 }, buyOnlyInCurrency);

        expect(amountsSentAfter(0)).toEqual(['BUY 10047 x0.99', 'BUY 10049 x0.99']);
      });

      // Spaced by 1.4, its highest price, 10002.8, is 10003 there, and the SELL next to it, 10001.4, is 10001
      it('warns of a price out of the range of the prices the exchange takes, naming where the grid waits', () => {
        tools.marketData = significantDigits;
        startStrategy(10000, { spacingValue: 1.4 }, balancedAround10000);
        strategy.onEachTimeframeCandle({ candle: makeCandle(10010), portfolio: balancedAround10000, tools });

        expect(log).toHaveBeenCalledWith(
          'warn',
          'GridBot: Price 10010 is out of grid range [9997.2, 10003]: the grid stays in place, its orders waiting for the price to come back to 10001',
        );
      });

      it('stops the run when the grid is built around the price the exchange takes, 10000 for a fill at 10000.37, where its tick merges two prices', () => {
        tools.marketData = significantDigits;
        startStrategy(9998, { buyLevels: 2, sellLevels: 4, spacingValue: 0.5 }, unbalancedPortfolio);
        const exchange = { price: 10000.37, portfolio: balancedAround10000 };

        expect(() => strategy.onOrderCompleted({ order: { id: issuedOrders[0].id } as any, exchange, tools })).toThrow(
          'GridBot: Grid configuration would result in a level buying and selling at the same price: spaced by spacingValue 0.5 (fixed) around the center price 10000, two adjacent prices of the grid would both round to 10001 at the price tick 1, the market taking 5 significant digits in a price (precision.priceSignificantDigits)',
        );
      });
    });
  });

  // A backtest's market data, parsed by the dummy-cex schema from the configuration of config/backtest.yml and the documentation,
  // whose precision is 8 decimals. Handed on as steps of 8, it rounded the grid prices to multiples of 8 and these amounts, below
  // 1 BTC, to 0: GridBot stopped the backtest at its first candle after warmup ('Insufficient portfolio for any grid levels').
  describe('with the market data of the documented dummy-cex configuration', () => {
    const { marketData: configuredMarketData } = dummyExchangeSchema.parse({
      name: 'dummy-cex',
      simulationBalance: [{ assetName: 'USDT', balance: 1000 }],
      marketData: [
        {
          symbol: 'BTC/USDT',
          marketData: {
            price: { min: 0.01, max: 1_000_000 },
            amount: { min: 0.00001, max: 9000 },
            cost: { min: 5, max: 9_000_000 },
            precision: { price: 8, amount: 8 },
            fee: { maker: 0.0004, taker: 0.0007 },
          },
        },
      ],
    });
    const percentGrid = { spacingType: 'percent', spacingValue: 1 } as const;

    beforeEach(() => {
      tools.marketData = configuredMarketData;
    });

    // Half of it used to be bought, 0.00816532 BTC, and about 3 % of the currency left stayed idle once the SELLs had their BTC
    it('rebalances the documented portfolio, 1000 USDT and no BTC, with a STICKY BUY of the split that funds its grid, to 8 decimals', () => {
      startStrategy(61234.56, { ...percentGrid, buyLevels: 5, sellLevels: 5 }, unbalancedPortfolio);

      expect(createOrder.mock.calls).toEqual([[{ type: 'STICKY', side: 'BUY', amount: 0.00828635, symbol: 'BTC/USDT' }]]);
    });

    // Limited by the currency, the BUY used to be sized on its price alone: 0.0494868 at 60622.2144 is all of the 3000 USDT, and
    // 3001.1994 with the maker fee the simulator charges on top, which refused it at every attempt. 0.04946702 costs 2999.9998.
    it('places a balanced grid 1 % around the close, its prices and amounts to 8 decimals', () => {
      const portfolio: Portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: 0.05, used: 0, total: 0.05 }],
        ['USDT', { free: 3000, used: 0, total: 3000 }],
      ]);
      startStrategy(61234.56, { ...percentGrid, buyLevels: 1, sellLevels: 1 }, portfolio);

      expect(createOrder.mock.calls).toEqual([
        [{ type: 'LIMIT', side: 'BUY', amount: 0.04946702, price: 60622.2144, symbol: 'BTC/USDT' }],
        [{ type: 'LIMIT', side: 'SELL', amount: 0.04946702, price: 61846.9056, symbol: 'BTC/USDT' }],
      ]);
    });

    // A sell-only grid wants the whole value in the asset. It used to plan a BUY of the whole currency at the close, 10 here, which
    // the simulator refused at every attempt: its STICKY order is placed one minimum price above the bid, at 100.01, and the maker fee
    // comes on top, 1000.50004 in all. The run stopped before any grid was built.
    it('rebalances a sell-only grid, all in currency, with a STICKY BUY the currency pays once placed', () => {
      startStrategy(100, { buyLevels: 0, sellLevels: 5 }, unbalancedPortfolio);

      expect(createOrder.mock.calls).toEqual([[{ type: 'STICKY', side: 'BUY', amount: 9.99500209, symbol: 'BTC/USDT' }]]);
    });

    // Planned on the totals, the rebalance bought 5 BTC at 100, a notional of 500 that the 500.22 USDT free passed, while its STICKY
    // order, at 100.01 with the maker fee on top, took 500.25002, which the simulator refused. Planned on the free currency, it splits
    // what the grid can use.
    it('rebalances the free currency, not the total, when part of it is locked in other orders', () => {
      const partlyLocked: Portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: 0, used: 0, total: 0 }],
        ['USDT', { free: 500.22, used: 499.78, total: 1000 }],
      ]);
      startStrategy(100, { buyLevels: 1, sellLevels: 1 }, partlyLocked);

      expect(createOrder.mock.calls).toEqual([[{ type: 'STICKY', side: 'BUY', amount: 2.56407359, symbol: 'BTC/USDT' }]]);
    });

    // A rebalance under cost.min, a gap between the 1 % tolerance and the market minimum on a small account, used to be sent and
    // refused, planned again identically at every attempt, until the run stopped ('Rebalance failed after 4 attempts'), while the
    // portfolio as it was funded a grid. Here a BUY of 3.23 USDT on 0.00235 BTC and 146 USDT, whose grid's lowest BUY costs 27.34
    describe('when the rebalance is under the market minimum', () => {
      const smallAccount: Portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: 0.00235, used: 0, total: 0.00235 }],
        ['USDT', { free: 146, used: 0, total: 146 }],
      ]);
      const fiveByFive = { ...percentGrid, buyLevels: 5, sellLevels: 5 };
      const asItIs = [...Array<string>(5).fill('LIMIT BUY 0.00047'), ...Array<string>(5).fill('LIMIT SELL 0.00047')];
      // Rebalanced with a STICKY BUY of 0.00241 BTC
      const allInCurrency: Portfolio = new Map<string, BalanceDetail>([
        ['BTC', { free: 0, used: 0, total: 0 }],
        ['USDT', { free: 290.84, used: 0, total: 290.84 }],
      ]);

      it('builds the grid on the portfolio as it is, with no rebalance', () => {
        startStrategy(61234.56, fiveByFive, smallAccount);

        expect(issuedOrders.map(({ type, side, amount }) => `${type} ${side} ${amount}`)).toEqual(asItIs);
      });

      it('logs, at info, the rebalance it leaves out', () => {
        startStrategy(61234.56, fiveByFive, smallAccount);

        expect(log).toHaveBeenCalledWith(
          'info',
          'GridBot: No rebalance, its BUY of 0.0000527 BTC being under the market minimum of 0.00008166 BTC: the grid is built on the free balances as they are',
        );
      });

      // 0.05 BTC at 100 is 5 USDT, but its STICKY order is placed one minimum price under the ask, at 99.99: 4.9995 USDT, which the
      // exchange refuses
      it('leaves out a SELL of cost.min at the center price, under it at the price of its STICKY order', () => {
        const richInAsset: Portfolio = new Map<string, BalanceDetail>([
          ['BTC', { free: 0.6, used: 0, total: 0.6 }],
          ['USDT', { free: 50, used: 0, total: 50 }],
        ]);
        const sellOfCostMin = { side: 'SELL', amount: 0.05, estimatedNotional: 5, centerPrice: 100 } as const;
        vi.spyOn(GridBotUtils, 'computeRebalancePlan').mockReturnValue(sellOfCostMin);
        startStrategy(100, fiveByFive, richInAsset);

        expect(log).toHaveBeenCalledWith(
          'info',
          'GridBot: No rebalance, its SELL of 0.05 BTC being under the market minimum of 0.05000501 BTC: the grid is built on the free balances as they are',
        );
      });

      // The plan made again after a failure used to be placed unchecked
      it('builds the grid once a failed rebalance leaves a gap under the market minimum', () => {
        startStrategy(61234.56, fiveByFive, allInCurrency);
        const order = { id: issuedOrders[0].id, reason: 'Test error' } as any;
        strategy.onOrderErrored({ order, exchange: { price: 61234.56, portfolio: smallAccount }, tools });

        expect(issuedOrders.map(({ type, side, amount }) => `${type} ${side} ${amount}`)).toEqual(['STICKY BUY 0.00241', ...asItIs]);
      });

      // It read "Retrying..." there, the grid built at once without a rebalance
      it('says the failed rebalance is not placed again, then why, once it leaves a gap under the market minimum', () => {
        startStrategy(61234.56, fiveByFive, allInCurrency);
        const logged = log.mock.calls.length;
        const order = { id: issuedOrders[0].id, reason: 'Test error' } as any;
        strategy.onOrderErrored({ order, exchange: { price: 61234.56, portfolio: smallAccount }, tools });

        expect(log.mock.calls.slice(logged)).toEqual([
          ['warn', 'GridBot: Rebalance attempt 1 failed: Test error. Not placed again: the grid is built on the free balances it left'],
          [
            'info',
            'GridBot: No rebalance, its BUY of 0.0000527 BTC being under the market minimum of 0.00008166 BTC: the grid is built on the free balances as they are',
          ],
          ['info', 'GridBot: Grid built around 61234.56 with 5 buy / 5 sell levels, qty=0.00047'],
        ]);
      });
    });
  });

  // A quantity raised to cost.min at the lowest price beyond what the free balances funded, and left unrounded, 0.0000859507… on
  // 0.0004 BTC and 25 USDT: the simulator refused the highest BUY and the highest SELL for want of funds, and CCXTExchange, truncating
  // the amount to Binance's step, 0.00008, refused 7 levels of 10 for a cost under 5 USDT, at every attempt
  describe('with the BTC/USDT steps of Binance, an amount to 5 decimals, on a small account', () => {
    const { marketData: binanceStepsMarketData } = dummyExchangeSchema.parse({
      name: 'dummy-cex',
      simulationBalance: [{ assetName: 'USDT', balance: 25 }],
      marketData: [
        {
          symbol: 'BTC/USDT',
          marketData: {
            price: { min: 0.01, max: 1_000_000 },
            amount: { min: 0.00001, max: 9000 },
            cost: { min: 5, max: 9_000_000 },
            precision: { price: 2, amount: 5 },
            fee: { maker: 0.0004, taker: 0.0007 },
          },
        },
      ],
    });
    const smallAccount: Portfolio = new Map<string, BalanceDetail>([
      ['BTC', { free: 0.0004, used: 0, total: 0.0004 }],
      ['USDT', { free: 25, used: 0, total: 25 }],
    ]);
    const fiveByFive = { buyLevels: 5, sellLevels: 5, spacingType: 'percent', spacingValue: 1 } as const;

    beforeEach(() => {
      tools.marketData = binanceStepsMarketData;
    });

    it('places every order at the market minimum or above, on the amount step, the farthest level of each side left out', () => {
      startStrategy(61234.56, fiveByFive, smallAccount);

      expect(issuedOrders.map(({ side, price, amount }) => `${side} ${price} x${amount}`)).toEqual([
        'BUY 58785.18 x0.0001',
        'BUY 59397.52 x0.0001',
        'BUY 60009.87 x0.0001',
        'BUY 60622.21 x0.0001',
        'SELL 61846.91 x0.0001',
        'SELL 62459.25 x0.0001',
        'SELL 63071.6 x0.0001',
        'SELL 63683.94 x0.0001',
      ]);
    });

    it('warns that it leaves out the farthest level of each side, and why', () => {
      startStrategy(61234.56, fiveByFive, smallAccount);

      expect(log).toHaveBeenCalledWith(
        'warn',
        'GridBot: 1 of the 5 buy levels and 1 of the 5 sell levels left out, the farthest from the center price: 0.0004 BTC and 25 USDT free fund no more orders of the market minimum, 0.00009 BTC at 58785.18, the lowest price of the grid',
      );
    });

    it('logs the levels the grid is built with', () => {
      startStrategy(61234.56, fiveByFive, smallAccount);

      expect(log).toHaveBeenCalledWith('info', 'GridBot: Grid built around 61234.56 with 4 buy / 4 sell levels, qty=0.0001');
    });

    it('warns of a price out of the grid it built, the levels left out included', () => {
      startStrategy(61234.56, fiveByFive, smallAccount);
      strategy.onEachTimeframeCandle({ candle: makeCandle(58500), portfolio: smallAccount, tools });

      expect(log).toHaveBeenCalledWith(
        'warn',
        'GridBot: Price 58500 is out of grid range [58785.18, 63683.94]: the grid stays in place, its orders waiting for the price to come back to 59397.52',
      );
    });
  });

  // The quantity was raised to amount.min beyond what the free balances funded: on 10 USDT, a 2/2 grid at 100 of 0.1 BTC a level,
  // which needed 18.5 USDT and 0.2 BTC
  describe('on free balances funding part of the grid at the market minimum, amount.min 0.1', () => {
    const tenUsdt: Portfolio = new Map<string, BalanceDetail>([
      ['BTC', { free: 0, used: 0, total: 0 }],
      ['USDT', { free: 10, used: 0, total: 10 }],
    ]);
    const fourUsdt: Portfolio = new Map<string, BalanceDetail>([
      ['BTC', { free: 0, used: 0, total: 0 }],
      ['USDT', { free: 4, used: 0, total: 4 }],
    ]);

    it('builds the levels they fund, one BUY here, the rebalance of 0.05 BTC being under the minimum', () => {
      startStrategy(100, {}, tenUsdt);

      expect(amountsSentAfter(0)).toEqual(['BUY 95 x0.1']);
    });

    it('warns that it leaves out the levels they do not fund, the whole of a side included', () => {
      startStrategy(100, {}, tenUsdt);

      expect(log).toHaveBeenCalledWith(
        'warn',
        'GridBot: 1 of the 2 buy levels and 2 of the 2 sell levels left out, the farthest from the center price: 0 BTC and 10 USDT free fund no more orders of the market minimum, 0.1 BTC at 95, the lowest price of the grid',
      );
    });

    it('stops the run when they fund no order the market takes', () => {
      expect(() => startStrategy(100, {}, fourUsdt)).toThrow(
        'GridBot: Insufficient portfolio for any grid levels: 0 BTC and 4 USDT free fund no order the market takes',
      );
    });
  });
});
