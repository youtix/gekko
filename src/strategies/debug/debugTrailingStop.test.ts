import { LoggedLine, OrderRecorder, relayOrderOutcome } from '@helpers/strategy/positionTracker/positionTracker.mock';
import type { TradingPair } from '@models/utility.types';
import type { Tools } from '@strategies/strategy.types';
import type { TrailingStopState } from '@strategies/trailingStopManager.types';
import type { UUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { playCandles, toolsOf } from './debug.mock';
import { DebugTrailingStop } from './debugTrailingStop.strategy';
import { DebugTrailingStopParams } from './debugTrailingStop.types';

const BTC: TradingPair = 'BTC/USDT';
const ETH: TradingPair = 'ETH/USDT';
const BUY_ID: UUID = '00000000-0000-0000-0000-000000000001';
const SELL_ID: UUID = '00000000-0000-0000-0000-000000000002';
/** The stop of the e2e flow (trigger 9930, 0.1%), activated by a candle that opened at 10000 */
const activeStop: TrailingStopState = {
  id: BUY_ID,
  symbol: BTC,
  amount: 1,
  config: { trigger: 9930, percentage: 0.1 },
  status: 'active',
  highestPeak: 10000,
  stopPrice: 9990,
  activationPrice: 9930,
  createdAt: 0,
};

describe('DebugTrailingStop', () => {
  let strategy: DebugTrailingStop;
  let orders: OrderRecorder;
  let logs: LoggedLine[];
  let tools: Tools<DebugTrailingStopParams>;

  /** Plays `count` candles of `pairs` with the strategy block parsed as `params`: see playCandles */
  const play = (count: number, params: DebugTrailingStopParams, pairs: TradingPair[] = [BTC]) => {
    tools.strategyParams = params;
    return playCandles(strategy, tools, orders, count, pairs);
  };

  beforeEach(() => {
    strategy = new DebugTrailingStop();
    orders = new OrderRecorder();
    logs = [];
    tools = toolsOf<DebugTrailingStopParams>(
      { wait: 0, trigger: 9930, percentage: 0.1 },
      { log: (level, message) => logs.push({ level, message }), createOrder: orders.createOrder },
    );
  });

  describe('onTimeframeCandleAfterWarmup', () => {
    it.each`
      wait | calendar
      ${0} | ${'B . .'}
      ${2} | ${'. . B .'}
    `('places its one BUY on the candle wait, counted from 0, the first after the warmup: wait $wait', ({ wait, calendar }) => {
      expect(play(calendar.split(' ').length, { wait, trigger: 9930, percentage: 0.1 })).toBe(calendar);
    });

    it('places a MARKET BUY of 1 unit on the first watched pair, with its trailing stop', () => {
      play(1, { wait: 0, trigger: 9930, percentage: 0.1 }, [BTC, ETH]);
      expect(orders.advices).toStrictEqual([
        { type: 'MARKET', side: 'BUY', amount: 1, symbol: BTC, trailing: { trigger: 9930, percentage: 0.1 } },
      ]);
    });

    it('logs the BUY it places', () => {
      play(1, { wait: 0, trigger: 9930, percentage: 0.1 });
      expect(logs).toEqual([{ level: 'debug', message: 'Trailing stop BUY order created' }]);
    });
  });

  // The paper trader e2e flow asserts on these lines: they show that the StrategyManager forwarded the hooks
  describe('lifecycle logs', () => {
    it('logs each order completed', () => {
      relayOrderOutcome(strategy, 'completed', { id: BUY_ID }, { log: tools.log });
      expect(logs).toEqual([{ level: 'debug', message: `Trailing stop order completed: ${BUY_ID}` }]);
    });

    it('logs the stop activated, with the peak and the stop price it starts from', () => {
      strategy.onTrailingStopActivated(activeStop, tools);
      expect(logs).toEqual([
        { level: 'debug', message: `Trailing stop activated: BUY ${BUY_ID} on BTC/USDT, peak 10000, stop price 9990` },
      ]);
    });

    it('logs the stop triggered, with the MARKET SELL the StrategyManager sent for it', () => {
      strategy.onTrailingStopTriggered(SELL_ID, { ...activeStop, status: 'selling', sellOrderId: SELL_ID }, tools);
      expect(logs).toEqual([
        {
          level: 'debug',
          message: `Trailing stop triggered: BUY ${BUY_ID} on BTC/USDT at stop price 9990, its MARKET SELL ${SELL_ID} of 1 sent`,
        },
      ]);
    });
  });
});
