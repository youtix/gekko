import {
  ORDER_CANCELED_EVENT,
  ORDER_COMPLETED_EVENT,
  ORDER_ERRORED_EVENT,
  STRATEGY_CREATE_ORDER_EVENT,
} from '@gekko/shared/constants/event.const';
import { GekkoError } from '@gekko/shared/errors/gekko.error';
import { GekkoPipelineOptions, PipelineContext } from './pipeline.types';
import { config } from '../../configuration/configuration';
import { inject } from '../../injecter/injecter';
import { debug, warning } from '../../logger/logger';
import { keepDuplicates } from '@gekko/shared/utils/collection/array.utils';
import { startOfMinuteUTC } from '@gekko/shared/utils/date/date.utils';
import { toCamelCase } from '@gekko/shared/utils/string/string.utils';
import { compact, each, filter, flatMap, map, some } from 'lodash-es';
import { z } from 'zod';
import { MissingCandlesError } from '../stream/backtest/backtest.error';
import { PluginsEmitSameEventError } from './pipeline.error';
import { streamPipelines } from './pipeline.helper';

export const launchStream = async (context: PipelineContext, options?: Pick<GekkoPipelineOptions, 'signal'>) => {
  const plugins = compact(map(context, p => p.plugin));
  await streamPipelines[config.getWatch().mode](plugins, options?.signal);
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

export const createPlugins = async (context: PipelineContext, { plugins }: Pick<GekkoPipelineOptions, 'plugins'>) =>
  map(context, pluginCtx => {
    const { name, parameters } = pluginCtx;
    // The output of its own schema, paired with the class by name (see PluginClass)
    const PluginClass = plugins[name];
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
 * a strategy that waits for its order to end before it advises again, as every built-in strategy does, advised once per run on each
 * pair, and nothing said why. A plugin that only hears of the orders, the EventSubscriber, ends none. Not refused: a strategy that
 * never creates orders needs no Trader, which only its run can tell, and where no paper exchange exists (hyperliquid) the Trader
 * trades for real.
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
        'as every built-in strategy does, advises once per run on each pair.',
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
      } catch (error) {
        // Kept as the cause, which main() appends to its report: a module that is installed but fails to load read "not installed" too
        throw new GekkoError('pipeline', `Dependency ${dependency} not installed for plugin ${plugin.name}`, { cause: error });
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

export const getPluginsStaticConfiguration = async (context: PipelineContext, { plugins }: Pick<GekkoPipelineOptions, 'plugins'>) => {
  // Bundled by `bun build`, the namespace is a plain object: arbitrary key order, and inherited keys such as 'constructor'
  const pluginNames = Object.keys(plugins).sort();
  return map(context, plugin => {
    if (!pluginNames.includes(plugin.name)) {
      const suggestion = pluginNames.find(pluginName => pluginName.toLowerCase() === plugin.name.toLowerCase());
      const didYouMean = suggestion ? ` Did you mean '${suggestion}'?` : '';
      throw new GekkoError('pipeline', `Unknown plugin '${plugin.name}'.${didYouMean} Available plugins: ${pluginNames.join(', ')}.`);
    }
    const PluginClass = plugins[plugin.name];
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

/**
 * Runs Gekko on its configuration: checks it and the plugins, creates the plugins, wires their events and hands them their services,
 * then streams the candles of the mode through them. Rejects with the error of the first step that fails. Once the stream runs, settles
 * when it is torn down and the plugins are finalised: resolves when it ended (a backtest or an import at the end of its range), rejects
 * with the error that ended the run otherwise.
 *
 * `signal` is the one way to end a run from code, and the only end of a realtime run but a failure or the circuit breaker's stop: its
 * live stream never ends. Once it is aborted, every stream of the run is destroyed, the plugins are finalised with an AbortError as the
 * failure that stopped the run (the analyzers report its message as their `interruption`), then the run rejects with that AbortError,
 * whose cause is the reason of the abort, unless a bucket failed meanwhile: its error stays the run's. main() passes no signal: SIGINT
 * and SIGTERM close the storage and exit without finalising the plugins. The e2e harness ends its realtime runs with one.
 *
 * `plugins` is the registry the configuration's `plugins[].name` entries pick their class from: the namespace of `@gekko/plugins/index`
 * for the executable. An entry naming no class of it is refused with the list of its names.
 */
export const gekkoPipeline = (options: GekkoPipelineOptions) =>
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
  ].reduce(async (context, step) => step(await context, options), Promise.resolve(config.getPlugins()));
