import { Candle } from '@models/candle.types';
import { CandleBucket, EquitySnapshot } from '@models/event.types';
import { bench } from '@utils/bench/bench.mock';
import { describe } from 'vitest';
import { SequentialEventEmitter } from './sequentialEventEmitter';

const MINUTE_START = Date.UTC(2024, 0, 1);
const createCandle = (close: number): Candle => ({
  start: MINUTE_START,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 12.345678,
});

describe('SequentialEventEmitter Performance', () => {
  describe('on', () => {
    bench('on - register single listener', () => {
      const emitter = new SequentialEventEmitter('bench');
      emitter.on('test', () => {});
    });

    bench('on - register 10 listeners', () => {
      const emitter = new SequentialEventEmitter('bench');
      for (let i = 0; i < 10; i++) {
        emitter.on('test', () => {});
      }
    });

    bench('on - register 100 listeners', () => {
      const emitter = new SequentialEventEmitter('bench');
      for (let i = 0; i < 100; i++) {
        emitter.on('test', () => {});
      }
    });
  });

  describe('emit', () => {
    bench('emit - single sync listener', async () => {
      const emitter = new SequentialEventEmitter('bench');
      emitter.on('test', () => {});
      await emitter.emit('test', { data: 42 });
    });

    bench('emit - 10 sync listeners', async () => {
      const emitter = new SequentialEventEmitter('bench');
      for (let i = 0; i < 10; i++) {
        emitter.on('test', () => {});
      }
      await emitter.emit('test', { data: 42 });
    });

    bench('emit - single async listener', async () => {
      const emitter = new SequentialEventEmitter('bench');
      emitter.on('test', async () => {});
      await emitter.emit('test', { data: 42 });
    });

    bench('emit - 10 async listeners', async () => {
      const emitter = new SequentialEventEmitter('bench');
      for (let i = 0; i < 10; i++) {
        emitter.on('test', async () => {});
      }
      await emitter.emit('test', { data: 42 });
    });

    bench('emit - no listeners (noop)', async () => {
      const emitter = new SequentialEventEmitter('bench');
      await emitter.emit('test', { data: 42 });
    });
  });

  // Listened to: the payload of an event nobody listens to is queued uncopied (see the equity snapshot below)
  describe('addDeferredEmit', () => {
    bench('addDeferredEmit - single event', () => {
      const emitter = new SequentialEventEmitter('bench');
      emitter.on('test', () => {});
      emitter.addDeferredEmit('test', { data: 42 });
    });

    bench('addDeferredEmit - 10 events same name', () => {
      const emitter = new SequentialEventEmitter('bench');
      emitter.on('test', () => {});
      for (let i = 0; i < 10; i++) {
        emitter.addDeferredEmit('test', { data: i });
      }
    });

    bench('addDeferredEmit - 100 events same name', () => {
      const emitter = new SequentialEventEmitter('bench');
      emitter.on('test', () => {});
      for (let i = 0; i < 100; i++) {
        emitter.addDeferredEmit('test', { data: i });
      }
    });
  });

  describe('broadcastDeferredEmit', () => {
    bench('broadcastDeferredEmit - single event with listener', async () => {
      const emitter = new SequentialEventEmitter('bench');
      emitter.on('test', () => {});
      emitter.addDeferredEmit('test', { data: 42 });
      await emitter.broadcastDeferredEmit();
    });

    bench('broadcastDeferredEmit - empty queue', async () => {
      const emitter = new SequentialEventEmitter('bench');
      await emitter.broadcastDeferredEmit();
    });

    // Each listener gets its own copy of the payloads, but the last, which gets the one made when they were queued
    const portfolio = new Map([
      ['BTC', { free: 0.5, used: 0, total: 0.5 }],
      ['USDT', { free: 1000, used: 0, total: 1000 }],
    ]);
    for (const count of [1, 2, 3]) {
      bench(`broadcastDeferredEmit - portfolio to ${count} listener(s)`, async () => {
        const emitter = new SequentialEventEmitter('bench');
        for (let i = 0; i < count; i++) emitter.on('portfolioChange', () => {});
        emitter.addDeferredEmit('portfolioChange', portfolio);
        await emitter.broadcastDeferredEmit();
      });
    }

    // What a backtest at 1m queues every minute: the timeframe candle, which its analyzer alone listens to, and the equity point of the
    // PortfolioAnalyzer, which nothing listens to
    const bucket: CandleBucket = new Map([
      ['BTC/USDT', createCandle(42000)],
      ['ETH/USDT', createCandle(2300)],
      ['SOL/USDT', createCandle(95)],
    ]);
    bench('broadcastDeferredEmit - timeframe bucket of 3 pairs to 1 listener', async () => {
      const emitter = new SequentialEventEmitter('bench');
      emitter.on('timeframeCandle', () => {});
      emitter.addDeferredEmit('timeframeCandle', bucket);
      await emitter.broadcastDeferredEmit();
    });

    const snapshot: EquitySnapshot = { date: MINUTE_START, totalValue: 1000 };
    bench('broadcastDeferredEmit - equity snapshot to no listener', async () => {
      const emitter = new SequentialEventEmitter('bench');
      emitter.addDeferredEmit('equitySnapshot', snapshot);
      await emitter.broadcastDeferredEmit();
    });
  });

  describe('full workflow', () => {
    bench('full workflow - register, emit', async () => {
      const emitter = new SequentialEventEmitter('bench');
      emitter.on('test', () => {});
      await emitter.emit('test', { data: 42 });
    });
  });
});
