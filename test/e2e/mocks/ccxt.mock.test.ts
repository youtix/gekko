import { beforeEach, describe, expect, it } from 'bun:test';
import { ONE_MINUTE } from '@constants/time.const';
import { generateSyntheticCandle } from '../fixtures/syntheticData';
import { MockCCXTExchange } from './ccxt.mock';

describe('MockCCXTExchange', () => {
  let exchange: MockCCXTExchange;

  beforeEach(() => {
    exchange = new MockCCXTExchange({});
    MockCCXTExchange.reset();
  });

  describe('Predefined Candles', () => {
    it('should return the predefined candles one per call, then fall back to synthetic ones', async () => {
      const symbol = 'BTC/USDT';
      MockCCXTExchange.setPredefinedCandles(symbol, [
        { close: 100 },
        { close: 105, volume: 10 },
        { close: 102, high: 110, low: 100, open: 103 },
      ]);

      const pages = [
        await exchange.fetchOHLCV(symbol, '1m', 1000, 100),
        await exchange.fetchOHLCV(symbol, '1m', 2000, 100),
        await exchange.fetchOHLCV(symbol, '1m', 3000, 100),
        await exchange.fetchOHLCV(symbol, '1m', 4 * ONE_MINUTE + 1, 2),
      ];

      // [timestamp, open, high, low, close, volume]: a predefined candle at since, the open at the close and the volume at 50 by
      // default, then the synthetic candles from the first minute at or after since
      const synthetic = (minute: number) => {
        const { start, open, high, low, close, volume } = generateSyntheticCandle(symbol, minute * ONE_MINUTE);
        return [start, open, high, low, close, volume];
      };
      expect(pages).toEqual([
        [[1000, 100, 100, 100, 100, 50]],
        [[2000, 105, 105, 105, 105, 10]],
        [[3000, 103, 110, 100, 102, 50]],
        [synthetic(5), synthetic(6)],
      ]);
    });
  });

  describe('Synthetic Candles', () => {
    // bun:test takes no tagged-template table
    it.each([
      { since: 10 * ONE_MINUTE, expected: [10, 11, 12].map(n => n * ONE_MINUTE) },
      { since: 10 * ONE_MINUTE + 1, expected: [11, 12, 13].map(n => n * ONE_MINUTE) },
      { since: 11 * ONE_MINUTE - 1, expected: [11, 12, 13].map(n => n * ONE_MINUTE) },
    ])('should serve minute-aligned candles from the first minute at or after since=$since', async ({ since, expected }) => {
      const result = await exchange.fetchOHLCV('BTC/USDT', '1m', since, 3);
      expect(result.map(([start]) => start)).toEqual(expected);
    });

    it('should respect resetPredefinedCandles', async () => {
      const symbol = 'BTC/USDT';
      MockCCXTExchange.setPredefinedCandles(symbol, [{ close: 100 }]);
      MockCCXTExchange.resetPredefinedCandles();

      const result = await exchange.fetchOHLCV(symbol, '1m', 1000, 2);
      // Because we reset, we should get standard synthetic data
      expect(result).toHaveLength(2);
    });
  });

  describe('reset', () => {
    // The statics a scenario sets, as each flow's beforeEach finds them
    const statics = () => ({
      simulatedGaps: MockCCXTExchange.simulatedGaps,
      shouldThrowError: MockCCXTExchange.shouldThrowError,
      shouldThrowOnCreateOrder: MockCCXTExchange.shouldThrowOnCreateOrder,
      emitDuplicatesEveryXCandle: MockCCXTExchange.emitDuplicatesEveryXCandle,
      emitFutureCandles: MockCCXTExchange.emitFutureCandles,
      simulateOpenOrders: MockCCXTExchange.simulateOpenOrders,
      mockTrades: MockCCXTExchange.mockTrades,
      predefinedCandles: MockCCXTExchange.predefinedCandles,
      predefinedCandlesIndex: MockCCXTExchange.predefinedCandlesIndex,
    });

    it('should put back every static a scenario sets', () => {
      MockCCXTExchange.simulatedGaps = [{ start: 0, end: ONE_MINUTE }];
      MockCCXTExchange.shouldThrowError = true;
      MockCCXTExchange.shouldThrowOnCreateOrder = true;
      MockCCXTExchange.emitDuplicatesEveryXCandle = 3;
      MockCCXTExchange.emitFutureCandles = true;
      MockCCXTExchange.simulateOpenOrders = true;
      MockCCXTExchange.mockTrades = [{ id: 'trade' }];
      MockCCXTExchange.setPredefinedCandles('BTC/USDT', [{ close: 100 }]);

      MockCCXTExchange.reset();

      expect(statics()).toEqual({
        simulatedGaps: [],
        shouldThrowError: false,
        shouldThrowOnCreateOrder: false,
        emitDuplicatesEveryXCandle: 0,
        emitFutureCandles: false,
        simulateOpenOrders: false,
        mockTrades: [],
        predefinedCandles: {},
        predefinedCandlesIndex: {},
      });
    });
  });
});
