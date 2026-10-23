import { Portfolio } from '@gekko/shared/models/portfolio.types';
import { debug } from '../logger/logger';
import { noop } from 'lodash-es';
import { describe, expect, it, vi } from 'vitest';
import { copyPayload } from '@gekko/shared/helpers/event/event.helper';
import { SequentialEventEmitter } from './sequentialEventEmitter';

// The real copy, counted
vi.mock('@gekko/shared/helpers/event/event.helper', async importOriginal => {
  const actual = await importOriginal<typeof import('@gekko/shared/helpers/event/event.helper')>();
  return { copyPayload: vi.fn(actual.copyPayload) };
});

vi.mock('../logger/logger', () => ({ debug: vi.fn() }));

type Delivery = [event: string, payloads: unknown[]];

/** An emitter whose listeners of `events` log every delivery they receive, in the order they receive them */
const createRecordingEmitter = (events: string[]) => {
  const emitter = new SequentialEventEmitter('test');
  const deliveries: Delivery[] = [];
  for (const event of events) {
    emitter.on(event, (payloads: unknown[]) => {
      deliveries.push([event, payloads]);
    });
  }
  return { emitter, deliveries };
};

/** Broadcasts until nothing is queued, as PluginsStream does after every bucket */
const broadcastAll = async (emitter: SequentialEventEmitter) => {
  while (await emitter.broadcastDeferredEmit()) {
    // Until the queue is empty
  }
};

const createPortfolio = (btc: number): Portfolio =>
  new Map([
    ['BTC', { free: btc, used: 0, total: btc }],
    ['USDT', { free: 100, used: 0, total: 100 }],
  ]);

/** Two portfolios queued in a row under one event, delivered as one array whose order shows too: Maps, which no freeze protects */
const queuedPortfolios = () => [createPortfolio(1), createPortfolio(2)];

/**
 * Queues the portfolios of queuedPortfolios() and broadcasts them to `count` listeners of their event: each one calls `listen` with its
 * place among them, from 0, and the payloads it received
 */
const deliverPortfolios = async (count: number, listen: (index: number, payloads: Portfolio[]) => void) => {
  const emitter = new SequentialEventEmitter('test');
  for (let index = 0; index < count; index++) {
    emitter.on('portfolioChange', (payloads: Portfolio[]) => {
      listen(index, payloads);
    });
  }
  for (const portfolio of queuedPortfolios()) emitter.addDeferredEmit('portfolioChange', portfolio);
  await broadcastAll(emitter);
};

/** An emitter whose first listener of 'a' throws, and whose second records the payloads it receives */
const createEmitterWithFailingListener = () => {
  const emitter = new SequentialEventEmitter('test');
  const received: unknown[][] = [];
  emitter.on('a', () => {
    throw new Error('listener failed');
  });
  emitter.on('a', (payloads: unknown[]) => {
    received.push(payloads);
  });
  emitter.addDeferredEmit('a', 'a1');
  return { emitter, received };
};

describe('SequentialEventEmitter', () => {
  describe('emit', () => {
    it('should execute listeners sequentially and await them', async () => {
      const emitter = new SequentialEventEmitter('test');
      const callOrder: string[] = [];

      emitter.on('test', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        callOrder.push('first');
      });

      emitter.on('test', () => {
        callOrder.push('second');
      });

      await emitter.emit('test');

      expect(callOrder).toEqual(['first', 'second']);
    });

    it('should resolve when the event has no listener', async () => {
      await expect(new SequentialEventEmitter('test').emit('unknown', 'payload')).resolves.toBeUndefined();
    });

    it('should call a listener added during an emit from the next emit on, not during the emit that added it', async () => {
      const emitter = new SequentialEventEmitter('test');
      const calls: string[] = [];
      emitter.on('test', () => {
        calls.push('first');
        if (calls.length > 1) return;
        emitter.on('test', () => {
          calls.push('late');
        });
      });

      await emitter.emit('test');
      await emitter.emit('test');

      expect(calls).toEqual(['first', 'first', 'late']);
    });

    // Not a copy, unlike a deferred event: the final reports and the strategy's error line have one listener each
    it.each`
      position    | index
      ${'first'}  | ${0}
      ${'second'} | ${1}
    `('should hand the $position listener the payload itself', async ({ index }) => {
      const emitter = new SequentialEventEmitter('test');
      const received: unknown[] = [];
      for (let count = 0; count < 2; count++) {
        emitter.on('test', (payload: unknown) => {
          received.push(payload);
        });
      }
      const payload = { value: 1 };

      await emitter.emit('test', payload);

      expect(received[index]).toBe(payload);
    });
  });

  describe('deferred events', () => {
    it('should not deliver a deferred event before it is broadcast', () => {
      const { emitter, deliveries } = createRecordingEmitter(['a']);
      emitter.addDeferredEmit('a', 'a1');
      expect(deliveries).toEqual([]);
    });

    it.each`
      order                                                                       | queued                                                  | delivered
      ${'the payloads of one event together'}                                     | ${[['a', 'a1'], ['a', 'a2'], ['a', 'a3']]}              | ${[['a', ['a1', 'a2', 'a3']]]}
      ${'the payloads queued in a row under an event together'}                   | ${[['a', 'a1'], ['a', 'a2'], ['b', 'b1']]}              | ${[['a', ['a1', 'a2']], ['b', ['b1']]]}
      ${'interleaved events in the order they were queued'}                       | ${[['a', 'a1'], ['b', 'b1'], ['a', 'a2'], ['b', 'b2']]} | ${[['a', ['a1']], ['b', ['b1']], ['a', ['a2']], ['b', ['b2']]]}
      ${'apart the payloads queued on either side of an event nobody listens to'} | ${[['a', 'a1'], ['unheard', 'u1'], ['a', 'a2']]}        | ${[['a', ['a1']], ['a', ['a2']]]}
    `('should deliver $order', async ({ queued, delivered }: { queued: [string, string][]; delivered: Delivery[] }) => {
      const { emitter, deliveries } = createRecordingEmitter(['a', 'b']);
      for (const [event, payload] of queued) emitter.addDeferredEmit(event, payload);

      await broadcastAll(emitter);

      expect(deliveries).toEqual(delivered);
    });

    it('should deliver a payload queued during a delivery afterwards, not with the payloads being delivered', async () => {
      const { emitter, deliveries } = createRecordingEmitter(['a']);
      emitter.on('a', (payloads: string[]) => {
        if (payloads.includes('a1')) emitter.addDeferredEmit('a', 'a2');
      });
      emitter.addDeferredEmit('a', 'a1');

      await broadcastAll(emitter);

      expect(deliveries).toEqual([
        ['a', ['a1']],
        ['a', ['a2']],
      ]);
    });

    it.each`
      position    | index
      ${'first'}  | ${0}
      ${'second'} | ${1}
    `('should deliver a copy of the $position payload of a group, unchanged by a later change to the original', async ({ index }) => {
      const { emitter, deliveries } = createRecordingEmitter(['a']);
      const payloads = [{ value: 1 }, { value: 2 }];
      for (const payload of payloads) emitter.addDeferredEmit('a', payload);

      payloads[index].value = 0;
      await broadcastAll(emitter);

      expect(deliveries).toEqual([['a', [{ value: 1 }, { value: 2 }]]]);
    });

    // The Trader queues its own portfolio, the one it reads again to size its orders
    it.each`
      written        | write
      ${'a balance'} | ${(portfolio: Portfolio) => (portfolio.get('BTC')!.free = 0)}
      ${'an entry'}  | ${(portfolio: Portfolio) => portfolio.delete('BTC')}
    `('should deliver a portfolio as it was queued when the emitter then writes to $written of its own', async ({ write }) => {
      const { emitter, deliveries } = createRecordingEmitter(['portfolioChange']);
      const portfolio = createPortfolio(1);
      emitter.addDeferredEmit('portfolioChange', portfolio);

      write(portfolio);
      await broadcastAll(emitter);

      expect(deliveries).toEqual([['portfolioChange', [createPortfolio(1)]]]);
    });

    it('should leave the portfolio of the emitter as it was queued when its listener writes to the one it got', async () => {
      const emitter = new SequentialEventEmitter('test');
      emitter.on('portfolioChange', ([received]: Portfolio[]) => {
        received.get('BTC')!.free = 0;
      });
      const portfolio = createPortfolio(1);
      emitter.addDeferredEmit('portfolioChange', portfolio);

      await broadcastAll(emitter);

      expect(portfolio).toEqual(createPortfolio(1));
    });

    it.each`
      kind            | payload
      ${'a function'} | ${{ order: { id: 'order', notify: noop } }}
      ${'a symbol'}   | ${{ order: { id: 'order', tag: Symbol('tag') } }}
    `('should refuse a payload holding $kind with a DataCloneError as it queues it, as structuredClone does', ({ payload }) => {
      const { emitter } = createRecordingEmitter(['a']);
      expect(() => emitter.addDeferredEmit('a', payload)).toThrow(expect.objectContaining({ name: 'DataCloneError' }));
    });

    it('should deliver a payload queued for nobody to a listener added before its delivery', async () => {
      const emitter = new SequentialEventEmitter('test');
      const received: unknown[][] = [];
      emitter.addDeferredEmit('a', { value: 1 });
      emitter.on('a', (payloads: unknown[]) => {
        received.push(payloads);
      });

      await broadcastAll(emitter);

      expect(received).toEqual([[{ value: 1 }]]);
    });

    // Queued for nobody, the payload is the emitter's own object, not a copy: the listener added since gets a copy of its own
    it('should leave a payload queued for nobody as it was when a listener added before its delivery writes to it', async () => {
      const emitter = new SequentialEventEmitter('test');
      const payload = { value: 2 };
      emitter.addDeferredEmit('a', payload);
      emitter.on('a', (payloads: { value: number }[]) => {
        payloads.at(-1)!.value = 0;
      });

      await broadcastAll(emitter);

      expect(payload).toEqual({ value: 2 });
    });

    it('should deliver a listener added once a payload queued for nobody is broadcast only the payloads queued after it', async () => {
      const emitter = new SequentialEventEmitter('test');
      const received: unknown[][] = [];
      emitter.addDeferredEmit('a', 'a1');
      await broadcastAll(emitter);
      emitter.on('a', (payloads: unknown[]) => {
        received.push(payloads);
      });
      emitter.addDeferredEmit('a', 'a2');

      await broadcastAll(emitter);

      expect(received).toEqual([['a2']]);
    });

    it('should resolve to true for each group it delivers, then to false', async () => {
      const { emitter } = createRecordingEmitter(['a', 'b']);
      emitter.addDeferredEmit('a', 'a1');
      emitter.addDeferredEmit('b', 'b1');

      const results = [await emitter.broadcastDeferredEmit(), await emitter.broadcastDeferredEmit(), await emitter.broadcastDeferredEmit()];

      expect(results).toEqual([true, true, false]);
    });

    it('should return false when no deferred events', async () => {
      const emitter = new SequentialEventEmitter('test');
      const result = await emitter.broadcastDeferredEmit();
      expect(result).toBe(false);
    });

    it('should take a group nobody listens to out of the queue', async () => {
      const emitter = new SequentialEventEmitter('test');
      emitter.addDeferredEmit('unheard', 'u1');

      const results = [await emitter.broadcastDeferredEmit(), await emitter.broadcastDeferredEmit()];

      expect(results).toEqual([true, false]);
    });

    describe('delivery to the listeners', () => {
      it.each`
        written                     | write
        ${'a balance of a payload'} | ${(payloads: Portfolio[]) => (payloads[0].get('BTC')!.free = 0)}
        ${'an entry of a payload'}  | ${(payloads: Portfolio[]) => payloads[0].delete('BTC')}
        ${'the order of the array'} | ${(payloads: Portfolio[]) => payloads.reverse()}
        ${'a payload of the array'} | ${(payloads: Portfolio[]) => payloads.pop()}
      `('should deliver the payloads as queued to the listener after one that wrote to $written', async ({ write }) => {
        let received: Portfolio[] = [];
        await deliverPortfolios(2, (index, payloads) => {
          if (index === 0) write(payloads);
          else received = payloads;
        });

        expect(received).toEqual(queuedPortfolios());
      });

      it.each`
        writer      | reader      | writerIndex | readerIndex
        ${'first'}  | ${'second'} | ${0}        | ${1}
        ${'first'}  | ${'last'}   | ${0}        | ${2}
        ${'second'} | ${'last'}   | ${1}        | ${2}
      `(
        'should deliver the payloads as queued to the $reader of three listeners after the $writer wrote to them',
        async ({ writerIndex, readerIndex }) => {
          let received: Portfolio[] = [];
          await deliverPortfolios(3, (index, payloads) => {
            if (index === writerIndex) payloads[0].get('BTC')!.free = 0;
            if (index === readerIndex) received = payloads;
          });

          expect(received).toEqual(queuedPortfolios());
        },
      );

      it.each`
        keeper     | writer     | keeperIndex | writerIndex
        ${'first'} | ${'last'}  | ${0}        | ${1}
        ${'last'}  | ${'first'} | ${1}        | ${0}
      `(
        'should leave what the $keeper listener kept as it was when the $writer later writes to what it got',
        async ({ keeperIndex, writerIndex }) => {
          const kept: Portfolio[][] = [];
          await deliverPortfolios(2, (index, payloads) => {
            kept[index] = payloads;
          });

          kept[writerIndex][0].get('BTC')!.free = 0;

          expect(kept[keeperIndex]).toEqual(queuedPortfolios());
        },
      );

      // A backtest at 1m queues its timeframe candle every minute for its analyzer alone, which gets the copy made then, by hand. By
      // structuredClone, that copy cost about a sixth of the run, and as much again when the analyzer got a copy of its own
      it.each`
        made              | listeners            | count | copies
        ${'one copy'}     | ${'one listener'}    | ${1}  | ${1}
        ${'two copies'}   | ${'two listeners'}   | ${2}  | ${2}
        ${'three copies'} | ${'three listeners'} | ${3}  | ${3}
      `('should make $made of a payload to queue it and deliver it to $listeners', async ({ count, copies }) => {
        const emitter = new SequentialEventEmitter('test');
        for (let index = 0; index < count; index++) emitter.on('a', noop);
        emitter.addDeferredEmit('a', { value: 1 });

        await emitter.broadcastDeferredEmit();

        expect(copyPayload).toHaveBeenCalledTimes(copies);
      });

      // As the equity point of the PortfolioAnalyzer, which nothing listens to: a backtest at 1m copied it every minute as it queued it
      it.each`
        copier               | getCopier
        ${'copyPayload'}     | ${() => copyPayload}
        ${'structuredClone'} | ${() => globalThis.structuredClone}
      `('should not call $copier for a payload nobody listens to', async ({ getCopier }) => {
        vi.spyOn(globalThis, 'structuredClone');
        const emitter = new SequentialEventEmitter('test');
        emitter.addDeferredEmit('unheard', { value: 1 });

        await emitter.broadcastDeferredEmit();

        expect(getCopier()).not.toHaveBeenCalled();
      });

      it('should call each listener once the one before it is done', async () => {
        const emitter = new SequentialEventEmitter('test');
        const calls: string[] = [];
        emitter.on('a', async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          calls.push('first');
        });
        emitter.on('a', () => {
          calls.push('second');
        });
        emitter.addDeferredEmit('a', 'a1');

        await emitter.broadcastDeferredEmit();

        expect(calls).toEqual(['first', 'second']);
      });

      it('should reject with what a listener throws', async () => {
        const { emitter } = createEmitterWithFailingListener();
        await expect(emitter.broadcastDeferredEmit()).rejects.toThrow('listener failed');
      });

      it('should not deliver the group to the listeners after one that throws', async () => {
        const { emitter, received } = createEmitterWithFailingListener();
        await emitter.broadcastDeferredEmit().catch(noop);

        expect(received).toEqual([]);
      });

      it('should deliver a listener added during a delivery the groups that follow, not the one being delivered', async () => {
        const emitter = new SequentialEventEmitter('test');
        const lateDeliveries: unknown[][] = [];
        let isAdded = false;
        emitter.on('a', () => {
          if (isAdded) return;
          isAdded = true;
          emitter.on('a', (payloads: unknown[]) => {
            lateDeliveries.push(payloads);
          });
        });
        emitter.addDeferredEmit('a', 'a1');
        await broadcastAll(emitter);
        emitter.addDeferredEmit('a', 'a2');

        await broadcastAll(emitter);

        expect(lateDeliveries).toEqual([['a2']]);
      });
    });
  });

  // Logged whatever GEKKO_LOG_LEVEL: the logger drops a debug line below its level before winston formats it
  describe('debug lines', () => {
    /** Queues a1 and a2 under 'a', then b1 under 'b': two groups */
    const queueTwoGroups = (emitter: SequentialEventEmitter) => {
      emitter.addDeferredEmit('a', 'a1');
      emitter.addDeferredEmit('a', 'a2');
      emitter.addDeferredEmit('b', 'b1');
    };

    it('should log a line for each payload it queues, with its event', () => {
      const { emitter } = createRecordingEmitter(['a', 'b']);
      queueTwoGroups(emitter);

      expect(vi.mocked(debug).mock.calls).toEqual([
        ['event', '[test] Adding deferred event: a'],
        ['event', '[test] Adding deferred event: a'],
        ['event', '[test] Adding deferred event: b'],
      ]);
    });

    it('should then log a line for each group it delivers, with its event and its count of payloads', async () => {
      const { emitter } = createRecordingEmitter(['a', 'b']);
      queueTwoGroups(emitter);

      await broadcastAll(emitter);

      expect(vi.mocked(debug).mock.calls).toEqual([
        ['event', '[test] Adding deferred event: a'],
        ['event', '[test] Adding deferred event: a'],
        ['event', '[test] Adding deferred event: b'],
        ['event', '[test] Broadcasting deferred event: a (2 payloads)'],
        ['event', '[test] Broadcasting deferred event: b (1 payloads)'],
      ]);
    });

    it('should log nothing when no group is queued', async () => {
      await new SequentialEventEmitter('test').broadcastDeferredEmit();
      expect(debug).not.toHaveBeenCalled();
    });
  });

  describe('countUndeliveredPayloads', () => {
    it.each`
      counted                                              | queued                                                  | counts
      ${'nothing when nothing is queued'}                  | ${[]}                                                   | ${[]}
      ${'the payloads of every group queued under a name'} | ${[['a', 'a1'], ['b', 'b1'], ['a', 'a2'], ['a', 'a3']]} | ${[['a', 3], ['b', 1]]}
      ${'no event nobody listens to'}                      | ${[['a', 'a1'], ['unheard', 'u1']]}                     | ${[['a', 1]]}
    `('should count $counted', ({ queued, counts }: { queued: [string, string][]; counts: [string, number][] }) => {
      const { emitter } = createRecordingEmitter(['a', 'b']);
      for (const [event, payload] of queued) emitter.addDeferredEmit(event, payload);

      expect(Array.from(emitter.countUndeliveredPayloads())).toEqual(counts);
    });

    it('should count nothing once the queue is broadcast', async () => {
      const { emitter } = createRecordingEmitter(['a']);
      emitter.addDeferredEmit('a', 'a1');

      await broadcastAll(emitter);

      expect(emitter.countUndeliveredPayloads().size).toBe(0);
    });

    it('should leave the payloads it counts queued', async () => {
      const { emitter, deliveries } = createRecordingEmitter(['a']);
      emitter.addDeferredEmit('a', 'a1');

      emitter.countUndeliveredPayloads();
      await broadcastAll(emitter);

      expect(deliveries).toEqual([['a', ['a1']]]);
    });
  });

  // The stream asks it before each broadcast, so that a plugin with nothing queued is not awaited. A payload nobody listens to is
  // queued too: its broadcast takes it out of the queue.
  describe('hasDeferredEvents', () => {
    it.each`
      state                            | queued                 | expected
      ${'nothing queued'}              | ${[]}                  | ${false}
      ${'a payload queued'}            | ${[['a', 'a1']]}       | ${true}
      ${'a payload nobody listens to'} | ${[['unheard', 'u1']]} | ${true}
    `('should be $expected with $state', ({ queued, expected }: { queued: [string, string][]; expected: boolean }) => {
      const { emitter } = createRecordingEmitter(['a']);
      for (const [event, payload] of queued) emitter.addDeferredEmit(event, payload);

      expect(emitter.hasDeferredEvents()).toBe(expected);
    });

    it('should be false once the queue is broadcast', async () => {
      const { emitter } = createRecordingEmitter(['a']);
      emitter.addDeferredEmit('a', 'a1');

      await broadcastAll(emitter);

      expect(emitter.hasDeferredEvents()).toBe(false);
    });
  });
});
