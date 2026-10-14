import { ONE_MINUTE } from '@constants/time.const';
import { SMA } from '@indicators/movingAverages/sma/sma.indicator';
import type { StrategyOrder } from '@models/advice.types';
import type { Candle } from '@models/candle.types';
import type { CandleBucket, OrderCompletedEvent } from '@models/event.types';
import type { Portfolio } from '@models/portfolio.types';
import type { TradingPair } from '@models/utility.types';
import type { MarketData } from '@services/exchange/exchange.types';
import type { IndicatorResults, Tools } from '@strategies/strategy.types';
import { bench } from '@utils/bench/bench.mock';
import type { UUID } from 'node:crypto';
import { describe } from 'vitest';
import { SMACrossover } from './smaCrossover.strategy';
import type { SMACrossoverStrategyParams } from './smaCrossover.types';

// The fixtures used to be cast to `any`, and the fill of an order to carry its id alone: the PositionTracker read the pair of the first
// SELL that filled, undefined, and threw, so the three oscillating benches measured nothing while `bun run bench` passed (see
// @utils/bench/bench.mock). They are what the StrategyManager hands the strategy: a bucket of candles, the SMA as the indicator computes
// it, the tools, and the fill of each order as the Trader relays it.

const PAIR: TradingPair = 'BTC/USDT';
// The SMA of two candles is ready from the second one: it averages a swing of the oscillating candles to 100, which they cross on every
// candle, and stays half a step below the trending ones
const PARAMS: SMACrossoverStrategyParams = { period: 2, src: 'close' };
const START = Date.UTC(2024, 0, 1);
const MARKET_DATA = new Map<TradingPair, MarketData>([
  [PAIR, { precision: { price: 0.01, amount: 0.00001 }, amount: { min: 0.00001, max: 9000 }, cost: { min: 5 } }],
]);
// The balances the Trader reads after a fill: the BTC an all-in BUY bought, none once the all-in SELL sold it. The strategy starts flat.
const LONG: Portfolio = new Map([
  ['BTC', { free: 1, used: 0, total: 1 }],
  ['USDT', { free: 0, used: 0, total: 0 }],
]);
const FLAT: Portfolio = new Map([
  ['BTC', { free: 0, used: 0, total: 0 }],
  ['USDT', { free: 100, used: 0, total: 100 }],
]);

/** A timeframe candle as the StrategyManager plays it: the bucket the hooks get, the candle of the pair, and the SMA of that candle */
type Step = { bucket: CandleBucket; candle: Candle; sma: IndicatorResults<number | null> };

/** The timeframe candles at these closes, one a minute, each with its SMA as the indicator computes it */
const stepsAt = (closes: number[]): Step[] => {
  const sma = new SMA(PARAMS);
  return closes.map((close, i) => {
    const candle: Candle = { start: START + i * ONE_MINUTE, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000 };
    sma.onNewCandle(candle);
    return { bucket: new Map([[PAIR, candle]]), candle, sma: { results: sma.getResult(), symbol: PAIR } };
  });
};
const oscillating = (count: number) => stepsAt(Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 90 : 110)));
const trending = (count: number) => stepsAt(Array.from({ length: count }, (_, i) => 100 + i));

/**
 * The fill of an order as the Trader relays it: all-in, 1 BTC at the close of the candle it was created on, as the simulator fills a
 * MARKET order, the fee rate unknown, with the balances read after it
 */
const fillOf = (id: UUID, { symbol, side, type }: StrategyOrder, { start, close }: Candle): OrderCompletedEvent => ({
  order: {
    id,
    symbol,
    side,
    type,
    amount: 1,
    price: close,
    orderCreationDate: start + ONE_MINUTE,
    orderExecutionDate: start + ONE_MINUTE,
    effectivePrice: close,
    fee: 0,
  },
  exchange: { portfolio: side === 'BUY' ? LONG : FLAT, price: close },
});

/**
 * The strategy initialized on the first candle, as the StrategyManager initializes it on the first one-minute bucket, with the tools it
 * hands it: the orders the strategy creates wait in `pending` until play fills them
 */
const startRun = (first: CandleBucket) => {
  const strategy = new SMACrossover();
  const pending: { id: UUID; order: StrategyOrder }[] = [];
  let created = 0;
  const tools: Tools<SMACrossoverStrategyParams> = {
    strategyParams: PARAMS,
    marketData: MARKET_DATA,
    log: () => {},
    createOrder: order => {
      const id: UUID = `00000000-0000-0000-0000-${String(++created).padStart(12, '0')}`;
      pending.push({ id, order });
      return id;
    },
    cancelOrder: () => {},
    cancelTrailingOrder: () => {},
  };
  strategy.init({ candle: first, portfolio: FLAT, tools, addIndicator: () => {} });
  return { strategy, tools, pending };
};

/**
 * Plays the candles as the StrategyManager plays them once the warmup is over, log aside: onEachTimeframeCandle records the side of the
 * price, onTimeframeCandleAfterWarmup trades its crossovers, and each order fills before the next candle, as in a backtest
 */
const play = (steps: Step[]) => {
  const { strategy, tools, pending } = startRun(steps[0].bucket);
  let portfolio = FLAT;
  for (const { bucket, candle, sma } of steps) {
    strategy.onEachTimeframeCandle({ candle: bucket, portfolio, tools }, sma);
    strategy.onTimeframeCandleAfterWarmup({ candle: bucket, portfolio, tools }, sma);
    for (const { id, order } of pending.splice(0)) {
      const fill = fillOf(id, order, candle);
      strategy.onOrderCompleted({ ...fill, tools });
      portfolio = fill.exchange.portfolio;
    }
  }
};

describe('SMACrossover Strategy Performance', () => {
  describe('onTimeframeCandleAfterWarmup', () => {
    for (const count of [10, 100, 1000]) {
      const steps = oscillating(count);
      bench(`${count} candles - oscillating (frequent crossovers)`, () => play(steps));
    }

    const trend = trending(1000);
    bench('1000 candles - trending (no crossovers)', () => play(trend));
  });

  describe('init', () => {
    const [{ bucket }] = trending(1);
    bench('init strategy', () => {
      startRun(bucket);
    });
  });

  describe('log', () => {
    const steps = trending(1000);
    bench('log 1000 candles', () => {
      const { strategy, tools } = startRun(steps[0].bucket);
      for (const { bucket, sma } of steps) strategy.log({ candle: bucket, portfolio: FLAT, tools }, sma);
    });
  });
});
