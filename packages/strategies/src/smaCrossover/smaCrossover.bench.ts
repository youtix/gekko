import { ONE_MINUTE } from '@gekko/shared/constants/time.const';
import { SMA } from '@gekko/indicators/movingAverages/sma/sma.indicator';
import type { Candle } from '@gekko/shared/models/candle.types';
import type { CandleBucket } from '@gekko/shared/models/event.types';
import type { Portfolio } from '@gekko/shared/models/portfolio.types';
import type { TradingPair } from '@gekko/shared/models/utility.types';
import { indicatorsBySymbol, ScriptedPositions } from '../strategy.mock';
import type { IndicatorResults, Tools } from '../strategy.types';
import { bench } from '@gekko/shared/utils/bench/bench.mock';
import { describe } from 'vitest';
import { SMACrossover } from './smaCrossover.strategy';
import type { SMACrossoverStrategyParams } from './smaCrossover.types';

// The fixtures are what the StrategyManager hands the strategy: a bucket of candles, the SMA as the indicator computes it, and the
// tools. Cast to `any`, they once made the first SELL that filled throw, and the three oscillating benches measured nothing while
// `bun run bench` passed (see @gekko/shared/utils/bench/bench.mock). tools.positions is scripted positions of the pair (see
// ScriptedPositions), which play moves as the position book settles each fill before the next candle, as in a backtest: long once a BUY
// is placed, flat once a SELL is.

const PAIR: TradingPair = 'BTC/USDT';
// The SMA of two candles is ready from the second one: it averages a swing of the oscillating candles to 100, which they cross on every
// candle, and stays half a step below the trending ones
const PARAMS: SMACrossoverStrategyParams = { period: 2, src: 'close' };
const START = Date.UTC(2024, 0, 1);
// What the candle hooks get: the strategy reads no balance, the position book sizing its orders
const PORTFOLIO: Portfolio = new Map();

/** A timeframe candle as the StrategyManager plays it: the bucket the hooks get, and the SMA of that candle */
type Step = { bucket: CandleBucket; sma: IndicatorResults<number | null> };

/** The timeframe candles at these closes, one a minute, each with its SMA as the indicator computes it */
const stepsAt = (closes: number[]): Step[] => {
  const sma = new SMA(PARAMS);
  return closes.map((close, i) => {
    const candle: Candle = { start: START + i * ONE_MINUTE, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000 };
    sma.onNewCandle(candle);
    return { bucket: new Map([[PAIR, candle]]), sma: { results: sma.getResult(), symbol: PAIR } };
  });
};
const oscillating = (count: number) => stepsAt(Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 90 : 110)));
const trending = (count: number) => stepsAt(Array.from({ length: count }, (_, i) => 100 + i));

/**
 * The strategy initialized on the first candle, as the StrategyManager initializes it on the first one-minute bucket, with the tools it
 * hands it: the scripted positions of the pair, flat until play moves them
 */
const startRun = (first: CandleBucket) => {
  const strategy = new SMACrossover();
  const positions = new ScriptedPositions([PAIR]);
  const tools: Tools<SMACrossoverStrategyParams> = {
    strategyParams: PARAMS,
    marketData: new Map(),
    log: () => {},
    // An order created here would leave the position as it was, and the bench would measure another run: it fails at once
    createOrder: () => {
      throw new Error('SMACrossover places its orders through tools.positions, never through tools.createOrder');
    },
    cancelOrder: () => {},
    cancelTrailingOrder: () => {},
    positions,
    indicatorsBySymbol,
  };
  strategy.init({ candle: first, portfolio: PORTFOLIO, tools, addIndicator: () => {} });
  return { strategy, tools, positions };
};

/**
 * Plays the candles as the StrategyManager plays them once the warmup is over, log aside: onEachTimeframeCandle records the side of the
 * price, onTimeframeCandleAfterWarmup trades its crossovers, and each order fills before the next candle, as in a backtest, the position
 * book then long on the pair after a BUY, flat after a SELL
 */
const play = (steps: Step[]) => {
  const { strategy, tools, positions } = startRun(steps[0].bucket);
  let filled = 0;
  for (const { bucket, sma } of steps) {
    strategy.onEachTimeframeCandle({ candle: bucket, portfolio: PORTFOLIO, tools }, sma);
    strategy.onTimeframeCandleAfterWarmup({ candle: bucket, portfolio: PORTFOLIO, tools }, sma);
    while (filled < positions.advices.length) positions.set(PAIR, positions.advices[filled++].side === 'BUY' ? 'LONG' : 'FLAT');
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
      for (const { bucket, sma } of steps) strategy.log({ candle: bucket, portfolio: PORTFOLIO, tools }, sma);
    });
  });
});
