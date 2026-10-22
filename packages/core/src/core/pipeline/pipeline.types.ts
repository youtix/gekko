import type { Plugin } from '../../plugin/plugin';
import { z } from 'zod';

/**
 * The options of a plugin: its entry of the configuration as its own schema outputs it (see validatePluginsSchema), with its defaults
 * applied. Every entry has a name, which every plugin schema, strict, declares.
 */
export type PluginParameters = { name: string; [option: string]: unknown };

/**
 * A plugin class as a registry holds it and createPlugins builds it: from its options, the output of its own schema, which the
 * pipeline pairs with it by name at run time. No one type expresses that pairing: under strictFunctionTypes a construct signature of
 * `PluginParameters` refused every class, each taking its own options, so the parameter is `any`. The class still has to build a
 * Plugin and to declare its static configuration.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginClass = (new (parameters: any) => Plugin) & { getStaticConfiguration(): PluginStaticConfiguration };

/** What a plugin class declares of itself, read by the pipeline before any plugin is built */
export type PluginStaticConfiguration = {
  name: string;
  schema?: z.ZodTypeAny;
  modes: readonly string[];
  dependencies: readonly string[];
  inject: readonly string[];
  eventsHandlers: readonly string[];
  eventsEmitted: readonly string[];
};

/**
 * The plugin classes a run may configure, by the name the configuration's `plugins[].name` entries pick them with: the namespace of
 * `@gekko/plugins/index` for the executable, which the pipeline does not import itself (a package of a lower layer)
 */
export type PluginRegistry = Record<string, PluginClass>;

/** The options of gekkoPipeline */
export type GekkoPipelineOptions = {
  /** The plugin classes the configuration's `plugins[].name` entries pick from */
  plugins: PluginRegistry;
  /** Ends the run once aborted (see gekkoPipeline) */
  signal?: AbortSignal;
};

export type PipelineContext = {
  name: string;
  plugin?: Plugin;
  /** Its options, once validatePluginsSchema has parsed its entry: undefined for a plugin without schema */
  parameters?: PluginParameters;
  eventsEmitted?: readonly string[];
  eventsHandlers?: readonly string[];
  dependencies?: readonly string[];
  inject?: readonly string[];
  modes?: readonly string[];
  schema?: z.ZodTypeAny;
}[];
