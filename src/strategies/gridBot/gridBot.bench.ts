import type { CandleBucket, OrderCompletedEvent } from '@models/event.types';
import type { Portfolio } from '@models/portfolio.types';
import type { TradingPair } from '@models/utility.types';
import type { MarketData } from '@services/exchange/exchange.types';
import type { Tools } from '@strategies/strategy.types';
import { bench } from '@utils/bench/bench.mock';
import type { UUID } from 'node:crypto';
import { describe } from 'vitest';
import { GridBot } from './gridBot.strategy';
import type { GridBotStrategyParams } from './gridBot.types';
import { getGridFunding } from './gridBot.utils';

// The fixtures used to have other shapes than what the StrategyManager hands a strategy, behind `as any`: a bare candle, the market
// data of the pair alone, and a portfolio keyed 'asset' and 'currency'. Every bench threw at init and measured nothing, reported as
// no sample while the run passed. They are a bucket of a candle per pair, the market data by pair and the balances by asset.
const PAIR: TradingPair = 'BTC/USDT';
const CENTER_PRICE = 100;

const marketData = new Map<TradingPair, MarketData>([
  [PAIR, { precision: { price: 0.01, amount: 0.001 }, amount: { min: 0.001, max: 1000 } }],
]);

const bucketAt = (close: number): CandleBucket => new Map([[PAIR, { start: 0, open: close, high: close, low: close, close, volume: 1 }]]);

/** A grid and the balances that fund it with 10 a level around the center price, the split it rebalances to: built without a rebalance */
const gridOf = (params: GridBotStrategyParams) => {
  const { asset, currency } = getGridFunding(CENTER_PRICE, params, marketData.get(PAIR)!);
  const portfolio: Portfolio = new Map([
    ['BTC', { free: 10 * asset, used: 0, total: 10 * asset }],
    ['USDT', { free: 10 * currency, used: 0, total: 10 * currency }],
  ]);
  return { params, portfolio };
};

const fiveByFive = gridOf({ buyLevels: 5, sellLevels: 5, spacingType: 'fixed', spacingValue: 5, retryOnError: 3 });
const tenByTen = gridOf({ buyLevels: 10, sellLevels: 10, spacingType: 'fixed', spacingValue: 2, retryOnError: 3 });
const logarithmic = gridOf({ buyLevels: 5, sellLevels: 5, spacingType: 'logarithmic', spacingValue: 0.02, retryOnError: 3 });

/** The tools GridBot gets, each order it creates kept in `orders` as the event of its fill carries it */
const toolsFor = (strategyParams: GridBotStrategyParams, orders: OrderCompletedEvent['order'][]): Tools<GridBotStrategyParams> => ({
  strategyParams,
  marketData,
  log: () => {},
  createOrder: ({ symbol, side, type, amount = 0, price = CENTER_PRICE }) => {
    const id = `00000000-0000-0000-0000-${String(orders.length + 1).padStart(12, '0')}` as UUID;
    orders.push({ id, symbol, side, type, amount, price, orderCreationDate: 0, orderExecutionDate: 0, effectivePrice: price, fee: 0 });
    return id;
  },
  cancelOrder: () => {},
  cancelTrailingOrder: () => {},
});

/** A GridBot whose grid is placed: init on the first bucket, then the first candle after the warmup, which starts the grid */
const startGrid = ({ params, portfolio }: ReturnType<typeof gridOf>, orders: OrderCompletedEvent['order'][] = []) => {
  const strategy = new GridBot();
  const tools = toolsFor(params, orders);
  strategy.init({ candle: bucketAt(CENTER_PRICE), portfolio, tools, addIndicator: () => {} });
  strategy.onTimeframeCandleAfterWarmup({ candle: bucketAt(CENTER_PRICE), portfolio, tools });
  return { strategy, tools, portfolio };
};

describe('GridBot Strategy Performance', () => {
  describe('init and the first candle after the warmup', () => {
    bench('initialize with 5 buy + 5 sell levels', () => {
      startGrid(fiveByFive);
    });

    bench('initialize with 10 buy + 10 sell levels', () => {
      startGrid(tenByTen);
    });

    bench('initialize with logarithmic spacing', () => {
      startGrid(logarithmic);
    });
  });

  describe('onEachTimeframeCandle', () => {
    bench('100 candle updates in range', () => {
      const { strategy, tools, portfolio } = startGrid(fiveByFive);

      for (let i = 0; i < 100; i++) {
        strategy.onEachTimeframeCandle({ candle: bucketAt(CENTER_PRICE + (i % 10) - 5), portfolio, tools });
      }
    });

    bench('100 candle updates out of range', () => {
      const { strategy, tools, portfolio } = startGrid(fiveByFive);

      for (let i = 0; i < 100; i++) {
        strategy.onEachTimeframeCandle({ candle: bucketAt(150), portfolio, tools });
      }
    });
  });

  describe('onOrderCompleted', () => {
    // It used to complete orders GridBot never placed, which it ignores
    bench('100 fills, each turning its level to its other side', () => {
      const orders: OrderCompletedEvent['order'][] = [];
      const { strategy, tools, portfolio } = startGrid(fiveByFive, orders);

      // The BUY next to the center price fills, and its level sells at the center price: each fill places the order that fills next
      let order = orders.find(({ side, price }) => side === 'BUY' && price === 95)!;
      for (let i = 0; i < 100; i++) {
        strategy.onOrderCompleted({ order, exchange: { price: order.price ?? CENTER_PRICE, portfolio }, tools });
        order = orders[orders.length - 1];
      }
    });
  });
});
