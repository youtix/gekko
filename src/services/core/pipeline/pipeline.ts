import { ORDER_CANCELED_EVENT, ORDER_COMPLETED_EVENT, ORDER_ERRORED_EVENT, STRATEGY_CREATE_ORDER_EVENT } from '@constants/event.const';
import { GekkoError } from '@errors/gekko.error';
import { PipelineContext } from '@models/pipeline.types';
import * as pluginList from '@plugins/index';
import { PluginsNames } from '@plugins/plugin.types';
import { config } from '@services/configuration/configuration';
import { inject } from '@services/injecter/injecter';
import { debug, warning } from '@services/logger';
import { keepDuplicates } from '@utils/collection/array.utils';
import { startOfMinuteUTC } from '@utils/date/date.utils';
import { toCamelCase } from '@utils/string/string.utils';
import { compact, each, filter, flatMap, map, some } from 'lodash-es';
import { z } from 'zod';
import { MissingCandlesError } from '../stream/backtest/backtest.error';
import { PluginsEmitSameEventError } from './pipeline.error';
import { streamPipelines } from './pipeline.utils';

export const launchStream = async (context: PipelineContext) => {
  const plugins = compact(map(context, p => p.plugin));
  await streamPipelines[config.getWatch().mode](plugins);
  return context;
};

export const injectServices = async (context: PipelineContext) =>
  each(context, pipeline => {
    each(pipeline.inject, serviceName => {
      // @ts-expect-error TODO fix complex typescript error
      pipeline.plugin[toCamelCase('set', serviceName)](inject[serviceName]());
    });
  });

export const wirePlugins = async (context: PipelineContext) => {
  const emitters = filter(context, ({ eventsEmitted }) => !!eventsEmitted?.length);

  return each(context, ({ plugin: handler, name: handlerName, eventsHandlers }) => {
    each(emitters, ({ eventsEmitted, plugin: emitter, name: emitterName }) => {
      each(eventsEmitted, event => {
        const eventHandler = toCamelCase('on', event);
        if (eventsHandlers?.includes(eventHandler)) {
          // @ts-expect-error TODO fix complex typescript error
          emitter?.on(event, handler[eventHandler].bind(handler));
          debug('pipeline', `When ${emitterName} emit '${event}', ${handlerName}.${eventHandler} will be executed.`);
        }
      });
    });
  });
};

export const createPlugins = async (context: PipelineContext) =>
  map(context, pluginCtx => {
    const { name, parameters } = pluginCtx;
    const PluginClass = pluginList[name as PluginsNames];
    // @ts-expect-error TODO fix complex typescript error
    const plugin = new PluginClass(parameters);
    debug('pipeline', `${name} plugin created !`);
    return { ...pluginCtx, plugin };
  });

export const preloadMarkets = async (context: PipelineContext) => {
  const exchange = inject.exchange();
  debug('pipeline', `Preloading Markets data for ${exchange.getExchangeName()}`);
  await exchange.loadMarkets();
  return context;
};

export const checkPluginsDuplicateEvents = async (context: PipelineContext) => {
  const eventsByPlugin = map(context, ({ name, eventsEmitted }) => ({
    name,
    events: eventsEmitted ?? [],
  }));

  const duplicateEvents = keepDuplicates(compact(flatMap(eventsByPlugin, p => p.events)));
  const duplicatePlugins = map(
    filter(eventsByPlugin, ({ events }) => events.some(e => duplicateEvents.includes(e))),
    p => p.name,
  );

  if (duplicateEvents.length) throw new PluginsEmitSameEventError(duplicatePlugins, duplicateEvents);
  return context;
};

// Each order a strategy creates ends in one of them, emitted by the plugin that executes the orders: the Trader
const ORDER_END_EVENTS = [ORDER_COMPLETED_EVENT, ORDER_CANCELED_EVENT, ORDER_ERRORED_EVENT];

/**
 * Warns when a plugin creates orders that no plugin executes. Without a Trader (a screener meant to alert only), no order ever ended:
 * a strategy that waits for its order to end before it advises again, as every built-in strategy does, advised once per run, and
 * nothing said why. A plugin that only hears of the orders, the EventSubscriber, ends none. Not refused: a strategy that never creates
 * orders needs no Trader, which only its run can tell, and where no paper exchange exists (hyperliquid) the Trader trades for real.
 */
export const checkPluginsOrderExecution = async (context: PipelineContext) => {
  const hasOrderExecutor = some(context, ({ eventsEmitted }) => ORDER_END_EVENTS.every(event => eventsEmitted?.includes(event)));
  if (hasOrderExecutor) return context;
  for (const { name, eventsEmitted } of context) {
    if (!eventsEmitted?.includes(STRATEGY_CREATE_ORDER_EVENT)) continue;
    warning(
      'pipeline',
      [
        `${name} emits ${STRATEGY_CREATE_ORDER_EVENT}, but no configured plugin executes orders and ends each one with`,
        `${ORDER_COMPLETED_EVENT}, ${ORDER_CANCELED_EVENT} or ${ORDER_ERRORED_EVENT}, as the Trader does.`,
        'Every order of the strategy stays pending, so a strategy that waits for its order to end before it advises again,',
        'as every built-in strategy does, advises once per run.',
        'Add a Trader (on paper-binance or dummy-cex, it only simulates the orders), unless the strategy never creates orders.',
      ].join(' '),
    );
  }
  return context;
};

export const checkPluginsDependencies = async (context: PipelineContext) => {
  for (const plugin of context) {
    for (const dependency of plugin.dependencies ?? []) {
      try {
        await import(dependency);
      } catch {
        throw new GekkoError('pipeline', `Dependency ${dependency} not installed for plugin ${plugin.name}`);
      }
    }
  }
  return context;
};

export const validatePluginsSchema = async (context: PipelineContext) => {
  const parameters = config.getPlugins();
  return map(context, (plugin, i) => {
    const result = plugin.schema?.safeParse(parameters[i]);
    // Not the ZodError itself: it names neither the plugin nor its entry (a plugin can be configured twice), and its message, the
    // JSON of its issues, would be printed twice by the fatal error report (message, then the stack that repeats it)
    if (result?.error)
      throw new GekkoError('pipeline', `Invalid options for plugin ${plugin.name} (plugins[${i}]):\n${z.prettifyError(result.error)}`);
    return { ...plugin, parameters: result?.data };
  });
};

export const checkPluginsModesCompatibility = async (context: PipelineContext) =>
  each(context, ({ name, modes }) => {
    const mode = config.getWatch().mode;
    if (!modes?.includes(mode)) throw new GekkoError('pipeline', `Plugin ${name} does not support ${mode} mode.`);
  });

export const getPluginsStaticConfiguration = async (context: PipelineContext) => {
  // Bundled by `bun build`, the namespace is a plain object: arbitrary key order, and inherited keys such as 'constructor'
  const pluginNames = Object.keys(pluginList).sort();
  return map(context, plugin => {
    if (!pluginNames.includes(plugin.name)) {
      const suggestion = pluginNames.find(pluginName => pluginName.toLowerCase() === plugin.name.toLowerCase());
      const didYouMean = suggestion ? ` Did you mean '${suggestion}'?` : '';
      throw new GekkoError('pipeline', `Unknown plugin '${plugin.name}'.${didYouMean} Available plugins: ${pluginNames.join(', ')}.`);
    }
    const PluginClass = pluginList[plugin.name as PluginsNames];
    const { modes, schema, dependencies, eventsEmitted, name, eventsHandlers, inject } = PluginClass.getStaticConfiguration();
    return { modes, schema, dependencies, eventsEmitted, name, eventsHandlers, inject };
  });
};

export const checkDateRange = async (context: PipelineContext) => {
  const { pairs, mode, daterange } = config.getWatch();
  if (mode === 'backtest' && daterange) {
    const storage = inject.storage();
    // Same minutes as the backtest reader (splitIntervals): checkInterval expects the starts of the first and last candles
    const alignedDaterange = { start: startOfMinuteUTC(daterange.start), end: startOfMinuteUTC(daterange.end) };
    for (const { symbol } of pairs) {
      const result = storage.checkInterval(symbol, alignedDaterange);
      if (result?.missingCandleCount) {
        const availableDateranges = storage.getCandleDateranges(symbol);
        throw new MissingCandlesError(symbol, alignedDaterange, availableDateranges);
      }
    }
  }
  return context;
};

export const gekkoPipeline = () =>
  [
    checkDateRange,
    getPluginsStaticConfiguration,
    checkPluginsModesCompatibility,
    validatePluginsSchema,
    checkPluginsDependencies,
    checkPluginsDuplicateEvents,
    checkPluginsOrderExecution,
    preloadMarkets,
    createPlugins,
    wirePlugins,
    injectServices,
    launchStream,
  ].reduce(async (params, fn) => fn(await params), Promise.resolve(config.getPlugins()));
