import type { Watch } from '@gekko/schemas/configuration/configuration.types';
import { CandleBucket } from '@gekko/shared/models/event.types';
import type { Exchange } from '@gekko/shared/models/exchange.types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '../run/runContext.types';
import type { Storage } from '../storage/storage';
import { Plugin } from './plugin';
import { PluginMissingServiceError } from './plugin.error';
import { createPluginContext } from './plugin.mock';

vi.mock('../logger/logger', () => ({ debug: vi.fn() }));

/** What the hooks of TestPlugin are called with */
const hooks = { processInit: vi.fn(), processOneMinuteBucket: vi.fn(), processFinalize: vi.fn() };

/** A plugin whose hooks report their calls to `hooks` */
class TestPlugin extends Plugin {
  protected processInit() {
    hooks.processInit();
  }

  protected processOneMinuteBucket(bucket: CandleBucket) {
    hooks.processOneMinuteBucket(bucket);
  }

  protected processFinalize(failure?: Error) {
    hooks.processFinalize(failure);
  }
}

// A realtime run on BTC and ETH at 5m, as the schema outputs its watch section: the pairs derived from the assets
const WATCH: Watch = {
  assets: ['BTC', 'ETH'],
  currency: 'USDT',
  timeframe: '5m',
  tickrate: 1000,
  mode: 'realtime',
  warmup: { tickrate: 1000, candleCount: 3 },
  pairs: [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }],
};
const STRATEGY = { name: 'DEMA', period: 21 };
const BUCKET: CandleBucket = new Map([['BTC/USDT', { start: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]]);

describe('Plugin', () => {
  let context: RunContext;
  let plugin: TestPlugin;

  beforeEach(() => {
    context = createPluginContext({ watch: WATCH, strategy: STRATEGY });
    plugin = new TestPlugin('TestPlugin', context);
  });

  describe('built from the context of a run', () => {
    it.each`
      field                 | expected
      ${'pluginName'}       | ${'TestPlugin'}
      ${'emitterName'}      | ${'TestPlugin'}
      ${'timeframe'}        | ${'5m'}
      ${'warmupPeriod'}     | ${3}
      ${'mode'}             | ${'realtime'}
      ${'pairs'}            | ${['BTC/USDT', 'ETH/USDT']}
      ${'assets'}           | ${['BTC', 'ETH']}
      ${'currency'}         | ${'USDT'}
      ${'strategySettings'} | ${STRATEGY}
    `('reads its $field from the configuration', ({ field, expected }) => {
      expect(plugin[field as keyof TestPlugin]).toEqual(expected);
    });

    it('keeps the context, which it hands to what it builds', () => {
      expect(plugin['context']).toBe(context);
    });

    // The pipeline hands a plugin the services it injects once it is built: asked for here, the exchange and the storage were created
    // for every plugin, a plugin that uses neither included
    it.each`
      service
      ${'exchange'}
      ${'storage'}
    `('creates no $service', ({ service }) => {
      expect(context.services[service as 'exchange' | 'storage']).not.toHaveBeenCalled();
    });
  });

  describe.each`
    service       | read
    ${'exchange'} | ${(target: TestPlugin) => target.getExchange()}
    ${'storage'}  | ${(target: TestPlugin) => target.getStorage()}
  `('its $service', ({ service, read }) => {
    describe('before the pipeline injects it', () => {
      it('is refused with a PluginMissingServiceError', () => {
        expect(() => read(plugin)).toThrow(PluginMissingServiceError);
      });

      it('is refused naming the service and the plugin', () => {
        expect(() => read(plugin)).toThrow(
          `[PIPELINE] Missing ${service} in TestPlugin plugin. Did you forget to inject it in getStaticConfiguration() ?`,
        );
      });
    });

    describe('once injected', () => {
      const injected = {} as Exchange & Storage;

      beforeEach(() => {
        if (service === 'exchange') plugin.setExchange(injected);
        else plugin.setStorage(injected);
      });

      it('is the one injected', () => {
        expect(read(plugin)).toBe(injected);
      });
    });
  });

  describe('lifecycle', () => {
    const failure = new Error('stopped');

    it.each`
      step                    | run                                                           | hook                        | args
      ${'processInitStream'}  | ${(target: TestPlugin) => target.processInitStream()}         | ${'processInit'}            | ${[]}
      ${'processInputStream'} | ${(target: TestPlugin) => target.processInputStream(BUCKET)}  | ${'processOneMinuteBucket'} | ${[BUCKET]}
      ${'processCloseStream'} | ${(target: TestPlugin) => target.processCloseStream(failure)} | ${'processFinalize'}        | ${[failure]}
      ${'processCloseStream'} | ${(target: TestPlugin) => target.processCloseStream()}        | ${'processFinalize'}        | ${[undefined]}
    `('$step calls $hook with $args', async ({ run, hook, args }) => {
      await run(plugin);
      expect(hooks[hook as keyof typeof hooks].mock.calls).toEqual([args]);
    });
  });
});
