import {
  ORDER_CANCELED_EVENT,
  ORDER_COMPLETED_EVENT,
  ORDER_ERRORED_EVENT,
  STRATEGY_CREATE_ORDER_EVENT,
  STRATEGY_INFO_EVENT,
} from '@gekko/shared/constants/event.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import type { PipelineContext, PluginRegistry } from './pipeline.types';
import { config } from '../../configuration/configuration';
import * as injecter from '../../injecter/injecter';
import { warning } from '../../logger/logger';
import { CandleDateranges } from '../../storage/storage.types';
import { useTimeZone } from '@gekko/shared/utils/date/date.mock';
import { SequentialEventEmitter } from '../../plugin/sequentialEventEmitter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MissingCandlesError } from '../stream/backtest/backtest.error';
import * as pipelineModule from './pipeline';
import { PluginsEmitSameEventError } from './pipeline.error';
import { streamPipelines } from './pipeline.helper';

vi.mock('../../configuration/configuration', () => ({
  config: {
    getWatch: vi.fn(() => ({ mode: 'realtime' })),
    getPlugins: vi.fn(() => []),
  },
}));

vi.mock('../../injecter/injecter', () => ({
  inject: {
    exchange: vi.fn(),
    storage: vi.fn(),
  },
}));

vi.mock('../../logger/logger', () => ({
  debug: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('./pipeline.helper', () => ({
  streamPipelines: {
    realtime: vi.fn(),
    backtest: vi.fn(),
  },
}));

describe('Pipeline Service', () => {
  describe('launchStream', () => {
    const context: PipelineContext = [{ name: 'TestPlugin', plugin: {} as any }];
    const { signal } = new AbortController();

    it.each`
      mode
      ${'realtime'}
      ${'backtest'}
    `('should call the stream function of the $mode mode with the plugins and no signal', async ({ mode }) => {
      vi.mocked(config.getWatch).mockReturnValue({ mode } as any);
      await pipelineModule.launchStream(context);
      expect(streamPipelines[mode as 'realtime' | 'backtest']).toHaveBeenCalledWith([expect.anything()], undefined);
    });

    it.each`
      mode
      ${'realtime'}
      ${'backtest'}
    `('should hand the stream function of the $mode mode the signal of the options', async ({ mode }) => {
      vi.mocked(config.getWatch).mockReturnValue({ mode } as any);
      await pipelineModule.launchStream(context, { signal });
      expect(vi.mocked(streamPipelines[mode as 'realtime' | 'backtest']).mock.lastCall?.[1]).toBe(signal);
    });
  });

  describe('injectServices', () => {
    it('should inject services into plugins', async () => {
      const setServiceMock = vi.fn();
      const mockService = { foo: 'bar' };

      // Setup dynamic injection mock
      (injecter.inject as any).myService = vi.fn().mockReturnValue(mockService);

      const context: PipelineContext = [
        {
          name: 'TestPlugin',
          inject: ['myService'],
          plugin: {
            setMyService: setServiceMock,
          } as any,
        },
      ];

      await pipelineModule.injectServices(context);

      expect(setServiceMock).toHaveBeenCalledWith(mockService);
    });

    describe('with several plugins and services', () => {
      const storage = { name: 'storage' };
      const exchange = { name: 'exchange' };
      const plugins = {
        PluginA: { setStorage: vi.fn(), setExchange: vi.fn() },
        PluginB: { setExchange: vi.fn() },
      };
      const context: PipelineContext = [
        { name: 'PluginA', inject: ['storage', 'exchange'], plugin: plugins.PluginA as any },
        { name: 'PluginB', inject: ['exchange'], plugin: plugins.PluginB as any },
        { name: 'PluginC', plugin: {} as any },
      ];

      beforeEach(() => {
        vi.mocked(injecter.inject.storage).mockReturnValue(storage as any);
        vi.mocked(injecter.inject.exchange).mockReturnValue(exchange as any);
      });

      it.each`
        pluginName   | setter           | service
        ${'PluginA'} | ${'setStorage'}  | ${storage}
        ${'PluginA'} | ${'setExchange'} | ${exchange}
        ${'PluginB'} | ${'setExchange'} | ${exchange}
      `('should call $setter on $pluginName with its service', async ({ pluginName, setter, service }) => {
        await pipelineModule.injectServices(context);
        expect((plugins as any)[pluginName][setter]).toHaveBeenCalledWith(service);
      });

      it('should resolve with the context', async () => {
        await expect(pipelineModule.injectServices(context)).resolves.toBe(context);
      });
    });

    describe('when an injection throws', () => {
      const failure = new Error('unable to open database file');
      const throwFailure = () => {
        throw failure;
      };

      it.each`
        thrower              | factory         | setter
        ${'service factory'} | ${throwFailure} | ${vi.fn()}
        ${'plugin setter'}   | ${vi.fn()}      | ${throwFailure}
      `('should reject with the error thrown by the $thrower', async ({ factory, setter }) => {
        vi.mocked(injecter.inject.storage).mockImplementation(factory);
        const context: PipelineContext = [{ name: 'CandleWriter', inject: ['storage'], plugin: { setStorage: setter } as any }];

        await expect(pipelineModule.injectServices(context)).rejects.toBe(failure);
      });
    });
  });

  describe('wirePlugins', () => {
    const payloads = [{ id: 1 }];
    const handler = { onOtherEvent: vi.fn(), onMyEvent: vi.fn() };
    const bystander = { onMyEvent: vi.fn() };

    beforeEach(async () => {
      const emitter = new SequentialEventEmitter('EmitterPlugin');
      await pipelineModule.wirePlugins([
        { name: 'EmitterPlugin', eventsEmitted: ['myEvent'], plugin: emitter as any },
        { name: 'HandlerPlugin', eventsHandlers: ['onOtherEvent', 'onMyEvent'], plugin: handler as any },
        // Has the method but does not declare it as a handler
        { name: 'BystanderPlugin', plugin: bystander as any },
      ]);
      await emitter.emit('myEvent', payloads);
    });

    it('should run the handler of the event once, with the payloads', () => {
      expect(handler.onMyEvent.mock.calls).toEqual([[payloads]]);
    });

    it('should run the handler bound to its plugin', () => {
      expect(handler.onMyEvent.mock.contexts).toEqual([handler]);
    });

    it.each`
      method                          | mock
      ${'HandlerPlugin.onOtherEvent'} | ${handler.onOtherEvent}
      ${'BystanderPlugin.onMyEvent'}  | ${bystander.onMyEvent}
    `('should not run $method', ({ mock }) => {
      expect(mock).not.toHaveBeenCalled();
    });
  });

  describe('createPlugins', () => {
    // The registry handed to the pipeline, as the executable hands it the namespace of @gekko/plugins/index
    const registry: Record<string, unknown> = {};
    const plugins = registry as PluginRegistry;
    class MockPlugin {
      constructor(public params: any) {}
    }

    beforeEach(() => {
      registry.MockPlugin = MockPlugin;
    });

    afterEach(() => {
      delete registry.MockPlugin;
    });

    const context: PipelineContext = [{ name: 'MockPlugin', parameters: { name: 'MockPlugin', foo: 'bar' } }];

    it('should instantiate plugins using the registry', async () => {
      const result = await pipelineModule.createPlugins(context, { plugins });

      expect(result[0].plugin).toBeInstanceOf(MockPlugin);
    });

    it('should construct each plugin with its parsed options', async () => {
      const result = await pipelineModule.createPlugins(context, { plugins });

      expect((result[0].plugin as any).params).toEqual({ name: 'MockPlugin', foo: 'bar' });
    });
  });

  describe('preloadMarkets', () => {
    it('should call loadMarkets on the injected exchange', async () => {
      const loadMarketsMock = vi.fn();
      const getExchangeNameMock = vi.fn().mockReturnValue('Binance');
      vi.mocked(injecter.inject.exchange).mockReturnValue({ loadMarkets: loadMarketsMock, getExchangeName: getExchangeNameMock } as any);

      await pipelineModule.preloadMarkets([] as PipelineContext);

      expect(loadMarketsMock).toHaveBeenCalled();
    });
  });

  describe('checkPluginsDuplicateEvents', () => {
    it('should throw PluginsEmitSameEventError if multiple plugins emit the same event', async () => {
      const context: PipelineContext = [
        { name: 'A', eventsEmitted: ['event1'] },
        { name: 'B', eventsEmitted: ['event1'] },
      ];

      await expect(pipelineModule.checkPluginsDuplicateEvents(context)).rejects.toThrow(PluginsEmitSameEventError);
    });

    it('should return context if no duplicates found', async () => {
      const context: PipelineContext = [
        { name: 'A', eventsEmitted: ['event1'] },
        { name: 'B', eventsEmitted: ['event2'] },
        { name: 'C' }, // eventsEmitted undefined
      ];

      const result = await pipelineModule.checkPluginsDuplicateEvents(context);
      expect(result).toBe(context);
    });
  });

  describe('checkPluginsOrderExecution', () => {
    // The events their static configurations declare, those that matter here
    const advisor = { name: 'TradingAdvisor', eventsEmitted: [STRATEGY_INFO_EVENT, STRATEGY_CREATE_ORDER_EVENT] };
    const trader = { name: 'Trader', eventsEmitted: [ORDER_CANCELED_EVENT, ORDER_COMPLETED_EVENT, ORDER_ERRORED_EVENT] };
    // Handles the orders the strategy creates, to notify them, and executes none
    const subscriber = { name: 'EventSubscriber', eventsEmitted: [], eventsHandlers: ['onStrategyCreateOrder', 'onOrderCompleted'] };
    const writer = { name: 'CandleWriter', eventsEmitted: [] };
    // Would end the orders that complete, never the others
    const completer = { name: 'Completer', eventsEmitted: [ORDER_COMPLETED_EVENT] };

    it.each`
      configured                                        | context
      ${'a Trader with the plugin that creates orders'} | ${[advisor, trader, subscriber]}
      ${'no plugin that creates orders'}                | ${[writer, subscriber]}
    `('should not warn with $configured', async ({ context }) => {
      await pipelineModule.checkPluginsOrderExecution(context);
      expect(warning).not.toHaveBeenCalled();
    });

    it.each`
      configured                                             | context
      ${'only a plugin that notifies the orders (screener)'} | ${[advisor, subscriber]}
      ${'no other plugin'}                                   | ${[advisor]}
      ${'only a plugin that would end completed orders'}     | ${[advisor, completer]}
    `('should warn once with $configured', async ({ context }) => {
      await pipelineModule.checkPluginsOrderExecution(context);
      expect(warning).toHaveBeenCalledTimes(1);
    });

    it('should name the plugin, say why the strategy advises once and what to do', async () => {
      await pipelineModule.checkPluginsOrderExecution([advisor, subscriber]);
      expect(warning).toHaveBeenCalledWith(
        'pipeline',
        [
          'TradingAdvisor emits strategyCreateOrder, but no configured plugin executes orders and ends each one with orderCompleted,',
          'orderCanceled or orderErrored, as the Trader does. Every order of the strategy stays pending, so a strategy that waits for its',
          'order to end before it advises again, as every built-in strategy does, advises once per run on each pair. Add a Trader (on',
          'paper-binance or dummy-cex, it only simulates the orders), unless the strategy never creates orders.',
        ].join(' '),
      );
    });

    it.each`
      when                                | context
      ${'it warns'}                       | ${[advisor, subscriber]}
      ${'a Trader executes their orders'} | ${[advisor, trader]}
    `('should resolve with the context when $when', async ({ context }) => {
      await expect(pipelineModule.checkPluginsOrderExecution(context)).resolves.toBe(context);
    });
  });

  describe('checkPluginsDependencies', () => {
    it.each([['fs'], ['path']])('should pass if dependency %s exists', async dep => {
      const context: PipelineContext = [{ name: 'P', dependencies: [dep] }];
      await expect(pipelineModule.checkPluginsDependencies(context)).resolves.toBe(context);
    });

    it('should pass if no dependencies defined', async () => {
      const context: PipelineContext = [{ name: 'P' }];
      await expect(pipelineModule.checkPluginsDependencies(context)).resolves.toBe(context);
    });

    it('should throw if dependency does not exist', async () => {
      const context: PipelineContext = [{ name: 'P', dependencies: ['non-existent-dep-xyz'] }];
      await expect(pipelineModule.checkPluginsDependencies(context)).rejects.toThrow(/Dependency non-existent-dep-xyz not installed/);
    });

    // main() appends the cause to its report: a module installed but failing to load read "not installed" all the same
    it('keeps the failure of the import as the cause', async () => {
      const context: PipelineContext = [{ name: 'P', dependencies: ['non-existent-dep-xyz'] }];
      await expect(pipelineModule.checkPluginsDependencies(context)).rejects.toHaveProperty('cause', expect.any(Error));
    });
  });

  describe('validatePluginsSchema', () => {
    // Strict, like every plugin schema
    const schemaOf = (name: string) =>
      z.strictObject({ name: z.string(), threshold: z.number() }).transform(entry => ({ ...entry, parsedBy: name }));
    const sender = { name: 'Sender', schema: schemaOf('Sender') };
    const receiver = { name: 'Receiver', schema: schemaOf('Receiver') };

    beforeEach(() => {
      vi.mocked(config.getPlugins).mockReturnValue([
        { name: 'Sender', threshold: 1 },
        { name: 'Receiver', threshold: 2 },
      ] as any);
    });

    it('should set the parameters of each plugin to its own entry, parsed by its schema', async () => {
      await expect(pipelineModule.validatePluginsSchema([sender, receiver])).resolves.toEqual([
        { ...sender, parameters: { name: 'Sender', threshold: 1, parsedBy: 'Sender' } },
        { ...receiver, parameters: { name: 'Receiver', threshold: 2, parsedBy: 'Receiver' } },
      ]);
    });

    it('should leave the parameters of a plugin without schema undefined', async () => {
      await expect(pipelineModule.validatePluginsSchema([{ name: 'Sender' }, receiver])).resolves.toEqual([
        { name: 'Sender', parameters: undefined },
        { ...receiver, parameters: { name: 'Receiver', threshold: 2, parsedBy: 'Receiver' } },
      ]);
    });

    describe.each`
      problem                          | receiverEntry                                        | issues
      ${'an unknown key'}              | ${{ name: 'Receiver', threshold: 2, treshold: 3 }}   | ${'✖ Unrecognized key: "treshold"'}
      ${'an option of the wrong type'} | ${{ name: 'Receiver', threshold: '2' }}              | ${'✖ Invalid input: expected number, received string\n  → at threshold'}
      ${'several problems'}            | ${{ name: 'Receiver', threshold: '2', treshold: 3 }} | ${'✖ Unrecognized key: "treshold"\n✖ Invalid input: expected number, received string\n  → at threshold'}
    `('when the entry of a plugin has $problem', ({ receiverEntry, issues }) => {
      beforeEach(() => {
        vi.mocked(config.getPlugins).mockReturnValue([{ name: 'Sender', threshold: 1 }, receiverEntry]);
      });

      it('should reject with a GekkoError', async () => {
        await expect(pipelineModule.validatePluginsSchema([sender, receiver])).rejects.toBeInstanceOf(GekkoError);
      });

      it('should name the plugin and its entry, then give each problem with the path of its option', async () => {
        await expect(pipelineModule.validatePluginsSchema([sender, receiver])).rejects.toHaveProperty(
          'message',
          `[PIPELINE] Invalid options for plugin Receiver (plugins[1]):\n${issues}`,
        );
      });
    });

    describe('when a plugin is configured twice', () => {
      beforeEach(() => {
        vi.mocked(config.getPlugins).mockReturnValue([
          { name: 'Sender', threshold: 1 },
          { name: 'Sender', threshold: '2' },
        ] as any);
      });

      it('should name the invalid entry by its index', async () => {
        await expect(pipelineModule.validatePluginsSchema([sender, sender])).rejects.toThrow(
          /^\[PIPELINE\] Invalid options for plugin Sender \(plugins\[1\]\):\n/,
        );
      });
    });
  });

  describe('checkPluginsModesCompatibility', () => {
    it.each`
      currentMode   | allowedModes                | shouldThrow
      ${'realtime'} | ${['realtime']}             | ${false}
      ${'realtime'} | ${['backtest']}             | ${true}
      ${'backtest'} | ${['realtime', 'backtest']} | ${false}
    `('currentMode: $currentMode, allowed: $allowedModes => throw: $shouldThrow', async ({ currentMode, allowedModes, shouldThrow }) => {
      const { config } = await import('../../configuration/configuration');
      vi.mocked(config.getWatch).mockReturnValue({ mode: currentMode } as any);

      const context: PipelineContext = [{ name: 'P', modes: allowedModes }];
      const promise = pipelineModule.checkPluginsModesCompatibility(context);

      if (shouldThrow) {
        await expect(promise).rejects.toThrow(/does not support/);
      } else {
        await expect(promise).resolves.not.toThrow();
      }
    });
  });

  describe('getPluginsStaticConfiguration', () => {
    // The registry handed to the pipeline, as the executable hands it the namespace of @gekko/plugins/index
    const registry: Record<string, unknown> = {};
    const plugins = registry as PluginRegistry;
    const staticConfiguration = { name: 'RoundTripAnalyzer', modes: ['realtime', 'backtest'], eventsEmitted: ['roundtripCompleted'] };
    class RoundTripAnalyzer {
      static getStaticConfiguration() {
        return staticConfiguration;
      }
    }
    class Trader {}

    beforeEach(() => {
      // Registered out of alphabetical order
      Object.assign(registry, { Trader, RoundTripAnalyzer });
    });

    afterEach(() => {
      delete registry.Trader;
      delete registry.RoundTripAnalyzer;
    });

    it('should return the static configuration of a registered plugin', async () => {
      await expect(pipelineModule.getPluginsStaticConfiguration([{ name: 'RoundTripAnalyzer' }], { plugins })).resolves.toEqual([
        staticConfiguration,
      ]);
    });

    it.each`
      name                     | message
      ${'PerformanceAnalyzer'} | ${/^\[PIPELINE\] Unknown plugin 'PerformanceAnalyzer'\. Available plugins: /}
      ${'RoundtripAnalyzer'}   | ${/^\[PIPELINE\] Unknown plugin 'RoundtripAnalyzer'\. Did you mean 'RoundTripAnalyzer'\? Available plugins: /}
      ${'constructor'}         | ${/^\[PIPELINE\] Unknown plugin 'constructor'\. Available plugins: /}
    `('should reject the unknown plugin $name', async ({ name, message }) => {
      await expect(pipelineModule.getPluginsStaticConfiguration([{ name }], { plugins })).rejects.toThrow(message);
    });

    it('should list the registered plugins in alphabetical order', async () => {
      await expect(pipelineModule.getPluginsStaticConfiguration([{ name: 'PerformanceAnalyzer' }], { plugins })).rejects.toThrow(
        /Available plugins: (.+, )?RoundTripAnalyzer, (.+, )?Trader(, .+)?\.$/,
      );
    });
  });

  describe('checkDateRange', () => {
    const checkInterval = vi.fn();
    const getCandleDateranges = vi.fn();
    const backtestWatch = (start: string, end: string) =>
      ({ mode: 'backtest', pairs: [{ symbol: 'BTC/USDT' }], daterange: { start: Date.parse(start), end: Date.parse(end) } }) as any;

    beforeEach(() => {
      vi.mocked(injecter.inject.storage).mockReturnValue({ checkInterval, getCandleDateranges } as any);
    });

    it.each`
      start                     | end                           | checkedStart              | checkedEnd
      ${'2025-12-30T00:00:00Z'} | ${'2025-12-31T23:59:59Z'}     | ${'2025-12-30T00:00:00Z'} | ${'2025-12-31T23:59:00Z'}
      ${'2025-12-30T00:00:00Z'} | ${'2025-12-31T23:59:59.999Z'} | ${'2025-12-30T00:00:00Z'} | ${'2025-12-31T23:59:00Z'}
      ${'2025-12-30T00:00:30Z'} | ${'2025-12-31T23:59:00Z'}     | ${'2025-12-30T00:00:00Z'} | ${'2025-12-31T23:59:00Z'}
      ${'2025-12-30T00:00:00Z'} | ${'2025-12-31T23:59:00Z'}     | ${'2025-12-30T00:00:00Z'} | ${'2025-12-31T23:59:00Z'}
    `('should check the candles $checkedStart -> $checkedEnd for $start -> $end', async ({ start, end, checkedStart, checkedEnd }) => {
      vi.mocked(config.getWatch).mockReturnValue(backtestWatch(start, end));

      await pipelineModule.checkDateRange([]);

      expect(checkInterval).toHaveBeenCalledWith('BTC/USDT', { start: Date.parse(checkedStart), end: Date.parse(checkedEnd) });
    });

    // On 2025-10-26 Paris goes from 03:00 CEST back to 02:00 CET: the hour from 01:00Z to 02:00Z is the second pass of 02:00-03:00.
    // Floored in local time, a bound in it was checked an hour early, and the backtest read the same wrong minutes: nothing told.
    describe('on a host in Europe/Paris, with bounds in the hour repeated when DST ends', () => {
      useTimeZone('Europe/Paris');

      it.each`
        start                     | end                       | checkedStart              | checkedEnd
        ${'2025-10-26T01:30:20Z'} | ${'2025-10-26T01:45:30Z'} | ${'2025-10-26T01:30:00Z'} | ${'2025-10-26T01:45:00Z'}
        ${'2025-10-23T01:30:00Z'} | ${'2025-10-26T01:30:00Z'} | ${'2025-10-23T01:30:00Z'} | ${'2025-10-26T01:30:00Z'}
      `('should check the candles $checkedStart -> $checkedEnd for $start -> $end', async ({ start, end, checkedStart, checkedEnd }) => {
        vi.mocked(config.getWatch).mockReturnValue(backtestWatch(start, end));

        await pipelineModule.checkDateRange([]);

        expect(checkInterval).toHaveBeenCalledWith('BTC/USDT', { start: Date.parse(checkedStart), end: Date.parse(checkedEnd) });
      });
    });

    it('should report the checked daterange when candles are missing', async () => {
      checkInterval.mockReturnValue({ missingCandleCount: 1 });
      vi.mocked(config.getWatch).mockReturnValue(backtestWatch('2025-12-30T00:00:30Z', '2025-12-31T23:59:59Z'));

      await expect(pipelineModule.checkDateRange([])).rejects.toThrow('BTC/USDT 2025-12-30T00:00:00.000Z -> 2025-12-31T23:59:00.000Z,');
    });

    describe('with two pairs', () => {
      const context: PipelineContext = [{ name: 'TradingAdvisor' }];
      const pairs = [{ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }];
      const daterange = { start: Date.parse('2025-12-30T00:00:00Z'), end: Date.parse('2025-12-31T23:59:00Z') };

      it.each`
        case                                      | mode          | range
        ${'in realtime mode'}                     | ${'realtime'} | ${daterange}
        ${'in importer mode'}                     | ${'importer'} | ${daterange}
        ${'in backtest mode without a daterange'} | ${'backtest'} | ${undefined}
      `('should not open the storage $case', async ({ mode, range }) => {
        vi.mocked(config.getWatch).mockReturnValue({ mode, pairs, daterange: range } as any);

        await pipelineModule.checkDateRange(context);

        expect(injecter.inject.storage).not.toHaveBeenCalled();
      });

      it.each`
        case                                      | mode          | range        | result
        ${'in realtime mode'}                     | ${'realtime'} | ${daterange} | ${undefined}
        ${'in importer mode'}                     | ${'importer'} | ${daterange} | ${undefined}
        ${'in backtest mode without a daterange'} | ${'backtest'} | ${undefined} | ${undefined}
        ${'when no candle is missing'}            | ${'backtest'} | ${daterange} | ${{ missingCandleCount: 0 }}
        ${'when the storage returns no count'}    | ${'backtest'} | ${daterange} | ${null}
      `('should resolve with the context $case', async ({ mode, range, result }) => {
        vi.mocked(config.getWatch).mockReturnValue({ mode, pairs, daterange: range } as any);
        checkInterval.mockReturnValue(result);

        await expect(pipelineModule.checkDateRange(context)).resolves.toBe(context);
      });

      it('should check the candles of every pair', async () => {
        vi.mocked(config.getWatch).mockReturnValue({ mode: 'backtest', pairs, daterange } as any);
        checkInterval.mockReturnValue({ missingCandleCount: 0 });

        await pipelineModule.checkDateRange(context);

        expect(checkInterval.mock.calls).toEqual([
          ['BTC/USDT', daterange],
          ['ETH/USDT', daterange],
        ]);
      });

      describe('when candles of the second pair are missing', () => {
        const missingCandleCounts: Record<string, number> = { 'BTC/USDT': 0, 'ETH/USDT': 3 };
        const availableDateranges: Record<string, CandleDateranges[]> = {
          'BTC/USDT': [{ daterange_start: daterange.start, daterange_end: daterange.end }],
          'ETH/USDT': [
            { daterange_start: daterange.start, daterange_end: Date.parse('2025-12-30T11:59:00Z') },
            { daterange_start: Date.parse('2025-12-30T12:03:00Z'), daterange_end: daterange.end },
          ],
        };

        beforeEach(() => {
          vi.mocked(config.getWatch).mockReturnValue({ mode: 'backtest', pairs, daterange } as any);
          checkInterval.mockImplementation((symbol: string) => ({ missingCandleCount: missingCandleCounts[symbol] }));
          getCandleDateranges.mockImplementation((symbol: string) => availableDateranges[symbol]);
        });

        it('should reject with a MissingCandlesError', async () => {
          await expect(pipelineModule.checkDateRange(context)).rejects.toThrow(MissingCandlesError);
        });

        it('should name that pair, the checked daterange and the date ranges available for that pair', async () => {
          await expect(pipelineModule.checkDateRange(context)).rejects.toHaveProperty(
            'message',
            '[STREAM] Missing candles in database: ETH/USDT 2025-12-30T00:00:00.000Z -> 2025-12-31T23:59:00.000Z, Available date ranges: [2025-12-30T00:00:00.000Z - 2025-12-30T11:59:00.000Z], [2025-12-30T12:03:00.000Z - 2025-12-31T23:59:00.000Z]',
          );
        });
      });
    });
  });

  describe('gekkoPipeline', () => {
    // The registry handed to the pipeline, as the executable hands it the namespace of @gekko/plugins/index
    const registry: Record<string, unknown> = {};
    const plugins = registry as PluginRegistry;
    const journal: string[] = [];
    // What the steps leave in the journal, in the documented order. The checks of the modes, the dependencies and the
    // duplicate emitters leave nothing, nor does the check of the order execution unless it warns: the cases below place them.
    const documentedOrder = [
      'checkDateRange: BTC/USDT',
      'getPluginsStaticConfiguration: Sender',
      'getPluginsStaticConfiguration: Receiver',
      'validatePluginsSchema: Sender',
      'validatePluginsSchema: Receiver',
      'preloadMarkets',
      'createPlugins: Sender',
      'createPlugins: Receiver',
      'wirePlugins: Sender.on(myEvent)',
      'injectServices: Sender.setExchange',
      'injectServices: Receiver.setStorage',
      'launchStream: backtest',
    ];
    const payloads = [{ id: 1 }];
    const unavailable = new Error('exchange unavailable');
    const storage = {
      checkInterval: (symbol: string) => {
        journal.push(`checkDateRange: ${symbol}`);
        return { missingCandleCount: 0 };
      },
    };
    const exchange = { getExchangeName: () => 'binance', loadMarkets: vi.fn() };
    // Journals valid entries only: zod skips the transform of an invalid one
    const schemaOf = (name: string) =>
      z.strictObject({ name: z.string(), threshold: z.number() }).transform(entry => {
        journal.push(`validatePluginsSchema: ${name}`);
        return { ...entry, parsedBy: name };
      });
    let staticConfigurations: Record<string, PipelineContext[number]>;
    const changeReceiver = (change: Partial<PipelineContext[number]>) => () => Object.assign(staticConfigurations.Receiver, change);
    const changeReceiverEntry = (change: object) => () =>
      vi.mocked(config.getPlugins).mockReturnValue([
        { name: 'Sender', threshold: 1 },
        { name: 'Receiver', threshold: 2, ...change },
      ]);

    class StubPlugin extends SequentialEventEmitter {
      readonly services: Record<string, unknown> = {};

      constructor(
        readonly pluginName: string,
        readonly parameters: unknown,
      ) {
        super(pluginName);
        journal.push(`createPlugins: ${pluginName}`);
      }

      static configurationOf(name: string) {
        journal.push(`getPluginsStaticConfiguration: ${name}`);
        return staticConfigurations[name];
      }

      on<T>(event: string, listener: (payload: T) => Promise<void> | void) {
        journal.push(`wirePlugins: ${this.pluginName}.on(${event})`);
        super.on(event, listener);
      }

      setExchange(exchange: unknown) {
        journal.push(`injectServices: ${this.pluginName}.setExchange`);
        this.services.exchange = exchange;
      }

      setStorage(storage: unknown) {
        journal.push(`injectServices: ${this.pluginName}.setStorage`);
        this.services.storage = storage;
      }
    }

    class Sender extends StubPlugin {
      static getStaticConfiguration() {
        return StubPlugin.configurationOf('Sender');
      }

      constructor(parameters: unknown) {
        super('Sender', parameters);
      }
    }

    class Receiver extends StubPlugin {
      readonly received: unknown[] = [];

      static getStaticConfiguration() {
        return StubPlugin.configurationOf('Receiver');
      }

      constructor(parameters: unknown) {
        super('Receiver', parameters);
      }

      onMyEvent(payloads: unknown) {
        this.received.push(payloads);
      }
    }

    beforeEach(() => {
      journal.length = 0;
      staticConfigurations = {
        Sender: {
          name: 'Sender',
          schema: schemaOf('Sender'),
          modes: ['realtime', 'backtest'],
          eventsEmitted: ['myEvent'],
          inject: ['exchange'],
        },
        Receiver: {
          name: 'Receiver',
          schema: schemaOf('Receiver'),
          modes: ['backtest'],
          eventsHandlers: ['onMyEvent'],
          inject: ['storage'],
        },
      };
      // Registered out of config order
      Object.assign(registry, { Receiver, Sender });
      vi.mocked(config.getPlugins).mockReturnValue([
        { name: 'Sender', threshold: 1 },
        { name: 'Receiver', threshold: 2 },
      ] as any);
      vi.mocked(config.getWatch).mockReturnValue({
        mode: 'backtest',
        pairs: [{ symbol: 'BTC/USDT' }],
        daterange: { start: Date.parse('2025-12-30T00:00:00Z'), end: Date.parse('2025-12-30T23:59:00Z') },
      } as any);
      vi.mocked(injecter.inject.storage).mockReturnValue(storage as any);
      vi.mocked(injecter.inject.exchange).mockReturnValue(exchange as any);
      exchange.loadMarkets.mockImplementation(async () => {
        journal.push('preloadMarkets');
      });
      vi.mocked(streamPipelines.backtest).mockImplementation(async () => {
        journal.push('launchStream: backtest');
      });
      vi.mocked(warning).mockImplementation(() => {
        journal.push('checkPluginsOrderExecution: warning');
      });
    });

    afterEach(() => {
      delete registry.Sender;
      delete registry.Receiver;
    });

    describe('with valid plugins', () => {
      const launchedPlugins = () => vi.mocked(streamPipelines.backtest).mock.calls[0][0] as unknown as [Sender, Receiver];

      beforeEach(async () => {
        await pipelineModule.gekkoPipeline({ plugins });
      });

      it('should run the steps in the documented order', () => {
        expect(journal).toEqual(documentedOrder);
      });

      it('should launch the stream of the mode with the created plugins, in config order', () => {
        expect(launchedPlugins()).toEqual([expect.any(Sender), expect.any(Receiver)]);
      });

      it('should create each plugin from its own entry, parsed by its schema', () => {
        expect(launchedPlugins().map(({ parameters }) => parameters)).toEqual([
          { name: 'Sender', threshold: 1, parsedBy: 'Sender' },
          { name: 'Receiver', threshold: 2, parsedBy: 'Receiver' },
        ]);
      });

      it('should deliver the events of a plugin to the handler of another', async () => {
        const [sender, receiver] = launchedPlugins();
        await sender.emit('myEvent', payloads);
        expect(receiver.received).toEqual([payloads]);
      });

      it('should inject into each plugin the services it asks for', () => {
        expect(launchedPlugins().map(({ services }) => services)).toEqual([{ exchange }, { storage }]);
      });

      it('should launch the stream of the mode without a signal', () => {
        expect(vi.mocked(streamPipelines.backtest).mock.calls[0][1]).toBeUndefined();
      });
    });

    describe('with a signal', () => {
      const { signal } = new AbortController();

      beforeEach(async () => {
        await pipelineModule.gekkoPipeline({ plugins, signal });
      });

      it('should run the steps in the documented order', () => {
        expect(journal).toEqual(documentedOrder);
      });

      it('should hand the signal to the stream of the mode', () => {
        expect(vi.mocked(streamPipelines.backtest).mock.calls[0][1]).toBe(signal);
      });
    });

    describe('when a plugin creates orders that no plugin executes', () => {
      beforeEach(async () => {
        changeReceiver({ eventsEmitted: [STRATEGY_CREATE_ORDER_EVENT] })();
        await pipelineModule.gekkoPipeline({ plugins });
      });

      it('should warn before the markets are loaded, and go on', () => {
        const preloadStep = documentedOrder.indexOf('preloadMarkets');
        expect(journal).toEqual([
          ...documentedOrder.slice(0, preloadStep),
          'checkPluginsOrderExecution: warning',
          ...documentedOrder.slice(preloadStep),
        ]);
      });
    });

    describe.each`
      failure                                   | breakIt                                                                                   | error                                                                  | lastStep
      ${'a plugin does not support the mode'}   | ${changeReceiver({ modes: ['realtime'] })}                                                | ${'Plugin Receiver does not support backtest mode.'}                   | ${'getPluginsStaticConfiguration: Receiver'}
      ${'the entry of a plugin is invalid'}     | ${changeReceiverEntry({ threshold: '2' })}                                                | ${'Invalid options for plugin Receiver (plugins[1]):'}                 | ${'validatePluginsSchema: Sender'}
      ${'a dependency is missing'}              | ${changeReceiver({ dependencies: ['non-existent-dep-xyz'] })}                             | ${'Dependency non-existent-dep-xyz not installed for plugin Receiver'} | ${'validatePluginsSchema: Receiver'}
      ${'two plugins emit the same event'}      | ${changeReceiver({ eventsEmitted: ['myEvent'] })}                                         | ${PluginsEmitSameEventError}                                           | ${'validatePluginsSchema: Receiver'}
      ${'dependency and duplicate checks fail'} | ${changeReceiver({ dependencies: ['non-existent-dep-xyz'], eventsEmitted: ['myEvent'] })} | ${'Dependency non-existent-dep-xyz not installed for plugin Receiver'} | ${'validatePluginsSchema: Receiver'}
      ${'a duplicate emitter creates orders'}   | ${changeReceiver({ eventsEmitted: ['myEvent', STRATEGY_CREATE_ORDER_EVENT] })}            | ${PluginsEmitSameEventError}                                           | ${'validatePluginsSchema: Receiver'}
      ${'the markets cannot be loaded'}         | ${() => exchange.loadMarkets.mockRejectedValue(unavailable)}                              | ${unavailable}                                                         | ${'validatePluginsSchema: Receiver'}
    `('when $failure', ({ breakIt, error, lastStep }) => {
      let pipeline: Promise<unknown>;

      beforeEach(async () => {
        breakIt();
        pipeline = pipelineModule.gekkoPipeline({ plugins });
        await pipeline.catch(() => {});
      });

      it('should reject with the error of the first failing step', async () => {
        await expect(pipeline).rejects.toThrow(error);
      });

      it(`should stop after ${lastStep}`, () => {
        expect(journal).toEqual(documentedOrder.slice(0, documentedOrder.indexOf(lastStep) + 1));
      });
    });
  });
});
